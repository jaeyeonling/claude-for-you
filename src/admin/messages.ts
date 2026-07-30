import type { Context } from 'hono';
import type {
  ListFilters,
  MessageLogStore,
  MessageSource,
  StatusClass,
} from '../usage/messages-log.js';
import { attempt } from '../lib/degrade.js';
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

    return c.html(renderMessageDetail(record));
  };
