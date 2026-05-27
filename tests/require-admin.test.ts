import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { createApiKeyMiddleware } from '../src/auth/api-key.js';
import type { ApiKeyStore } from '../src/auth/api-key-store.js';
import { requireAdmin } from '../src/auth/require-admin.js';
import { DomainError } from '../src/lib/errors.js';

const ADMIN_KEY = '0123456789abcdef0123456789abcdef';
const USER_KEY = 'fedcba9876543210fedcba9876543210';

const store: ApiKeyStore = {
  list: () => [
    {
      name: 'operator',
      key: ADMIN_KEY,
      createdAt: '(env)',
      source: 'env',
      role: 'admin',
    },
    {
      name: 'bob',
      key: USER_KEY,
      createdAt: '2026-05-27T00:00:00.000Z',
      source: 'file',
      role: 'user',
    },
  ],
  add: async () => {
    throw new Error('not used');
  },
  revoke: async () => false,
  isRevoked: () => false,
};

const buildAdminApp = (): Hono => {
  const app = new Hono();
  app.use('/admin/*', createApiKeyMiddleware(store));
  app.use('/admin/*', requireAdmin);
  app.get('/admin/secret', (c) => c.text('ok'));
  app.onError((err, c) => {
    if (err instanceof DomainError) {
      return c.json({ code: err.code }, err.status as 401 | 403);
    }
    return c.text('boom', 500);
  });
  return app;
};

describe('requireAdmin gate on /admin/*', () => {
  test('env-baked admin key passes', async () => {
    const app = buildAdminApp();
    const res = await app.request('/admin/secret', {
      headers: { 'x-api-key': ADMIN_KEY },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  test('file-added user key is rejected with 403 admin_required', async () => {
    const app = buildAdminApp();
    const res = await app.request('/admin/secret', {
      headers: { 'x-api-key': USER_KEY },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'admin_required' });
  });

  test('missing credentials still get 401 (auth runs first)', async () => {
    const app = buildAdminApp();
    const res = await app.request('/admin/secret');
    expect(res.status).toBe(401);
  });

  test('invalid key gets 401 (auth runs first, never reaches role check)', async () => {
    const app = buildAdminApp();
    const res = await app.request('/admin/secret', {
      headers: { 'x-api-key': 'unknown' + 'x'.repeat(26) },
    });
    expect(res.status).toBe(401);
  });
});
