import { describe, expect, test } from 'bun:test';
import {
  renderAdminHtml,
  renderLiveSections,
  type AdminPageSnapshot,
} from '../src/admin/render.js';

const baseSnap = (overrides: Partial<AdminPageSnapshot> = {}): AdminPageSnapshot => ({
  poolSnap: {
    members: [
      { name: 'default', remainingTokens: 50_000, remainingObservedAt: Date.now() - 30_000 },
    ],
    sessionAssignments: {},
  },
  billingSnap: {
    lastObservation: null,
    nonStandardCount: 0,
    lastAlarmAt: null,
  },
  guardSnap: { remaining: null, observedAt: null },
  usageSnap: {},
  canarySnap: {
    active: false,
    percent: 0,
    tripped: false,
    trippedAt: null,
    trippedReason: null,
    candidateRequests: 0,
    stableRequests: 0,
  },
  alertConfig: { discordWebhookUrl: null, slackWebhookUrl: null },
  apiKeyRows: [],
  orgId: null,
  candidateDescription: null,
  candidateSnapshotPresent: false,
  templateDescription: 'cc-snapshot/v2 [stable]',
  bunVersion: '1.3.13',
  uptimeSec: 90,
  now: new Date('2026-05-22T12:00:00Z'),
  ...overrides,
});

describe('renderAdminHtml', () => {
  test('renders all canonical section headers', () => {
    const html = renderAdminHtml(baseSnap());
    for (const heading of [
      'billing health',
      'account pool',
      'subscription headroom',
      'account learner',
      'canary',
      'api keys',
      'snapshot promote/rollback',
      'oauth token rotation',
      'alert webhooks',
      'per-user usage (UTC today)',
    ]) {
      expect(html).toContain(heading);
    }
  });

  test('escapes HTML-special characters in api key name', () => {
    const html = renderAdminHtml(
      baseSnap({
        apiKeyRows: [
          {
            name: '<script>alert(1)</script>',
            source: 'env',
            key: 'longkey0123456789longkey0123456789',
            createdAt: '2026-01-01T00:00:00Z',
          },
        ],
      }),
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('shows configured/not-set status for webhook URLs without leaking the URL', () => {
    const html = renderAdminHtml(
      baseSnap({
        alertConfig: {
          discordWebhookUrl: 'https://discord.com/api/webhooks/123/SECRET-TOKEN-VALUE',
          slackWebhookUrl: null,
        },
      }),
    );
    expect(html).toContain('configured');
    expect(html).toContain('not set');
    expect(html).not.toContain('SECRET-TOKEN-VALUE'); // mask leak check
  });

  test('shows canary "tripped" badge when tripped', () => {
    const html = renderAdminHtml(
      baseSnap({
        canarySnap: {
          active: true,
          percent: 10,
          tripped: true,
          trippedAt: Date.now() - 60_000,
          trippedReason: 'service_tier=priority',
          candidateRequests: 5,
          stableRequests: 100,
        },
      }),
    );
    expect(html).toContain('tripped</span>');
    expect(html).toContain('service_tier=priority');
  });

  test('snapshot promote controls only appear when candidate file is present', () => {
    const without = renderAdminHtml(baseSnap({ candidateSnapshotPresent: false }));
    expect(without).toContain('no candidate snapshot present');
    expect(without).not.toContain('promote candidate → stable');

    const withCandidate = renderAdminHtml(baseSnap({ candidateSnapshotPresent: true }));
    expect(withCandidate).toContain('promote candidate → stable');
  });

  test('non-standard service_tier shows the bad badge variant', () => {
    const html = renderAdminHtml(
      baseSnap({
        billingSnap: {
          lastObservation: {
            serviceTier: 'priority',
            unifiedStatus: 'allowed',
            representativeClaim: null,
            observedAt: Date.now(),
          },
          nonStandardCount: 7,
          lastAlarmAt: Date.now() - 30_000,
        },
      }),
    );
    expect(html).toContain('b-bad">priority');
    expect(html).toContain('non-standard count</dt><dd>7');
  });
});

describe('renderLiveSections vs renderAdminHtml split (SSE)', () => {
  test('live sections never contain text-input form fields', () => {
    const live = renderLiveSections(baseSnap());
    // The text fields the operator might be typing into must NOT be in the
    // live region — they live in the form sections that the SSE update path
    // never touches.
    expect(live).not.toContain('name="refreshToken"');
    expect(live).not.toContain('name="accessToken"');
    expect(live).not.toContain('name="url"');
  });

  test('live sections do contain auto-updating data (billing/pool/usage)', () => {
    const live = renderLiveSections(baseSnap());
    expect(live).toContain('billing health');
    expect(live).toContain('account pool');
    expect(live).toContain('per-user usage');
    expect(live).toContain('snapshot promote/rollback');
  });

  test('full page wraps live sections in display:contents container', () => {
    const html = renderAdminHtml(baseSnap());
    expect(html).toContain('id="live-region"');
    expect(html).toContain('style="display:contents"');
  });

  test('full page includes EventSource client + status pip', () => {
    const html = renderAdminHtml(baseSnap());
    expect(html).toContain('id="live-status"');
    expect(html).toContain("new EventSource('/admin/events')");
    // Old meta-refresh must not coexist with SSE flow.
    expect(html).not.toContain('http-equiv="refresh"');
  });

  test('full page includes both live and form sections', () => {
    const html = renderAdminHtml(baseSnap());
    expect(html).toContain('billing health'); // live
    expect(html).toContain('oauth token rotation'); // form
    expect(html).toContain('alert webhooks'); // form
  });
});
