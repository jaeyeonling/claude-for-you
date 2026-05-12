import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ConfigError } from '../lib/errors.js';
import { createOAuthManager, type OAuthManager, type TokenState } from './oauth.js';
export type { TokenState };

/**
 * Phase 20a — multi-account pool.
 *
 * Wraps N OAuth managers (each tied to a distinct Claude.ai subscription) and
 * routes each request to one of them. The "cumulative aggregate" fingerprint
 * axis — long-term usage pattern of a single OAuth account becoming visibly
 * multi-tenant — is the only wire axis we couldn't otherwise close. Pooling
 * across 2+ accounts splits that load back toward natural 1-person shapes.
 *
 * Routing strategy:
 *   1. Session sticky FIRST. Same x-claude-code-session-id always goes to
 *      the same account → preserves Anthropic prompt-cache hits.
 *   2. New sessions pick the account with the highest known headroom
 *      (`anthropic-ratelimit-unified-remaining`). Null/unknown is treated
 *      as "plenty" so cold pools fan out instead of piling on one account.
 *
 * The pool is also the seam for in-flight 429 failover (Phase 20a-b):
 * `getAccessTokenExcluding(sessionId, excludeName)` lets the upstream layer
 * retry on a different account before surfacing the error to the client.
 *
 * Backward-compat: a single-account pool (N=1) behaves indistinguishably
 * from the bare OAuthManager — every request gets the same account.
 */

export interface PoolMemberSnapshot {
  readonly name: string;
  readonly remainingTokens: number | null;
  readonly remainingObservedAt: number | null;
}

export interface AccountPoolSnapshot {
  readonly members: readonly PoolMemberSnapshot[];
  readonly sessionAssignments: Readonly<Record<string, string>>;
}

export interface AccountPool {
  /** Token for this request. If sessionId is known, sticky to its account. */
  getAccessToken(sessionId: string | undefined): Promise<{ name: string; token: string }>;
  /** Same as getAccessToken but excludes a member (for 429 failover). */
  getAccessTokenExcluding(
    sessionId: string | undefined,
    excludeName: string,
  ): Promise<{ name: string; token: string } | null>;
  /** Force a fresh token for the named member (called on 401 retry). */
  forceRefresh(memberName: string): Promise<string>;
  /** Replace the named member's token state (operator UI). */
  replaceOAuth(memberName: string, state: TokenState): Promise<void>;
  /** Update internal headroom estimate from an upstream response. */
  observeResponse(memberName: string, responseHeaders: Headers): void;
  snapshot(): AccountPoolSnapshot;
}

interface PoolMember {
  name: string;
  oauth: OAuthManager;
  remainingTokens: number | null;
  remainingObservedAt: number | null;
}

const pickByHeadroom = (members: readonly PoolMember[], exclude?: string): PoolMember | null => {
  const eligible = exclude ? members.filter((m) => m.name !== exclude) : members;
  if (eligible.length === 0) return null;
  // Sort: higher remaining first; null = "unknown" sorts as +Infinity so
  // unobserved members get a chance over a tired-known one. Tie-break by name
  // for determinism in tests.
  const sorted = [...eligible].sort((a, b) => {
    const ar = a.remainingTokens ?? Number.POSITIVE_INFINITY;
    const br = b.remainingTokens ?? Number.POSITIVE_INFINITY;
    if (br !== ar) return br - ar;
    return a.name.localeCompare(b.name);
  });
  return sorted[0] ?? null;
};

