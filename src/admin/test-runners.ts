import type { Context, Hono } from 'hono';
import type { AccountPool } from '../auth/account-pool.js';
import type { ApiKeyStore } from '../auth/api-key-store.js';
import { InvalidRequest, NotFound } from '../lib/errors.js';
import { redact } from '../lib/redact.js';
import { CC_SYSTEM_PREFIX } from '../proxy/messages.js';

/**
 * Phase 21 — admin self-test panel.
 *
 * Operator-triggered probes, results held in-memory (last one per kind).
 *
 *   POST /admin/test/oauth-probe        — forceRefresh on a pool member
 *   POST /admin/test/self-ping          — loop /v1/messages through this proxy
 *   POST /admin/test/key-invoke         — same as self-ping but with a chosen key
 *   POST /admin/test/upstream-direct    — bypass proxy template, call Anthropic directly
 *   POST /admin/test/verify-entitlement — two-call drift probe (#40)
 *   (Token store inspector is render-only — see render.ts)
 *
 * Results live in `TestResultStore` and bleed into the admin live region on
 * the next SSE tick. Nothing persists across restarts — these are interactive
 * diagnostics, not telemetry.
 */

export type TestKind =
  | 'oauth-probe'
  | 'self-ping'
  | 'key-invoke'
  | 'upstream-direct'
  | 'verify-entitlement';

export interface TestResult {
  readonly kind: TestKind;
  readonly ok: boolean;
  readonly at: number;
  readonly latencyMs: number;
  /** One-line operator-readable summary (e.g., "200 OK · 142ms · alice"). */
  readonly summary: string;
  /** Raw detail — error message, status code line, body excerpt. */
  readonly detail: string;
}

export interface TestResultStore {
  record(result: TestResult): void;
  latest(): Readonly<Record<TestKind, TestResult | null>>;
}

export const createTestResultStore = (): TestResultStore => {
  const latest: Record<TestKind, TestResult | null> = {
    'oauth-probe': null,
    'self-ping': null,
    'key-invoke': null,
    'upstream-direct': null,
    'verify-entitlement': null,
  };
  return {
    record(result) {
      latest[result.kind] = result;
    },
    latest() {
      return { ...latest };
    },
  };
};

const parseFormOrJson = async (c: Context): Promise<Record<string, unknown>> => {
  const contentType = c.req.header('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return (await c.req.json()) as Record<string, unknown>;
  }
  const form = await c.req.formData();
  const out: Record<string, unknown> = {};
  form.forEach((value, key) => {
    out[key] = typeof value === 'string' ? value : '';
  });
  return out;
};

const asString = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const excerpt = (s: string, n = 240): string =>
  s.length <= n ? s : `${s.slice(0, n)}… (+${s.length - n} chars)`;

const wantsJson = (c: Context): boolean =>
  (c.req.header('accept') ?? '').includes('application/json');

const respond = (c: Context, result: TestResult): Response => {
  // Fetch interceptor sends Accept: application/json so it can render the
  // result inline next to the submit button — no page reload, no scrolling
  // to find which live card just changed.
  if (wantsJson(c)) {
    return c.json(result);
  }
  // Native form-submit fallback (JS disabled): the live region still picks
  // the result up on the next SSE tick after the redirect renders /admin.
  return c.redirect('/admin');
};

/**
 * Pulls the first text content block out of an Anthropic /v1/messages
 * response. Kept narrow on purpose — we want the smoke check to surface
 * "model actually replied with text" without dragging in the full schema.
 */
const summarizeMessageBody = (body: unknown): string => {
  if (!body || typeof body !== 'object') return '<non-object body>';
  const obj = body as Record<string, unknown>;
  if (typeof obj.error === 'object' && obj.error !== null) {
    const err = obj.error as Record<string, unknown>;
    return `error: ${asString(err.type) || '?'} — ${asString(err.message) || '?'}`;
  }
  const content = obj.content;
  if (Array.isArray(content)) {
    const firstText = content.find(
      (b): b is { type: 'text'; text: string } =>
        b !== null &&
        typeof b === 'object' &&
        (b as Record<string, unknown>).type === 'text' &&
        typeof (b as Record<string, unknown>).text === 'string',
    );
    if (firstText) return `text: ${excerpt(firstText.text, 80)}`;
  }
  return excerpt(JSON.stringify(obj), 120);
};

