import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { dirname, join } from 'node:path';
import { createAccountLearner } from './account-learner.js';
import { createAlertsHandlers } from './admin/alerts.js';
import { csrfGuard } from './admin/csrf.js';
import { createAdminEventsHandler } from './admin/events.js';
import { createKeysHandlers } from './admin/keys.js';
import { createMessageDetailHandler, createMessagesListHandler } from './admin/messages.js';
import { createOAuthReplaceHandler } from './admin/oauth.js';
import { createAdminPageHandler } from './admin/page.js';
import { createSnapshotHandlers } from './admin/snapshot.js';
import { createStatsHandler } from './admin/stats.js';
import {
  createKeyInvokeHandler,
  createOAuthProbeHandler,
  createSelfPingHandler,
  createTestResultStore,
  createUpstreamDirectHandler,
  createVerifyEntitlementHandler,
  honoLoopback,
} from './admin/test-runners.js';
import { createDynamicSink, withCooldown } from './alerts.js';
import { createAlertStore } from './alerts-store.js';
import { singleAccountPool, tryLoadAccountPool } from './auth/account-pool.js';
import type { AccountPool } from './auth/account-pool.js';
import { createApiKeyMiddleware } from './auth/api-key.js';
import { createApiKeyStore } from './auth/api-key-store.js';
import { createOAuthManager } from './auth/oauth.js';
import { requireAdmin } from './auth/require-admin.js';
import { createCanaryController } from './canary.js';
import { createCaptureMiddleware, loadCaptureConfig } from './capture.js';
import type { AppConfig } from './config.js';
import { ConfigError, DomainError, FORBIDDEN_ERROR_HEADERS } from './lib/errors.js';
import { log } from './lib/logger.js';
import { redact } from './lib/redact.js';
import { createPacingEnforcer } from './pacing.js';
import { createConcurrencyLimiter, createPerKeyConcurrencyLimiter } from './proxy/concurrency.js';
import { createIpRateLimiter } from './proxy/rate-limit.js';
import { createMessagesHandler } from './proxy/messages.js';
import { createModelsHandler } from './proxy/models.js';
import { createOutcomeObserver } from './proxy/observe-outcome.js';
import {
  createExtractedTemplate,
  recommendedMinGapMs,
  tryCreateCandidateTemplate,
} from './template/extracted.js';
import { createBillingMonitor } from './usage/billing-monitor.js';
import { createDriftAnalyzer } from './usage/drift-analyzer.js';
import { createGlobalGuard } from './usage/global.js';
import { createNullMessageLogStore } from './usage/messages-log.js';
import type { MessageLogStore } from './usage/messages-log.js';
import { createPostgresMessageLogStore } from './usage/messages-log-postgres.js';
import { createPostgresUsageTracker } from './usage/per-user-postgres.js';
import { createUsageTracker } from './usage/per-user.js';
import type { UsageTracker } from './usage/per-user.js';

/**
 * `composeApp` is the pure wiring layer — given an AppConfig it builds the
 * full request graph (Hono app, all middlewares, all routes) and returns:
 *   - `app`: the Hono instance ready to serve
 *   - `banner`: prints the boot banner once the bind address is known
 *   - `dispose`: drains resources (DB pool, etc.) on shutdown
 *
 * server.ts just orchestrates: load config → composeApp → serve → register
 * shutdown. This split makes the app independently testable (you can build
 * the app graph in a test and dispatch synthetic requests against it).
 */

export interface ComposedApp {
  readonly app: Hono;
  readonly banner: (host: string, port: number, adapter: string) => void;
  readonly dispose: () => Promise<void>;
  readonly captureModeEnabled: boolean;
}

const buildPool = async (
  config: AppConfig,
  oauthFailSink: (msg: string) => Promise<void>,
): Promise<AccountPool> => {
  const multi = await tryLoadAccountPool({
    accountsPath: config.accountsPath,
    tokenStoreBaseDir: dirname(config.tokenStorePath),
    onRefreshFail: (memberName, reason) => {
      const msg = `[oauth/${memberName}] ⚠️  refresh failed: ${reason}`;
      log.error(msg);
      void oauthFailSink(msg);
    },
  });
  if (multi) return multi;

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
      log.error(msg);
      void oauthFailSink(msg);
    },
  });
  return singleAccountPool(oauth);
};

