import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  DomainError,
  InvalidRequest,
  QuotaExceeded,
  TooManyRequests,
  Unauthorized,
  UpstreamFailed,
} from '../src/lib/errors.js';
import type { AuthenticatedUser } from '../src/auth/api-key.js';
import { createOutcomeObserver } from '../src/proxy/observe-outcome.js';
import type {
  MessageLogRecord,
  MessageLogStore,
  MessageLogSummary,
} from '../src/usage/messages-log.js';

/**
 * Step 1 — gating spike (issue #144).
 *
 * Proves the Hono semantics the observer relies on. The spike OVERTURNED the
 * initial catch-based design and pinned down the correct one:
 *
 *   FINDING: with `app.onError` registered (as the real app does, app.ts), a
 *   downstream throw is intercepted by onError BEFORE it re-reaches an outer
 *   middleware's `await next()`. `next()` then RESOLVES (not rejects) with
 *   `c.res` already set to the onError response. So a try/catch in the observer
 *   never fires — the correct, uniform signal is `c.res.status` AFTER next().
 *
 * Therefore the observer needs NO try/catch/rethrow. It observes every failure
 * (middleware throw, handler throw, and non-throw `c.json(...,4xx)`) uniformly
 * via `c.res.status >= 400`.
 *
 * Also proves: a middleware registered on '/v1/messages' BEFORE a '/v1/*' one
 * runs outermost (Hono orders by registration, not path specificity).
 */

interface Observed {
  readonly status: number;
}

// Inline model of the real observer's mechanism: observe c.res.status after
// next() — NO catch (onError already converted throws into c.res).
const buildSpikeApp = (
  inner: (c: import('hono').Context) => Response | Promise<Response>,
  innerWildcard?: (c: import('hono').Context) => Response | Promise<Response>,
): { app: Hono; observed: Observed[]; order: string[] } => {
  const observed: Observed[] = [];
  const order: string[] = [];
  const app = new Hono();

  // Registered FIRST, on the exact route — must run outermost.
  app.use('/v1/messages', async (c, next) => {
    order.push('observer:in');
    await next();
    if (c.res.status >= 400) observed.push({ status: c.res.status });
    order.push('observer:out');
  });

  // Registered SECOND, on the wildcard — models apiKey/limiters on '/v1/*'.
  app.use('/v1/*', async (c, next) => {
    order.push('inner');
    if (innerWildcard) {
      c.res = await innerWildcard(c);
      return;
    }
    await next();
  });

  app.post('/v1/messages', inner);

  app.onError((err, c) => {
    if (err instanceof DomainError) {
      return c.json({ error: { type: err.code, message: err.message } }, err.status as 429);
    }
    return c.json({ error: { type: 'internal', message: 'boom' } }, 500);
  });
  return { app, observed, order };
};

const post = (app: Hono): Promise<Response> =>
  app.request('/v1/messages', { method: 'POST' });

describe('#144 gating spike — Hono propagation + registration order', () => {
  test('observer (registered first) runs outermost — proves it wraps the /v1/* middleware', async () => {
    const { app, order } = buildSpikeApp(() => new Response('ok'));
    await post(app);
    expect(order[0]).toBe('observer:in');
    expect(order[1]).toBe('inner');
  });

  test('DomainError thrown by the handler → onError → observable as c.res.status (no catch needed)', async () => {
    const { app, observed } = buildSpikeApp(() => {
      throw TooManyRequests('max concurrent requests reached (120)');
    });
    const res = await post(app);
    expect(observed).toEqual([{ status: 429 }]);
    expect(res.status).toBe(429);
  });

  test('throw from the /v1/* middleware is also captured via c.res.status', async () => {
    const { app, observed } = buildSpikeApp(
      () => new Response('ok'),
      () => {
        throw Unauthorized('invalid_api_key');
      },
    );
    const res = await post(app);
    expect(observed).toEqual([{ status: 401 }]);
    expect(res.status).toBe(401);
  });

  test('raw non-DomainError throw → onError 500 → observable as c.res.status 500', async () => {
    const { app, observed } = buildSpikeApp(() => {
      throw new Error('unexpected');
    });
    const res = await post(app);
    expect(observed).toEqual([{ status: 500 }]);
    expect(res.status).toBe(500);
  });

  test('non-throw 4xx (handler returns c.json(...,400)) observable via c.res.status', async () => {
    const { app, observed } = buildSpikeApp((c) =>
      c.json({ error: { type: 'invalid_request', message: 'bad' } }, 400),
    );
    const res = await post(app);
    expect(observed).toEqual([{ status: 400 }]);
    expect(res.status).toBe(400);
  });

  test('successful 2xx produces no observed failure', async () => {
    const { app, observed } = buildSpikeApp(() => new Response('ok'));
    const res = await post(app);
    expect(observed).toEqual([]);
    expect(res.status).toBe(200);
  });
});

