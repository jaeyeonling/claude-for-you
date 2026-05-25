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
 *   Origin == "null" (sandbox / strict privacy / opaque origin)
 *     → check Referer; allow if its HOSTNAME matches expected (ignoring
 *       scheme + port to survive Caddy proxy hops, HSTS upgrades, etc.)
 *   Origin absent (non-browser CLI)   → ALLOW (no browser → no CSRF surface)
 *
 * Why hostname-only on the Origin-null fallback path:
 *   - An attacker page on https://evil.example.com can set neither Origin
 *     nor Referer to point at the proxy's hostname.
 *   - Same-origin form submissions in browsers that send Origin: null
 *     (Safari, sandbox iframes, some privacy modes) reliably send a
 *     Referer with the page hostname — but scheme/port may differ from
 *     what the server computes (Caddy → Bun internal hop, HSTS cache
 *     upgrades, etc.).
 *
 * Behind Caddy/any reverse proxy the effective public host comes from
 * X-Forwarded-Host. Without that header we fall back to the request URL.
 */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

const computeExpected = (c: Context): { origin: string; hostname: string } => {
  const xfProto = c.req.header('x-forwarded-proto');
  const xfHost = c.req.header('x-forwarded-host') ?? c.req.header('host');
  const url = new URL(c.req.url);
  const origin =
    xfHost !== undefined
      ? `${xfProto ?? url.protocol.replace(':', '')}://${xfHost}`
      : `${url.protocol}//${url.host}`;
  // Hostname only — used for the Referer-fallback path so we tolerate
  // Caddy ↔ Bun internal hop scheme/port quirks and stale HSTS upgrades.
  const hostname = (xfHost ?? url.host).split(':')[0] ?? '';
  return { origin, hostname };
};

const refererHostname = (referer: string | undefined): string | null => {
  if (!referer) return null;
  try {
    return new URL(referer).hostname;
  } catch {
    return null;
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

  const expected = computeExpected(c);

  if (origin === 'null') {
    // Sandbox / opaque origin / strict-privacy browser. Fall back to a
    // Referer HOSTNAME match — attacker pages can't forge Referer to the
    // proxy's hostname. Scheme + port deliberately ignored so we survive
    // Caddy → Bun internal hops, HSTS quirks, and downgrade redirects.
    const referer = c.req.header('referer');
    const refHost = refererHostname(referer);
    if (refHost !== null && refHost === expected.hostname) {
      await next();
      return;
    }
    throw CsrfFailed(
      `csrf check failed: Origin=null, Referer=${referer ?? '<none>'} (expected hostname ${expected.hostname})`,
    );
  }

  if (origin !== expected.origin) {
    throw CsrfFailed(`csrf check failed: Origin ${origin} ≠ expected ${expected.origin}`);
  }
  await next();
};
