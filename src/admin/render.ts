import type { AccountPoolSnapshot } from '../auth/account-pool.js';
import type { CanaryStats } from '../canary.js';
import type { AlertConfig } from '../alerts-store.js';
import type { UsageSnapshot } from '../usage/per-user.js';
import type { BillingMonitorSnapshot } from '../usage/billing-monitor.js';
import type { GlobalGuardSnapshot } from '../usage/global.js';
import type { TestKind, TestResult } from './test-runners.js';

/**
 * Pure renderer for the /admin dashboard.
 *
 * Separating render from data-fetching keeps the HTML output unit-testable
 * (no need to spin up the proxy or mock the entire AccountPool / Postgres
 * tracker — just hand the renderer a frozen snapshot).
 */

export interface ApiKeyRow {
  readonly name: string;
  readonly source: 'env' | 'file';
  readonly key: string;
  readonly createdAt: string;
  readonly allowedModels?: readonly string[];
}

export interface AdminPageSnapshot {
  readonly poolSnap: AccountPoolSnapshot;
  readonly billingSnap: BillingMonitorSnapshot;
  readonly guardSnap: GlobalGuardSnapshot;
  readonly usageSnap: UsageSnapshot;
  readonly canarySnap: CanaryStats;
  readonly alertConfig: AlertConfig;
  readonly apiKeyRows: readonly ApiKeyRow[];
  readonly orgId: string | null;
  readonly candidateDescription: string | null;
  readonly candidateSnapshotPresent: boolean;
  readonly templateDescription: string;
  readonly bunVersion: string;
  readonly uptimeSec: number;
  readonly now: Date;
  readonly testResults: Readonly<Record<TestKind, TestResult | null>>;
}

const esc = (s: unknown): string => {
  const str = s === null || s === undefined ? '—' : String(s);
  return str
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
};

const fmtDur = (s: number): string => {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
};

const fmtAgo = (epochMs: number | null | undefined): string => {
  if (epochMs === null || epochMs === undefined) return '—';
  const s = Math.floor((Date.now() - epochMs) / 1000);
  return fmtDur(s) + ' ago';
};

const tierBadge = (tier: string | null | undefined): string => {
  if (!tier) return `<span class="badge b-mute">—</span>`;
  if (tier === 'standard') return `<span class="badge b-good">${esc(tier)}</span>`;
  return `<span class="badge b-bad">${esc(tier)}</span>`;
};

const statusBadge = (st: string | null | undefined): string => {
  if (!st) return `<span class="badge b-mute">—</span>`;
  if (st === 'allowed') return `<span class="badge b-good">${esc(st)}</span>`;
  if (st === 'allowed_warning') return `<span class="badge b-warn">${esc(st)}</span>`;
  return `<span class="badge b-bad">${esc(st)}</span>`;
};

