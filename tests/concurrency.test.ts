import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { createConcurrencyLimiter } from '../src/proxy/concurrency.js';
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
