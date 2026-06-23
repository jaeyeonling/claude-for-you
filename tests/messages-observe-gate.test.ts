import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { createMessagesHandler, type MessagesDeps } from '../src/proxy/messages.js';
import { createGlobalGuard, type GlobalGuard } from '../src/usage/global.js';
import { createCanaryController, type CanaryController } from '../src/canary.js';
import { createPacingEnforcer } from '../src/pacing.js';
import { createDriftAnalyzer } from '../src/usage/drift-analyzer.js';
import { createAccountLearner } from '../src/account-learner.js';
import { createBillingMonitor, type BillingMonitor } from '../src/usage/billing-monitor.js';
import { createNullMessageLogStore } from '../src/usage/messages-log.js';
import type { AccountPool } from '../src/auth/account-pool.js';
import type { ClaudeTemplate } from '../src/template/types.js';
import type { UsageTracker } from '../src/usage/per-user.js';
import type { AuthenticatedUser } from '../src/auth/api-key.js';

/**
 * End-to-end gate tests for the "ignore error-response signals" narrowing
 * (#86 globalGuard.observeHeaders, #87 canary.trip, plus the check-R1
 * follow-up that extended the gate to pool.observeResponse and
 * billingMonitor.observe). The production handler has no test harness, so we
 * mount it in a bare Hono app with a fake auth middleware and a mocked
 * upstream fetch.
 *
 * Real GlobalGuard / CanaryController / BillingMonitor are used (plus a pool
 * call counter) so we can assert directly on post-request state: the gate is
 * correct iff an error response leaves all four signal sinks untouched while a
 * 2xx still drives them. Accounting (tracker.record) and org-id learning stay
 * ungated by design and are not asserted here.
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

interface PoolCalls {
  observeResponse: number;
}

const stubPool = (calls: PoolCalls): AccountPool =>
  Object.freeze({
    getAccessToken: async () => ({ name: 'primary', token: 'tok-1' }),
    getAccessTokenExcluding: async () => null,
    forceRefresh: async () => 'tok-2',
    replaceOAuth: async () => {},
    observeResponse: () => {
      calls.observeResponse += 1;
    },
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
  readonly billingMonitor: BillingMonitor;
  readonly poolCalls: PoolCalls;
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
  const billingMonitor = createBillingMonitor({ sink: async () => {}, drift });
  const poolCalls: PoolCalls = { observeResponse: 0 };
  const deps: MessagesDeps = {
    pool: stubPool(poolCalls),
    template: stubTemplate(),
    candidateTemplate,
    canary,
    tracker: stubTracker(),
    globalGuard: guard,
    billingMonitor,
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

  return { app, guard, canary, billingMonitor, poolCalls };
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

// service_tier 'usage-based' is non-standard (BillingMonitor treats anything
// !== 'standard' as an alarm-worthy tier), so this body exercises both the
// billing alarm and the canary trip when it lands on a 2xx.
const usageBody = { type: 'message', usage: { service_tier: 'usage-based', input_tokens: 1, output_tokens: 1 } };

const upstreamResponse = (
  status: number,
  init: { headers?: Record<string, string>; body?: unknown } = {},
): Response =>
  new Response(JSON.stringify(init.body ?? { type: 'message' }), {
    status,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });

// callUpstream (src/proxy/upstream.ts) reaches the network via the global
// fetch, so replacing globalThis.fetch intercepts the upstream round-trip
// without a real request. If upstream.ts ever switches to an injected/imported
// fetch, this mock stops intercepting — update both together.
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

describe('observe gate — #86 globalGuard + pool routing', () => {
  test('a 429 carrying unified-remaining does NOT poison the guard or pool routing', async () => {
    // Arrange: threshold enabled; upstream returns a 429 advertising 0 headroom.
    const { app, guard, poolCalls } = buildHarness({ thresholdTokens: 1000, canaryPercent: 0 });
    mockUpstream(upstreamResponse(429, { headers: { 'anthropic-ratelimit-unified-remaining': '0' } }));

    // Act
    await fireRequest(app);

    // Assert: both observeHeaders and pool.observeResponse were gated out.
    expect(guard.snapshot().remaining).toBeNull();
    expect(() => guard.assertSubscriptionHealthy()).not.toThrow();
    expect(poolCalls.observeResponse).toBe(0);
  });

  test('a 400 is gated the same as a 429 (predicate is < 400, not 429-only)', async () => {
    const { app, guard, poolCalls } = buildHarness({ thresholdTokens: 1000, canaryPercent: 0 });
    mockUpstream(upstreamResponse(400, { headers: { 'anthropic-ratelimit-unified-remaining': '0' } }));

    await fireRequest(app);

    expect(guard.snapshot().remaining).toBeNull();
    expect(poolCalls.observeResponse).toBe(0);
  });

  test('a 2xx carrying unified-remaining STILL drives the guard and pool routing', async () => {
    // Arrange: same threshold, but the low-headroom signal arrives on a 200.
    const { app, guard, poolCalls } = buildHarness({ thresholdTokens: 1000, canaryPercent: 0 });
    mockUpstream(upstreamResponse(200, { headers: { 'anthropic-ratelimit-unified-remaining': '0' } }));

    // Act
    await fireRequest(app);

    // Assert: observeHeaders + pool.observeResponse ran on the success response.
    expect(guard.snapshot().remaining).toBe(0);
    expect(() => guard.assertSubscriptionHealthy()).toThrow();
    expect(poolCalls.observeResponse).toBe(1);
  });
});

describe('observe gate — #87 canary + billing alarm', () => {
  test('a 429 with a non-standard service_tier trips NOTHING (canary + billing alarm)', async () => {
    // Arrange: canary forced on (percent=100); upstream 429 with a usage block.
    const { app, canary, billingMonitor } = buildHarness({ thresholdTokens: 0, canaryPercent: 100 });
    mockUpstream(upstreamResponse(429, { body: usageBody }));

    // Act
    await fireRequest(app);

    // Assert: neither the canary nor the billing alarm reacts to an error body.
    expect(canary.snapshot().tripped).toBe(false);
    expect(billingMonitor.snapshot().nonStandardCount).toBe(0);
  });

  test('a 2xx with a non-standard service_tier STILL trips the canary and billing alarm', async () => {
    // Arrange: same canary, but the non-standard tier arrives on a 200.
    const { app, canary, billingMonitor } = buildHarness({ thresholdTokens: 0, canaryPercent: 100 });
    mockUpstream(upstreamResponse(200, { body: usageBody }));

    // Act
    await fireRequest(app);

    // Assert: a real candidate-side non-standard tier still trips + alarms.
    expect(canary.snapshot().tripped).toBe(true);
    expect(billingMonitor.snapshot().nonStandardCount).toBe(1);
  });
});
