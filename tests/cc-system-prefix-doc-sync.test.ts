import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { CC_SYSTEM_PREFIX } from '../src/proxy/messages.js';

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
});
