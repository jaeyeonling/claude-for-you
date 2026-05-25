import type { Context, Next } from 'hono';
import { TooManyRequests } from '../lib/errors.js';

/**
 * Per-IP token bucket. Caps bursts from any one client IP independently of
 * `MAX_CONCURRENT_REQUESTS` (which is global). A leaked key from one source
 * IP can no longer pin all 8 slots; well-behaved CC clients see no change.
 *
 * Bucket size is `burst`; refill rate is `perSecond`. A request consumes
 * 1 token. If the bucket is empty → 429.
 *
 * Memory: one entry per active IP. Idle entries are GC'd after 5 minutes of
 * inactivity (sweep on next request from any IP — no timers).
 */

export interface RateLimitParams {
  /** Tokens per second (refill rate). 0 disables the middleware. */
  readonly perSecond: number;
  /** Max tokens in the bucket (burst capacity). Default = perSecond * 2. */
  readonly burst?: number;
  /** Override the IP extractor — useful for tests / unusual proxy chains. */
  readonly clientIp?: (c: Context) => string;
}

interface Bucket {
  tokens: number;
  lastRefillAt: number;
  lastSeenAt: number;
}

const IDLE_EVICT_MS = 5 * 60 * 1000;

const defaultClientIp = (c: Context): string => {
  // Behind Caddy/Cloudflare/ALB the original IP arrives in X-Forwarded-For.
  // We take the leftmost token; deeper providers can override clientIp.
  const xff = c.req.header('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first && first.length > 0) return first;
  }
  return c.req.header('x-real-ip') ?? 'unknown';
};

export const createIpRateLimiter = (params: RateLimitParams) => {
  if (params.perSecond <= 0) {
    return async (_c: Context, next: Next): Promise<void> => {
      await next();
    };
  }
  const burst = params.burst ?? params.perSecond * 2;
  const refillPerMs = params.perSecond / 1000;
  const buckets = new Map<string, Bucket>();
  const ipOf = params.clientIp ?? defaultClientIp;

  const sweep = (now: number): void => {
    if (buckets.size < 64) return; // skip sweep until the map grows
    for (const [ip, b] of buckets) {
      if (now - b.lastSeenAt > IDLE_EVICT_MS) buckets.delete(ip);
    }
  };

  return async (c: Context, next: Next): Promise<void> => {
    const now = Date.now();
    sweep(now);

    const ip = ipOf(c);
    let b = buckets.get(ip);
    if (!b) {
      b = { tokens: burst, lastRefillAt: now, lastSeenAt: now };
      buckets.set(ip, b);
    }

    // Refill since last touch.
    const elapsed = now - b.lastRefillAt;
    if (elapsed > 0) {
      b.tokens = Math.min(burst, b.tokens + elapsed * refillPerMs);
      b.lastRefillAt = now;
    }
    b.lastSeenAt = now;

    if (b.tokens < 1) {
      throw TooManyRequests(`per-IP rate limit exceeded for ${ip}`);
    }
    b.tokens -= 1;
    await next();
  };
};
