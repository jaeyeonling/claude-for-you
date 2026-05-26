import type { AccountPool } from '../auth/account-pool.js';
import { UpstreamFailed } from '../lib/errors.js';
import type { PacingEnforcer } from '../pacing.js';
import type { ClaudeTemplate } from '../template/types.js';

export interface UpstreamDeps {
  readonly pool: AccountPool;
  readonly template: ClaudeTemplate;
  readonly pacing: PacingEnforcer;
}

const UPSTREAM_TIMEOUT_MS = 300_000; // 5min — accommodates long streaming responses

export interface UpstreamResult {
  readonly response: Response;
  /** Which pool member served the request — used by messages.ts for observeResponse. */
  readonly servedBy: string;
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const fetchOnce = async (
  clientBody: unknown,
  clientHeaders: Headers | undefined,
  accessToken: string,
  template: ClaudeTemplate,
  pacing: PacingEnforcer,
): Promise<Response> => {
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
      const res = await fetch(outbound.url, {
        method: outbound.method,
        headers: outbound.headers,
        body: outbound.body,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (isTransient5xx(res.status) && attempt < FIVE_XX_MAX_ATTEMPTS - 1) {
        // Consume the body so the connection can be reused.
        await res.body?.cancel().catch(() => undefined);
        lastResponse = res;
        continue;
      }
      return res;
    } catch (e) {
      lastNetworkError = e;
      // Network errors (timeout, DNS, connection reset) — retry like 5xx.
      if (attempt < FIVE_XX_MAX_ATTEMPTS - 1) continue;
      throw UpstreamFailed(`upstream fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (lastResponse) return lastResponse;
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
  const firstRes = await fetchOnce(
    clientBody,
    clientHeaders,
    first.token,
    deps.template,
    deps.pacing,
  );

  if (firstRes.status !== 401 && firstRes.status !== 429) {
    return { response: firstRes, servedBy: first.name };
  }

  if (firstRes.status === 401) {
    // OAuth refresh path — same account, new token. Body of the 401 is
    // never surfaced to the client (we're about to retry), so cancel to
    // free the underlying connection.
    await firstRes.body?.cancel().catch(() => undefined);
    const freshToken = await deps.pool.forceRefresh(first.name);
    const retryRes = await fetchOnce(
      clientBody,
      clientHeaders,
      freshToken,
      deps.template,
      deps.pacing,
    );
    return { response: retryRes, servedBy: first.name };
  }

  // 429 — try failover to another pool member if one exists.
  const failover = await deps.pool.getAccessTokenExcluding(sessionId, first.name);
  if (failover === null) {
    // Single-account pool (or all members rate-limited): we're about to
    // surface this exact 429 to the client. DO NOT cancel the body — the
    // upstream's error JSON (e.g. {"type":"rate_limit_error",...}) lives
    // there and downstream needs to read it via .text(). Cancelling here
    // used to silently emit an empty body to the client.
    return { response: firstRes, servedBy: first.name };
  }
  await firstRes.body?.cancel().catch(() => undefined);
  const retryRes = await fetchOnce(
    clientBody,
    clientHeaders,
    failover.token,
    deps.template,
    deps.pacing,
  );
  return { response: retryRes, servedBy: failover.name };
};
