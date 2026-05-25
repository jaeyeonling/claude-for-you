import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApiKeyStore } from '../src/auth/api-key-store.js';

let workdir: string;
beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'cfy-keys-'));
});
afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

const SIXTEEN = '0123456789abcdef';
const longerKey = SIXTEEN.repeat(2); // 32 chars

describe('createApiKeyStore', () => {
  test('env-only mode: list returns env entries, source = env', () => {
    const store = createApiKeyStore({
      envKeys: [{ name: 'alice', key: longerKey }],
      filePath: null,
    });
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe('alice');
    expect(list[0]?.source).toBe('env');
  });

  test('add() requires API_KEYS_PATH and throws Conflict otherwise', async () => {
    const store = createApiKeyStore({
      envKeys: [{ name: 'alice', key: longerKey }],
      filePath: null,
    });
    expect(store.add('bob')).rejects.toThrow(/api keys file not configured/);
  });

  test('add() validates name (no whitespace/colon/comma)', async () => {
    const store = createApiKeyStore({
      envKeys: [{ name: 'alice', key: longerKey }],
      filePath: join(workdir, 'api-keys.json'),
    });
    expect(store.add('bad name')).rejects.toThrow(/whitespace\/colon\/comma/);
    expect(store.add('bad,name')).rejects.toThrow(/whitespace\/colon\/comma/);
    expect(store.add('bad:name')).rejects.toThrow(/whitespace\/colon\/comma/);
  });

  test('add() and revoke() round-trip and write atomically (0600)', async () => {
    const path = join(workdir, 'api-keys.json');
    const store = createApiKeyStore({ envKeys: [], filePath: path });
    const created = await store.add('alice');
    expect(created.key.length).toBeGreaterThanOrEqual(32);
    expect(created.source).toBe('file');
    expect(store.list().map((e) => e.name)).toEqual(['alice']);

    const ok = await store.revoke('alice');
    expect(ok).toBe(true);
    expect(store.list()).toHaveLength(0);
    expect(store.isRevoked('alice')).toBe(true);

    // The written file has correct shape — verify via raw read.
    const persisted = JSON.parse(await readFile(path, 'utf8')) as {
      keys: unknown[];
      revoked: string[];
    };
    expect(persisted.keys).toHaveLength(0);
    expect(persisted.revoked).toEqual(['alice']);
  });

  test('revoke() removes env-baked keys via the revoked-list mechanism', async () => {
    const store = createApiKeyStore({
      envKeys: [{ name: 'alice', key: longerKey }],
      filePath: join(workdir, 'api-keys.json'),
    });
    expect(store.list()).toHaveLength(1);
    await store.revoke('alice');
    expect(store.list()).toHaveLength(0); // env entry no longer visible
    expect(store.isRevoked('alice')).toBe(true);
  });

  test('revoke() rejects malformed name (regression for #M7 audit finding)', async () => {
    const store = createApiKeyStore({
      envKeys: [{ name: 'alice', key: longerKey }],
      filePath: join(workdir, 'api-keys.json'),
    });
    expect(store.revoke('alice with space')).rejects.toThrow(/whitespace\/colon\/comma/);
  });

  test('add() rejects duplicate names with key_exists', async () => {
    const store = createApiKeyStore({
      envKeys: [{ name: 'alice', key: longerKey }],
      filePath: join(workdir, 'api-keys.json'),
    });
    expect(store.add('alice')).rejects.toThrow(/already exists/);
  });
});
