import { timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { Unauthorized } from '../lib/errors.js';
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