// `system` is required by upstream for sonnet/opus when the OAuth token was
// issued via Claude.ai (CC flow). Without the CC identity marker: rate_limit_error.
// haiku passes without. We reuse CC_SYSTEM_PREFIX from proxy/messages so the
// marker has a single source of truth — silent drift between the two locations
// is what produced the misdiagnosis fixed in 2026-06-02.
const PING_BODY = (model: string): string =>
  JSON.stringify({
    model,
    max_tokens: 16,
    system: CC_SYSTEM_PREFIX,
    messages: [{ role: 'user', content: 'reply with the single word: pong' }],
  });

const DEFAULT_MODEL = 'claude-sonnet-4-6';

// ---------- OAuth refresh probe ----------

export const createOAuthProbeHandler =
  (pool: AccountPool, store: TestResultStore) =>
  async (c: Context): Promise<Response> => {
    const raw = await parseFormOrJson(c).catch(() => null);
    if (!raw) throw InvalidRequest('invalid request body');
    const memberName = asString(raw.memberName) || 'default';

    const startedAt = Date.now();
    let result: TestResult;
    try {
      const token = await pool.forceRefresh(memberName);
      const latencyMs = Date.now() - startedAt;
      const suffix = token.length >= 4 ? token.slice(-4) : token;
      result = {
        kind: 'oauth-probe',
        ok: true,
        at: Date.now(),
        latencyMs,
        summary: `refreshed · ${memberName} · ${latencyMs}ms · …${suffix}`,
        detail: `member="${memberName}" new access token suffix=…${suffix}`,
      };
    } catch (err: unknown) {
      const reason = redact(err instanceof Error ? err.message : String(err));
      result = {
        kind: 'oauth-probe',
        ok: false,
        at: Date.now(),
        latencyMs: Date.now() - startedAt,
        summary: `failed · ${memberName} · ${excerpt(reason, 60)}`,
        detail: reason,
      };
    }
    store.record(result);
    return respond(c, result);
  };

// ---------- Self-ping (loopback through this proxy) ----------

export interface LoopbackFetcher {
  /** Hono.fetch — same signature as global fetch but routes to in-process app. */
  (input: Request | URL | string, init?: RequestInit): Promise<Response>;
}

// Headers we ALWAYS want to see in self-ping detail. Each gives a signal:
//   retry-after, x-should-retry → rate-limit shape vs abuse cooldown
//   anthropic-ratelimit-*       → which quota was hit + when it resets
//   request-id, cf-ray          → traceable reference for support tickets
//   x-envoy-upstream-service-time → backend latency vs network latency split
//   anthropic-organization-id   → confirms which account the upstream saw
// Authorization, x-api-key, cookie, set-cookie are NEVER captured — they
// could carry token material on the request side or stale auth on response.
const DIAG_HEADERS = [
  'retry-after',
  'x-should-retry',
  'request-id',
  'cf-ray',
  'cf-cache-status',
  'x-envoy-upstream-service-time',
  'anthropic-organization-id',
  'content-length',
  'content-type',
];

const captureDiagHeaders = (headers: Headers): string => {
  const lines: string[] = [];
  for (const key of DIAG_HEADERS) {
    const v = headers.get(key);
    if (v !== null) lines.push(`${key}: ${v}`);
  }
  headers.forEach((value, name) => {
    if (name.toLowerCase().startsWith('anthropic-ratelimit-')) {
      lines.push(`${name}: ${value}`);
    }
  });
  return lines.join('\n');
};

const runLoopbackPing = async (
  fetcher: LoopbackFetcher,
  apiKey: string,
  model: string,
): Promise<{
  ok: boolean;
  status: number;
  latencyMs: number;
  bodyText: string;
  diagHeaders: string;
}> => {
  const startedAt = Date.now();
  try {
    // Short-lived admin probe — full-fetch wall-clock cap is correct here.
    // (See proxy/upstream.ts for the SSE exception that needs TTFB-only.)
    const res = await fetcher('http://internal/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: PING_BODY(model),
      signal: AbortSignal.timeout(20_000),
    });
    const bodyText = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      latencyMs: Date.now() - startedAt,
      bodyText,
      diagHeaders: captureDiagHeaders(res.headers),
    };
  } catch (err: unknown) {
    const reason = redact(err instanceof Error ? err.message : String(err));
    return {
      ok: false,
      status: 0,
      latencyMs: Date.now() - startedAt,
      bodyText: `<transport error> ${reason}`,
      diagHeaders: '',
    };
  }
};

