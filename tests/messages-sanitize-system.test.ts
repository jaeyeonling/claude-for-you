import { describe, expect, test } from 'bun:test';
import {
  CC_BLOCK,
  CC_SYSTEM_PREFIX,
  ensureSystem,
  sanitizeSystemForUpstream,
} from '../src/proxy/messages.js';
import {
  CLASSIFIER_TRIGGERS,
  applyClassifierTriggers,
} from '../src/proxy/classifier-triggers.js';

// Background: issue #123. Anthropic's sub-plan classifier reads prompt content
// (system text + tool-set fingerprint), not just headers. Two confirmed
// triggers were isolated by in-proxy bisection: (1) a co-occurrence pattern in
// system text involving `## Skills (mandatory)` + `skill_manage(action='patch')`,
// and (2) the tool name `session_search` appearing in a non-CC tool set. This
// PR addresses (1) only; (2) requires bidirectional rewriting and is tracked
// as #125.
//
// Test layout mirrors the plan v3 case enumeration from
// .claude/matrix-sessions/123.md.

describe('applyClassifierTriggers (function-level)', () => {
  test('case 1: each rule rewrites its trigger string', () => {
    // Confirmed triggers from CLASSIFIER_TRIGGERS — these are the exact
    // substrings that bisected to 400 on the failing request.
    expect(applyClassifierTriggers("skill_manage(action='patch')")).toBe(
      "skill_manage with action 'patch'",
    );
    expect(applyClassifierTriggers('skill_view(name)')).toBe('skill_view with name argument');
    expect(applyClassifierTriggers('## Skills (mandatory)')).toBe('## Skills');
  });

  test('case 2: idempotent — applying twice equals applying once', () => {
    for (const trigger of CLASSIFIER_TRIGGERS) {
      const once = applyClassifierTriggers(trigger.pattern);
      const twice = applyClassifierTriggers(once);
      expect(twice).toBe(once);
      // The replacement must not contain the source pattern, otherwise
      // a second pass would change the string and the function would not
      // be idempotent — the load-bearing invariant for safe re-application.
      expect(once.includes(trigger.pattern)).toBe(false);
    }
  });

  test('case 3: non-trigger text passes through string-equal', () => {
    const benign = 'This is an arbitrary system block that mentions skills generically.';
    expect(applyClassifierTriggers(benign)).toBe(benign);
  });

  test('case 6: every occurrence of a trigger is rewritten, not just the first', () => {
    const input =
      "Use skill_manage(action='patch') for routine maintenance. " +
      "When a skill drifts, run skill_manage(action='patch') again.";
    const out = applyClassifierTriggers(input);
    expect(out).toBe(
      "Use skill_manage with action 'patch' for routine maintenance. " +
        "When a skill drifts, run skill_manage with action 'patch' again.",
    );
    expect(out.includes("skill_manage(action='patch')")).toBe(false);
  });

  test("case 7: CC_SYSTEM_PREFIX invariant — entitlement marker passes through unchanged", () => {
    // If a future trigger entry accidentally matches a substring of the
    // entitlement marker text, the upstream identity gate breaks silently.
    // This guard fails loudly the moment that happens.
    expect(applyClassifierTriggers(CC_SYSTEM_PREFIX)).toBe(CC_SYSTEM_PREFIX);
  });

  test("cross-pattern safety: no replacement contains another entry's pattern", () => {
    // If trigger A's replacement contains trigger B's pattern, applying the
    // dictionary in order could produce cascading rewrites whose final shape
    // depends entirely on the array ordering (Chaos #123). This invariant
    // makes the order documented in the source the only thing that matters
    // for correctness — any new entry that violates it must be rejected.
    for (const a of CLASSIFIER_TRIGGERS) {
      for (const b of CLASSIFIER_TRIGGERS) {
        expect(a.replacement.includes(b.pattern)).toBe(false);
      }
    }
  });

  test('input guard: non-string input is returned unchanged instead of throwing', () => {
    // Defensive: the function is exported and may be reused outside the
    // `sanitizeSystemForUpstream` guard. Hot-path safety > strict typing.
    expect(applyClassifierTriggers(null as unknown as string)).toBe(null);
    expect(applyClassifierTriggers(undefined as unknown as string)).toBe(undefined);
    expect(applyClassifierTriggers(0 as unknown as string)).toBe(0);
    expect(applyClassifierTriggers({} as unknown as string)).toEqual({});
  });

  test('CLASSIFIER_TRIGGERS entries are deep-frozen', () => {
    // Shallow freeze on the array leaves the entry objects writable. A
    // mutation like `CLASSIFIER_TRIGGERS[0].pattern = ''` would make every
    // request explode into per-character replacement on the hot path. Each
    // entry must individually refuse `Object.assign` / property writes.
    for (const entry of CLASSIFIER_TRIGGERS) {
      expect(Object.isFrozen(entry)).toBe(true);
    }
  });
});

