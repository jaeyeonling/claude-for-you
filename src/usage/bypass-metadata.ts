/**
 * Bypass metadata — the proxy-side wire information that flows through but
 * isn't otherwise captured in messages_log. Stored in a single JSONB blob
 * (`bypass_metadata` column) so future fields don't require schema migrations.
 *
 * Three header sets are captured, each through an allowlist (NOT a blocklist):
 *   - inbound: client → proxy
 *   - outbound: proxy → Anthropic (after template.apply)
 *   - upstream: Anthropic → proxy (response headers)
 *
 * Allowlist rationale: outbound headers contain `authorization: Bearer <OAuth
 * token>`, and inbound may carry caller-side credentials or cookies. A
 * blocklist forgets to mask the next header someone forwards; an allowlist
 * fails closed — unknown headers simply don't appear in the log. Bearer values
 * are still redacted as defense-in-depth via the lib/redact pipeline.
 *
 * See docs/operational-pitfalls.md #11 — most proxy-side incidents
 * (plan-quota, TLS fingerprint gate, 1m-context strip misdiagnosis) were
 * diagnosed via outbound/upstream header inspection. This module makes that
 * data first-class in the audit log instead of relying on the volatile
 * drift ring.
 */

import { redact } from "../lib/redact.js";

/** Headers we keep from the inbound client request. */
const INBOUND_ALLOWLIST: ReadonlySet<string> = new Set([
  "anthropic-beta",
  "anthropic-version",
  "anthropic-dangerous-direct-browser-access",
  "x-claude-code-session-id",
  "x-stainless-arch",
  "x-stainless-lang",
  "x-stainless-os",
  "x-stainless-package-version",
  "x-stainless-retry-count",
  "x-stainless-runtime",
  "x-stainless-runtime-version",
  "x-stainless-timeout",
  "x-app",
  "user-agent",
  "accept",
  "accept-language",
  "content-type",
]);

/** Headers we keep from the outbound (proxy → Anthropic) request. Same family
 * as inbound, plus authorization (redacted) so operators can verify the OAuth
 * shape without seeing the token. */
const OUTBOUND_ALLOWLIST: ReadonlySet<string> = new Set([
  ...INBOUND_ALLOWLIST,
  "authorization",
]);

/** Headers we keep from the upstream (Anthropic → proxy) response.
 *
 * Two families coexist here:
 *
 *  1. Classic `anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-*`
 *     — per-account-token billing surface. Set early in the project; unchanged.
 *
 *  2. `anthropic-ratelimit-unified-*` (#122) — sub-plan classification + 5h/7d
 *     bucket surface that the OAuth route returns. Includes:
 *      - `-status` / `-reset`             … aggregate verdict + window reset
 *      - `-overage-{status,disabled-reason}` … the overage-lane verdict and
 *        the slug explaining why overage is disabled when it is
 *      - `-representative-claim` / `-fallback-percentage` … internal routing
 *        signals exposed in the response
 *      - `-5h-{status,utilization,reset}`  … 5-hour bucket
 *      - `-7d-{status,utilization,reset}`  … 7-day bucket
 *      - `-7d_<model>-{status,utilization,reset}` … per-model 7-day bucket;
 *        ONE family currently observed: `7d_sonnet`. When Anthropic ships new
 *        per-model buckets (e.g. `7d_opus`, `7d_haiku`), ADD each new triplet
 *        BELOW the `7d_sonnet` block — don't reach for a wildcard. The
 *        allowlist's auditability is the security boundary; a regex shortcut
 *        defeats it.
 *
 * All `unified-*` values are short slugs / numerics / unix timestamps — no
 * PII or auth state, so capturing them does not weaken redaction.
 */
const UPSTREAM_RESPONSE_ALLOWLIST: ReadonlySet<string> = new Set([
  "anthropic-organization-id",
  "anthropic-ratelimit-requests-limit",
  "anthropic-ratelimit-requests-remaining",
  "anthropic-ratelimit-requests-reset",
  "anthropic-ratelimit-tokens-limit",
  "anthropic-ratelimit-tokens-remaining",
  "anthropic-ratelimit-tokens-reset",
  "anthropic-ratelimit-input-tokens-limit",
  "anthropic-ratelimit-input-tokens-remaining",
  "anthropic-ratelimit-input-tokens-reset",
  "anthropic-ratelimit-output-tokens-limit",
  "anthropic-ratelimit-output-tokens-remaining",
  "anthropic-ratelimit-output-tokens-reset",
  // Unified classifier + bucket surface (#122). See block comment above for
  // family structure and where to add new per-model triplets.
  "anthropic-ratelimit-unified-status",
  "anthropic-ratelimit-unified-reset",
  "anthropic-ratelimit-unified-overage-status",
  "anthropic-ratelimit-unified-overage-disabled-reason",
  "anthropic-ratelimit-unified-representative-claim",
  "anthropic-ratelimit-unified-fallback-percentage",
  "anthropic-ratelimit-unified-5h-status",
  "anthropic-ratelimit-unified-5h-utilization",
  "anthropic-ratelimit-unified-5h-reset",
  "anthropic-ratelimit-unified-7d-status",
  "anthropic-ratelimit-unified-7d-utilization",
  "anthropic-ratelimit-unified-7d-reset",
  // Per-model 7d triplets — add new model families BELOW (do not wildcard).
  "anthropic-ratelimit-unified-7d_sonnet-status",
  "anthropic-ratelimit-unified-7d_sonnet-utilization",
  "anthropic-ratelimit-unified-7d_sonnet-reset",
  "request-id",
  "retry-after",
  "x-should-retry",
  "content-type",
  "x-envoy-upstream-service-time",
]);

