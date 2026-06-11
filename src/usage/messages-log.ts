/**
 * Full-content request/response log for `/v1/messages`.
 *
 * One row per call. Stores the raw request body (JSONB) and the full upstream
 * response — either the JSON body (non-stream) or the concatenated SSE bytes
 * (stream). Designed for admin-side monitoring + replay, not for accounting
 * (UsageTracker still owns the token-counter table).
 *
 * Two implementations:
 *   - createNullMessageLogStore: no-op fallback when DATABASE_URL is absent
 *     or MESSAGES_LOG_ENABLED=false. The proxy never branches on this — it
 *     calls `record()` unconditionally; the null store discards.
 *   - createPostgresMessageLogStore (separate file): PG-backed.
 *
 * Storage shape: response_body is a small envelope
 *   { kind: 'json', body: <upstream JSON> }
 *   { kind: 'sse',  raw: <concatenated SSE event bytes as string> }
 * Storing raw SSE is lossless and lets the admin UI decode on render rather
 * than baking a (possibly lossy) reassembly into the write path.
 */

export type ResponseBody =
  | Readonly<{ kind: "json"; body: unknown }>
  | Readonly<{ kind: "sse"; raw: string }>
  /** Non-streaming response whose body wasn't JSON-parseable — e.g. an
   * HTML error page, a plain-text 4xx, or a truncated stream. Stored
   * verbatim. */
  | Readonly<{ kind: "text"; raw: string }>;

export interface MessageLogRecord {
  readonly id: string;
  readonly ts: Date;
  readonly userName: string;
  readonly model: string | null;
  readonly status: number;
  readonly streaming: boolean;
  readonly durationMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly serviceTier: string | null;
  readonly stopReason: string | null;
  readonly clientIp: string | null;
  readonly userAgent: string | null;
  readonly requestBody: unknown;
  readonly responseBody: ResponseBody | null;
  readonly errorMessage: string | null;
  /** Which OAuth pool member served the upstream call. null when the request
   * never reached the pool (validation reject, etc.). */
  readonly servedBy: string | null;
  /** Proxy-side wire metadata: inbound/outbound/upstream header allowlist
   * snapshots and canary decision. Shape defined in usage/bypass-metadata.ts.
   * null when the request short-circuited before metadata could be assembled. */
  readonly bypassMetadata: unknown;
}

export interface MessageLogSummary {
  readonly id: string;
  readonly ts: Date;
  readonly userName: string;
  readonly model: string | null;
  readonly status: number;
  readonly streaming: boolean;
  readonly durationMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly serviceTier: string | null;
  readonly preview: string;
}

export type StatusClass = "all" | "success" | "error";

export interface ListFilters {
  readonly userName?: string;
  readonly model?: string;
  readonly statusClass?: StatusClass;
  /** Substring match against `preview` (last user message excerpt). */
  readonly search?: string;
  /** Pagination cursor: rows strictly older than `before`. */
  readonly before?: Date;
  readonly limit: number;
}

export interface MessageLogStore {
  record(entry: MessageLogRecord): Promise<void>;
  list(filters: ListFilters): Promise<readonly MessageLogSummary[]>;
  get(id: string): Promise<MessageLogRecord | null>;
  close?(): Promise<void>;
}

export const createNullMessageLogStore = (): MessageLogStore =>
  Object.freeze({
    async record(): Promise<void> {
      // No-op: feature disabled.
    },
    async list(): Promise<readonly MessageLogSummary[]> {
      return [];
    },
    async get(): Promise<MessageLogRecord | null> {
      return null;
    },
  });

/**
 * Sanitize a JSON-shaped value for safe persistence in storage backends that
 * impose stricter constraints than JSON itself — most notably Postgres JSONB.
 *
 * Three responsibilities, in order:
 *  1. NUL (U+0000) → U+FFFD. Postgres JSONB's underlying TEXT type rejects
 *     NUL with `unsupported Unicode escape sequence`, dropping the entire row.
 *     U+FFFD survives both Postgres and the admin UI's HTML render, so the
 *     replacement is lossy-but-visible (operators can spot tainted payloads).
 *  2. Cap recursion at MAX_SANITIZE_DEPTH (1024). Adversarial payloads of the
 *     shape `{a:{a:{a:...}}}` would otherwise blow V8's ~10k frame stack and
 *     silently drop the log row via the proxy's fire-and-forget catch.
 *  3. Drop prototype-pollution keys (`__proto__`, `constructor`, `prototype`,
 *     and legacy `__lookupGetter__` / `__lookupSetter__` / `__defineGetter__`
 *     / `__defineSetter__`). JSON.parse can land these as *own* properties
 *     from adversarial input; allowing them through confuses downstream
 *     readers and bloats the audit log with attacker-controlled artifacts.
 *
 * Invariants the implementation MUST hold:
 *  - Pure: returns a new value; never mutates input (record is shared with
 *    other observers — the proxy still hands `requestBody` to other paths).
 *  - Deep: walks plain objects and arrays. Object keys count too — PG rejects
 *    NUL in keys the same way it rejects NUL in values.
 *  - Type-stable: strings → string, arrays → array, objects → object, other
 *    primitives (number/boolean/null/undefined) pass through unchanged.
 *  - JSON-only: assumes the input is a JSON.parse-shaped value. No Date / Map
 *    / Set / class instance handling — the request/response bodies that flow
 *    here are always parsed JSON (or null).
 *  - Bounded: depth > MAX_SANITIZE_DEPTH returns DEPTH_SENTINEL string rather
 *    than recursing further. Real Claude payloads are depth 6–8.
 *  - Pollution-safe: DANGEROUS_KEYS are dropped (see responsibility #3).
 *
 * See `docs/operational-pitfalls.md` #14 for the operator-side playbook on
 * the original symptom that motivated this helper.
 */
