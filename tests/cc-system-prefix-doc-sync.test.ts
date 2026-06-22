import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { CC_SYSTEM_PREFIX, CC_BLOCK, isCanonicalCcMarker } from '../src/proxy/messages.js';

// The CC entitlement marker has TWO authoritative locations:
//   - src/proxy/messages.ts (the runtime value used by the proxy)
//   - docs/cc-wire-reference.md Section 2a (the operator-facing pin)
//
// #41 hardened the proxy side; #40 added the drift probe; this test is the
// CI gate that prevents silent doc drift — if the constant is bumped but
// Section 2a is forgotten, future operators will read a stale invariant
// and misdiagnose the next regression exactly the way 2026-06-02 played out.
describe('CC_SYSTEM_PREFIX docs sync', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const docPath = resolve(here, '..', 'docs', 'cc-wire-reference.md');
  const docText = readFileSync(docPath, 'utf8');

  test('cc-wire-reference.md contains the exact CC_SYSTEM_PREFIX value', () => {
    // We assert verbatim substring presence — no regex escaping subtleties,
    // no partial match. If the constant changes, this test fails and the
    // author must update the doc in the same PR.
    expect(docText.includes(CC_SYSTEM_PREFIX)).toBe(true);
  });

  test('cc-wire-reference.md has a Section 2a entitlement-marker block', () => {
    // Belt-and-suspenders: also guard the heading. Catches the case where
    // a future refactor moves the value out of Section 2a entirely.
    expect(docText).toMatch(/##\s*2a\.\s*Entitlement marker invariant/);
  });

  test("cc-wire-reference.md §2a documents the cache_control: ephemeral anchor (#55)", () => {
    // Issue #55: CC_BLOCK carries cache_control: { type: 'ephemeral' } as a
    // prompt-cache prefix anchor. If a future refactor silently drops that
    // field from the doc, operators read a stale invariant — the same class
    // of misdiagnosis the prefix-existence guards above were built to prevent.
    // We assert the verbatim substring so the doc stays sync'd with the
    // runtime CC_BLOCK shape.
    expect(docText).toContain("cache_control: { type: 'ephemeral' }");
  });

  test('CC_BLOCK itself is a canonical CC marker (definitional consistency, #96)', () => {
    // The proxy-emitted CC_BLOCK and caller-emitted canonical blocks share the
    // same wire shape (this is what makes the transparent-passthrough branch
    // ToS-coherent — see pitfall #15 threat model). If a future change to
    // CC_BLOCK or isCanonicalCcMarker breaks this self-consistency, the
    // transparent branch silently stops working for real CC traffic and
    // cache hit% regresses without any other test failing.
    expect(isCanonicalCcMarker(CC_BLOCK)).toBe(true);
  });

  test('cc-wire-reference.md §2a documents the canonical-shape match conditions (#96)', () => {
    // The "Canonical CC marker shape" subsection lists three conditions that
    // mirror `isCanonicalCcMarker` (type, text, cache_control). Substring
    // checks for the key fragments — narrow enough to catch silent rewords
    // that drop a condition, broad enough to survive prose tweaks.
    expect(docText).toContain('text === CC_SYSTEM_PREFIX');
    expect(docText).toContain("cache_control.type === 'ephemeral'");
  });

  // #136 made the prepend cap-aware: a caller already at the 4-breakpoint
  // ceiling gets CC_BLOCK_NO_CACHE (no cache_control) instead of CC_BLOCK, so
  // the proxy's +1 doesn't overflow Anthropic's limit. Same doc-drift class the
  // #55 ephemeral-anchor guard above defends. Two SEPARATE tests so a failure
  // names exactly which substring drifted (a single combined assert would only
  // report "expected true, received false" — the 2026-06-02 misdiagnosis class).
  test('cc-wire-reference.md §2a names the CC_BLOCK_NO_CACHE constant (#136)', () => {
    expect(docText).toContain('CC_BLOCK_NO_CACHE');
  });

  test('cc-wire-reference.md §2a documents the 4-breakpoint ceiling phrase (#136)', () => {
    expect(docText).toContain('4-breakpoint ceiling');
  });
});
