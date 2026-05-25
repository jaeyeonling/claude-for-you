import type { Context } from 'hono';
import { existsSync } from 'node:fs';
import { rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Conflict } from '../lib/errors.js';

/**
 * Phase 20d — snapshot promote/rollback admin endpoints.
 *
 * Operations on `cc-snapshot.candidate.json` next to the live snapshot:
 *   POST /admin/snapshot/promote   → candidate → cc-snapshot.json (overwrites)
 *   POST /admin/snapshot/rollback  → delete candidate
 *
 * The server reads snapshot files at startup (module-level). Both operations
 * therefore return `{ restartRequired: true }` so the operator knows to
 * `docker compose restart app`. We don't auto-restart because some in-flight
 * requests may be mid-flight; the operator controls drain timing.
 */

// Resolve from the same path conventions used by template/extracted.ts.
// We import the path constants implicitly — both files use dirname(import.meta.url)
// relative to src/template/, so we redo the same resolution here.
const TEMPLATE_DIR = (): string => {
  // Resolve at call time so tests can override via cwd if needed.
  const here = dirname(fileURLToPath(import.meta.url)); // .../src/admin
  return join(here, '..', 'template');
};

const stablePath = (): string => join(TEMPLATE_DIR(), 'cc-snapshot.json');
const candidatePath = (): string => join(TEMPLATE_DIR(), 'cc-snapshot.candidate.json');

export const createSnapshotHandlers = (): {
  promote: (c: Context) => Promise<Response>;
  rollback: (c: Context) => Promise<Response>;
  status: (c: Context) => Response;
} => ({
  status(c) {
    return c.json({
      stable: { path: stablePath(), exists: existsSync(stablePath()) },
      candidate: { path: candidatePath(), exists: existsSync(candidatePath()) },
    });
  },

  async promote(_c) {
    const cand = candidatePath();
    if (!existsSync(cand)) {
      throw Conflict('no candidate snapshot to promote', 'no_candidate');
    }
    await rename(cand, stablePath());
    return Response.json({
      promoted: true,
      restartRequired: true,
      hint: 'run `docker compose restart app` to load the new stable snapshot',
    });
  },

  async rollback(_c) {
    const cand = candidatePath();
    if (!existsSync(cand)) {
      throw Conflict('no candidate snapshot to rollback', 'no_candidate');
    }
    await unlink(cand);
    return Response.json({
      rolledBack: true,
      restartRequired: true,
      hint: 'run `docker compose restart app` to re-disable canary cleanly',
    });
  },
});
