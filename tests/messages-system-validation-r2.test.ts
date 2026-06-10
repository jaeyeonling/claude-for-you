/**
 * R2 behavioral fuzz for issue #57 — system block validation surfaced as a
 * real wire envelope through the full middleware -> onError -> JSON response
 * stack. Unit tests in `messages-ensure-system.test.ts` cover the predicate
 * and the throw site; this file confirms the failure path round-trips
 * end-to-end without breaking framing, content-type, or status code.
 *
 * Per CLAUDE.md persona R2 step: "exercise the failure path. Capture results
 * in the PR body Test plan."
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';

let workdir: string;
beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'cfy-r2-57-'));
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
    databaseUrl: null,
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

const postMessages = async (
  app: { request: (path: string, init?: RequestInit) => Promise<Response> },
  body: unknown,
): Promise<Response> =>
  app.request('/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': VALID_KEY,
    },
    body: JSON.stringify(body),
  });

describe('R2 #57: system block validation wire envelope', () => {
  test('null element -> 400 with invalid_system_block code + proxy marker', async () => {
    const { app, dispose } = await composeApp(baseConfig());
    try {
      const res = await postMessages(app, {
        model: 'claude-sonnet-4-6',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        system: [null],
      });
      expect(res.status).toBe(400);
      expect(res.headers.get('content-type')).toContain('application/json');
      const body = (await res.json()) as { error: { type: string; message: string } };
      expect(body.error.type).toBe('invalid_system_block');
      expect(body.error.message).toContain('[claude-for-you]');
      expect(body.error.message).toContain('system[0]');
      expect(body.error.message).toContain('got null');
    } finally {
      await dispose();
    }
  });

  test('non-text block ({type:image}) -> 400 invalid_system_block, never reaches upstream', async () => {
    const { app, dispose } = await composeApp(baseConfig());
    try {
      const res = await postMessages(app, {
        model: 'claude-sonnet-4-6',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        system: [{ type: 'image', source: { type: 'base64', data: 'AAA' } }],
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { type: string; message: string } };
      expect(body.error.type).toBe('invalid_system_block');
      expect(body.error.message).toContain('type="image"');
    } finally {
      await dispose();
    }
  });

  test('oversized type field -> response body bounded (chaos R1 fix)', async () => {
    const { app, dispose } = await composeApp(baseConfig());
    try {
      const oversizedType = 'x'.repeat(50_000);
      const res = await postMessages(app, {
        model: 'claude-sonnet-4-6',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        system: [{ type: oversizedType }],
      });
      expect(res.status).toBe(400);
      const raw = await res.text();
      expect(raw.length).toBeLessThan(500);
      expect(raw).not.toContain('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
    } finally {
      await dispose();
    }
  });

  test('control-char injection in type field -> stripped before reflection (adversary R1 fix)', async () => {
    const { app, dispose } = await composeApp(baseConfig());
    try {
      const res = await postMessages(app, {
        model: 'claude-sonnet-4-6',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        system: [{ type: 'evil\r\nX-Injected: bad\x00' }],
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { type: string; message: string } };
      expect(body.error.message).not.toMatch(/[\r\n\x00]/);
    } finally {
      await dispose();
    }
  });

  test('mixed valid+invalid array -> 400 with index of the invalid block', async () => {
    const { app, dispose } = await composeApp(baseConfig());
    try {
      const res = await postMessages(app, {
        model: 'claude-sonnet-4-6',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        system: [
          { type: 'text', text: 'ok block' },
          { type: 'text', text: 'also ok' },
          null,
        ],
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { type: string; message: string } };
      expect(body.error.message).toContain('system[2]');
    } finally {
      await dispose();
    }
  });

  test('canonical marker present alongside invalid neighbor -> 400 (validation runs before transparent path)', async () => {
    const { app, dispose } = await composeApp(baseConfig());
    try {
      const res = await postMessages(app, {
        model: 'claude-sonnet-4-6',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        system: [
          {
            type: 'text',
            text: "You are Claude Code, Anthropic's official CLI for Claude.",
            cache_control: { type: 'ephemeral' },
          },
          { type: 'image' },
        ],
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { type: string; message: string } };
      expect(body.error.type).toBe('invalid_system_block');
      expect(body.error.message).toContain('system[1]');
    } finally {
      await dispose();
    }
  });

  test('valid system path is NOT broken — string system still proceeds past validation', async () => {
    const { app, dispose } = await composeApp(baseConfig());
    try {
      const res = await postMessages(app, {
        model: 'claude-sonnet-4-6',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        system: 'you are a helpful bot',
      });
      if (res.status === 400) {
        const body = (await res.json()) as { error: { type: string } };
        expect(body.error.type).not.toBe('invalid_system_block');
      }
    } finally {
      await dispose();
    }
  });
});