const recordPingResult = (
  store: TestResultStore,
  kind: TestKind,
  label: string,
  res: {
    ok: boolean;
    status: number;
    latencyMs: number;
    bodyText: string;
    diagHeaders: string;
  },
): TestResult => {
  let bodySummary: string;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(res.bodyText);
    bodySummary = summarizeMessageBody(parsed);
  } catch {
    bodySummary = excerpt(res.bodyText, 80);
  }
  const ok = res.ok && res.status === 200;
  const headersBlock =
    res.diagHeaders.length > 0 ? `\n--- response headers ---\n${res.diagHeaders}` : '';
  const bodyBlock =
    res.bodyText.length > 0 ? `\n--- body ---\n${excerpt(res.bodyText, 600)}` : '';
  const result: TestResult = {
    kind,
    ok,
    at: Date.now(),
    latencyMs: res.latencyMs,
    summary: `${res.status || 'NET'} · ${res.latencyMs}ms · ${label} · ${bodySummary}`,
    detail: `status=${res.status} latency=${res.latencyMs}ms${headersBlock}${bodyBlock}`,
  };
  store.record(result);
  return result;
};

const pickFirstKey = (apiKeyStore: ApiKeyStore): string | null => {
  const entries = apiKeyStore.list();
  return entries.length > 0 ? entries[0]!.key : null;
};

export const createSelfPingHandler =
  (
    apiKeyStore: ApiKeyStore,
    fetcher: () => LoopbackFetcher,
    store: TestResultStore,
  ) =>
  async (c: Context): Promise<Response> => {
    const raw = await parseFormOrJson(c).catch(() => null);
    const model = asString(raw?.model) || DEFAULT_MODEL;
    const key = pickFirstKey(apiKeyStore);
    if (!key) {
      const result: TestResult = {
        kind: 'self-ping',
        ok: false,
        at: Date.now(),
        latencyMs: 0,
        summary: 'failed · no api keys configured',
        detail: 'apiKeyStore is empty — cannot self-authenticate.',
      };
      store.record(result);
      return respond(c, result);
    }
    const res = await runLoopbackPing(fetcher(), key, model);
    const result = recordPingResult(store, 'self-ping', `model=${model}`, res);
    return respond(c, result);
  };

// ---------- Per-key invoke ----------

export const createKeyInvokeHandler =
  (
    apiKeyStore: ApiKeyStore,
    fetcher: () => LoopbackFetcher,
    store: TestResultStore,
  ) =>
  async (c: Context): Promise<Response> => {
    const raw = await parseFormOrJson(c).catch(() => null);
    if (!raw) throw InvalidRequest('invalid request body');
    const name = asString(raw.keyName);
    if (name.length === 0) throw InvalidRequest('keyName is required');
    const model = asString(raw.model) || DEFAULT_MODEL;

    const entry = apiKeyStore.list().find((e) => e.name === name);
    if (!entry) {
      // Operator picked a name no longer in the store (e.g., just revoked).
      // Record it so the next render makes the staleness obvious, then 404.
      const result: TestResult = {
        kind: 'key-invoke',
        ok: false,
        at: Date.now(),
        latencyMs: 0,
        summary: `failed · key "${name}" not found`,
        detail: `apiKeyStore has no entry named "${name}" (revoked or removed).`,
      };
      store.record(result);
      throw NotFound(`api key "${name}" not found`);
    }

    const res = await runLoopbackPing(fetcher(), entry.key, model);
    const result = recordPingResult(store, 'key-invoke', `key=${entry.name}`, res);
    return respond(c, result);
  };

// ---------- Upstream direct (bypass proxy/template) ----------

/**
 * Calls api.anthropic.com directly with the bare minimum: Authorization
 * Bearer + content-type. NO Claude Code headers, NO anthropic-beta flags,
 * NO x-stainless-*. Compared with self-ping (which goes through the full
 * proxy template), this isolates whether a 429 originates upstream-of-template
 * (account/quota) or template-of-upstream (header drift).
 */
const ANTHROPIC_DIRECT_URL = 'https://api.anthropic.com/v1/messages';

