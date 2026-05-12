import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ApiKeyEntry } from '../config.js';
import { ConfigError, DomainError } from '../lib/errors.js';

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

export interface ApiKeyRecord extends ApiKeyEntry {
  readonly createdAt: string;
  readonly source: 'env' | 'file';
}

interface ApiKeyFile {
  readonly keys: ReadonlyArray<{
    readonly name: string;
    readonly key: string;
    readonly createdAt: string;
  }>;
  readonly revoked: readonly string[];
}

export interface ApiKeyStore {
  list(): readonly ApiKeyRecord[];
  add(name: string, providedKey?: string): Promise<ApiKeyRecord>;
  revoke(name: string): Promise<boolean>;
  /** True if `name` is in the revoke set — caller can short-circuit. */
  isRevoked(name: string): boolean;
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
  const { rename } = await import('node:fs/promises');
  await rename(tmp, path);
};

export const createApiKeyStore = (params: {
  readonly envKeys: readonly ApiKeyEntry[];
  readonly filePath: string | null;
}): ApiKeyStore => {
  const filePath = params.filePath;
  let file: ApiKeyFile = filePath ? loadFile(filePath) : emptyFile();

  const compose = (): readonly ApiKeyRecord[] => {
    const out: ApiKeyRecord[] = [];
    const seen = new Set<string>();
    const revoked = new Set(file.revoked);

    for (const entry of params.envKeys) {
      if (revoked.has(entry.name)) continue;
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      out.push({ name: entry.name, key: entry.key, createdAt: '(env)', source: 'env' });
    }
    for (const entry of file.keys) {
      if (revoked.has(entry.name)) continue;
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      out.push({ ...entry, source: 'file' });
    }
    return out;
  };

  const persist = async (next: ApiKeyFile): Promise<void> => {
    if (!filePath) {
      throw new DomainError(
        'api keys file not configured (set API_KEYS_PATH to enable self-serve add/revoke)',
        409,
        'no_keystore_file',
      );
    }
    await writeAtomic(filePath, next);
    file = next;
  };

  return Object.freeze({
    list: compose,
    async add(name: string, providedKey?: string): Promise<ApiKeyRecord> {
      if (name.length === 0 || /\s|,|:/.test(name)) {
        throw new DomainError(
          'name must be non-empty and contain no whitespace/colon/comma',
          400,
          'invalid_name',
        );
      }
      const existing = compose().find((e) => e.name === name);
      if (existing) {
        throw new DomainError(`key "${name}" already exists`, 409, 'key_exists');
      }
      const key = providedKey ?? generateKey();
      if (key.length < MIN_KEY_LENGTH) {
        throw new DomainError(`key must be at least ${MIN_KEY_LENGTH} chars`, 400, 'key_too_short');
      }
      const createdAt = new Date().toISOString();
      const next: ApiKeyFile = {
        keys: [...file.keys, { name, key, createdAt }],
        revoked: file.revoked.filter((r) => r !== name),
      };
      await persist(next);
      return { name, key, createdAt, source: 'file' };
    },
    async revoke(name: string): Promise<boolean> {
      const present = compose().some((e) => e.name === name);
      if (!present) return false;
      // Drop from file.keys if present and add to revoked (covers env-baked keys).
      const next: ApiKeyFile = {
        keys: file.keys.filter((k) => k.name !== name),
        revoked: file.revoked.includes(name) ? file.revoked : [...file.revoked, name],
      };
      await persist(next);
      return true;
    },
    isRevoked(name: string): boolean {
      return file.revoked.includes(name);
    },
  });
};
