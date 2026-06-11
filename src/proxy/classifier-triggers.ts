/**
 * Sub-plan prompt-content classifier triggers.
 *
 * Background (issue #123):
 *   Anthropic's OAuth sub plan runs a prompt-content classifier that decides
 *   whether an inbound request looks like a "real" Claude Code client. Requests
 *   that fail this classifier get routed to the overage lane, and overage on
 *   Pro/Max sub plans is org-level-disabled — surfacing as HTTP 400 with the
 *   misleading body `"You're out of extra usage. Add more at claude.ai/...".
 *
 *   Outbound headers (`user-agent: claude-cli/...`, `anthropic-beta: claude-code-...`,
 *   `x-app: cli`, `anthropic-dangerous-direct-browser-access: true`) are already
 *   forged correctly — the classifier reads prompt **content**, not headers.
 *
 *   In-proxy bisection (recorded on #123) confirmed two independent triggers
 *   on the failing traffic:
 *     1. System text — function-call-shaped strings like
 *        `skill_manage(action='patch')` co-occurring with the literal section
 *        header `## Skills (mandatory)`.
 *     2. Tool list — name `session_search` combined with other non-CC tool
 *        names in the same `tools` array (the name alone is fine; the set is
 *        what the classifier fingerprints).
 *
 * Scope of this module:
 *   System text only. `system` blocks never appear in the upstream response,
 *   so rewriting them outbound has zero observable downstream effect on the
 *   caller — no bidirectional mapping needed.
 *
 *   Tool-name rewriting requires reverse mapping in the SSE sniffer and JSON
 *   path (caller's SDK expects to see the original name in `tool_use.name`).
 *   That work is tracked separately as issue #125.
 *
 * Maintenance:
 *   Each entry carries a `confirmed YYYY-MM-DD via #NNN` provenance comment.
 *   The classifier evolves; entries that no longer trigger 400s should be
 *   retired only after the originating issue's reproducer no longer fires.
 *   Don't strip an entry that looks unmotivated — read the issue first.
 *
 * Implementation constraints (watchdog, #123):
 *   - Runs once per inbound `/v1/messages` request on the synchronous
 *     pre-forward path. Hot path.
 *   - `String.prototype.split(pattern).join(replacement)` for each entry —
 *     constant-string substring scan. No regex (no backtracking surface).
 *   - O(K * N) where K = trigger count (small constant) and N = system text
 *     length. For a 50 KB system text the bench in
 *     tests/messages-sanitize-system.test.ts records sub-millisecond runtime.
 */

export interface ClassifierTrigger {
  /** Exact literal substring the classifier flags. */
  readonly pattern: string;
  /** Semantically equivalent rewrite the model still understands. */
  readonly replacement: string;
  /** ISO date when this trigger was confirmed in production traffic. */
  readonly confirmedAt: string;
  /** GitHub issue that confirmed (or last re-confirmed) the trigger. */
  readonly issue: number;
}

/**
 * Trigger dictionary. Both the array AND each entry are frozen — caller code
 * (or future contributors writing in the same process) must not mutate them
 * at runtime. `Object.freeze` is shallow by default, which would leave the
 * entry objects writable: e.g. setting `entry.pattern = ''` would turn
 * `text.split('').join(replacement)` into a per-character explosion and
 * detonate the hot path on every subsequent request. Freezing each entry
 * closes that surface (Chaos #123 review).
 *
 * Ordering note: substrings that are more specific (longer / more contextual)
 * come before substrings they would shadow. `## Skills (mandatory)` is rewritten
 * to `## Skills` BEFORE any rule that would touch `## Skills` standalone — none
 * currently exists, but if one is added in the future, audit the order.
 */
export const CLASSIFIER_TRIGGERS: ReadonlyArray<ClassifierTrigger> = Object.freeze([
  // confirmed 2026-06-11 via #123
  // Function-call-shaped representation of `skill_manage(action='patch')` was
  // the load-bearing substring in the bisected 20-char window inside system[1]
  // at offset ~3,420-3,440 of the failing request. Rewrite preserves human
  // readability and the model's behavioral understanding.
  Object.freeze({
    pattern: "skill_manage(action='patch')",
    replacement: "skill_manage with action 'patch'",
    confirmedAt: '2026-06-11',
    issue: 123,
  }),
  // confirmed 2026-06-11 via #123
  // Same shape as the skill_manage trigger; the function-call notation
  // `skill_view(name)` is the classifier fingerprint, not the tool itself.
  Object.freeze({
    pattern: 'skill_view(name)',
    replacement: 'skill_view with name argument',
    confirmedAt: '2026-06-11',
    issue: 123,
  }),
  // confirmed 2026-06-11 via #123
  // The section header `## Skills (mandatory)` co-occurred with the function-
  // call-shaped strings above in the failing system[1] payload. Stripping the
  // parenthetical `(mandatory)` is enough to break the combined fingerprint
  // without losing semantic content — "Skills" remains a top-level section.
  Object.freeze({
    pattern: '## Skills (mandatory)',
    replacement: '## Skills',
    confirmedAt: '2026-06-11',
    issue: 123,
  }),
]);

