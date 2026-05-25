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
import { extractUsage, safeParseJson, sniffUsage } from '../usage/sniff.js';
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

    const clientBody = await c.req.json().catch(() => null);
    if (clientBody === null || typeof clientBody !== 'object') {
      return c.json(
        { error: { type: 'invalid_request', message: 'request body must be JSON object' } },
        400,
      );
    }

    // Record a thin fingerprint for drift root-cause analysis. Memory-only ring.
    const reqHeaders = c.req.raw.headers;
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

<<<<<<< Updated upstream
    // Non-streaming responses (JSON or empty): buffer fully, extract usage
    // from the parsed body, and return a fresh Response with the buffered
    // text. Avoids piping the upstream body through a TransformStream —
    // Bun's stream internals can race the consumer-close edge there.
    const bodyText =
      upstream.response.body !== null
        ? await new Response(upstream.response.body).text()
        : '';
=======
    // Non-streaming responses (JSON or empty): consume the upstream Response
    // via its own .text() helper — NOT by re-wrapping `response.body` in a
    // new Response. Bun's small-body optimization can leave the body stream
    // in a "used" state that throws synchronously when re-wrapped, while
    // `response.text()` always works because it owns the internal buffer.
    const bodyText = await upstream.response.text().catch(() => '');
>>>>>>> Stashed changes
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
