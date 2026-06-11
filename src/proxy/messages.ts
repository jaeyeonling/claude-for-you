import { randomUUID } from 'node:crypto';
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
import type { MessageLogStore, ResponseBody } from '../usage/messages-log.js';
import { extractModel, extractResponseMeta } from '../usage/messages-log.js';
import { buildBypassMetadata } from '../usage/bypass-metadata.js';
import { applyClassifierTriggers, TOOL_NAME_TRIGGERS } from './classifier-triggers.js';
import {
  createAliasMap,
  createReverseToolNameStream,
  reverseToolNamesInText,
  rewriteToolNamesForUpstream,
} from './tool-name-mapping.js';
import type { UsageTracker } from '../usage/per-user.js';
import { isModelAllowed } from '../auth/model-allow.js';
import { Forbidden, InvalidRequest } from '../lib/errors.js';
import { extractUsage, safeParseJson, sniffUsage } from '../usage/sniff.js';
import { log } from '../lib/logger.js';
import { callUpstream } from './upstream.js';
import { tapResponseBody } from './response-tap.js';

/**
 * Claude Code identity prefix that Anthropic's Claude.ai-OAuth entitlement
 * gate looks for on sonnet/opus calls. Without it the upstream rejects with
 * `rate_limit_error` (HTTP 429) — even when `system` is non-empty. haiku is
 * exempt from this check.
 *
 * History:
 *   2026-05-27 — original guard treated `system` as a binary (present/absent)
 *     after a wire-level A/B that only varied presence. Tomodachi-style custom
 *     `system` bodies still passed the proxy guard but were rejected upstream
 *     because the prefix was missing. Logged as `rate_limit_error`, easy to
 *     misread as a quota issue (see docs/operational-pitfalls.md for the
 *     cousin misdiagnosis in template/extracted.ts:102).
 *   2026-06-02 — guard rewritten to PREPEND the prefix as a separate `system`
 *     block on every call, with no caller-side opt-out. We deliberately break
 *     the older "transparent on every other field" invariant for `system`
 *     only: the entitlement layer treats `system` as identity, so the proxy
 *     must own the leading block to keep upstream from rejecting AND to keep
 *     a caller from forging the identity by prefixing their own body with the
 *     marker. Caller's original intent (custom persona, cache_control on
 *     blocks) is preserved verbatim as the second+ blocks. See pitfalls #13.
 *   2026-06-08 — `CC_BLOCK` now carries `cache_control: { type: 'ephemeral' }`
 *     to act as an explicit prompt-cache anchor (issue #55). The earlier
 *     shape silently pushed every caller cache_control breakpoint one slot
 *     deeper, which broke the content-hash prefix Anthropic uses for cache
 *     lookups and dropped sonnet/opus hit rate from ~95% to ~0% (~4-5x
 *     effective input cost). With our own breakpoint, the caller's downstream
 *     cache_control blocks anchor against a deterministic CC_BLOCK prefix.
 *     Trade-off: this consumes 1 of the 4 cache_control breakpoints Anthropic
 *     counts across system+messages+tools. Real CC traffic uses 2 → +1 is
 *     safe; SDK callers maxing out at 4 would now hit 400, tracked as a
 *     follow-up (caller-aware conditional prepend). Mechanism per Anthropic
 *     docs (https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching):
 *     prompt caching is content-hash based with a 20-block lookback window
 *     — adding our anchor segments the cumulative hash so the caller's
 *     larger entries match across calls instead of missing every time.
 *     `'ephemeral'` is currently the only valid `cache_control.type` Anthropic
 *     accepts; if the enum widens (e.g. `persistent`), revisit this constant
 *     alongside cc-wire-reference §2a — `as const` + the doc-sync test guard
 *     the runtime side, but the trade-off rationale needs a fresh evaluation
 *     because a longer-TTL anchor changes the breakpoint-budget math.
 *   2026-06-10 — B3 strict gate (#96, this commit): `ensureSystem` now skips
 *     the prepend when the caller's `system` array already contains a
 *     canonical CC marker block (see `isCanonicalCcMarker` below). Real CC
 *     traffic ships such a block at `system[1]` (after the billing header),
 *     so this transparent passthrough eliminates the marker duplication that
 *     PR #41 introduced — restoring the prefix hash caller `cache_control`
 *     breakpoints relied on (issue #55, cost evidence in pitfall #15).
 *     Non-CC callers (tomodachi-style bots, SDK clients without the marker)
 *     still get the unconditional prepend, preserving PR #41's entitlement
 *     fix. Threat model per docs/operational-pitfalls.md #15: wire-level
 *     identity is byte-identical for proxy-emitted and caller-emitted
 *     canonical blocks — Anthropic cannot distinguish them, so a caller
 *     who ships the exact canonical shape carries the identity claim
 *     themselves. ToS responsibility shifts from proxy to API key holder.
 *   2026-06-10 — Boundary validation (#57): `ensureSystem` now rejects caller
 *     `system` arrays containing non-text blocks (null, `{}`, `{type:'image'}`,
 *     `{type:'text'}` missing `text`) with a 400 BEFORE the canonical-marker
 *     check. Anthropic's contract is `system?: string | Array<TextBlockParam>`
 *     — text blocks only — so this enforces the published contract at the
 *     proxy boundary. Pre-#57 these shapes silently flowed to Anthropic and
 *     surfaced as generic 400s the caller couldn't trace back to the proxy.
 *     The dedicated `invalid_system_block` error code + `[claude-for-you]`
 *     message prefix let callers grep the JSON envelope and distinguish this
 *     from upstream Anthropic rejections. Validation runs BEFORE the
 *     canonical-marker check so a valid marker mixed with invalid neighbors
 *     (`[canonicalMarker, null]`) still 400s — the transparent path only
 *     accepts fully-valid arrays. Caller-controlled `b.type` is truncated to
 *     64 chars + ASCII-control stripped before being interpolated into the
 *     error message (R1 chaos+adversary: prevents response-body amplification
 *     and log injection via `\r\n`).
 */
