import type { AccountPool } from '../auth/account-pool.js';
import { DomainError, UpstreamFailed } from '../lib/errors.js';
import type { PacingEnforcer } from '../pacing.js';
import type { ClaudeTemplate } from '../template/types.js';

export interface UpstreamDeps {
  readonly pool: AccountPool;
  readonly template: ClaudeTemplate;
  readonly pacing: PacingEnforcer;
}

// TTFB-only timeout. Covers DNS + TLS + headers; does NOT cover body streaming.
// Rationale (mirrors server.ts / Bun.serve idleTimeout: 0): a wall-clock cap
// on the entire fetch silently truncates valid long-running SSE streams
// (compaction of large conversations, extended thinking, etc.).
//
// INVARIANT (see docs/operational-pitfalls.md #16): this value MUST equal
// Caddyfile's `response_header_timeout`. Caddy < Bun produces silent 504s
// (Caddy aborts before Bun gives up); Caddy > Bun produces a stuck request
// holding upstream connections after Bun has surrendered. A PR that changes
// one without the other should be rejected in review.
//
// 5min → 120s (issue #44, 2026-06-09): with the 5xx retry / 429 failover
// loops removed (this file), single-request wall-clock is bounded by one
// upstream round-trip. 1M-context prefill worst-case is the dominant cost;
// real-world headroom is confirmed via R2 staging behavioral fuzz. The
// SDK declares `x-stainless-timeout: 600` so 120s leaves ample headroom
// without inviting Slowloris pressure. Raise only if R2 metrics show
// repeated abort at TTFB.
const UPSTREAM_TTFB_TIMEOUT_MS = 120 * 1000;

// Streaming hard cap — installed AFTER TTFB succeeds, so legitimate long
// SSE flows freely up to this ceiling. Defense-in-depth replacement for the
// implicit role the old wall-clock fetch timeout used to play: keeps a
// malicious or stuck upstream from holding a concurrency slot indefinitely
// (Slowloris-style). Caddy `read_timeout` (see Caddyfile) covers the
// Caddy→Bun leg; this constant protects the Bun→Anthropic leg directly.
// 20min chosen to comfortably exceed observed worst-case compact + extended-
// thinking streams (~5-10min) with ~2× headroom, while keeping stuck-slot
// turnover within a single SRE response window. Raise if real workloads
// regularly approach the ceiling; lower if Slowloris pressure ever appears.
const STREAMING_HARD_CAP_MS = 20 * 60 * 1000; // 20min

export interface UpstreamResult {
  readonly response: Response;
  /** Which pool member served the request — used by messages.ts for observeResponse. */
  readonly servedBy: string;
}

/**
 * Internal result from a single fetchOnce attempt. The streaming timer is
 * exposed so callers that intend to cancel the body (e.g. callUpstream's
 * 401 retry path) can clear it instead of leaving a 20-minute orphan
 * timer pinning the AbortController in a closure.
 */
interface FetchOnceResult {
  readonly response: Response;
  readonly streamingTimer: ReturnType<typeof setTimeout> | undefined;
}

/** Bun/Node setTimeout returns a Timer/Timeout object that holds the event
 * loop alive by default. unref() opts the timer out of keep-alive so a
 * pending 20-minute streaming cap doesn't delay SIGTERM shutdown. Safe
 * no-op on runtimes that lack unref(). */
const unrefTimer = (t: ReturnType<typeof setTimeout>): void => {
  const u = (t as unknown as { unref?: () => void }).unref;
  if (typeof u === 'function') u.call(t);
};

/**
 * Performs one fetch attempt guarded by a TTFB-only abort signal. Returns
 * both the Response and the AbortController so the caller can install a
 * streaming hard cap that reuses the same signal post-TTFB.
 */
const fetchWithTtfbGuard = async (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
  ttfbMs: number,
): Promise<{ response: Response; controller: AbortController }> => {
  const controller = new AbortController();
  const ttfbTimer = setTimeout(() => controller.abort(), ttfbMs);
  unrefTimer(ttfbTimer);
  try {
    const response = await fetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: controller.signal,
    });
    return { response, controller };
  } finally {
    // fetch() resolved or threw — either way the TTFB phase is over.
    // Body streaming runs unclamped from the caller's point of view.
    clearTimeout(ttfbTimer);
  }
};

/**
 * Wraps a pre-network fetchOnce stage (template.apply, pacing.await) so raw
 * exceptions land in onError as a DomainError with a distinct code. Status
 * is 500 — template/pacing failures are server-internal, not upstream-network
 * failures, so the 502 default would be misleading. Existing DomainErrors
 * pass through unchanged.
 */
