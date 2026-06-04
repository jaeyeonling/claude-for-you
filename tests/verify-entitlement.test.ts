import { describe, expect, test } from 'bun:test';
import {
  classifyEntitlement,
  isEntitlementModelAllowed,
} from '../src/admin/test-runners.js';

describe('isEntitlementModelAllowed', () => {
  // The gate only applies to sonnet/opus on Claude.ai-OAuth tokens. The
  // whitelist is the quota-abuse guard from #40 H1 (Adversary + Watchdog).
  test('allows current sonnet/opus model ids', () => {
    expect(isEntitlementModelAllowed('claude-sonnet-4-6')).toBe(true);
    expect(isEntitlementModelAllowed('claude-opus-4-7')).toBe(true);
    expect(isEntitlementModelAllowed('claude-opus-4-5')).toBe(true);
  });

  test('rejects haiku (no gate, would always inconclusive)', () => {
    expect(isEntitlementModelAllowed('claude-haiku-4-5')).toBe(false);
    expect(isEntitlementModelAllowed('claude-haiku-4-5-20251001')).toBe(false);
  });

  test('rejects empty / placeholder / non-anthropic ids', () => {
    expect(isEntitlementModelAllowed('')).toBe(false);
    expect(isEntitlementModelAllowed('gpt-4')).toBe(false);
    expect(isEntitlementModelAllowed('claude')).toBe(false);
    expect(isEntitlementModelAllowed('claude-sonnet')).toBe(false); // missing tail
  });

  test('rejects sneaky partial matches (anchored regex)', () => {
    // Without `^`/`$`, "claude-haiku-sonnet-something" or
    // "x claude-sonnet-4-6 y" might slip through.
    expect(isEntitlementModelAllowed('claude-haiku-sonnet-x')).toBe(false);
    expect(isEntitlementModelAllowed('prefix-claude-sonnet-4-6')).toBe(false);
    expect(isEntitlementModelAllowed('claude-sonnet-4-6 ; rm -rf /')).toBe(
      false,
    );
  });
});

describe('classifyEntitlement', () => {
  // The four canonical quadrants from #40 plan.
  test('(200, 429) → ok (marker is gating sonnet correctly)', () => {
    const r = classifyEntitlement(200, 429);
    expect(r.verdict).toBe('ok');
    expect(r.ok).toBe(true);
  });

  test('(200, 200) → marker-drift (sonnet passes WITHOUT marker — #41 regression signature)', () => {
    const r = classifyEntitlement(200, 200);
    expect(r.verdict).toBe('marker-drift');
    expect(r.ok).toBe(false);
  });

  test('(429, 429) → account-issue (both fail — not a marker problem)', () => {
    const r = classifyEntitlement(429, 429);
    expect(r.verdict).toBe('account-issue');
    expect(r.ok).toBe(false);
  });

  test('(429, 200) → reversed (signal inverted — needs wire recapture)', () => {
    const r = classifyEntitlement(429, 200);
    expect(r.verdict).toBe('reversed');
    expect(r.ok).toBe(false);
  });

  // Inconclusive umbrella — anything that isn't a clean 200/429 pair.
  test('transport error on A → inconclusive', () => {
    const r = classifyEntitlement(0, 429, 'ECONNRESET', undefined);
    expect(r.verdict).toBe('inconclusive');
    expect(r.ok).toBe(false);
  });

  test('transport error on B → inconclusive', () => {
    const r = classifyEntitlement(200, 0, undefined, 'fetch timeout');
    expect(r.verdict).toBe('inconclusive');
    expect(r.ok).toBe(false);
  });

  test('transport error on both → inconclusive', () => {
    const r = classifyEntitlement(0, 0, 'dns', 'dns');
    expect(r.verdict).toBe('inconclusive');
    expect(r.ok).toBe(false);
  });

  test('unexpected status pair (500, 200) → inconclusive', () => {
    // 5xx says nothing about marker effectiveness. We refuse to guess.
    const r = classifyEntitlement(500, 200);
    expect(r.verdict).toBe('inconclusive');
    expect(r.ok).toBe(false);
  });

  test('unexpected status pair (400, 400) → inconclusive', () => {
    const r = classifyEntitlement(400, 400);
    expect(r.verdict).toBe('inconclusive');
    expect(r.ok).toBe(false);
  });

  test('error string but status=200 → inconclusive (error wins)', () => {
    // Defensive: if the caller hands us BOTH a status and an error, we treat
    // it as inconclusive rather than silently ignore the error signal.
    const r = classifyEntitlement(200, 429, 'flaky tls', undefined);
    expect(r.verdict).toBe('inconclusive');
    expect(r.ok).toBe(false);
  });

  // ok is the ONLY verdict that sets ok=true. Every other path must be
  // operator-actionable, which means ok=false.
  test('only ok verdict sets ok=true', () => {
    expect(classifyEntitlement(200, 429).ok).toBe(true);
    expect(classifyEntitlement(200, 200).ok).toBe(false);
    expect(classifyEntitlement(429, 429).ok).toBe(false);
    expect(classifyEntitlement(429, 200).ok).toBe(false);
    expect(classifyEntitlement(0, 0, 'x', 'y').ok).toBe(false);
    expect(classifyEntitlement(500, 500).ok).toBe(false);
  });
});
