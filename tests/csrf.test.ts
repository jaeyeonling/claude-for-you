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

  test('Origin: null allowed when Referer hostname matches expected', async () => {
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

  test('Origin: null with HTTPS Referer to same hostname is allowed (HSTS quirk)', async () => {
    // Stale HSTS or browser auto-upgrade may give a Referer with `https`
    // even though the page is served over `http`. Hostname is what matters
    // for forgery resistance, not the scheme.
    const res = await buildApp().request('http://proxy.example.com/admin/x', {
      method: 'POST',
      headers: {
        Origin: 'null',
        Referer: 'https://proxy.example.com/admin',
      },
    });
    expect(res.status).toBe(200);
  });

  test('Origin: null with different-port Referer to same hostname is allowed', async () => {
    // Reverse-proxy port quirks: the Referer may carry the public port (80/
    // 443 implicit) while the server sees a different internal port. The
    // hostname-only check ignores port.
    const res = await buildApp().request('http://proxy.example.com/admin/x', {
      method: 'POST',
      headers: {
        Origin: 'null',
        Referer: 'http://proxy.example.com:8443/admin',
      },
    });
    expect(res.status).toBe(200);
  });

  test('Origin: null with malformed Referer is rejected', async () => {
    const res = await buildApp().request('http://proxy.example.com/admin/x', {
      method: 'POST',
      headers: {
        Origin: 'null',
        Referer: 'not a url',
      },
    });
    expect(res.status).toBe(403);
  });

  test('Origin: null error message includes the actual Referer for debugging', async () => {
    const res = await buildApp().request('http://proxy.example.com/admin/x', {
      method: 'POST',
      headers: {
        Origin: 'null',
        Referer: 'https://evil.example.com/x',
      },
    });
    const body = await res.text();
    expect(body).toContain('Referer=https://evil.example.com/x');
    expect(body).toContain('hostname proxy.example.com');
  });
});
