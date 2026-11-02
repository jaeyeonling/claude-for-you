import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  INITIAL_PRESSURE_STATE,
  createMemoryWatch,
  evaluatePressure,
  readCgroupMemoryLimit,
  readWorkingSet,
} from '../src/memory-alerts.js';

let cgroupDir: string;

beforeEach(async () => {
  cgroupDir = await mkdtemp(join(tmpdir(), 'cfy-mem-'));
});
afterEach(async () => {
  await rm(cgroupDir, { recursive: true, force: true });
});

const collectSink = () => {
  const messages: string[] = [];
  return { messages, sink: async (m: string) => void messages.push(m) };
};

describe('evaluatePressure', () => {
  // Only policy-independent invariants live here; exact thresholds are a tuning
  // choice inside evaluatePressure, so these use ratios far from any sane cutoff.
  test('no alert well below the limit', () => {
    expect(evaluatePressure(INITIAL_PRESSURE_STATE, 0.3).alert).toBe(false);
  });

  test('alerts once on first crossing near the limit', () => {
    expect(evaluatePressure(INITIAL_PRESSURE_STATE, 0.97).alert).toBe(true);
  });

  test('does not repeat while pressure stays high', () => {
    let s = evaluatePressure(INITIAL_PRESSURE_STATE, 0.97).state;
    for (const ratio of [0.98, 0.96, 0.99]) {
      const r = evaluatePressure(s, ratio);
      expect(r.alert).toBe(false);
      s = r.state;
    }
  });

  test('re-arms after pressure clearly drops, then alerts again', () => {
    let s = evaluatePressure(INITIAL_PRESSURE_STATE, 0.97).state;
    s = evaluatePressure(s, 0.3).state;
    expect(evaluatePressure(s, 0.97).alert).toBe(true);
  });
});

describe('readCgroupMemoryLimit', () => {
  test('parses a numeric limit', async () => {
    await writeFile(join(cgroupDir, 'memory.max'), '2147483648\n');
    expect(readCgroupMemoryLimit(cgroupDir)).toBe(2147483648);
  });

  test('"max" (unlimited) disables the watch', async () => {
    await writeFile(join(cgroupDir, 'memory.max'), 'max\n');
    expect(readCgroupMemoryLimit(cgroupDir)).toBeNull();
  });

  test('missing file (macOS dev, cgroup v1) disables the watch', () => {
    expect(readCgroupMemoryLimit(join(cgroupDir, 'nope'))).toBeNull();
  });
});

describe('readWorkingSet', () => {
  test('memory.current minus reclaimable inactive_file', async () => {
    await writeFile(join(cgroupDir, 'memory.current'), '1000000\n');
    await writeFile(join(cgroupDir, 'memory.stat'), 'anon 700000\ninactive_file 300000\nactive_file 5\n');
    expect(readWorkingSet(cgroupDir)).toBe(700000);
  });

  test('missing memory.stat reports raw memory.current', async () => {
    await writeFile(join(cgroupDir, 'memory.current'), '1000000\n');
    expect(readWorkingSet(cgroupDir)).toBe(1000000);
  });

  test('no cgroup files falls back to process RSS', () => {
    const ws = readWorkingSet(join(cgroupDir, 'nope'));
    expect(ws).toBeGreaterThan(0);
  });
});

describe('createMemoryWatch', () => {
  const MiB = 1024 * 1024;

  test('alerts through the sink with usage, limit, and runbook pointer', async () => {
    const { messages, sink } = collectSink();
    const watch = createMemoryWatch({ sink, limitBytes: 1000 * MiB, readUsage: () => 970 * MiB });
    await watch.tick();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('970MiB');
    expect(messages[0]).toContain('1000MiB');
    expect(messages[0]).toContain('operational-pitfalls');
  });

  test('stays quiet below the limit and does not repeat while high', async () => {
    const { messages, sink } = collectSink();
    let used = 100 * MiB;
    const watch = createMemoryWatch({ sink, limitBytes: 1000 * MiB, readUsage: () => used });
    await watch.tick();
    expect(messages).toHaveLength(0);
    used = 970 * MiB;
    await watch.tick();
    await watch.tick();
    expect(messages).toHaveLength(1);
  });

  test('a throwing reader never propagates', async () => {
    const { messages, sink } = collectSink();
    const watch = createMemoryWatch({
      sink,
      limitBytes: 1000 * MiB,
      readUsage: () => {
        throw new Error('boom');
      },
    });
    await watch.tick();
    expect(messages).toHaveLength(0);
  });

  test('start samples on the interval and stop actually halts sampling', async () => {
    const { sink } = collectSink();
    let reads = 0;
    const watch = createMemoryWatch({
      sink,
      limitBytes: 1000 * MiB,
      intervalMs: 1,
      readUsage: () => {
        reads += 1;
        return 0;
      },
    });
    watch.start();
    expect(watch.isRunning()).toBe(true);
    await Bun.sleep(20);
    expect(reads).toBeGreaterThan(0);
    watch.stop();
    watch.stop(); // idempotent
    expect(watch.isRunning()).toBe(false);
    const after = reads;
    await Bun.sleep(20);
    expect(reads).toBe(after);
  });
});
