import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { composeApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { createModelsHandler } from '../src/proxy/models.js';
import type { AccountPool, TokenState } from '../src/auth/account-pool.js';
import { DomainError } from '../src/lib/errors.js';

/**
 * Tests for the gateway model-discovery endpoint `GET /v1/models`.
 *
 * The handler pass-throughs to upstream `/v1/models` with a pool OAuth token.
 * Unit tests mount it in a bare Hono app with a stub pool + a mocked
 * `globalThis.fetch`; the e2e block boots the full `composeApp` graph to prove
 * the real `/v1/*` auth middleware and pool wiring carry a request through.
 */

interface PoolCalls {
  getAccessToken: number;
  forceRefresh: number;
  observeResponse: number;
}

const stubPool = (overrides?: Partial<AccountPool>): { pool: AccountPool; calls: PoolCalls } => {
  const calls: PoolCalls = { getAccessToken: 0, forceRefresh: 0, observeResponse: 0 };
  const base: AccountPool = {
    getAccessToken: async () => {
      calls.getAccessToken += 1;
      return { name: 'primary', token: 'tok-primary-1' };
    },
    getAccessTokenExcluding: async () => null,
    forceRefresh: async () => {
      calls.forceRefresh += 1;
      return 'tok-primary-2';
    },
    replaceOAuth: async (_name: string, _state: TokenState) => {},
    observeResponse: () => {
      calls.observeResponse += 1;
    },
    snapshot: () => ({ members: [], sessionAssignments: {} }),
    ...(overrides ?? {}),
  };
  return { pool: base, calls };
};

// Bare mount — the handler ignores `c.get('user')` (no per-key filtering), so
// no fake-auth middleware is needed. onError mirrors app.ts so a thrown
// DomainError renders as its status, exercising the transport→502 path.
const mount = (pool: AccountPool): Hono => {
  const app = new Hono();
  app.get('/v1/models', createModelsHandler({ pool }));
  app.onError((err, c) => {
    if (err instanceof DomainError) {
      return c.json(
        { error: { type: err.code, message: err.message } },
        err.status as 400 | 401 | 403 | 429 | 500 | 502,
      );
    }
    return c.json({ error: { type: 'internal_error', message: 'internal' } }, 500);
  });
  return app;
};

let originalFetch: typeof globalThis.fetch;
let fetchCallCount = 0;
let fetchUrlsSeen: string[] = [];
let fetchAuthSeen: string[] = [];

const installFetch = (responses: Response[]): void => {
  fetchCallCount = 0;
  fetchUrlsSeen = [];
  fetchAuthSeen = [];
  globalThis.fetch = (async (url: string, init?: RequestInit): Promise<Response> => {
    const idx = fetchCallCount;
    fetchCallCount += 1;
    fetchUrlsSeen.push(String(url));
    const headers = init?.headers as Record<string, string> | undefined;
    fetchAuthSeen.push(headers?.['authorization'] ?? '');
    const r = responses[idx];
    if (!r) {
      throw new Error(
        `fetch called ${fetchCallCount} times but only ${responses.length} stubbed responses provided`,
      );
    }
    return r;
  }) as typeof globalThis.fetch;
};

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const FABLE_LIST = {
  data: [
    { id: 'claude-fable-5', display_name: 'Claude Fable 5' },
    { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8' },
  ],
};

describe('createModelsHandler — upstream pass-through', () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('200 pass-through: returns upstream body verbatim, forwards query string, uses pool token', async () => {
    installFetch([jsonResponse(200, FABLE_LIST)]);
    const { pool, calls } = stubPool();

    const res = await mount(pool).request('/v1/models?limit=1000');

    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof FABLE_LIST;
    expect(body.data.map((m) => m.id)).toContain('claude-fable-5');
    // Query string forwarded to upstream, targeting the models endpoint.
    expect(fetchUrlsSeen[0]).toBe('https://api.anthropic.com/v1/models?limit=1000');
    // Pool token attached; no refresh needed on a 200.
    expect(fetchAuthSeen[0]).toBe('Bearer tok-primary-1');
    expect(calls.getAccessToken).toBe(1);
    expect(calls.forceRefresh).toBe(0);
    // Never feeds headroom tracking — this is not a billable messages call.
    expect(calls.observeResponse).toBe(0);
  });

  test('no query string: upstream URL has no trailing ?', async () => {
    installFetch([jsonResponse(200, FABLE_LIST)]);
    const { pool } = stubPool();

    const res = await mount(pool).request('/v1/models');

    expect(res.status).toBe(200);
    expect(fetchUrlsSeen[0]).toBe('https://api.anthropic.com/v1/models');
  });

  test('401 → forceRefresh → retry once with the fresh token → 200', async () => {
    installFetch([jsonResponse(401, { type: 'error' }), jsonResponse(200, FABLE_LIST)]);
    const { pool, calls } = stubPool();

    const res = await mount(pool).request('/v1/models?limit=1000');

    expect(res.status).toBe(200);
    expect(calls.forceRefresh).toBe(1);
    expect(fetchCallCount).toBe(2);
    expect(fetchAuthSeen[0]).toBe('Bearer tok-primary-1');
    expect(fetchAuthSeen[1]).toBe('Bearer tok-primary-2');
  });

  test('401 twice → the retried 401 is passed through verbatim (no retry loop)', async () => {
    installFetch([jsonResponse(401, { type: 'error' }), jsonResponse(401, { type: 'error' })]);
    const { pool, calls } = stubPool();

    const res = await mount(pool).request('/v1/models');

    expect(res.status).toBe(401);
    expect(calls.forceRefresh).toBe(1);
    expect(fetchCallCount).toBe(2);
  });

  test('non-401 upstream error (403) is passed through verbatim, no refresh', async () => {
    installFetch([jsonResponse(403, { type: 'error', error: { type: 'permission_error' } })]);
    const { pool, calls } = stubPool();

    const res = await mount(pool).request('/v1/models');

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe('permission_error');
    expect(calls.forceRefresh).toBe(0);
    expect(fetchCallCount).toBe(1);
  });

  test('transport failure → 502 upstream_failed envelope', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof globalThis.fetch;
    const { pool, calls } = stubPool();

    const res = await mount(pool).request('/v1/models');

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe('upstream_failed');
    expect(calls.forceRefresh).toBe(0);
  });

  test('token fetch failure (getAccessToken rejects) → 502 upstream_failed, no upstream call', async () => {
    // A network-level throw during the OAuth refresh inside getAccessToken must
    // map to the 502 upstream contract, not escape as a generic 500.
    installFetch([]); // upstream must never be reached
    const { pool } = stubPool({
      getAccessToken: async () => {
        throw new Error('oauth refresh network failure');
      },
    });

    const res = await mount(pool).request('/v1/models');

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe('upstream_failed');
    expect(fetchCallCount).toBe(0);
  });

  test('content-type defaults to application/json when upstream omits it', async () => {
    installFetch([new Response(JSON.stringify(FABLE_LIST), { status: 200 })]);
    const { pool } = stubPool();

    const res = await mount(pool).request('/v1/models');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
  });

  test('body read failure after 2xx headers → 502 upstream_failed (not a generic 500)', async () => {
    // Upstream sends a 200 header then the connection drops mid-body — res.text()
    // throws. Must map to the 502 upstream contract, not escape as a 500.
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"data":'));
        controller.error(new Error('connection reset mid-body'));
      },
    });
    installFetch([
      new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } }),
    ]);
    const { pool } = stubPool();

    const res = await mount(pool).request('/v1/models');

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe('upstream_failed');
  });
});

