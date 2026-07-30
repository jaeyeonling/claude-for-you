import { describe, expect, test } from 'bun:test';
import {
  archiveBatch,
  buildArchiveKey,
  cutoffFrom,
  parseArchivedRow,
  serializeJsonl,
  type ArchivableRow,
  type ArchiveSource,
} from '../src/usage/messages-log-archive.js';

const row = (id: string, ts: string, overrides: Partial<ArchivableRow> = {}): ArchivableRow => ({
  id,
  ts: new Date(ts),
  userName: 'alice',
  model: 'claude-opus-5',
  status: 200,
  streaming: false,
  durationMs: 1200,
  inputTokens: 10,
  outputTokens: 20,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  serviceTier: 'standard',
  stopReason: 'end_turn',
  clientIp: '10.0.0.1',
  userAgent: 'claude-cli/2.1.201',
  requestBody: { model: 'claude-opus-5', messages: [{ role: 'user', content: 'hi' }] },
  responseBody: { kind: 'json', body: { id: 'msg_1' } },
  errorMessage: null,
  servedBy: 'default',
  bypassMetadata: null,
  source: 'upstream',
  archivedAt: null,
  archiveKey: null,
  ...overrides,
});

interface Recorder {
  readonly source: ArchiveSource;
  readonly calls: string[];
  readonly puts: Array<{ key: string; bytes: number }>;
  readonly marked: Array<{ ids: readonly string[]; key: string }>;
}

const recorder = (batches: ReadonlyArray<readonly ArchivableRow[]>): Recorder => {
  const calls: string[] = [];
  const puts: Array<{ key: string; bytes: number }> = [];
  const marked: Array<{ ids: readonly string[]; key: string }> = [];
  let batchIndex = 0;

  const source: ArchiveSource = {
    async selectBatch() {
      calls.push('select');
      return batches[batchIndex++] ?? [];
    },
    async markArchived(ids, key) {
      calls.push('mark');
      marked.push({ ids, key });
    },
  };
  return { source, calls, puts, marked };
};

const NOW = new Date('2026-07-30T04:17:00.000Z');

describe('buildArchiveKey', () => {
  test('uses hive-style dt= partitioning so Athena can prune later', () => {
    expect(buildArchiveKey('2026-07-15', 1_785_000_000_000, 0)).toBe(
      'messages-log/dt=2026-07-15/part-1785000000000-0.jsonl.gz',
    );
  });

  test('honours a custom prefix', () => {
    expect(buildArchiveKey('2026-07-15', 1, 2, 'backfill')).toBe(
      'backfill/dt=2026-07-15/part-1-2.jsonl.gz',
    );
  });
});

describe('cutoffFrom', () => {
  test('subtracts whole days from now', () => {
    expect(cutoffFrom(NOW, 14).toISOString()).toBe('2026-07-16T04:17:00.000Z');
  });
});

describe('serializeJsonl', () => {
  test('one JSON object per line, ts as ISO-8601 for foreign readers', () => {
    const out = serializeJsonl([row('a', '2026-07-01T00:00:00Z'), row('b', '2026-07-01T01:00:00Z')]);
    const lines = out.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0] as string) as { id: string; ts: string };
    expect(first.id).toBe('a');
    expect(first.ts).toBe('2026-07-01T00:00:00.000Z');
  });

  test('keeps the bodies — they are the entire reason the archive exists', () => {
    const parsed = JSON.parse(serializeJsonl([row('a', '2026-07-01T00:00:00Z')]).trimEnd()) as {
      requestBody: unknown;
      responseBody: unknown;
    };
    expect(parsed.requestBody).toEqual({
      model: 'claude-opus-5',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(parsed.responseBody).toEqual({ kind: 'json', body: { id: 'msg_1' } });
  });
});

