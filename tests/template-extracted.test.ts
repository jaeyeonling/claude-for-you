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

  test('strips context-1m flag from client and reports it', () => {
    const { value, stripped } = mergeAndFilterAnthropicBeta(
      BASELINE,
      'context-1m-2025-08-07,oauth-2025-04-20',
    );

    expect(value).not.toContain('context-1m');
    expect(value).toContain('oauth-2025-04-20');
    expect(value).toContain('claude-code-20250219');
    expect(stripped).toEqual(['context-1m-2025-08-07']);
  });

  test('strips future context-1m version variants via prefix match', () => {
    const { value, stripped } = mergeAndFilterAnthropicBeta(BASELINE, 'context-1m-2099-12-31');

    expect(value).not.toContain('context-1m');
    expect(stripped).toEqual(['context-1m-2099-12-31']);
  });

  test('strips context-1m even when present in the baseline', () => {
    // Defensive: if a future snapshot accidentally bakes context-1m into the
    // baseline, filter must still drop it. The gateway constraint is at the
    // upstream-auth layer, not at the source of the flag.
    const { value, stripped } = mergeAndFilterAnthropicBeta(
      `${BASELINE},context-1m-2025-08-07`,
      '',
    );

    expect(value).not.toContain('context-1m');
    expect(stripped).toEqual(['context-1m-2025-08-07']);
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

    expect(value).not.toContain('context-1m');
    expect(value.split(',')).toContain('oauth-2025-04-20');
    expect(stripped).toEqual(['context-1m-2025-08-07']);
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
  test('strips context-1m from a real Headers object when going through apply()', async () => {
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
    expect(sentBeta).not.toContain('context-1m');
    expect(sentBeta).toContain('oauth-2025-04-20');
  });
});