export const CC_SYSTEM_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";

interface SystemTextBlock {
  readonly type: 'text';
  readonly text: string;
  readonly cache_control?: unknown;
}

/**
 * Module-singleton — `Object.freeze` (deep) keeps V8's hidden class stable so
 * the inline cache for the prepended block doesn't churn under hot-path load.
 * The inner `cache_control` object is frozen too: shallow-freeze would let
 * external code mutate `CC_BLOCK.cache_control.type` and silently invalidate
 * the prompt-cache anchor for every subsequent caller.
 *
 * Exported so tests can use the live runtime value as their assertion ground
 * truth instead of duplicating string literals. Production code should not
 * pull this directly — go through `ensureSystem`.
 */
export const CC_BLOCK: SystemTextBlock = Object.freeze({
  type: 'text',
  text: CC_SYSTEM_PREFIX,
  cache_control: Object.freeze({ type: 'ephemeral' as const }),
});

/**
 * Detects whether a `system` block is a "canonical CC marker" — i.e. the exact
 * shape we'd prepend ourselves. Used by `ensureSystem` to skip the prepend when
 * the caller has already shipped one (real CC client). See pitfall #15.
 *
 * Ground truth comes from the frozen `CC_BLOCK` singleton, NOT a hardcoded
 * 'ephemeral' literal — a deliberate future change to
 * `CC_BLOCK.cache_control.type` propagates here automatically. The single
 * hardcoded literal lives in `tests/cc-system-prefix-doc-sync.test.ts` as the
 * dedicated invariant-trip test (see issue #55 maintainer review).
 *
 * Returns `true` only for blocks that match all three:
 *   - `type === 'text'`
 *   - `text === CC_SYSTEM_PREFIX` (byte-identical)
 *   - `cache_control.type === CC_BLOCK.cache_control.type` (currently 'ephemeral')
 */
