import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from 'hono';
import type { AccountLearner } from '../account-learner.js';
import type { AccountPool } from '../auth/account-pool.js';
import type { ApiKeyStore } from '../auth/api-key-store.js';
import type { CanaryController } from '../canary.js';
import type { AlertStore } from '../alerts-store.js';
import type { BillingMonitor } from '../usage/billing-monitor.js';
import type { GlobalGuard } from '../usage/global.js';
import type { UsageTracker } from '../usage/per-user.js';
import { renderAdminHtml } from './render.js';
import type { TestResultStore } from './test-runners.js';

const CANDIDATE_SNAPSHOT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'template',
  'cc-snapshot.candidate.json',
);

export interface AdminPageDeps {
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
  readonly testResultStore: TestResultStore;
}

/**
 * Handler is a thin orchestrator — fetches every snapshot, then hands them
 * to `renderAdminHtml` (a pure function in `./render.ts`). The split makes
 * the HTML output independently testable without spinning up the proxy.
 */
export const createAdminPageHandler =
  (deps: AdminPageDeps) =>
  async (c: Context): Promise<Response> => {
    const uptimeSec = Math.floor((Date.now() - deps.startedAt) / 1000);
    const html = renderAdminHtml({
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
      testResults: deps.testResultStore.latest(),
    });
    return c.html(html);
  };
