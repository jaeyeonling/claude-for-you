import { randomUUID } from 'node:crypto';
import type { Context, Next } from 'hono';
import type { AlertSink } from '../alerts.js';
import type { AuthenticatedUser } from '../auth/api-key.js';
import {
  classifyProxySource,
  type MessageLogStore,
} from '../usage/messages-log.js';
import { clientIpHint } from './messages.js';

/**
 * Pre-handler outcome observer (issue #144).
 *
 * The `/v1/messages` handler only writes to `messages_log` AFTER its upstream
 * call returns, so every failure that dies earlier — the proxy's own
 * concurrency/quota 429, an api-key 401, an oversized 413, a malformed-body
 * 400, a `template_apply_failed`/`pacing_await_failed` 500, a failed upstream
 * fetch 502 — was invisible in the admin dashboard. This middleware, registered
 * OUTERMOST on `/v1/messages` (before the api-key middleware), records exactly
 * one lightweight row for any such failure the handler did not already log.
 *
 * Mechanism (pinned down by the gating spike, tests/observe-outcome.test.ts):
 * with `app.onError` registered, a downstream throw is converted to a response
 * by onError BEFORE the outer `await next()` resolves — so there is NOTHING to
 * catch here. The uniform signal for both thrown and non-throw failures is
 * `c.res.status >= 400` after `next()`. No try/catch, no rethrow.
 *
 * Invariants:
 *   - Never reads the request body (would race the handler's `c.req.json()` and
 *     add cost to the happy path). Pre-handler rows carry requestBody/model=null.
 *   - Records ONLY on failure (status >= 400) — a 2xx is never logged, so a
 *     success is never mislabelled as a proxy failure.
 *   - Skips when the handler already logged (`c.get('logged') === true`), so no
 *     row is double-written for requests that reached upstream.
 *   - Fire-and-forget write; a logging failure is funneled to the error sink
 *     and never changes the response the client sees.
 */

declare module 'hono' {
  interface ContextVariableMap {
    /** Set true by the messages handler once it owns the log write, so the
     * outermost outcome observer does not double-record. */
    logged: boolean;
  }
}

export interface OutcomeObserverDeps {
  readonly store: MessageLogStore;
  readonly errorSink: AlertSink;
}

/** Best-effort `error.message` from a small Anthropic/DomainError-shaped JSON
 * error body. Returns null on any parse miss — status + source carry the
 * primary signal, the message is a nicety. */
const extractErrorMessage = (text: string): string | null => {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== 'object') return null;
    const err = (parsed as Record<string, unknown>).error;
    if (err === null || typeof err !== 'object') return null;
    const m = (err as Record<string, unknown>).message;
    return typeof m === 'string' ? m : null;
  } catch {
    return null;
  }
};

export const createOutcomeObserver = (deps: OutcomeObserverDeps) => {
  return async (c: Context, next: Next): Promise<void> => {
    const start = Date.now();
    await next();

    // Handler already recorded this request (it reached upstream) — nothing to do.
    if (c.get('logged') === true) return;

    const status = c.res.status;
    // Only failures are of interest. A 2xx that skipped `logged` would be a
    // non-inference route; never log a success as a failure row.
    if (status < 400) return;

    // The error body is a small JSON envelope from onError / bodyLimit. Clone
    // so reading it doesn't disturb the response streamed to the client.
    const errorMessage = await c.res
      .clone()
      .text()
      .then(extractErrorMessage)
      .catch(() => null);

    const user = c.get('user') as AuthenticatedUser | undefined;

    void deps.store
      .record({
        id: randomUUID(),
        ts: new Date(start),
        userName: user?.name ?? '-',
        model: null,
        status,
        streaming: false,
        durationMs: Date.now() - start,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        serviceTier: null,
        stopReason: null,
        clientIp: clientIpHint(c),
        userAgent: c.req.header('user-agent') ?? null,
        // Never read the request body here (see invariants) — pre-handler rows
        // have no parsed body.
        requestBody: null,
        responseBody: null,
        errorMessage,
        // Never reached the OAuth pool.
        servedBy: null,
        bypassMetadata: null,
        source: classifyProxySource(status),
      })
      .catch((err: unknown) => {
        const msg = `[observe-outcome] write failed: ${err instanceof Error ? err.message : String(err)}`;
        void deps.errorSink(msg);
      });
  };
};
