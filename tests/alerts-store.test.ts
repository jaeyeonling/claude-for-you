import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAlertStore } from '../src/alerts-store.js';

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'cfy-alerts-'));
});
afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe('alerts-store', () => {
  test('env baseline applies when no file exists', async () => {
    const store = await createAlertStore({
      filePath: join(workdir, 'alerts.json'),
      envDiscord: 'https://discord.com/api/webhooks/x/y',
      envSlack: null,
    });
    expect(store.get().discordWebhookUrl).toBe('https://discord.com/api/webhooks/x/y');
    expect(store.get().slackWebhookUrl).toBeNull();
  });

  test('file overrides env when both present', async () => {
    const path = join(workdir, 'alerts.json');
    const first = await createAlertStore({ filePath: path, envDiscord: 'env-url', envSlack: null });
    await first.setDiscord('https://discord.com/api/webhooks/from-file');
    // Re-create — simulates a process restart.
    const second = await createAlertStore({ filePath: path, envDiscord: 'env-url', envSlack: null });
    expect(second.get().discordWebhookUrl).toBe('https://discord.com/api/webhooks/from-file');
  });

  test('setDiscord(null) clears the URL and persists', async () => {
    const path = join(workdir, 'alerts.json');
    const store = await createAlertStore({
      filePath: path,
      envDiscord: 'https://discord.com/api/webhooks/x',
      envSlack: null,
    });
    await store.setDiscord(null);
    // After clear, file state wins — null. Env value does NOT come back.
    const restarted = await createAlertStore({
      filePath: path,
      envDiscord: 'https://discord.com/api/webhooks/x',
      envSlack: null,
    });
    expect(restarted.get().discordWebhookUrl).toBeNull();
  });

  test('whitespace-only URLs normalize to null', async () => {
    const store = await createAlertStore({
      filePath: join(workdir, 'alerts.json'),
      envDiscord: '   ',
      envSlack: '',
    });
    expect(store.get().discordWebhookUrl).toBeNull();
    expect(store.get().slackWebhookUrl).toBeNull();
  });
});