describe('GET /v1/models — e2e via composeApp', () => {
  const VALID_KEY = '0123456789abcdef0123456789abcdef';
  let workdir: string;

  const baseConfig = (overrides: Partial<AppConfig> = {}): AppConfig =>
    Object.freeze({
      port: 0,
      host: '127.0.0.1',
      oauth: Object.freeze({
        refreshToken: `sk-ant-ort01-${'a'.repeat(80)}`,
        accessToken: null,
        expiresAt: 0,
      }),
      tokenStorePath: join(workdir, 'data', 'tokens.json'),
      apiKeys: [{ name: 'alice', key: VALID_KEY }],
      apiKeysFilePath: null,
      dailyTokenLimitPerKey: 0,
      databaseUrl: null,
      globalSubscriptionThresholdTokens: 0,
      maxConcurrentRequests: 8,
      maxConcurrentRequestsPerKey: 0,
      perIpRateLimitPerSecond: 0,
      pacingMinGapMs: 0,
      accountUuidOverride: 'test-uuid',
      accountsPath: join(workdir, 'data', 'accounts.json'),
      canaryPercent: 0,
      messagesLogEnabled: false,
      discordWebhookUrl: null,
      slackWebhookUrl: null,
      logLevel: 'error',
      ...overrides,
    });

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'cfy-models-'));
    await mkdir(join(workdir, 'data'), { recursive: true });
    originalFetch = globalThis.fetch;
    // Route by URL: intercept the OAuth refresh (triggered lazily by the pool's
    // first getAccessToken) and the upstream models GET. Anything else throws so
    // an unexpected real network call fails loudly.
    globalThis.fetch = (async (url: string): Promise<Response> => {
      const u = String(url);
      if (u.includes('/v1/oauth/token')) {
        return jsonResponse(200, {
          access_token: 'at-live-1',
          refresh_token: `sk-ant-ort01-${'b'.repeat(80)}`,
          expires_in: 3600,
        });
      }
      if (u.includes('/v1/models')) {
        return jsonResponse(200, FABLE_LIST);
      }
      throw new Error(`unexpected fetch in e2e: ${u}`);
    }) as typeof globalThis.fetch;
  });
  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(workdir, { recursive: true, force: true });
  });

  test('without an api key → 401 (inherits /v1/* auth)', async () => {
    const { app, dispose } = await composeApp(baseConfig());
    try {
      const res = await app.request('/v1/models');
      expect(res.status).toBe(401);
    } finally {
      await dispose();
    }
  });

  test('with a valid api key → 200 with the upstream model list (fable present)', async () => {
    const { app, dispose } = await composeApp(baseConfig());
    try {
      const res = await app.request('/v1/models?limit=1000', {
        headers: { 'x-api-key': VALID_KEY },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as typeof FABLE_LIST;
      expect(body.data.map((m) => m.id)).toContain('claude-fable-5');
    } finally {
      await dispose();
    }
  });

  test('global concurrency cap applies to /v1/models: with cap=1, a 2nd concurrent request is 429', async () => {
    // Prove the shared fan-out defense now covers /v1/models (persona R1 HIGH).
    // Gate the upstream models fetch so the first request holds the single slot
    // while the second arrives and is rejected.
    let releaseModels: () => void = () => {};
    const modelsGate = new Promise<void>((resolve) => {
      releaseModels = resolve;
    });
    globalThis.fetch = (async (url: string): Promise<Response> => {
      const u = String(url);
      if (u.includes('/v1/oauth/token')) {
        return jsonResponse(200, {
          access_token: 'at-live-1',
          refresh_token: `sk-ant-ort01-${'c'.repeat(80)}`,
          expires_in: 3600,
        });
      }
      if (u.includes('/v1/models')) {
        await modelsGate;
        return jsonResponse(200, FABLE_LIST);
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as typeof globalThis.fetch;

    const { app, dispose } = await composeApp(baseConfig({ maxConcurrentRequests: 1 }));
    try {
      const both = Promise.all([
        app.request('/v1/models', { headers: { 'x-api-key': VALID_KEY } }),
        app.request('/v1/models', { headers: { 'x-api-key': VALID_KEY } }),
      ]);
      // Let both requests reach the global limiter: one holds the slot on the
      // gate, the other is rejected synchronously.
      await new Promise((r) => setTimeout(r, 30));
      releaseModels();
      const [a, b] = await both;
      expect([a.status, b.status].sort((x, y) => x - y)).toEqual([200, 429]);
    } finally {
      releaseModels();
      await dispose();
    }
  });
});
