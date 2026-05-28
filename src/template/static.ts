import { randomUUID } from 'node:crypto';
import type { ApplyInput, ClaudeTemplate, OutboundRequest } from './types.js';

/**
 * `?beta=true` is required by upstream — without it, sonnet/opus return
 * rate_limit_error while haiku still works. CC v2.1.142 sends it on every
 * /v1/messages POST. Treat it as part of the URL, not a feature toggle.
 */
const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages?beta=true';

/**
 * Header snapshot from CC v2.1.142, captured via mitmproxy against the real
 * /opt/homebrew/bin/claude binary on macOS arm64.
 *
 * Drift detection: when sonnet/opus return 429 while haiku passes, this
 * snapshot has drifted from current CC. Re-capture via:
 *   1. brew install mitmproxy
 *   2. mitmdump --listen-port 8080 -w /tmp/flows.bin
 *   3. HTTPS_PROXY=http://localhost:8080 \
 *      NODE_EXTRA_CA_CERTS=~/.mitmproxy/mitmproxy-ca-cert.pem \
 *      claude -p "pong" --model claude-sonnet-4-6
 *   4. copy outbound headers from mitmdump output onto here
 *
 * `authorization`, `content-type`, `content-length`, `host`, `accept-encoding`
 * are intentionally absent — they're injected/managed per request.
 *
 * `x-client-request-id` is set per-request (random uuid) in `apply()` because
 * CC re-generates it on every call.
 *
 * `x-claude-code-session-id` is intentionally NOT here — when the client
 * forwards one, the upstream layer preserves it via the existing pacing
 * codepath. Synthesizing one here would break Anthropic prompt-cache hits.
 */
const CC_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  accept: 'application/json',
  'user-agent': 'claude-cli/2.1.142 (external, sdk-cli)',
  'x-app': 'cli',
  'anthropic-version': '2023-06-01',
  'anthropic-dangerous-direct-browser-access': 'true',
  // Order matches CC v2.1.142 outbound. Some flags (e.g. afk-mode,
  // cache-diagnosis) are likely conditional in real CC but always-on here —
  // upstream tolerates known flags it doesn't ask for, but missing a
  // required one re-triggers the rate_limit_error gate.
  'anthropic-beta': [
    'claude-code-20250219',
    'oauth-2025-04-20',
    'interleaved-thinking-2025-05-14',
    'context-management-2025-06-27',
    'prompt-caching-scope-2026-01-05',
    'advisor-tool-2026-03-01',
    'advanced-tool-use-2025-11-20',
    'effort-2025-11-24',
    'afk-mode-2026-01-31',
    'extended-cache-ttl-2025-04-11',
    'cache-diagnosis-2026-04-07',
  ].join(','),
  'x-stainless-arch': 'arm64',
  'x-stainless-lang': 'js',
  'x-stainless-os': 'MacOS',
  'x-stainless-package-version': '0.94.0',
  'x-stainless-runtime': 'node',
  'x-stainless-runtime-version': 'v24.3.0',
  'x-stainless-retry-count': '0',
  'x-stainless-timeout': '600',
});

export const staticTemplate: ClaudeTemplate = {
  source: 'static',
  description: 'cc-snapshot/2026-05-27 (CC v2.1.142 mitmproxy-captured)',

  // `clientHeaders` is intentionally NOT destructured — this template is a
  // pure replay of the captured CC v2.1.142 wire shape, so client-supplied
  // `anthropic-beta` is dropped wholesale (not merged). That means the
  // OAuth-incompatible strip done in extracted.ts is structurally automatic
  // here: `context-1m-*` can never reach upstream via this template. If you
  // ever extend static to forward client beta flags, route through
  // `mergeAndFilterAnthropicBeta` first — see pitfalls #12.
  apply: async ({ clientBody, accessToken }: ApplyInput): Promise<OutboundRequest> => {
    const body = JSON.stringify(clientBody);
    return {
      url: ANTHROPIC_MESSAGES_URL,
      method: 'POST',
      headers: {
        ...CC_HEADERS,
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        'x-client-request-id': randomUUID(),
      },
      body,
    };
  },
};
