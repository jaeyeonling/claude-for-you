import { log } from './logger.js';
import { redact } from './redact.js';

/**
 * Graceful degradation for admin-surface reads.
 *
 * Motivation (2026-07-30 incident): `/admin` had exactly one I/O call —
 * `tracker.snapshot()` — and every other panel it renders comes from in-memory
 * state. When RDS filled up and Postgres entered recovery mode, that single
 * await threw, Hono's onError caught it, and the whole dashboard became
 * `{"error":{"type":"internal_error",...}}`. The one page an operator needs in
 * order to diagnose a DB outage was the page the DB outage took down.
 *
 * `attempt` inverts that: a failed dependency becomes a *value* the renderer
 * can display next to the panels that still work, instead of an exception that
 * discards them. It never throws.
 *
 * Why a discriminated union rather than `T | null`: the failure reason is
 * operationally load-bearing ("recovery mode" vs "connect ETIMEDOUT" point at
 * different fixes). `null` would force the renderer to say "unavailable" and
 * make the operator go read container logs — which is exactly the loop this
 * helper exists to short-circuit.
 */

export type Degradable<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; reason: string }>;

/**
 * Reason strings are rendered into admin HTML. Driver errors can be long
 * (multi-line SQL echoes); cap so one failure can't push the whole layout
 * around. Diagnosis value is front-loaded in the first line anyway.
 */
const REASON_MAX_LENGTH = 200;

export const succeeded = <T>(value: T): Degradable<T> =>
  Object.freeze({ ok: true as const, value });

export const attempt = async <T>(
  label: string,
  fn: () => Promise<T>,
): Promise<Degradable<T>> => {
  try {
    return Object.freeze({ ok: true as const, value: await fn() });
  } catch (err) {
    // redact here, not only in the logger: this string is also rendered into
    // the admin page, and that path does not pass through logger.ts.
    const raw = err instanceof Error ? err.message : String(err);
    const reason = redact(raw).replaceAll(/\s+/g, ' ').trim().slice(0, REASON_MAX_LENGTH);
    log.error(`[degraded/${label}] ${reason}`);
    return Object.freeze({ ok: false as const, reason });
  }
};
