import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { createIpRateLimiter } from '../src/proxy/rate-limit.js';
import { DomainError } from '../src/lib/errors.js';

const buildApp = (params: Parameters<typeof createIpRateLimiter>[0]): Hono => {
  const app = new Hono();
  app.use('*', createIpRateLimiter(params));
  app.get('/', (c) => c.text('ok'));
  app.onError((err, c) => {
    if (err instanceof DomainError) return c.text(err.code, err.status as 429);
    return c.text('boom', 500);
  });
  return app;
};

describe('createIpRateLimiter', () => {
  test('perSecond=0 is a no-op (everything passes)', async () => {
    const app = buildApp({ perSecond: 0 });
    for (let i = 0; i < 50; i += 1) {
      const res = await app.request('/', { headers: { 'x-forwarded-for': '1.2.3.4' } });
      expect(res.status).toBe(200);
    }
  });

  test('refuses with 429 once the burst is exhausted from one IP', async () => {
    // 2 req/sec, burst = 4 (default = 2x rate)
    const app = buildApp({ perSecond: 2 });
    // 4 quick requests succeed, 5th should 429
    for (let i = 0; i < 4; i += 1) {
      const res = await app.request('/', { headers: { 'x-forwarded-for': '9.9.9.9' } });
      expect(res.status).toBe(200);
    }
    const blocked = await app.request('/', { headers: { 'x-forwarded-for': '9.9.9.9' } });
    expect(blocked.status).toBe(429);
    expect(await blocked.text()).toBe('too_many_requests');
  });

  test('two different IPs have independent buckets', async () => {
    const app = buildApp({ perSecond: 1, burst: 1 });
    // First IP consumes its token
    expect((await app.request('/', { headers: { 'x-forwarded-for': '1.1.1.1' } })).status).toBe(200);
    expect((await app.request('/', { headers: { 'x-forwarded-for': '1.1.1.1' } })).status).toBe(429);
    // Second IP still has its token
    expect((await app.request('/', { headers: { 'x-forwarded-for': '2.2.2.2' } })).status).toBe(200);
  });

  test('refill restores tokens after a short wait', async () => {
    // 100 req/sec, burst = 1 → after 15ms we should get another token
    const app = buildApp({ perSecond: 100, burst: 1 });
    expect((await app.request('/', { headers: { 'x-forwarded-for': '3.3.3.3' } })).status).toBe(200);
    expect((await app.request('/', { headers: { 'x-forwarded-for': '3.3.3.3' } })).status).toBe(429);
    await new Promise((r) => setTimeout(r, 20));
    expect((await app.request('/', { headers: { 'x-forwarded-for': '3.3.3.3' } })).status).toBe(200);
  });

  test('takes the leftmost X-Forwarded-For token (originating client)', async () => {
    const app = buildApp({ perSecond: 1, burst: 1 });
    // Two requests forwarded through different proxy chains but with the same
    // originating client IP must consume the same bucket.
    expect(
      (
        await app.request('/', {
          headers: { 'x-forwarded-for': '5.5.5.5, 10.0.0.1, 10.0.0.2' },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request('/', {
          headers: { 'x-forwarded-for': '5.5.5.5, 10.0.0.3' },
        })
      ).status,
    ).toBe(429);
  });

  test('custom clientIp extractor is honored', async () => {
    const app = buildApp({
      perSecond: 1,
      burst: 1,
      clientIp: (c) => c.req.header('x-real-user') ?? 'anonymous',
    });
    expect((await app.request('/', { headers: { 'x-real-user': 'alice' } })).status).toBe(200);
    expect((await app.request('/', { headers: { 'x-real-user': 'alice' } })).status).toBe(429);
    expect((await app.request('/', { headers: { 'x-real-user': 'bob' } })).status).toBe(200);
  });
});