const STYLE = `
:root{--bg:oklch(15% 0 0);--surface:oklch(20% 0 0);--text:oklch(94% 0 0);--muted:oklch(60% 0 0);--accent:oklch(72% 0.18 220);--warn:oklch(78% 0.18 60);--bad:oklch(70% 0.22 25);--good:oklch(72% 0.16 145);--border:oklch(28% 0 0)}
*{box-sizing:border-box}html,body{margin:0;padding:0}
body{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--bg);color:var(--text);font-size:13px;line-height:1.5;padding:clamp(1rem,2vw,2rem)}
header{display:flex;align-items:baseline;gap:1.5rem;margin-bottom:1.5rem;border-bottom:1px solid var(--border);padding-bottom:.8rem;flex-wrap:wrap}
h1{font-size:1.1rem;font-weight:600;margin:0;letter-spacing:-.01em}
.tag{font-size:.8rem;color:var(--muted)}
main{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:1rem}
section{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:1rem 1.1rem}
section h2{font-size:.78rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin:0 0 .7rem 0}
.kv{display:grid;grid-template-columns:minmax(140px,max-content) 1fr;gap:.35rem 1rem;font-size:.86rem}
.kv > dt{color:var(--muted)}
.kv > dd{margin:0;word-break:break-all}
.badge{display:inline-block;padding:.1rem .5rem;border-radius:3px;font-size:.72rem;font-weight:600;letter-spacing:.04em}
.b-good{background:oklch(72% 0.16 145 / 0.18);color:var(--good)}
.b-warn{background:oklch(78% 0.18 60 / 0.18);color:var(--warn)}
.b-bad{background:oklch(70% 0.22 25 / 0.2);color:var(--bad)}
.b-mute{background:oklch(40% 0 0 / 0.25);color:var(--muted)}
footer{margin-top:1.5rem;color:var(--muted);font-size:.75rem;display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap}
button{font-family:inherit;font-size:.78rem;padding:.3rem .75rem;background:var(--accent);color:var(--bg);border:none;border-radius:3px;cursor:pointer;font-weight:600}
button:hover{filter:brightness(1.1)}
button.logout{background:transparent;color:var(--muted);border:1px solid var(--border);font-size:.72rem;padding:.15rem .5rem;font-weight:500}
button.logout:hover{color:var(--text)}
form{display:inline}
form.stack{display:flex;flex-direction:column;gap:.5rem;margin-top:.7rem}
form.stack label{font-size:.72rem;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
form.stack input[type=text],form.stack input[type=password],form.stack input[type=url]{font-family:inherit;font-size:.8rem;padding:.4rem .55rem;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:3px;width:100%}
form.stack input:focus{outline:none;border-color:var(--accent)}
form.stack button{align-self:flex-start;margin-top:.2rem}
code{background:oklch(28% 0 0 / 0.5);padding:.05rem .35rem;border-radius:2px;font-size:.78rem;word-break:break-all}
`;

const webhookStatus = (url: string | null): string =>
  url
    ? `<span class="badge b-good">configured</span> <span class="tag">(${esc(url.length)} chars)</span>`
    : `<span class="badge b-mute">not set</span>`;

/**
 * Renders only the auto-updating sections (everything except the input forms).
 * Exported so the SSE handler can stream just these on each tick — the
 * `<div id="live-region" style="display:contents">` wrapper in the full page
 * gets its children replaced with this output, preserving form input state.
 */
