import type { Context } from 'hono';
import type { ApiKeyStore } from '../auth/api-key-store.js';
import { DomainError } from '../lib/errors.js';

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
      })),
    });
  },

  async create(c) {
    const body = (await c.req.json().catch(() => null)) as
      | { name?: unknown; key?: unknown }
      | null;
    if (!body || typeof body.name !== 'string') {
      throw new DomainError('body must be { name: string, key?: string }', 400, 'invalid_request');
    }
    const providedKey = typeof body.key === 'string' ? body.key : undefined;
    const created = await store.add(body.name, providedKey);
    // Return the full key ONCE so the operator can hand it to the user.
    return c.json({
      name: created.name,
      key: created.key,
      createdAt: created.createdAt,
      note: 'Store this value securely — it will not be shown again.',
    });
  },

  async revoke(c) {
    const name = c.req.param('name');
    if (!name) {
      throw new DomainError('missing name path parameter', 400, 'invalid_request');
    }
    const ok = await store.revoke(name);
    if (!ok) {
      throw new DomainError(`key "${name}" not found`, 404, 'not_found');
    }
    return c.json({ revoked: name });
  },
});
