import type { Context } from 'hono';
import type { AccountLearner } from '../account-learner.js';
import type { AccountPool } from '../auth/account-pool.js';
import type { CanaryController } from '../canary.js';
import type { PacingEnforcer } from '../pacing.js';
import type { ClaudeTemplate } from '../template/types.js';
import type { AlertSink } from '../alerts.js';
import type { BillingMonitor } from '../usage/billing-monitor.js';
import type { DriftAnalyzer } from '../usage/drift-analyzer.js';
import type { GlobalGuard } from '../usage/global.js';
import type { UsageTracker } from '../usage/per-user.js';
import { isModelAllowed } from '../auth/model-allow.js';
import { Forbidden } from '../lib/errors.js';
import { extractUsage, safeParseJson, sniffUsage } from '../usage/sniff.js';
import { log } from '../lib/logger.js';
import { callUpstream } from './upstream.js';

/**
 * Hop-by-hop headers (RFC 7230 §6.1) plus content-length / content-encoding
 * which are body-framing and must be recomputed by the local HTTP stack.
 */
const HOP_BY_HOP: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'content-encoding',
]);

const forwardHeaders = (upstream: Headers): Headers => {
  const out = new Headers();
  upstream.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) out.set(key, value);
  });
  return out;
};

export interface MessagesDeps {
  readonly pool: AccountPool;
  readonly template: ClaudeTemplate;
  readonly candidateTemplate: ClaudeTemplate | null;
  readonly canary: CanaryController;
  readonly tracker: UsageTracker;
  readonly globalGuard: GlobalGuard;
  readonly billingMonitor: BillingMonitor;
  readonly accountLearner: AccountLearner;
  readonly pacing: PacingEnforcer;
  readonly drift: DriftAnalyzer;
  /** Cooldown-wrapped sink. Receives non-fatal usage-write errors so DB
   * outages alarm once per cooldown window instead of flooding stderr. */
  readonly usageErrorSink: AlertSink;
}