/**
 * Direct (no-template) POST helper for admin's two Anthropic probes —
 * `upstream-direct` and `verify-entitlement` — so a future change to the beta
 * flag, version header, or timeout lands in one place for BOTH of them
 * (preventing the kind of silent drift that #41 fixed at the proxy layer).
 *
 * NOT the single source of truth for the whole codebase: `proxy/models.ts`
 * (the GET /v1/models discovery handler) deliberately keeps its own copy of the
 * same OAuth header set + 20s timeout — see that file's `buildHeaders` comment
 * for why it isn't shared. If you change the OAuth beta flag / version header
 * here, mirror it there (and vice-versa).
 */
const callAnthropicDirect = async (
  token: string,
  body: string,
): Promise<DirectCallResult> => {
  try {
    const res = await fetch(ANTHROPIC_DIRECT_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        // Beta flag REQUIRED for Claude.ai OAuth-issued tokens — without it
        // the upstream rejects the call regardless of model. This is the
        // smallest set; everything else (x-stainless-*, claude-code-* beta
        // flags, user-agent) is omitted to isolate whether THAT extra set
        // is what's tripping sonnet/opus.
        'anthropic-beta': 'oauth-2025-04-20',
      },
      body,
      // Short-lived admin probe — full-fetch wall-clock cap is correct here.
      // proxy/upstream.ts is the SSE exception that needs TTFB-only.
      signal: AbortSignal.timeout(20_000),
    });
    return { status: res.status, bodyText: await res.text(), headers: res.headers };
  } catch (err: unknown) {
    return {
      status: 0,
      bodyText: '',
      headers: null,
      error: redact(err instanceof Error ? err.message : String(err)),
    };
  }
};

export const createUpstreamDirectHandler =
  (pool: AccountPool, store: TestResultStore) =>
  async (c: Context): Promise<Response> => {
    const raw = await parseFormOrJson(c).catch(() => null);
    const model = asString(raw?.model) || DEFAULT_MODEL;

    const startedAt = Date.now();
    let result: TestResult;
    try {
      const { token, name: servedBy } = await pool.getAccessToken(undefined);
      // callAnthropicDirect never throws (it normalises transport errors
      // into { status:0, error }), so reaching the outer catch below
      // unambiguously means token-fetch failed — see #40 R2.
      const call = await callAnthropicDirect(token, PING_BODY(model));
      const latencyMs = Date.now() - startedAt;
      if (call.error !== undefined) {
        // Fetch-phase transport error — pool gave us a token but Anthropic
        // is unreachable.
        result = {
          kind: 'upstream-direct',
          ok: false,
          at: Date.now(),
          latencyMs,
          summary: `NET · phase=fetch · ${excerpt(call.error, 80)}`,
          detail: `phase=fetch member=${servedBy} error=${call.error}`,
        };
      } else {
        let bodySummary: string;
        try {
          bodySummary = summarizeMessageBody(JSON.parse(call.bodyText));
        } catch {
          bodySummary = excerpt(call.bodyText, 80);
        }
        const diag = call.headers ? captureDiagHeaders(call.headers) : '';
        const headersBlock =
          diag.length > 0 ? `\n--- response headers ---\n${diag}` : '';
        const bodyBlock =
          call.bodyText.length > 0
            ? `\n--- body ---\n${excerpt(call.bodyText, 600)}`
            : '';
        // 200 only — fetch's res.ok covers 200-299, but the entitlement /
        // direct probe is only meaningful when Anthropic returns the
        // canonical 200; 201/202/204 are not part of the upstream contract.
        // Note: `recordPingResult` writes `res.ok && res.status === 200`
        // because its `res` is the LOOPBACK fetch (already proxy-wrapped);
        // here `call.status` is the RAW Anthropic status, so the redundant
        // `res.ok` check is unnecessary — the two paths look different on
        // purpose, not by drift.
        result = {
          kind: 'upstream-direct',
          ok: call.status === 200,
          at: Date.now(),
          latencyMs,
          summary: `${call.status} · ${latencyMs}ms · model=${model} (member=${servedBy}, no template) · ${bodySummary}`,
          detail: `status=${call.status} latency=${latencyMs}ms${headersBlock}${bodyBlock}`,
        };
      }
    } catch (err: unknown) {
      // Only reachable when pool.getAccessToken throws — see comment above.
      const reason = redact(err instanceof Error ? err.message : String(err));
      result = {
        kind: 'upstream-direct',
        ok: false,
        at: Date.now(),
        latencyMs: Date.now() - startedAt,
        summary: `NET · phase=token-fetch · ${excerpt(reason, 80)}`,
        detail: `phase=token-fetch error=${reason}`,
      };
    }
    store.record(result);
    return respond(c, result);
  };

