import type { Context, Next } from 'hono';
import { TooManyRequests } from '../lib/errors.js';

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
