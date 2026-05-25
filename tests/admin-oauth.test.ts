import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { createOAuthReplaceHandler } from '../src/admin/oauth.js';
import { DomainError } from '../src/lib/errors.js';
import type { AccountPool, TokenState } from '../src/auth/account-pool.js';

interface FakePoolCall {
  readonly memberName: string;
  readonly state: TokenState;
}

const fakePool = (): {
  pool: AccountPool;
  calls: FakePoolCall[];
} => {
  const calls: FakePoolCall[] = [];
  const pool: AccountPool = {
    getAccessToken: async () => ({ name: 'default', token: 't' }),
    getAccessTokenExcluding: async () => null,
    forceRefresh: async () => 't',
    replaceOAuth: async (memberName, state) => {
      calls.push({ memberName, state });
    },
    observeResponse: () => {},
    snapshot: () => ({ members: [], sessionAssignments: {} }),
  };
  return { pool, calls };
};

const app = (handler: (c: any) => Promise<Response>): Hono => {
  const a = new Hono();
  a.post('/admin/oauth/replace', handler);
  a.onError((err, c) => {
    if (err instanceof DomainError) {
      return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
    }
    return c.text('boom', 500);
  });
  return a;
};

const REAL_PREFIX_REFRESH = `sk-ant-ort01-${'a'.repeat(40)}`;
const REAL_PREFIX_ACCESS = `sk-ant-oat01-${'b'.repeat(40)}`;

describe('POST /admin/oauth/replace', () => {
  test('accepts a well-formed refresh token and forwards to pool', async () => {
    const { pool, calls } = fakePool();
    const h = createOAuthReplaceHandler(pool);
    const res = await app(h).request('/admin/oauth/replace', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: REAL_PREFIX_REFRESH }),
    });
    expect(res.status).toBe(302);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.memberName).toBe('default');
    expect(calls[0]?.state.refreshToken).toBe(REAL_PREFIX_REFRESH);
  });

  test('rejects refresh token that omits the sk-ant-ort01- prefix', async () => {
    const { pool, calls } = fakePool();
    const h = createOAuthReplaceHandler(pool);
    const res = await app(h).request('/admin/oauth/replace', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Common mistake: an access token pasted into the refresh field.
      body: JSON.stringify({ refreshToken: REAL_PREFIX_ACCESS }),
    });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('invalid_request');
    expect(body.error.message).toContain('sk-ant-ort01-');
  });

  test('rejects access token without the sk-ant-oat01- prefix', async () => {
    const { pool, calls } = fakePool();
    const h = createOAuthReplaceHandler(pool);
    const res = await app(h).request('/admin/oauth/replace', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        refreshToken: REAL_PREFIX_REFRESH,
        accessToken: 'garbage-not-a-token',
      }),
    });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});
