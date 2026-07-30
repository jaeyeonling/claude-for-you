import type { Context } from 'hono';
import type {
  ListFilters,
  MessageLogStore,
  MessageSource,
  StatusClass,
} from '../usage/messages-log.js';
import { attempt } from '../lib/degrade.js';
import { parseArchivedRow } from '../usage/messages-log-archive.js';
import {
  renderMessageDetail,
  renderMessagesList,
  renderStoreUnavailable,
} from './messages-render.js';

/**
 * Handlers for the messages-log admin pages. Pure orchestration — fetches
 * from the store, hands shape to the renderer. The renderer is the
 * unit-testable surface; this layer is HTTP wiring only.
 */

const PAGE_LIMIT = 100;

const parseStatusClass = (raw: string | undefined): StatusClass => {
  if (raw === 'success' || raw === 'error') return raw;
  return 'all';
};

const parseSource = (raw: string | undefined): 'all' | MessageSource => {
  if (raw === 'client' || raw === 'proxy' || raw === 'upstream') return raw;
  return 'all';
};

const parseBefore = (raw: string | undefined): Date | undefined => {
  if (!raw) return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d;
};

export interface MessagesAdminDeps {
  readonly store: MessageLogStore;
  /**
   * Fetches an archived part from cold storage (#150). Null when archiving is
   * not configured, or when the app has no S3 read credentials — the app
   * container cannot use the instance role (IMDS is unreachable at
   * `http_put_response_hop_limit = 1`), so this is wired only when a read-only
   * key is present. Absent capability degrades to showing the object key.
   */
  readonly readArchive?: ((key: string) => Promise<Uint8Array>) | null;
}

export const createMessagesListHandler =
  (deps: MessagesAdminDeps) =>
  async (c: Context): Promise<Response> => {
    const url = new URL(c.req.url);
    const q = (url.searchParams.get('q') ?? '').trim();
    const user = (url.searchParams.get('user') ?? '').trim();
    const model = (url.searchParams.get('model') ?? '').trim();
    const status = parseStatusClass(url.searchParams.get('status') ?? undefined);
    const source = parseSource(url.searchParams.get('source') ?? undefined);
    const before = parseBefore(url.searchParams.get('before') ?? undefined);

    const filters: ListFilters = {
      ...(user.length > 0 ? { userName: user } : {}),
      ...(model.length > 0 ? { model } : {}),
      ...(status !== 'all' ? { statusClass: status } : {}),
      ...(source !== 'all' ? { source } : {}),
      ...(q.length > 0 ? { search: q } : {}),
      ...(before ? { before } : {}),
      limit: PAGE_LIMIT,
    };

    const listed = await attempt('messages-log-list', () => deps.store.list(filters));
    if (!listed.ok) return c.html(renderStoreUnavailable(listed.reason));
    const rows = listed.value;
    // Cursor for the next page = ts of the OLDEST row on this page (rows are
    // ordered DESC). When fewer than PAGE_LIMIT rows came back we've hit the
    // tail — no next cursor.
    const lastRow = rows[rows.length - 1];
    const nextCursor =
      rows.length >= PAGE_LIMIT && lastRow ? lastRow.ts.toISOString() : null;

    return c.html(
      renderMessagesList({
        rows,
        filters: { q, user, model, status, source },
        nextCursor,
        hasPrev: before !== undefined,
      }),
    );
  };

// RFC 4122 UUID (any version). Guards `store.get()` from PG raising a
// `22P02 invalid_input_syntax` when a non-UUID is passed in the URL —
// which Hono's onError would otherwise surface as a generic 500.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const createMessageDetailHandler =
  (deps: MessagesAdminDeps) =>
  async (c: Context): Promise<Response> => {
    const id = c.req.param('id');
    if (!id || !UUID_RE.test(id)) return c.text('invalid id', 400);

    const fetched = await attempt('messages-log-get', () => deps.store.get(id));
    if (!fetched.ok) return c.html(renderStoreUnavailable(fetched.reason));
    const record = fetched.value;
    if (!record) return c.text('not found', 404);

    return c.html(renderMessageDetail(record, { canReadArchive: Boolean(deps.readArchive) }));
  };

/**
 * GET /admin/messages/:id/archived — re-hydrate a row whose bodies were moved
 * to cold storage and render the ordinary detail page from the archived copy.
 *
 * Kept as a separate route rather than folded into the detail handler so the
 * S3 round-trip is opt-in per click. Archived rows are by definition the old
 * ones; making every detail view pay a possible cold-storage fetch would be a
 * latency tax on the common case.
 */
export const createArchivedMessageHandler =
  (deps: MessagesAdminDeps) =>
  async (c: Context): Promise<Response> => {
    const id = c.req.param('id');
    if (!id || !UUID_RE.test(id)) return c.text('invalid id', 400);

    const readArchive = deps.readArchive;
    if (!readArchive) {
      return c.text(
        'archive reads are not configured on this instance (no S3 read credentials)',
        501,
      );
    }

    const fetched = await attempt('messages-log-get', () => deps.store.get(id));
    if (!fetched.ok) return c.html(renderStoreUnavailable(fetched.reason));
    const record = fetched.value;
    if (!record) return c.text('not found', 404);

    const key = record.archiveKey;
    if (!key) return c.text('this message is not archived', 404);

    const object = await attempt('messages-log-archive-read', () => readArchive(key));
    if (!object.ok) return c.html(renderStoreUnavailable(object.reason));

    // A miss here is a real inconsistency worth naming precisely rather than
    // rendering an empty page: the row points at an object that does not
    // contain it (stale key, or a part that was replaced by a lifecycle rule).
    const archived = parseArchivedRow(object.value, id);
    if (!archived) {
      return c.text(`archived object ${key} does not contain row ${id}`, 502);
    }

    return c.html(renderMessageDetail(archived, { canReadArchive: true, restoredFrom: key }));
  };