// --- createOutcomeObserver (the real middleware) -----------------------------

interface FakeStore extends MessageLogStore {
  readonly records: MessageLogRecord[];
}

const fakeStore = (opts: { rejectRecord?: boolean } = {}): FakeStore => {
  const records: MessageLogRecord[] = [];
  return {
    records,
    async record(entry: MessageLogRecord): Promise<void> {
      if (opts.rejectRecord) throw new Error('db down');
      records.push(entry);
    },
    async list(): Promise<readonly MessageLogSummary[]> {
      return [];
    },
    async get(): Promise<MessageLogRecord | null> {
      return null;
    },
  };
};

const USER: AuthenticatedUser = { name: 'alice', role: 'user' } as AuthenticatedUser;

interface ObsAppOpts {
  /** Set c.var.user in the pre-auth middleware (simulates a valid api key). */
  readonly setUser?: boolean;
  /** Throw inside the /v1/* pre-auth middleware — models the api-key middleware
   * rejecting (401) BEFORE the observer runs. The observer must NOT see it. */
  readonly failAuth?: () => never;
  /** Throw inside a /v1/messages middleware registered AFTER the observer —
   * models the IP/key/global concurrency limiters. The observer DOES see it. */
  readonly postThrow?: () => never;
  /** The POST handler. Default: 200 + logged=true (a "handler owns the log"). */
  readonly handler?: (c: Context) => Response | Promise<Response>;
}

// Mirrors the real app.ts registration order so the observer's placement
// invariant is under test (not an inverted toy topology):
//   api-key (/v1/*)  →  observer (/v1/messages)  →  limiters (/v1/messages)  →  handler
// The observer wraps everything AFTER api-key, so an api-key 401 is never
// observed (the fix for the check-R1 pre-auth write-amplification finding).
const buildObsApp = (
  opts: ObsAppOpts,
  storeOpts: { rejectRecord?: boolean } = {},
): { app: Hono; store: FakeStore; sinkMsgs: string[] } => {
  const store = fakeStore(storeOpts);
  const sinkMsgs: string[] = [];
  const app = new Hono();
  // 1. api-key stand-in (/v1/*), registered FIRST → outermost.
  app.use('/v1/*', async (c, next) => {
    if (opts.setUser) c.set('user', USER);
    if (opts.failAuth) opts.failAuth();
    await next();
  });
  // 2. observer (/v1/messages), after api-key.
  app.use(
    '/v1/messages',
    createOutcomeObserver({
      store,
      errorSink: async (m) => {
        sinkMsgs.push(m);
      },
    }),
  );
  // 3. limiter stand-in (/v1/messages), after the observer → observed on throw.
  app.use('/v1/messages', async (c, next) => {
    if (opts.postThrow) opts.postThrow();
    await next();
  });
  app.post(
    '/v1/messages',
    opts.handler ??
      ((c) => {
        c.set('logged', true);
        return c.json({ ok: true }, 200);
      }),
  );
  app.onError((err, c) => {
    if (err instanceof DomainError) {
      const headers = err.headers ?? {};
      return c.json(
        { error: { type: err.code, message: err.message } },
        err.status as 429,
        headers,
      );
    }
    return c.json({ error: { type: 'internal', message: 'boom' } }, 500);
  });
  return { app, store, sinkMsgs };
};