export const renderLiveSections = (s: AdminPageSnapshot): string => {
  const lastObs = s.billingSnap.lastObservation;
  const canaryBadge = !s.canarySnap.active
    ? '<span class="badge b-mute">inactive</span>'
    : s.canarySnap.tripped
      ? '<span class="badge b-bad">tripped</span>'
      : `<span class="badge b-good">${esc(s.canarySnap.percent)}%</span>`;

  const usageRows =
    Object.entries(s.usageSnap)
      .map(
        ([name, v]) =>
          `<dt>${esc(name)}</dt><dd>${esc(v.tokens.toLocaleString())} tok <span class="badge b-mute">${esc(v.day)}</span></dd>`,
      )
      .join('') || `<dt class="tag" style="grid-column:span 2">no usage yet today</dt><dd></dd>`;

  const keyRows =
    s.apiKeyRows
      .map((k) => {
        const modelsBadge =
          k.allowedModels && k.allowedModels.length > 0
            ? ` <span class="badge b-warn" title="${esc(k.allowedModels.join(', '))}">models: ${esc(k.allowedModels.join(', '))}</span>`
            : ' <span class="badge b-mute">any model</span>';
        return (
          `<dt>${esc(k.name)} <span class="badge b-mute">${esc(k.source)}</span></dt>` +
          `<dd>${esc(k.key.slice(0, 4))}…${esc(k.key.slice(-4))} <span class="tag">${esc(k.createdAt)}</span>` +
          modelsBadge +
          ` <form action="/admin/keys/${esc(k.name)}/revoke" method="post" style="display:inline;margin-left:.5rem">` +
          `<button class="logout" type="submit">revoke</button></form></dd>`
        );
      })
      .join('') || `<dt class="tag" style="grid-column:span 2">no keys configured</dt><dd></dd>`;

  const snapshotControls = s.candidateSnapshotPresent
    ? `<form action="/admin/snapshot/promote" method="post" style="display:inline">` +
      `<button type="submit">promote candidate → stable</button></form> ` +
      `<form action="/admin/snapshot/rollback" method="post" style="display:inline">` +
      `<button type="submit" class="logout">rollback (delete candidate)</button></form>`
    : `<span class="badge b-mute">no candidate snapshot present</span>`;

  const fmtExpiresAt = (epochMs: number): string => {
    if (epochMs <= 0) return '<span class="badge b-warn">force on next call</span>';
    const remainingSec = Math.floor((epochMs - Date.now()) / 1000);
    if (remainingSec <= 0) return `<span class="badge b-bad">expired ${fmtDur(-remainingSec)} ago</span>`;
    return `<span class="badge b-good">${esc(fmtDur(remainingSec))} left</span>`;
  };

  const tokenRows = s.poolSnap.members
    .map((m) => {
      const meta = m.tokenMeta;
      const accessSuffix = meta.accessTokenSuffix
        ? `…${esc(meta.accessTokenSuffix)}`
        : '<span class="badge b-mute">not minted</span>';
      return (
        `<dt>${esc(m.name)}</dt>` +
        `<dd>rt: …${esc(meta.refreshTokenSuffix)} · at: ${accessSuffix} ` +
        `<span class="tag">${fmtExpiresAt(meta.accessTokenExpiresAt)}</span></dd>`
      );
    })
    .join('');

  const renderTestResult = (label: string, r: TestResult | null): string => {
    if (!r) return `<dt>${esc(label)}</dt><dd><span class="badge b-mute">not run</span></dd>`;
    const badge = r.ok
      ? `<span class="badge b-good">ok</span>`
      : `<span class="badge b-bad">fail</span>`;
    return (
      `<dt>${esc(label)}</dt>` +
      `<dd>${badge} <span class="tag">${esc(fmtAgo(r.at))}</span><br>` +
      `<code>${esc(r.summary)}</code><br>` +
      `<details><summary class="tag">detail</summary><pre style="white-space:pre-wrap;margin:.4rem 0 0 0;font-size:.72rem">${esc(r.detail)}</pre></details></dd>`
    );
  };

  return `
  <section>
    <h2>billing health</h2>
    <dl class="kv">
      <dt>service_tier</dt><dd>${tierBadge(lastObs?.serviceTier ?? null)}</dd>
      <dt>unified-status</dt><dd>${statusBadge(lastObs?.unifiedStatus ?? null)}</dd>
      <dt>representative claim</dt><dd>${esc(lastObs?.representativeClaim)}</dd>
      <dt>last observation</dt><dd>${esc(fmtAgo(lastObs?.observedAt))}</dd>
      <dt>non-standard count</dt><dd>${esc(s.billingSnap.nonStandardCount)}</dd>
      <dt>last alarm</dt><dd>${esc(fmtAgo(s.billingSnap.lastAlarmAt))}</dd>
    </dl>
  </section>
  <section>
    <h2>account pool</h2>
    <dl class="kv">
      ${s.poolSnap.members
        .map(
          (m) =>
            `<dt>${esc(m.name)}</dt>` +
            `<dd>remaining: ${m.remainingTokens !== null ? esc(m.remainingTokens.toLocaleString()) : '<span class="badge b-mute">unknown</span>'}` +
            ` <span class="tag">${esc(fmtAgo(m.remainingObservedAt))}</span></dd>`,
        )
        .join('')}
      <dt>session sticks</dt><dd>${esc(Object.keys(s.poolSnap.sessionAssignments).length)} active</dd>
    </dl>
  </section>
  <section>
    <h2>subscription headroom</h2>
    <dl class="kv">
      <dt>remaining tokens</dt><dd>${esc(s.guardSnap.remaining?.toLocaleString())}</dd>
      <dt>observed</dt><dd>${esc(fmtAgo(s.guardSnap.observedAt))}</dd>
    </dl>
  </section>
  <section>
    <h2>account learner</h2>
    <dl class="kv">
      <dt>org id</dt>
      <dd>${s.orgId ? esc(s.orgId) : '<span class="badge b-mute">not learned yet</span>'}</dd>
    </dl>
  </section>
  <section>
    <h2>canary</h2>
    <dl class="kv">
      <dt>status</dt><dd>${canaryBadge}</dd>
      <dt>candidate</dt><dd>${s.candidateDescription ? esc(s.candidateDescription) : '<span class="badge b-mute">none</span>'}</dd>
      <dt>candidate reqs</dt><dd>${esc(s.canarySnap.candidateRequests)}</dd>
      <dt>stable reqs</dt><dd>${esc(s.canarySnap.stableRequests)}</dd>
      <dt>tripped at</dt><dd>${esc(fmtAgo(s.canarySnap.trippedAt))}</dd>
      <dt>tripped reason</dt><dd>${esc(s.canarySnap.trippedReason)}</dd>
    </dl>
  </section>
  <section>
    <h2>api keys</h2>
    <dl class="kv">${keyRows}</dl>
    <p class="tag" style="margin-top:.7rem">Create with: <code>curl -u admin:KEY -H 'content-type: application/json' -X POST /admin/keys -d '{"name":"newuser"}'</code></p>
  </section>
  <section>
    <h2>snapshot promote/rollback</h2>
    <p class="tag">${snapshotControls}</p>
    <p class="tag" style="margin-top:.7rem">⚠️ Both actions require <code>docker compose restart app</code> to take effect.</p>
  </section>
  <section>
    <h2>token store</h2>
    <dl class="kv">${tokenRows}</dl>
    <p class="tag" style="margin-top:.7rem">Suffix-only — paste a fresh RT via the rotation form below if a row looks stale.</p>
  </section>
  <section>
    <h2>self-test results</h2>
    <dl class="kv">
      ${renderTestResult('oauth refresh', s.testResults['oauth-probe'])}
      ${renderTestResult('self-ping', s.testResults['self-ping'])}
      ${renderTestResult('key invoke', s.testResults['key-invoke'])}
      ${renderTestResult('upstream direct', s.testResults['upstream-direct'])}
    </dl>
  </section>
  <section style="grid-column: 1 / -1">
    <h2>per-user usage (UTC today)</h2>
    <dl class="kv">${usageRows}</dl>
  </section>`;
};

