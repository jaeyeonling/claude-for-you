import type { Context, Next } from 'hono';
import { CsrfFailed } from '../lib/errors.js';

/**
 * Origin-based CSRF guard for state-changing admin endpoints.
 *
 * Admin auth is HTTP Basic — browsers cache credentials and auto-send them
 * cross-origin. Without this guard, any page on the internet can submit a
 * form POST to /admin/oauth/replace, /admin/alerts/*, /admin/keys/* etc.,
 * silently rotating tokens or exfiltrating webhook URLs.
 *
 * Threat model & defense:
 *   - Browser cross-origin POST → Origin header set by browser, ≠ proxy host → 403
 *   - Same-origin admin form → Origin matches → allowed
 *   - Non-browser client (curl, scripts) → no Origin header → allowed (manual
 *     Authorization header is not subject to CSRF)
 *
 * Behind Caddy/any reverse proxy the effective public host comes from
 * X-Forwarded-Host. Without that header we fall back to the request URL.
 */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

export const csrfGuard = async (c: Context, next: Next): Promise<Response | void> => {
  if (SAFE_METHODS.has(c.req.method)) {
    await next();
    return;
  }

  const origin = c.req.header('origin');
  if (!origin) {
    // Non-browser client. CSRF requires a browser to forward credentials
    // automatically; CLI clients send their own Authorization header.
    await next();
    return;
  }

  const xfProto = c.req.header('x-forwarded-proto');
  const xfHost = c.req.header('x-forwarded-host') ?? c.req.header('host');
  const url = new URL(c.req.url);
  const expectedOrigin =
    xfHost !== undefined
      ? `${xfProto ?? url.protocol.replace(':', '')}://${xfHost}`
      : `${url.protocol}//${url.host}`;

  if (origin !== expectedOrigin) {
    throw CsrfFailed(`csrf check failed: Origin ${origin} ≠ expected ${expectedOrigin}`);
  }
  await next();
};
