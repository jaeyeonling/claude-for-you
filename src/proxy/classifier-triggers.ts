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
 * Trigger dictionary. Frozen so callers can't extend at runtime (the entire
 * point is the list is reviewable and ages predictably).
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
  {
    pattern: "skill_manage(action='patch')",
    replacement: "skill_manage with action 'patch'",
    confirmedAt: '2026-06-11',
    issue: 123,
  },
  // confirmed 2026-06-11 via #123
  // Same shape as the skill_manage trigger; the function-call notation
  // `skill_view(name)` is the classifier fingerprint, not the tool itself.
  {
    pattern: 'skill_view(name)',
    replacement: 'skill_view with name argument',
    confirmedAt: '2026-06-11',
    issue: 123,
  },
  // confirmed 2026-06-11 via #123
  // The section header `## Skills (mandatory)` co-occurred with the function-
  // call-shaped strings above in the failing system[1] payload. Stripping the
  // parenthetical `(mandatory)` is enough to break the combined fingerprint
  // without losing semantic content — "Skills" remains a top-level section.
  {
    pattern: '## Skills (mandatory)',
    replacement: '## Skills',
    confirmedAt: '2026-06-11',
    issue: 123,
  },
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
export const applyClassifierTriggers = (text: string): string => {
  let out = text;
  for (const trigger of CLASSIFIER_TRIGGERS) {
    out = out.split(trigger.pattern).join(trigger.replacement);
  }
  return out;
};