export const createMessagesHandler =
  (deps: MessagesDeps) =>
  async (c: Context): Promise<Response> => {
    const user = c.get('user');

    // Pre-flight: subscription headroom first (cheap shared state), then per-user
    // quota. Both throw QuotaExceeded (429) handled by the global onError.
    deps.globalGuard.assertSubscriptionHealthy();
    await deps.tracker.assertCanRequest(user.name);

    const reqHeaders = c.req.raw.headers;

    // The earlier `OAUTH_PAYLOAD_LIMIT_BYTES = 1MB` gate that lived here was
    // removed 2026-05-29 — it was based on the same misdiagnosis as the
    // `context-1m-` strip in extracted.ts. Real CC's [1m] variant routinely
    // sends ~1.2MB bodies (~385K input tokens) to the OAuth-authed upstream
    // and gets HTTP 200. The generic body-size cap enforced elsewhere (4 MB
    // in app.ts) still applies as runaway protection.

    const rawBody = await c.req.json().catch(() => null);
    if (rawBody === null || typeof rawBody !== 'object') {
      return c.json(
        { error: { type: 'invalid_request', message: 'request body must be JSON object' } },
        400,
      );
    }
    // Upstream rejects Claude.ai-OAuth calls that omit `system` for premium
    // models (sonnet/opus) with rate_limit_error — even though the API schema
    // marks system as optional. haiku is exempt. Confirmed 2026-05-27 by
    // wire-level A/B (same OAuth token, body w/ vs w/o system → 429 vs 200).
    // The proxy is transparent on every other field; only synthesize a
    // minimal system when the client truly didn't send one.
    const ensureSystem = (b: Record<string, unknown>): Record<string, unknown> => {
      const sys = b.system;
      const present =
        (typeof sys === 'string' && sys.length > 0) ||
        (Array.isArray(sys) && sys.length > 0);
      if (present) return b;
      return { ...b, system: "You are Claude Code, Anthropic's official CLI for Claude." };
    };
    const clientBody = ensureSystem(rawBody as Record<string, unknown>);

    // Per-key allowlist gate. Empty/missing allowlist = no restriction
    // (env-baked keys always fall through here). Body must declare a model
    // string for the gate to evaluate; absent or non-string falls through
    // too — upstream will return its own 400 for malformed bodies.
    const requestedModel = clientBody.model;
    if (typeof requestedModel === 'string' && user.allowedModels) {
      if (!isModelAllowed(requestedModel, user.allowedModels)) {
        throw Forbidden(
          `model "${requestedModel}" not allowed for key "${user.name}" ` +
            `(permitted: ${user.allowedModels.join(', ')})`,
          'model_not_allowed',
        );
      }
    }

    // Record a thin fingerprint for drift root-cause analysis. Memory-only ring.
    const headerNames: string[] = [];
    reqHeaders.forEach((_v, k) => headerNames.push(k.toLowerCase()));
    const bodyKeys =
      typeof clientBody === 'object' && clientBody !== null
        ? Object.keys(clientBody as Record<string, unknown>)
        : [];
    const model = (clientBody as Record<string, unknown>).model;
    deps.drift.record({
      ts: Date.now(),
      userKey: user.name,
      headerNames,
      bodyKeys,
      anthropicBeta: reqHeaders.get('anthropic-beta') ?? '',
      userAgent: reqHeaders.get('user-agent') ?? '',
      model: typeof model === 'string' ? model : '',
    });

    // Canary routing: dice roll picks template per request. Tripped canary
    // (auto-set after a candidate-side service_tier alarm) routes everyone
    // back to stable.
    const decision = deps.canary.decide();
    const chosenTemplate =
      decision.useCandidate && deps.candidateTemplate !== null
        ? deps.candidateTemplate
        : deps.template;
    deps.canary.recordRequest(decision.useCandidate);

    // Session-id flows account selection. Client may set it; otherwise we
    // pick fresh per request (no sticky possible, but pool still works).
    const sessionId = reqHeaders.get('x-claude-code-session-id') ?? undefined;

    const upstream = await callUpstream(
      clientBody,
      c.req.raw.headers,
      sessionId,
      { ...deps, template: chosenTemplate },
    );

    // Update subscription headroom both globally and per-member.
    deps.globalGuard.observeHeaders(upstream.response.headers);
    deps.pool.observeResponse(upstream.servedBy, upstream.response.headers);
    // Learn organization-id from the response — improves future account_uuid
    // fingerprint injection. Per-request, low overhead.
    deps.accountLearner.observe(upstream.response.headers);

    const contentType = upstream.response.headers.get('content-type') ?? '';
    const isStream = contentType.toLowerCase().startsWith('text/event-stream');

    // Common usage-observation callback. Fire-and-forget DB write (we don't
    // block the response on accounting), then alarm sinks.
    const onUsage = (usage: import('../usage/sniff.js').SniffedUsage): void => {
      void deps.tracker.record(user.name, usage).catch((err: unknown) => {
        const msg = `[usage] record failed: ${err instanceof Error ? err.message : String(err)}`;
        void deps.usageErrorSink(msg);
      });
      deps.billingMonitor.observe(usage.serviceTier, upstream.response.headers);
      if (decision.useCandidate && usage.serviceTier && usage.serviceTier !== 'standard') {
        deps.canary.trip(`candidate served service_tier=${usage.serviceTier}`);
      }
    };

    // Streaming responses (SSE): wrap with sniffUsage TransformStream so we
    // forward chunks byte-for-byte to the client while extracting usage from
    // each event payload as it flies past.
    if (isStream && upstream.response.body !== null) {
      const sniffed = sniffUsage(upstream.response.body, contentType, onUsage);
      return new Response(sniffed, {
        status: upstream.response.status,
        statusText: upstream.response.statusText,
        headers: forwardHeaders(upstream.response.headers),
      });
    }

    // Non-streaming responses (JSON or empty): consume the upstream Response
    // via its own .text() helper — NOT by re-wrapping `response.body` in a
    // new Response. Bun's small-body optimization can leave the body stream
    // in a "used" state that throws synchronously when re-wrapped, while
    // `response.text()` always works because it owns the internal buffer.
    //
    // Failure mode worth seeing: silently swallowing the .text() error used
    // to make 429 responses show up at the client with EMPTY bodies, which
    // hid the upstream's "rate_limit_error" detail and broke self-test
    // diagnostics. We now log the actual failure reason instead.
    const bodyText = await upstream.response.text().catch((err: unknown) => {
      log.error(
        `[proxy] body read failed (status=${upstream.response.status}): ${err instanceof Error ? err.message : String(err)}`,
      );
      return '';
    });
    if (upstream.response.status >= 400 && bodyText.length === 0) {
      log.warn(
        `[proxy] empty body on ${upstream.response.status} — ` +
          `ct=${upstream.response.headers.get('content-type') ?? '?'} ` +
          `cl=${upstream.response.headers.get('content-length') ?? '?'} ` +
          `te=${upstream.response.headers.get('transfer-encoding') ?? '?'} ` +
          `ce=${upstream.response.headers.get('content-encoding') ?? '?'}`,
      );
    }
    const usage = extractUsage(safeParseJson(bodyText));
    if (usage) {
      onUsage({
        inputTokens: usage.input ?? 0,
        outputTokens: usage.output ?? 0,
        serviceTier: usage.tier,
      });
    }
    return new Response(bodyText, {
      status: upstream.response.status,
      statusText: upstream.response.statusText,
      headers: forwardHeaders(upstream.response.headers),
    });
  };
