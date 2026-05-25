import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConfigError, UpstreamFailed } from '../lib/errors.js';
import { redact } from '../lib/redact.js';

const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REFRESH_BEFORE_EXPIRY_MS = 5 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 15_000;

export type TokenState = Readonly<{
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}>;

export type OAuthManager = Readonly<{
  getAccessToken(): Promise<string>;
  forceRefresh(): Promise<string>;
  snapshot(): TokenState;
  /**
   * Replace the in-memory token state and persist to disk. The next request
   * may immediately refresh if accessToken is empty or expiresAt is in the
   * past — this is the intended UX for "operator pasted a fresh refresh token".
   */
  replace(state: TokenState): Promise<void>;
}>;

type RefreshResponse = Readonly<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
}>;

const loadFromFile = async (path: string): Promise<TokenState | null> => {
  try {
    const text = await readFile(path, 'utf8');
    const parsed = JSON.parse(text) as TokenState;
    if (
      typeof parsed.accessToken !== 'string' ||
      typeof parsed.refreshToken !== 'string' ||
      typeof parsed.expiresAt !== 'number'
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

const writeAtomic = async (path: string, state: TokenState): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
  await rename(tmp, path);
};

const selectInitial = (
  envState: TokenState,
  fileState: TokenState | null,
): TokenState => {
  if (!fileState) return envState;
  // File wins only if it's strictly fresher — env is the operator's explicit
  // override and stays authoritative when both exist with equal expiry.
  return fileState.expiresAt > envState.expiresAt ? fileState : envState;
};

export const createOAuthManager = async (params: {
  envState: TokenState;
  storePath: string;
  onRefreshFail?: (reason: string) => void;
}): Promise<OAuthManager> => {
  if (params.envState.refreshToken.length === 0) {
    throw ConfigError('ANTHROPIC_OAUTH_REFRESH_TOKEN must be set');
  }

  const fileState = await loadFromFile(params.storePath);
  let current: TokenState = selectInitial(params.envState, fileState);
  let refreshInFlight: Promise<TokenState> | null = null;

  const isNearExpiry = (): boolean =>
    Date.now() + REFRESH_BEFORE_EXPIRY_MS >= current.expiresAt;

  const doRefresh = async (): Promise<TokenState> => {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: current.refreshToken,
      client_id: CLIENT_ID,
    }).toString();

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // Upstream error body can echo the submitted refresh_token in rare
      // edge cases. Redact before it travels to alarm sinks / logs.
      const reason = redact(`${res.status} ${text}`);
      params.onRefreshFail?.(reason);
      // OAuth refresh failure is always an operator / infra issue (expired
      // refresh token, rotated client_id, etc.). Surface as 502, not the
      // upstream's 4xx — clients would otherwise debug their own request.
      throw UpstreamFailed(`oauth refresh failed: ${reason}`);
    }

    const data = (await res.json()) as RefreshResponse;
    if (!data.access_token || !data.refresh_token || !data.expires_in) {
      throw UpstreamFailed('oauth refresh response malformed');
    }

    const next: TokenState = Object.freeze({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    });

    current = next;
    await writeAtomic(params.storePath, next);
    return next;
  };

  const ensureFresh = async (force: boolean): Promise<string> => {
    if (!force && !isNearExpiry() && current.accessToken.length > 0) {
      return current.accessToken;
    }

    if (!refreshInFlight) {
      refreshInFlight = doRefresh().finally(() => {
        refreshInFlight = null;
      });
    }

    const fresh = await refreshInFlight;
    return fresh.accessToken;
  };

  const replace = async (state: TokenState): Promise<void> => {
    if (state.refreshToken.length === 0) {
      throw ConfigError('refreshToken must be non-empty');
    }
    const next: TokenState = Object.freeze({
      accessToken: state.accessToken,
      refreshToken: state.refreshToken,
      expiresAt: state.expiresAt,
    });
    current = next;
    await writeAtomic(params.storePath, next);
  };

  return Object.freeze({
    getAccessToken: () => ensureFresh(false),
    forceRefresh: () => ensureFresh(true),
    snapshot: () => current,
    replace,
  });
};