export const isCanonicalCcMarker = (block: unknown): boolean => {
  if (block == null || typeof block !== 'object') return false;
  const b = block as { type?: unknown; text?: unknown; cache_control?: unknown };
  if (b.type !== 'text' || b.text !== CC_SYSTEM_PREFIX) return false;
  if (b.cache_control == null || typeof b.cache_control !== 'object') return false;
  const ccType = (b.cache_control as { type?: unknown }).type;
  return ccType === (CC_BLOCK.cache_control as { type: string }).type;
};

/**
 * Validates a single caller-supplied `system` array element against Anthropic's
 * public contract: `system?: string | Array<TextBlockParam>` — text blocks only.
 *
 * The load-bearing shape is `{type: 'text', text: string}`. Extra fields
 * (`cache_control`, `citations`, future additions) are NOT validated here —
 * they pass through verbatim. We intentionally do not tighten the gate beyond
 * the official contract: empty `text` is allowed (Anthropic decides), and the
 * `cache_control.type` enum is not policed (Anthropic decides).
 *
 * Used by `ensureSystem` to reject malformed arrays at the proxy boundary
 * with an index-bearing 400 instead of letting them surface as a generic
 * Anthropic 400. See issue #57.
 *
 * Returns `true` for valid blocks, `false` for anything that would not match
 * the `TextBlockParam` shape.
 */
export const isValidSystemBlock = (block: unknown): boolean => {
  if (block == null || typeof block !== 'object') return false;
  const b = block as { type?: unknown; text?: unknown };
  if (b.type !== 'text') return false;
  return typeof b.text === 'string';
};

/**
 * Normalize `system` so the upstream entitlement gate sees a CC identity block
 * — either prepended by us or already shipped by the caller. Caller's other
 * blocks are preserved verbatim.
 *
 * Shape rules:
 *   - missing / empty / non-string non-array        → `[CC_BLOCK]`
 *   - non-empty string                              → `[CC_BLOCK, {type:'text', text: caller}]`
 *   - non-empty array, contains canonical marker    → caller passed through (shallow copy)
 *   - non-empty array, no canonical marker          → `[CC_BLOCK, ...caller]`
 *
 * The "contains canonical marker" branch (#96, post-#97 invariant) skips the
 * prepend when the caller's `system` array already carries a block matching
 * `isCanonicalCcMarker`. This preserves the prefix hash caller cache_control
 * breakpoints rely on (issue #55). Non-canonical callers still get the
 * unconditional prepend (PR #41 entitlement fix preserved).
 *
 * Returns a new object — never mutates the input. The transparent branch uses
 * a shallow-copied `system` array (`[...sys]`) so downstream code can't leak
 * mutations back to the caller's array reference, even though element
 * references are shared (same shape as the existing prepend branches).
 */
export const ensureSystem = (b: Record<string, unknown>): Record<string, unknown> => {
  const sys = b.system;
  if (typeof sys === 'string' && sys.length > 0) {
    return { ...b, system: [CC_BLOCK, { type: 'text', text: sys }] };
  }
  if (Array.isArray(sys) && sys.length > 0) {
    // #57: validate caller-supplied blocks BEFORE the canonical-marker check.
    // A valid marker mixed with invalid neighbors must still 400 — otherwise
    // the transparent path would silently pass invalid blocks to upstream.
    for (let i = 0; i < sys.length; i++) {
      if (!isValidSystemBlock(sys[i])) {
        // `code` is intentionally `invalid_system_block` (not generic
        // `invalid_request`) so the caller can grep the JSON envelope and
        // recognize this as a claude-for-you boundary check, NOT an upstream
        // Anthropic rejection (#57 first-timer R1). Anthropic's own error
        // codes use forms like `invalid_request_error`; ours is distinct.
        throw InvalidRequest(
          `[claude-for-you] system[${i}]: expected text block {type:"text", text:string}, got ${describeInvalidBlock(sys[i])}`,
          'invalid_system_block',
        );
      }
    }
    if (sys.some(isCanonicalCcMarker)) {
      return { ...b, system: [...sys] };
    }
    return { ...b, system: [CC_BLOCK, ...sys] };
  }
  return { ...b, system: [CC_BLOCK] };
};

