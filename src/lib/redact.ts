// Token-shape redaction for log lines and DomainError messages surfaced to
// clients. Two-layer defense:
//
//   1. `src/lib/logger.ts:53` runs every emitted log message through redact().
//   2. `DomainError` factories that embed caught `e.message` (upstream.ts,
//      account-pool.ts, api-key-store.ts, template/extracted.ts) wrap the
//      message in redact() *at construction time*, because DomainError.message
//      is also surfaced verbatim to clients by Hono's onError handler
//      (src/app.ts:332) — and that path does not pass through the logger.
//
// Patterns are applied in order via reduce + replace — every pattern runs
// against the (already-redacted) intermediate, so an earlier wider pattern
// consumes its match before a narrower later pattern can fire on the same
// substring. We keep multiple patterns instead of a single mega-regex so
// each shape's intent stays scannable.
//
// What is intentionally NOT covered:
//   - File paths, IPs, internal hostnames. The 5xx log surface legitimately
//     wants those for triage.
//   - Generic high-entropy strings. False positives on random-looking config
//     values (commit SHAs, request IDs) would hide the actual operational signal.
//   - `Bearer <word>` false-positives like `"Bearer scheme is deprecated"` get
//     squashed too. This is an accepted trade-off — the security cost of
//     leaking a real Bearer token is higher than the diagnostic cost of one
//     reduced log line. See follow-up #104 for a triage-bypass channel.
const TOKEN_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  // OAuth Bearer header echoes. Includes `.` so a JWT
  // (`Bearer eyJhbGciOi....<sig>`) matches end-to-end.
  /Bearer\s+[a-zA-Z0-9._-]+/gi,
  // OAuth credential query params (`?access_token=...`, `&refresh_token=...`).
  // Issue #93 L17 explicitly requires this shape — upstream errors and curl
  // diagnostics can echo a query string containing the live token.
  /(?:access_token|refresh_token|id_token)=[^&\s]+/gi,
  // Labeled opaque token values surfaced in free-form prose (e.g.
  // `access token was: <opaque>`). Catches the non-`Bearer ` / non-JWT case
  // where an upstream error narrates the credential. Length floor 20 keeps
  // common phrases like `"access token: missing"` from matching.
  /(?:access|refresh|id)[ _-]?token(?:\s+was)?[:=]\s*[A-Za-z0-9._~-]{20,}/gi,
  // Standalone JWTs surfaced in messages without an explicit `Bearer ` prefix
  // (e.g. `access token was: eyJ...`). Three-part `header.payload.sig`.
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  // Anthropic console / OAuth keys. `sk-ant-` is matched specifically before
  // the generic `sk-` so the longer prefix is visible in the source even
  // though the `sk-` pattern would also catch it.
  /sk-ant-[a-zA-Z0-9_-]{20,}/g,
  // OpenAI / Anthropic-style API keys. Generic fallback for any `sk-<long>`.
  /sk-[a-zA-Z0-9_-]{20,}/g,
]);

// Credentials in a URL's userinfo segment (`postgres://claude:pw@host/db`,
// `https://user:token@example.com`). Kept separate from TOKEN_PATTERNS because
// it needs a capture-group replacement — the scheme and host stay visible so
// the line remains diagnosable ("which database?"), only the credential pair
// is dropped. Motivated by the degraded-read path (src/lib/degrade.ts), which
// renders driver error text into the admin page: postgres.js does not normally
// echo the DSN, but "normally" is not a guarantee worth betting a password on.
//
// Every quantifier here is BOUNDED, and that is load-bearing, not stylistic.
// Every other pattern in TOKEN_PATTERNS begins with a literal (`Bearer`, `sk-`,
// `eyJ`, `token`), so the engine rejects non-matching positions in O(1). This
// one begins with a character class, which means an unbounded `[a-z...]*`
// prefix would greedily consume any long lowercase run, fail to find `://`,
// and backtrack — O(n²) over the whole input. Measured before bounding:
// 50KB of `"a://" + "x"*50000` took 1.2s, and a 1MB body-derived string did
// not finish. `redact` runs on EVERY emitted log line (logger.ts), so that is
// an event-loop stall reachable from upstream error text.
// Schemes are ≤32 chars in practice (`postgres`, `mongodb+srv`); userinfo
// halves are capped at 256. Anything longer simply is not redacted — a missed
// redaction is recoverable, a stalled proxy is not.
const URL_USERINFO_PATTERN = /([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s:@/]{1,256}:[^\s@/]{1,256}@/gi;

export const redact = (input: string): string =>
  TOKEN_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, '[REDACTED]'), input).replace(
    URL_USERINFO_PATTERN,
    '$1[REDACTED]@',
  );

export const redactObject = <T>(obj: T): T => {
  const json = JSON.stringify(obj);
  return JSON.parse(redact(json)) as T;
};