/** Name + byte-length pair for a header that's NOT in the allowlist. The
 * value itself is dropped — this is the cheapest signal that lets operators
 * notice a new SDK header rolling out (length jump from 12 → 240 chars) or
 * an unexpected client appearing, without ever persisting the value. */
export interface UnknownHeaderFingerprint {
  readonly name: string;
  readonly length: number;
}

export interface BypassMetadata {
  /** Subset of client request headers (allowlist). */
  readonly inboundHeaders: Readonly<Record<string, string>>;
  /** Subset of proxy→Anthropic request headers (allowlist). Bearer tokens
   * redacted. */
  readonly outboundHeaders: Readonly<Record<string, string>>;
  /** Subset of Anthropic→proxy response headers (allowlist). */
  readonly upstreamHeaders: Readonly<Record<string, string>>;
  /** Fingerprints of inbound headers NOT in the allowlist. Names are
   * lowercased, sorted; values are NOT stored — only length. Lets the
   * dashboard surface "new SDK header rolling out" without leaking
   * cookies / auth headers / forwarded chains. */
  readonly unknownInboundHeaders: readonly UnknownHeaderFingerprint[];
  /** Fingerprints of outbound headers NOT in the allowlist. Same rationale
   * as unknownInboundHeaders — diagnostic-only, no values. */
  readonly unknownOutboundHeaders: readonly UnknownHeaderFingerprint[];
  /** Fingerprints of upstream-response headers NOT in the allowlist. */
  readonly unknownUpstreamHeaders: readonly UnknownHeaderFingerprint[];
  /** Canary routing decision for this request. */
  readonly canary: Readonly<{
    useCandidate: boolean;
  }>;
}

interface SplitHeaders {
  readonly allowed: Record<string, string>;
  readonly unknown: readonly UnknownHeaderFingerprint[];
}

const sortFingerprints = (
  list: UnknownHeaderFingerprint[],
): readonly UnknownHeaderFingerprint[] =>
  Object.freeze(
    list
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((f) => Object.freeze(f)),
  );

const collectFromHeaders = (
  headers: Headers,
  allow: ReadonlySet<string>,
): SplitHeaders => {
  const allowed: Record<string, string> = {};
  const unknown: UnknownHeaderFingerprint[] = [];
  headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (allow.has(lower)) {
      allowed[lower] = redact(value);
    } else {
      unknown.push({ name: lower, length: value.length });
    }
  });
  return { allowed, unknown: sortFingerprints(unknown) };
};

const collectFromRecord = (
  headers: Readonly<Record<string, string>>,
  allow: ReadonlySet<string>,
): SplitHeaders => {
  const allowed: Record<string, string> = {};
  const unknown: UnknownHeaderFingerprint[] = [];
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (allow.has(lower)) {
      allowed[lower] = redact(value);
    } else {
      unknown.push({ name: lower, length: value.length });
    }
  }
  return { allowed, unknown: sortFingerprints(unknown) };
};

export interface BuildBypassMetadataInput {
  readonly inboundHeaders: Headers;
  readonly outboundHeaders: Readonly<Record<string, string>>;
  readonly upstreamHeaders: Headers;
  readonly canary: Readonly<{ useCandidate: boolean }>;
}

export const buildBypassMetadata = (
  input: BuildBypassMetadataInput,
): BypassMetadata => {
  const inbound = collectFromHeaders(input.inboundHeaders, INBOUND_ALLOWLIST);
  const outbound = collectFromRecord(input.outboundHeaders, OUTBOUND_ALLOWLIST);
  const upstream = collectFromHeaders(
    input.upstreamHeaders,
    UPSTREAM_RESPONSE_ALLOWLIST,
  );
  return Object.freeze({
    inboundHeaders: Object.freeze(inbound.allowed),
    outboundHeaders: Object.freeze(outbound.allowed),
    upstreamHeaders: Object.freeze(upstream.allowed),
    unknownInboundHeaders: inbound.unknown,
    unknownOutboundHeaders: outbound.unknown,
    unknownUpstreamHeaders: upstream.unknown,
    canary: Object.freeze({ useCandidate: input.canary.useCandidate }),
  });
};

/** Expose an allowlist as a frozen sorted array. We deliberately do NOT export
 * the underlying `Set` — `Object.freeze` is shallow and a `Set` instance is
 * unaffected by it, so a consumer could call `.add('cookie')` at runtime and
 * silently weaken the fail-closed allowlist. The array form gives operators
 * the same read-only visibility (admin docs, debugging) with no mutation surface. */
const exposeAllowlist = (allowlist: ReadonlySet<string>): readonly string[] =>
  Object.freeze([...allowlist].sort());

export const BYPASS_HEADER_ALLOWLISTS = Object.freeze({
  inbound: exposeAllowlist(INBOUND_ALLOWLIST),
  outbound: exposeAllowlist(OUTBOUND_ALLOWLIST),
  upstream: exposeAllowlist(UPSTREAM_RESPONSE_ALLOWLIST),
});
