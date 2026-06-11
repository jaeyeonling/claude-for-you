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

/** Headers we keep from the upstream (Anthropic → proxy) response. */
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
  "request-id",
  "retry-after",
  "x-should-retry",
  "content-type",
  "x-envoy-upstream-service-time",
]);

export interface BypassMetadata {
  /** Subset of client request headers (allowlist). */
  readonly inboundHeaders: Readonly<Record<string, string>>;
  /** Subset of proxy→Anthropic request headers (allowlist). Bearer tokens
   * redacted. */
  readonly outboundHeaders: Readonly<Record<string, string>>;
  /** Subset of Anthropic→proxy response headers (allowlist). */
  readonly upstreamHeaders: Readonly<Record<string, string>>;
  /** Canary routing decision for this request. */
  readonly canary: Readonly<{
    useCandidate: boolean;
  }>;
}

const collectFromHeaders = (
  headers: Headers,
  allow: ReadonlySet<string>,
): Record<string, string> => {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (allow.has(lower)) {
      out[lower] = redact(value);
    }
  });
  return out;
};

const collectFromRecord = (
  headers: Readonly<Record<string, string>>,
  allow: ReadonlySet<string>,
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (allow.has(lower)) {
      out[lower] = redact(value);
    }
  }
  return out;
};

export interface BuildBypassMetadataInput {
  readonly inboundHeaders: Headers;
  readonly outboundHeaders: Readonly<Record<string, string>>;
  readonly upstreamHeaders: Headers;
  readonly canary: Readonly<{ useCandidate: boolean }>;
}

export const buildBypassMetadata = (
  input: BuildBypassMetadataInput,
): BypassMetadata =>
  Object.freeze({
    inboundHeaders: Object.freeze(
      collectFromHeaders(input.inboundHeaders, INBOUND_ALLOWLIST),
    ),
    outboundHeaders: Object.freeze(
      collectFromRecord(input.outboundHeaders, OUTBOUND_ALLOWLIST),
    ),
    upstreamHeaders: Object.freeze(
      collectFromHeaders(input.upstreamHeaders, UPSTREAM_RESPONSE_ALLOWLIST),
    ),
    canary: Object.freeze({ useCandidate: input.canary.useCandidate }),
  });

export const BYPASS_HEADER_ALLOWLISTS = Object.freeze({
  inbound: INBOUND_ALLOWLIST,
  outbound: OUTBOUND_ALLOWLIST,
  upstream: UPSTREAM_RESPONSE_ALLOWLIST,
});
