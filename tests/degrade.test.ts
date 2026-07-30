import { describe, expect, test } from 'bun:test';
import { attempt, succeeded } from '../src/lib/degrade.js';

describe('attempt', () => {
  test('wraps a resolved value as ok:true', async () => {
    const r = await attempt('probe', async () => 42);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(42);
  });

  test('converts a throw into ok:false instead of propagating', async () => {
    // Arrange: the exact failure shape from the 2026-07-30 incident.
    const boom = async (): Promise<never> => {
      throw new Error('the database system is in recovery mode');
    };

    // Act
    const r = await attempt('usage-snapshot', boom);

    // Assert
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('the database system is in recovery mode');
  });

  test('never rejects — a throwing dependency must not become an unhandled rejection', async () => {
    const r = await attempt('probe', async () => {
      throw new Error('nope');
    });
    expect(r.ok).toBe(false);
  });

  test('handles non-Error throws (drivers reject with strings and objects)', async () => {
    const r = await attempt('probe', async () => {
      throw 'plain string failure';
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('plain string failure');
  });

  test('redacts credentials before the reason reaches the admin page', async () => {
    // The reason is rendered into HTML, which does NOT pass through logger.ts's
    // redact. postgres.js does not normally echo the DSN, but if it ever does,
    // the password must not land in a browser tab.
    const r = await attempt('probe', async () => {
      throw new Error('connection to postgres://claude:sup3rs3cret@db.internal/cfy failed');
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).not.toContain('sup3rs3cret');
      expect(r.reason).toContain('postgres://[REDACTED]@db.internal/cfy');
    }
  });

  test('collapses whitespace and caps length (multi-line SQL echoes)', async () => {
    const r = await attempt('probe', async () => {
      throw new Error(`line one\n  line two\t\tline three${'x'.repeat(400)}`);
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('line one line two line three');
      expect(r.reason.length).toBe(200);
      expect(r.reason).not.toContain('\n');
    }
  });
});

describe('succeeded', () => {
  test('lifts a value that needs no I/O into the same union', () => {
    const r = succeeded('static');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('static');
  });
});