describe('archiveBatch', () => {
  test('returns 0 rows and does not write when nothing is eligible', async () => {
    const rec = recorder([[]]);
    const result = await archiveBatch({
      source: rec.source,
      putObject: async () => {
        throw new Error('must not be called');
      },
      now: () => NOW,
      cutoffDays: 14,
      batchSize: 200,
    });
    expect(result.rowsArchived).toBe(0);
    expect(result.parts).toEqual([]);
    expect(rec.calls).toEqual(['select']);
  });

  test('uploads BEFORE marking — the ordering that prevents data loss', async () => {
    const rec = recorder([[row('a', '2026-07-01T00:00:00Z')]]);
    await archiveBatch({
      source: rec.source,
      putObject: async (key, body) => {
        rec.calls.push('put');
        rec.puts.push({ key, bytes: body.byteLength });
      },
      now: () => NOW,
      cutoffDays: 14,
      batchSize: 200,
    });
    // If these ever invert, a failed upload would null bodies that never
    // reached S3 — unrecoverable.
    expect(rec.calls).toEqual(['select', 'put', 'mark']);
  });

  test('a failed upload leaves the rows untouched (no mark, error propagates)', async () => {
    const rec = recorder([[row('a', '2026-07-01T00:00:00Z')]]);
    await expect(
      archiveBatch({
        source: rec.source,
        putObject: async () => {
          throw new Error('AccessDenied');
        },
        now: () => NOW,
        cutoffDays: 14,
        batchSize: 200,
      }),
    ).rejects.toThrow('AccessDenied');
    expect(rec.marked).toEqual([]);
  });

  test('splits a batch straddling midnight into honest dt= partitions', async () => {
    const rec = recorder([
      [
        row('a', '2026-07-01T23:59:00Z'),
        row('b', '2026-07-02T00:01:00Z'),
        row('c', '2026-07-02T05:00:00Z'),
      ],
    ]);
    const result = await archiveBatch({
      source: rec.source,
      putObject: async (key, body) => {
        rec.puts.push({ key, bytes: body.byteLength });
      },
      now: () => NOW,
      cutoffDays: 14,
      batchSize: 200,
    });

    expect(result.rowsArchived).toBe(3);
    expect(result.parts).toHaveLength(2);
    expect(rec.puts.map((p) => p.key)).toEqual([
      `messages-log/dt=2026-07-01/part-${NOW.getTime()}-0.jsonl.gz`,
      `messages-log/dt=2026-07-02/part-${NOW.getTime()}-1.jsonl.gz`,
    ]);
    // Each object is marked with only its own rows, so a mid-loop failure
    // cannot claim rows that were never uploaded.
    expect(rec.marked[0]?.ids).toEqual(['a']);
    expect(rec.marked[1]?.ids).toEqual(['b', 'c']);
  });

  test('gzips the payload (compressed size well under raw JSONL)', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => row(`id-${i}`, '2026-07-01T00:00:00Z'));
    const rawBytes = Buffer.byteLength(serializeJsonl(rows), 'utf8');
    const rec = recorder([rows]);

    const result = await archiveBatch({
      source: rec.source,
      putObject: async () => {},
      now: () => NOW,
      cutoffDays: 14,
      batchSize: 200,
    });

    const compressed = result.parts[0]?.compressedBytes ?? Number.MAX_SAFE_INTEGER;
    expect(compressed).toBeLessThan(rawBytes);
  });

  test('the gzipped object round-trips back to the original rows', async () => {
    // The archive is the only copy after this runs. If it cannot be read back,
    // everything else here is theatre.
    const rec = recorder([[row('a', '2026-07-01T00:00:00Z')]]);
    let captured: Uint8Array | null = null;
    await archiveBatch({
      source: rec.source,
      putObject: async (_key, body) => {
        captured = body;
      },
      now: () => NOW,
      cutoffDays: 14,
      batchSize: 200,
    });

    expect(captured).not.toBeNull();
    const text = new TextDecoder().decode(Bun.gunzipSync(captured as unknown as Uint8Array));
    const parsed = JSON.parse(text.trimEnd()) as { id: string; requestBody: unknown };
    expect(parsed.id).toBe('a');
    expect(parsed.requestBody).toEqual({
      model: 'claude-opus-5',
      messages: [{ role: 'user', content: 'hi' }],
    });
  });

  test('passes the computed cutoff to the source', async () => {
    let seen: Date | null = null;
    const source: ArchiveSource = {
      async selectBatch(cutoff) {
        seen = cutoff;
        return [];
      },
      async markArchived() {},
    };
    await archiveBatch({
      source,
      putObject: async () => {},
      now: () => NOW,
      cutoffDays: 7,
      batchSize: 10,
    });
    expect((seen as unknown as Date).toISOString()).toBe('2026-07-23T04:17:00.000Z');
  });
});

describe('parseArchivedRow', () => {
  const part = (rows: readonly ArchivableRow[]): Uint8Array =>
    Bun.gzipSync(Buffer.from(serializeJsonl(rows), 'utf8'));

  test('finds the requested row and revives Date fields', () => {
    const gz = part([
      row('11111111-1111-1111-1111-111111111111', '2026-07-01T00:00:00Z'),
      row('22222222-2222-2222-2222-222222222222', '2026-07-01T02:00:00Z', {
        archivedAt: new Date('2026-07-20T04:17:00Z'),
      }),
    ]);

    const found = parseArchivedRow(gz, '22222222-2222-2222-2222-222222222222');
    expect(found).not.toBeNull();
    expect(found?.ts).toBeInstanceOf(Date);
    expect(found?.ts.toISOString()).toBe('2026-07-01T02:00:00.000Z');
    expect(found?.archivedAt).toBeInstanceOf(Date);
    // The renderer calls Date methods on these; a string here would throw at
    // render time rather than here, which is a much worse place to find out.
    expect(found?.requestBody).toEqual({
      model: 'claude-opus-5',
      messages: [{ role: 'user', content: 'hi' }],
    });
  });

  test('returns null when the object does not contain the id (stale archive_key)', () => {
    const gz = part([row('11111111-1111-1111-1111-111111111111', '2026-07-01T00:00:00Z')]);
    expect(parseArchivedRow(gz, '99999999-9999-9999-9999-999999999999')).toBeNull();
  });

  test('a corrupt line does not make the rest of the part unreadable', () => {
    const good = serializeJsonl([row('33333333-3333-3333-3333-333333333333', '2026-07-01T00:00:00Z')]);
    const corrupted = `{"id":"33333333-3333-3333-3333-333333333333","ts":\n${good}`;
    const gz = Bun.gzipSync(Buffer.from(corrupted, 'utf8'));

    const found = parseArchivedRow(gz, '33333333-3333-3333-3333-333333333333');
    expect(found?.userName).toBe('alice');
  });

  test('does not match a row whose id merely appears inside another field', () => {
    // The line-level `includes` is only a pre-filter; the id must match the
    // actual `id` field or a prompt containing a UUID would return the wrong row.
    const target = '44444444-4444-4444-4444-444444444444';
    const gz = part([
      row('55555555-5555-5555-5555-555555555555', '2026-07-01T00:00:00Z', {
        requestBody: { messages: [{ role: 'user', content: `see ${target}` }] },
      }),
    ]);
    expect(parseArchivedRow(gz, target)).toBeNull();
  });
});
