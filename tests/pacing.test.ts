import { describe, expect, test } from 'bun:test';
import { createPacingEnforcer } from '../src/pacing.js';

describe('createPacingEnforcer', () => {
  test('minGapMs <= 0 is a no-op — returns immediately', async () => {
    const pacing = createPacingEnforcer({ minGapMs: 0 });
    const start = Date.now();
    await pacing.await('session-A');
    await pacing.await('session-A');
    expect(Date.now() - start).toBeLessThan(20);
  });

  test('missing session id skips pacing (SDK-direct clients)', async () => {
    const pacing = createPacingEnforcer({ minGapMs: 1_000 });
    const start = Date.now();
    await pacing.await(undefined);
    await pacing.await(undefined);
    expect(Date.now() - start).toBeLessThan(20);
  });

  test('second call within minGapMs delays to satisfy the gap', async () => {
    const pacing = createPacingEnforcer({ minGapMs: 50 });
    const t0 = Date.now();
    await pacing.await('session-A');
    await pacing.await('session-A');
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(45); // ~50ms gap, small jitter allowance
    expect(elapsed).toBeLessThan(200);
  });

  test('different session ids are independent', async () => {
    const pacing = createPacingEnforcer({ minGapMs: 200 });
    const t0 = Date.now();
    await pacing.await('A');
    await pacing.await('B');
    // B does NOT wait for A's 200ms gap — should be near-instant.
    expect(Date.now() - t0).toBeLessThan(50);
  });
});
