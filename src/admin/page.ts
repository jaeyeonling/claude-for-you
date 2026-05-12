import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from 'hono';
import type { AccountLearner } from '../account-learner.js';
import type { AccountPool } from '../auth/account-pool.js';
import type { ApiKeyStore } from '../auth/api-key-store.js';
import type { CanaryController } from '../canary.js';
import type { AlertStore } from '../alerts-store.js';
import type { BillingMonitor } from '../usage/billing-monitor.js';
import type { GlobalGuard } from '../usage/global.js';
import type { UsageTracker } from '../usage/per-user.js';

const CANDIDATE_SNAPSHOT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'template',
  'cc-snapshot.candidate.json',
);

export interface AdminPageDeps {
  readonly pool: AccountPool;
  readonly tracker: UsageTracker;
  readonly globalGuard: GlobalGuard;
  readonly billingMonitor: BillingMonitor;
  readonly accountLearner: AccountLearner;
  readonly canary: CanaryController;
  readonly apiKeyStore: ApiKeyStore;
  readonly alertStore: AlertStore;
  readonly candidateDescription: string | null;
  readonly startedAt: number;
  readonly templateDescription: string;
}

/**
 * Server-side rendered admin page. Every dynamic value passes through
 * `esc()` before being interpolated into the HTML — no innerHTML, no
 * client-side templating. Auto-refresh via <meta http-equiv="refresh">.
 *
 * Auth: standard API key middleware on /admin/* — browser sends an
 * Authorization: Basic header; the middleware picks up the password
 * portion via its existing Bearer path is bypassed here. Instead, we serve
 * a simple HTML form on auth failure that POSTs the key as a cookie.
 *
 * Simpler than that: just rely on x-api-key in a cookie set by the form,
 * or basic-auth via WWW-Authenticate. We go with basic-auth — browser
 * caches it and shows a native dialog. The api-key middleware already
 * accepts `Authorization: Bearer <key>`, and basic auth's Authorization
 * header (`Basic base64(user:pass)`) doesn't fit. So we extend the middleware
 * minimally with a basic-auth code path in `auth/api-key.ts`.
 */

