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
  /** Set c.var.user before the failing step (simulates post-auth failure). */
  readonly setUser?: boolean;
  /** Run inside the /v1/* middleware — throw here to model a middleware reject
   * (concurrency/api-key/quota); omit to fall through to the handler. */
  readonly wildcard?: (c: Context) => void;
  /** The POST handler. Default: 200 + logged=true (a "handler owns the log"). */
  readonly handler?: (c: Context) => Response | Promise<Response>;
}

const buildObsApp = (
  opts: ObsAppOpts,
  storeOpts: { rejectRecord?: boolean } = {},
): { app: Hono; store: FakeStore; sinkMsgs: string[] } => {
  const store = fakeStore(storeOpts);
  const sinkMsgs: string[] = [];
  const app = new Hono();
  app.use(
    '/v1/messages',
    createOutcomeObserver({
      store,
      errorSink: async (m) => {
        sinkMsgs.push(m);
      },
    }),
  );
  app.use('/v1/*', async (c, next) => {
    if (opts.setUser) c.set('user', USER);
    if (opts.wildcard) opts.wildcard(c);
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
  test('(a) proxy concurrency 429 (post-auth) → one proxy row, real userName', async () => {
    const { app, store } = buildObsApp({
      setUser: true,
      wildcard: () => {
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
    // errorMessage best-effort extracted from the onError JSON body.
    expect(row.errorMessage).toBe('max concurrent requests reached (120)');
  });

  test('(b) api-key 401 (pre-auth) → one client row, userName sentinel "-"', async () => {
    const { app, store } = buildObsApp({
      wildcard: () => {
        throw Unauthorized('invalid api key');
      },
    });
    const res = await postMsg(app);
    expect(res.status).toBe(401);
    expect(store.records).toHaveLength(1);
    expect(store.records[0]!.source).toBe('client');
    expect(store.records[0]!.userName).toBe('-');
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
        wildcard: () => {
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