const postMsg = (app: Hono): Promise<Response> =>
  app.request('/v1/messages', {
    method: 'POST',
    headers: { 'user-agent': 'claude-cli/test', 'x-forwarded-for': '203.0.113.9' },
  });

describe('createOutcomeObserver — pre-handler failure capture (#144)', () => {
  test('(a) proxy concurrency 429 (limiter after observer) → one proxy row, real userName', async () => {
    const { app, store } = buildObsApp({
      setUser: true,
      postThrow: () => {
        throw TooManyRequests('max concurrent requests reached (120)');
      },
    });
    const res = await postMsg(app);
    expect(res.status).toBe(429);
    expect(store.records).toHaveLength(1);
    const row = store.records[0]!;
    expect(row.status).toBe(429);
    expect(row.source).toBe('proxy');
    expect(row.userName).toBe('alice');
    expect(row.servedBy).toBeNull();
    expect(row.requestBody).toBeNull();
    expect(row.model).toBeNull();
    expect(row.clientIp).toBe('203.0.113.9');
    expect(row.userAgent).toBe('claude-cli/test');
    // errorMessage best-effort extracted (+redacted) from the onError JSON body.
    expect(row.errorMessage).toBe('max concurrent requests reached (120)');
  });

  // Regression guard for the check-R1 CRITICAL (pre-auth write-amplification
  // DoS): the observer is registered AFTER api-key, so an unauthenticated 401
  // is thrown before the observer runs and produces ZERO log rows. If a future
  // edit swaps the two app.use registrations back, THIS test fails.
  test('(b) api-key 401 (pre-auth, before observer) → ZERO rows written', async () => {
    const { app, store } = buildObsApp({
      failAuth: () => {
        throw Unauthorized('missing api key');
      },
    });
    const res = await postMsg(app);
    expect(res.status).toBe(401);
    expect(store.records).toHaveLength(0);
  });

  test('(c) non-throw 413 (bodyLimit-style) → one client row', async () => {
    const { app, store } = buildObsApp({
      handler: (c) => c.json({ error: { type: 'invalid_request', message: 'too big' } }, 413),
    });
    const res = await postMsg(app);
    expect(res.status).toBe(413);
    expect(store.records).toHaveLength(1);
    expect(store.records[0]!.status).toBe(413);
    expect(store.records[0]!.source).toBe('client');
  });

  test('(d) non-throw 400 (malformed JSON body) → one client row', async () => {
    const { app, store } = buildObsApp({
      handler: (c) =>
        c.json({ error: { type: 'invalid_request', message: 'must be JSON object' } }, 400),
    });
    const res = await postMsg(app);
    expect(res.status).toBe(400);
    expect(store.records[0]!.source).toBe('client');
  });

  test('(d2) invalid_system_block 400 throw → one client row', async () => {
    const { app, store } = buildObsApp({
      handler: () => {
        throw InvalidRequest('leading system block', 'invalid_system_block');
      },
    });
    const res = await postMsg(app);
    expect(res.status).toBe(400);
    expect(store.records).toHaveLength(1);
    expect(store.records[0]!.source).toBe('client');
  });

  test('(e) UpstreamFailed 502 throw → one proxy row', async () => {
    const { app, store } = buildObsApp({
      handler: () => {
        throw UpstreamFailed('upstream fetch failed');
      },
    });
    const res = await postMsg(app);
    expect(res.status).toBe(502);
    expect(store.records[0]!.source).toBe('proxy');
    expect(store.records[0]!.status).toBe(502);
  });

  test('(f) template/pacing 500 throw → one proxy row', async () => {
    const { app, store } = buildObsApp({
      handler: () => {
        throw UpstreamFailed('template apply failed', 500, 'template_apply_failed');
      },
    });
    const res = await postMsg(app);
    expect(res.status).toBe(500);
    expect(store.records[0]!.source).toBe('proxy');
  });

  test('(g) raw non-DomainError throw → one proxy row, status 500', async () => {
    const { app, store } = buildObsApp({
      handler: () => {
        throw new Error('unexpected');
      },
    });
    const res = await postMsg(app);
    expect(res.status).toBe(500);
    expect(store.records[0]!.source).toBe('proxy');
    expect(store.records[0]!.status).toBe(500);
  });

  test('(h) quota_exceeded 429 throw → one proxy row (distinct from upstream 429)', async () => {
    const { app, store } = buildObsApp({
      setUser: true,
      handler: () => {
        throw QuotaExceeded('daily token limit reached');
      },
    });
    const res = await postMsg(app);
    expect(res.status).toBe(429);
    expect(store.records[0]!.source).toBe('proxy');
  });

  test('(i) successful 200 (handler logged) → no observer row', async () => {
    const { app, store } = buildObsApp({ setUser: true });
    const res = await postMsg(app);
    expect(res.status).toBe(200);
    expect(store.records).toHaveLength(0);
  });

  test('(j) upstream 429 already logged by handler → observer does not double-record', async () => {
    const { app, store } = buildObsApp({
      setUser: true,
      handler: (c) => {
        c.set('logged', true); // handler owns the row (source would be 'upstream')
        return c.json({ error: { type: 'rate_limit_error', message: 'slow down' } }, 429);
      },
    });
    const res = await postMsg(app);
    expect(res.status).toBe(429);
    expect(store.records).toHaveLength(0);
  });

  test('(k) store.record rejection does not change the client response', async () => {
    const { app, store, sinkMsgs } = buildObsApp(
      {
        postThrow: () => {
          throw TooManyRequests('cap');
        },
      },
      { rejectRecord: true },
    );
    const res = await postMsg(app);
    expect(res.status).toBe(429); // unchanged despite the logging failure
    expect(store.records).toHaveLength(0);
    // Fire-and-forget catch routes to the error sink; allow the microtask to run.
    await new Promise((r) => setImmediate(r));
    expect(sinkMsgs.some((m) => m.includes('observe-outcome'))).toBe(true);
  });
});

