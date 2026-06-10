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
//   - File paths, query strings, IPs, internal hostnames. The 5xx log surface
//     legitimately wants those for triage.
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

export const redact = (input: string): string =>
  TOKEN_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, '[REDACTED]'), input);

export const redactObject = <T>(obj: T): T => {
  const json = JSON.stringify(obj);
  return JSON.parse(redact(json)) as T;
};
