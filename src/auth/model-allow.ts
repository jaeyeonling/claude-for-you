/**
 * Per-key model allowlist matching.
 *
 * Patterns are either:
 *   - Exact:  `"claude-haiku-4-5-20251001"`
 *   - Prefix: `"claude-haiku-*"` — the trailing `*` is dropped and the
 *             remainder is `startsWith`-matched.
 *
 * No infix or multi-wildcard support — operationally we restrict by model
 * family (the prefix shape Anthropic uses), and avoiding glob complexity
 * keeps the rule trivially auditable.
 *
 * An empty / missing pattern list means "no restriction" — every model is
 * allowed. This preserves backward compatibility with keystores that pre-date
 * the feature.
 */
export const isModelAllowed = (
  model: string,
  patterns: readonly string[] | undefined,
): boolean => {
  if (!patterns || patterns.length === 0) return true;
  return patterns.some((p) => {
    if (p.endsWith('*')) return model.startsWith(p.slice(0, -1));
    return model === p;
  });
};

/**
 * Upper bound on a stored pattern. Real Anthropic ids top out around 30 chars
 * (e.g. `claude-haiku-4-5-20251001`); 128 gives ~4× headroom for future
 * naming changes while keeping `isModelAllowed`'s per-call cost bounded —
 * patterns run on every authenticated request.
 *
 * Units are UTF-16 code units (`String.prototype.length`), not codepoints or
 * grapheme clusters. This is intentional — the cap exists to bound memory
 * and `startsWith` cost, both of which scale with code units, not characters.
 *
 * Revisit when (a) Anthropic ships an id ≥ ~64 chars (check their changelog
 * before bumping), or (b) the admin proxy logs show repeated
 * `invalid_model_pattern` 400s with `pattern too long` in the message field
 * from a legitimate operator (grep `[admin]` lines in proxy stdout / docker
 * logs — there is no dedicated metric, see issue #24 follow-up for adding
 * one if this becomes load-bearing).
 */
const MAX_MODEL_PATTERN_LENGTH = 128;

/**
 * Validate a pattern shape before persisting it. Catches stray internal `*`
 * or empty strings at write time so we never store an unmatchable rule that
 * silently locks the user out.
 */
export const assertValidModelPattern = (p: string): void => {
  // typeof MUST be the first guard: every check below dereferences `p`
  // (`.length`, `.match`, `.endsWith`) and would crash with a generic
  // TypeError if `p` were non-string. Reordering breaks error quality.
  //
  // null is split out from typeof because JS reports `typeof null === 'object'`,
  // which would otherwise hide a common JSON-parse failure mode behind a
  // misleading "got object" message.
  if (p === null) {
    throw new Error('model pattern must be a string (got null)');
  }
  if (typeof p !== 'string') {
    throw new Error(`model pattern must be a string (got ${typeof p})`);
  }
  if (p.length === 0) {
    throw new Error('model pattern must be non-empty');
  }
  if (p.length > MAX_MODEL_PATTERN_LENGTH) {
    throw new Error(
      `model pattern too long (${p.length} > ${MAX_MODEL_PATTERN_LENGTH} chars)`,
    );
  }
  const starCount = (p.match(/\*/g) ?? []).length;
  if (starCount > 1) {
    throw new Error(`model pattern "${p}" has more than one wildcard`);
  }
  if (starCount === 1 && !p.endsWith('*')) {
    throw new Error(`model pattern "${p}" — wildcard only allowed as trailing suffix`);
  }
};