describe('createOutcomeObserver — robustness (#144 check-R1 fixes)', () => {
  test('non-JSON error body records errorMessage=null and preserves status (no 500)', async () => {
    const store = fakeStore();
    const app = new Hono();
    app.use(
      '/v1/messages',
      createOutcomeObserver({ store, errorSink: async () => {} }),
    );
    // Handler returns a non-JSON body with a 4xx — extractErrorMessage must
    // miss gracefully, the row still records, and the client status is intact.
    app.post('/v1/messages', (c) => c.text('plain boom', 400));
    app.onError((_e, c) => c.json({ error: 'x' }, 500));
    const res = await postMsg(app);
    expect(res.status).toBe(400); // not swapped to 500
    expect(store.records).toHaveLength(1);
    expect(store.records[0]!.errorMessage).toBeNull();
    expect(store.records[0]!.source).toBe('client');
  });

  test('global write throttle sheds excess rows under a failure storm, responses unaffected', async () => {
    const store = fakeStore();
    const app = new Hono();
    app.use(
      '/v1/messages',
      createOutcomeObserver({ store, errorSink: async () => {} }),
    );
    app.post('/v1/messages', () => {
      throw TooManyRequests('cap');
    });
    app.onError((err, c) =>
      c.json({ error: 'x' }, err instanceof DomainError ? (err.status as 429) : 500),
    );
    // Fire well past the burst (40) in a tight loop (same-ms → minimal refill).
    const results = await Promise.all(Array.from({ length: 60 }, () => postMsg(app)));
    // Every client response is the true 429 — throttling never touches responses.
    expect(results.every((r) => r.status === 429)).toBe(true);
    // Some rows were shed: fewer recorded than requests (bounded by the bucket).
    expect(store.records.length).toBeLessThan(60);
    expect(store.records.length).toBeGreaterThan(0);
  });
});
