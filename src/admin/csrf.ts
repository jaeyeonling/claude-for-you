import type { Context, Next } from 'hono';
import { CsrfFailed } from '../lib/errors.js';

/**
 * CSRF guard for state-changing admin endpoints.
 *
 * Admin auth is HTTP Basic — browsers cache credentials and auto-send them
 * cross-origin. Without this guard, any page on the internet can submit a
 * form POST to /admin/oauth/replace, /admin/alerts/*, /admin/keys/* etc.,
 * silently rotating tokens or exfiltrating webhook URLs.
 *
 * Defense layers, in priority order:
 *
 *   1. Sec-Fetch-Site (modern browsers, RFC: Fetch Metadata Request Headers)
 *      - Sent by every Chromium/Firefox/Safari version from ~2020+
 *      - Cannot be set by attacker JavaScript (forbidden header per Fetch spec)
 *      - Not affected by Referrer-Policy
 *      - Values: same-origin / same-site / cross-site / none
 *      - We allow `same-origin` (the legitimate operator case) and `none`
 *        (direct user action — bookmark, typed URL; rare for POST but safe)
 *      - We reject `same-site` and `cross-site` outright
 *
 *   2. Origin header — older browsers without Sec-Fetch-Site, or unusual
 *      contexts. Standard comparison: Origin must equal the expected host
 *      (including scheme). An attacker page CANNOT set Origin to our host.
 *
 *   3. Referer header — last-resort fallback when Origin is `null` (sandbox /
 *      strict-privacy modes / opaque origins) AND Sec-Fetch-Site is missing.
 *      Hostname-only comparison so we tolerate Caddy ↔ Bun internal hops,
 *      HSTS quirks, port mismatches.
 *
 *   4. No Origin AND no Sec-Fetch-Site → non-browser client (curl, scripts).
 *      No browser → no CSRF surface. The API-key middleware already
 *      enforces authn.
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

  // Layer 1: Sec-Fetch-Site — definitive, attacker-unforgeable signal.
  const fetchSite = c.req.header('sec-fetch-site');
  if (fetchSite !== undefined) {
    if (fetchSite === 'same-origin' || fetchSite === 'none') {
      await next();
      return;
    }
    throw CsrfFailed(`csrf check failed: Sec-Fetch-Site=${fetchSite}`);
  }

  // Layer 2/4: Origin header — present in nearly all browser POSTs.
  const origin = c.req.header('origin');
  if (origin === undefined) {
    // No Sec-Fetch-Site AND no Origin → non-browser client. The auth
    // middleware verified the API key; CSRF is a browser-only attack
    // because it relies on the browser auto-sending credentials.
    await next();
    return;
  }

  const expected = computeExpected(c);

  if (origin === 'null') {
    // Layer 3: Referer hostname fallback for the Origin:null case.
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