/**
 * Strip sub-plan classifier triggers from outbound `system` text.
 *
 * History:
 *   2026-06-11 — sub-plan classifier 트리거 normalization (#123). The Pro/Max
 *     OAuth sub plan inspects prompt content (not just headers) to decide
 *     whether the caller is "really" Claude Code. Requests that fail the
 *     check are routed to the overage lane, which is disabled for sub plans
 *     and surfaces as HTTP 400 with the misleading body
 *     `"You're out of extra usage. Add more at claude.ai/...".
 *
 *     This function is called AFTER `ensureSystem`, so `body.system` is
 *     guaranteed to be a non-empty array of `{type:'text', text:string}`
 *     blocks (possibly with `cache_control` etc. as additional fields).
 *
 *     We walk that array and apply the `CLASSIFIER_TRIGGERS` dictionary
 *     (`src/proxy/classifier-triggers.ts`) to each block's `text` field.
 *     Other fields pass through verbatim. The CC marker block is unchanged
 *     because its `text` value (`CC_SYSTEM_PREFIX`) is not in the trigger
 *     dictionary; a dedicated regression test (#123 case 7) guards that
 *     invariant for future trigger additions.
 *
 *     `system` text never appears in upstream responses, so this rewrite has
 *     ZERO observable downstream effect on the caller — no bidirectional
 *     mapping needed. Tool-name rewriting (the other confirmed classifier
 *     trigger, see #125) is NOT covered here; it requires reverse mapping in
 *     the SSE sniffer and is tracked separately.
 *
 *     Implementation contract:
 *       - Pure: new object returned, input not mutated.
 *       - Identity-preserving when no triggers match: each text block ends
 *         up byte-identical to its input (the underlying
 *         `applyClassifierTriggers` returns the same string reference when
 *         no `pattern` is found).
 *       - Cheap: one synchronous pass over a small constant dictionary.
 *         Sub-millisecond on real traffic (bench in tests).
 */
export const sanitizeSystemForUpstream = (
  b: Record<string, unknown>,
): Record<string, unknown> => {
  const sys = b.system;
  if (!Array.isArray(sys)) return b;
  const rewritten = sys.map((block) => {
    if (block === null || typeof block !== 'object') return block;
    const obj = block as Record<string, unknown>;
    if (typeof obj.text !== 'string') return block;
    const next = applyClassifierTriggers(obj.text);
    if (next === obj.text) return block;
    return { ...obj, text: next };
  });
  return { ...b, system: rewritten };
};

/** Cap on caller-controlled values reflected back into the 400 message — keeps
 * the response body small and bounds any control-character / HTML payload
 * surface (R1 chaos + adversary, #57). 64 chars is enough to tell `image` from
 * `tool_use` from a typo while making blob-stuffing useless. */
const INVALID_BLOCK_TAG_CAP = 64;

/** Sanitize a caller-controlled tag fragment before interpolating it into the
 * 400 message: strip ASCII control chars (including CR/LF that would let a
 * caller forge log lines or HTTP header continuations in downstream sinks),
 * then truncate. */
const sanitizeTag = (s: string): string =>
  s.replace(/[\x00-\x1f\x7f]/g, '?').slice(0, INVALID_BLOCK_TAG_CAP);

/**
 * Generates a short human-readable tag for an invalid block, surfaced in the
 * 400 error message so the caller can self-diagnose without dumping the full
 * (potentially large) request body back at them.
 *
 * Caller-controlled values (currently only `b.type` reaches the output) are
 * passed through `sanitizeTag` to bound size and strip control characters.
 * This matters because the 400 message flows through `app.ts` `onError` into
 * the JSON response body AND into operator log sinks; an un-truncated
 * 100KB `type` field would amplify a single bad request into a 100KB response,
 * and unstripped CR/LF could forge log entries in any downstream aggregator.
 *
 * Branches are ordered to match `isValidSystemBlock` failure modes:
 *   1. null / undefined         → "null" / "undefined"
 *   2. primitive (string/num)    → typeof
 *   3. object, type not string   → "object without string `type`"
 *   4. object, type !== 'text'   → `type="..."` (truncated)
 *   5. object, text not string   → `text=<typeof>`
 *
 * There is NO fallback for `{type:'text', text:string}` because
 * `isValidSystemBlock` returns true for that shape and the caller never enters
 * this code path. If the two predicates ever diverge during refactoring, an
 * assertion failure here is preferable to a misleading `"got object"` message.
 */
