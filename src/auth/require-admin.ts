import type { MiddlewareHandler } from 'hono';
import { Forbidden } from '../lib/errors.js';

/**
 * Gate that runs *after* `createApiKeyMiddleware` has populated `c.var.user`.
 *
 * Only env-baked keys carry role === 'admin' (see api-key-store.ts), so a key
 * issued through `/admin/keys` (role === 'user') will receive 403 here even
 * though it authenticated successfully a frame earlier.
 *
 * The 401 vs 403 distinction matters: browsers re-prompt Basic credentials
 * on 401, which is wrong for a *correctly authenticated but unprivileged*
 * caller. Throwing 403 here keeps the WWW-Authenticate retry loop in
 * app.ts:onError tied to genuine auth failures.
 */
export const requireAdmin: MiddlewareHandler = async (c, next) => {
  const user = c.get('user');
  if (user.role !== 'admin') {
    throw Forbidden('admin role required', 'admin_required');
  }
  await next();
};
