import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';

let workdir: string;
beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'cfy-app-'));
  await mkdir(join(workdir, 'data'), { recursive: true });
});
afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

const VALID_KEY = '0123456789abcdef0123456789abcdef';

const baseConfig = (overrides: Partial<AppConfig> = {}): AppConfig =>
  Object.freeze({
    port: 0,
    host: '127.0.0.1',
    oauth: Object.freeze({
      refreshToken: `sk-ant-ort01-${'a'.repeat(80)}`,
      accessToken: null,
      expiresAt: 0,
    }),
    tokenStorePath: join(workdir, 'data', 'tokens.json'),
    apiKeys: [{ name: 'alice', key: VALID_KEY }],
    apiKeysFilePath: null,
    dailyTokenLimitPerKey: 0,
    databaseUrl: null, // in-memory tracker — no DB needed for these tests
    globalSubscriptionThresholdTokens: 0,
    maxConcurrentRequests: 8,
    perIpRateLimitPerSecond: 0,
    pacingMinGapMs: 0,
    accountUuidOverride: 'test-uuid',
    accountsPath: join(workdir, 'data', 'accounts.json'),
    canaryPercent: 0,
    discordWebhookUrl: null,
    slackWebhookUrl: null,
    logLevel: 'error',
    ...overrides,
  });

describe('composeApp', () => {
  test('returns a Hono app whose /healthz responds 200', async () => {
    const { app, dispose } = await composeApp(baseConfig());
    try {
      const res = await app.request('/healthz');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    } finally {
      await dispose();
    }
  });

  test('/admin without credentials is 401', async () => {
    const { app, dispose } = await composeApp(baseConfig());
    try {
      const res = await app.request('/admin');
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toContain('Basic');
    } finally {
      await dispose();
    }
  });

  test('/admin with a valid api key returns the dashboard HTML', async () => {
    const { app, dispose } = await composeApp(baseConfig());
    try {
      const res = await app.request('/admin', {
        headers: { 'x-api-key': VALID_KEY },
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('claude-for-you · admin');
      expect(html).toContain('billing health');
      expect(html).toContain('oauth token rotation');
      expect(html).toContain('alert webhooks');
    } finally {
      await dispose();
    }
  });

  test('cross-origin POST to /admin/alerts/discord is rejected by CSRF guard', async () => {
    const { app, dispose } = await composeApp(baseConfig());
    try {
      const res = await app.request('http://proxy.example.com/admin/alerts/discord', {
        method: 'POST',
        headers: {
          'x-api-key': VALID_KEY,
          Origin: 'https://evil.example.com',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: 'url=',
      });
      expect(res.status).toBe(403);
    } finally {
      await dispose();
    }
  });

  test('/v1/messages without api key is 401', async () => {
    const { app, dispose } = await composeApp(baseConfig());
    try {
      const res = await app.request('/v1/messages', {
        method: 'POST',
        body: '{}',
        headers: { 'content-type': 'application/json' },
      });
      expect(res.status).toBe(401);
    } finally {
      await dispose();
    }
  });

  test('boots with no apiKeys + no apiKeysFilePath → throws ConfigError', async () => {
    expect(
      composeApp(baseConfig({ apiKeys: [] })),
    ).rejects.toThrow(/api-key store is empty/);
  });
});