const esc = (s: unknown): string => {
  if (s === null || s === undefined) return '—';
  return String(s)
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

export const createAdminPageHandler =
  (deps: AdminPageDeps) =>
  async (c: Context): Promise<Response> => {
  const poolSnap = deps.pool.snapshot();
  const billingSnap = deps.billingMonitor.snapshot();
  const guardSnap = deps.globalGuard.snapshot();
  const usageSnap = await deps.tracker.snapshot();

  const uptimeSec = Math.floor((Date.now() - deps.startedAt) / 1000);
  const lastObs = billingSnap.lastObservation;
  const canarySnap = deps.canary.snapshot();
  const canaryBadge = !canarySnap.active
    ? '<span class="badge b-mute">inactive</span>'
    : canarySnap.tripped
      ? '<span class="badge b-bad">tripped</span>'
      : `<span class="badge b-good">${esc(canarySnap.percent)}%</span>`;

  const usageRows =
    Object.entries(usageSnap)
      .map(
        ([name, v]) =>
          `<dt>${esc(name)}</dt><dd>${esc(v.tokens.toLocaleString())} tok <span class="badge b-mute">${esc(v.day)}</span></dd>`,
      )
      .join('') || `<dt class="tag" style="grid-column:span 2">no usage yet today</dt><dd></dd>`;

  // Phase 20c — keys section
  const keyRows =
    deps.apiKeyStore
      .list()
      .map(
        (k) =>
          `<dt>${esc(k.name)} <span class="badge b-mute">${esc(k.source)}</span></dt>` +
          `<dd>${esc(k.key.slice(0, 4))}…${esc(k.key.slice(-4))} <span class="tag">${esc(k.createdAt)}</span> ` +
          `<form action="/admin/keys/${esc(k.name)}/revoke" method="post" style="display:inline;margin-left:.5rem">` +
          `<button class="logout" type="submit">revoke</button></form></dd>`,
      )
      .join('') || `<dt class="tag" style="grid-column:span 2">no keys configured</dt><dd></dd>`;

  // Phase 20d — snapshot section
  const candidateExists = existsSync(CANDIDATE_SNAPSHOT_PATH);
  const snapshotControls = candidateExists
    ? `<form action="/admin/snapshot/promote" method="post" style="display:inline">` +
      `<button type="submit">promote candidate → stable</button></form> ` +
      `<form action="/admin/snapshot/rollback" method="post" style="display:inline">` +
      `<button type="submit" class="logout">rollback (delete candidate)</button></form>`
    : `<span class="badge b-mute">no candidate snapshot present</span>`;

  // Phase 20e — OAuth + webhook rotation (operator UI).
  const memberOptions = poolSnap.members
    .map(
      (m, i) =>
        `<option value="${esc(m.name)}"${i === 0 ? ' selected' : ''}>${esc(m.name)}</option>`,
    )
    .join('');

  const alertCfg = deps.alertStore.get();
  const webhookStatus = (url: string | null): string =>
    url
      ? `<span class="badge b-good">configured</span> <span class="tag">(${esc(url.length)} chars)</span>`
      : `<span class="badge b-mute">not set</span>`;

  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="5">
<title>claude-for-you · admin</title>
<style>${STYLE}</style>
</head><body>
<header>
  <h1>claude-for-you · admin</h1>
  <span class="tag">bun ${esc(Bun.version)} · uptime ${esc(fmtDur(uptimeSec))}</span>
  <span class="tag" style="flex:1">${esc(deps.templateDescription)}</span>
</header>
<main>
  <section>
    <h2>billing health</h2>
    <dl class="kv">
      <dt>service_tier</dt><dd>${tierBadge(lastObs?.serviceTier ?? null)}</dd>
      <dt>unified-status</dt><dd>${statusBadge(lastObs?.unifiedStatus ?? null)}</dd>
      <dt>representative claim</dt><dd>${esc(lastObs?.representativeClaim)}</dd>
      <dt>last observation</dt><dd>${esc(fmtAgo(lastObs?.observedAt))}</dd>
      <dt>non-standard count</dt><dd>${esc(billingSnap.nonStandardCount)}</dd>
      <dt>last alarm</dt><dd>${esc(fmtAgo(billingSnap.lastAlarmAt))}</dd>
    </dl>
  </section>
  <section>
    <h2>account pool</h2>
    <dl class="kv">
      ${poolSnap.members
        .map(
          (m) =>
            `<dt>${esc(m.name)}</dt>` +
            `<dd>remaining: ${m.remainingTokens !== null ? esc(m.remainingTokens.toLocaleString()) : '<span class="badge b-mute">unknown</span>'}` +
            ` <span class="tag">${esc(fmtAgo(m.remainingObservedAt))}</span></dd>`,
        )
        .join('')}
      <dt>session sticks</dt><dd>${esc(Object.keys(poolSnap.sessionAssignments).length)} active</dd>
    </dl>
  </section>
  <section>
    <h2>subscription headroom</h2>
    <dl class="kv">
      <dt>remaining tokens</dt><dd>${esc(guardSnap.remaining?.toLocaleString())}</dd>
      <dt>observed</dt><dd>${esc(fmtAgo(guardSnap.observedAt))}</dd>
    </dl>
  </section>
  <section>
    <h2>account learner</h2>
    <dl class="kv">
      <dt>org id</dt>
      <dd>${deps.accountLearner.current() ? esc(deps.accountLearner.current()) : '<span class="badge b-mute">not learned yet</span>'}</dd>
    </dl>
  </section>
  <section>
    <h2>canary</h2>
    <dl class="kv">
      <dt>status</dt><dd>${canaryBadge}</dd>
      <dt>candidate</dt><dd>${esc(deps.candidateDescription) ?? '<span class="badge b-mute">none</span>'}</dd>
      <dt>candidate reqs</dt><dd>${esc(canarySnap.candidateRequests)}</dd>
      <dt>stable reqs</dt><dd>${esc(canarySnap.stableRequests)}</dd>
      <dt>tripped at</dt><dd>${esc(fmtAgo(canarySnap.trippedAt))}</dd>
      <dt>tripped reason</dt><dd>${esc(canarySnap.trippedReason)}</dd>
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
      <dt>discord</dt><dd>${webhookStatus(alertCfg.discordWebhookUrl)}</dd>
      <dt>slack</dt><dd>${webhookStatus(alertCfg.slackWebhookUrl)}</dd>
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
  </section>
  <section style="grid-column: 1 / -1">
    <h2>per-user usage (UTC today)</h2>
    <dl class="kv">${usageRows}</dl>
  </section>
</main>
<footer>
  <span>auto-refresh 5s</span>
  <span>${esc(new Date().toLocaleTimeString())}</span>
</footer>
</body></html>`;

  return c.html(html);
};
