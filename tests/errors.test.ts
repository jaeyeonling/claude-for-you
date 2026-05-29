import { describe, expect, test } from 'bun:test';
import {
  ConfigError,
  Conflict,
  CsrfFailed,
  DomainError,
  FORBIDDEN_ERROR_HEADERS,
  Forbidden,
  InvalidRequest,
  NotFound,
  QuotaExceeded,
  TooManyRequests,
  Unauthorized,
  UpstreamFailed,
} from '../src/lib/errors.js';

describe('errors factories', () => {
  test('all factories return DomainError with the expected (status, code)', () => {
    const cases: Array<[() => DomainError, number, string]> = [
      [() => Unauthorized(), 401, 'unauthorized'],
      [() => Forbidden(), 403, 'forbidden'],
      [() => QuotaExceeded(), 429, 'quota_exceeded'],
      [() => UpstreamFailed('boom'), 502, 'upstream_failed'],
      [() => ConfigError('missing env'), 500, 'config_error'],
      [() => InvalidRequest('bad'), 400, 'invalid_request'],
      [() => NotFound('missing'), 404, 'not_found'],
      [() => Conflict('dup'), 409, 'conflict'],
      [() => TooManyRequests('cap'), 429, 'too_many_requests'],
      [() => CsrfFailed('origin'), 403, 'csrf_failed'],
    ];
    for (const [factory, status, code] of cases) {
      const err = factory();
      expect(err).toBeInstanceOf(DomainError);
      expect(err.status).toBe(status);
      expect(err.code).toBe(code);
    }
  });

  test('factories with optional code override preserve status', () => {
    expect(InvalidRequest('x', 'custom_code').code).toBe('custom_code');
    expect(Conflict('x', 'key_exists').code).toBe('key_exists');
    expect(NotFound('x', 'gone').code).toBe('gone');
  });

  test('UpstreamFailed accepts status override (e.g. 504 for gateway timeout)', () => {
    expect(UpstreamFailed('slow', 504).status).toBe(504);
  });

  test('TooManyRequests carries optional headers (e.g. Retry-After)', () => {
    const err = TooManyRequests('cap', { 'retry-after': '1' });
    expect(err.headers).toEqual({ 'retry-after': '1' });
  });

  test('FORBIDDEN_ERROR_HEADERS covers hop-by-hop, framing, and sensitive headers', () => {
    // Spot-check the categories — exact membership is documented in errors.ts.
    expect(FORBIDDEN_ERROR_HEADERS.has('connection')).toBe(true); // hop-by-hop
    expect(FORBIDDEN_ERROR_HEADERS.has('transfer-encoding')).toBe(true); // framing
    expect(FORBIDDEN_ERROR_HEADERS.has('content-length')).toBe(true); // framing
    expect(FORBIDDEN_ERROR_HEADERS.has('set-cookie')).toBe(true); // sensitive
    expect(FORBIDDEN_ERROR_HEADERS.has('authorization')).toBe(true); // sensitive
    // Legitimate response metadata must NOT be on the list.
    expect(FORBIDDEN_ERROR_HEADERS.has('retry-after')).toBe(false);
    expect(FORBIDDEN_ERROR_HEADERS.has('www-authenticate')).toBe(false);
  });
});
