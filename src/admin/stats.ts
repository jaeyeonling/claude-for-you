import type { Context } from 'hono';
import type { AccountLearner } from '../account-learner.js';
import type { AccountPool } from '../auth/account-pool.js';
import type { CanaryController } from '../canary.js';
import type { BillingMonitor } from '../usage/billing-monitor.js';
import type { GlobalGuard } from '../usage/global.js';
import type { UsageTracker } from '../usage/per-user.js';
import { attempt } from '../lib/degrade.js';

export interface AdminStatsDeps {
  readonly pool: AccountPool;
  readonly tracker: UsageTracker;
  readonly globalGuard: GlobalGuard;
  readonly billingMonitor: BillingMonitor;
  readonly accountLearner: AccountLearner;
  readonly canary: CanaryController;
  readonly candidateDescription: string | null;
  readonly startedAt: number;
  readonly templateDescription: string;
}

export const createStatsHandler =
  (deps: AdminStatsDeps) =>
  async (c: Context): Promise<Response> => {
    const billingSnap = deps.billingMonitor.snapshot();
    const guardSnap = deps.globalGuard.snapshot();
    const usageSnap = await attempt('usage-snapshot', () => deps.tracker.snapshot());
    const canarySnap = deps.canary.snapshot();
    const poolSnap = deps.pool.snapshot();

    const payload = {
      server: {
        uptimeSec: Math.floor((Date.now() - deps.startedAt) / 1000),
        runtime: `bun ${Bun.version}`,
        template: deps.templateDescription,
      },
      accountPool: {
        members: poolSnap.members,
        sessionAssignments: poolSnap.sessionAssignments,
      },
      billing: {
        lastObservation: billingSnap.lastObservation,
        nonStandardCount: billingSnap.nonStandardCount,
        lastAlarmAt: billingSnap.lastAlarmAt,
      },
      subscriptionHeadroom: {
        remainingTokens: guardSnap.remaining,
        observedAt: guardSnap.observedAt,
      },
      accountLearner: {
        currentOrgId: deps.accountLearner.current(),
      },
      canary: {
        active: canarySnap.active,
        percent: canarySnap.percent,
        tripped: canarySnap.tripped,
        trippedAt: canarySnap.trippedAt,
        trippedReason: canarySnap.trippedReason,
        candidateRequests: canarySnap.candidateRequests,
        stableRequests: canarySnap.stableRequests,
        candidateDescription: deps.candidateDescription,
      },
      // Contract note: `perUserUsage` stays the same shape on the happy path.
      // On a DB failure it becomes null and the dependency name appears in
      // `degraded` — an additive change, so existing consumers that read
      // `perUserUsage` keep working (they see null instead of a 500 body).
      perUserUsage: usageSnap.ok ? usageSnap.value : null,
      degraded: usageSnap.ok ? [] : [{ dependency: 'perUserUsage', reason: usageSnap.reason }],
    };

    return c.json(payload);
  };
