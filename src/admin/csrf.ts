import type { Context, Next } from 'hono';
import { CsrfFailed } from '../lib/errors.js';

/**
 * Origin/Referer-based CSRF guard for state-changing admin endpoints.
 *
 * Admin auth is HTTP Basic — browsers cache credentials and auto-send them
 * cross-origin. Without this guard, any page on the internet can submit a
 * form POST to /admin/oauth/replace, /admin/alerts/*, /admin/keys/* etc.,
 * silently rotating tokens or exfiltrating webhook URLs.
 *
 * Decision table:
 *   Origin present + matches expected → ALLOW
 *   Origin present + mismatches       → DENY
 *   Origin == "null" (sandbox / strict
 *     privacy / opaque origin) → check Referer; allow if matches expected
 *   Origin absent (non-browser CLI)   → ALLOW (no browser → no CSRF surface)
 *
 * The Origin: null path matters because some browsers / privacy modes send
 * a literal "null" string for plain-HTTP same-origin form submissions or for
 * sandbox-embedded contexts. The Referer fallback lets legitimate operator
 * sessions through while still blocking attacker pages (which can't forge
 * Referer to match the proxy host).
 *
 * Behind Caddy/any reverse proxy the effective public host comes from
 * X-Forwarded-Host. Without that header we fall back to the request URL.
 */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

const computeExpectedOrigin = (c: Context): string => {
  const xfProto = c.req.header('x-forwarded-proto');
  const xfHost = c.req.header('x-forwarded-host') ?? c.req.header('host');
  const url = new URL(c.req.url);
  return xfHost !== undefined
    ? `${xfProto ?? url.protocol.replace(':', '')}://${xfHost}`
    : `${url.protocol}//${url.host}`;
};

const refererMatches = (referer: string | undefined, expected: string): boolean => {
  if (!referer) return false;
  try {
    return new URL(referer).origin === expected;
  } catch {
    return false;
  }
};

export const csrfGuard = async (c: Context, next: Next): Promise<Response | void> => {
  if (SAFE_METHODS.has(c.req.method)) {
    await next();
    return;
  }

  const origin = c.req.header('origin');

  if (origin === undefined) {
    // Non-browser client. CSRF requires a browser to forward credentials
    // automatically; CLI clients send their own Authorization header.
    await next();
    return;
  }

  const expectedOrigin = computeExpectedOrigin(c);

  if (origin === 'null') {
    // Sandbox / opaque origin / strict-privacy browser. Fall back to
    // Referer — an attacker page cannot forge Referer to match our host.
    const referer = c.req.header('referer');
    if (refererMatches(referer, expectedOrigin)) {
      await next();
      return;
    }
    throw CsrfFailed(
      `csrf check failed: Origin null with non-matching Referer (expected ${expectedOrigin})`,
    );
  }

  if (origin !== expectedOrigin) {
    throw CsrfFailed(`csrf check failed: Origin ${origin} ≠ expected ${expectedOrigin}`);
  }
  await next();
};
