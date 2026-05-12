import type { Context } from 'hono';
import type { AccountLearner } from '../account-learner.js';
import type { AccountPool } from '../auth/account-pool.js';
import type { CanaryController } from '../canary.js';
import type { BillingMonitor } from '../usage/billing-monitor.js';
import type { GlobalGuard } from '../usage/global.js';
import type { UsageTracker } from '../usage/per-user.js';

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
    const usageSnap = await deps.tracker.snapshot();
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
      perUserUsage: usageSnap,
    };

    return c.json(payload);
  };