const describeInvalidBlock = (block: unknown): string => {
  if (block === null) return 'null';
  if (block === undefined) return 'undefined';
  if (typeof block !== 'object') return typeof block;
  const b = block as { type?: unknown; text?: unknown };
  if (typeof b.type !== 'string') return 'object without string `type`';
  if (b.type !== 'text') return `type="${sanitizeTag(b.type)}"`;
  return `text=${typeof b.text}`;
};

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
  /** Full-content request/response log. The null impl no-ops, so the handler
   * can call `record()` unconditionally. */
  readonly messageLogStore: MessageLogStore;
  /** Cooldown-wrapped sink for messages_log write failures. Same rationale
   * as usageErrorSink — DB outages must not flood stderr. */
  readonly messageLogErrorSink: AlertSink;
}

/**
 * First IP we trust from `X-Forwarded-For`. When the proxy is behind no
 * trusted forwarder this is meaningless, but we capture whatever the client
 * sent for log forensics — it's a hint, not a security control.
 */
const clientIpHint = (c: Context): string | null => {
  const xff = c.req.header('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first && first.length > 0) return first;
  }
  return c.req.header('x-real-ip') ?? null;
};

export const createMessagesHandler =
  (deps: MessagesDeps) =>
  async (c: Context): Promise<Response> => {
    const user = c.get('user');
    const t0 = Date.now();

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
    const clientBody = sanitizeSystemForUpstream(
      ensureSystem(rawBody as Record<string, unknown>),
    );

    // Tool-name aliasing for the sub-plan classifier (#125). The map is
    // per-request — declared here so the downstream response transform can
    // close over it without any module-global state. `outboundBody` is the
    // shape we send upstream; when no triggers fired it's the same reference
    // as `clientBody` and the response chain stays a no-op. We deliberately
    // log this (alias-bearing) shape under `requestBody` so a replay from
    // `messages_log` produces an upstream-identical request and so operators
    // can grep for "which caller triggered which alias". Resolving aliases
    // for the admin UI is a separate follow-up (#131).
    const aliasMap = createAliasMap();
    const outboundBody = rewriteToolNamesForUpstream(
      clientBody,
      TOOL_NAME_TRIGGERS,
      aliasMap,
    );

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
      typeof outboundBody === 'object' && outboundBody !== null
        ? Object.keys(outboundBody as Record<string, unknown>)
        : [];
    const model = (outboundBody as Record<string, unknown>).model;
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
      outboundBody,
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

    // Fire-and-forget log write. The store may be the null impl when the log
    // feature is disabled — in that case `record` is an immediate no-op and
    // the catch never fires. Failures are funneled into a cooldown sink so a
    // DB outage doesn't blow up stderr.
    const bypassMetadata = buildBypassMetadata({
      inboundHeaders: reqHeaders,
      outboundHeaders: upstream.outboundHeaders,
      upstreamHeaders: upstream.response.headers,
      canary: { useCandidate: decision.useCandidate },
    });
    const writeLog = (responseBody: ResponseBody | null, errorMessage: string | null): void => {
      const meta = extractResponseMeta(responseBody);
      void deps.messageLogStore
        .record({
          id: randomUUID(),
          ts: new Date(t0),
          userName: user.name,
          model: extractModel(outboundBody),
          status: upstream.response.status,
          streaming: isStream,
          durationMs: Date.now() - t0,
          inputTokens: meta.inputTokens,
          outputTokens: meta.outputTokens,
          cacheReadTokens: meta.cacheReadTokens,
          cacheCreationTokens: meta.cacheCreationTokens,
          serviceTier: meta.serviceTier,
          stopReason: meta.stopReason,
          clientIp: clientIpHint(c),
          userAgent: c.req.header('user-agent') ?? null,
          requestBody: outboundBody,
          responseBody,
          errorMessage,
          servedBy: upstream.servedBy,
          bypassMetadata,
        })
        .catch((err: unknown) => {
          const msg = `[messages-log] write failed: ${err instanceof Error ? err.message : String(err)}`;
          void deps.messageLogErrorSink(msg);
        });
    };

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

    // Streaming responses (SSE): tap the upstream body for full-content log
    // capture, then run it through sniffUsage for token accounting. Tap sits
    // upstream of sniff so it observes every byte Anthropic sent regardless
    // of whether the client disconnects mid-stream (sniff stops enqueuing in
    // that case but tap's accumulation continues).
    if (isStream && upstream.response.body !== null) {
      const tap = tapResponseBody(upstream.response.body);
      let sniffed = sniffUsage(tap.stream, contentType, onUsage);
      // Reverse tool-name aliases on the caller-facing branch only. The log
      // branch (`tap.getRaw()`) deliberately keeps the wire-raw form — see
      // the alias-policy note above the `aliasMap` declaration and #131.
      if (aliasMap.hasMappings()) {
        sniffed = sniffed.pipeThrough(createReverseToolNameStream(aliasMap));
      }
      // Stream end → write the log. Detached: failures land in the sink.
      void tap.done.then(() => {
        writeLog({ kind: 'sse', raw: tap.getRaw() }, null);
      });
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
    const parsedBody = safeParseJson(bodyText);
    const usage = extractUsage(parsedBody);
    if (usage) {
      onUsage({
        inputTokens: usage.input ?? 0,
        outputTokens: usage.output ?? 0,
        serviceTier: usage.tier,
      });
    }
    // Log capture for non-streaming path. Wrap whichever shape the body
    // actually had: JSON envelope when parseable, raw text otherwise (4xx
    // upstream responses sometimes return non-JSON or empty bodies — see
    // the warn-log above).
    // Non-streaming bodies split three ways:
    //   - parseable JSON → 'json' with the parsed object
    //   - non-empty non-JSON text (HTML error pages, plain-text 4xx) → 'text'
    //   - empty body (the known 429-empty-body case) → null
    // 'sse' is reserved for the streaming branch where `raw` is genuinely
    // wire-format SSE that admin UI can decode event-by-event.
    const responseBody: ResponseBody | null =
      parsedBody !== null
        ? { kind: 'json', body: parsedBody }
        : bodyText.length > 0
          ? { kind: 'text', raw: bodyText }
          : null;
    const errorMessage =
      upstream.response.status >= 400 && parsedBody !== null
        ? extractErrorMessage(parsedBody)
        : null;
    writeLog(responseBody, errorMessage);
    // Reverse tool-name aliases on the caller-facing body only. `responseBody`
    // (already written above) keeps the wire-raw alias form so the log stays
    // consistent with the SSE branch and with what was actually sent upstream.
    const clientFacingBody = aliasMap.hasMappings()
      ? reverseToolNamesInText(bodyText, aliasMap)
      : bodyText;
    return new Response(clientFacingBody, {
      status: upstream.response.status,
      statusText: upstream.response.statusText,
      headers: forwardHeaders(upstream.response.headers),
    });
  };

/**
 * Best-effort pull of `error.message` from an Anthropic-shaped error body.
 * Returns null when the body doesn't match the expected envelope.
 */
const extractErrorMessage = (parsed: unknown): string | null => {
  if (parsed === null || typeof parsed !== 'object') return null;
  const err = (parsed as Record<string, unknown>).error;
  if (err === null || typeof err !== 'object') return null;
  const m = (err as Record<string, unknown>).message;
  return typeof m === 'string' ? m : null;
};
