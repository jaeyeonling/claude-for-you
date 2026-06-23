import { describe, expect, test } from 'bun:test';
import { createGlobalGuard } from '../src/usage/global.js';
import { DomainError } from '../src/lib/errors.js';

const headers = (init: Record<string, string> = {}): Headers => new Headers(init);

describe('createGlobalGuard', () => {
  test('observes unified-remaining and blocks the next request below the threshold', () => {
    // Arrange
    const guard = createGlobalGuard({ thresholdTokens: 1000 });

    // Act
    guard.observeHeaders(headers({ 'anthropic-ratelimit-unified-remaining': '500' }));

    // Assert
    expect(guard.snapshot().remaining).toBe(500);
    expect(() => guard.assertSubscriptionHealthy()).toThrow(DomainError);
  });

  test('the thrown error is a 429 quota_exceeded DomainError', () => {
    const guard = createGlobalGuard({ thresholdTokens: 1000 });
    guard.observeHeaders(headers({ 'anthropic-ratelimit-unified-remaining': '0' }));

    try {
      guard.assertSubscriptionHealthy();
      throw new Error('expected assertSubscriptionHealthy to throw');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(DomainError);
      const e = err as DomainError;
      expect(e.status).toBe(429);
      expect(e.code).toBe('quota_exceeded');
    }
  });

  test('falls back to the legacy tokens-remaining header', () => {
    const guard = createGlobalGuard({ thresholdTokens: 1000 });
    guard.observeHeaders(headers({ 'anthropic-ratelimit-tokens-remaining': '250' }));
    expect(guard.snapshot().remaining).toBe(250);
    expect(() => guard.assertSubscriptionHealthy()).toThrow(DomainError);
  });

  test('admits when headroom is at or above the threshold', () => {
    const guard = createGlobalGuard({ thresholdTokens: 1000 });
    guard.observeHeaders(headers({ 'anthropic-ratelimit-unified-remaining': '1000' }));
    expect(() => guard.assertSubscriptionHealthy()).not.toThrow();
  });

  test('admits when nothing has been observed yet (remaining stays null)', () => {
    // This is the production reality: Anthropic does not emit a numeric
    // *-remaining header, so the guard never has a value to act on.
    const guard = createGlobalGuard({ thresholdTokens: 1000 });
    expect(guard.snapshot().remaining).toBeNull();
    expect(() => guard.assertSubscriptionHealthy()).not.toThrow();
  });

  test('is disabled when the threshold is zero, even after a low observation', () => {
    const guard = createGlobalGuard({ thresholdTokens: 0 });
    guard.observeHeaders(headers({ 'anthropic-ratelimit-unified-remaining': '0' }));
    expect(() => guard.assertSubscriptionHealthy()).not.toThrow();
  });

  test('ignores a non-numeric header value (remaining stays null)', () => {
    const guard = createGlobalGuard({ thresholdTokens: 1000 });
    guard.observeHeaders(headers({ 'anthropic-ratelimit-unified-remaining': 'not-a-number' }));
    expect(guard.snapshot().remaining).toBeNull();
    expect(() => guard.assertSubscriptionHealthy()).not.toThrow();
  });
});
