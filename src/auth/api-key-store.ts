import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ApiKeyEntry } from '../config.js';
import { ConfigError, Conflict, InvalidRequest, NotFound } from '../lib/errors.js';
import { assertValidModelPattern } from './model-allow.js';

/**
 * Phase 20c — API key store.
 *
 * Combines two sources:
 *   1. Static env: API_KEYS=alice:..,bob:.. (immutable, baked at boot)
 *   2. Dynamic file: api-keys.json (mutable via admin endpoints)
 *
 * Resolution: env first (operator's baseline), file additions appended,
 * file revocations win over env (so an operator can disable a baked-in key
 * without re-deploying). All lookups go through `list()` so the auth
 * middleware sees the latest state on every request.
 *
 * File shape:
 *   {
 *     "keys":  [{"name":"alice","key":"0123...","createdAt":"2026-..."}],
 *     "revoked": ["bob"]    // names disabled regardless of source
 *   }
 *
 * Persistence is atomic (temp file + rename) so admin actions can't
 * leave a half-written keystore on disk.
 */

const MIN_KEY_LENGTH = 16;

/**
 * `role` is derived from `source`, not stored in the file:
 *   - env-baked keys  → 'admin' (the operator who deployed the proxy)
 *   - file-added keys → 'user'  (issued via /admin/keys for regular consumers)
 *
 * Keeping it computed means there's no migration step for existing
 * api-keys.json files, and there's no way to accidentally elevate a
 * file-issued key by editing the JSON.
 */
export type ApiKeyRole = 'admin' | 'user';

export interface ApiKeyRecord extends ApiKeyEntry {
  readonly createdAt: string;
  readonly source: 'env' | 'file';
  readonly role: ApiKeyRole;
}

interface ApiKeyFile {
  readonly keys: ReadonlyArray<{
    readonly name: string;
    readonly key: string;
    readonly createdAt: string;
    readonly allowedModels?: readonly string[];
  }>;
  readonly revoked: readonly string[];
}

/**
 * `null`/empty array on `allowedModels` = "no restriction" (drops the field
 * from the persisted entry). `undefined` = "don't touch this field". The
 * distinction matters: a form submit with an empty input means "remove the
 * restriction", whereas a JSON PATCH that omits the field entirely means
 * "leave it alone".
 */
export interface ApiKeyPatch {
  readonly newName?: string;
  readonly allowedModels?: readonly string[] | null;
}

export interface ApiKeyStore {
  list(): readonly ApiKeyRecord[];
  add(
    name: string,
    options?: { providedKey?: string; allowedModels?: readonly string[] },
  ): Promise<ApiKeyRecord>;
  revoke(name: string): Promise<boolean>;
  /** True if `name` is in the revoke set — caller can short-circuit. */
  isRevoked(name: string): boolean;
  /**
   * Patch a file-issued key in place. Only `name` and `allowedModels` are
   * mutable — `key` and `createdAt` are stable identifiers. Throws:
   *   - Conflict (`key_revoked`)         if the target is in the revoke list
   *   - InvalidRequest (`env_source_immutable`) if the target is env-baked
   *   - NotFound (`key_not_found`)       if no file entry matches
   *   - Conflict (`name_conflict`)       if `newName` collides with an active key
   *   - Conflict (`name_in_revoke_list`) if `newName` is currently revoked
   *   - InvalidRequest                   on malformed name / model pattern
   */
  update(name: string, patch: ApiKeyPatch): Promise<ApiKeyRecord>;
}

const emptyFile = (): ApiKeyFile => ({ keys: [], revoked: [] });

const generateKey = (): string => randomBytes(32).toString('hex');

const loadFile = (path: string): ApiKeyFile => {
  if (!existsSync(path)) return emptyFile();
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw ConfigError(`failed to read ${path}: ${msg}`);
  }
  try {
    const parsed = JSON.parse(raw) as ApiKeyFile;
    if (!Array.isArray(parsed.keys) || !Array.isArray(parsed.revoked)) {
      throw new Error('missing keys[] or revoked[]');
    }
    return parsed;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw ConfigError(`api-keys file malformed (${path}): ${msg}`);
  }
};

const writeAtomic = async (path: string, file: ApiKeyFile): Promise<void> => {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
  await rename(tmp, path);
};