/**
 * Renders only the input-form sections. These never get touched by SSE
 * updates — preserves the operator's in-progress paste / type.
 */
const renderFormSections = (s: AdminPageSnapshot): string => {
  const memberOptions = s.poolSnap.members
    .map(
      (m, i) =>
        `<option value="${esc(m.name)}"${i === 0 ? ' selected' : ''}>${esc(m.name)}</option>`,
    )
    .join('');

  const keyOptions = s.apiKeyRows
    .map(
      (k, i) =>
        `<option value="${esc(k.name)}"${i === 0 ? ' selected' : ''}>${esc(k.name)}</option>`,
    )
    .join('');
  const selectStyle =
    'font-family:inherit;font-size:.8rem;padding:.4rem .55rem;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:3px';

  return `
  <section>
    <h2>self-test</h2>
    <p class="tag">Operator-triggered probes. Results appear in the live region above.</p>
    <form class="stack" action="/admin/test/oauth-probe" method="post">
      <label for="probe-member">oauth refresh probe</label>
      <select id="probe-member" name="memberName" style="${selectStyle}">${memberOptions}</select>
      <button type="submit">forceRefresh</button>
    </form>
    <form class="stack" action="/admin/test/self-ping" method="post">
      <label for="ping-model">self-ping <span class="tag">(loops through this proxy)</span></label>
      <input id="ping-model" type="text" name="model" placeholder="claude-sonnet-4-6" value="claude-sonnet-4-6">
      <button type="submit">send pong</button>
    </form>
    ${
      keyOptions.length > 0
        ? `<form class="stack" action="/admin/test/key-invoke" method="post">
      <label for="invoke-key">key invoke <span class="tag">(authenticates as the chosen key)</span></label>
      <select id="invoke-key" name="keyName" style="${selectStyle}">${keyOptions}</select>
      <input id="invoke-model" type="text" name="model" placeholder="claude-sonnet-4-6" value="claude-sonnet-4-6">
      <button type="submit">invoke as key</button>
    </form>`
        : '<p class="tag" style="margin-top:.5rem">No keys to invoke — add one via <code>/admin/keys</code> first.</p>'
    }
    <form class="stack" action="/admin/test/upstream-direct" method="post">
      <label for="direct-model">upstream direct <span class="tag">(bypasses proxy template — minimal headers)</span></label>
      <input id="direct-model" type="text" name="model" placeholder="claude-sonnet-4-6" value="claude-sonnet-4-6">
      <button type="submit">call api.anthropic.com</button>
    </form>
  </section>
  <section>
    <h2>oauth token rotation</h2>
    <p class="tag">Paste a fresh refresh token. The next request triggers a refresh and writes a new access token to disk.</p>
    <form class="stack" action="/admin/oauth/replace" method="post">
      <label for="oauth-member">pool member</label>
      <select id="oauth-member" name="memberName" style="font-family:inherit;font-size:.8rem;padding:.4rem .55rem;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:3px">${memberOptions}</select>
      <label for="oauth-refresh">refresh token <span class="tag">(required)</span></label>
      <input id="oauth-refresh" type="password" name="refreshToken" placeholder="sk-ant-ort01-..." autocomplete="off" required minlength="32">
      <label for="oauth-access">access token <span class="tag">(optional — leave blank to mint via next request)</span></label>
      <input id="oauth-access" type="password" name="accessToken" placeholder="sk-ant-oat01-..." autocomplete="off">
      <button type="submit">replace tokens</button>
    </form>
  </section>
  <section>
    <h2>alert webhooks</h2>
    <dl class="kv">
      <dt>discord</dt><dd>${webhookStatus(s.alertConfig.discordWebhookUrl)}</dd>
      <dt>slack</dt><dd>${webhookStatus(s.alertConfig.slackWebhookUrl)}</dd>
    </dl>
    <form class="stack" action="/admin/alerts/discord" method="post">
      <label for="discord-url">discord webhook url <span class="tag">(empty = clear)</span></label>
      <input id="discord-url" type="url" name="url" placeholder="https://discord.com/api/webhooks/...">
      <button type="submit">update discord</button>
    </form>
    <form class="stack" action="/admin/alerts/slack" method="post">
      <label for="slack-url">slack webhook url <span class="tag">(empty = clear)</span></label>
      <input id="slack-url" type="url" name="url" placeholder="https://hooks.slack.com/services/...">
      <button type="submit">update slack</button>
    </form>
  </section>`;
};

