import type { Context } from 'hono';
import type { ApiKeyPatch, ApiKeyStore } from '../auth/api-key-store.js';
import { InvalidRequest, NotFound } from '../lib/errors.js';

/**
 * Phase 20c — admin key management.
 *
 * Endpoints:
 *   GET    /admin/keys              → list (env + file, revoke set applied)
 *   POST   /admin/keys              → add a key. body: { name, key?, allowedModels? }
 *   PATCH  /admin/keys/:name        → update name/allowedModels (file source only)
 *   DELETE /admin/keys/:name        → revoke (works for both env and file sources)
 *
 * The key value is returned once (on create) and never persisted elsewhere
 * we can show it. Operator copies it to the user. Lost = revoke + regenerate.
 *
 * Response-shape convention (read this before adding a new write endpoint):
 *   - create  → returns the secret-once payload as itself ({ name, key, ... }).
 *               No `kind` marker — `key` field is the unmistakable discriminator.
 *   - revoke  → returns { revoked: name }. The `revoked` field IS the marker.
 *   - update  → returns { kind: 'updated', name, createdAt, allowedModels }.
 *               No natural discriminator (no secret to leak, no destructive verb
 *               in the body), so an explicit `kind` string is required.
 *
 *   Rule of thumb: if the response body has no field whose presence/absence is
 *   inherently meaningful (`key`, `revoked`, etc.), add an explicit `kind`
 *   discriminator. The admin UI's paintResult branches on these — see
 *   src/admin/render.ts. Future write endpoints should follow this pattern.
 */

export const createKeysHandlers = (store: ApiKeyStore): {
  list: (c: Context) => Response;
  create: (c: Context) => Promise<Response>;
  update: (c: Context) => Promise<Response>;
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

  async update(c) {
    // Path-based for PATCH and the form-friendly POST /admin/keys/:name/update.
    // The admin UI's "edit api key" form rewrites action to include :name so
    // a single handler covers both JSON and form-urlencoded callers.
    const name = c.req.param('name');
    if (!name) {
      throw InvalidRequest('missing name path parameter');
    }

    const patch: { newName?: string; allowedModels?: readonly string[] | null } = {};
    const contentType = c.req.header('content-type') ?? '';

    if (contentType.includes('application/json')) {
      const body = (await c.req.json().catch(() => null)) as
        | { name?: unknown; allowedModels?: unknown }
        | null;
      if (!body) throw InvalidRequest('body must be JSON');
      if (body.name !== undefined) {
        if (typeof body.name !== 'string') {
          throw InvalidRequest('name must be a string');
        }
        patch.newName = body.name;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'allowedModels')) {
        if (body.allowedModels === null) {
          patch.allowedModels = null;
        } else if (Array.isArray(body.allowedModels)) {
          const bad = body.allowedModels.find((m) => typeof m !== 'string');
          if (bad !== undefined) {
            throw InvalidRequest('allowedModels must be an array of strings or null');
          }
          patch.allowedModels = body.allowedModels as readonly string[];
        } else {
          throw InvalidRequest('allowedModels must be an array of strings or null');
        }
      }
    } else {
      // Form encoding: an input that's present but empty means "clear" for
      // allowedModels (the operator explicitly wants no restriction). For
      // `name`, an empty value is treated as "keep current" — renaming to
      // empty is meaningless and would fail validation anyway.
      //
      // Why `form.has()` here but not in create(): create's allowedModels is
      // optional from the start, so absence and emptiness both mean "no
      // restriction". update() needs to distinguish "operator left this
      // field alone" (keep current) from "operator cleared this field"
      // (drop restriction) — and only `form.has()` can tell them apart for
      // form-urlencoded bodies.
      const form = await c.req.formData();
      const nameRaw = form.get('name');
      if (typeof nameRaw === 'string' && nameRaw.length > 0 && nameRaw !== name) {
        patch.newName = nameRaw;
      }
      if (form.has('allowedModels')) {
        const modelsRaw = form.get('allowedModels');
        if (typeof modelsRaw === 'string') {
          const parsed = modelsRaw
            .split(/[\s,]+/)
            .map((s) => s.trim())
            .filter(Boolean);
          patch.allowedModels = parsed.length > 0 ? parsed : null;
        }
      }
    }

    const updated = await store.update(name, patch satisfies ApiKeyPatch);
    // `kind: 'updated'` is an explicit response-shape marker so the admin
    // UI's paintResult can branch on it without resorting to negative
    // conditions like "has name but no key". Keeps the contract durable
    // even if we add fields here later.
    return c.json({
      kind: 'updated' as const,
      name: updated.name,
      createdAt: updated.createdAt,
      allowedModels: updated.allowedModels ?? null,
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
