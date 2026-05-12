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

const fetchOnce = async (
  clientBody: unknown,
  clientHeaders: Headers | undefined,
  accessToken: string,
  template: ClaudeTemplate,
  pacing: PacingEnforcer,
): Promise<Response> => {
  const outbound = await template.apply({ clientBody, accessToken, clientHeaders });
  // Pace by the session-id we're about to send (CC's view of "same session").
  await pacing.await(outbound.headers['x-claude-code-session-id']);
  try {
    return await fetch(outbound.url, {
      method: outbound.method,
      headers: outbound.headers,
      body: outbound.body,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (e) {
    throw UpstreamFailed(`upstream fetch failed: ${e instanceof Error ? e.message : String(e)}`);
  }
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

  await firstRes.body?.cancel().catch(() => undefined);

  if (firstRes.status === 401) {
    // OAuth refresh path — same account, new token.
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

  // 429 — failover to another pool member if available.
  const failover = await deps.pool.getAccessTokenExcluding(sessionId, first.name);
  if (failover === null) {
    // Single-account pool or all members rate-limited — return the original
    // 429 to the client. They can back off naturally.
    return { response: firstRes, servedBy: first.name };
  }
  const retryRes = await fetchOnce(
    clientBody,
    clientHeaders,
    failover.token,
    deps.template,
    deps.pacing,
  );
  return { response: retryRes, servedBy: failover.name };
};
