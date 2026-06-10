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

  test('passes innocuous text through unchanged', () => {
    expect(redact('hello world')).toBe('hello world');
    expect(redact('failed to read /tmp/data: ENOENT')).toBe('failed to read /tmp/data: ENOENT');
  });
});
