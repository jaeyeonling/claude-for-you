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
