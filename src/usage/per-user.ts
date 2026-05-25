import { QuotaExceeded } from '../lib/errors.js';
import type { SniffedUsage } from './sniff.js';

export interface DailyState {
  readonly day: string;
  readonly tokens: number;
}

export const utcDayKey = (now: Date): string => now.toISOString().slice(0, 10);

export type UsageSnapshot = Readonly<Record<string, DailyState>>;

// Async contract — Postgres-backed implementations need network round-trips,
// and the in-memory variant simply resolves immediately. Callers must await.
export type UsageTracker = Readonly<{
  assertCanRequest(userName: string): Promise<void>;
  record(userName: string, usage: SniffedUsage): Promise<void>;
  snapshot(): Promise<UsageSnapshot>;
  /** Graceful shutdown hook — close DB pools, flush buffers, etc.
   *  In-memory variants leave undefined. */
  close?(): Promise<void>;
}>;

export const createUsageTracker = (params: {
  dailyLimitPerKey: number;
  now?: () => Date;
}): UsageTracker => {
  const clock = params.now ?? ((): Date => new Date());
  const state = new Map<string, DailyState>();

  const currentDayUsage = (userName: string): DailyState => {
    const today = utcDayKey(clock());
    const existing = state.get(userName);
    return existing && existing.day === today ? existing : { day: today, tokens: 0 };
  };

  return Object.freeze({
    async assertCanRequest(userName: string): Promise<void> {
      if (params.dailyLimitPerKey <= 0) return;
      const current = currentDayUsage(userName);
      if (current.tokens >= params.dailyLimitPerKey) {
        throw QuotaExceeded(
          `daily token limit exceeded for "${userName}" (${current.tokens}/${params.dailyLimitPerKey})`,
        );
      }
    },
    async record(userName: string, usage: SniffedUsage): Promise<void> {
      const current = currentDayUsage(userName);
      state.set(userName, {
        day: current.day,
        tokens: current.tokens + usage.inputTokens + usage.outputTokens,
      });
    },
    async snapshot(): Promise<UsageSnapshot> {
      const out: Record<string, DailyState> = {};
      state.forEach((v, k) => {
        out[k] = v;
      });
      return Object.freeze(out);
    },
  });
};
