/**
 * Phase 28 — canary deploy for snapshot A/B.
 *
 * Lets the operator drop a `cc-snapshot.candidate.json` next to the live
 * snapshot. When `CANARY_PERCENT > 0` and the candidate file is present,
 * roughly N% of outbound traffic is routed through the candidate template
 * while the rest stays on the stable snapshot. Any service_tier alarm in
 * the candidate window auto-trips the canary (subsequent requests skip
 * candidate until operator explicitly resets).
 *
 * Why automatic trip — a bad snapshot starts charging money in real time.
 * Failing closed is the only safe default.
 *
 * Operator workflow:
 *   1. cron-capture lands a new src/template/cc-snapshot.candidate.json
 *   2. operator commits + deploys with CANARY_PERCENT=5
 *   3. monitor /admin or Discord channel for a few hours
 *   4. promote: rename candidate -> cc-snapshot.json, redeploy
 *   5. rollback: delete candidate, redeploy
 */

import { log } from './lib/logger.js';
import type { ClaudeTemplate } from './template/types.js';

export type CanaryDecision = Readonly<{
  useCandidate: boolean;
  reason: 'no-candidate' | 'disabled' | 'tripped' | 'random-stable' | 'random-candidate';
}>;

export type CanaryStats = Readonly<{
  active: boolean;
  percent: number;
  tripped: boolean;
  trippedAt: number | null;
  trippedReason: string | null;
  candidateRequests: number;
  stableRequests: number;
}>;

export type CanaryController = Readonly<{
  /** Returns whether this request should use the candidate template. */
  decide(): CanaryDecision;
  /** Called when a request finishes — used to gate stats. */
  recordRequest(usedCandidate: boolean): void;
  /** Manually trip (called by billing-monitor on candidate-side alarm). */
  trip(reason: string): void;
  /** Operator manual reset via admin / restart. */
  reset(): void;
  snapshot(): CanaryStats;
}>;

export const createCanaryController = (params: {
  candidate: ClaudeTemplate | null;
  percent: number;
}): CanaryController => {
  const active = params.candidate !== null && params.percent > 0;
  const percent = Math.min(Math.max(0, params.percent), 100);
  let tripped = false;
  let trippedAt: number | null = null;
  let trippedReason: string | null = null;
  let candidateRequests = 0;
  let stableRequests = 0;

  return Object.freeze({
    decide(): CanaryDecision {
      if (!params.candidate) return { useCandidate: false, reason: 'no-candidate' };
      if (!active || percent === 0) return { useCandidate: false, reason: 'disabled' };
      if (tripped) return { useCandidate: false, reason: 'tripped' };
      const roll = Math.random() * 100;
      if (roll < percent) return { useCandidate: true, reason: 'random-candidate' };
      return { useCandidate: false, reason: 'random-stable' };
    },

    recordRequest(usedCandidate: boolean): void {
      if (usedCandidate) candidateRequests += 1;
      else stableRequests += 1;
    },

    trip(reason: string): void {
      if (tripped) return;
      tripped = true;
      trippedAt = Date.now();
      trippedReason = reason;
      log.warn(`[canary] 🛑 tripped — ${reason}. All traffic stays on stable snapshot.`);
    },

    reset(): void {
      tripped = false;
      trippedAt = null;
      trippedReason = null;
    },

    snapshot(): CanaryStats {
      return {
        active,
        percent,
        tripped,
        trippedAt,
        trippedReason,
        candidateRequests,
        stableRequests,
      };
    },
  });
};
