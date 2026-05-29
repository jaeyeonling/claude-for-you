import { describe, expect, test } from 'bun:test';
import {
  createExtractedTemplate,
  mergeAndFilterAnthropicBeta,
} from '../src/template/extracted.js';

const BASELINE =
  'claude-code-20250219,interleaved-thinking-2025-05-14,prompt-caching-scope-2026-01-05';

describe('mergeAndFilterAnthropicBeta', () => {
  test('preserves baseline when client sends nothing', () => {
    const { value, stripped } = mergeAndFilterAnthropicBeta(BASELINE, '');

    expect(value.split(',').sort()).toEqual(BASELINE.split(',').sort());
    expect(stripped).toEqual([]);
  });

  test('unions baseline with client-only flags', () => {
    const { value, stripped } = mergeAndFilterAnthropicBeta(
      BASELINE,
      'oauth-2025-04-20,advisor-tool-2026-03-01',
    );

    const flags = new Set(value.split(','));
    expect(flags.has('claude-code-20250219')).toBe(true);
    expect(flags.has('oauth-2025-04-20')).toBe(true);
    expect(flags.has('advisor-tool-2026-03-01')).toBe(true);
    expect(stripped).toEqual([]);
  });

  test('passes context-1m through (OAuth + 1M is now confirmed working)', () => {
    // 2026-05-29: real CC v2.1.145 sends `context-1m-2025-08-07` over OAuth
    // and upstream returns 200 (verified by mitmproxy capture against a Pro
    // account). The earlier strip was a misdiagnosis caused by our URL
    // omitting `?beta=true`. Filter is now empty by default.
    const { value, stripped } = mergeAndFilterAnthropicBeta(
      BASELINE,
      'context-1m-2025-08-07,oauth-2025-04-20',
    );

    expect(value).toContain('context-1m-2025-08-07');
    expect(value).toContain('oauth-2025-04-20');
    expect(value).toContain('claude-code-20250219');
    expect(stripped).toEqual([]);
  });

  test('deduplicates when client repeats a baseline flag', () => {
    const { value } = mergeAndFilterAnthropicBeta(BASELINE, 'claude-code-20250219');

    const occurrences = value.split(',').filter((f) => f === 'claude-code-20250219');
    expect(occurrences.length).toBe(1);
  });

  test('tolerates whitespace and empty segments in the client value', () => {
    const { value, stripped } = mergeAndFilterAnthropicBeta(
      BASELINE,
      '  context-1m-2025-08-07 , , oauth-2025-04-20  ',
    );

    expect(value.split(',')).toContain('oauth-2025-04-20');
    expect(value.split(',')).toContain('context-1m-2025-08-07');
    expect(stripped).toEqual([]);
  });

  test('returns empty string when both inputs are empty', () => {
    const { value, stripped } = mergeAndFilterAnthropicBeta('', '');

    expect(value).toBe('');
    expect(stripped).toEqual([]);
  });
});

describe('createExtractedTemplate apply() — wrapper integration', () => {
  // Guards the seam between mergeAnthropicBeta (which logs) and
  // mergeAndFilterAnthropicBeta (the pure helper). If someone refactors and
  // forgets to call the helper, or wires clientHeaders wrong, only this test
  // catches it — the pure tests above pass even if the wrapper bypasses them.
  test('forwards context-1m through to upstream (OAuth + 1M works)', async () => {
    const template = createExtractedTemplate();
    const clientHeaders = new Headers({
      'anthropic-beta': 'context-1m-2025-08-07,oauth-2025-04-20',
    });

    const outbound = await template.apply({
      clientBody: { model: 'claude-opus-4-7', messages: [] },
      accessToken: 'sk-ant-test-token',
      clientHeaders,
    });

    const sentBeta = outbound.headers['anthropic-beta'] ?? '';
    expect(sentBeta).toContain('context-1m-2025-08-07');
    expect(sentBeta).toContain('oauth-2025-04-20');
  });

  test('URL includes ?beta=true (required for upstream beta-flag gating)', async () => {
    const template = createExtractedTemplate();
    const outbound = await template.apply({
      clientBody: { model: 'claude-sonnet-4-6', messages: [] },
      accessToken: 'sk-ant-test-token',
      clientHeaders: undefined,
    });
    expect(outbound.url).toContain('?beta=true');
  });
});
