import { describe, expect, test } from 'bun:test';
import { redact, redactObject } from '../src/lib/redact.js';

describe('redact', () => {
  test('redacts Bearer header echoes', () => {
    const out = redact('upstream rejected: Bearer sk-ant-oat01-abcdef0123456789abcd "scheme"');
    expect(out).not.toContain('sk-ant-oat01');
    expect(out).toContain('[REDACTED]');
  });

  test('redacts standalone sk-ant-* tokens', () => {
    const out = redact('cached refresh token sk-ant-ort01-aaaaaaaaaaaaaaaaaaaa');
    expect(out).not.toContain('sk-ant-ort01');
    expect(out).toContain('[REDACTED]');
  });

  test('redacts standalone JWT (three-part eyJ.<payload>.<sig>) — issue #93 Adversary HIGH', () => {
    // Real OAuth access tokens can be JWTs surfaced without a `Bearer ` prefix
    // (e.g. `access token was: eyJ...`). Verify the standalone pattern fires.
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const out = redact(`upstream replied: access token was ${jwt} (rotated)`);
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(out).not.toContain('SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c');
    expect(out).toContain('[REDACTED]');
  });

  test('redactObject scrubs nested string fields', () => {
    const out = redactObject({
      ok: false,
      detail: 'Bearer sk-leaked-abcdef0123456789abcd refused',
      nested: { msg: 'sk-ant-ort01-bbbbbbbbbbbbbbbbbbbb' },
    });
    expect(JSON.stringify(out)).not.toContain('sk-leaked');
    expect(JSON.stringify(out)).not.toContain('sk-ant-ort01');
    expect(JSON.stringify(out)).toContain('[REDACTED]');
  });

  test('redacts query-string credential params (#93 L17, CodeRabbit follow-up)', () => {
    const out = redact(
      'curl https://example/cb?state=xyz&access_token=opaqueABCDEF12345 failed',
    );
    expect(out).not.toContain('opaqueABCDEF12345');
    expect(out).toContain('[REDACTED]');
    // Adjacent params on the other side of `&` survive — boundary check.
    expect(out).toContain('state=xyz');
  });

  test('redacts labeled opaque token values in prose', () => {
    const out = redact('upstream replied: access token was: opaqueXYZ0123456789abcd (rotated)');
    expect(out).not.toContain('opaqueXYZ0123456789abcd');
    expect(out).toContain('[REDACTED]');
  });

  test('labeled-token pattern length floor avoids `access token: missing`', () => {
    // Short value below 20 chars must NOT match — otherwise innocuous error
    // text would lose triage signal.
    expect(redact('access token: missing')).toBe('access token: missing');
  });

  test('passes innocuous text through unchanged', () => {
    expect(redact('hello world')).toBe('hello world');
    expect(redact('failed to read /tmp/data: ENOENT')).toBe('failed to read /tmp/data: ENOENT');
  });
});

// ---------- URL userinfo credentials (2026-07-30 degraded-read path) ----------
describe('URL userinfo redaction', () => {
  test('strips the credential pair but keeps scheme + host diagnosable', () => {
    expect(redact('connection to postgres://claude:pw@db.internal/cfy failed')).toBe(
      'connection to postgres://[REDACTED]@db.internal/cfy failed',
    );
  });

  test('handles schemes containing + and . (mongodb+srv)', () => {
    expect(redact('mongodb+srv://u:p@cluster0.mongodb.net')).toBe(
      'mongodb+srv://[REDACTED]@cluster0.mongodb.net',
    );
  });

  test('does not fire on a colon that is not userinfo', () => {
    const s = 'no creds here: https://example.com/a:b';
    expect(redact(s)).toBe(s);
  });

  test('does not fire on a bare host (no userinfo at all)', () => {
    const s = 'GET https://api.anthropic.com/v1/messages';
    expect(redact(s)).toBe(s);
  });
});

describe('watchdog bench — redact stays linear (bounded quantifiers)', () => {
  // Regression guard for a real defect caught in R1 review: the first draft of
  // URL_USERINFO_PATTERN used an UNBOUNDED `[a-z0-9+.-]*` scheme prefix. Every
  // long lowercase run became an O(n²) backtrack — this exact input took
  // 1.2 SECONDS, and a 1MB one never finished. redact() runs on every log line,
  // so that is an event-loop stall reachable from upstream error text.
  // Ceiling is deliberately loose (CI machines vary); the defect was 1000x over.
  test('50KB lowercase run with no @ does not backtrack', () => {
    const adversarial = `a://${'x'.repeat(50_000)}`;
    const t0 = performance.now();
    const out = redact(adversarial);
    const elapsedMs = performance.now() - t0;
    process.stderr.write(`[#22 bench] 50KB no-@ backtrack probe: ${elapsedMs.toFixed(3)} ms\n`);
    expect(elapsedMs).toBeLessThan(100);
    // Sanity: nothing matched, so the bench measured the reject path (the
    // expensive one) rather than an early-exit.
    expect(out).toBe(adversarial);
  });
});
