import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { createMessagesHandler, type MessagesDeps } from '../src/proxy/messages.js';
import { createGlobalGuard, type GlobalGuard } from '../src/usage/global.js';
import { createCanaryController, type CanaryController } from '../src/canary.js';
import { createPacingEnforcer } from '../src/pacing.js';
import { createDriftAnalyzer } from '../src/usage/drift-analyzer.js';
import { createAccountLearner } from '../src/account-learner.js';
import { createBillingMonitor } from '../src/usage/billing-monitor.js';
import { createNullMessageLogStore } from '../src/usage/messages-log.js';
import type { AccountPool } from '../src/auth/account-pool.js';
import type { ClaudeTemplate } from '../src/template/types.js';
import type { UsageTracker } from '../src/usage/per-user.js';
import type { AuthenticatedUser } from '../src/auth/api-key.js';

/**
 * End-to-end gate tests for #86 (globalGuard.observeHeaders) and #87
 * (canary.trip). The production handler has no test harness, so we mount it
 * in a bare Hono app with a fake auth middleware and a mocked upstream fetch.
 *
 * Real `createGlobalGuard` / `createCanaryController` are used so we can assert
 * directly on their post-request state (snapshot), rather than spying on call
 * sites — the gate is correct iff a 429 leaves that state untouched while a
 * 2xx drives it.
 */

const TEST_USER: AuthenticatedUser = { name: 'alice', role: 'user' };

const stubTemplate = (): ClaudeTemplate =>
  Object.freeze({
    source: 'static' as const,
    description: 'test',
    apply: async ({ accessToken }) => ({
      url: 'https://upstream.example/v1/messages',
      method: 'POST' as const,
      headers: { authorization: `Bearer ${accessToken}` },
      body: '{}',
    }),
  });

const stubPool = (): AccountPool =>
  Object.freeze({
    getAccessToken: async () => ({ name: 'primary', token: 'tok-1' }),
    getAccessTokenExcluding: async () => null,
    forceRefresh: async () => 'tok-2',
    replaceOAuth: async () => {},
    observeResponse: () => {},
    snapshot: () => ({ members: [], sessionAssignments: {} }),
  });

const stubTracker = (): UsageTracker =>
  Object.freeze({
    assertCanRequest: async () => {},
    record: async () => {},
  });

interface Harness {
  readonly app: Hono;
  readonly guard: GlobalGuard;
  readonly canary: CanaryController;
}

const buildHarness = (params: {
  thresholdTokens: number;
  canaryPercent: number;
}): Harness => {
  const guard = createGlobalGuard({ thresholdTokens: params.thresholdTokens });
  const candidateTemplate = stubTemplate();
  const canary = createCanaryController({
    candidate: candidateTemplate,
    percent: params.canaryPercent,
  });
  const drift = createDriftAnalyzer();
  const deps: MessagesDeps = {
    pool: stubPool(),
    template: stubTemplate(),
    candidateTemplate,
    canary,
    tracker: stubTracker(),
    globalGuard: guard,
    billingMonitor: createBillingMonitor({ sink: async () => {}, drift }),
    accountLearner: createAccountLearner('test-uuid'),
    pacing: createPacingEnforcer({ minGapMs: 0 }),
    drift,
    usageErrorSink: async () => {},
    messageLogStore: createNullMessageLogStore(),
    messageLogErrorSink: async () => {},
  };

  const app = new Hono();
  app.use('/v1/messages', async (c, next) => {
    c.set('user', TEST_USER);
    await next();
  });
  app.post('/v1/messages', createMessagesHandler(deps));

  return { app, guard, canary };
};

const REQUEST_BODY = JSON.stringify({
  model: 'claude-test',
  messages: [{ role: 'user', content: 'hi' }],
  max_tokens: 16,
});

const fireRequest = (app: Hono): Promise<Response> =>
  app.request('/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: REQUEST_BODY,
  });

const upstreamResponse = (
  status: number,
  init: { headers?: Record<string, string>; body?: unknown } = {},
): Response =>
  new Response(JSON.stringify(init.body ?? { type: 'message' }), {
    status,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });

let originalFetch: typeof globalThis.fetch;
const mockUpstream = (response: Response): void => {
  globalThis.fetch = (async () => response) as typeof globalThis.fetch;
};

beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('observe gate — #86 globalGuard.observeHeaders', () => {
  test('a 429 carrying unified-remaining does NOT poison the subscription guard', async () => {
    // Arrange: threshold enabled; upstream returns a 429 advertising 0 headroom.
    const { app, guard } = buildHarness({ thresholdTokens: 1000, canaryPercent: 0 });
    mockUpstream(upstreamResponse(429, { headers: { 'anthropic-ratelimit-unified-remaining': '0' } }));

    // Act
    await fireRequest(app);

    // Assert: observeHeaders was gated out → guard never saw the misleading 0.
    expect(guard.snapshot().remaining).toBeNull();
    expect(() => guard.assertSubscriptionHealthy()).not.toThrow();
  });

  test('a 2xx carrying unified-remaining STILL drives the subscription guard', async () => {
    // Arrange: same threshold, but the low-headroom signal arrives on a 200.
    const { app, guard } = buildHarness({ thresholdTokens: 1000, canaryPercent: 0 });
    mockUpstream(upstreamResponse(200, { headers: { 'anthropic-ratelimit-unified-remaining': '0' } }));

    // Act
    await fireRequest(app);

    // Assert: observeHeaders ran → guard would block the next request.
    expect(guard.snapshot().remaining).toBe(0);
    expect(() => guard.assertSubscriptionHealthy()).toThrow();
  });
});

describe('observe gate — #87 canary.trip', () => {
  test('a 429 carrying a non-standard service_tier does NOT trip the canary', async () => {
    // Arrange: canary forced on (percent=100); upstream 429 with a usage block.
    const { app, canary } = buildHarness({ thresholdTokens: 0, canaryPercent: 100 });
    mockUpstream(
      upstreamResponse(429, {
        body: { type: 'message', usage: { service_tier: 'usage-based', input_tokens: 1, output_tokens: 1 } },
      }),
    );

    // Act
    await fireRequest(app);

    // Assert: gate blocked the trip — a transient 429 can't abort the rollout.
    expect(canary.snapshot().tripped).toBe(false);
  });

  test('a 2xx carrying a non-standard service_tier STILL trips the canary', async () => {
    // Arrange: same canary, but the non-standard tier arrives on a 200.
    const { app, canary } = buildHarness({ thresholdTokens: 0, canaryPercent: 100 });
    mockUpstream(
      upstreamResponse(200, {
        body: { type: 'message', usage: { service_tier: 'usage-based', input_tokens: 1, output_tokens: 1 } },
      }),
    );

    // Act
    await fireRequest(app);

    // Assert: a real candidate-side non-standard tier still trips.
    expect(canary.snapshot().tripped).toBe(true);
  });
});