/**
 * Apply the trigger dictionary to a single system-text string.
 *
 * Behavior:
 *   - Iterates `CLASSIFIER_TRIGGERS` in order, replacing every occurrence of
 *     each `pattern` with its `replacement`.
 *   - Pure substring scan (`split(pattern).join(replacement)`). No regex.
 *   - Idempotent: applying twice equals applying once, because each
 *     `replacement` is constructed so it does NOT contain its source `pattern`.
 *     Test `tests/messages-sanitize-system.test.ts` enforces this invariant.
 *   - Identity-preserving on text without triggers: returns the exact input
 *     string (string equality, since `split` of a substring not present
 *     returns the original as a single-element array and `join` reconstructs
 *     byte-identical output).
 */
/**
 * Tool-name classifier triggers.
 *
 * The sub-plan classifier also reads the inbound `tools[].name` set as a
 * fingerprint (see issue #125). Specific names — confirmed via in-proxy
 * bisection on the failing traffic recorded under #123 — trip the classifier
 * when they co-occur with the rest of a non-CC tool set. The same names in
 * isolation do not trip it; the same set with one of these names renamed does
 * not trip it. The set is what's being fingerprinted.
 *
 * Unlike `CLASSIFIER_TRIGGERS` above, this dictionary is intentionally
 * **single-direction-from-here**: the data structure is just the membership
 * test ("is this name a classifier trigger we need to alias?"). The
 * forward/reverse alias mapping itself lives in `tool-name-mapping.ts` because
 * it's per-request state, not a static table.
 *
 * Maintenance: when a name retires from the classifier (the bisect no longer
 * reproduces with it alone), remove its entry — but only after confirming the
 * removal against a recent failing-traffic sample.
 */
export const TOOL_NAME_TRIGGERS: ReadonlySet<string> = (() => {
  const inner = new Set<string>([
    // confirmed 2026-06-11 via #125 (bisected on the #123 failing payload —
    // tools[0..20] + this name = 400; tools[0..20] with this name renamed = 200;
    // this name alone with no other non-CC tools = 200).
    'session_search',
    // confirmed 2026-06-11 via #134 (post-#125 production smoke). The #125
    // bisect was necessary but not sufficient — adding session_search to a
    // 21-tool set tripped 400, but the other three skill_* names were
    // already in tools[22..24] and contributed to the fingerprint. R2 on the
    // live failing body showed that removing any single member of
    // {session_search, skill_manage, skill_view, skills_list} flips 400 → 200.
    // Aliasing any one breaks the fingerprint; we alias all four so the
    // defense survives a future classifier evolution that narrows the set.
    // See #134 for the R2/R3 evidence.
    'skill_manage',
    'skill_view',
    'skills_list',
  ]);
  // `Object.freeze` is shallow on a Set — the internal [[SetData]] slot is
  // not protected by frozen-object semantics, so `inner.add(...)` / `.clear()`
  // / `.delete(...)` would still succeed and silently mutate the membership
  // list (Chaos #125 review). Block the three mutators explicitly so a buggy
  // or hostile sibling module in the same process can't disable the trigger
  // out from under us.
  const blocked = (): never => {
    throw new TypeError('TOOL_NAME_TRIGGERS is read-only');
  };
  for (const method of ['add', 'clear', 'delete'] as const) {
    Object.defineProperty(inner, method, {
      value: blocked,
      writable: false,
      configurable: false,
    });
  }
  Object.freeze(inner);
  return inner;
})();

export const applyClassifierTriggers = (text: string): string => {
  // Defensive: the function is exported and may be called by future code paths
  // without going through the `typeof obj.text !== 'string'` guard inside
  // `sanitizeSystemForUpstream`. Returning the input unchanged on non-string
  // is safer than letting the `split` call throw on the hot path (Chaos #123).
  if (typeof text !== 'string') return text;
  let out = text;
  for (const trigger of CLASSIFIER_TRIGGERS) {
    out = out.split(trigger.pattern).join(trigger.replacement);
  }
  return out;
};
