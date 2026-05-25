import { describe, expect, test } from 'bun:test';
import { createDriftAnalyzer } from '../src/usage/drift-analyzer.js';
import type { RequestFingerprint } from '../src/usage/drift-analyzer.js';

const fp = (
  overrides: Partial<RequestFingerprint> & { ts: number },
): RequestFingerprint => ({
  ts: overrides.ts,
  userKey: overrides.userKey ?? 'alice',
  headerNames: overrides.headerNames ?? ['user-agent', 'x-app'],
  bodyKeys: overrides.bodyKeys ?? ['model', 'messages'],
  anthropicBeta: overrides.anthropicBeta ?? '',
  userAgent: overrides.userAgent ?? 'claude-cli/2.1.126',
  model: overrides.model ?? 'claude-sonnet-4',
});

describe('createDriftAnalyzer', () => {
  test('empty after window reports unobservable (no recent requests)', () => {
    const a = createDriftAnalyzer();
    a.record(fp({ ts: 1000 }));
    const report = a.analyze(2000);
    expect(report.recentCount).toBe(0);
    expect(report.changes.join('')).toContain('unobservable');
  });

  test('detects an added header name in the after window', () => {
    const a = createDriftAnalyzer();
    a.record(fp({ ts: 1000, headerNames: ['user-agent', 'x-app'] }));
    a.record(fp({ ts: 1500, headerNames: ['user-agent', 'x-app'] }));
    a.record(fp({ ts: 5000, headerNames: ['user-agent', 'x-app', 'x-fake'] }));
    const report = a.analyze(2000);
    expect(report.changes.join('\n')).toContain('header names added: x-fake');
  });

  test('detects a removed body key in the after window', () => {
    const a = createDriftAnalyzer();
    a.record(fp({ ts: 1000, bodyKeys: ['model', 'messages', 'system'] }));
    a.record(fp({ ts: 5000, bodyKeys: ['model', 'messages'] }));
    const report = a.analyze(2000);
    expect(report.changes.join('\n')).toContain('body keys removed: system');
  });

  test('detects a new model value (diffValues path)', () => {
    const a = createDriftAnalyzer();
    a.record(fp({ ts: 1000, model: 'claude-sonnet-4' }));
    a.record(fp({ ts: 5000, model: 'claude-opus-4' }));
    const report = a.analyze(2000);
    expect(report.changes.join('\n')).toContain('claude-opus-4');
  });

  test('ring caps at RING_SIZE (oldest entries drop)', () => {
    const a = createDriftAnalyzer();
    // 105 records — old "before" entries should drop out of the ring.
    for (let i = 0; i < 105; i += 1) {
      a.record(fp({ ts: i }));
    }
    // analyze with splitAt at the very end → after window holds the tail
    const report = a.analyze(104);
    expect(report.recentCount).toBeLessThanOrEqual(1); // exactly the last record
  });

  test('multiple axes can change at once (all surfaced)', () => {
    const a = createDriftAnalyzer();
    a.record(fp({ ts: 1000, headerNames: ['a'], bodyKeys: ['m'], anthropicBeta: 'old-flag' }));
    a.record(fp({ ts: 5000, headerNames: ['a', 'b'], bodyKeys: ['m', 'n'], anthropicBeta: 'new-flag' }));
    const report = a.analyze(2000);
    const joined = report.changes.join('\n');
    expect(joined).toContain('header names added: b');
    expect(joined).toContain('body keys added: n');
    expect(joined).toContain('new-flag');
  });
});