// ---------- Verify entitlement (marker drift detection) ----------

/**
 * #40: Anthropic could change the entitlement gate semantics at any time.
 * If they do, the existing `upstream-direct` probe — which always sends
 * `system: CC_SYSTEM_PREFIX` — keeps returning 200 OK and we lose the
 * signal. This probe fires TWO calls back-to-back:
 *
 *   A) sonnet + `system: CC_SYSTEM_PREFIX`         → expected 200
 *   B) sonnet + no system block                    → expected 429 rate_limit_error
 *
 * The (statusA, statusB) pair maps to one of five verdicts. Only `ok`
 * means the marker is doing its job; `marker-drift` is the deterministic
 * regression signal that #41 patched against.
 */

export type EntitlementVerdict =
  | 'ok'
  | 'marker-drift'
  | 'account-issue'
  | 'reversed'
  | 'inconclusive';

export interface EntitlementClassification {
  readonly verdict: EntitlementVerdict;
  readonly ok: boolean;
}

export const classifyEntitlement = (
  statusA: number,
  statusB: number,
  errorA?: string,
  errorB?: string,
): EntitlementClassification => {
  // Transport failure on either side collapses the comparison to noise.
  // status=0 is our sentinel for "network error before HTTP status".
  if (
    errorA !== undefined ||
    errorB !== undefined ||
    statusA === 0 ||
    statusB === 0
  ) {
    return { verdict: 'inconclusive', ok: false };
  }
  if (statusA === 200 && statusB === 429) return { verdict: 'ok', ok: true };
  if (statusA === 200 && statusB === 200)
    return { verdict: 'marker-drift', ok: false };
  if (statusA === 429 && statusB === 429)
    return { verdict: 'account-issue', ok: false };
  if (statusA === 429 && statusB === 200)
    return { verdict: 'reversed', ok: false };
  // Any other status code combination (5xx, 400, …) is also inconclusive —
  // we cannot say anything about marker effectiveness from a non-200/429 pair.
  return { verdict: 'inconclusive', ok: false };
};

// PING_BODY (defined above for sonnet+marker self-tests) already produces the
// "with marker" body — reuse it instead of duplicating. The "without marker"
// variant only differs by omitting the `system` key.
const PING_BODY_WITHOUT_MARKER = (model: string): string =>
  JSON.stringify({
    model,
    max_tokens: 16,
    // No `system` key — this is the whole point of the probe.
    messages: [{ role: 'user', content: 'reply with the single word: pong' }],
  });

// The entitlement gate only applies to sonnet/opus on Claude.ai-OAuth tokens
// (haiku has no gate). Other models would produce a useless `inconclusive`
// pair at best and burn OAuth-account quota at worst. We refuse upfront so
// operators can't accidentally (or maliciously) point this at expensive
// models like opus 4.5 in a loop. Patterns are anchored AND tail-length
// capped — partial matches like "claude-haiku-sonnet-something" and
// pathological long tails ("claude-sonnet-" + 10kB of 'a') are rejected.
//
// Tail length rationale: current model ids fit in ~9 chars (e.g. `4-6-1m`,
// `4-7[1m]` → 8-9). {1,40} gives roughly 4x headroom for future naming
// (date-stamped builds like `4-7-20261231-extended` ~22 chars still pass)
// while keeping a hard ceiling against payload-amplification abuse. If
// Anthropic ships an id that exceeds 40 chars, the cap is the trigger
// for an explicit review, not silent acceptance.
const ENTITLEMENT_MODEL_PATTERN = /^claude-(sonnet|opus)-[a-z0-9-]{1,40}$/i;

export const isEntitlementModelAllowed = (model: string): boolean =>
  ENTITLEMENT_MODEL_PATTERN.test(model);

interface DirectCallResult {
  readonly status: number;
  readonly bodyText: string;
  readonly headers: Headers | null;
  readonly error?: string;
}

