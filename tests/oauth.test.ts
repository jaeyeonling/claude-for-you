import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOAuthManager } from '../src/auth/oauth.js';

let workdir: string;
let originalFetch: typeof globalThis.fetch;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'cfy-oauth-'));
  originalFetch = globalThis.fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await rm(workdir, { recursive: true, force: true });
});

const SECONDS = 1000;
const VALID_REFRESH = `sk-ant-ort01-${'a'.repeat(80)}`;
const VALID_ACCESS = `sk-ant-oat01-${'b'.repeat(80)}`;

const mockSuccessfulRefresh = (
  next: { access: string; refresh: string; expiresIn: number },
): { fetchSpy: ReturnType<typeof mock> } => {
  const fetchSpy = mock(async () =>
    new Response(
      JSON.stringify({
        access_token: next.access,
        refresh_token: next.refresh,
        expires_in: next.expiresIn,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  );
  globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
  return { fetchSpy };
};

describe('createOAuthManager', () => {
  test('returns cached access token while still fresh (no refresh call)', async () => {
    const { fetchSpy } = mockSuccessfulRefresh({ access: 'new', refresh: 'new', expiresIn: 3600 });
    const mgr = await createOAuthManager({
      envState: {
        accessToken: VALID_ACCESS,
        refreshToken: VALID_REFRESH,
        expiresAt: Date.now() + 30 * 60 * SECONDS,
      },
      storePath: join(workdir, 'tokens.json'),
    });
    const tok = await mgr.getAccessToken();
    expect(tok).toBe(VALID_ACCESS);
    expect(fetchSpy.mock.calls).toHaveLength(0);
  });

  test('near-expiry tokens trigger a refresh', async () => {
    const { fetchSpy } = mockSuccessfulRefresh({
      access: 'refreshed-access',
      refresh: 'refreshed-refresh',
      expiresIn: 3600,
    });
    const mgr = await createOAuthManager({
      envState: {
        accessToken: VALID_ACCESS,
        refreshToken: VALID_REFRESH,
        // Already expired:
        expiresAt: Date.now() - 1000,
      },
      storePath: join(workdir, 'tokens.json'),
    });
    const tok = await mgr.getAccessToken();
    expect(tok).toBe('refreshed-access');
    expect(fetchSpy.mock.calls).toHaveLength(1);
  });

  test('concurrent getAccessToken calls share ONE refresh (single-flight)', async () => {
    let inflightCalls = 0;
    let peakConcurrency = 0;
    globalThis.fetch = (async () => {
      inflightCalls += 1;
      peakConcurrency = Math.max(peakConcurrency, inflightCalls);
      await new Promise((r) => setTimeout(r, 25));
      inflightCalls -= 1;
      return new Response(
        JSON.stringify({
          access_token: 'single-flight-access',
          refresh_token: 'single-flight-refresh',
          expires_in: 3600,
        }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const mgr = await createOAuthManager({
      envState: {
        accessToken: '', // empty → triggers refresh
        refreshToken: VALID_REFRESH,
        expiresAt: 0,
      },
      storePath: join(workdir, 'tokens.json'),
    });

    const tokens = await Promise.all([
      mgr.getAccessToken(),
      mgr.getAccessToken(),
      mgr.getAccessToken(),
      mgr.getAccessToken(),
    ]);
    expect(tokens.every((t) => t === 'single-flight-access')).toBe(true);
    // The whole point: never more than 1 in flight.
    expect(peakConcurrency).toBe(1);
  });

  test('refresh failure invokes onRefreshFail with redacted reason + throws', async () => {
    globalThis.fetch = (async () =>
      new Response(`{"error":"invalid_grant","refresh_token":"${VALID_REFRESH}"}`, {
        status: 400,
      })) as unknown as typeof globalThis.fetch;

    const captured: string[] = [];
    const mgr = await createOAuthManager({
      envState: { accessToken: '', refreshToken: VALID_REFRESH, expiresAt: 0 },
      storePath: join(workdir, 'tokens.json'),
      onRefreshFail: (reason) => {
        captured.push(reason);
      },
    });

    expect(mgr.getAccessToken()).rejects.toThrow(/oauth refresh failed/);
    // Wait a tick for onRefreshFail to fire (it's invoked synchronously
    // before the throw, so should already be captured).
    expect(captured).toHaveLength(1);
    // redact() must scrub the sk-ant-ort01-* substring from the alarm body.
    expect(captured[0]).toContain('[REDACTED]');
    expect(captured[0]).not.toContain(VALID_REFRESH);
  });

  test('replace() updates state and persists atomically', async () => {
    mockSuccessfulRefresh({ access: 'unused', refresh: 'unused', expiresIn: 3600 });
    const path = join(workdir, 'tokens.json');
    const mgr = await createOAuthManager({
      envState: { accessToken: VALID_ACCESS, refreshToken: VALID_REFRESH, expiresAt: Date.now() + 60_000 },
      storePath: path,
    });
    const next = {
      accessToken: 'fresh-access',
      refreshToken: 'sk-ant-ort01-fresh-pasted',
      expiresAt: Date.now() + 60_000,
    };
    await mgr.replace(next);
    expect(mgr.snapshot().refreshToken).toBe('sk-ant-ort01-fresh-pasted');
    const persisted = JSON.parse(await readFile(path, 'utf8')) as typeof next;
    expect(persisted.refreshToken).toBe('sk-ant-ort01-fresh-pasted');
  });

  test('replace() rejects empty refresh token', async () => {
    mockSuccessfulRefresh({ access: 'u', refresh: 'u', expiresIn: 3600 });
    const mgr = await createOAuthManager({
      envState: { accessToken: VALID_ACCESS, refreshToken: VALID_REFRESH, expiresAt: Date.now() + 60_000 },
      storePath: join(workdir, 'tokens.json'),
    });
    expect(
      mgr.replace({ accessToken: 'x', refreshToken: '', expiresAt: 0 }),
    ).rejects.toThrow(/refreshToken must be non-empty/);
  });
});
