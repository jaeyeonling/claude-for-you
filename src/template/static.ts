import type { ApplyInput, ClaudeTemplate, OutboundRequest } from './types.js';

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';

/**
 * Header snapshot meant to look like one Claude Code would send. Values are
 * a reasonable B-policy default — the exact set drifts whenever Anthropic
 * ships a new CC build. To pin your install:
 *   1. mitmproxy against your local `claude` CLI
 *   2. copy the outbound request headers onto api.anthropic.com
 *   3. replace the constants below
 *
 * `authorization`, `content-type`, `content-length`, `host`, `accept-encoding`
 * are intentionally absent — they're injected/managed per request.
 */
const CC_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'user-agent': 'claude-cli/1.0.0 (external, cli)',
  'x-app': 'cli',
  'anthropic-version': '2023-06-01',
  // Phase 9 — flags discovered by `strings /opt/homebrew/bin/claude` on
  // Claude Code 2.1.126. Replace via Phase 10's extraction script.
  'anthropic-beta':
    'oauth-2025-04-20,claude-code-20250219,context-management-2025-06-27,interleaved-thinking-2025-05-14,files-api-2025-04-14,message-batches-2024-09-24,fine-grained-tool-streaming-2025-05-14',
  'x-stainless-lang': 'js',
  'x-stainless-package-version': '0.27.0',
  'x-stainless-os': 'Linux',
  'x-stainless-arch': 'x64',
  'x-stainless-runtime': 'node',
  'x-stainless-runtime-version': 'v20.10.0',
  'x-stainless-retry-count': '0',
  accept: 'application/json',
});

export const staticTemplate: ClaudeTemplate = {
  source: 'static',
  description: 'cc-snapshot/2026-05 (B policy, CC 2.1.126 beta flags)',

  apply: async ({ clientBody, accessToken }: ApplyInput): Promise<OutboundRequest> => {
    const body = JSON.stringify(clientBody);
    return {
      url: ANTHROPIC_MESSAGES_URL,
      method: 'POST',
      headers: {
        ...CC_HEADERS,
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body,
    };
  },
};
