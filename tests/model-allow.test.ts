import { describe, expect, test } from 'bun:test';
import { assertValidModelPattern, isModelAllowed } from '../src/auth/model-allow.js';

describe('isModelAllowed', () => {
  test('undefined patterns means no restriction', () => {
    expect(isModelAllowed('claude-opus-4-7', undefined)).toBe(true);
    expect(isModelAllowed('anything-at-all', undefined)).toBe(true);
  });

  test('empty patterns means no restriction (backward compat with keystores written before the field existed)', () => {
    expect(isModelAllowed('claude-opus-4-7', [])).toBe(true);
  });

  test('exact match', () => {
    expect(isModelAllowed('claude-haiku-4-5-20251001', ['claude-haiku-4-5-20251001'])).toBe(true);
    expect(isModelAllowed('claude-haiku-4-5-20251001', ['claude-haiku-4-5'])).toBe(false);
  });

  test('prefix wildcard matches model family', () => {
    expect(isModelAllowed('claude-haiku-4-5-20251001', ['claude-haiku-*'])).toBe(true);
    expect(isModelAllowed('claude-haiku-4-5', ['claude-haiku-*'])).toBe(true);
    expect(isModelAllowed('claude-sonnet-4-6', ['claude-haiku-*'])).toBe(false);
    expect(isModelAllowed('claude-opus-4-7', ['claude-haiku-*'])).toBe(false);
  });

  test('any matching pattern is enough', () => {
    const allow = ['claude-haiku-*', 'claude-sonnet-4-6'];
    expect(isModelAllowed('claude-haiku-4-5-20251001', allow)).toBe(true);
    expect(isModelAllowed('claude-sonnet-4-6', allow)).toBe(true);
    expect(isModelAllowed('claude-sonnet-4-5', allow)).toBe(false);
    expect(isModelAllowed('claude-opus-4-7', allow)).toBe(false);
  });

  test('wildcard at root matches everything (escape hatch — operationally discouraged)', () => {
    expect(isModelAllowed('any-model', ['*'])).toBe(true);
  });
});

describe('assertValidModelPattern', () => {
  test('accepts exact ids and trailing-wildcard families', () => {
    expect(() => assertValidModelPattern('claude-haiku-4-5-20251001')).not.toThrow();
    expect(() => assertValidModelPattern('claude-sonnet-*')).not.toThrow();
    expect(() => assertValidModelPattern('*')).not.toThrow();
  });

  test('rejects empty string', () => {
    expect(() => assertValidModelPattern('')).toThrow(/non-empty/);
  });

  test('rejects multiple wildcards', () => {
    expect(() => assertValidModelPattern('claude-*-opus-*')).toThrow(/more than one/);
  });

  test('rejects wildcard at non-trailing position', () => {
    expect(() => assertValidModelPattern('claude-*-opus')).toThrow(/trailing suffix/);
    expect(() => assertValidModelPattern('*-opus')).toThrow(/trailing suffix/);
  });

  test('accepts pattern at the 128-char boundary, rejects 129+', () => {
    // Real Anthropic ids top out near 30 chars; the cap exists to keep
    // isModelAllowed bounded on the hot auth path, not to constrain
    // legitimate naming. A pattern just below the cap should pass.
    const at = 'a'.repeat(128);
    const over = 'a'.repeat(129);
    expect(() => assertValidModelPattern(at)).not.toThrow();
    expect(() => assertValidModelPattern(over)).toThrow(/too long/);
  });
});
