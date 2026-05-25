import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AccountLearner } from '../account-learner.js';
import type { AccountPool } from '../auth/account-pool.js';
import type { ApiKeyStore } from '../auth/api-key-store.js';
import type { AlertStore } from '../alerts-store.js';
import type { CanaryController } from '../canary.js';
import type { BillingMonitor } from '../usage/billing-monitor.js';
import type { GlobalGuard } from '../usage/global.js';
import type { UsageTracker } from '../usage/per-user.js';
import { renderLiveSections } from './render.js';

/**
 * GET /admin/events — Server-Sent Events stream that pushes a fresh
 * `<live-region>` HTML fragment every 2 seconds. The admin page's inline
 * client script replaces only the live region, leaving the form sections
 * (OAuth paste, webhook paste) untouched. This eliminates the previous
 * `<meta http-equiv="refresh">` flicker AND protects in-progress paste.
 *
 * Connection lifecycle:
 *   - Per-client interval; closes when the browser disconnects (streamSSE
 *     surfaces that via the stream's abort signal).
 *   - EventSource auto-reconnects on transient failure; we don't ship custom
 *     reconnect logic on the server side.
 */

const CANDIDATE_SNAPSHOT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'template',
  'cc-snapshot.candidate.json',
);

const TICK_MS = 2_000;

export interface AdminEventsDeps {
  readonly pool: AccountPool;
  readonly tracker: UsageTracker;
  readonly globalGuard: GlobalGuard;
  readonly billingMonitor: BillingMonitor;
  readonly accountLearner: AccountLearner;
  readonly canary: CanaryController;
  readonly apiKeyStore: ApiKeyStore;
  readonly alertStore: AlertStore;
  readonly candidateDescription: string | null;
  readonly startedAt: number;
  readonly templateDescription: string;
}

export const createAdminEventsHandler =
  (deps: AdminEventsDeps) =>
  (c: Context): Response | Promise<Response> => {
    return streamSSE(c, async (stream) => {
      while (!stream.aborted && !stream.closed) {
        const uptimeSec = Math.floor((Date.now() - deps.startedAt) / 1000);
        const snapshot = {
          poolSnap: deps.pool.snapshot(),
          billingSnap: deps.billingMonitor.snapshot(),
          guardSnap: deps.globalGuard.snapshot(),
          usageSnap: await deps.tracker.snapshot(),
          canarySnap: deps.canary.snapshot(),
          alertConfig: deps.alertStore.get(),
          apiKeyRows: deps.apiKeyStore.list().map((e) => ({
            name: e.name,
            source: e.source,
            key: e.key,
            createdAt: e.createdAt,
          })),
          orgId: deps.accountLearner.current(),
          candidateDescription: deps.candidateDescription,
          candidateSnapshotPresent: existsSync(CANDIDATE_SNAPSHOT_PATH),
          templateDescription: deps.templateDescription,
          bunVersion: Bun.version,
          uptimeSec,
          now: new Date(),
        };
        const html = renderLiveSections(snapshot);
        await stream.writeSSE({ data: JSON.stringify({ html }) });
        await stream.sleep(TICK_MS);
      }
    });
  };
