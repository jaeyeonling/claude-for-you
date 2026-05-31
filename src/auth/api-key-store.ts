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
 * Per-key cap on `allowedModels` entries. PR #23 capped each pattern's
 * length (`MAX_MODEL_PATTERN_LENGTH = 128`) but the array itself was
 * unbounded — an authenticated admin (or a compromised session) could
 * install 100k patterns and every authenticated request would then iterate
 * them via `isModelAllowed`'s `patterns.some(...)` on the hot auth path.
 *
 * 50 sits at ~2.5× the realistic ceiling (Anthropic currently runs ~6 model
 * families × wildcards × occasional dated pins ≈ 20 patterns to cover
 * everything an operator might want). Revisit if (a) Anthropic ships a new
 * generation that pushes the realistic max past ~30, or (b) admin logs show
 * legitimate `allowed_models_too_many` rejections.
 *
 * Migration: the cap is enforced at WRITE only (`add` / `update`). Existing
 * `api-keys.json` rows that already exceed it continue to load — see
 * `loadFile` for the boot-time warning that surfaces them to the operator.
 * This keeps an upgrade from crash-looping any legacy deployment.
 */
export const MAX_ALLOWED_MODELS_PER_KEY = 50;

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
    // Validate per-entry allowedModels shape. We separate two cases here:
    //
    // 1. MALFORMED (not array, not undefined): fail-fast with ConfigError.
    //    isModelAllowed calls `.some()` on the value at request time, which
    //    would TypeError on a string or array-like object and crash every
    //    authenticated request for this key. Better to crash at boot than
    //    to mask the file corruption until the next auth attempt.
    //
    // 2. OVERSIZED (array > cap): warn and keep as-is. PR #23/#24 added the
    //    cap; pre-existing rows that exceed it stay loaded so an upgrade
    //    never crash-loops a legacy deployment. New writes still enforce.
    for (const entry of parsed.keys) {
      const allowed = entry.allowedModels;
      if (allowed !== undefined && !Array.isArray(allowed)) {
        throw new Error(
          `entry "${entry.name}" has allowedModels of type ${typeof allowed} ` +
            `(expected array or absent) — fix the file before restart`,
        );
      }
      if (Array.isArray(allowed) && allowed.length > MAX_ALLOWED_MODELS_PER_KEY) {
        // JSON.stringify on the name escapes embedded quotes / newlines /
        // controls so a malicious file edit (`name: "alice\nFAKE: ..."`)
        // can't forge log lines. It already wraps the value in quotes — no
        // outer quotes needed in the template.
        console.warn(
          `[api-key] entry ${JSON.stringify(entry.name)} has ${allowed.length} ` +
            `allowedModels (cap=${MAX_ALLOWED_MODELS_PER_KEY}) — predates the cap, ` +
            `kept as-is. To trim: PATCH /admin/keys/<name> with a ≤${MAX_ALLOWED_MODELS_PER_KEY}-` +
            `entry allowedModels array, or revoke + re-issue via POST /admin/keys.`,
        );
      }
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
  // The chain shape needs three properties, each driven by a specific line:
  //
  //   1. `writeLock.then(fn, fn)` — `fn` runs whether the previous link
  //      resolved OR rejected. Passing `fn` as both arguments means a
  //      throwing mutator does not stall later writers behind a pending
  //      rejection; the queue keeps moving.
  //
  //   2. `writeLock = next.catch(() => undefined)` — we MUST store the
  //      caught version, not `next` itself. If `next` is stored and rejects,
  //      every later `writeLock.then(fn, fn)` resolves the second handler
  //      with the *same* rejection reason, propagating it forever and
  //      effectively poisoning the chain head. The `.catch()` swallows the
  //      rejection only for the lock-tracking reference; `return next` still
  //      surfaces it to the original caller.
  //
  //   3. `return next` — the caller observes the real result of their fn,
  //      including any throw. The lock-tracking promise is separate.
  //
  // Removing the `.catch()` looks innocent ("we already return next") but
  // breaks the chain on the first rejection. Don't.
  //
  // `MAX_WRITE_QUEUE_DEPTH` caps the unbounded-queue DoS surface flagged by
  // the Adversary persona on the issue #14 review. An authenticated admin
  // can otherwise fire PATCH/POST/DELETE in a tight loop and grow the
  // promise chain (each link holds a `file` snapshot in its closure)
  // without bound. 100 is sized for the realistic single-operator-plus-
  // some-scripts workload — bursts that would legitimately exceed it
  // suggest a stuck disk or a misconfigured client.
  const MAX_WRITE_QUEUE_DEPTH = 100;
  let writeLock: Promise<unknown> = Promise.resolve();
  let queueDepth = 0;
  const withWriteLock = <T>(fn: () => Promise<T>): Promise<T> => {
    if (queueDepth >= MAX_WRITE_QUEUE_DEPTH) {
      return Promise.reject(
        Conflict(
          `write queue full (${MAX_WRITE_QUEUE_DEPTH} pending) — retry shortly`,
          'write_queue_full',
        ),
      );
    }
    queueDepth++;
    // Wrap fn so the decrement runs *inside* the same chain link as fn
    // itself — i.e. before `next` resolves. Putting the decrement on
    // `next.finally(...)` defers it by one microtask: a caller that does
    // `await withWriteLock(a); withWriteLock(b)` would then see `queueDepth`
    // still incremented for `a` when `b` runs its cap check, producing a
    // spurious `write_queue_full` on perfectly serial usage.
    // Wrapping pulls the bookkeeping back into the lock-held critical
    // section, which is the only way to keep `queueDepth` consistent with
    // what callers observe.
    const wrapped = async (): Promise<T> => {
      try {
        return await fn();
      } finally {
        queueDepth--;
      }
    };
    const next = writeLock.then(wrapped, wrapped);
    // We MUST store the caught variant — not `next` itself. If `next` is
    // stored and rejects, every later `writeLock.then(fn, fn)` resolves the
    // second handler with that same rejection reason, propagating it forever
    // and poisoning the chain head. The `.catch()` swallows the rejection
    // only for the lock-tracking reference; `return next` still surfaces it
    // to the original caller.
    //
    // Don't simplify this to `void next.finally(...)`: that spawns a
    // *separate* promise whose rejection (when fn throws) becomes unhandled,
    // and Bun/Node mark unhandled rejections as test failures.
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

  // Invariant: `file = next` happens *after* `writeAtomic` resolves, so if
  // the disk write throws (ENOSPC, EACCES, etc.) the in-memory `file` is
  // left untouched — the mutator throws and the next read still sees the
  // previous committed state. There is no explicit rollback because there
  // is nothing to roll back. Anyone adding retry/recovery logic must
  // preserve this property: a failed persist must NOT leave `file` updated.
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
      // ───────────────────────────────────────────────────────────────────
      // Validation placement rule (applies to add/update/revoke):
      //
      //   - PRE-LOCK if the check depends only on the inputs themselves —
      //     name/key/pattern shape, length, character set. Fail fast and
      //     don't park bad input behind the write queue.
      //
      //   - INSIDE LOCK if the check depends on the in-flight result of
      //     other writers — uniqueness, existence, revoke-list membership,
      //     env-baked-name collision. Two requests can both pass a pre-lock
      //     "no such name" check; only a lock-internal re-check is sound.
      //
      // When in doubt: ask "could a concurrent writer change the answer
      // between my check and my persist?" If yes, it belongs in the lock.
      // ───────────────────────────────────────────────────────────────────
      assertValidName(name);
      const key = options?.providedKey ?? generateKey();
      if (key.length < MIN_KEY_LENGTH) {
        throw InvalidRequest(`key must be at least ${MIN_KEY_LENGTH} chars`, 'key_too_short');
      }
      // Same TOCTOU snapshot pattern as update(): caller could mutate
      // options.allowedModels between submission and lock granting. Shallow
      // copy is enough because the elements are string primitives.
      const capturedAllowed: readonly string[] | undefined = options?.allowedModels
        ? [...options.allowedModels]
        : undefined;
      if (capturedAllowed) {
        if (capturedAllowed.length > MAX_ALLOWED_MODELS_PER_KEY) {
          throw InvalidRequest(
            `allowedModels too many entries (${capturedAllowed.length} > ${MAX_ALLOWED_MODELS_PER_KEY})`,
            'allowed_models_too_many',
          );
        }
        try {
          for (const p of capturedAllowed) assertValidModelPattern(p);
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
        const fileEntry: ApiKeyFile['keys'][number] = capturedAllowed
          ? { name, key, createdAt, allowedModels: capturedAllowed }
          : { name, key, createdAt };
        const next: ApiKeyFile = {
          keys: [...file.keys, fileEntry],
          revoked: file.revoked.filter((r) => r !== name),
        };
        await persist(next);
        const record: ApiKeyRecord = capturedAllowed
          ? { name, key, createdAt, source: 'file', role: 'user', allowedModels: capturedAllowed }
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

      // Placement rule: see add() above.
      //
      // Pre-lock validation + TOCTOU snapshot. `ApiKeyPatch`'s `readonly` is
      // a compile-time hint, not a runtime guarantee — a caller could mutate
      // the patch object between submitting the request and the lock
      // granting it. To make the validate-then-use sequence safe we capture
      // each patched field into a local *here*, validate the local, and use
      // *only* the local inside the lock. `patch` itself is never read
      // again after this point.
      assertValidName(name);
      const targetName = name;

      // Plain capture: primitive string copy by value, safe against any
      // later mutation of `patch.newName` (including via a Proxy getter).
      const patchedNewName = patch.newName;
      if (patchedNewName !== undefined && patchedNewName !== targetName) {
        assertValidName(patchedNewName);
      }

      // Three-way snapshot for allowedModels:
      //   undefined → "don't touch this field"
      //   null      → "drop the restriction" (no allowedModels stored)
      //   array     → shallow-copy so caller's later .push() cannot leak
      //               into the lock-internal `nextAllowed` reference. Items
      //               are strings (primitives), so a shallow copy is enough.
      let patchedAllowed: readonly string[] | null | undefined;
      if (patch.allowedModels === undefined) {
        patchedAllowed = undefined;
      } else if (patch.allowedModels === null) {
        patchedAllowed = null;
      } else {
        patchedAllowed = [...patch.allowedModels];
      }

      // Rename-only PATCHes (patchedAllowed === undefined) skip this block
      // entirely — they inherit current.allowedModels. The post-lock cap
      // re-check below catches the case where a legacy oversized array rides
      // through that inheritance path. Don't try to merge the two guards
      // into one: they verify different things (payload validity vs final
      // persisted state) and only one of them has the current row in scope.
      if (
        patchedAllowed !== undefined &&
        patchedAllowed !== null &&
        patchedAllowed.length > 0
      ) {
        if (patchedAllowed.length > MAX_ALLOWED_MODELS_PER_KEY) {
          throw InvalidRequest(
            `allowedModels too many entries (${patchedAllowed.length} > ${MAX_ALLOWED_MODELS_PER_KEY})`,
            'allowed_models_too_many',
          );
        }
        try {
          for (const p of patchedAllowed) assertValidModelPattern(p);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          throw InvalidRequest(msg, 'invalid_model_pattern');
        }
      }

      return withWriteLock(async () => {
        // From here on, only the captured locals (`targetName`,
        // `patchedNewName`, `patchedAllowed`) are read — never `patch.*`.
        if (file.revoked.includes(targetName)) {
          throw Conflict(
            `key "${targetName}" is revoked — restore it before editing`,
            'key_revoked',
          );
        }
        if (params.envKeys.some((e) => e.name === targetName)) {
          throw InvalidRequest(
            `key "${targetName}" is env-baked and cannot be updated via the keystore file ` +
              `— change API_KEYS env and redeploy instead`,
            'env_source_immutable',
          );
        }
        const idx = file.keys.findIndex((e) => e.name === targetName);
        if (idx === -1) {
          throw NotFound(`key "${targetName}" not found`, 'key_not_found');
        }
        const current = file.keys[idx]!;

        let nextName = current.name;
        if (patchedNewName !== undefined && patchedNewName !== current.name) {
          if (file.revoked.includes(patchedNewName)) {
            throw Conflict(
              `name "${patchedNewName}" is in revoke list — pick another name or ` +
                `restore the revoked entry first`,
              'name_in_revoke_list',
            );
          }
          const collidesEnv = params.envKeys.some((e) => e.name === patchedNewName);
          const collidesFile = file.keys.some(
            (e, i) => i !== idx && e.name === patchedNewName,
          );
          if (collidesEnv || collidesFile) {
            throw Conflict(`key "${patchedNewName}" already exists`, 'name_conflict');
          }
          nextName = patchedNewName;
        }

        let nextAllowed: readonly string[] | undefined = current.allowedModels;
        if (patchedAllowed !== undefined) {
          if (patchedAllowed === null || patchedAllowed.length === 0) {
            // Empty list and explicit null both mean "drop the restriction" —
            // we never persist an empty allowedModels array (it would be
            // unmatchable and lock the user out of every model).
            nextAllowed = undefined;
          } else {
            nextAllowed = patchedAllowed;
          }
        }

        // No-op fast path: if neither name nor allowedModels actually changed,
        // skip the disk write entirely. Empty patches are common when the form
        // is submitted without modifications, and a no-op write would only add
        // contention on the keystore file.
        //
        // Ordered comparison is intentional: ['claude-haiku-*','claude-sonnet-*']
        // and ['claude-sonnet-*','claude-haiku-*'] differ at request time because
        // isModelAllowed (src/auth/model-allow.ts) runs `.some()` top-down. The
        // matcher there iterates patterns in array order via `.some()`, so two
        // arrays with identical contents but different ordering are NOT
        // equivalent at request time. If anyone ever switches this comparison
        // to set-equality (`new Set(...)` etc.), `isModelAllowed` must change
        // first — otherwise this fast path silently drops legitimate reorders.
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

        // Final-state cap re-check. The pre-lock check on `patchedAllowed`
        // catches explicit re-supply, but a rename-only PATCH that omits
        // allowedModels would otherwise inherit `current.allowedModels`
        // verbatim — including a legacy oversized array that pre-dated the
        // cap. The migration policy is "lenient at read, strict at write":
        // any write that re-persists the row must satisfy the cap, even if
        // the over-cap array came from disk rather than the patch payload.
        // No-op fast path above already returned, so we know we're writing.
        //
        // Message is intentionally verbose (vs the terse pre-lock variant)
        // because the operator most likely sent a rename-only PATCH and is
        // surprised to see an allowedModels error — they need the context
        // ("we re-persist on rename, current row is legacy oversized") and
        // the actionable resolution ("send allowedModels in this PATCH") to
        // unblock without reading source.
        if (nextAllowed && nextAllowed.length > MAX_ALLOWED_MODELS_PER_KEY) {
          throw InvalidRequest(
            `cannot persist this PATCH: the row's existing allowedModels has ` +
              `${nextAllowed.length} entries (cap=${MAX_ALLOWED_MODELS_PER_KEY}). ` +
              `A rename or any other field-change re-persists the whole row, ` +
              `so the over-cap array must be trimmed at the same time. ` +
              `Include allowedModels (≤${MAX_ALLOWED_MODELS_PER_KEY} entries) ` +
              `in this PATCH to clear the legacy bloat in one call.`,
            'allowed_models_too_many',
          );
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
      // Placement rule: see add() above. Name-shape validation is input-
      // only, so it stays pre-lock; the existence check has to live inside
      // the lock to handle a concurrent add/update of the same name.
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
