import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { AccountPool, TokenState } from '../src/auth/account-pool.js';
import { ConfigError, DomainError } from '../src/lib/errors.js';
import { createPacingEnforcer, type PacingEnforcer } from '../src/pacing.js';
import { callUpstream } from '../src/proxy/upstream.js';
import type { ClaudeTemplate } from '../src/template/types.js';

interface PoolCalls {
  getAccessToken: number;
  getAccessTokenExcluding: number;
  forceRefresh: number;
  observeResponse: number;
}

const stubPool = (overrides?: Partial<AccountPool>): { pool: AccountPool; calls: PoolCalls } => {
  const calls: PoolCalls = {
    getAccessToken: 0,
    getAccessTokenExcluding: 0,
    forceRefresh: 0,
    observeResponse: 0,
  };
  const base: AccountPool = {
    getAccessToken: async () => {
      calls.getAccessToken += 1;
      return { name: 'primary', token: 'tok-primary-1' };
    },
    getAccessTokenExcluding: async () => {
      calls.getAccessTokenExcluding += 1;
      return null;
    },
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

const stubTemplate = (): ClaudeTemplate =>
  Object.freeze({
    source: 'static' as const,
    description: 'test',
    apply: async ({ accessToken }) => ({
      url: 'https://upstream.example/v1/messages',
      method: 'POST' as const,
      headers: {
        'x-claude-code-session-id': 'sess-1',
        authorization: `Bearer ${accessToken}`,
      },
      body: '{}',
    }),
  });

const stubPacing = createPacingEnforcer({ minGapMs: 0 });

const makeResponse = (status: number): Response =>
  new Response(JSON.stringify({ type: 'error', status }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

let originalFetch: typeof globalThis.fetch;
let fetchCallCount = 0;
let fetchTokensSeen: string[] = [];

const installFetch = (responses: Response[]): void => {
  fetchCallCount = 0;
  fetchTokensSeen = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit): Promise<Response> => {
    const idx = fetchCallCount;
    fetchCallCount += 1;
    const headers = init?.headers as Record<string, string> | undefined;
    if (headers && typeof headers === 'object') {
      const auth = (headers as Record<string, string>)['authorization'] ?? '';
      fetchTokensSeen.push(auth);
    }
    const r = responses[idx];
    if (!r) throw new Error(`fetch called ${fetchCallCount} times but only ${responses.length} stubbed responses provided`);
    return r;
  }) as typeof globalThis.fetch;
};

describe('callUpstream — transparent proxy (no 5xx retry, no 429 failover)', () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('A: 429 is surfaced verbatim — no pool failover, body untouched', async () => {
    const { pool, calls } = stubPool();
    const ratelimitBody = JSON.stringify({ type: 'rate_limit_error', message: 'slow down' });
    installFetch([
      new Response(ratelimitBody, {
        status: 429,
        headers: { 'retry-after': '37', 'content-type': 'application/json' },
      }),
    ]);

    const { response, servedBy } = await callUpstream({}, undefined, 'sess-1', {
      pool,
      template: stubTemplate(),
      pacing: stubPacing,
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('37');
    // Body must NOT have been consumed inside callUpstream — caller reads it.
    expect(response.bodyUsed).toBe(false);
    const text = await response.text();
    expect(text).toBe(ratelimitBody);
    expect(servedBy).toBe('primary');
    expect(calls.getAccessTokenExcluding).toBe(0);
    expect(fetchCallCount).toBe(1);
  });

  test.each([502, 503, 504] as const)('B: %s is surfaced verbatim — no retry', async (status) => {
    const { pool, calls } = stubPool();
    installFetch([makeResponse(status)]);

    const { response } = await callUpstream({}, undefined, undefined, {
      pool,
      template: stubTemplate(),
      pacing: stubPacing,
    });

    expect(response.status).toBe(status);
    expect(fetchCallCount).toBe(1);
    expect(calls.forceRefresh).toBe(0);
    expect(calls.getAccessTokenExcluding).toBe(0);
  });

  test('C: 401 triggers forceRefresh and one retry on the SAME pool member', async () => {
    const { pool, calls } = stubPool();
    installFetch([
      new Response('{"type":"error","message":"unauth"}', { status: 401 }),
      new Response('{"ok":true}', { status: 200 }),
    ]);

    const { response, servedBy } = await callUpstream({}, undefined, undefined, {
      pool,
      template: stubTemplate(),
      pacing: stubPacing,
    });

    expect(response.status).toBe(200);
    expect(servedBy).toBe('primary');
    expect(calls.forceRefresh).toBe(1);
    expect(calls.getAccessTokenExcluding).toBe(0);
    expect(fetchCallCount).toBe(2);
    // Second fetch must carry the refreshed token, not the original.
    expect(fetchTokensSeen[1]).not.toBe(fetchTokensSeen[0]);
  });

  test('E: raw template.apply throw is converted to DomainError(template_apply_failed, 500)', async () => {
    const { pool } = stubPool();
    const badTemplate: ClaudeTemplate = Object.freeze({
      source: 'static' as const,
      description: 'broken',
      apply: async () => {
        throw new TypeError('snapshot.system is not iterable');
      },
    });
    installFetch([]);

    let caught: unknown;
    try {
      await callUpstream({}, undefined, 'sess-1', {
        pool,
        template: badTemplate,
        pacing: stubPacing,
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(DomainError);
    const err = caught as DomainError;
    expect(err.code).toBe('template_apply_failed');
    expect(err.status).toBe(500);
    expect(err.message).toContain('snapshot.system is not iterable');
    expect(fetchCallCount).toBe(0);
  });

  test('F: raw pacing.await throw is converted to DomainError(pacing_await_failed, 500)', async () => {
    const { pool } = stubPool();
    const badPacing: PacingEnforcer = Object.freeze({
      await: async () => {
        throw new Error('pacing invariant broken');
      },
    });
    installFetch([]);

    let caught: unknown;
    try {
      await callUpstream({}, undefined, 'sess-1', {
        pool,
        template: stubTemplate(),
        pacing: badPacing,
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(DomainError);
    const err = caught as DomainError;
    expect(err.code).toBe('pacing_await_failed');
    expect(err.status).toBe(500);
    expect(err.message).toContain('pacing invariant broken');
    expect(fetchCallCount).toBe(0);
  });

  test('G: DomainError thrown inside template.apply is re-thrown as-is (no double-wrap)', async () => {
    const { pool } = stubPool();
    const badTemplate: ClaudeTemplate = Object.freeze({
      source: 'static' as const,
      description: 'config-broken',
      apply: async () => {
        throw ConfigError('missing system prompt token');
      },
    });
    installFetch([]);

    let caught: unknown;
    try {
      await callUpstream({}, undefined, 'sess-1', {
        pool,
        template: badTemplate,
        pacing: stubPacing,
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(DomainError);
    const err = caught as DomainError;
    // Original code preserved — NOT wrapped as template_apply_failed.
    expect(err.code).toBe('config_error');
    expect(err.message).toContain('missing system prompt token');
    expect(fetchCallCount).toBe(0);
  });

  test('D: 401 after refresh is surfaced — no pool failover', async () => {
    const { pool, calls } = stubPool();
    installFetch([
      new Response('{"type":"error","message":"unauth"}', { status: 401 }),
      new Response('{"type":"error","message":"still unauth"}', { status: 401 }),
    ]);

    const { response } = await callUpstream({}, undefined, undefined, {
      pool,
      template: stubTemplate(),
      pacing: stubPacing,
    });

    expect(response.status).toBe(401);
    expect(calls.forceRefresh).toBe(1);
    expect(calls.getAccessTokenExcluding).toBe(0);
    expect(fetchCallCount).toBe(2);
  });
});
