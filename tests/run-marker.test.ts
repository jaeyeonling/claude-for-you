import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkUncleanRestart, clearRunMarker, resetRunMarkerCheckForTests } from '../src/run-marker.js';

let workdir: string;
let marker: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'cfy-marker-'));
  marker = join(workdir, '.run-marker');
  resetRunMarkerCheckForTests();
});
afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
  resetRunMarkerCheckForTests();
});

const collectSink = () => {
  const messages: string[] = [];
  return { messages, sink: async (m: string) => void messages.push(m) };
};

/** Each call is a fresh boot (new process). */
const boot = async (
  sink: (m: string) => Promise<void>,
  opts: { at?: string } = {},
): Promise<void> => {
  resetRunMarkerCheckForTests();
  await checkUncleanRestart({
    markerPath: marker,
    sink,
    now: () => Date.parse(opts.at ?? '2026-11-01T19:00:00Z'),
  });
};

describe('checkUncleanRestart', () => {
  test('first boot: no alert, marker written', async () => {
    const { messages, sink } = collectSink();
    await boot(sink);
    expect(messages).toHaveLength(0);
    expect(existsSync(marker)).toBe(true);
  });

  test('leftover marker → alert with previous start time, marker refreshed', async () => {
    const { messages, sink } = collectSink();
    await boot(sink, { at: '2026-11-01T19:00:00Z' });
    await boot(sink, { at: '2026-11-01T19:03:16Z' });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('[restart]');
    expect(messages[0]).toContain('2026-11-01T19:00:00');
    expect(await readFile(marker, 'utf8')).toContain('2026-11-01T19:03:16');
  });

  test('alert points at the host dmesg instead of guessing the cause', async () => {
    const { messages, sink } = collectSink();
    await boot(sink);
    await boot(sink);
    expect(messages[0]).toContain('dmesg');
    expect(messages[0]).not.toContain('not a memcg OOM kill');
  });

  test('graceful shutdown clears the marker → next boot is quiet', async () => {
    const { messages, sink } = collectSink();
    await boot(sink);
    await clearRunMarker(marker);
    await boot(sink);
    expect(messages).toHaveLength(0);
  });

  test('marker is on disk before the sink is called (no race with dispose)', async () => {
    let markerSeenDuringSend: string | null = null;
    const sink = async () => {
      markerSeenDuringSend = await readFile(marker, 'utf8');
    };
    await boot(async () => undefined, { at: '2026-11-01T19:00:00Z' });
    await boot(sink, { at: '2026-11-01T19:03:16Z' });
    expect(markerSeenDuringSend).toContain('2026-11-01T19:03:16');
  });

  test('same process (bun --hot reload) never reports', async () => {
    const { messages, sink } = collectSink();
    await boot(sink);
    // no reset → same process re-running composeApp
    await checkUncleanRestart({ markerPath: marker, sink });
    expect(messages).toHaveLength(0);
  });

  test('corrupt marker still reports, with unknown start time', async () => {
    const { messages, sink } = collectSink();
    await writeFile(marker, '{not json');
    await boot(sink);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('previous run started unknown');
  });

  test('non-ISO startedAt is not echoed into the webhook', async () => {
    const { messages, sink } = collectSink();
    await writeFile(marker, JSON.stringify({ startedAt: '@everyone http://evil.example' }));
    await boot(sink);
    expect(messages[0]).not.toContain('@everyone');
    expect(messages[0]).not.toContain('evil');
  });

  test('a planted symlink is replaced, not written through', async () => {
    const victim = join(workdir, 'tokens.json');
    await writeFile(victim, '{"secret":true}');
    await symlink(victim, marker);
    await boot(async () => undefined);
    expect(await readFile(victim, 'utf8')).toBe('{"secret":true}');
  });

  test('missing marker dir is created', async () => {
    marker = join(workdir, 'no', 'such', 'dir', '.run-marker');
    await boot(async () => undefined);
    expect(existsSync(marker)).toBe(true);
  });

  test('unreadable marker dir logs instead of throwing or posing as clean', async () => {
    const { messages, sink } = collectSink();
    const dir = join(workdir, 'locked');
    await mkdir(dir);
    marker = join(dir, '.run-marker');
    await writeFile(marker, '{}');
    await chmod(dir, 0o000);
    try {
      await boot(sink); // must not throw
      expect(messages).toHaveLength(0);
    } finally {
      await chmod(dir, 0o700);
    }
  });

  test('unreadable marker file is not mistaken for "no marker" and overwritten', async () => {
    const leftover = JSON.stringify({ startedAt: '2026-11-01T19:00:00Z' });
    await writeFile(marker, leftover);
    await chmod(marker, 0o000);
    try {
      await boot(async () => undefined); // EACCES on read → log, keep the evidence
    } finally {
      await chmod(marker, 0o600).catch(() => undefined);
    }
    expect(await readFile(marker, 'utf8')).toBe(leftover);
  });
});

describe('clearRunMarker', () => {
  test('clearing a missing marker does not throw', async () => {
    await clearRunMarker(join(workdir, 'absent'));
  });
});