const buildTracker = async (config: AppConfig): Promise<UsageTracker> => {
  if (config.databaseUrl) {
    return createPostgresUsageTracker({
      databaseUrl: config.databaseUrl,
      dailyLimitPerKey: config.dailyTokenLimitPerKey,
    });
  }
  return createUsageTracker({ dailyLimitPerKey: config.dailyTokenLimitPerKey });
};

const buildMessageLogStore = async (config: AppConfig): Promise<MessageLogStore> => {
  if (!config.messagesLogEnabled || !config.databaseUrl) {
    return createNullMessageLogStore();
  }
  return createPostgresMessageLogStore({ databaseUrl: config.databaseUrl });
};

export const composeApp = async (config: AppConfig): Promise<ComposedApp> => {
  const startedAt = Date.now();

  const alertStore = await createAlertStore({
    filePath: join(dirname(config.tokenStorePath), 'alerts.json'),
    envDiscord: config.discordWebhookUrl,
    envSlack: config.slackWebhookUrl,
  });
  const rawSink = createDynamicSink(alertStore);
  const oauthFailSink = withCooldown(rawSink, 60_000);
  const serverErrorSink = withCooldown(rawSink, 60_000);
  const usageErrorSink = withCooldown(rawSink, 60_000);

  const messageLogErrorSink = withCooldown(rawSink, 60_000);

  const pool = await buildPool(config, oauthFailSink);
  const tracker = await buildTracker(config);
  const messageLogStore = await buildMessageLogStore(config);
  const globalGuard = createGlobalGuard({
    thresholdTokens: config.globalSubscriptionThresholdTokens,
  });
  const drift = createDriftAnalyzer();
  const billingMonitor = createBillingMonitor({ sink: rawSink, drift });
  const accountLearner = createAccountLearner(config.accountUuidOverride);

  if (!config.accountUuidOverride) {
    try {
      const { token } = await pool.getAccessToken(undefined);
      const learned = await accountLearner.bootstrap(token);
      if (learned) log.info(`[claude-for-you] account_uuid bootstrap: learned ${learned}`);
    } catch {
      // graceful degradation to header learning
    }
  }

  const effectivePacingMinGapMs =
    config.pacingMinGapMs > 0 ? config.pacingMinGapMs : (recommendedMinGapMs() ?? 0);
  const pacing = createPacingEnforcer({ minGapMs: effectivePacingMinGapMs });
  const template = createExtractedTemplate({ accountLearner });

  const candidateTemplate = tryCreateCandidateTemplate({ accountLearner });
  const canary = createCanaryController({
    candidate: candidateTemplate,
    percent: config.canaryPercent,
  });

  const app = new Hono();

  if (config.logLevel === 'debug') {
    app.use('*', async (c, next) => {
      const start = Date.now();
      await next();
      const ms = Date.now() - start;
      log.debug(
        `[req] ${c.req.method} ${new URL(c.req.url).pathname} → ${c.res.status} (${ms}ms)`,
      );
    });
  }

  app.get('/healthz', (c) => c.json({ ok: true }));

  const captureCfg = loadCaptureConfig();

  const apiKeyStore = createApiKeyStore({
    envKeys: config.apiKeys,
    filePath: config.apiKeysFilePath,
  });
  if (apiKeyStore.list().length === 0) {
    throw ConfigError('api-key store is empty — set API_KEYS env or populate API_KEYS_PATH file');
  }

  // Outermost on /v1/messages, registered BEFORE the api-key middleware so it
  // observes EVERY failure that dies before the handler's own log write —
  // including the api-key 401 and the concurrency/quota 429 — and records a
  // one-row pre-handler outcome to messages_log (#144). Hono orders middleware
  // by registration, not path specificity, so this must precede the /v1/*
  // api-key `use` below for the 401 case to be captured.
  app.use(
    '/v1/messages',
    createOutcomeObserver({ store: messageLogStore, errorSink: messageLogErrorSink }),
  );
  app.use('/v1/*', createApiKeyMiddleware(apiKeyStore));
  app.use('/v1/*', createCaptureMiddleware(captureCfg));
  app.use(
    '/v1/messages',
    bodyLimit({
      maxSize: 4 * 1024 * 1024,
      onError: (c) =>
        c.json(
          { error: { type: 'invalid_request', message: 'request body too large (>4MB)' } },
          413,
        ),
    }),
  );
  // Fan-out defenses, shared across BOTH inference paths — /v1/messages and the
  // /v1/models discovery GET. Same middleware instances → one per-IP token
  // bucket, one per-key ceiling, and one global ceiling spanning both routes, so
  // a leaked key (or a client stuck in a restart loop hammering discovery)
  // can't burn the shared OAuth account's request-rate headroom out from under
  // legitimate /v1/messages traffic. /v1/models used to skip these entirely
  // (persona R1 adversary/watchdog HIGH). Order within the trio: per-IP →
  // per-key (clear "your slot quota" error before the shared pool) → global.
  // perSecond=0 / max<=0 disables each. bodyLimit stays messages-only above
  // (a GET /v1/models has no body).
  const ipRateLimiter = createIpRateLimiter({ perSecond: config.perIpRateLimitPerSecond });
  const perKeyLimiter = createPerKeyConcurrencyLimiter(config.maxConcurrentRequestsPerKey);
  const globalLimiter = createConcurrencyLimiter(config.maxConcurrentRequests);
  for (const inferencePath of ['/v1/messages', '/v1/models'] as const) {
    app.use(inferencePath, ipRateLimiter);
    app.use(inferencePath, perKeyLimiter);
    app.use(inferencePath, globalLimiter);
  }
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
      usageErrorSink,
      messageLogStore,
      messageLogErrorSink,
    }),
  );

  // Gateway model discovery. Claude Code (with
  // CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1) queries this at startup to
  // learn which model families this gateway serves — the only way a new family
  // like Fable reaches a proxied client's /model picker. It runs under /v1/*
  // auth + capture (capture self-gates to /v1/messages, so it's a no-op here)
  // and the shared fan-out defenses (per-IP / per-key / global caps registered
  // above for both inference paths); only bodyLimit stays messages-only (a GET
  // has no body). See docs/operational-pitfalls.md #21.
  app.get('/v1/models', createModelsHandler({ pool }));

  const testResultStore = createTestResultStore();
  // Loopback fetcher resolves to `app.fetch` at call time — keeps the
  // self-ping handler usable even though it's wired *before* the app object
  // is fully populated with routes.
  const appRef: { current: Hono | null } = { current: null };
  const loopbackFetcher = honoLoopback(appRef);

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
    testResultStore,
  };
  app.use('/admin/*', createApiKeyMiddleware(apiKeyStore));
  app.use('/admin/*', requireAdmin);
  app.use('/admin/*', csrfGuard);
  app.get('/admin/stats', createStatsHandler(adminDeps));
  app.get('/admin', createAdminPageHandler({ ...adminDeps, apiKeyStore, alertStore }));
  app.get('/admin/', createAdminPageHandler({ ...adminDeps, apiKeyStore, alertStore }));
  // Live SSE stream that powers the no-flicker dashboard.
  app.get(
    '/admin/events',
    createAdminEventsHandler({ ...adminDeps, apiKeyStore, alertStore }),
  );

  app.post('/admin/test/oauth-probe', createOAuthProbeHandler(pool, testResultStore));
  app.post(
    '/admin/test/self-ping',
    createSelfPingHandler(apiKeyStore, loopbackFetcher, testResultStore),
  );
  app.post(
    '/admin/test/key-invoke',
    createKeyInvokeHandler(apiKeyStore, loopbackFetcher, testResultStore),
  );
  app.post(
    '/admin/test/upstream-direct',
    createUpstreamDirectHandler(pool, testResultStore),
  );
  app.post(
    '/admin/test/verify-entitlement',
    createVerifyEntitlementHandler(pool, testResultStore),
  );

  const keysH = createKeysHandlers(apiKeyStore);
  app.get('/admin/keys', keysH.list);
  app.post('/admin/keys', keysH.create);
  app.patch('/admin/keys/:name', keysH.update);
  app.delete('/admin/keys/:name', keysH.revoke);
  app.post('/admin/keys/:name/revoke', async (c) => {
    const res = await keysH.revoke(c);
    if (res.status < 300) return c.redirect('/admin');
    return res;
  });
  app.post('/admin/keys/:name/update', async (c) => {
    const res = await keysH.update(c);
    if (res.status < 300) return c.redirect('/admin');
    return res;
  });

  const snapH = createSnapshotHandlers();
  app.get('/admin/snapshot', snapH.status);
  app.post('/admin/snapshot/promote', snapH.promote);
  app.post('/admin/snapshot/rollback', snapH.rollback);

  app.get('/admin/messages', createMessagesListHandler({ store: messageLogStore }));
  app.get('/admin/messages/:id', createMessageDetailHandler({ store: messageLogStore }));

  app.post('/admin/oauth/replace', createOAuthReplaceHandler(pool));
  const alertsH = createAlertsHandlers(alertStore);
  app.post('/admin/alerts/discord', alertsH.setDiscord);
  app.post('/admin/alerts/slack', alertsH.setSlack);

  app.onError((err, c) => {
    if (err instanceof DomainError) {
      if (err.status === 401 && c.req.path.startsWith('/admin')) {
        return new Response('Unauthorized', {
          status: 401,
          headers: { 'WWW-Authenticate': 'Basic realm="claude-for-you admin"' },
        });
      }
      if (err.status >= 500) {
        const msg = redact(`[5xx] ${err.code}: ${err.message}`);
        log.error(msg);
        void serverErrorSink(msg);
      }
      const response = c.json(
        { error: { type: err.code, message: err.message } },
        err.status as 400 | 401 | 403 | 429 | 500 | 502,
      );
      if (err.headers) {
        for (const [name, value] of Object.entries(err.headers)) {
          const key = name.toLowerCase();
          if (FORBIDDEN_ERROR_HEADERS.has(key)) {
            // Defensive: a future factory might accidentally include a
            // hop-by-hop/framing/sensitive header. Strip rather than trust.
            log.warn(`[onError] dropped forbidden header from DomainError: ${key}`);
            continue;
          }
          response.headers.set(key, value);
        }
      }
      return response;
    }
    const msg = redact(`[unhandled] ${err instanceof Error ? err.message : String(err)}`);
    log.error(msg);
    // Stack trace helps locate the throw site. Names only — function /
    // file frames don't carry response bodies, but redact still scrubs
    // any incidental token-shaped string.
    if (err instanceof Error && err.stack) {
      log.error(redact(err.stack));
    }
    void serverErrorSink(msg);
    return c.json({ error: { type: 'internal_error', message: 'internal error' } }, 500);
  });

  const banner = (host: string, port: number, adapter: string): void => {
    log.info(`[claude-for-you] listening on http://${host}:${port}`);
    log.info(`[claude-for-you] runtime: bun ${Bun.version} (${adapter})`);
    log.info(
      `[claude-for-you] authorized keys: ${config.apiKeys.map((k) => k.name).join(', ')}`,
    );
    log.info(`[claude-for-you] template: ${template.description}`);
    const poolMembers = pool.snapshot().members.map((m) => m.name).join(', ');
    log.info(`[claude-for-you] account pool: ${poolMembers}`);
    const pacingSrc =
      config.pacingMinGapMs > 0
        ? 'env'
        : recommendedMinGapMs() !== null
          ? 'snapshot.p50'
          : 'disabled';
    log.info(
      `[claude-for-you] pacing: ${effectivePacingMinGapMs > 0 ? `${effectivePacingMinGapMs}ms (${pacingSrc})` : 'disabled'}; ` +
        `account_uuid override: ${config.accountUuidOverride ? 'set' : 'learn-from-headers'}`,
    );
    log.info(
      `[claude-for-you] daily limit/key: ${config.dailyTokenLimitPerKey || 'unlimited'}; ` +
        `subscription threshold: ${config.globalSubscriptionThresholdTokens || 'disabled'}`,
    );
    const canarySnap = canary.snapshot();
    if (canarySnap.active) {
      log.info(
        `[claude-for-you] 🐤 canary: ${canarySnap.percent}% → ${candidateTemplate?.description ?? '?'}`,
      );
    } else if (candidateTemplate) {
      log.info(`[claude-for-you] canary candidate present but inactive (CANARY_PERCENT=0)`);
    }
    if (captureCfg.enabled) {
      log.warn(`[claude-for-you] ⚠️  CAPTURE_MODE ON — dumping to ${captureCfg.dir}`);
    }
  };

  const dispose = async (): Promise<void> => {
    try {
      await tracker.close?.();
    } catch (err: unknown) {
      log.error(
        `[shutdown] tracker close failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      await messageLogStore.close?.();
    } catch (err: unknown) {
      log.error(
        `[shutdown] messageLogStore close failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  // Bind loopback after every route is registered, so self-ping → /v1/messages
  // resolves through the same router any external client would hit.
  appRef.current = app;

  return Object.freeze({
    app,
    banner,
    dispose,
    captureModeEnabled: captureCfg.enabled,
  });
};
