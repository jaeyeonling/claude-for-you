import postgres from 'postgres';
import { QuotaExceeded } from '../lib/errors.js';
import type { SniffedUsage } from './sniff.js';
import { utcDayKey, type DailyState, type UsageSnapshot, type UsageTracker } from './per-user.js';

/**
 * Postgres-backed UsageTracker.
 *
 * Schema: one row per (user_name, day). History grows; a cron
 * `DELETE WHERE day < ?` is sufficient when needed. Trusted-few traffic keeps
 * the table tiny indefinitely.
 *
 * Concurrency: postgres.js connection pool handles concurrent writes. Single
 * proxy container is the expected topology; horizontal scaling would still
 * work since the upsert is atomic via ON CONFLICT.
 */

export interface PostgresUsageTrackerParams {
  readonly databaseUrl: string;
  readonly dailyLimitPerKey: number;
  readonly now?: () => Date;
}

interface SelectRow {
  readonly tokens: string;
}

interface DayRow {
  readonly user_name: string;
  readonly tokens: string;
}

export const createPostgresUsageTracker = async (
  params: PostgresUsageTrackerParams,
): Promise<UsageTracker> => {
  const clock = params.now ?? ((): Date => new Date());
  const sql = postgres(params.databaseUrl, {
    max: 8,
    idle_timeout: 30,
    connect_timeout: 10,
  });

  await sql`
    CREATE TABLE IF NOT EXISTS usage_per_user (
      user_name TEXT NOT NULL,
      day DATE NOT NULL,
      tokens BIGINT NOT NULL DEFAULT 0,
      PRIMARY KEY (user_name, day)
    )
  `;

  const tracker: UsageTracker = {
    async assertCanRequest(userName: string): Promise<void> {
      if (params.dailyLimitPerKey <= 0) return;
      const today = utcDayKey(clock());
      const rows = await sql<SelectRow[]>`
        SELECT tokens FROM usage_per_user
        WHERE user_name = ${userName} AND day = ${today}
      `;
      const first = rows[0];
      const tokens = first ? Number(first.tokens) : 0;
      if (tokens >= params.dailyLimitPerKey) {
        throw QuotaExceeded(
          `daily token limit exceeded for "${userName}" (${tokens}/${params.dailyLimitPerKey})`,
        );
      }
    },
    async record(userName: string, usage: SniffedUsage): Promise<void> {
      const total = usage.inputTokens + usage.outputTokens;
      if (total <= 0) return;
      const today = utcDayKey(clock());
      await sql`
        INSERT INTO usage_per_user (user_name, day, tokens)
        VALUES (${userName}, ${today}, ${total})
        ON CONFLICT (user_name, day) DO UPDATE
        SET tokens = usage_per_user.tokens + EXCLUDED.tokens
      `;
    },
    async snapshot(): Promise<UsageSnapshot> {
      const today = utcDayKey(clock());
      const rows = await sql<DayRow[]>`
        SELECT user_name, tokens FROM usage_per_user WHERE day = ${today}
      `;
      const out: Record<string, DailyState> = {};
      for (const r of rows) {
        out[r.user_name] = { day: today, tokens: Number(r.tokens) };
      }
      return Object.freeze(out);
    },
    async close(): Promise<void> {
      // 5s grace gives in-flight queries a chance to finish before forcing close.
      await sql.end({ timeout: 5 });
    },
  };
  return Object.freeze(tracker);
};
