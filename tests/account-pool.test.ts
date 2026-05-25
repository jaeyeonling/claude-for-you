import { describe, expect, test } from 'bun:test';
import { createAccountPool } from '../src/auth/account-pool.js';
import type { OAuthManager, TokenState } from '../src/auth/oauth.js';

const fakeOAuth = (token: string): OAuthManager => {
  let state: TokenState = { accessToken: token, refreshToken: 'rt', expiresAt: Date.now() + 60_000 };
  return Object.freeze({
    getAccessToken: async () => state.accessToken,
    forceRefresh: async () => state.accessToken,
    snapshot: () => state,
    replace: async (next: TokenState) => {
      state = next;
    },
  });
};

describe('createAccountPool routing', () => {
  test('picks the member with the highest known headroom', async () => {
    const pool = createAccountPool([
      { name: 'low', oauth: fakeOAuth('tok-low'), remainingTokens: 1_000, remainingObservedAt: Date.now() },
      { name: 'high', oauth: fakeOAuth('tok-high'), remainingTokens: 50_000, remainingObservedAt: Date.now() },
    ]);
    const got = await pool.getAccessToken(undefined);
    expect(got.name).toBe('high');
  });

  test('unknown headroom (null) sorts as +Infinity to fan-out new pools', async () => {
    const pool = createAccountPool([
      { name: 'known', oauth: fakeOAuth('a'), remainingTokens: 99_999, remainingObservedAt: Date.now() },
      { name: 'fresh', oauth: fakeOAuth('b'), remainingTokens: null, remainingObservedAt: null },
    ]);
    const got = await pool.getAccessToken(undefined);
    expect(got.name).toBe('fresh');
  });

  test('session id sticks to the same member across calls', async () => {
    const pool = createAccountPool([
      { name: 'a', oauth: fakeOAuth('a'), remainingTokens: 1, remainingObservedAt: Date.now() },
      { name: 'b', oauth: fakeOAuth('b'), remainingTokens: 999, remainingObservedAt: Date.now() },
    ]);
    const first = await pool.getAccessToken('session-X');
    const second = await pool.getAccessToken('session-X');
    expect(second.name).toBe(first.name);
  });

  test('getAccessTokenExcluding falls back to a different member', async () => {
    const pool = createAccountPool([
      { name: 'a', oauth: fakeOAuth('a'), remainingTokens: 999, remainingObservedAt: Date.now() },
      { name: 'b', oauth: fakeOAuth('b'), remainingTokens: 1, remainingObservedAt: Date.now() },
    ]);
    const fallback = await pool.getAccessTokenExcluding(undefined, 'a');
    expect(fallback?.name).toBe('b');
  });

  test('replaceOAuth resets the member’s headroom estimate', async () => {
    const pool = createAccountPool([
      { name: 'a', oauth: fakeOAuth('a'), remainingTokens: 500, remainingObservedAt: 1_000 },
    ]);
    const before = pool.snapshot().members[0];
    expect(before?.remainingTokens).toBe(500);

    await pool.replaceOAuth('a', { accessToken: '', refreshToken: 'rt-new', expiresAt: 0 });
    const after = pool.snapshot().members[0];
    expect(after?.remainingTokens).toBeNull();
    expect(after?.remainingObservedAt).toBeNull();
  });
});
