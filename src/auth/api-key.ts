import { timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { InvalidRequest, Unauthorized } from '../lib/errors.js';
import { log } from '../lib/logger.js';
import type { ApiKeyRole, ApiKeyStore } from './api-key-store.js';

export type AuthenticatedUser = Readonly<{
  name: string;
  role: ApiKeyRole;
  /** Mirrors ApiKeyEntry.allowedModels — undefined/empty means no restriction. */
  allowedModels?: readonly string[];
}>;

declare module 'hono' {
  interface ContextVariableMap {
    user: AuthenticatedUser;
  }
}

// Anthropic-issued OAuth credentials carry these prefixes. The proxy issues
// its own API keys that never use these. A client presenting one of these
// almost always means `claude auth login` was run on a machine that should
// have stayed an API-key-only client — the keychain OAuth is leaking through
// `apiKeyHelper`. Rejecting at the prefix layer surfaces the cause (rather
// than a generic "invalid api key") so the operator can fix the local setup.
//
// Background: docs/operational-pitfalls.md #11 carries the self-diagnosis
// checklist and the recovery flow.
const OAUTH_TOKEN_PREFIXES = ['sk-ant-oat01-', 'sk-ant-ort01-'] as const;
const looksLikeOAuthToken = (presented: string): boolean =>
  OAUTH_TOKEN_PREFIXES.some((prefix) => presented.startsWith(prefix));

const safeEqual = (a: string, b: string): boolean => {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
};

const extractKey = (c: Context): string | null => {
  // Anthropic-native header first. Bearer is accepted because many OpenAI-shaped
  // clients (e.g. tools that pipe through env conventions) default to it.
  // Basic auth is accepted so a browser can hit /admin/ with the native
  // credential dialog — password portion is treated as the API key.
  const xApiKey = c.req.header('x-api-key');
  if (xApiKey && xApiKey.length > 0) return xApiKey;

  const auth = c.req.header('authorization');
  if (!auth) return null;
  const lower = auth.toLowerCase();

  if (lower.startsWith('bearer ')) {
    const token = auth.slice(7).trim();
    return token.length > 0 ? token : null;
  }

  if (lower.startsWith('basic ')) {
    try {
      const decoded = atob(auth.slice(6).trim());
      const colon = decoded.indexOf(':');
      const password = colon >= 0 ? decoded.slice(colon + 1) : decoded;
      return password.length > 0 ? password : null;
    } catch {
      return null;
    }
  }

  return null;
};

export const createApiKeyMiddleware = (store: ApiKeyStore): MiddlewareHandler => {
  return async (c, next) => {
    const presented = extractKey(c);
    if (presented === null) throw Unauthorized('missing api key');

    // Safeguard: reject OAuth-shaped tokens before the timing-safe compare.
    // Logged at warn (not alerted) — the operator is the only realistic
    // source of this signal in a trusted-few deployment, and a single noisy
    // line is enough for them to spot it on the next log review. The logged
    // prefix is truncated so the full token never lands in stderr.
    if (looksLikeOAuthToken(presented)) {
      log.warn(
        `[api-key] rejected OAuth-shaped token (prefix=${presented.slice(0, 14)}…) ` +
          `— see docs/operational-pitfalls.md #11`,
      );
      throw InvalidRequest(
        "client presented an OAuth token; this proxy accepts only proxy-issued API keys. " +
          "did you accidentally run 'claude auth login'? see docs/operational-pitfalls.md #11",
        'oauth_token_rejected',
      );
    }

    // Live-list each request — picks up store mutations (add/revoke) without
    // restart. The trusted-few key set stays tiny so this is microseconds.
    //
    // The loop deliberately does NOT short-circuit on match: a `break` would
    // leak which key matched via timing (early-match requests finish faster
    // than late-match ones). Always running through every entry keeps the
    // total cost equal regardless of where the match lives.
    const entries = store.list();
    let matched: AuthenticatedUser | null = null;
    for (const entry of entries) {
      if (safeEqual(presented, entry.key)) {
        matched = entry.allowedModels
          ? { name: entry.name, role: entry.role, allowedModels: entry.allowedModels }
          : { name: entry.name, role: entry.role };
      }
    }
    if (matched === null) throw Unauthorized('invalid api key');

    c.set('user', matched);
    await next();
  };
};
