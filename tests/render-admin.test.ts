import { describe, expect, test } from 'bun:test';
import {
  renderAdminHtml,
  renderLiveSections,
  type AdminPageSnapshot,
} from '../src/admin/render.js';
import { MAX_ALLOWED_MODELS_PER_KEY } from '../src/auth/api-key-store.js';
import { MAX_MODEL_PATTERN_LENGTH } from '../src/auth/model-allow.js';

const baseSnap = (overrides: Partial<AdminPageSnapshot> = {}): AdminPageSnapshot => ({
  poolSnap: {
    members: [
      {
        name: 'default',
        remainingTokens: 50_000,
        remainingObservedAt: Date.now() - 30_000,
        tokenMeta: {
          refreshTokenSuffix: 'abcd',
          accessTokenSuffix: 'wxyz',
          accessTokenExpiresAt: Date.now() + 60_000,
        },
      },
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
  testResults: {
    'oauth-probe': null,
    'self-ping': null,
    'key-invoke': null,
    'upstream-direct': null,
  },
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

  test('test forms are intercepted client-side (no full-page reload)', () => {
    const html = renderAdminHtml(baseSnap());
    // The interceptor matches /admin/test/* and /admin/keys via shouldIntercept.
    expect(html).toContain("action.includes('/admin/test/')");
    expect(html).toContain("'/admin/keys'");
    expect(html).toContain('ev.preventDefault()');
    // Fetch sends Accept: application/json so the handler returns a TestResult
    // JSON body (the no-JS form fallback gets a 302 redirect instead).
    expect(html).toContain("accept: 'application/json'");
    // Inline result slot must be rendered next to the submit button, not in
    // some far-off card the operator has to scroll to find.
    expect(html).toContain('test-inline-result');
  });

  test('full page includes both live and form sections', () => {
    const html = renderAdminHtml(baseSnap());
    expect(html).toContain('billing health'); // live
    expect(html).toContain('oauth token rotation'); // form
    expect(html).toContain('alert webhooks'); // form
  });

  test('issue-api-key form is present with name + allowedModels inputs', () => {
    const html = renderAdminHtml(baseSnap());
    expect(html).toContain('issue api key');
    expect(html).toContain('action="/admin/keys" method="post"');
    expect(html).toContain('name="name"');
    expect(html).toContain('name="allowedModels"');
  });

  test('edit-api-key section explains there is nothing to edit when no file keys exist', () => {
    const html = renderAdminHtml(baseSnap({ apiKeyRows: [] }));
    expect(html).toContain('edit api key');
    expect(html).toContain('No file-issued keys to edit');
  });

  test('edit-api-key section omits env-baked keys from the editable select', () => {
    const html = renderAdminHtml(
      baseSnap({
        apiKeyRows: [
          {
            name: 'operator',
            source: 'env',
            key: 'longkey0123456789longkey0123456789',
            createdAt: '(env)',
          },
        ],
      }),
    );
    // Only env keys present → still treated as "nothing to edit".
    expect(html).toContain('No file-issued keys to edit');
    expect(html).not.toContain('id="edit-key-form"');
  });

  test('edit-api-key form renders when at least one file-issued key exists', () => {
    const html = renderAdminHtml(
      baseSnap({
        apiKeyRows: [
          {
            name: 'bob',
            source: 'file',
            key: 'longkey0123456789longkey0123456789',
            createdAt: '2026-05-30T00:00:00Z',
            allowedModels: ['claude-haiku-*'],
          },
        ],
      }),
    );
    expect(html).toContain('id="edit-key-form"');
    expect(html).toContain('action="/admin/keys/bob/update"');
    // Inputs prefilled with the current values so a no-op submit is harmless.
    expect(html).toContain('value="bob"');
    expect(html).toContain('value="claude-haiku-*"');
  });

  test('edit-api-key form prefills empty allowedModels when no restriction is set', () => {
    const html = renderAdminHtml(
      baseSnap({
        apiKeyRows: [
          {
            name: 'bob',
            source: 'file',
            key: 'longkey0123456789longkey0123456789',
            createdAt: '2026-05-30T00:00:00Z',
          },
        ],
      }),
    );
    expect(html).toContain('id="edit-key-form"');
    // value="" on the allowedModels input — operator can type without clearing first.
    expect(html).toMatch(/id="edit-key-models"[^>]*value=""/);
  });

  test('edit-api-key form action is intercepted client-side', () => {
    const html = renderAdminHtml(baseSnap());
    // shouldIntercept should match POST /admin/keys/:name/update so submits
    // don't blow away the typed values via a full page nav.
    expect(html).toContain("/admin/keys/'");
    expect(html).toContain("endsWith('/update')");
  });

  test('edit-key name field is readonly by default with rename toggle', () => {
    const html = renderAdminHtml(
      baseSnap({
        apiKeyRows: [
          {
            name: 'bob',
            source: 'file',
            key: 'longkey0123456789longkey0123456789',
            createdAt: '2026-05-30T00:00:00Z',
          },
        ],
      }),
    );
    // Rename safety: prefilled name input must start with `readonly` so a
    // misclick can't trigger an accidental rename. The toggle next to it
    // unlocks the field when the operator explicitly opts in.
    expect(html).toMatch(/id="edit-key-name"[^>]*readonly/);
    expect(html).toContain('id="edit-key-rename-toggle"');
    // Label hints at the gating mechanism so a noscript / first-time
    // operator immediately understands why the field looks disabled. The
    // explicit "tick the rename checkbox" wording (with accent-colored
    // emphasis) replaced the original muted hint after round 2 first-timer
    // feedback that readonly looked identical to disabled.
    expect(html).toMatch(/tick the .+rename.+ checkbox on the right to edit/);
  });

  test('issue + edit forms surface allowedModels caps in label hints', () => {
    const html = renderAdminHtml(
      baseSnap({
        apiKeyRows: [
          {
            name: 'bob',
            source: 'file',
            key: 'longkey0123456789longkey0123456789',
            createdAt: '2026-05-30T00:00:00Z',
          },
        ],
      }),
    );
    // Hint wording is derived dynamically from the imported source-of-truth
    // constants — if either cap changes in src/auth/*, this test fires only
    // when the rendered UI fails to track it. The literal "50/128" is not
    // baked into the assertion.
    const expectedHint = `max ${MAX_ALLOWED_MODELS_PER_KEY} entries, each pattern ≤${MAX_MODEL_PATTERN_LENGTH} chars`;
    expect(html).toContain(expectedHint);
    // Exactly two occurrences: issue form + edit form. `toBe(2)` (not `>=`)
    // catches both omission and accidental triplication.
    const escaped = expectedHint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = html.match(new RegExp(escaped, 'g')) ?? [];
    expect(matches.length).toBe(2);
  });

  test('readonly inputs render with visual differentiation (CSS rule present)', () => {
    const html = renderAdminHtml(baseSnap());
    // First-timer persona: a bare readonly input looks identical to a
    // disabled input, so operators waste time wondering why the field
    // refuses focus. The CSS rule below changes background + cursor +
    // border-style so readonly state is visibly different from the normal
    // editable state AND from a disabled-forever state (dashed border is
    // the universal "this is unlockable, just not right now" affordance).
    expect(html).toContain('form.stack input[readonly]');
    expect(html).toContain('cursor:not-allowed');
    expect(html).toContain('border-style:dashed');
  });

  test('edit-key name label cues the rename checkbox explicitly', () => {
    const html = renderAdminHtml(
      baseSnap({
        apiKeyRows: [
          {
            name: 'bob',
            source: 'file',
            key: 'longkey0123456789longkey0123456789',
            createdAt: '2026-05-30T00:00:00Z',
          },
        ],
      }),
    );
    // First-timer round 2: the previous "(readonly — check rename to edit)"
    // hint sat in muted tag text next to a muted-styled input, which a
    // first-time operator scanned as "disabled" and never noticed the
    // checkbox. Highlight `rename` in accent color so the label visually
    // points at the unlock control.
    expect(html).toContain('tick the <strong style="color:var(--accent)">rename</strong>');
  });

  test('env-only fallback names the redeploy command for the major orchestrators', () => {
    const html = renderAdminHtml(baseSnap({ apiKeyRows: [] }));
    // First-timer round 2: "bare metal" alone left K8s / systemd operators
    // stranded. Surface concrete commands for each common deployment shape
    // so the operator can copy-paste without context switching to docs.
    expect(html).toContain('docker compose restart app');
    expect(html).toContain('systemctl restart claude-for-you');
    expect(html).toContain('kubectl rollout restart deploy/claude-for-you');
  });

  test('rename toggle setter restores pristine value when unchecked', () => {
    const html = renderAdminHtml(
      baseSnap({
        apiKeyRows: [
          {
            name: 'bob',
            source: 'file',
            key: 'longkey0123456789longkey0123456789',
            createdAt: '2026-05-30T00:00:00Z',
          },
        ],
      }),
    );
    // Adversary persona finding (PR #29 round 1): unchecking the rename
    // toggle restored the readonly attribute but kept the edited value, so
    // submit silently performed the rename the operator thought they
    // cancelled. The setter now snapshots pristine on unlock and restores
    // it on re-lock.
    expect(html).toContain('editNamePristine');
    expect(html).toMatch(/editName\.value = editNamePristine/);
  });

  test('rename toggle resets after a successful update PATCH submit', () => {
    const html = renderAdminHtml(
      baseSnap({
        apiKeyRows: [
          {
            name: 'bob',
            source: 'file',
            key: 'longkey0123456789longkey0123456789',
            createdAt: '2026-05-30T00:00:00Z',
          },
        ],
      }),
    );
    // Chaos persona round 2: after a successful rename PATCH the toggle
    // stayed checked with pristine = the OLD name. A subsequent toggle-OFF
    // would visually undo the rename just confirmed. The reset must happen
    // INSIDE the refresh chain so pristine syncs to the new name first.
    expect(html).toMatch(/refreshEditMeta\(\)\.then\(\s*\(\)\s*=>/);
    expect(html).toContain('renameToggle.checked = false');
    expect(html).toContain('setRenameUnlocked(false)');
  });

  test('rename toggle missing element surfaces visible diagnostic', () => {
    const html = renderAdminHtml(
      baseSnap({
        apiKeyRows: [
          {
            name: 'bob',
            source: 'file',
            key: 'longkey0123456789longkey0123456789',
            createdAt: '2026-05-30T00:00:00Z',
          },
        ],
      }),
    );
    // Chaos persona finding (PR #29 round 1): a missing rename-toggle DOM
    // element would otherwise silently leave name readonly forever with no
    // operator-visible signal. The fallback branch surfaces a status-span
    // diagnostic so the operator can take action instead of fighting a
    // mysteriously inert input.
    expect(html).toContain('rename UI is wired but the toggle element is missing');
  });

  test('env-only guidance mentions a concrete redeploy command', () => {
    const html = renderAdminHtml(baseSnap({ apiKeyRows: [] }));
    // First-timer persona: "redeploy instead" left operators stuck on the
    // next step. We now name `docker compose restart app` for the common
    // case and acknowledge bare-metal restart as the alternative.
    expect(html).toContain('docker compose restart app');
  });

  test('env-only-keys section names the env format and links to user-guide', () => {
    const html = renderAdminHtml(baseSnap({ apiKeyRows: [] }));
    // With no file keys, the edit section degrades to operator guidance.
    // It must (a) show the API_KEYS format so an operator who only has
    // env-baked keys can configure new ones without grep, and (b) link to
    // the user guide for the full layout.
    expect(html).toContain('name1:key1,name2:key2');
    expect(html).toContain('docs/user-guide.md');
  });

  test('noscript fallback mentions API_KEYS_PATH instead of bare filename', () => {
    const html = renderAdminHtml(
      baseSnap({
        apiKeyRows: [
          {
            name: 'bob',
            source: 'file',
            key: 'longkey0123456789longkey0123456789',
            createdAt: '2026-05-30T00:00:00Z',
          },
        ],
      }),
    );
    // A noscript operator can't use the inline JS edit flow. The fallback
    // points them at the env var that defines the file path rather than a
    // bare filename — operators may run the proxy with a custom path.
    expect(html).toContain('API_KEYS_PATH');
  });

  test('edit-api-key Save button starts disabled and noscript warns', () => {
    const html = renderAdminHtml(
      baseSnap({
        apiKeyRows: [
          {
            name: 'bob',
            source: 'file',
            key: 'longkey0123456789longkey0123456789',
            createdAt: '2026-05-30T00:00:00Z',
          },
        ],
      }),
    );
    // Save must be disabled until JS confirms editMeta is fresh.
    expect(html).toMatch(/id="edit-key-save"[^>]*disabled/);
    // noscript fallback for JS-disabled operators.
    expect(html).toContain('<noscript>');
    expect(html).toContain('JavaScript is required');
  });

  test('paintResult branches on explicit kind:"updated" marker', () => {
    const html = renderAdminHtml(baseSnap());
    // The kind marker keeps the branch unambiguous instead of relying on
    // the absence of a "key" field.
    expect(html).toContain("payload.kind === 'updated'");
  });

  test('paintResult sanitizes server-echoed error strings before render', () => {
    const html = renderAdminHtml(baseSnap());
    // textContent already neutralises HTML, but the server may relay
    // upstream-proxy text containing control chars / bidi overrides that
    // would corrupt the operator's terminal on copy-paste. The error branch
    // must run a length-bounded, control-stripping helper before
    // concatenation.
    //
    // We assert that the sanitizer is *applied to* the values, not how it's
    // spelled internally — that's the actual security invariant for static
    // inspection. (Behavioral coverage requires LIVE_SCRIPT extraction to a
    // real module so safeText can be unit-tested; tracked in issue #26.)
    //
    // What we CAN check statically: payload.error.type is read, safeText is
    // called on the message path, and the rendered base uses the local
    // `type` variable. Quote-agnostic regex so source formatting (single vs
    // double quotes) does not break the test.
    expect(html).toContain('payload.error.type');
    expect(html).toMatch(/safeText\(\s*payload\.error\.message/);
    expect(html).toMatch(/['"]✗ ['"]\s*\+\s*type\b/);
    // Format-character class (zero-width, bidi-override, BOM) MUST be in the
    // strip set — \\p{Cf} covers the whole family.
    expect(html).toContain('\\p{Cf}');
    // C0 controls must be stripped EXCEPT \\t \\n so multi-line stack traces
    // survive when an upstream relays them. The regex achieves this by
    // listing the explicit ranges around 0x09/0x0A. \\r is stripped by the
    // strip pass but only because the normalize pass below converts \\r\\n
    // → \\n first — see the newline-policy test for the \\r path.
    expect(html).toContain('\\u0000-\\u0008');
    expect(html).toContain('\\u000B-\\u001F');
  });

  test('paintResult collapses newline runs to prevent log-injection padding (#27)', () => {
    const html = renderAdminHtml(baseSnap());
    // Issue #27: an attacker controlling upstream error text could craft
    // long newline runs to fake separate log entries when an operator
    // pasted the toast text into a terminal / Slack / log aggregator. The
    // safeText helper must:
    //   1. Normalize \\r\\n? → \\n so the rest of the pipeline only sees \\n.
    //   2. Collapse 3+ consecutive newlines down to one blank line.
    //   3. Trim leading/trailing blank lines (so leading-newline padding
    //      can't eat the MAX_LINES budget and silently drop real content).
    //   4. Hard-cap total line count via MAX_LINES.
    //
    // Asserting the source-text invariants is the strongest static check we
    // can do without LIVE_SCRIPT extraction (#26 will add behavioral tests).
    // The exact regex spelling is intentional — a regression that drops the
    // collapse, the trim, or the line cap would fail at least one of these.
    expect(html).toContain('replace(/\\r\\n?/g');
    expect(html).toMatch(/\\n\{3,\}/);
    // Trim: must strip leading or trailing blank lines via /^\\n+|\\n+$/g.
    // Without trim, leading newlines eat the MAX_LINES budget and silently
    // truncate real content (chaos persona finding).
    expect(html).toContain('replace(/^\\n+|\\n+$/g');
    expect(html).toContain('MAX_LINES');
    expect(html).toMatch(/lines\.length\s*>\s*MAX_LINES/);
  });

  test('editMeta uses null-prototype object (prototype pollution defense)', () => {
    const html = renderAdminHtml(baseSnap());
    expect(html).toContain('Object.create(null)');
  });

  test('edit-key form has dedicated status span next to Save', () => {
    const html = renderAdminHtml(
      baseSnap({
        apiKeyRows: [
          {
            name: 'bob',
            source: 'file',
            key: 'longkey0123456789longkey0123456789',
            createdAt: '2026-05-30T00:00:00Z',
          },
        ],
      }),
    );
    // Status span is the dedicated channel for meta-health messages — must
    // exist and start with the loading hint so the operator never sees a
    // mysterious disabled Save with no context.
    expect(html).toMatch(/id="edit-key-status"[^>]*>loading key data/);
    expect(html).toContain('aria-live="polite"');
  });

  test('refresh error message tells the operator to refresh the page', () => {
    const html = renderAdminHtml(baseSnap());
    // The reword from "save is disabled until reload" to the explicit
    // keyboard shortcut prevents ambiguity between "reload page" and
    // "retry button".
    expect(html).toContain('Refresh the page (Cmd/Ctrl+R) and try again');
  });

  test('select change re-fetches metadata (defense against stale prefill)', () => {
    const html = renderAdminHtml(baseSnap());
    // The change handler must call refreshEditMeta (not just applyEditSelection)
    // so external edits never leave stale values prefilled.
    expect(html).toContain('refreshEditMeta().then(applyEditSelection)');
  });
});
