import type { MessageLogRecord } from './messages-log.js';
import { utcDayKey } from './per-user.js';

/**
 * Cold-storage archival for `messages_log` (issue #150).
 *
 * `messages_log` stores the full request and response body of every
 * `/v1/messages` call and had no retention policy — roughly 2GB/week, which
 * filled a 20GB volume in ten weeks and caused the 2026-07-30 outage (#149).
 *
 * The fix is to move bytes, not to delete rows. Only `request_body` and
 * `response_body` consume real space; the rest of the row (timestamps, tokens,
 * status, preview) is a few hundred bytes and is what the admin list view,
 * search, and per-user aggregates actually read. So an archived row keeps
 * every queryable column and nulls only the two JSONB payloads, recording
 * where they went in `archive_key`. Space drops ~99%, history stays intact.
 *
 * This module owns the pure part: grouping, serialization, key layout, and the
 * ordering guarantee. The `ArchiveSource` implementation (SQL) lives with the
 * connection in `messages-log-postgres.ts`, and `putObject` is supplied by the
 * CLI entrypoint — which is what makes this testable without a database or a
 * network.
 */

/** One archivable row: the full record, bodies included. */
export type ArchivableRow = MessageLogRecord;

export interface ArchiveSource {
  /** Rows older than `cutoff` that have not been archived yet, oldest first. */
  selectBatch(cutoff: Date, limit: number): Promise<readonly ArchivableRow[]>;
  /**
   * Null the two body columns and stamp `archived_at` / `archive_key`.
   * MUST only be called after the object is durably stored.
   */
  markArchived(ids: readonly string[], archiveKey: string, at: Date): Promise<void>;
}

export interface ArchiveDeps {
  readonly source: ArchiveSource;
  readonly putObject: (key: string, body: Uint8Array) => Promise<void>;
  readonly now: () => Date;
  /** Rows younger than this stay hot in Postgres. */
  readonly cutoffDays: number;
  readonly batchSize: number;
  /** Key prefix inside the bucket. Defaults to `messages-log`. */
  readonly prefix?: string;
}

export interface ArchivedPart {
  readonly key: string;
  readonly rows: number;
  readonly compressedBytes: number;
}

export interface ArchiveBatchResult {
  readonly rowsArchived: number;
  readonly parts: readonly ArchivedPart[];
}

const DEFAULT_PREFIX = 'messages-log';

/**
 * Hive-style `dt=` partitioning, so Athena (or any partition-aware reader) can
 * be pointed at the bucket later without re-laying out years of objects. The
 * partition is the DATA's date, not the run's — see the grouping in
 * `archiveBatch` for why that distinction is enforced rather than assumed.
 */
export const buildArchiveKey = (
  day: string,
  epochMs: number,
  seq: number,
  prefix: string = DEFAULT_PREFIX,
): string => `${prefix}/dt=${day}/part-${epochMs}-${seq}.jsonl.gz`;

/**
 * One JSON object per line. `ts` is serialized as ISO-8601 rather than left to
 * `Date`'s default so the archive is readable by tools that never saw this
 * codebase.
 */
export const serializeJsonl = (rows: readonly ArchivableRow[]): string =>
  rows.map((r) => JSON.stringify({ ...r, ts: r.ts.toISOString() })).join('\n') + '\n';

export const cutoffFrom = (now: Date, cutoffDays: number): Date =>
  new Date(now.getTime() - cutoffDays * 24 * 60 * 60 * 1000);

/**
 * Pull one row back out of a gzipped JSONL part, by id. Powers the admin detail
 * view's "open archived bodies" path.
 *
 * A part holds up to `batchSize` rows, so this scans lines rather than seeking.
 * That is fine at 200 rows/part; if parts ever grow by orders of magnitude the
 * answer is smaller parts, not an index — a linear scan of one object is far
 * simpler to reason about than a second consistency problem.
 *
 * Returns null when the id is absent (stale `archive_key`, wrong object) and
 * skips malformed lines rather than throwing: a single corrupt line must not
 * make the other 199 rows unreadable.
 */
export const parseArchivedRow = (gzipped: Uint8Array, id: string): ArchivableRow | null => {
  // Buffer.from copies into a plain ArrayBuffer. Needed because the caller's
  // Uint8Array may be backed by a SharedArrayBuffer (Uint8Array<ArrayBufferLike>),
  // which gunzipSync's signature rejects.
  const text = new TextDecoder().decode(Bun.gunzipSync(Buffer.from(gzipped)));
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    // Cheap pre-filter: skip JSON.parse on lines that cannot contain the id.
    if (!line.includes(id)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== 'object') continue;
    const obj = parsed as Record<string, unknown>;
    if (obj.id !== id) continue;
    return {
      ...(obj as unknown as ArchivableRow),
      // Revive the fields serialized as ISO strings — the renderer calls
      // Date methods on them.
      ts: new Date(String(obj.ts)),
      archivedAt: obj.archivedAt ? new Date(String(obj.archivedAt)) : null,
    };
  }
  return null;
};

/**
 * Archive one batch. Returns `rowsArchived: 0` when there is nothing eligible,
 * which is the caller's signal to stop looping.
 *
 * Ordering is the load-bearing property: upload, THEN mark. If the upload
 * succeeds and the UPDATE fails, the batch is retried on the next run and
 * re-uploaded under a new key — the previous object becomes an unreferenced
 * orphan, which costs a few cents of S3 and loses nothing. The reverse order
 * would null the bodies of rows whose payload never reached S3, which is
 * unrecoverable. Never reorder these two calls.
 */
export const archiveBatch = async (deps: ArchiveDeps): Promise<ArchiveBatchResult> => {
  const now = deps.now();
  const rows = await deps.source.selectBatch(cutoffFrom(now, deps.cutoffDays), deps.batchSize);
  if (rows.length === 0) return { rowsArchived: 0, parts: [] };

  // Group by the row's own UTC day. A batch can straddle midnight (or, on a
  // first run over a backlog, span months) — writing all of it under a single
  // `dt=` would make the partition a lie and silently break every partition
  // predicate a future reader writes.
  const byDay = new Map<string, ArchivableRow[]>();
  for (const row of rows) {
    const day = utcDayKey(row.ts);
    const bucket = byDay.get(day);
    if (bucket) bucket.push(row);
    else byDay.set(day, [row]);
  }

  const epochMs = now.getTime();
  const parts: ArchivedPart[] = [];
  let rowsArchived = 0;
  let seq = 0;

  // Sequential, not Promise.all: a partial failure must leave a coherent state,
  // and the whole point of this job is to be gentle with a database that has
  // already been pushed to its limit once.
  for (const [day, dayRows] of byDay) {
    const key = buildArchiveKey(day, epochMs, seq, deps.prefix);
    const compressed = Bun.gzipSync(Buffer.from(serializeJsonl(dayRows), 'utf8'));

    await deps.putObject(key, compressed);
    await deps.source.markArchived(
      dayRows.map((r) => r.id),
      key,
      now,
    );

    parts.push({ key, rows: dayRows.length, compressedBytes: compressed.byteLength });
    rowsArchived += dayRows.length;
    seq += 1;
  }

  return { rowsArchived, parts };
};
