import type { Context, Next } from 'hono';
import type { AuthenticatedUser } from '../auth/api-key.js';
import { TooManyRequests } from '../lib/errors.js';
import { log } from '../lib/logger.js';

/** Retry-After value (seconds) for per-key 429s. 1s is intentionally tight:
 * the cap is meant to throttle one busy key without making it wait long,
 * and clients with proper backoff will multiply this. */
const PER_KEY_RETRY_AFTER_SECONDS = '1';

/** Sentinel bucket used when api-key middleware didn't populate `user`.
 * Production middleware order guarantees this never appears, but if it
 * does we want one shared bucket (so the cap still applies) AND a runtime
 * warning so the misconfiguration is visible. */
const UNKNOWN_KEY = '__unknown__';

/** Cooldown between log.warn lines for a noisy event (per-key cap hit,
 * unknown-user fallback). Burst traffic that all rejects under the same
 * condition emits one warn per second, with the suppressed count attached
 * on the next emission — log pipeline stays healthy, signal preserved. */
const WARN_COOLDOWN_MS = 1000;

interface WarnThrottle {
  lastEmittedAt: number;
  suppressed: number;
}

/** Rate-limited warn helper. Returns true if the warn was emitted (so the
 * caller can update auxiliary state); false if it was suppressed. Counts
 * are merged into the next emission's message to avoid losing signal. */
const throttledWarn = (state: WarnThrottle, message: string): boolean => {
  const now = Date.now();
  if (now - state.lastEmittedAt < WARN_COOLDOWN_MS) {
    state.suppressed += 1;
    return false;
  }
  const tail = state.suppressed > 0 ? ` (+${state.suppressed} suppressed since last)` : '';
  log.warn(`${message}${tail}`);
  state.lastEmittedAt = now;
  state.suppressed = 0;
  return true;
};

/**
 * Bounded concurrency middleware — caps the number of in-flight requests
 * to /v1/messages. Wired so a single misbehaving (or compromised) API key
 * can't exhaust the proxy's resources or pile up against Anthropic's
 * subscription rate limit.
 *
 * Rejects with 429 once the cap is reached; clients see a deterministic
 * "try again later" rather than the request being silently queued.
 */
export const createConcurrencyLimiter = (max: number) => {
  if (max <= 0) {
    // 0 = unlimited — preserve historical behavior.
    return async (_c: Context, next: Next): Promise<void> => {
      await next();
    };
  }
  let inFlight = 0;
  return async (_c: Context, next: Next): Promise<void> => {
    if (inFlight >= max) {
      throw TooManyRequests(`max concurrent requests reached (${max})`);
    }
    inFlight += 1;
    try {
      await next();
    } finally {
      inFlight -= 1;
    }
  };
};

/**
 * Per-key bounded concurrency — caps in-flight requests by API key identity
 * so a single (buggy or compromised) client cannot monopolize the global
 * slot pool while other keys are starved. Sits alongside the global
 * concurrency limiter as the second layer of slot-fairness defense.
 *
 * Relies on the api-key middleware running first to populate `c.var.user`
 * (typed via Hono's `ContextVariableMap` in src/auth/api-key.ts). If user
 * is somehow absent (misconfigured middleware order), requests share the
 * UNKNOWN_KEY bucket so the cap still applies, AND a one-time warning is
 * logged so the misconfiguration becomes visible.
 *
 * 429 responses include `Retry-After: 1` so backoff-aware clients don't
 * busy-loop against a transient per-key burst.
 */
export const createPerKeyConcurrencyLimiter = (max: number) => {
  if (max <= 0) {
    return async (_c: Context, next: Next): Promise<void> => {
      await next();
    };
  }
  const inFlightByKey = new Map<string, number>();
  // Throttle state lives inside the closure so each limiter instance has
  // its own cooldown clock — improves test isolation vs. module-level state.
  const capWarn: WarnThrottle = { lastEmittedAt: 0, suppressed: 0 };
  const unknownWarn: WarnThrottle = { lastEmittedAt: 0, suppressed: 0 };
  return async (c: Context, next: Next): Promise<void> => {
    const user = c.get('user') as AuthenticatedUser | undefined;
    if (user === undefined) {
      throttledWarn(
        unknownWarn,
        '[concurrency] per-key limiter ran without c.var.user — ' +
          'api-key middleware must run before this limiter. ' +
          'Requests are sharing the UNKNOWN_KEY bucket until fixed.',
      );
    }
    const key = user?.name ?? UNKNOWN_KEY;
    const current = inFlightByKey.get(key) ?? 0;
    if (current >= max) {
      // Generic message: do not echo the key name (avoids identity leak in
      // error responses). Server-side warn is rate-limited so a burst of
      // rejects can't flood the log sink.
      throttledWarn(capWarn, `[concurrency] per-key cap reached (limit=${max})`);
      throw TooManyRequests(`per-key concurrency cap reached (limit=${max})`, {
        'retry-after': PER_KEY_RETRY_AFTER_SECONDS,
      });
    }
    inFlightByKey.set(key, current + 1);
    try {
      await next();
    } finally {
      const remaining = (inFlightByKey.get(key) ?? 1) - 1;
      if (remaining <= 0) inFlightByKey.delete(key);
      else inFlightByKey.set(key, remaining);
    }
  };
};