export const createApiKeyStore = (params: {
  readonly envKeys: readonly ApiKeyEntry[];
  readonly filePath: string | null;
}): ApiKeyStore => {
  const filePath = params.filePath;
  let file: ApiKeyFile = filePath ? loadFile(filePath) : emptyFile();

  // Per-store write mutex (issue #14). The store keeps `file` as in-memory
  // closure state and every mutator follows read-modify-persist. Without
  // serialization two concurrent writers read the same snapshot, each
  // computes `next` from it, and the later persist silently overwrites the
  // earlier one — admin UI assumes a single human operator but external
  // callers (curl, scripts) hit the race trivially.
  //
  // The chain shape (`writeLock.then(fn, fn)`) intentionally runs `fn`
  // whether the previous link resolved or rejected, so a throwing mutator
  // never deadlocks the chain. `next.catch(() => {})` keeps the rejection
  // contained inside the link that owns it; the lock-holding promise itself
  // must not surface as an unhandled rejection.
  let writeLock: Promise<unknown> = Promise.resolve();
  const withWriteLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = writeLock.then(fn, fn);
    writeLock = next.catch(() => undefined);
    return next;
  };

  const compose = (): readonly ApiKeyRecord[] => {
    const out: ApiKeyRecord[] = [];
    const seen = new Set<string>();
    const revoked = new Set(file.revoked);

    for (const entry of params.envKeys) {
      if (revoked.has(entry.name)) continue;
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      // Env-baked keys carry no allowedModels (the env format has no slot)
      // so they're effectively unrestricted. Operators wanting per-key
      // restriction must use api-keys.json.
      out.push({
        name: entry.name,
        key: entry.key,
        createdAt: '(env)',
        source: 'env',
        role: 'admin',
      });
    }
    for (const entry of file.keys) {
      if (revoked.has(entry.name)) continue;
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      out.push({ ...entry, source: 'file', role: 'user' });
    }
    return out;
  };

  const persist = async (next: ApiKeyFile): Promise<void> => {
    if (!filePath) {
      throw Conflict(
        'api keys file not configured (set API_KEYS_PATH to enable self-serve add/revoke)',
        'no_keystore_file',
      );
    }
    await writeAtomic(filePath, next);
    file = next;
  };

  // Reserved names that would alias Object.prototype slots if used as map
  // keys downstream — block at the boundary so we never persist them.
  const RESERVED_NAMES: ReadonlySet<string> = new Set([
    '__proto__',
    'prototype',
    'constructor',
  ]);

  const assertValidName = (name: string): void => {
    // Order matters: the message lists *all* disallowed shapes so the caller
    // doesn't have to retry one constraint at a time.
    //   whitespace/colon/comma — env format separators (API_KEYS=a:k,b:k)
    //   slash                  — would break URL path params
    //   control / DEL          — defense against header/log injection
    //   reserved               — prototype-pollution defense for downstream maps
    if (
      name.length === 0 ||
      /\s|,|:|\//.test(name) ||
      // eslint-disable-next-line no-control-regex
      /[\x00-\x1f\x7f]/.test(name) ||
      RESERVED_NAMES.has(name)
    ) {
      throw InvalidRequest(
        'name must be non-empty and contain no whitespace/colon/comma/slash/control-chars, ' +
          'and must not be a reserved key (__proto__, prototype, constructor)',
        'invalid_name',
      );
    }
  };

  return Object.freeze({
    list: compose,
    async add(
      name: string,
      options?: { providedKey?: string; allowedModels?: readonly string[] },
    ): Promise<ApiKeyRecord> {
      // Validate inputs *outside* the lock so callers see synchronous-style
      // rejection latency on bad input — no point holding the write queue
      // for a request that's going to fail validation.
      assertValidName(name);
      const key = options?.providedKey ?? generateKey();
      if (key.length < MIN_KEY_LENGTH) {
        throw InvalidRequest(`key must be at least ${MIN_KEY_LENGTH} chars`, 'key_too_short');
      }
      const allowedModels = options?.allowedModels;
      if (allowedModels) {
        try {
          for (const p of allowedModels) assertValidModelPattern(p);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          throw InvalidRequest(msg, 'invalid_model_pattern');
        }
      }

      return withWriteLock(async () => {
        // Existence check has to live *inside* the lock: a concurrent add()
        // of the same name could otherwise both pass the pre-lock check.
        const existing = compose().find((e) => e.name === name);
        if (existing) {
          throw Conflict(`key "${name}" already exists`, 'key_exists');
        }
        const createdAt = new Date().toISOString();
        const fileEntry: ApiKeyFile['keys'][number] = allowedModels
          ? { name, key, createdAt, allowedModels }
          : { name, key, createdAt };
        const next: ApiKeyFile = {
          keys: [...file.keys, fileEntry],
          revoked: file.revoked.filter((r) => r !== name),
        };
        await persist(next);
        const record: ApiKeyRecord = allowedModels
          ? { name, key, createdAt, source: 'file', role: 'user', allowedModels }
          : { name, key, createdAt, source: 'file', role: 'user' };
        return record;
      });
    },
    async update(name: string, patch: ApiKeyPatch): Promise<ApiKeyRecord> {
      // Helper kept local to update() because only file-source records are
      // ever returned from this path. `allowedModels` is copied via spread so
      // callers cannot mutate the in-memory keystore through the returned
      // record (the readonly[] type only enforces this at compile time).
      // Callers may pass `allowedModels: undefined` to signal "no restriction",
      // so the parameter is explicitly union-typed rather than optional —
      // satisfies tsconfig `exactOptionalPropertyTypes`.
      const buildFileRecord = (entry: {
        readonly name: string;
        readonly key: string;
        readonly createdAt: string;
        readonly allowedModels: readonly string[] | undefined;
      }): ApiKeyRecord => {
        const base = {
          name: entry.name,
          key: entry.key,
          createdAt: entry.createdAt,
          source: 'file' as const,
          role: 'user' as const,
        };
        return entry.allowedModels
          ? { ...base, allowedModels: [...entry.allowedModels] }
          : base;
      };

      // Cheap pre-lock validation: same rationale as add() — fail fast on
      // bad input without blocking other writers.
      assertValidName(name);
      if (patch.newName !== undefined && patch.newName !== name) {
        assertValidName(patch.newName);
      }
      if (
        patch.allowedModels !== undefined &&
        patch.allowedModels !== null &&
        patch.allowedModels.length > 0
      ) {
        try {
          for (const p of patch.allowedModels) assertValidModelPattern(p);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          throw InvalidRequest(msg, 'invalid_model_pattern');
        }
      }

      return withWriteLock(async () => {
        if (file.revoked.includes(name)) {
          throw Conflict(
            `key "${name}" is revoked — restore it before editing`,
            'key_revoked',
          );
        }
        if (params.envKeys.some((e) => e.name === name)) {
          throw InvalidRequest(
            `key "${name}" is env-baked and cannot be updated via the keystore file ` +
              `— change API_KEYS env and redeploy instead`,
            'env_source_immutable',
          );
        }
        const idx = file.keys.findIndex((e) => e.name === name);
        if (idx === -1) {
          throw NotFound(`key "${name}" not found`, 'key_not_found');
        }
        const current = file.keys[idx]!;

        let nextName = current.name;
        if (patch.newName !== undefined && patch.newName !== current.name) {
          if (file.revoked.includes(patch.newName)) {
            throw Conflict(
              `name "${patch.newName}" is in revoke list — pick another name or ` +
                `restore the revoked entry first`,
              'name_in_revoke_list',
            );
          }
          const collidesEnv = params.envKeys.some((e) => e.name === patch.newName);
          const collidesFile = file.keys.some(
            (e, i) => i !== idx && e.name === patch.newName,
          );
          if (collidesEnv || collidesFile) {
            throw Conflict(`key "${patch.newName}" already exists`, 'name_conflict');
          }
          nextName = patch.newName;
        }

        let nextAllowed: readonly string[] | undefined = current.allowedModels;
        if (patch.allowedModels !== undefined) {
          if (patch.allowedModels === null || patch.allowedModels.length === 0) {
            // Empty list and explicit null both mean "drop the restriction" —
            // we never persist an empty allowedModels array (it would be
            // unmatchable and lock the user out of every model).
            nextAllowed = undefined;
          } else {
            nextAllowed = patch.allowedModels;
          }
        }

        // No-op fast path: if neither name nor allowedModels actually changed,
        // skip the disk write entirely. Empty patches are common when the form
        // is submitted without modifications, and a no-op write would only add
        // contention on the keystore file.
        //
        // Ordered comparison is intentional: ['claude-haiku-*','claude-sonnet-*']
        // and ['claude-sonnet-*','claude-haiku-*'] differ at request time because
        // isModelAllowed (src/auth/model-allow.ts) runs `.some()` top-down. If
        // you ever switch this to set-equality, also revisit isModelAllowed.
        const sameAllowed =
          (nextAllowed === undefined && current.allowedModels === undefined) ||
          (nextAllowed !== undefined &&
            current.allowedModels !== undefined &&
            nextAllowed.length === current.allowedModels.length &&
            nextAllowed.every((p, i) => p === current.allowedModels![i]));
        if (nextName === current.name && sameAllowed) {
          return buildFileRecord({
            name: current.name,
            key: current.key,
            createdAt: current.createdAt,
            allowedModels: current.allowedModels,
          });
        }

        const nextEntry: ApiKeyFile['keys'][number] = nextAllowed
          ? {
              name: nextName,
              key: current.key,
              createdAt: current.createdAt,
              allowedModels: nextAllowed,
            }
          : { name: nextName, key: current.key, createdAt: current.createdAt };
        const next: ApiKeyFile = {
          keys: file.keys.map((e, i) => (i === idx ? nextEntry : e)),
          revoked: file.revoked,
        };
        await persist(next);

        return buildFileRecord({
          name: nextName,
          key: current.key,
          createdAt: current.createdAt,
          allowedModels: nextAllowed,
        });
      });
    },
    async revoke(name: string): Promise<boolean> {
      // Apply the same validator as add() — rejects malformed names from
      // the URL param before they touch the file format.
      assertValidName(name);
      return withWriteLock(async () => {
        const present = compose().some((e) => e.name === name);
        if (!present) return false;
        // Drop from file.keys if present and add to revoked (covers env-baked keys).
        const next: ApiKeyFile = {
          keys: file.keys.filter((k) => k.name !== name),
          revoked: file.revoked.includes(name) ? file.revoked : [...file.revoked, name],
        };
        await persist(next);
        return true;
      });
    },
    isRevoked(name: string): boolean {
      return file.revoked.includes(name);
    },
  });
};
