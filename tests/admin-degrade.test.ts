import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { createAdminPageHandler, type AdminPageDeps } from '../src/admin/page.js';
import { createStatsHandler } from '../src/admin/stats.js';
import { createMessageDetailHandler, createMessagesListHandler } from '../src/admin/messages.js';
import type { MessageLogStore } from '../src/usage/messages-log.js';
import type { UsageTracker } from '../src/usage/per-user.js';

/**
 * Behavioral verification for the 2026-07-30 degradation work (#149).
 *
 * These are handler-level rather than end-to-end on purpose: `composeApp`
 * cannot represent this incident. With a DATABASE_URL that fails,
 * `createPostgresUsageTracker` throws on its boot-time `CREATE TABLE` and
 * composeApp never resolves — so an app-level test would exercise "the proxy
 * refuses to boot", not "the proxy is up and the DB went bad underneath it",
 * which is what actually happened (the container had booted hours earlier).
 *
 * The distinction is itself worth knowing: a container restart during a
 * storage-full event fails to boot and crash-loops. Boot-time resilience is a
 * separate decision from read-time resilience and is not in scope here.
 */

/** The precise failure from the incident: reachable server, refusing queries. */
const RECOVERY_MODE = 'the database system is in recovery mode';

const throwingTracker: UsageTracker = Object.freeze({
  async assertCanRequest(): Promise<void> {},
  async record(): Promise<void> {},
  async snapshot(): Promise<never> {
    throw new Error(RECOVERY_MODE);
  },
});

const throwingStore: MessageLogStore = Object.freeze({
  async record(): Promise<void> {},
  async list(): Promise<never> {
    throw new Error(RECOVERY_MODE);
  },
  async get(): Promise<never> {
    throw new Error(RECOVERY_MODE);
  },
});

const pageDeps = (): AdminPageDeps =>
  Object.freeze({
    pool: {
      snapshot: () => ({ members: [], sessionAssignments: {} }),
    } as unknown as AdminPageDeps['pool'],
    tracker: throwingTracker,
    globalGuard: {
      snapshot: () => ({ remaining: null, observedAt: null }),
    } as unknown as AdminPageDeps['globalGuard'],
    billingMonitor: {
      snapshot: () => ({ lastObservation: null, nonStandardCount: 0, lastAlarmAt: null }),
    } as unknown as AdminPageDeps['billingMonitor'],
    accountLearner: { current: () => null } as unknown as AdminPageDeps['accountLearner'],
    canary: {
      snapshot: () => ({
        active: false,
        percent: 0,
        tripped: false,
        trippedAt: null,
        trippedReason: null,
        candidateRequests: 0,
        stableRequests: 0,
      }),
    } as unknown as AdminPageDeps['canary'],
    apiKeyStore: { list: () => [] } as unknown as AdminPageDeps['apiKeyStore'],
    alertStore: {
      get: () => ({ discordWebhookUrl: null, slackWebhookUrl: null }),
    } as unknown as AdminPageDeps['alertStore'],
    candidateDescription: null,
    startedAt: Date.now() - 90_000,
    templateDescription: 'cc-snapshot/v2 [stable]',
    testResultStore: {
      latest: () => ({
        'oauth-probe': null,
        'self-ping': null,
        'key-invoke': null,
        'upstream-direct': null,
      }),
    } as unknown as AdminPageDeps['testResultStore'],
  });

describe('/admin with a dead database', () => {
  test('serves 200 HTML instead of a 500 JSON envelope', async () => {
    const app = new Hono();
    app.get('/admin', createAdminPageHandler(pageDeps()));

    const res = await app.request('/admin');

    // The regression this pins: the incident produced 500 +
    // {"error":{"type":"internal_error"}}.
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).not.toContain('internal_error');
  });

  test('names the failing dependency and keeps the working panels', async () => {
    const app = new Hono();
    app.get('/admin', createAdminPageHandler(pageDeps()));

    const html = await (await app.request('/admin')).text();

    expect(html).toContain(RECOVERY_MODE);
    expect(html).toContain('degraded');
    // The panels that need no DB must survive — that is the entire point.
    expect(html).toContain('billing health');
    expect(html).toContain('account pool');
    expect(html).toContain('oauth token rotation');
  });
});

describe('/admin/stats with a dead database', () => {
  test('returns 200 with perUserUsage null and the dependency listed in degraded', async () => {
    const app = new Hono();
    app.get('/admin/stats', createStatsHandler(pageDeps()));

    const res = await app.request('/admin/stats');
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      perUserUsage: unknown;
      degraded: ReadonlyArray<{ dependency: string; reason: string }>;
      server: { runtime: string };
    };
    expect(body.perUserUsage).toBeNull();
    expect(body.degraded).toHaveLength(1);
    expect(body.degraded[0]?.dependency).toBe('perUserUsage');
    expect(body.degraded[0]?.reason).toBe(RECOVERY_MODE);
    // Additive change: fields that never needed the DB still populate.
    expect(body.server.runtime).toContain('bun');
  });
});

describe('/admin/messages with a dead log store', () => {
  test('list renders the store-unavailable page, not a 500', async () => {
    const app = new Hono();
    app.get('/admin/messages', createMessagesListHandler({ store: throwingStore }));

    const res = await app.request('/admin/messages');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('store unavailable');
    expect(html).toContain(RECOVERY_MODE);
  });

  test('detail renders the store-unavailable page for a well-formed id', async () => {
    const app = new Hono();
    app.get('/admin/messages/:id', createMessageDetailHandler({ store: throwingStore }));

    const res = await app.request('/admin/messages/3f2504e0-4f89-11d3-9a0c-0305e82c3301');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('store unavailable');
  });

  test('detail still rejects a malformed id before touching the store', async () => {
    // Ordering guard: the UUID check must stay ahead of the store call, so a
    // junk id remains a 400 and does not surface as "store unavailable".
    const app = new Hono();
    app.get('/admin/messages/:id', createMessageDetailHandler({ store: throwingStore }));

    const res = await app.request('/admin/messages/not-a-uuid');
    expect(res.status).toBe(400);
  });
});