const NUL_CHAR = "\u0000";
const REPLACEMENT_CHAR = "\uFFFD";
const MAX_SANITIZE_DEPTH = 1024;
const DEPTH_SENTINEL = "[messages-log: depth limit reached]";
const DANGEROUS_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
  // Legacy accessor APIs — still parseable as own properties via JSON.parse,
  // still surface area for attacker-controlled keys we don't want in the log.
  "__lookupGetter__",
  "__lookupSetter__",
  "__defineGetter__",
  "__defineSetter__",
]);

const replaceNulInString = (s: string): string =>
  s.indexOf(NUL_CHAR) === -1 ? s : s.replaceAll(NUL_CHAR, REPLACEMENT_CHAR);

export const sanitizeJsonValue = (value: unknown, depth = 0): unknown => {
  if (depth > MAX_SANITIZE_DEPTH) return DEPTH_SENTINEL;
  if (typeof value === "string") return replaceNulInString(value);
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeJsonValue(v, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (DANGEROUS_KEYS.has(k)) continue;
      out[replaceNulInString(k)] = sanitizeJsonValue(v, depth + 1);
    }
    return out;
  }
  return value;
};

const PREVIEW_MAX = 240;

/**
 * Extract a short preview of the LAST user message in the request body.
 * Used for admin list view + ILIKE search. Quoted tool-result blocks and
 * non-text blocks are skipped — the goal is a human-readable hint, not a
 * faithful reproduction.
 */
export const extractPreview = (
  requestBody: unknown,
  max = PREVIEW_MAX,
): string => {
  if (requestBody === null || typeof requestBody !== "object") return "";
  const messages = (requestBody as Record<string, unknown>).messages;
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg === null || typeof msg !== "object") continue;
    const m = msg as Record<string, unknown>;
    if (m.role !== "user") continue;
    const c = m.content;
    if (typeof c === "string") return c.slice(0, max);
    if (Array.isArray(c)) {
      for (const block of c) {
        if (block === null || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          return b.text.slice(0, max);
        }
      }
    }
    return "";
  }
  return "";
};

/**
 * Pull the model string out of the request body, defensively. Returned as
 * `null` if absent or non-string — the proxy still forwards the request and
 * lets upstream emit its own 400.
 */
export const extractModel = (requestBody: unknown): string | null => {
  if (requestBody === null || typeof requestBody !== "object") return null;
  const m = (requestBody as Record<string, unknown>).model;
  return typeof m === "string" ? m : null;
};

export interface ResponseMeta {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly serviceTier: string | null;
  readonly stopReason: string | null;
}

const EMPTY_META: ResponseMeta = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  serviceTier: null,
  stopReason: null,
};

const safeParseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const readUsageObject = (
  obj: Record<string, unknown>,
): Record<string, unknown> | null => {
  // message_start payload nests usage under `message.usage`; message_delta
  // and final non-stream responses expose `usage` at the top.
  const nested = obj.message as Record<string, unknown> | undefined;
  const u = (obj.usage ?? nested?.usage) as Record<string, unknown> | undefined;
  return u ?? null;
};

const readStopReason = (obj: Record<string, unknown>): string | null => {
  // Non-stream final JSON: top-level `stop_reason`.
  // SSE message_delta: `delta.stop_reason`.
  if (typeof obj.stop_reason === "string") return obj.stop_reason;
  const delta = obj.delta as Record<string, unknown> | undefined;
  if (delta && typeof delta.stop_reason === "string") return delta.stop_reason;
  return null;
};

const mergeMeta = (a: ResponseMeta, ev: unknown): ResponseMeta => {
  if (ev === null || typeof ev !== "object") return a;
  const obj = ev as Record<string, unknown>;
  const u = readUsageObject(obj);
  const stop = readStopReason(obj);

  let inputTokens = a.inputTokens;
  let outputTokens = a.outputTokens;
  let cacheReadTokens = a.cacheReadTokens;
  let cacheCreationTokens = a.cacheCreationTokens;
  let serviceTier = a.serviceTier;

  if (u) {
    if (typeof u.input_tokens === "number") {
      inputTokens = Math.max(inputTokens, u.input_tokens);
    }
    if (typeof u.output_tokens === "number") {
      outputTokens = Math.max(outputTokens, u.output_tokens);
    }
    if (typeof u.cache_read_input_tokens === "number") {
      cacheReadTokens = Math.max(cacheReadTokens, u.cache_read_input_tokens);
    }
    if (typeof u.cache_creation_input_tokens === "number") {
      cacheCreationTokens = Math.max(
        cacheCreationTokens,
        u.cache_creation_input_tokens,
      );
    }
    if (typeof u.service_tier === "string") {
      serviceTier = u.service_tier;
    }
  }

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    serviceTier,
    stopReason: stop ?? a.stopReason,
  };
};

/**
 * Pull token counters / service_tier / stop_reason out of a captured response
 * body. SSE: walks every `data:` line; the cumulative usage rolls forward as
 * later events arrive (we take the max so partial events don't shrink it).
 * JSON: a single pass over the parsed object.
 */
export const extractResponseMeta = (rb: ResponseBody | null): ResponseMeta => {
  if (rb === null) return EMPTY_META;
  if (rb.kind === "json") {
    return mergeMeta(EMPTY_META, rb.body);
  }
  if (rb.kind === "text") {
    // Opaque text — no usage to extract.
    return EMPTY_META;
  }
  let meta = EMPTY_META;
  for (const line of rb.raw.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const parsed = safeParseJson(line.slice(6));
    if (parsed !== null) meta = mergeMeta(meta, parsed);
  }
  return meta;
};