export const createVerifyEntitlementHandler =
  (pool: AccountPool, store: TestResultStore) =>
  async (c: Context): Promise<Response> => {
    const raw = await parseFormOrJson(c).catch(() => null);
    const model = asString(raw?.model) || DEFAULT_MODEL;

    // H1 quota-abuse guard: reject anything that isn't sonnet/opus before we
    // burn even a single upstream call. We ALSO record the rejection into
    // TestResultStore so the admin live region surfaces "why nothing
    // happened" — otherwise the 400 returns to the form, the SSE region
    // stays silent, and the operator clicks again expecting different
    // behavior (Chaos R3 finding).
    if (!isEntitlementModelAllowed(model)) {
      const reason = `verify-entitlement only accepts sonnet/opus models (got "${excerpt(model, 60)}"). haiku is not gated and other models would burn account quota without producing a usable verdict.`;
      store.record({
        kind: 'verify-entitlement',
        ok: false,
        at: Date.now(),
        latencyMs: 0,
        summary: `rejected · model "${excerpt(model, 40)}" not in allowlist`,
        detail: `phase=model-guard\n${reason}`,
      });
      throw InvalidRequest(reason);
    }

    const startedAt = Date.now();
    let result: TestResult;
    try {
      const { token, name: servedBy } = await pool.getAccessToken(undefined);
      // callAnthropicDirect normalises transport errors to status=0/error
      // so the outer catch is only reachable from pool.getAccessToken —
      // phase=token-fetch is the only reachable label there.

      // Fire both calls in parallel. Sequential would widen the time gap and
      // let upstream state (rate-limit window boundary, account-level quota
      // refresh) shift between A and B, which would muddy the comparison.
      // Reusing PING_BODY for the marker side keeps a single source of truth
      // for the body shape — see #40 H3 (no PING_BODY_WITH_MARKER duplicate).
      const [withMarker, withoutMarker] = await Promise.all([
        callAnthropicDirect(token, PING_BODY(model)),
        callAnthropicDirect(token, PING_BODY_WITHOUT_MARKER(model)),
      ]);

      const { verdict, ok } = classifyEntitlement(
        withMarker.status,
        withoutMarker.status,
        withMarker.error,
        withoutMarker.error,
      );
      const latencyMs = Date.now() - startedAt;

      const summarizeSide = (
        label: 'A' | 'B',
        kind: 'with marker' | 'without marker',
        side: DirectCallResult,
      ): string => {
        const head =
          side.error !== undefined
            ? `${label} (${kind}): NET error="${excerpt(side.error, 120)}"`
            : `${label} (${kind}): status=${side.status}`;
        const body =
          side.bodyText.length > 0 ? `\n${excerpt(side.bodyText, 240)}` : '';
        return `${head}${body}`;
      };

      result = {
        kind: 'verify-entitlement',
        ok,
        at: Date.now(),
        latencyMs,
        summary: `${verdict} · A=${withMarker.status || 'NET'} B=${withoutMarker.status || 'NET'} · ${latencyMs}ms · model=${model} (member=${servedBy})`,
        detail: [
          `verdict=${verdict} (A,B)=(${withMarker.status || 'NET'},${withoutMarker.status || 'NET'})`,
          `latency=${latencyMs}ms member=${servedBy} phase=fetch`,
          ``,
          summarizeSide('A', 'with marker', withMarker),
          ``,
          summarizeSide('B', 'without marker', withoutMarker),
        ].join('\n'),
      };
    } catch (err: unknown) {
      // Reached only when pool.getAccessToken throws — fetch errors are
      // swallowed inside callAnthropicDirect and surface as status=0/error
      // via the verdict path. Phase is therefore unambiguous: token-fetch.
      const reason = redact(err instanceof Error ? err.message : String(err));
      result = {
        kind: 'verify-entitlement',
        ok: false,
        at: Date.now(),
        latencyMs: Date.now() - startedAt,
        summary: `NET · phase=token-fetch · ${excerpt(reason, 80)}`,
        detail: `phase=token-fetch error=${reason}`,
      };
    }
    store.record(result);
    return respond(c, result);
  };

// ---------- helper for app.ts ----------

/**
 * Wrap a Hono app's `fetch` into a LoopbackFetcher. Lazy so handlers can be
 * created before the app object is final — we resolve the closure at call time.
 */
export const honoLoopback =
  (appRef: { current: Hono | null }): (() => LoopbackFetcher) =>
  () => {
    const app = appRef.current;
    if (!app) {
      throw new Error('loopback fetcher used before app was bound');
    }
    return async (input, init) => {
      const url =
        input instanceof URL
          ? input.toString()
          : typeof input === 'string'
            ? input
            : input.url;
      const req = new Request(url, init);
      return await app.fetch(req);
    };
  };
