import type { Context } from 'hono';
import type { AccountPool } from '../auth/account-pool.js';
import { UpstreamFailed } from '../lib/errors.js';
import { log } from '../lib/logger.js';
import { redact } from '../lib/redact.js';

/**
 * `GET /v1/models` — gateway model discovery.
 *
 * Claude Code's model picker is populated differently per endpoint. On a
 * first-party endpoint (`api.anthropic.com`) it uses its bundled built-in
 * list. On a custom `ANTHROPIC_BASE_URL` gateway (us) it does NOT surface new
 * model *families* from built-in — it must learn them via **gateway model
 * discovery**: a startup `GET /v1/models?limit=1000` (opt-in via
 * `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`, CC >= 2.1.129).
 *
 * This is the ONLY path by which a brand-new family (e.g. Fable,
 * `claude-fable-5`) reaches a proxied client's picker. sonnet/opus version
 * bumps ride the client's built-in *aliases* and resolve to concrete versions
 * upstream at request time, so they need nothing here; new families need this.
 * See docs/operational-pitfalls.md #21.
 *
 * Design: a plain pass-through to upstream `/v1/models`, modeled on
 * admin/test-runners' `callAnthropicDirect`, NOT `proxy/upstream.ts`'s
 * `callUpstream`/`template.apply()` — those are welded to `POST /v1/messages`
 * (the `OutboundRequest.method` type is the literal `'POST'`, the URL is the
 * hardcoded messages endpoint, and they layer on session pacing). A small JSON
 * GET wants none of that machinery.
 */
// No `?beta=true` here — unlike the messages URL (`ANTHROPIC_MESSAGES_URL` in
// template/*.ts, which needs it or sonnet/opus 429 on the entitlement gate, see
// operational-pitfalls #12), the model list is not entitlement-gated. If a live
// `/v1/models` starts 4xx-ing, re-check this query-string assumption before
// blaming auth (that exact misdiagnosis is recorded in operational-pitfalls #21).
const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models';

// Wall-clock cap. This is a small JSON GET, not a streaming /v1/messages call,
// so a plain timed fetch is correct (mirrors callAnthropicDirect's 20s cap).
// NOTE: Claude Code's own discovery call gives up after ~3s (operational-pitfalls
// #21), so this 20s (plus a possible refresh + retry) mostly matters for the
// manual `curl` verification path, not the CC client — don't tune it expecting
// to make CC discovery "more reliable".
const MODELS_TIMEOUT_MS = 20_000;

/**
 * Minimal OAuth-token header set. The model list is not entitlement-gated the
 * way sonnet/opus messages are (no CC_SYSTEM_PREFIX marker required), so the
 * same three headers admin/test-runners sends on its OAuth ping suffice.
 *
 * If upstream ever rejects this specific set on `/v1/models` (verified against
 * live upstream before ship), escalate to the full Claude Code disguise
 * (`CC_HEADERS` in template/static.ts: `user-agent: claude-cli/...`, `x-app`,
 * `x-stainless-*`, the full `anthropic-beta` list) — lift it into a shared
 * exported constant rather than duplicating. (This header set is a deliberate
 * second copy of admin/test-runners' `callAnthropicDirect` headers; see that
 * file's comment, which is scoped to note this copy exists.)
 */
const buildHeaders = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  'anthropic-version': '2023-06-01',
  'anthropic-beta': 'oauth-2025-04-20',
});

export interface ModelsDeps {
  readonly pool: AccountPool;
}

export const createModelsHandler =
  (deps: ModelsDeps) =>
  async (c: Context): Promise<Response> => {
    // Forward the client's query string verbatim — Claude Code sends
    // `?limit=1000`, so upstream pagination behaves as the client expects.
    const upstreamUrl = ANTHROPIC_MODELS_URL + new URL(c.req.url).search;

    // Session-less GET (discovery runs at startup, not inside a session).
    // getAccessToken picks the highest-headroom pool member and refreshes a
    // stale token before returning.
    const { name, token } = await deps.pool.getAccessToken(undefined);

    // Single fetch with transport-error → 502 normalization. Closes over
    // upstreamUrl; `attempt` distinguishes the first call from the 401 retry in
    // logs/alerts.
    const fetchModels = async (tok: string, attempt: string): Promise<Response> => {
      try {
        return await fetch(upstreamUrl, {
          method: 'GET',
          headers: buildHeaders(tok),
          signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
        });
      } catch (err: unknown) {
        // Transport-level failure (timeout, DNS, connection reset). Surface as
        // 502 via onError. Discovery treats any non-2xx/failure as "fall back
        // to the built-in list" (Claude Code client behavior, not enforced
        // here), so the client degrades gracefully — but the operator still
        // wants to see it.
        throw UpstreamFailed(
          redact(`models ${attempt} fetch failed: ${err instanceof Error ? err.message : String(err)}`),
        );
      }
    };

    let res = await fetchModels(token, 'initial');

    // 401 → the member's access token was rejected mid-flight (rotated/revoked
    // upstream). Force a refresh on that member and retry once — mirrors
    // callUpstream's single-retry 401 path without its messages-specific rest.
    if (res.status === 401) {
      let fresh: string;
      try {
        fresh = await deps.pool.forceRefresh(name);
      } catch (err: unknown) {
        throw UpstreamFailed(
          redact(`models auth refresh failed: ${err instanceof Error ? err.message : String(err)}`),
        );
      }
      res = await fetchModels(fresh, 'retry');
    }

    // A 5xx from upstream `/v1/models` is otherwise invisible to the operator:
    // this endpoint deliberately skips observeResponse/tracker (not a billable
    // messages call), and passing a non-2xx through does not trip onError's
    // alert branch. Log it so a live Anthropic-side outage is at least visible.
    if (res.status >= 500) {
      log.warn(`[models] upstream /v1/models returned ${res.status}`);
    }

    // Read the body defensively. A mid-stream connection drop makes res.text()
    // throw AFTER a 2xx header; unguarded, that escapes as a generic 500 instead
    // of our documented 502 upstream contract (mirrors the guarded .text() read
    // in proxy/messages.ts).
    let bodyText: string;
    try {
      bodyText = await res.text();
    } catch (err: unknown) {
      throw UpstreamFailed(
        redact(`models body read failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    }

    // Pass the upstream response through verbatim (status + body). Claude Code
    // reads `data[].id` / `data[].display_name` and ignores everything else, so
    // no transformation is needed and future families flow through
    // automatically. A non-2xx also passes through unchanged — the client reads
    // it as discovery-failed and falls back, which is the correct degradation.
    //
    // We intentionally do NOT call pool.observeResponse() here: /v1/models is
    // not a billable messages call and must not perturb headroom-based routing.
    // We also intentionally do NOT filter by the caller's allowedModels — the
    // full upstream list is returned to every key (see README "Model discovery"
    // and operational-pitfalls #21 for the restricted-key 403-at-send caveat).
    return new Response(bodyText, {
      status: res.status,
      headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
    });
  };