export const createAccountPool = (members: readonly PoolMember[]): AccountPool => {
  if (members.length === 0) throw ConfigError('account pool requires at least 1 member');
  const memberByName = new Map(members.map((m) => [m.name, m]));
  const sessionAssignments = new Map<string, string>();

  const pick = (sessionId: string | undefined, exclude?: string): PoolMember | null => {
    if (sessionId !== undefined) {
      const sticky = sessionAssignments.get(sessionId);
      if (sticky && sticky !== exclude) {
        const m = memberByName.get(sticky);
        if (m) return m;
      }
    }
    const chosen = pickByHeadroom(members, exclude);
    if (chosen && sessionId !== undefined) sessionAssignments.set(sessionId, chosen.name);
    return chosen;
  };

  const pool: AccountPool = {
    async getAccessToken(sessionId: string | undefined) {
      const m = pick(sessionId);
      if (!m) throw ConfigError('account pool exhausted (no eligible member)');
      const token = await m.oauth.getAccessToken();
      return { name: m.name, token };
    },
    async getAccessTokenExcluding(sessionId: string | undefined, excludeName: string) {
      const m = pick(sessionId, excludeName);
      if (!m) return null;
      if (sessionId !== undefined) sessionAssignments.set(sessionId, m.name);
      const token = await m.oauth.getAccessToken();
      return { name: m.name, token };
    },
    async forceRefresh(memberName: string) {
      const m = memberByName.get(memberName);
      if (!m) throw ConfigError(`pool member not found: ${memberName}`);
      return m.oauth.forceRefresh();
    },
    async replaceOAuth(memberName: string, state: TokenState) {
      const m = memberByName.get(memberName);
      if (!m) throw ConfigError(`pool member not found: ${memberName}`);
      await m.oauth.replace(state);
    },
    observeResponse(memberName: string, responseHeaders: Headers) {
      const m = memberByName.get(memberName);
      if (!m) return;
      const raw =
        responseHeaders.get('anthropic-ratelimit-unified-remaining') ??
        responseHeaders.get('anthropic-ratelimit-tokens-remaining');
      if (raw === null) return;
      const n = Number(raw);
      if (!Number.isFinite(n)) return;
      m.remainingTokens = n;
      m.remainingObservedAt = Date.now();
    },
    snapshot() {
      return {
        members: members.map((m) => ({
          name: m.name,
          remainingTokens: m.remainingTokens,
          remainingObservedAt: m.remainingObservedAt,
        })),
        sessionAssignments: Object.fromEntries(sessionAssignments),
      };
    },
  };
  return Object.freeze(pool);
};

// ---------- loader ----------

interface AccountFile {
  readonly accounts: ReadonlyArray<{
    readonly name: string;
    readonly refreshToken: string;
    readonly accessToken?: string;
    readonly expiresAt?: number;
  }>;
}

export interface LoadAccountsParams {
  /** Path to accounts.json. If file missing, returns null. */
  readonly accountsPath: string;
  /** Token store base dir — each account gets `{baseDir}/tokens-{name}.json`. */
  readonly tokenStoreBaseDir: string;
  /** Optional alarm hook on refresh failure for any member. */
  readonly onRefreshFail?: (memberName: string, reason: string) => void;
}

/**
 * Build a multi-account pool from `accounts.json`. Returns null if the file
 * doesn't exist (caller falls back to single-account mode).
 */
export const tryLoadAccountPool = async (
  params: LoadAccountsParams,
): Promise<AccountPool | null> => {
  if (!existsSync(params.accountsPath)) return null;

  let raw: string;
  try {
    raw = await readFile(params.accountsPath, 'utf-8');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw ConfigError(`failed to read ${params.accountsPath}: ${msg}`);
  }

  let parsed: AccountFile;
  try {
    parsed = JSON.parse(raw) as AccountFile;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw ConfigError(`${params.accountsPath} malformed: ${msg}`);
  }
  if (!Array.isArray(parsed.accounts) || parsed.accounts.length === 0) {
    throw ConfigError(`${params.accountsPath} must contain a non-empty "accounts" array`);
  }

  const seen = new Set<string>();
  const members: PoolMember[] = [];
  for (const acc of parsed.accounts) {
    if (typeof acc.name !== 'string' || acc.name.length === 0) {
      throw ConfigError(`accounts entry missing "name"`);
    }
    if (seen.has(acc.name)) {
      throw ConfigError(`duplicate account name: ${acc.name}`);
    }
    seen.add(acc.name);
    if (typeof acc.refreshToken !== 'string' || acc.refreshToken.length === 0) {
      throw ConfigError(`account "${acc.name}" missing refreshToken`);
    }
    const envState: TokenState = {
      accessToken: acc.accessToken ?? '',
      refreshToken: acc.refreshToken,
      expiresAt: acc.expiresAt ?? 0,
    };
    const oauth = await createOAuthManager({
      envState,
      storePath: join(params.tokenStoreBaseDir, `tokens-${acc.name}.json`),
      onRefreshFail: (reason) => params.onRefreshFail?.(acc.name, reason),
    });
    members.push({
      name: acc.name,
      oauth,
      remainingTokens: null,
      remainingObservedAt: null,
    });
  }

  return createAccountPool(members);
};

/** Wrap a single OAuthManager as a 1-member pool (backward compat). */
export const singleAccountPool = (oauth: OAuthManager): AccountPool =>
  createAccountPool([
    { name: 'default', oauth, remainingTokens: null, remainingObservedAt: null },
  ]);

// Re-export for callers that want the dir convention
export const defaultTokenStoreBaseDir = (singleTokenPath: string): string => dirname(singleTokenPath);
