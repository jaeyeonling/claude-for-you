import { serve as honoServeNode } from '@hono/node-server';
import { Hono } from 'hono';
import { dirname, join } from 'node:path';
import { createAccountLearner } from './account-learner.js';
import { createAlertsHandlers } from './admin/alerts.js';
import { createKeysHandlers } from './admin/keys.js';
import { createOAuthReplaceHandler } from './admin/oauth.js';
import { createAdminPageHandler } from './admin/page.js';
import { createSnapshotHandlers } from './admin/snapshot.js';
import { createStatsHandler } from './admin/stats.js';
import { createDynamicSink, withCooldown } from './alerts.js';
import { createAlertStore } from './alerts-store.js';
import { singleAccountPool, tryLoadAccountPool } from './auth/account-pool.js';
import { createApiKeyMiddleware } from './auth/api-key.js';
import { createApiKeyStore } from './auth/api-key-store.js';
import { createOAuthManager } from './auth/oauth.js';
import { ConfigError } from './lib/errors.js';
import { createCanaryController } from './canary.js';
import { createCaptureMiddleware, loadCaptureConfig } from './capture.js';
import { loadConfig } from './config.js';
import { DomainError } from './lib/errors.js';
import { createPacingEnforcer } from './pacing.js';
import { createMessagesHandler } from './proxy/messages.js';
import {
  createExtractedTemplate,
  recommendedMinGapMs,
  tryCreateCandidateTemplate,
} from './template/extracted.js';
import { createBillingMonitor } from './usage/billing-monitor.js';
import { createDriftAnalyzer } from './usage/drift-analyzer.js';
import { createGlobalGuard } from './usage/global.js';
import { createUsageTracker } from './usage/per-user.js';
import { createPostgresUsageTracker } from './usage/per-user-postgres.js';

const config = loadConfig();
const startedAt = Date.now();

// Mutable webhook config — boot baseline from env, operator can hot-swap via
// /admin/alerts/*. Persisted to alerts.json next to the token store.
const alertStore = await createAlertStore({
  filePath: join(dirname(config.tokenStorePath), 'alerts.json'),
  envDiscord: config.discordWebhookUrl,
  envSlack: config.slackWebhookUrl,
});
const rawSink = createDynamicSink(alertStore);

const oauthFailSink = withCooldown(rawSink, 60_000);
const serverErrorSink = withCooldown(rawSink, 60_000);

// Auth source selection:
//   1. accounts.json (multi-account pool) if present → wins
//   2. ANTHROPIC_OAUTH_REFRESH_TOKEN env → single-account pool wrapping
const multiAccountPool = await tryLoadAccountPool({
  accountsPath: config.accountsPath,
  tokenStoreBaseDir: dirname(config.tokenStorePath),
  onRefreshFail: (memberName, reason) => {
    const msg = `[oauth/${memberName}] ⚠️  refresh failed: ${reason}`;
    console.error(msg);
    void oauthFailSink(msg);
  },
});

let pool: import('./auth/account-pool.js').AccountPool;
if (multiAccountPool) {
  pool = multiAccountPool;
} else {
  if (config.oauth.refreshToken.length === 0) {
    throw ConfigError(
      `No auth source: set ANTHROPIC_OAUTH_REFRESH_TOKEN, or provide ${config.accountsPath}`,
    );
  }
  const oauth = await createOAuthManager({
    envState: {
      accessToken: config.oauth.accessToken ?? '',
      refreshToken: config.oauth.refreshToken,
      expiresAt: config.oauth.expiresAt ?? 0,
    },
    storePath: config.tokenStorePath,
    onRefreshFail: (reason) => {
      const msg = `[oauth] ⚠️  refresh failed: ${reason}`;
      console.error(msg);
      void oauthFailSink(msg);
    },
  });
  pool = singleAccountPool(oauth);
}

