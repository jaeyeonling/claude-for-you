import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AlertSink } from './alerts.js';
import { log } from './lib/logger.js';

/**
 * Memory-pressure early warning (#169). Born from #167: the app was
 * memcg-OOM-killed 60 times and nothing noticed, because a SIGKILLed process
 * can't log its own death and /healthz recovers within seconds. This samples
 * the cgroup's working set against its limit and warns *before* the kill.
 * (The after-the-fact report lives in run-marker.ts.)
 */

export const DEFAULT_CGROUP_DIR = '/sys/fs/cgroup';
// #167's kills came from multi-MB body bursts; at 30s a burst could eat the
// remaining headroom between samples. A sample is two sysfs reads (~µs).
const DEFAULT_INTERVAL_MS = 5_000;
const MiB = 1024 * 1024;
// Warn with ~15% of the limit left; re-arm only once usage falls back under
// 70%, so a slow climb hovering near the mark doesn't flap.
const ALERT_RATIO = 0.85;
const REARM_RATIO = 0.7;

export type PressureState = Readonly<{ armed: boolean }>;
export const INITIAL_PRESSURE_STATE: PressureState = Object.freeze({ armed: true });

/** `ratio` is working set / cgroup limit (0..1+). */
export const evaluatePressure = (
  state: PressureState,
  ratio: number,
): Readonly<{ state: PressureState; alert: boolean }> => {
  if (state.armed && ratio >= ALERT_RATIO) return { state: { armed: false }, alert: true };
  if (!state.armed && ratio < REARM_RATIO) return { state: { armed: true }, alert: false };
  return { state, alert: false };
};

const readNumber = (path: string): number | null => {
  try {
    const n = Number(readFileSync(path, 'utf8').trim());
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
};

/** cgroup v2 `memory.max` in bytes, or null when unlimited / unavailable (macOS, cgroup v1). */
export const readCgroupMemoryLimit = (cgroupDir: string = DEFAULT_CGROUP_DIR): number | null => {
  const n = readNumber(join(cgroupDir, 'memory.max'));
  return n !== null && n > 0 ? n : null;
};

/**
 * Working set = memory.current − inactive_file — what `docker stats` and the
 * kubelet report. memory.current is what memcg actually charges against
 * memory.max (it includes socket buffers and slab, which RSS misses), minus
 * the clean page cache the kernel would reclaim before resorting to a kill.
 * Falls back to process RSS when the cgroup files aren't readable.
 */
export const readWorkingSet = (cgroupDir: string = DEFAULT_CGROUP_DIR): number => {
  const current = readNumber(join(cgroupDir, 'memory.current'));
  if (current === null) return process.memoryUsage.rss();
  let inactiveFile = 0;
  try {
    const m = /^inactive_file (\d+)$/m.exec(readFileSync(join(cgroupDir, 'memory.stat'), 'utf8'));
    if (m) inactiveFile = Number(m[1]);
  } catch {
    // memory.stat missing: report the uncorrected (slightly high) number
  }
  return Math.max(0, current - inactiveFile);
};

export type MemoryWatch = Readonly<{
  tick(): Promise<void>;
  start(): void;
  stop(): void;
  isRunning(): boolean;
}>;

export const createMemoryWatch = (params: {
  sink: AlertSink;
  limitBytes: number;
  readUsage?: () => number;
  intervalMs?: number;
}): MemoryWatch => {
  const readUsage = params.readUsage ?? (() => readWorkingSet());
  const intervalMs = params.intervalMs ?? DEFAULT_INTERVAL_MS;
  let state = INITIAL_PRESSURE_STATE;
  let timer: ReturnType<typeof setInterval> | null = null;

  const tick = async (): Promise<void> => {
    try {
      const used = readUsage();
      const result = evaluatePressure(state, used / params.limitBytes);
      state = result.state;
      if (!result.alert) return;
      const message =
        `[memory] ⚠️  app working set ${Math.round(used / MiB)}MiB / limit ${Math.round(params.limitBytes / MiB)}MiB ` +
        `(${Math.round((used / params.limitBytes) * 100)}%) — memcg OOM kill is next. ` +
        'Runbook: docs/operational-pitfalls.md "App memcg OOM kills"';
      log.warn(message);
      await params.sink(message);
    } catch (err: unknown) {
      log.error(`[memory] watch tick failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return Object.freeze({
    tick,
    start(): void {
      if (timer) return;
      timer = setInterval(() => void tick(), intervalMs);
      timer.unref?.();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
    isRunning(): boolean {
      return timer !== null;
    },
  });
};
