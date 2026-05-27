import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { createApiKeyMiddleware } from '../src/auth/api-key.js';
import type { ApiKeyStore } from '../src/auth/api-key-store.js';
import { DomainError } from '../src/lib/errors.js';

const stubStore = (entries: Array<{ name: string; key: string }>): ApiKeyStore => ({
  list: () =>
    entries.map((e) => ({
      ...e,
      createdAt: '2026-01-01T00:00:00.000Z',
      source: 'env' as const,
      role: 'admin' as const,
    })),
  add: async () => {
    throw new Error('not used in middleware tests');
  },
  revoke: async () => false,
  isRevoked: () => false,
});

const buildApp = (store: ApiKeyStore): Hono => {
  const app = new Hono();
  app.use('/v1/*', createApiKeyMiddleware(store));
  app.get('/v1/whoami', (c) => {
    const u = c.get('user');
    return c.json({ name: u.name, role: u.role });
  });
  app.onError((err, c) => {
    if (err instanceof DomainError) return c.text(err.code, err.status as 401);
    return c.text('boom', 500);
  });
  return app;
};

const VALID = '0123456789abcdef0123456789abcdef';
const OTHER = 'fedcba9876543210fedcba9876543210';

describe('createApiKeyMiddleware', () => {
  test('accepts x-api-key header', async () => {
    const app = buildApp(stubStore([{ name: 'alice', key: VALID }]));
    const res = await app.request('/v1/whoami', {
      headers: { 'x-api-key': VALID },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: 'alice', role: 'admin' });
  });

  test('accepts Authorization: Bearer', async () => {
    const app = buildApp(stubStore([{ name: 'alice', key: VALID }]));
    const res = await app.request('/v1/whoami', {
      headers: { Authorization: `Bearer ${VALID}` },
    });
    expect(res.status).toBe(200);
  });

  test('accepts Authorization: Basic (password portion = key)', async () => {
    const app = buildApp(stubStore([{ name: 'alice', key: VALID }]));
    const creds = Buffer.from(`admin:${VALID}`).toString('base64');
    const res = await app.request('/v1/whoami', {
      headers: { Authorization: `Basic ${creds}` },
    });
    expect(res.status).toBe(200);
  });

  test('rejects missing credentials with 401', async () => {
    const app = buildApp(stubStore([{ name: 'alice', key: VALID }]));
    const res = await app.request('/v1/whoami');
    expect(res.status).toBe(401);
  });

  test('rejects an unrecognized but well-formed key', async () => {
    const app = buildApp(stubStore([{ name: 'alice', key: VALID }]));
    const res = await app.request('/v1/whoami', {
      headers: { 'x-api-key': OTHER },
    });
    expect(res.status).toBe(401);
  });

  test('different-length presented key still safe (no length leak)', async () => {
    const app = buildApp(stubStore([{ name: 'alice', key: VALID }]));
    const res = await app.request('/v1/whoami', {
      headers: { 'x-api-key': 'short' },
    });
    expect(res.status).toBe(401);
  });
});
