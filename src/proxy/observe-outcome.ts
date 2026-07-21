import { randomUUID } from 'node:crypto';
import type { Context, Next } from 'hono';
import type { AlertSink } from '../alerts.js';
import type { AuthenticatedUser } from '../auth/api-key.js';
import { log } from '../lib/logger.js';
import { redact } from '../lib/redact.js';
import {
  classifyProxySource,
  extractErrorMessage,
  type MessageLogStore,
} from '../usage/messages-log.js';
import { clientIpHint } from './messages.js';

/**
 * Pre-handler outcome observer (issue #144).
 *
 * The /v1/messages handler only writes to messages_log AFTER its upstream call
 * returns, so failures that die earlier — the proxy's own concurrency/quota
 * 429, an oversized 413, a malformed-body 400, a template_apply_failed /
 * pacing_await_failed 500, a failed upstream fetch 502 — were invisible in the
 * admin dashboard, making it impossible to tell a proxy-side 429 from a real
 * Anthropic rate-limit 429. This middleware records exactly one lightweight row
 * for any such failure the handler did not already log.
 *
 * PLACEMENT (see app.ts): registered AFTER the api-key middleware, before the
 * body-limit and rate limiters. Deliberately NOT outermost — an outermost
 * observer would record a DB row for every unauthenticated 401, letting an
 * anonymous client with no valid key flood messages_log (a write-amplification
 * DoS; check-R1 adversary/chaos). Sitting after api-key means only
 * authenticated requests reach it, so writes are bounded by valid-key holders.
 * The trade-off — auth-failure 401s are not in the dashboard — is acceptable:
 * they stay in stderr ([api-key] warn) and carry little diagnostic value.
 *
 * Mechanism (pinned down by the gating spike, tests/observe-outcome.test.ts):
 * with app.onError registered, a downstream throw is converted to a response by
 * onError BEFORE the outer `await next()` resolves — so there is nothing to
 * catch. The uniform signal for thrown AND non-throw failures is
 * `c.res.status >= 400` after next().
 *
 * Invariants:
 *   - Never THROWS. All post-next work is wrapped so a logging fault can never
 *     replace the real error response with an onError 500 (check-R1 chaos).
 *   - Never reads the request body (would race the handler's c.req.json()).
 *     Pre-handler rows carry requestBody / model = null.
 *   - Records ONLY on failure (status >= 400); a 2xx is never logged.
 *   - Skips when the handler already logged (c.get('logged') === true).
 *   - Globally rate-limited writes: a 429/5xx storm cannot outrun the small
 *     messages_log connection pool (check-R1 chaos self-amplification). Excess
 *     failures are dropped from the log (not from the response) and counted.
 *   - errorMessage is redacted before storage — the row is persisted and
 *     admin-visible, a wider exposure window than the one-shot response
 *     (check-R1 adversary), so it gets the same scrubbing as alarm sinks.
 */

// `logged` on Hono's ContextVariableMap is declared at its producer
// (proxy/messages.ts); the augmentation is global, so it is in scope here via
// the import from ./messages.js. No redeclaration needed.

/** Max observer log-writes per second (global, not per-IP: an authenticated
 * caller's X-Forwarded-For is spoofable, so a per-IP bucket could be bypassed
 * by rotating the header; a single global bucket bounds total DB write pressure
 * regardless). Generous vs. real failure rates — only a storm hits it.
 *
 * This exists to protect the messages_log connection pool
 * (`postgres(..., { max: 2 })` in usage/messages-log-postgres.ts) from a
 * 429/5xx write storm. If that pool size changes, revisit these — the cap
 * should stay comfortably above what `max` connections can drain, so writes
 * shed here rather than queue unboundedly in postgres.js. (Trade-off: a single
 * busy key can exhaust the shared budget and hide other keys' failure rows —
 * acceptable for this small trusted-key deployment; a per-key sub-budget would
 * be the multi-tenant answer.) */
const WRITE_TOKENS_PER_SEC = 20;
const WRITE_BURST = 40;
/** Cooldown between "dropped N rows" warnings so the drop itself can't flood
 * the log it is protecting. */
const DROP_WARN_COOLDOWN_MS = 5000;

export interface OutcomeObserverDeps {
  readonly store: MessageLogStore;
  readonly errorSink: AlertSink;
}

export const createOutcomeObserver = (deps: OutcomeObserverDeps) => {
  // Global token bucket for log writes.
  let tokens = WRITE_BURST;
  let lastRefillAt = Date.now();
  let dropped = 0;
  let lastDropWarnAt = 0;

  const admitWrite = (now: number): boolean => {
    const elapsed = now - lastRefillAt;
    if (elapsed > 0) {
      tokens = Math.min(WRITE_BURST, tokens + (elapsed * WRITE_TOKENS_PER_SEC) / 1000);
      lastRefillAt = now;
    }
    if (tokens < 1) {
      dropped += 1;
      if (now - lastDropWarnAt >= DROP_WARN_COOLDOWN_MS) {
        log.warn(`[observe-outcome] failure-log write throttled — ${dropped} row(s) dropped since last notice`);
        lastDropWarnAt = now;
        dropped = 0;
      }
      return false;
    }
    tokens -= 1;
    return true;
  };

  return async (c: Context, next: Next): Promise<void> => {
    const start = Date.now();
    await next();

    // Everything below is best-effort observation — it must NEVER throw, or
    // Hono's onError would replace the real pre-handler response (with its
    // meaningful status/headers) with a generic 500.
    try {
      if (c.get('logged') === true) return; // handler owns this row
      const status = c.res.status;
      if (status < 400) return; // only failures

      const now = Date.now();
      if (!admitWrite(now)) return; // storm shedding — response is untouched

      // Small JSON error envelope from onError / bodyLimit. Clone so reading
      // it doesn't disturb the response streamed to the client. redact() the
      // extracted message — it lands in durable, admin-visible storage.
      let errorMessage: string | null = null;
      try {
        const body = await c.res.clone().text();
        const msg = extractErrorMessage(safeParse(body));
        errorMessage = msg === null ? null : redact(msg);
      } catch {
        errorMessage = null;
      }

      const user = c.get('user') as AuthenticatedUser | undefined;

      void deps.store
        .record({
          id: randomUUID(),
          ts: new Date(start),
          userName: user?.name ?? '-',
          model: null,
          status,
          streaming: false,
          durationMs: now - start,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          serviceTier: null,
          stopReason: null,
          clientIp: clientIpHint(c),
          userAgent: c.req.header('user-agent') ?? null,
          requestBody: null,
          responseBody: null,
          errorMessage,
          servedBy: null,
          source: classifyProxySource(status),
          bypassMetadata: null,
        })
        .catch((err: unknown) => {
          const m = `[observe-outcome] write failed: ${err instanceof Error ? err.message : String(err)}`;
          void deps.errorSink(m).catch(() => undefined);
        });
    } catch (err: unknown) {
      // Observation itself faulted — swallow to preserve the client response.
      const m = `[observe-outcome] observation error: ${err instanceof Error ? err.message : String(err)}`;
      void deps.errorSink(m).catch(() => undefined);
    }
  };
};

const safeParse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
