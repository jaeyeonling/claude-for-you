import { describe, expect, test } from 'bun:test';
import { createUsageTracker, utcDayKey } from '../src/usage/per-user.js';

describe('utcDayKey', () => {
  test('returns YYYY-MM-DD in UTC regardless of local timezone', () => {
    // 2026-05-22T23:30:00Z and 2026-05-23T00:30:00 Asia/Seoul (UTC+9) both
    // produce the same UTC day key when interpreted via Date.toISOString().
    expect(utcDayKey(new Date('2026-05-22T23:30:00Z'))).toBe('2026-05-22');
    expect(utcDayKey(new Date('2026-05-23T00:30:00Z'))).toBe('2026-05-23');
  });
});

describe('in-memory UsageTracker', () => {
  test('accumulates per-user tokens within the same UTC day', async () => {
    const tracker = createUsageTracker({ dailyLimitPerKey: 0 });
    await tracker.record('alice', { inputTokens: 100, outputTokens: 200, serviceTier: 'standard' });
    await tracker.record('alice', { inputTokens: 50, outputTokens: 75, serviceTier: 'standard' });
    await tracker.record('bob', { inputTokens: 10, outputTokens: 20, serviceTier: 'standard' });
    const snap = await tracker.snapshot();
    expect(snap.alice?.tokens).toBe(425);
    expect(snap.bob?.tokens).toBe(30);
  });

  test('assertCanRequest throws QuotaExceeded once user crosses limit', async () => {
    const tracker = createUsageTracker({ dailyLimitPerKey: 100 });
    await tracker.assertCanRequest('alice'); // 0 used — pass
    await tracker.record('alice', { inputTokens: 60, outputTokens: 50, serviceTier: 'standard' });
    expect(tracker.assertCanRequest('alice')).rejects.toThrow(/daily token limit exceeded/);
  });

  test('dailyLimitPerKey=0 disables quota enforcement entirely', async () => {
    const tracker = createUsageTracker({ dailyLimitPerKey: 0 });
    await tracker.record('alice', { inputTokens: 1_000_000, outputTokens: 0, serviceTier: 'standard' });
    await expect(tracker.assertCanRequest('alice')).resolves.toBeUndefined();
  });
});
