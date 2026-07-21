import postgres from "postgres";
import type {
  ListFilters,
  MessageLogRecord,
  MessageLogStore,
  MessageLogSummary,
  MessageSource,
  ResponseBody,
} from "./messages-log.js";
import { extractPreview, sanitizeJsonValue } from "./messages-log.js";

/**
 * Postgres-backed MessageLogStore.
 *
 * Schema: one row per `/v1/messages` call, with full request/response JSON.
 * Writes are fire-and-forget from the proxy (see `proxy/messages.ts`) — a DB
 * outage must NOT break user-visible traffic.
 *
 * Row size note: with 1M-context bodies a single row can be multiple MB.
 * JSONB columns are TOAST-compressed transparently, but unbounded retention +
 * heavy users means the table can grow fast. The operator must plan for
 * pg_repack / partition pruning out-of-band — this module has no TTL.
 *
 * postgres.js pool sized at 2: writes are mostly serialized (single proxy
 * container) and admin queries are rare. Bumping the pool buys little while
 * the per-key concurrency cap (`MAX_CONCURRENT_REQUESTS_PER_KEY`) already
 * keeps inflight work small.
 */

export interface PostgresMessageLogStoreParams {
  readonly databaseUrl: string;
}

interface DetailRow {
  readonly id: string;
  readonly ts: Date;
  readonly user_name: string;
  readonly model: string | null;
  readonly status: number;
  readonly streaming: boolean;
  readonly duration_ms: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_tokens: number;
  readonly cache_creation_tokens: number;
  readonly service_tier: string | null;
  readonly stop_reason: string | null;
  readonly client_ip: string | null;
  readonly user_agent: string | null;
  readonly request_body: unknown;
  readonly response_body: ResponseBody | null;
  readonly error_message: string | null;
  readonly served_by: string | null;
  readonly bypass_metadata: unknown;
  readonly source: MessageSource | null;
}

interface SummaryRow {
  readonly id: string;
  readonly ts: Date;
  readonly user_name: string;
  readonly model: string | null;
  readonly status: number;
  readonly streaming: boolean;
  readonly duration_ms: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly service_tier: string | null;
  readonly preview: string;
  readonly source: MessageSource | null;
}

const toSummary = (r: SummaryRow): MessageLogSummary => ({
  id: r.id,
  ts: r.ts,
  userName: r.user_name,
  model: r.model,
  status: r.status,
  streaming: r.streaming,
  durationMs: r.duration_ms,
  inputTokens: r.input_tokens,
  outputTokens: r.output_tokens,
  serviceTier: r.service_tier,
  preview: r.preview,
  source: r.source ?? null,
});

const toRecord = (r: DetailRow): MessageLogRecord => ({
  id: r.id,
  ts: r.ts,
  userName: r.user_name,
  model: r.model,
  status: r.status,
  streaming: r.streaming,
  durationMs: r.duration_ms,
  inputTokens: r.input_tokens,
  outputTokens: r.output_tokens,
  cacheReadTokens: r.cache_read_tokens,
  cacheCreationTokens: r.cache_creation_tokens,
  serviceTier: r.service_tier,
  stopReason: r.stop_reason,
  clientIp: r.client_ip,
  userAgent: r.user_agent,
  requestBody: r.request_body,
  responseBody: r.response_body,
  errorMessage: r.error_message,
  servedBy: r.served_by,
  bypassMetadata: r.bypass_metadata,
  source: r.source ?? null,
});

