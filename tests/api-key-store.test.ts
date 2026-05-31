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

  test('add() validates name (no whitespace/colon/comma/slash/control/reserved)', async () => {
    const store = createApiKeyStore({
      envKeys: [{ name: 'alice', key: longerKey }],
      filePath: join(workdir, 'api-keys.json'),
    });
    expect(store.add('bad name')).rejects.toThrow(/invalid|whitespace/);
    expect(store.add('bad,name')).rejects.toThrow(/invalid|whitespace/);
    expect(store.add('bad:name')).rejects.toThrow(/invalid|whitespace/);
    // New hardening: slash would break URL path params
    expect(store.add('bad/name')).rejects.toThrow(/slash|invalid/);
    // New hardening: NULL byte and other control chars
    expect(store.add('bad\x00name')).rejects.toThrow(/control|invalid/);
    expect(store.add('bad\x1fname')).rejects.toThrow(/control|invalid/);
    // New hardening: reserved prototype keys
    expect(store.add('__proto__')).rejects.toThrow(/reserved/);
    expect(store.add('constructor')).rejects.toThrow(/reserved/);
    expect(store.add('prototype')).rejects.toThrow(/reserved/);
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

  test('add() with allowedModels persists and exposes them on list()', async () => {
    const store = createApiKeyStore({
      envKeys: [],
      filePath: join(workdir, 'api-keys.json'),
    });
    const created = await store.add('bob', {
      allowedModels: ['claude-haiku-*', 'claude-sonnet-4-6'],
    });
    expect(created.allowedModels).toEqual(['claude-haiku-*', 'claude-sonnet-4-6']);
    const fromList = store.list().find((e) => e.name === 'bob');
    expect(fromList?.allowedModels).toEqual(['claude-haiku-*', 'claude-sonnet-4-6']);
  });

  test('add() rejects malformed model patterns at write time', async () => {
    const store = createApiKeyStore({
      envKeys: [],
      filePath: join(workdir, 'api-keys.json'),
    });
    // Multi-wildcard pattern would silently never match — reject early.
    expect(
      store.add('carol', { allowedModels: ['claude-*-opus-*'] }),
    ).rejects.toThrow(/more than one/);
  });

  test('env-baked keys carry no allowedModels (env format has no slot)', () => {
    const store = createApiKeyStore({
      envKeys: [{ name: 'alice', key: longerKey }],
      filePath: null,
    });
    const alice = store.list().find((e) => e.name === 'alice');
    expect(alice?.allowedModels).toBeUndefined();
  });

  test('env-baked keys get role=admin, file-added keys get role=user', async () => {
    const store = createApiKeyStore({
      envKeys: [{ name: 'operator', key: longerKey }],
      filePath: join(workdir, 'api-keys.json'),
    });
    const issued = await store.add('bob');
    expect(issued.role).toBe('user');

    const list = store.list();
    expect(list.find((e) => e.name === 'operator')?.role).toBe('admin');
    expect(list.find((e) => e.name === 'bob')?.role).toBe('user');
  });

  test('persisted file keys come back as role=user on next list()', async () => {
    const path = join(workdir, 'api-keys.json');
    const a = createApiKeyStore({ envKeys: [], filePath: path });
    await a.add('carol');

    // New store instance, same file — simulates restart.
    const b = createApiKeyStore({ envKeys: [], filePath: path });
    expect(b.list().find((e) => e.name === 'carol')?.role).toBe('user');
  });

  describe('update()', () => {
    test('updates allowedModels in place, preserves key and createdAt', async () => {
      const store = createApiKeyStore({ envKeys: [], filePath: join(workdir, 'api-keys.json') });
      const created = await store.add('bob', { allowedModels: ['claude-haiku-*'] });
      const updated = await store.update('bob', {
        allowedModels: ['claude-sonnet-4-6', 'claude-opus-*'],
      });
      expect(updated.allowedModels).toEqual(['claude-sonnet-4-6', 'claude-opus-*']);
      // key + createdAt must NOT change — they're the stable identity of the row.
      expect(updated.key).toBe(created.key);
      expect(updated.createdAt).toBe(created.createdAt);
    });

    test('renames a key, leaves allowedModels alone when patch omits it', async () => {
      const store = createApiKeyStore({ envKeys: [], filePath: join(workdir, 'api-keys.json') });
      await store.add('bob', { allowedModels: ['claude-haiku-*'] });
      const renamed = await store.update('bob', { newName: 'robert' });
      expect(renamed.name).toBe('robert');
      expect(renamed.allowedModels).toEqual(['claude-haiku-*']);
      expect(store.list().map((e) => e.name)).toEqual(['robert']);
    });

    test('allowedModels: null drops the restriction (any model allowed)', async () => {
      const store = createApiKeyStore({ envKeys: [], filePath: join(workdir, 'api-keys.json') });
      await store.add('bob', { allowedModels: ['claude-haiku-*'] });
      const updated = await store.update('bob', { allowedModels: null });
      expect(updated.allowedModels).toBeUndefined();
    });

    test('allowedModels: [] also drops the restriction (treated as null)', async () => {
      const store = createApiKeyStore({ envKeys: [], filePath: join(workdir, 'api-keys.json') });
      await store.add('bob', { allowedModels: ['claude-haiku-*'] });
      const updated = await store.update('bob', { allowedModels: [] });
      expect(updated.allowedModels).toBeUndefined();
    });

    test('rejects env-baked keys with env_source_immutable', async () => {
      const store = createApiKeyStore({
        envKeys: [{ name: 'alice', key: longerKey }],
        filePath: join(workdir, 'api-keys.json'),
      });
      expect(store.update('alice', { allowedModels: ['claude-haiku-*'] })).rejects.toThrow(
        /env-baked/,
      );
    });

    test('rejects revoked keys with key_revoked', async () => {
      const store = createApiKeyStore({ envKeys: [], filePath: join(workdir, 'api-keys.json') });
      await store.add('bob');
      await store.revoke('bob');
      expect(store.update('bob', { allowedModels: ['claude-haiku-*'] })).rejects.toThrow(
        /revoked/,
      );
    });

    test('rejects missing keys with key_not_found', async () => {
      const store = createApiKeyStore({ envKeys: [], filePath: join(workdir, 'api-keys.json') });
      expect(store.update('ghost', { allowedModels: ['claude-haiku-*'] })).rejects.toThrow(
        /not found/,
      );
    });

    test('rejects newName that collides with another active file key', async () => {
      const store = createApiKeyStore({ envKeys: [], filePath: join(workdir, 'api-keys.json') });
      await store.add('alice');
      await store.add('bob');
      expect(store.update('bob', { newName: 'alice' })).rejects.toThrow(/already exists/);
    });

    test('rejects newName that collides with an env-baked key', async () => {
      const store = createApiKeyStore({
        envKeys: [{ name: 'operator', key: longerKey }],
        filePath: join(workdir, 'api-keys.json'),
      });
      await store.add('bob');
      expect(store.update('bob', { newName: 'operator' })).rejects.toThrow(/already exists/);
    });

    test('rejects newName that sits in the revoke list', async () => {
      const store = createApiKeyStore({ envKeys: [], filePath: join(workdir, 'api-keys.json') });
      await store.add('alice');
      await store.add('bob');
      await store.revoke('alice');
      // 'alice' is now in the revoked list — renaming bob to alice would
      // resurrect a revoked identity. Block it.
      expect(store.update('bob', { newName: 'alice' })).rejects.toThrow(/revoke list/);
    });

    test('rejects malformed model patterns at update time', async () => {
      const store = createApiKeyStore({ envKeys: [], filePath: join(workdir, 'api-keys.json') });
      await store.add('bob');
      expect(store.update('bob', { allowedModels: ['claude-*-opus-*'] })).rejects.toThrow(
        /more than one/,
      );
    });

    test('rejects malformed newName', async () => {
      const store = createApiKeyStore({ envKeys: [], filePath: join(workdir, 'api-keys.json') });
      await store.add('bob');
      expect(store.update('bob', { newName: 'bad name' })).rejects.toThrow(
        /whitespace\/colon\/comma/,
      );
    });

    test('newName === current name is a no-op (still succeeds)', async () => {
      const store = createApiKeyStore({ envKeys: [], filePath: join(workdir, 'api-keys.json') });
      await store.add('bob', { allowedModels: ['claude-haiku-*'] });
      const updated = await store.update('bob', { newName: 'bob' });
      expect(updated.name).toBe('bob');
      expect(updated.allowedModels).toEqual(['claude-haiku-*']);
    });

    test('empty patch is a no-op (no disk write)', async () => {
      const path = join(workdir, 'api-keys.json');
      const store = createApiKeyStore({ envKeys: [], filePath: path });
      await store.add('bob', { allowedModels: ['claude-haiku-*'] });
      const beforeStat = await readFile(path, 'utf8');
      // Re-read mtime via raw content equality after a no-op patch.
      const updated = await store.update('bob', {});
      expect(updated.name).toBe('bob');
      expect(updated.allowedModels).toEqual(['claude-haiku-*']);
      const afterStat = await readFile(path, 'utf8');
      // Disk content must be byte-identical (no rewrite happened).
      expect(afterStat).toBe(beforeStat);
    });

    test('semantically identical patch is also a no-op', async () => {
      const path = join(workdir, 'api-keys.json');
      const store = createApiKeyStore({ envKeys: [], filePath: path });
      await store.add('bob', { allowedModels: ['claude-haiku-*'] });
      const before = await readFile(path, 'utf8');
      // newName === current and allowedModels content identical
      await store.update('bob', { newName: 'bob', allowedModels: ['claude-haiku-*'] });
      const after = await readFile(path, 'utf8');
      expect(after).toBe(before);
    });

    test('returned allowedModels is a fresh copy — caller mutation does not leak into store', async () => {
      const store = createApiKeyStore({ envKeys: [], filePath: join(workdir, 'api-keys.json') });
      await store.add('bob', { allowedModels: ['claude-haiku-*'] });
      const updated = await store.update('bob', { allowedModels: ['claude-sonnet-*'] });
      // Caller pushes into the returned array — must NOT corrupt the keystore.
      (updated.allowedModels as string[]).push('claude-opus-*');
      const reread = store.list().find((e) => e.name === 'bob');
      expect(reread?.allowedModels).toEqual(['claude-sonnet-*']);
    });

    test('no-op path also returns a fresh copy of allowedModels', async () => {
      const store = createApiKeyStore({ envKeys: [], filePath: join(workdir, 'api-keys.json') });
      await store.add('bob', { allowedModels: ['claude-haiku-*'] });
      const updated = await store.update('bob', {}); // no-op
      (updated.allowedModels as string[]).push('claude-opus-*');
      const reread = store.list().find((e) => e.name === 'bob');
      expect(reread?.allowedModels).toEqual(['claude-haiku-*']);
    });

    test('persists across store instances', async () => {
      const path = join(workdir, 'api-keys.json');
      const a = createApiKeyStore({ envKeys: [], filePath: path });
      await a.add('bob');
      await a.update('bob', { newName: 'robert', allowedModels: ['claude-haiku-*'] });

      const b = createApiKeyStore({ envKeys: [], filePath: path });
      const entry = b.list().find((e) => e.name === 'robert');
      expect(entry).toBeDefined();
      expect(entry?.allowedModels).toEqual(['claude-haiku-*']);
    });
  });

  describe('concurrency (issue #14)', () => {
    // Without serialization, two writes that both read the same in-memory
    // `file` snapshot and then `await persist(next)` end up with last-write-
    // wins — the earlier mutation is silently lost. Each test below fires
    // two writes via Promise.all; both must survive.

    test('two updates on different keys both persist', async () => {
      const path = join(workdir, 'api-keys.json');
      const store = createApiKeyStore({ envKeys: [], filePath: path });
      await store.add('alice', { allowedModels: ['claude-haiku-*'] });
      await store.add('bob', { allowedModels: ['claude-haiku-*'] });

      await Promise.all([
        store.update('alice', { allowedModels: ['claude-sonnet-*'] }),
        store.update('bob', { allowedModels: ['claude-opus-*'] }),
      ]);

      // Re-read from disk so we exercise the persisted state, not the
      // in-memory closure.
      const reread = createApiKeyStore({ envKeys: [], filePath: path });
      const alice = reread.list().find((e) => e.name === 'alice');
      const bob = reread.list().find((e) => e.name === 'bob');
      expect(alice?.allowedModels).toEqual(['claude-sonnet-*']);
      expect(bob?.allowedModels).toEqual(['claude-opus-*']);
    });

    test('two updates on the same key — second sees the first and fails visibly, no silent loss', async () => {
      const path = join(workdir, 'api-keys.json');
      const store = createApiKeyStore({ envKeys: [], filePath: path });
      await store.add('bob');

      // Two clients both think the key is "bob" and submit different patches.
      // The mutex serializes them in submission order. The first commits a
      // rename to "robert"; the second still references "bob" and so must
      // observe a fresh snapshot — not the stale pre-lock one — and fail
      // visibly with key_not_found.
      //
      // The point of the fix is *not* "both writes land" (impossible without
      // a merge resolver — the second client has no idea bob was renamed).
      // The point is "loss is surfaced to the caller as a rejection rather
      // than silently dropped by a last-write-wins overwrite."
      //
      // Ordering assumption: `Promise.allSettled` here relies on
      // `withWriteLock` queueing each call via `writeLock.then(fn, fn)` —
      // because `.then()` callbacks fire in registration order, the call we
      // pass first to `allSettled` registers first and therefore runs first.
      // If anyone replaces the chain mutex with a different primitive that
      // doesn't preserve submission order, this test will start flaking on
      // which result is fulfilled vs rejected.
      const results = await Promise.allSettled([
        store.update('bob', { newName: 'robert' }),
        store.update('bob', { allowedModels: ['claude-haiku-*'] }),
      ]);

      expect(results[0].status).toBe('fulfilled');
      expect(results[1].status).toBe('rejected');
      if (results[1].status === 'rejected') {
        expect(String(results[1].reason)).toMatch(/not found/);
      }

      // Persisted state reflects the first (rename) write; the second was
      // rejected before any disk mutation.
      const reread = createApiKeyStore({ envKeys: [], filePath: path });
      const final = reread.list().find((e) => e.name === 'robert');
      expect(final).toBeDefined();
      expect(final?.allowedModels).toBeUndefined();
    });

    test('write queue cap rejects beyond MAX_WRITE_QUEUE_DEPTH (DoS guard)', async () => {
      const path = join(workdir, 'api-keys.json');
      const store = createApiKeyStore({ envKeys: [], filePath: path });

      // The cap (currently 100) caps the unbounded promise-chain queue that
      // an authenticated admin could otherwise grow without bound via a
      // PATCH/POST flood. We fire 110 add() calls concurrently; the first
      // 100 should queue and resolve, the rest must reject synchronously
      // with `write_queue_full` rather than join the queue.
      const total = 110;
      const calls = Array.from({ length: total }, (_, i) => store.add('k' + i));
      const results = await Promise.allSettled(calls);

      const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
      const queueFullRejections = results.filter(
        (r) =>
          r.status === 'rejected' && String(r.reason).match(/write queue full/),
      ).length;

      // Up to MAX_WRITE_QUEUE_DEPTH (100) succeed; the rest are queue-full.
      expect(fulfilled).toBe(100);
      expect(queueFullRejections).toBe(total - 100);
    });

    test('TOCTOU guard: caller mutating patch after submit cannot leak past pre-lock validation', async () => {
      const path = join(workdir, 'api-keys.json');
      const store = createApiKeyStore({ envKeys: [], filePath: path });
      await store.add('bob');

      // Build a patch with a *valid* newName so it passes pre-lock validation,
      // then mutate it to an *invalid* one before the lock body runs. The
      // store must use the snapshot captured at pre-lock time, not re-read
      // the mutated patch object.
      const patch: { newName: string; allowedModels: string[] } = {
        newName: 'robert',
        allowedModels: ['claude-haiku-*'],
      };
      const pending = store.update('bob', patch);
      // Caller flips fields after submitting. If `update()` re-reads `patch`
      // inside the lock, the persisted state would carry the mutated values
      // — name with a space, or allowedModels with an invalid pattern.
      patch.newName = 'invalid name';
      patch.allowedModels.push('multi-*-wildcard-*');

      const result = await pending;
      expect(result.name).toBe('robert');
      expect(result.allowedModels).toEqual(['claude-haiku-*']);

      // Verify persistence too — the snapshot copy must protect the on-disk
      // state, not just the returned record.
      const reread = createApiKeyStore({ envKeys: [], filePath: path });
      const final = reread.list().find((e) => e.name === 'robert');
      expect(final?.allowedModels).toEqual(['claude-haiku-*']);
    });

    test('concurrent add() + revoke() both land', async () => {
      const path = join(workdir, 'api-keys.json');
      const store = createApiKeyStore({ envKeys: [], filePath: path });
      await store.add('alice');

      await Promise.all([store.add('bob'), store.revoke('alice')]);

      const reread = createApiKeyStore({ envKeys: [], filePath: path });
      const names = reread.list().map((e) => e.name);
      expect(names).toEqual(['bob']);
      expect(reread.isRevoked('alice')).toBe(true);
    });
  });
});
