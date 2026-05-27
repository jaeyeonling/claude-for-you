import type { Context } from 'hono';
import type { ApiKeyStore } from '../auth/api-key-store.js';
import { InvalidRequest, NotFound } from '../lib/errors.js';

/**
 * Phase 20c — admin key management.
 *
 * Three endpoints:
 *   GET    /admin/keys           → list (env + file, revoke set applied)
 *   POST   /admin/keys           → add a key. body: { "name": "alice", "key"?: "..." }
 *   DELETE /admin/keys/:name     → revoke (works for both env and file sources)
 *
 * The key value is returned once (on create) and never persisted elsewhere
 * we can show it. Operator copies it to the user. Lost = revoke + regenerate.
 */

export const createKeysHandlers = (store: ApiKeyStore): {
  list: (c: Context) => Response;
  create: (c: Context) => Promise<Response>;
  revoke: (c: Context) => Promise<Response>;
} => ({
  list(c) {
    const entries = store.list();
    return c.json({
      keys: entries.map((e) => ({
        name: e.name,
        source: e.source,
        createdAt: e.createdAt,
        // Never return the raw key value on list — it was already shown
        // once at creation. Show a fingerprint for operator recognition.
        keyPreview: `${e.key.slice(0, 4)}…${e.key.slice(-4)}`,
        allowedModels: e.allowedModels ?? null,
      })),
    });
  },

  async create(c) {
    // Accept JSON (programmatic / curl) and form-urlencoded (admin UI form).
    // For form input, allowedModels arrives as a single comma-or-whitespace
    // separated string: "claude-haiku-*, claude-sonnet-4-6".
    const contentType = c.req.header('content-type') ?? '';
    let name: unknown;
    let providedKey: string | undefined;
    let allowedModels: readonly string[] | undefined;

    if (contentType.includes('application/json')) {
      const body = (await c.req.json().catch(() => null)) as
        | { name?: unknown; key?: unknown; allowedModels?: unknown }
        | null;
      if (!body) throw InvalidRequest('body must be JSON');
      name = body.name;
      providedKey = typeof body.key === 'string' ? body.key : undefined;
      if (Array.isArray(body.allowedModels)) {
        const bad = body.allowedModels.find((m) => typeof m !== 'string');
        if (bad !== undefined) {
          throw InvalidRequest('allowedModels must be an array of strings');
        }
        allowedModels = body.allowedModels.length > 0
          ? (body.allowedModels as readonly string[])
          : undefined;
      }
    } else {
      const form = await c.req.formData();
      name = form.get('name');
      const keyRaw = form.get('key');
      providedKey = typeof keyRaw === 'string' && keyRaw.length > 0 ? keyRaw : undefined;
      const modelsRaw = form.get('allowedModels');
      if (typeof modelsRaw === 'string' && modelsRaw.trim().length > 0) {
        const parsed = modelsRaw
          .split(/[\s,]+/)
          .map((s) => s.trim())
          .filter(Boolean);
        if (parsed.length > 0) allowedModels = parsed;
      }
    }

    if (typeof name !== 'string') {
      throw InvalidRequest(
        'body must be { name: string, key?: string, allowedModels?: string[] | "a,b" }',
      );
    }
    const opts: { providedKey?: string; allowedModels?: readonly string[] } = {};
    if (providedKey !== undefined) opts.providedKey = providedKey;
    if (allowedModels !== undefined) opts.allowedModels = allowedModels;
    const created = await store.add(name, opts);
    // Return the full key ONCE so the operator can hand it to the user.
    return c.json({
      name: created.name,
      key: created.key,
      createdAt: created.createdAt,
      allowedModels: created.allowedModels ?? null,
      note: 'Store this value securely — it will not be shown again.',
    });
  },

  async revoke(c) {
    const name = c.req.param('name');
    if (!name) {
      throw InvalidRequest('missing name path parameter');
    }
    const ok = await store.revoke(name);
    if (!ok) {
      throw NotFound(`key "${name}" not found`);
    }
    return c.json({ revoked: name });
  },
});