const wrapFetchOnceStage = async <T>(
  code: string,
  label: string,
  stage: () => Promise<T>,
): Promise<T> => {
  try {
    return await stage();
  } catch (e) {
    if (e instanceof DomainError) throw e;
    // UpstreamFailed factory is reused for code/headers shape, but status is 500
    // (not the 502 default): the failure happened inside the proxy *before* any
    // network attempt, so reporting it as an upstream-network problem would
    // mislead alerts. `code` (e.g. template_apply_failed) carries the distinction.
    throw UpstreamFailed(`${label}: ${e instanceof Error ? e.message : String(e)}`, 500, code);
  }
};

/**
 * Single fetch attempt to upstream. Transparent proxy policy (#44):
 *   - 5xx is NOT retried here. POST /v1/messages is non-idempotent and
 *     a same-org pool can't distribute upstream quota, so retrying only
 *     wastes wall-clock and risks double-submission. The status (and
 *     upstream's headers/body) is surfaced verbatim to the client.
 *   - 401 is handled by the outer callUpstream — only this layer holds
 *     the refresh token.
 *   - 429 is handled by the outer callUpstream — surfaced verbatim with
 *     no failover (Retry-After / X-Should-Retry let the SDK back off).
 */
const fetchOnce = async (
  clientBody: unknown,
  clientHeaders: Headers | undefined,
  accessToken: string,
  template: ClaudeTemplate,
  pacing: PacingEnforcer,
): Promise<FetchOnceResult> => {
  // template.apply and pacing.await both run before the network call. Raw
  // exceptions from these (e.g. TypeError from a malformed snapshot, a non-
  // DomainError ConfigError variant from a pacing-map invariant violation)
  // would otherwise reach Hono onError as generic 500s, making same-class
  // failures ("can't talk to upstream") log as two different shapes. Convert
  // to DomainError with a distinct code so incident triage stays uniform.
  // DomainError already has an identifiable code — re-throw as-is so we
  // don't double-wrap (e.g. a ConfigError stays a config_error, not a
  // template_apply_failed).
  const outbound = await wrapFetchOnceStage(
    'template_apply_failed',
    'template apply failed',
    () => template.apply({ clientBody, accessToken, clientHeaders }),
  );
  // Pace by the session-id we're about to send (CC's view of "same session").
  await wrapFetchOnceStage('pacing_await_failed', 'pacing await failed', () =>
    pacing.await(outbound.headers['x-claude-code-session-id']),
  );
  try {
    const { response, controller } = await fetchWithTtfbGuard(
      outbound.url,
      { method: outbound.method, headers: outbound.headers, body: outbound.body },
      UPSTREAM_TTFB_TIMEOUT_MS,
    );
    // Arms the streaming hard cap for responses handed back to the caller.
    // Reuses the same AbortController — its abort() now targets the body
    // stream instead of the request phase. The timer ref is returned so
    // callers that intend to discard the body (callUpstream's 401 retry)
    // can clear it; otherwise it fires at STREAMING_HARD_CAP_MS and is a
    // no-op if the body already drained.
    const streamingTimer = setTimeout(() => controller.abort(), STREAMING_HARD_CAP_MS);
    unrefTimer(streamingTimer);
    return { response, streamingTimer };
  } catch (e) {
    throw UpstreamFailed(`upstream fetch failed: ${e instanceof Error ? e.message : String(e)}`);
  }
};

/**
 * Retry policy (#44 — transparent proxy):
 *   - 401  → force refresh the SAME pool member, retry once.
 *   - 429 / 5xx / anything else → surface to the client unchanged.
 *
 * 401 is the only status this layer can act on (we hold the refresh token).
 * 429 used to trigger pool failover, but a same-org pool shares the upstream
 * quota — failover within the same org returns the same answer and only burns
 * wall-clock, converting a truthful 429 into a Caddy 504. The SDK already has
 * a Retry-After-aware backoff for 429s; we get out of its way.
 */
export const callUpstream = async (
  clientBody: unknown,
  clientHeaders: Headers | undefined,
  sessionId: string | undefined,
  deps: UpstreamDeps,
): Promise<UpstreamResult> => {
  const first = await deps.pool.getAccessToken(sessionId);
  const firstAttempt = await fetchOnce(
    clientBody,
    clientHeaders,
    first.token,
    deps.template,
    deps.pacing,
  );

  if (firstAttempt.response.status !== 401) {
    return { response: firstAttempt.response, servedBy: first.name };
  }

  // OAuth refresh path — same account, new token. Body of the 401 is
  // never surfaced to the client (we're about to retry), so cancel to
  // free the underlying connection AND clear the streaming hard cap so
  // its 20-minute orphan timer doesn't hold the AbortController alive.
  if (firstAttempt.streamingTimer !== undefined) clearTimeout(firstAttempt.streamingTimer);
  await firstAttempt.response.body?.cancel().catch(() => undefined);
  const freshToken = await deps.pool.forceRefresh(first.name);
  const retryAttempt = await fetchOnce(
    clientBody,
    clientHeaders,
    freshToken,
    deps.template,
    deps.pacing,
  );
  return { response: retryAttempt.response, servedBy: first.name };
};