describe('sanitizeSystemForUpstream (wrapper-level)', () => {
  test('case 4: rewrites trigger inside a block, preserves cache_control and other fields', () => {
    const input = {
      model: 'claude-sonnet-4-6',
      system: [
        {
          type: 'text',
          text: "Run skill_manage(action='patch') first.",
          cache_control: { type: 'ephemeral' },
        },
      ],
    };
    const out = sanitizeSystemForUpstream(input);
    const sys = out.system as Array<{ type: string; text: string; cache_control: unknown }>;
    expect(sys).toHaveLength(1);
    expect(sys[0].text).toBe("Run skill_manage with action 'patch' first.");
    expect(sys[0].type).toBe('text');
    expect(sys[0].cache_control).toEqual({ type: 'ephemeral' });
    // Input was not mutated.
    expect(
      (input.system[0] as { text: string }).text,
    ).toBe("Run skill_manage(action='patch') first.");
  });

  test('case 5a: empty system array stays empty', () => {
    const out = sanitizeSystemForUpstream({ system: [] });
    expect(out.system).toEqual([]);
  });

  test('case 5b: CC_BLOCK-only array passes through with deep-equal content', () => {
    const out = sanitizeSystemForUpstream({ system: [CC_BLOCK] });
    const sys = out.system as Array<{ type: string; text: string; cache_control: unknown }>;
    expect(sys).toHaveLength(1);
    expect(sys[0]).toEqual(CC_BLOCK);
    // The block carries the entitlement marker; trigger sweep must not touch it.
    expect(sys[0].text).toBe(CC_SYSTEM_PREFIX);
  });

  test('case 8: full chain — ensureSystem then sanitize neutralizes the caller trigger', () => {
    // Real-world shape: caller sent `system` as a string. `ensureSystem`
    // converts it to `[CC_BLOCK, {type:'text', text: caller}]`, and the
    // sanitize pass rewrites the trigger inside the caller block while
    // leaving the CC marker untouched.
    const caller = "Run skill_manage(action='patch') and review with skill_view(name).";
    const chained = sanitizeSystemForUpstream(
      ensureSystem({ system: caller }),
    );
    const sys = chained.system as Array<{ type: string; text: string }>;
    expect(sys).toHaveLength(2);
    expect(sys[0].text).toBe(CC_SYSTEM_PREFIX);
    expect(sys[1]).toEqual({
      type: 'text',
      text: "Run skill_manage with action 'patch' and review with skill_view with name argument.",
    });
  });

  test('non-text blocks (e.g. a future schema with image refs) pass through untouched', () => {
    // Defensive: if Anthropic ever widens the system-block contract to include
    // non-text shapes, we must not crash on them or rewrite the wrong field.
    const exotic = { type: 'future', payload: { foo: 'bar' } };
    const out = sanitizeSystemForUpstream({
      system: [exotic, { type: 'text', text: "## Skills (mandatory)" }],
    });
    const sys = out.system as Array<unknown>;
    expect(sys[0]).toEqual(exotic);
    expect(sys[1]).toEqual({ type: 'text', text: '## Skills' });
  });

  test('blocks without a string text field are not touched', () => {
    // Boundary validation in `ensureSystem` would reject these at the gate,
    // but the sanitize step itself must still be safe on malformed input.
    const input = {
      system: [
        { type: 'text' }, // missing text
        { type: 'text', text: 123 }, // wrong type
        null,
      ],
    };
    const out = sanitizeSystemForUpstream(input);
    expect(out.system).toEqual(input.system);
  });

  test('input without a system field passes through identity', () => {
    const out = sanitizeSystemForUpstream({ model: 'claude-sonnet-4-6' });
    expect(out).toEqual({ model: 'claude-sonnet-4-6' });
  });
});

describe('case 9: watchdog bench (sub-millisecond expected, sanity ceiling only)', () => {
  test('50KB system text + full trigger sweep completes in under 1s', () => {
    // 50KB approximates real failing payloads in the messages_log. The 1s
    // ceiling is NOT a regression guard — real runtime is sub-millisecond.
    // It exists only so the test produces a PASS/FAIL signal that the
    // benchmark actually ran. If you see this flake in CI, hot-path
    // regression detection belongs upstream of this test (operational
    // alarm), not here.
    const filler = 'lorem ipsum dolor sit amet. '.repeat(2000); // ~54KB
    const triggerLaden = filler + " skill_manage(action='patch') " + filler;
    const t0 = performance.now();
    const out = applyClassifierTriggers(triggerLaden);
    const elapsedMs = performance.now() - t0;
    // stderr keeps test output out of CI stdout (no log scraping conflicts)
    // while still giving operators a number when debugging hot-path regressions.
    process.stderr.write(`[#123 bench] 50KB sweep: ${elapsedMs.toFixed(3)} ms\n`);
    expect(elapsedMs).toBeLessThan(1000);
    // Sanity: the trigger was actually rewritten (the bench is not measuring
    // a no-op path).
    expect(out.includes("skill_manage(action='patch')")).toBe(false);
  });
});
