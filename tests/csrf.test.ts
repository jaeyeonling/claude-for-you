import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { csrfGuard } from '../src/admin/csrf.js';
import { DomainError } from '../src/lib/errors.js';

const buildApp = (): Hono => {
  const app = new Hono();
  app.use('*', csrfGuard);
  app.post('/admin/x', (c) => c.text('ok'));
  app.get('/admin/x', (c) => c.text('safe'));
  app.onError((err, c) => {
    if (err instanceof DomainError) return c.text(err.message, err.status as 403);
    return c.text('unexpected', 500);
  });
  return app;
};

describe('csrfGuard', () => {
  test('allows GET requests regardless of Origin', async () => {
    const res = await buildApp().request('/admin/x', {
      method: 'GET',
      headers: { Origin: 'https://evil.example.com' },
    });
    expect(res.status).toBe(200);
  });

  test('allows POST without any Origin header (non-browser client)', async () => {
    const res = await buildApp().request('/admin/x', { method: 'POST' });
    expect(res.status).toBe(200);
  });

  test('allows POST when Origin matches the request host', async () => {
    const res = await buildApp().request('https://proxy.example.com/admin/x', {
      method: 'POST',
      headers: { Origin: 'https://proxy.example.com' },
    });
    expect(res.status).toBe(200);
  });

  test('blocks POST when Origin disagrees with host', async () => {
    const res = await buildApp().request('https://proxy.example.com/admin/x', {
      method: 'POST',
      headers: { Origin: 'https://evil.example.com' },
    });
    expect(res.status).toBe(403);
  });

  test('honors X-Forwarded-Host (Caddy reverse-proxy scenario)', async () => {
    // Bun internal hits app:3456 — but the public host is proxy.example.com,
    // forwarded by Caddy. Origin matches the public host, so it must pass.
    const res = await buildApp().request('http://app:3456/admin/x', {
      method: 'POST',
      headers: {
        Origin: 'https://proxy.example.com',
        'X-Forwarded-Host': 'proxy.example.com',
        'X-Forwarded-Proto': 'https',
      },
    });
    expect(res.status).toBe(200);
  });

  test('Origin: null allowed when Referer matches expected host', async () => {
    // Some browsers (Safari, strict-privacy mode, sandbox iframes) send
    // a literal "null" Origin even on same-origin POSTs. We fall back to
    // Referer — same-origin Referer is forgery-resistant.
    const res = await buildApp().request('http://proxy.example.com/admin/x', {
      method: 'POST',
      headers: {
        Origin: 'null',
        Referer: 'http://proxy.example.com/admin',
      },
    });
    expect(res.status).toBe(200);
  });

  test('Origin: null with no Referer is rejected', async () => {
    const res = await buildApp().request('http://proxy.example.com/admin/x', {
      method: 'POST',
      headers: { Origin: 'null' },
    });
    expect(res.status).toBe(403);
  });

  test('Origin: null with cross-origin Referer is rejected', async () => {
    const res = await buildApp().request('http://proxy.example.com/admin/x', {
      method: 'POST',
      headers: {
        Origin: 'null',
        Referer: 'https://evil.example.com/attack',
      },
    });
    expect(res.status).toBe(403);
  });
});
