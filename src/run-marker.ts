import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AlertSink } from './alerts.js';
import { log } from './lib/logger.js';

/**
 * Unclean-restart report (#169). A SIGKILLed process can't record its own
 * death, so we record the opposite: a marker written at boot that only a
 * graceful shutdown (SIGTERM/SIGINT/SIGHUP → dispose) removes. Finding it at
 * the next boot means the previous run was killed — OOM, crash, host reboot.
 *
 * It deliberately does NOT guess the cause. The container can't see it: Docker
 * gives every restart a fresh cgroup (memory.events `oom_kill` resets to 0) and
 * `State.OOMKilled` stays false on cgroup v2 — R2 reproduced a real memcg OOM
 * kill that both reported as "no OOM". Only the host's dmesg knows (#170).
 */

// globalThis survives `bun --hot` reloads within one process, while a real
// restart starts with a fresh global. (pid can't tell them apart: in Docker
// every restart gets the same pid.)
const CHECKED = Symbol.for('claude-for-you.run-marker.checked');


const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** Previous run's start time, only if it is a plain ISO timestamp (it goes into the webhook). */
const parseStartedAt = (raw: string): string | null => {
  try {
    const p: unknown = JSON.parse(raw);
    return p && typeof p === 'object' && 'startedAt' in p && typeof p.startedAt === 'string' && ISO_RE.test(p.startedAt)
      ? p.startedAt
      : null;
  } catch {
    return null; // corrupt still means unclean
  }
};

const isEnoent = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT';

/**
 * Boot-time check. Writes the fresh marker *before* alerting so a graceful
 * stop racing a slow webhook can't resurrect it after dispose cleared it.
 * Never throws — alerting must not be able to block boot.
 */
export const checkUncleanRestart = async (params: {
  markerPath: string;
  sink: AlertSink;
  now?: () => number;
}): Promise<void> => {
  const g = globalThis as Record<symbol, unknown>;
  if (g[CHECKED]) return; // bun --hot reload, not a restart
  g[CHECKED] = true;

  const now = params.now ?? Date.now;
  try {
    let previous: string | null = null;
    try {
      previous = await readFile(params.markerPath, 'utf8');
    } catch (err: unknown) {
      if (!isEnoent(err)) throw err; // EACCES etc. must not look like "clean"
    }

    await mkdir(dirname(params.markerPath), { recursive: true });
    // rm + exclusive create: never follow a planted symlink into tokens.json.
    await rm(params.markerPath, { force: true });
    await writeFile(
      params.markerPath,
      JSON.stringify({ startedAt: new Date(now()).toISOString() }),
      { flag: 'wx' },
    );

    if (previous === null) return;
    const message =
      `[restart] 🔁 app restarted without a graceful shutdown (previous run started ${parseStartedAt(previous) ?? 'unknown'}). ` +
      "Likely a memcg OOM kill; also crash or host reboot — confirm with `sudo dmesg -T | grep 'Killed process'` on the host. " +
      'Runbook: docs/operational-pitfalls.md "App memcg OOM kills"';
    log.warn(message);
    await params.sink(message);
  } catch (err: unknown) {
    log.error(`[restart] run marker check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
};

export const clearRunMarker = async (markerPath: string): Promise<void> => {
  await rm(markerPath, { force: true }).catch(() => undefined);
};

/** Test-only: forget that this process already checked (simulates a fresh boot). */
export const resetRunMarkerCheckForTests = (): void => {
  delete (globalThis as Record<symbol, unknown>)[CHECKED];
};
