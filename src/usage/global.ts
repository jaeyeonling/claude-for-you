import { QuotaExceeded } from '../lib/errors.js';

const REMAINING_HEADER_CANDIDATES: readonly string[] = [
  'anthropic-ratelimit-unified-remaining',
  'anthropic-ratelimit-tokens-remaining',
];

export type GlobalGuardSnapshot = Readonly<{
  remaining: number | null;
  observedAt: number | null;
}>;

export type GlobalGuard = Readonly<{
  observeHeaders(headers: Headers): void;
  assertSubscriptionHealthy(): void;
  snapshot(): GlobalGuardSnapshot;
}>;

export const createGlobalGuard = (params: {
  thresholdTokens: number;
}): GlobalGuard => {
  let remaining: number | null = null;
  let observedAt: number | null = null;

  return Object.freeze({
    observeHeaders(headers: Headers) {
      for (const name of REMAINING_HEADER_CANDIDATES) {
        const raw = headers.get(name);
        if (raw === null) continue;
        const n = Number(raw);
        if (Number.isFinite(n)) {
          remaining = n;
          observedAt = Date.now();
          return;
        }
      }
    },
    assertSubscriptionHealthy() {
      if (params.thresholdTokens <= 0) return; // disabled
      if (remaining === null) return; // no observation yet — admit and learn
      if (remaining < params.thresholdTokens) {
        throw QuotaExceeded(
          `subscription headroom low: ${remaining} tokens remaining (threshold ${params.thresholdTokens})`,
        );
      }
    },
    snapshot() {
      return { remaining, observedAt };
    },
  });
};