// Postgres-backed usage tracker survives container restarts and is shared
// across replicas. Falls back to in-memory only if DATABASE_URL is unset
// (test harnesses, ad-hoc local debugging without docker).
const tracker = config.databaseUrl
  ? await createPostgresUsageTracker({
      databaseUrl: config.databaseUrl,
      dailyLimitPerKey: config.dailyTokenLimitPerKey,
    })
  : createUsageTracker({ dailyLimitPerKey: config.dailyTokenLimitPerKey });
const globalGuard = createGlobalGuard({
  thresholdTokens: config.globalSubscriptionThresholdTokens,
});
const drift = createDriftAnalyzer();
const billingMonitor = createBillingMonitor({ sink: rawSink, drift });
const accountLearner = createAccountLearner(config.accountUuidOverride);

// Best-effort: try CC's documented bootstrap endpoints once at startup to
// pull a real account_uuid. Silent failure — falls back to response-header
// learning (anthropic-organization-id) on the first /v1/messages call.
if (!config.accountUuidOverride) {
  try {
    const { token } = await pool.getAccessToken(undefined);
    const learned = await accountLearner.bootstrap(token);
    if (learned) console.log(`[claude-for-you] account_uuid bootstrap: learned ${learned}`);
  } catch {
    // ignore — graceful degradation to header learning
  }
}
// pacing min-gap: env wins. If unset (=0), fall back to snapshot's p50.
const effectivePacingMinGapMs =
  config.pacingMinGapMs > 0 ? config.pacingMinGapMs : (recommendedMinGapMs() ?? 0);
const pacing = createPacingEnforcer({ minGapMs: effectivePacingMinGapMs });
const template = createExtractedTemplate({ accountLearner });

// Canary: a sibling template loaded from cc-snapshot.candidate.json if present.
// CANARY_PERCENT (env) controls the traffic share. Auto-trips on any
// service_tier alarm coming from a candidate request.
const candidateTemplate = tryCreateCandidateTemplate({ accountLearner });
const canary = createCanaryController({
  candidate: candidateTemplate,
  percent: config.canaryPercent,
});

const app = new Hono();

// Access log (temporary, debug only) — surfaces which paths the client hits.
app.use('*', async (c, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  console.log(`[req] ${c.req.method} ${new URL(c.req.url).pathname} → ${c.res.status} (${ms}ms)`);
});

app.get('/healthz', (c) => c.json({ ok: true }));

const captureCfg = loadCaptureConfig();

const apiKeyStore = createApiKeyStore({
  envKeys: config.apiKeys,
  filePath: config.apiKeysFilePath,
});
if (apiKeyStore.list().length === 0) {
  throw ConfigError('api-key store is empty — set API_KEYS env or populate API_KEYS_PATH file');
}

app.use('/v1/*', createApiKeyMiddleware(apiKeyStore));
app.use('/v1/*', createCaptureMiddleware(captureCfg));
app.post(
  '/v1/messages',
  createMessagesHandler({
    pool,
    template,
    candidateTemplate,
    canary,
    tracker,
    globalGuard,
    billingMonitor,
    accountLearner,
    pacing,
    drift,
  }),
);

const adminDeps = {
  pool,
  tracker,
  globalGuard,
  billingMonitor,
  accountLearner,
  canary,
  candidateDescription: candidateTemplate?.description ?? null,
  startedAt,
  templateDescription: template.description,
};
app.use('/admin/*', createApiKeyMiddleware(apiKeyStore));
app.get('/admin/stats', createStatsHandler(adminDeps));
app.get('/admin', createAdminPageHandler({ ...adminDeps, apiKeyStore, alertStore }));
app.get('/admin/', createAdminPageHandler({ ...adminDeps, apiKeyStore, alertStore }));

// Phase 20c — self-serve key management
const keysH = createKeysHandlers(apiKeyStore);
app.get('/admin/keys', keysH.list);
app.post('/admin/keys', keysH.create);
// HTML-form friendly mirrors (DELETE not emittable from <form>).
app.delete('/admin/keys/:name', keysH.revoke);
app.post('/admin/keys/:name/revoke', async (c) => {
  const res = await keysH.revoke(c);
  // After form submit, route back to /admin so the operator sees the new list.
  if (res.status < 300) return c.redirect('/admin');
  return res;
});

