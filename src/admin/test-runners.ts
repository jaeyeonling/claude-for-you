import type { Context, Hono } from 'hono';
import type { AccountPool } from '../auth/account-pool.js';
import type { ApiKeyStore } from '../auth/api-key-store.js';
import { InvalidRequest, NotFound } from '../lib/errors.js';

/**
 * Phase 21 — admin self-test panel.
 *
 * Four operator-triggered probes, results held in-memory (last one per kind).
 *
 *   POST /admin/test/oauth-probe   — forceRefresh on a pool member
 *   POST /admin/test/self-ping     — loop /v1/messages through this proxy
 *   POST /admin/test/key-invoke    — same as self-ping but with a chosen key
 *   (Token store inspector is render-only — see render.ts)
 *
 * Results live in `TestResultStore` and bleed into the admin live region on
 * the next SSE tick. Nothing persists across restarts — these are interactive
 * diagnostics, not telemetry.
 */

export type TestKind = 'oauth-probe' | 'self-ping' | 'key-invoke' | 'upstream-direct';

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
// issued via Claude.ai (CC flow). Without it: rate_limit_error. haiku passes
// without. See proxy/messages.ts:ensureSystem for the same fix on the proxy
// path; we duplicate it here so direct-upstream test (`upstream-direct`)
// also sends a valid body.
const PING_BODY = (model: string): string =>
  JSON.stringify({
    model,
    max_tokens: 16,
    system: "You are Claude Code, Anthropic's official CLI for Claude.",
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
      const reason = err instanceof Error ? err.message : String(err);
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
    const reason = err instanceof Error ? err.message : String(err);
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

export const createUpstreamDirectHandler =
  (pool: AccountPool, store: TestResultStore) =>
  async (c: Context): Promise<Response> => {
    const raw = await parseFormOrJson(c).catch(() => null);
    const model = asString(raw?.model) || DEFAULT_MODEL;

    const startedAt = Date.now();
    let result: TestResult;
    try {
      const { token, name: servedBy } = await pool.getAccessToken(undefined);
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
        body: PING_BODY(model),
        // Short-lived admin probe (upstream-direct variant) — full-fetch
        // wall-clock cap is correct. proxy/upstream.ts is the SSE exception.
        signal: AbortSignal.timeout(20_000),
      });
      const bodyText = await res.text();
      const latencyMs = Date.now() - startedAt;
      let bodySummary: string;
      try {
        bodySummary = summarizeMessageBody(JSON.parse(bodyText));
      } catch {
        bodySummary = excerpt(bodyText, 80);
      }
      const diag = captureDiagHeaders(res.headers);
      const headersBlock =
        diag.length > 0 ? `\n--- response headers ---\n${diag}` : '';
      const bodyBlock =
        bodyText.length > 0 ? `\n--- body ---\n${excerpt(bodyText, 600)}` : '';
      result = {
        kind: 'upstream-direct',
        ok: res.ok && res.status === 200,
        at: Date.now(),
        latencyMs,
        summary: `${res.status} · ${latencyMs}ms · model=${model} (member=${servedBy}, no template) · ${bodySummary}`,
        detail: `status=${res.status} latency=${latencyMs}ms${headersBlock}${bodyBlock}`,
      };
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      result = {
        kind: 'upstream-direct',
        ok: false,
        at: Date.now(),
        latencyMs: Date.now() - startedAt,
        summary: `NET · ${excerpt(reason, 80)}`,
        detail: reason,
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
