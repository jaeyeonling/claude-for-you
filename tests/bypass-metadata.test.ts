import { describe, expect, test } from 'bun:test';
import { buildBypassMetadata } from '../src/usage/bypass-metadata.js';

describe('buildBypassMetadata', () => {
  test('keeps allowlisted inbound headers and drops unknown / sensitive ones', () => {
    const inbound = new Headers({
      'anthropic-beta': 'context-1m-2025-08-07',
      'anthropic-version': '2023-06-01',
      'x-claude-code-session-id': 'sess-abc',
      'x-stainless-package-version': '0.34.0',
      cookie: 'session=secret-do-not-log',
      'x-forwarded-for': '10.0.0.1',
    });
    const m = buildBypassMetadata({
      inboundHeaders: inbound,
      outboundHeaders: {},
      upstreamHeaders: new Headers(),
      canary: { useCandidate: false },
    });
    expect(m.inboundHeaders['anthropic-beta']).toBe('context-1m-2025-08-07');
    expect(m.inboundHeaders['anthropic-version']).toBe('2023-06-01');
    expect(m.inboundHeaders['x-claude-code-session-id']).toBe('sess-abc');
    expect(m.inboundHeaders['x-stainless-package-version']).toBe('0.34.0');
    expect(m.inboundHeaders.cookie).toBeUndefined();
    expect(m.inboundHeaders['x-forwarded-for']).toBeUndefined();
  });

  test('non-allowlisted headers surface as name+length fingerprints', () => {
    const inbound = new Headers({
      'anthropic-beta': 'context-1m-2025-08-07',
      cookie: 'session=secret-do-not-log',
      'x-mystery': 'abcd',
    });
    const m = buildBypassMetadata({
      inboundHeaders: inbound,
      outboundHeaders: { authorization: 'Bearer x', 'x-internal-tag': 'qq' },
      upstreamHeaders: new Headers({ 'request-id': 'r', 'x-edge-cache': 'MISS' }),
      canary: { useCandidate: false },
    });

    // Values are NEVER in the unknown set, only name+length.
    const inboundNames = m.unknownInboundHeaders.map((h) => h.name);
    expect(inboundNames).toContain('cookie');
    expect(inboundNames).toContain('x-mystery');
    expect(inboundNames).not.toContain('anthropic-beta');
    const cookie = m.unknownInboundHeaders.find((h) => h.name === 'cookie');
    expect(cookie?.length).toBe('session=secret-do-not-log'.length);

    // Outbound + upstream same shape.
    expect(m.unknownOutboundHeaders.map((h) => h.name)).toEqual(['x-internal-tag']);
    expect(m.unknownUpstreamHeaders.map((h) => h.name)).toEqual(['x-edge-cache']);

    // Sorted lexicographically.
    const sorted = [...inboundNames].sort((a, b) => a.localeCompare(b));
    expect(inboundNames).toEqual(sorted);
  });

  test('redacts Bearer token in outbound authorization', () => {
    const m = buildBypassMetadata({
      inboundHeaders: new Headers(),
      outboundHeaders: {
        authorization: 'Bearer sk-ant-abcdefghijklmnopqrstuvwxyz0123456789',
        'anthropic-beta': 'oauth-2025-04-20',
      },
      upstreamHeaders: new Headers(),
      canary: { useCandidate: false },
    });
    expect(m.outboundHeaders.authorization).toBe('[REDACTED]');
    expect(m.outboundHeaders['anthropic-beta']).toBe('oauth-2025-04-20');
  });

  test('keeps upstream ratelimit + request-id headers', () => {
    const upstream = new Headers({
      'request-id': 'req_abc123',
      'anthropic-ratelimit-tokens-remaining': '5000',
      'anthropic-organization-id': 'org_xyz',
      'set-cookie': 'tracker=nope',
    });
    const m = buildBypassMetadata({
      inboundHeaders: new Headers(),
      outboundHeaders: {},
      upstreamHeaders: upstream,
      canary: { useCandidate: true },
    });
    expect(m.upstreamHeaders['request-id']).toBe('req_abc123');
    expect(m.upstreamHeaders['anthropic-ratelimit-tokens-remaining']).toBe('5000');
    expect(m.upstreamHeaders['anthropic-organization-id']).toBe('org_xyz');
    expect(m.upstreamHeaders['set-cookie']).toBeUndefined();
    expect(m.canary.useCandidate).toBe(true);
  });

  test('header names are normalized to lowercase', () => {
    const m = buildBypassMetadata({
      inboundHeaders: new Headers({ 'Anthropic-Beta': 'x' }),
      outboundHeaders: { 'Anthropic-Beta': 'y' },
      upstreamHeaders: new Headers({ 'Request-Id': 'z' }),
      canary: { useCandidate: false },
    });
    expect(m.inboundHeaders['anthropic-beta']).toBe('x');
    expect(m.outboundHeaders['anthropic-beta']).toBe('y');
    expect(m.upstreamHeaders['request-id']).toBe('z');
  });
});
