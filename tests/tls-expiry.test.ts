import { describe, expect, test } from 'bun:test';
import { createTlsExpiryWatch } from '../src/tls-expiry.js';

const H = 60 * 60 * 1000;
const NOW = Date.parse('2026-11-03T00:00:00Z');

const collectSink = () => {
  const messages: string[] = [];
  return { messages, sink: async (m: string) => void messages.push(m) };
};

/** A check that returns notAfter = NOW + hoursLeft, or throws. */
const scripted = (steps: Array<number | Error>) => {
  let i = 0;
  return async (): Promise<number> => {
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    if (step instanceof Error) throw step;
    return NOW + step * H;
  };
};

const makeWatch = (steps: Array<number | Error>) => {
  const { messages, sink } = collectSink();
  const watch = createTlsExpiryWatch({ host: '203.0.113.7', sink, check: scripted(steps), now: () => NOW });
  return { messages, watch };
};

describe('createTlsExpiryWatch', () => {
  test('plenty of validity left → quiet', async () => {
    const { messages, watch } = makeWatch([150]);
    await watch.tick();
    expect(messages).toHaveLength(0);
  });

  test('under 48h left → one alert naming host and hours left', async () => {
    const { messages, watch } = makeWatch([30]);
    await watch.tick();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('[tls]');
    expect(messages[0]).toContain('203.0.113.7');
    expect(messages[0]).toContain('30h');
  });

  test('stays quiet while still expiring, re-arms after renewal', async () => {
    const { messages, watch } = makeWatch([30, 20, 10, 150, 30]);
    for (let i = 0; i < 5; i += 1) await watch.tick();
    expect(messages).toHaveLength(2); // 30 → alert, 20/10 quiet, 150 renewed, 30 → alert again
  });

  test('a single failed check is not an alert (transient)', async () => {
    const { messages, watch } = makeWatch([new Error('ECONNRESET'), 150]);
    await watch.tick();
    await watch.tick();
    expect(messages).toHaveLength(0);
  });

  test('three consecutive failures → one alert with the error, no repeat', async () => {
    const err = new Error('certificate has expired');
    const { messages, watch } = makeWatch([err, err, err, err, err]);
    for (let i = 0; i < 5; i += 1) await watch.tick();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('certificate has expired');
  });

  test('failure streak resets on success and can alert again later', async () => {
    const e = new Error('timeout');
    const { messages, watch } = makeWatch([e, e, e, 150, e, e, e]);
    for (let i = 0; i < 7; i += 1) await watch.tick();
    expect(messages).toHaveLength(2);
  });

  test('failures split by a success are not "in a row"', async () => {
    const e = new Error('timeout');
    const { messages, watch } = makeWatch([e, e, 150, e]);
    for (let i = 0; i < 4; i += 1) await watch.tick();
    expect(messages).toHaveLength(0);
  });

  test('a throwing sink never propagates', async () => {
    const watch = createTlsExpiryWatch({
      host: '203.0.113.7',
      sink: async () => {
        throw new Error('webhook down');
      },
      check: scripted([1]),
      now: () => NOW,
    });
    await watch.tick();
  });

  test('start schedules the first check after the delay; stop halts it', async () => {
    let checks = 0;
    const watch = createTlsExpiryWatch({
      host: '203.0.113.7',
      sink: async () => undefined,
      check: async () => {
        checks += 1;
        return NOW + 150 * H;
      },
      now: () => NOW,
      firstDelayMs: 1,
      intervalMs: 5,
    });
    watch.start();
    await Bun.sleep(30);
    expect(checks).toBeGreaterThan(0);
    watch.stop();
    watch.stop(); // idempotent
    const after = checks;
    await Bun.sleep(30);
    expect(checks).toBe(after);
  });
});