// Phase 20d — snapshot promote/rollback
const snapH = createSnapshotHandlers();
app.get('/admin/snapshot', snapH.status);
app.post('/admin/snapshot/promote', snapH.promote);
app.post('/admin/snapshot/rollback', snapH.rollback);

// Phase 20e — operator-managed token + webhook rotation.
app.post('/admin/oauth/replace', createOAuthReplaceHandler(pool));
const alertsH = createAlertsHandlers(alertStore);
app.post('/admin/alerts/discord', alertsH.setDiscord);
app.post('/admin/alerts/slack', alertsH.setSlack);

app.onError((err, c) => {
  if (err instanceof DomainError) {
    // Browser-friendly: trigger native credential dialog on admin 401.
    if (err.status === 401 && c.req.path.startsWith('/admin')) {
      return new Response('Unauthorized', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="claude-for-you admin"' },
      });
    }
    // 5xx domain errors (upstream_failed, config_error) are also operator-
    // worthy. Alarm them; 4xx remain quiet (client problems).
    if (err.status >= 500) {
      const msg = `[5xx] ${err.code}: ${err.message}`;
      console.error(msg);
      void serverErrorSink(msg);
    }
    return c.json(
      { error: { type: err.code, message: err.message } },
      err.status as 400 | 401 | 403 | 429 | 500 | 502,
    );
  }
  const msg = `[unhandled] ${err instanceof Error ? err.message : String(err)}`;
  console.error(msg, err);
  void serverErrorSink(msg);
  return c.json({ error: { type: 'internal_error', message: 'internal error' } }, 500);
});

const banner = (host: string, port: number, adapter: string): void => {
  console.log(`[claude-for-you] listening on http://${host}:${port}`);
  console.log(`[claude-for-you] runtime: bun ${Bun.version} (${adapter})`);
  console.log(`[claude-for-you] authorized keys: ${config.apiKeys.map((k) => k.name).join(', ')}`);
  console.log(`[claude-for-you] template: ${template.description}`);
  const poolMembers = pool.snapshot().members.map((m) => m.name).join(', ');
  console.log(`[claude-for-you] account pool: ${poolMembers}`);
  const pacingSrc =
    config.pacingMinGapMs > 0 ? 'env' : recommendedMinGapMs() !== null ? 'snapshot.p50' : 'disabled';
  console.log(
    `[claude-for-you] pacing: ${effectivePacingMinGapMs > 0 ? `${effectivePacingMinGapMs}ms (${pacingSrc})` : 'disabled'}; ` +
      `account_uuid override: ${config.accountUuidOverride ? 'set' : 'learn-from-headers'}`,
  );
  console.log(
    `[claude-for-you] daily limit/key: ${config.dailyTokenLimitPerKey || 'unlimited'}; ` +
      `subscription threshold: ${config.globalSubscriptionThresholdTokens || 'disabled'}`,
  );
  const canarySnap = canary.snapshot();
  if (canarySnap.active) {
    console.log(
      `[claude-for-you] 🐤 canary: ${canarySnap.percent}% → ${candidateTemplate?.description ?? '?'}`,
    );
  } else if (candidateTemplate) {
    console.log(`[claude-for-you] canary candidate present but inactive (CANARY_PERCENT=0)`);
  }
  if (captureCfg.enabled) {
    console.log(`[claude-for-you] ⚠️  CAPTURE_MODE ON — dumping to ${captureCfg.dir}`);
  }
};

if (captureCfg.enabled) {
  // node:http adapter exposes wire-order req.rawHeaders, which Bun.serve's
  // Web Request API does not. Outbound TLS is still Bun (Bun.fetch).
  honoServeNode(
    { fetch: app.fetch, port: config.port, hostname: config.host },
    (info) => banner(info.address, info.port, 'hono/node-server'),
  );
} else {
  const server = Bun.serve({
    fetch: app.fetch,
    port: config.port,
    hostname: config.host,
  });
  banner(server.hostname ?? config.host, server.port ?? config.port, 'Bun.serve');
}

export { app };
