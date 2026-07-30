import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import {
  createArchivedMessageHandler,
  createMessageDetailHandler,
} from '../src/admin/messages.js';
import { serializeJsonl, type ArchivableRow } from '../src/usage/messages-log-archive.js';
import type { MessageLogRecord, MessageLogStore } from '../src/usage/messages-log.js';

/**
 * Cold-storage read-back path (#150). Covers the three states the detail page
 * must distinguish — hot, archived-and-readable, archived-but-no-credentials —
 * because collapsing them sends an operator hunting for a bug that isn't there.
 */

const ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const KEY = 'messages-log/dt=2026-07-01/part-1785000000000-0.jsonl.gz';

const baseRow = (overrides: Partial<MessageLogRecord> = {}): MessageLogRecord => ({
  id: ID,
  ts: new Date('2026-07-01T00:00:00Z'),
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
  requestBody: { model: 'claude-opus-5', messages: [{ role: 'user', content: 'archived hello' }] },
  responseBody: { kind: 'json', body: { id: 'msg_1' } },
  errorMessage: null,
  servedBy: 'default',
  bypassMetadata: null,
  source: 'upstream',
  archivedAt: null,
  archiveKey: null,
  ...overrides,
});

/** A stub row as it looks in Postgres AFTER archiving: metadata, no bodies. */
const stubRow = (): MessageLogRecord =>
  baseRow({
    requestBody: null,
    responseBody: null,
    archivedAt: new Date('2026-07-20T04:17:00Z'),
    archiveKey: KEY,
  });

const storeOf = (record: MessageLogRecord | null): MessageLogStore =>
  Object.freeze({
    async record(): Promise<void> {},
    async list() {
      return [];
    },
    async get() {
      return record;
    },
  });

const partContaining = (rows: readonly ArchivableRow[]): Uint8Array =>
  Bun.gzipSync(Buffer.from(serializeJsonl(rows), 'utf8'));

describe('detail page — archive banner states', () => {
  test('hot row shows no archive banner', async () => {
    const app = new Hono();
    app.get('/admin/messages/:id', createMessageDetailHandler({ store: storeOf(baseRow()) }));
    const html = await (await app.request(`/admin/messages/${ID}`)).text();
    expect(html).not.toContain('archived to cold storage');
  });

  test('archived row with read capability offers the fetch link', async () => {
    const app = new Hono();
    app.get(
      '/admin/messages/:id',
      createMessageDetailHandler({ store: storeOf(stubRow()), readArchive: async () => new Uint8Array() }),
    );
    const html = await (await app.request(`/admin/messages/${ID}`)).text();
    expect(html).toContain('archived to cold storage');
    expect(html).toContain(`/admin/messages/${ID}/archived`);
    expect(html).toContain(KEY);
  });

  test('archived row without credentials shows the key and a runnable command', async () => {
    const app = new Hono();
    app.get('/admin/messages/:id', createMessageDetailHandler({ store: storeOf(stubRow()) }));
    const html = await (await app.request(`/admin/messages/${ID}`)).text();
    expect(html).toContain('no S3 read credentials');
    expect(html).toContain('aws s3 cp');
    expect(html).toContain(KEY);
    // No dead link: the fetch route would 501, so it must not be offered.
    expect(html).not.toContain(`href="/admin/messages/${ID}/archived"`);
  });
});

describe('GET /admin/messages/:id/archived', () => {
  const mount = (deps: Parameters<typeof createArchivedMessageHandler>[0]): Hono => {
    const app = new Hono();
    app.get('/admin/messages/:id/archived', createArchivedMessageHandler(deps));
    return app;
  };

  test('renders the full bodies read back from S3', async () => {
    const app = mount({
      store: storeOf(stubRow()),
      readArchive: async (key) => {
        expect(key).toBe(KEY);
        return partContaining([baseRow() as ArchivableRow]);
      },
    });

    const res = await app.request(`/admin/messages/${ID}/archived`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('restored from cold storage');
    expect(html).toContain(KEY);
    // The actual payload, not just a banner about it.
    expect(html).toContain('archived hello');
  });

  test('501 when archive reads are not configured', async () => {
    const res = await mount({ store: storeOf(stubRow()) }).request(
      `/admin/messages/${ID}/archived`,
    );
    expect(res.status).toBe(501);
  });

  test('404 when the row exists but was never archived', async () => {
    const res = await mount({
      store: storeOf(baseRow()),
      readArchive: async () => new Uint8Array(),
    }).request(`/admin/messages/${ID}/archived`);
    expect(res.status).toBe(404);
  });

  test('502 when the object exists but does not contain the row', async () => {
    // Stale archive_key, or a part replaced out from under us. Naming this
    // precisely beats rendering a blank page.
    const res = await mount({
      store: storeOf(stubRow()),
      readArchive: async () =>
        partContaining([{ ...baseRow(), id: '00000000-0000-0000-0000-000000000000' } as ArchivableRow]),
    }).request(`/admin/messages/${ID}/archived`);
    expect(res.status).toBe(502);
    expect(await res.text()).toContain(KEY);
  });

  test('renders the store-unavailable page when S3 itself fails', async () => {
    const res = await mount({
      store: storeOf(stubRow()),
      readArchive: async () => {
        throw new Error('AccessDenied');
      },
    }).request(`/admin/messages/${ID}/archived`);
    // Degraded, not a 500 — same contract as the rest of the admin surface.
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('AccessDenied');
  });

  test('rejects a malformed id before any store or S3 call', async () => {
    const res = await mount({
      store: storeOf(stubRow()),
      readArchive: async () => {
        throw new Error('must not be called');
      },
    }).request('/admin/messages/not-a-uuid/archived');
    expect(res.status).toBe(400);
  });
});
