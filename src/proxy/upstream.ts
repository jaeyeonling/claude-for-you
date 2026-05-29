import type { AccountPool } from '../auth/account-pool.js';
import { UpstreamFailed } from '../lib/errors.js';
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
// The SDK declares `x-stainless-timeout: 600` (10min) for total — this is the
// hard ceiling we could raise to if operator metrics show 5min TTFB ever
// happens for 1M-context prefill. Past 600s we'd be lying to the SDK.
// Abuse defense for the TTFB phase lives in earlier layers (Caddy edge
// limits, per-IP rate limiter, concurrency limiter, payload-size gate).
const UPSTREAM_TTFB_TIMEOUT_MS = 5 * 60 * 1000; // 5min — matches legacy total cap

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
 * 401/429 retry paths) can clear it instead of leaving a 20-minute orphan
 * timer pinning the AbortController in a closure.
 */
interface FetchOnceResult {
  readonly response: Response;
  readonly streamingTimer: ReturnType<typeof setTimeout> | undefined;
}

// 5xx retry: small fixed budget with full jitter so a flapping upstream
// doesn't pin one pool member or burst-retry into the same outage window.
const FIVE_XX_MAX_ATTEMPTS = 2; // total attempts including the first
const FIVE_XX_BASE_DELAY_MS = 250;
const FIVE_XX_MAX_DELAY_MS = 2_000;

const isTransient5xx = (status: number): boolean =>
  status === 502 || status === 503 || status === 504;

const fullJitterDelay = (attempt: number): number => {
  const upper = Math.min(FIVE_XX_BASE_DELAY_MS * 2 ** attempt, FIVE_XX_MAX_DELAY_MS);
  return Math.floor(Math.random() * upper);
};

/** Bun/Node setTimeout returns a Timer/Timeout object that holds the event
 * loop alive by default. unref() opts the timer out of keep-alive so a
 * pending 20-minute streaming cap (or 5xx retry sleep) doesn't delay
 * SIGTERM shutdown. Safe no-op on runtimes that lack unref(). */
const unrefTimer = (t: ReturnType<typeof setTimeout>): void => {
  const u = (t as unknown as { unref?: () => void }).unref;
  if (typeof u === 'function') u.call(t);
};

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => {
    const t = setTimeout(r, ms);
    unrefTimer(t);
  });

/**
 * Performs one fetch attempt guarded by a TTFB-only abort signal. Returns
 * both the Response and the AbortController so the caller can install a
 * streaming hard cap that reuses the same signal post-TTFB. Extracted from
 * fetchOnce so the nested try-finally for timer cleanup lives in one place.
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

const fetchOnce = async (
  clientBody: unknown,
  clientHeaders: Headers | undefined,
  accessToken: string,
  template: ClaudeTemplate,
  pacing: PacingEnforcer,
): Promise<FetchOnceResult> => {
  // Transparent retry on transient upstream 5xx. Auth-related statuses
  // (401/429) are handled by the outer caller because they require a
  // different token / different pool member.
  let lastNetworkError: unknown = null;
  let lastResponse: Response | null = null;

  for (let attempt = 0; attempt < FIVE_XX_MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(fullJitterDelay(attempt - 1));
    const outbound = await template.apply({ clientBody, accessToken, clientHeaders });
    // Pace by the session-id we're about to send (CC's view of "same session").
    await pacing.await(outbound.headers['x-claude-code-session-id']);
    try {
      const { response: res, controller } = await fetchWithTtfbGuard(
        outbound.url,
        { method: outbound.method, headers: outbound.headers, body: outbound.body },
        UPSTREAM_TTFB_TIMEOUT_MS,
      );
      if (isTransient5xx(res.status) && attempt < FIVE_XX_MAX_ATTEMPTS - 1) {
        // Consume the body so the connection can be reused. No streaming
        // timer to clean up — it's only installed for the success path below.
        await res.body?.cancel().catch(() => undefined);
        lastResponse = res;
        continue;
      }
      // Arms the streaming hard cap for responses handed back to the caller.
      // Reuses the same AbortController — its abort() now targets the body
      // stream instead of the request phase. The timer ref is returned so
      // callers that intend to discard the body (callUpstream's 401/429
      // retries) can clear it; otherwise it fires at STREAMING_HARD_CAP_MS
      // and is a no-op if the body already drained.
      const streamingTimer = setTimeout(() => controller.abort(), STREAMING_HARD_CAP_MS);
      unrefTimer(streamingTimer);
      return { response: res, streamingTimer };
    } catch (e) {
      lastNetworkError = e;
      // Network errors (timeout, DNS, connection reset) — retry like 5xx.
      if (attempt < FIVE_XX_MAX_ATTEMPTS - 1) continue;
      throw UpstreamFailed(`upstream fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Defensive fallback: currently unreachable in normal flow. With
  // FIVE_XX_MAX_ATTEMPTS=2, the final attempt either returns via the
  // success path above (with streaming cap armed) or throws via catch.
  // If this branch is ever taken via future logic changes, the body of
  // `lastResponse` is already cancelled (line ~106), so streaming cap is
  // moot — the client receives an empty body anyway. streamingTimer:
  // undefined is therefore the correct contract here.
  if (lastResponse) {
    return { response: lastResponse, streamingTimer: undefined };
  }
  throw UpstreamFailed(
    `upstream fetch failed: ${lastNetworkError instanceof Error ? lastNetworkError.message : String(lastNetworkError)}`,
  );
};

/**
 * Retry policy:
 *   - 401  → force refresh the SAME pool member, retry once
 *   - 429  → failover to a DIFFERENT pool member if available, retry once
 *
 * Anything else (including a still-401 on retry or a 429 with no other
 * member available) surfaces to the client unchanged.
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

  if (firstAttempt.response.status !== 401 && firstAttempt.response.status !== 429) {
    return { response: firstAttempt.response, servedBy: first.name };
  }

  if (firstAttempt.response.status === 401) {
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
  }

  // 429 — try failover to another pool member if one exists.
  const failover = await deps.pool.getAccessTokenExcluding(sessionId, first.name);
  if (failover === null) {
    // Single-account pool (or all members rate-limited): we're about to
    // surface this exact 429 to the client. DO NOT cancel the body — the
    // upstream's error JSON (e.g. {"type":"rate_limit_error",...}) lives
    // there and downstream needs to read it via .text(). Cancelling here
    // used to silently emit an empty body to the client.
    // Streaming timer is intentionally left armed: messages.ts may stream
    // this body, so the hard cap applies as it would for any 200.
    return { response: firstAttempt.response, servedBy: first.name };
  }
  if (firstAttempt.streamingTimer !== undefined) clearTimeout(firstAttempt.streamingTimer);
  await firstAttempt.response.body?.cancel().catch(() => undefined);
  const retryAttempt = await fetchOnce(
    clientBody,
    clientHeaders,
    failover.token,
    deps.template,
    deps.pacing,
  );
  return { response: retryAttempt.response, servedBy: failover.name };
};