export const createPostgresMessageLogStore = async (
  params: PostgresMessageLogStoreParams,
): Promise<MessageLogStore> => {
  const sql = postgres(params.databaseUrl, {
    max: 2,
    idle_timeout: 30,
    connect_timeout: 10,
  });

  await sql`
    CREATE TABLE IF NOT EXISTS messages_log (
      id UUID PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL,
      user_name TEXT NOT NULL,
      model TEXT,
      status SMALLINT NOT NULL,
      streaming BOOLEAN NOT NULL,
      duration_ms INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      service_tier TEXT,
      stop_reason TEXT,
      client_ip TEXT,
      user_agent TEXT,
      request_body JSONB NOT NULL,
      response_body JSONB,
      preview TEXT NOT NULL DEFAULT '',
      error_message TEXT,
      served_by TEXT,
      bypass_metadata JSONB
    )
  `;
  // Idempotent ALTERs for older deployments (table predates the column).
  // IF NOT EXISTS keeps the create path above and the migration path here
  // converging on the same shape; PG ignores the no-op on fresh tables.
  await sql`ALTER TABLE messages_log ADD COLUMN IF NOT EXISTS served_by TEXT`;
  await sql`ALTER TABLE messages_log ADD COLUMN IF NOT EXISTS bypass_metadata JSONB`;
  // Failure-origin classifier (issue #144). NULL on rows written before it.
  await sql`ALTER TABLE messages_log ADD COLUMN IF NOT EXISTS source TEXT`;
  // Indexes: ts-desc is the dashboard's default scan; (user, ts) accelerates
  // per-user views; status-partial gates the "errors only" filter without
  // bloating the index for the 2xx majority.
  await sql`CREATE INDEX IF NOT EXISTS idx_messages_log_ts ON messages_log (ts DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_messages_log_user_ts ON messages_log (user_name, ts DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_messages_log_status_ts ON messages_log (status, ts DESC) WHERE status >= 400`;

  // `preview ILIKE '%foo%'` has a leading-wildcard pattern that a plain B-tree
  // can't help with. pg_trgm + GIN gives us proper sub-string acceleration —
  // without it the admin search scans the full table once it grows past
  // toy size. CREATE EXTENSION may require superuser; failure is non-fatal
  // (search still works, just slower).
  try {
    await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`;
    await sql`CREATE INDEX IF NOT EXISTS idx_messages_log_preview_trgm ON messages_log USING gin (preview gin_trgm_ops)`;
  } catch {
    // No-op: pg_trgm not available or insufficient privileges. ILIKE search
    // falls back to a seq scan, which is fine until the table grows large.
  }

  return Object.freeze({
    async record(entry: MessageLogRecord): Promise<void> {
      // Strip NUL (U+0000) before handing off to JSONB. Postgres TEXT/JSONB
      // cannot store NUL and rejects the entire row with `unsupported Unicode
      // escape sequence`. Replacement is intentionally visible (U+FFFD) so
      // admin operators can spot tainted payloads in the dashboard.
      const safeRequestBody = sanitizeJsonValue(entry.requestBody);
      const safeResponseBody =
        entry.responseBody === null
          ? null
          : sanitizeJsonValue(entry.responseBody);
      const safeBypassMetadata =
        entry.bypassMetadata === null || entry.bypassMetadata === undefined
          ? null
          : sanitizeJsonValue(entry.bypassMetadata);
      // Extract preview *after* sanitize. The `preview` TEXT column is subject
      // to the same NUL rejection as JSONB, and a NUL anywhere in the last
      // user message would otherwise leak into the column unsanitized.
      const preview = extractPreview(safeRequestBody);
      // `as never`: postgres.js `sql.json` is typed to accept its own
      // SerializableParameter set, not `unknown`. Our sanitizer returns
      // `unknown` by contract (it operates over arbitrary JSON shapes).
      // The runtime contract is JSON-serializable, so the cast is sound.
      await sql`
        INSERT INTO messages_log (
          id, ts, user_name, model, status, streaming, duration_ms,
          input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
          service_tier, stop_reason, client_ip, user_agent,
          request_body, response_body, preview, error_message,
          served_by, bypass_metadata, source
        ) VALUES (
          ${entry.id}, ${entry.ts}, ${entry.userName}, ${entry.model}, ${entry.status},
          ${entry.streaming}, ${entry.durationMs},
          ${entry.inputTokens}, ${entry.outputTokens},
          ${entry.cacheReadTokens}, ${entry.cacheCreationTokens},
          ${entry.serviceTier}, ${entry.stopReason}, ${entry.clientIp}, ${entry.userAgent},
          ${sql.json(safeRequestBody as never)},
          ${safeResponseBody === null ? null : sql.json(safeResponseBody as never)},
          ${preview},
          ${entry.errorMessage},
          ${entry.servedBy},
          ${safeBypassMetadata === null ? null : sql.json(safeBypassMetadata as never)},
          ${entry.source ?? null}
        )
      `;
    },

    async list(filters: ListFilters): Promise<readonly MessageLogSummary[]> {
      // Optional filters expressed via NULL-coalescing: each predicate is a
      // no-op when its parameter is null. PG planner handles this fine and
      // we avoid runtime fragment composition.
      const userName = filters.userName ?? null;
      const model = filters.model ?? null;
      const statusClass = filters.statusClass ?? "all";
      const source = filters.source ?? null;
      const search =
        filters.search && filters.search.length > 0 ? filters.search : null;
      const before = filters.before ?? null;
      const limit = Math.max(1, Math.min(filters.limit, 500));

      const rows = await sql<SummaryRow[]>`
        SELECT id, ts, user_name, model, status, streaming, duration_ms,
               input_tokens, output_tokens, service_tier, preview, source
          FROM messages_log
         WHERE (${userName}::text IS NULL OR user_name = ${userName})
           AND (${model}::text IS NULL OR model = ${model})
           AND (${statusClass}::text = 'all'
                OR (${statusClass}::text = 'success' AND status >= 200 AND status < 300)
                OR (${statusClass}::text = 'error'   AND status >= 400))
           AND (${source}::text IS NULL OR source = ${source})
           AND (${search}::text IS NULL OR preview ILIKE '%' || ${search}::text || '%')
           AND (${before}::timestamptz IS NULL OR ts < ${before})
         ORDER BY ts DESC
         LIMIT ${limit}
      `;
      return rows.map(toSummary);
    },

    async get(id: string): Promise<MessageLogRecord | null> {
      const rows = await sql<DetailRow[]>`
        SELECT id, ts, user_name, model, status, streaming, duration_ms,
               input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
               service_tier, stop_reason, client_ip, user_agent,
               request_body, response_body, error_message,
               served_by, bypass_metadata, source
          FROM messages_log
         WHERE id = ${id}
      `;
      const first = rows[0];
      return first ? toRecord(first) : null;
    },

    async close(): Promise<void> {
      await sql.end({ timeout: 5 });
    },
  });
};
