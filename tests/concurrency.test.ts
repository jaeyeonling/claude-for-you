import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import {
  createConcurrencyLimiter,
  createPerKeyConcurrencyLimiter,
} from '../src/proxy/concurrency.js';
import { DomainError } from '../src/lib/errors.js';

const slowHandler = (deferred: { resolve: () => void; promise: Promise<void> }) =>
  async () => {
    await deferred.promise;
    return new Response('ok');
  };

const defer = (): { resolve: () => void; promise: Promise<void> } => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { resolve, promise };
};

const buildApp = (max: number, gate: ReturnType<typeof defer>): Hono => {
  const app = new Hono();
  app.use('*', createConcurrencyLimiter(max));
  app.get('/', slowHandler(gate));
  app.onError((err, c) => {
    if (err instanceof DomainError) return c.text(err.code, err.status as 429);
    return c.text('boom', 500);
  });
  return app;
};

describe('createConcurrencyLimiter', () => {
  test('max=0 is a no-op (unlimited)', async () => {
    const gate = defer();
    const app = buildApp(0, gate);
    gate.resolve();
    const res = await app.request('/');
    expect(res.status).toBe(200);
  });

  test('rejects with 429 once max in-flight is reached', async () => {
    const gate = defer();
    const app = buildApp(2, gate);
    // Two in-flight, neither resolved yet.
    const p1 = app.request('/');
    const p2 = app.request('/');
    // Yield once so the limiter middleware has run on p1+p2.
    await new Promise((r) => setImmediate(r));
    const blocked = await app.request('/');
    expect(blocked.status).toBe(429);
    expect(await blocked.text()).toBe('too_many_requests');
    gate.resolve();
    expect((await p1).status).toBe(200);
    expect((await p2).status).toBe(200);
  });

  test('releases the slot once a request finishes', async () => {
    const gate1 = defer();
    const app = buildApp(1, gate1);
    const p1 = app.request('/');
    await new Promise((r) => setImmediate(r));
    gate1.resolve();
    await p1;
    // Now the slot is free.
    const next = await app.request('/');
    expect(next.status).toBe(200);
  });
});

const buildPerKeyApp = (max: number, gate: ReturnType<typeof defer>): Hono => {
  const app = new Hono();
  // Stub user injection — mimics what the api-key middleware does in production.
  // Setting the typed `user` variable via `c.set` keeps the ContextVariableMap
  // contract intact, matching what api-key.ts does at runtime.
  app.use('*', async (c, next) => {
    const name = c.req.header('x-test-key') ?? 'anon';
    c.set('user', { name, role: 'user' });
    await next();
  });
  app.use('*', createPerKeyConcurrencyLimiter(max));
  app.get('/', slowHandler(gate));
  // Mirror the real onError header propagation so DomainError.headers
  // (e.g. Retry-After) survive into the test response.
  // NOTE: body shape diverges from production onError (`c.text(err.message)`
  // here vs `c.json({error:{type,message}})` in app.ts). The stub returns
  // plain text so individual tests can assert on the raw message — body
  // structure isn't what these tests cover; header propagation and status
  // are. The forbidden-header filter from app.ts is intentionally NOT
  // mirrored — these tests verify the limiter's contract with onError, not
  // onError's defensive sanitization (covered separately if needed).
  app.onError((err, c) => {
    if (err instanceof DomainError) {
      const res = c.text(err.message, err.status as 429);
      if (err.headers) {
        for (const [name, value] of Object.entries(err.headers)) {
          res.headers.set(name, value);
        }
      }
      return res;
    }
    return c.text('boom', 500);
  });
  return app;
};

describe('createPerKeyConcurrencyLimiter', () => {
  test('max=0 is a no-op (unlimited)', async () => {
    const gate = defer();
    const app = buildPerKeyApp(0, gate);
    gate.resolve();
    const res = await app.request('/');
    expect(res.status).toBe(200);
  });

  test('rejects with 429 when one key exceeds its per-key cap', async () => {
    const gate = defer();
    const app = buildPerKeyApp(1, gate);
    const p1 = app.request('/', { headers: { 'x-test-key': 'alice' } });
    await new Promise((r) => setImmediate(r));
    const blocked = await app.request('/', { headers: { 'x-test-key': 'alice' } });
    expect(blocked.status).toBe(429);
    const body = await blocked.text();
    // Generic message — must NOT echo the key identity in the error body.
    expect(body).toContain('per-key concurrency cap reached');
    expect(body).not.toContain('alice');
    // Retry-After header guides backoff-aware clients away from busy-loop retry.
    expect(blocked.headers.get('retry-after')).toBe('1');
    gate.resolve();
    expect((await p1).status).toBe(200);
  });

  test('other keys are not blocked by a busy key', async () => {
    // CRITICAL: alice and bob must hit the SAME limiter instance for this
    // test to actually verify per-key isolation. Sharing a single Hono app
    // means both requests pass through the same `inFlightByKey` Map.
    const gate = defer();
    const app = buildPerKeyApp(1, gate);
    // Alice fills her single slot first.
    const aliceP = app.request('/', { headers: { 'x-test-key': 'alice' } });
    await new Promise((r) => setImmediate(r));
    // Bob hits the SAME app — should pass even though alice is still in-flight,
    // because the per-key cap is per-bucket, not global.
    const bobP = app.request('/', { headers: { 'x-test-key': 'bob' } });
    // Yield once more so bob's middleware definitely runs (and its limiter
    // check happens) WHILE alice's slot is still held — without this, a
    // broken global-counter implementation could pass by accident if alice's
    // handler completes before bob's middleware is scheduled.
    await new Promise((r) => setImmediate(r));
    // Release the shared slow handler so both responses complete.
    gate.resolve();
    const [aliceRes, bobRes] = await Promise.all([aliceP, bobP]);
    expect(aliceRes.status).toBe(200);
    expect(bobRes.status).toBe(200);
  });

  test('releases the per-key slot once a request finishes', async () => {
    const gate1 = defer();
    const app = buildPerKeyApp(1, gate1);
    const p1 = app.request('/', { headers: { 'x-test-key': 'alice' } });
    await new Promise((r) => setImmediate(r));
    gate1.resolve();
    await p1;
    const next = await app.request('/', { headers: { 'x-test-key': 'alice' } });
    expect(next.status).toBe(200);
  });

  test('per-instance throttle state — new limiter starts fresh', async () => {
    // Each createPerKeyConcurrencyLimiter() owns its own WarnThrottle, so a
    // burst in one app's lifetime can't silence warns in a separately built
    // app. We can't easily intercept log.warn here, but we can verify the
    // observable contract: two fresh instances both correctly reject when
    // their independent caps are reached.
    const gate1 = defer();
    const gate2 = defer();
    const app1 = buildPerKeyApp(1, gate1);
    const app2 = buildPerKeyApp(1, gate2);

    const hold1 = app1.request('/', { headers: { 'x-test-key': 'alice' } });
    const hold2 = app2.request('/', { headers: { 'x-test-key': 'alice' } });
    await new Promise((r) => setImmediate(r));

    const blocked1 = await app1.request('/', { headers: { 'x-test-key': 'alice' } });
    const blocked2 = await app2.request('/', { headers: { 'x-test-key': 'alice' } });
    expect(blocked1.status).toBe(429);
    expect(blocked2.status).toBe(429);

    gate1.resolve();
    gate2.resolve();
    await Promise.all([hold1, hold2]);
  });
});
