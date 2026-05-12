import type { AlertSink } from '../alerts.js';
import type { DriftAnalyzer } from './drift-analyzer.js';

/**
 * Phase 19/22 — billing drift monitor.
 *
 * Watches two signals from every /v1/messages response:
 *   1. response body `usage.service_tier`  (sniffed)
 *   2. response header `anthropic-ratelimit-unified-status`
 *
 * Triggers an alarm when either deviates from the subscription-billing path
 * ("standard" / "allowed"). This is the load-bearing signal for "is my card
 * about to be charged?" — the whole reason wire-fidelity matters.
 *
 * Alarms are rate-limited via a cooldown so a flapping endpoint doesn't
 * spam stdout or the operator's webhook channel.
 */

const STANDARD_TIER = 'standard';
const OK_STATUS = new Set(['allowed', 'allowed_warning']);
const ALARM_COOLDOWN_MS = 60 * 1000;

export type BillingObservation = Readonly<{
  serviceTier: string | null;
  unifiedStatus: string | null;
  representativeClaim: string | null;
  observedAt: number;
}>;

export type BillingMonitorSnapshot = Readonly<{
  lastObservation: BillingObservation | null;
  nonStandardCount: number;
  lastAlarmAt: number | null;
}>;

export type BillingMonitor = Readonly<{
  observe(serviceTier: string | undefined, responseHeaders: Headers): void;
  snapshot(): BillingMonitorSnapshot;
}>;

export const createBillingMonitor = (params: {
  sink: AlertSink;
  cooldownMs?: number;
  drift?: DriftAnalyzer;
}): BillingMonitor => {
  const cooldown = params.cooldownMs ?? ALARM_COOLDOWN_MS;
  let lastObservation: BillingObservation | null = null;
  let nonStandardCount = 0;
  let lastAlarmAt: number | null = null;

  return Object.freeze({
    observe(serviceTier: string | undefined, responseHeaders: Headers): void {
      const tier = serviceTier ?? null;
      const status = responseHeaders.get('anthropic-ratelimit-unified-status');
      const claim = responseHeaders.get('anthropic-ratelimit-unified-representative-claim');

      const obs: BillingObservation = {
        serviceTier: tier,
        unifiedStatus: status,
        representativeClaim: claim,
        observedAt: Date.now(),
      };
      lastObservation = obs;

      const tierBad = tier !== null && tier !== STANDARD_TIER;
      const statusBad = status !== null && !OK_STATUS.has(status);
      if (!tierBad && !statusBad) return;

      nonStandardCount += 1;

      const now = Date.now();
      if (lastAlarmAt !== null && now - lastAlarmAt < cooldown) return;
      lastAlarmAt = now;

      const reasons: string[] = [];
      if (tierBad) reasons.push(`service_tier=${tier}`);
      if (statusBad) reasons.push(`unified-status=${status}`);

      let rootCause = '';
      if (params.drift) {
        // Compare last 5min vs earlier — surfaces the change point if any.
        const report = params.drift.analyze(Date.now() - 5 * 60_000);
        if (report.changes.length > 0) {
          rootCause = `\n  ▸ root cause hint (window=${report.recentCount} reqs): ${report.changes.join('; ')}`;
        }
      }

      const message =
        `[billing] ⚠️  ALARM — ${reasons.join(' ')}` +
        (claim ? ` (representative-claim=${claim})` : '') +
        ` — total non-standard responses: ${nonStandardCount}` +
        rootCause;
      console.warn(message);
      void params.sink(message); // fire-and-forget — don't block request path
    },
    snapshot(): BillingMonitorSnapshot {
      return { lastObservation, nonStandardCount, lastAlarmAt };
    },
  });
};