// Inline JS — two responsibilities:
//   1. SSE live region updates (DOMParser-based inert swap)
//   2. Intercept /admin/test/* form submits with fetch() so the page doesn't
//      navigate — preserves in-progress paste in the OAuth/webhook forms, and
//      avoids re-tearing the SSE connection on every probe.
//
// Forms degrade gracefully: with JS disabled, the native submit still works
// because handlers respond with 302 → /admin.
const LIVE_SCRIPT = `
(() => {
  const region = document.getElementById('live-region');
  const pip = document.getElementById('live-status');
  if (!region || !pip) return;
  const setStatus = (text, cls) => {
    pip.textContent = text;
    pip.className = 'badge ' + cls;
  };
  setStatus('connecting…', 'b-mute');
  const es = new EventSource('/admin/events');
  es.onopen = () => setStatus('live', 'b-good');
  es.onerror = () => setStatus('reconnecting…', 'b-warn');
  es.onmessage = (ev) => {
    let payload;
    try { payload = JSON.parse(ev.data); }
    catch (_) { return; }
    if (typeof payload.html !== 'string') return;
    // DOMParser parses HTML inertly — <script> elements in the parsed
    // document are not executed. Combined with server-side esc(), this is
    // safe even though we control both ends.
    const parsed = new DOMParser().parseFromString(
      '<div>' + payload.html + '</div>',
      'text/html',
    );
    const wrapper = parsed.body.firstElementChild;
    if (!wrapper) return;
    region.replaceChildren(...wrapper.children);
  };

  // ---------- test form interceptor ----------
  // Match by action prefix so adding a new /admin/test/* route picks this up
  // automatically. Result is rendered INLINE under the form so the operator
  // never has to hunt across the page after a click — the live card on the
  // right is just history.
  const ensureInlineSlot = (form) => {
    let slot = form.querySelector('.test-inline-result');
    if (!slot) {
      slot = document.createElement('div');
      slot.className = 'test-inline-result';
      slot.style.cssText =
        'margin-top:.5rem;padding:.4rem .55rem;border-radius:3px;font-size:.75rem;line-height:1.4;word-break:break-word';
      form.appendChild(slot);
    }
    return slot;
  };
  const paintResult = (slot, payload) => {
    if (!payload || typeof payload !== 'object') {
      slot.style.background = 'oklch(40% 0 0 / 0.25)';
      slot.style.color = 'var(--muted)';
      slot.textContent = 'no response body';
      return;
    }
    const ok = payload.ok === true;
    slot.style.background = ok
      ? 'oklch(72% 0.16 145 / 0.18)'
      : 'oklch(70% 0.22 25 / 0.2)';
    slot.style.color = ok ? 'var(--good)' : 'var(--bad)';
    slot.textContent =
      (ok ? '✓ ' : '✗ ') + (payload.summary || JSON.stringify(payload));
  };
  document.addEventListener('submit', (ev) => {
    const form = ev.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (!form.action.includes('/admin/test/')) return;
    ev.preventDefault();

    const btn = form.querySelector('button[type=submit]');
    const originalLabel = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'running…'; }
    const slot = ensureInlineSlot(form);
    slot.style.background = 'oklch(28% 0 0 / 0.5)';
    slot.style.color = 'var(--muted)';
    slot.textContent = 'running…';

    fetch(form.action, {
      method: 'POST',
      headers: { accept: 'application/json' },
      body: new FormData(form),
      credentials: 'same-origin',
    })
      .then(async (res) => {
        if (!res.ok && res.status !== 200) {
          slot.style.background = 'oklch(70% 0.22 25 / 0.2)';
          slot.style.color = 'var(--bad)';
          slot.textContent = '✗ http ' + res.status;
          return;
        }
        const body = await res.json().catch(() => null);
        paintResult(slot, body);
      })
      .catch((err) => {
        slot.style.background = 'oklch(70% 0.22 25 / 0.2)';
        slot.style.color = 'var(--bad)';
        slot.textContent = '✗ ' + (err && err.message ? err.message : String(err));
      })
      .finally(() => {
        if (btn) { btn.disabled = false; btn.textContent = originalLabel; }
      });
  });
})();
`;

export const renderAdminHtml = (s: AdminPageSnapshot): string => {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>claude-for-you · admin</title>
<style>${STYLE}</style>
</head><body>
<header>
  <h1>claude-for-you · admin</h1>
  <span class="tag">bun ${esc(s.bunVersion)} · uptime ${esc(fmtDur(s.uptimeSec))}</span>
  <span class="tag" style="flex:1">${esc(s.templateDescription)}</span>
</header>
<main>
  <div id="live-region" style="display:contents">${renderLiveSections(s)}</div>
  ${renderFormSections(s)}
</main>
<footer>
  <span><span id="live-status" class="badge b-mute">connecting…</span></span>
  <span>${esc(s.now.toLocaleTimeString())}</span>
</footer>
<script>${LIVE_SCRIPT}</script>
</body></html>`;
};
