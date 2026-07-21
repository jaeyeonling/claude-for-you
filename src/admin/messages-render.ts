import type {
  MessageLogRecord,
  MessageLogSummary,
  MessageSource,
  ResponseBody,
} from '../usage/messages-log.js';

/**
 * Pure renderers for /admin/messages (list) and /admin/messages/:id (detail).
 * Separated from the handler so the HTML is unit-testable in isolation.
 */

const esc = (s: unknown): string => {
  const str = s === null || s === undefined ? '—' : String(s);
  return str
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
};

const fmtDurMs = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
};

const fmtTs = (d: Date): string => d.toISOString().replace('T', ' ').replace('Z', '');

const statusBadge = (status: number): string => {
  if (status >= 200 && status < 300) return `<span class="badge b-good">${status}</span>`;
  if (status >= 400) return `<span class="badge b-bad">${status}</span>`;
  return `<span class="badge b-mute">${status}</span>`;
};

const tierBadge = (tier: string | null): string => {
  if (!tier) return `<span class="badge b-mute">—</span>`;
  if (tier === 'standard') return `<span class="badge b-good">${esc(tier)}</span>`;
  return `<span class="badge b-bad">${esc(tier)}</span>`;
};

// Failure-origin badge (#144). CATEGORICAL colors, not severity — the row's
// severity is already carried by the status badge. `upstream` is written for
// EVERY request that reached Anthropic (including 2xx success), so it must NOT
// look alarming (a red badge on healthy traffic misreads as "error" —
// check-R1 first-timer). proxy = our infra (amber), upstream = Anthropic
// (neutral blue/info), client = caller (grey), null/legacy = mute dash.
const sourceBadge = (source: MessageSource | null | undefined): string => {
  if (source === 'proxy') return `<span class="badge b-warn">proxy</span>`;
  if (source === 'upstream') return `<span class="badge b-info">upstream</span>`;
  if (source === 'client') return `<span class="badge b-mute">client</span>`;
  return `<span class="badge b-mute">—</span>`;
};

const STYLE = `
:root{--bg:oklch(15% 0 0);--surface:oklch(20% 0 0);--text:oklch(94% 0 0);--muted:oklch(60% 0 0);--accent:oklch(72% 0.18 220);--warn:oklch(78% 0.18 60);--bad:oklch(70% 0.22 25);--good:oklch(72% 0.16 145);--border:oklch(28% 0 0)}
*{box-sizing:border-box}html,body{margin:0;padding:0}
body{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--bg);color:var(--text);font-size:13px;line-height:1.5;padding:clamp(1rem,2vw,2rem)}
header{display:flex;align-items:baseline;gap:1.5rem;margin-bottom:1.2rem;border-bottom:1px solid var(--border);padding-bottom:.7rem;flex-wrap:wrap}
h1{font-size:1.1rem;font-weight:600;margin:0;letter-spacing:-.01em}
h2{font-size:.78rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin:0 0 .7rem 0}
.tag{font-size:.78rem;color:var(--muted)}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
.toolbar{display:flex;gap:.5rem;flex-wrap:wrap;align-items:end;margin-bottom:1rem;padding:.7rem 1rem;background:var(--surface);border:1px solid var(--border);border-radius:6px}
.toolbar label{display:flex;flex-direction:column;gap:.2rem;font-size:.72rem;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.toolbar input,.toolbar select{font-family:inherit;font-size:.85rem;padding:.32rem .5rem;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:3px;min-width:140px}
.toolbar input:focus,.toolbar select:focus{outline:none;border-color:var(--accent)}
.toolbar button{font-family:inherit;font-size:.78rem;padding:.4rem .9rem;background:var(--accent);color:var(--bg);border:none;border-radius:3px;cursor:pointer;font-weight:600}
.toolbar a.clear{font-size:.72rem;color:var(--muted);padding:.4rem .5rem;border:1px solid var(--border);border-radius:3px}
.badge{display:inline-block;padding:.1rem .5rem;border-radius:3px;font-size:.72rem;font-weight:600;letter-spacing:.04em}
.b-good{background:oklch(72% 0.16 145 / 0.18);color:var(--good)}
.b-warn{background:oklch(78% 0.18 60 / 0.18);color:var(--warn)}
.b-bad{background:oklch(70% 0.22 25 / 0.2);color:var(--bad)}
.b-info{background:oklch(72% 0.18 220 / 0.18);color:var(--accent)}
.b-mute{background:oklch(40% 0 0 / 0.25);color:var(--muted)}
table{width:100%;border-collapse:collapse;background:var(--surface);border:1px solid var(--border);border-radius:6px;overflow:hidden}
th,td{text-align:left;padding:.55rem .8rem;border-bottom:1px solid var(--border);font-size:.82rem;vertical-align:top}
th{font-size:.7rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);background:oklch(18% 0 0);position:sticky;top:0}
tr:last-child td{border-bottom:none}
tr:hover{background:oklch(22% 0 0)}
td.preview{max-width:520px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text)}
td.num{text-align:right;font-variant-numeric:tabular-nums}
.pager{margin-top:1rem;display:flex;gap:.7rem;color:var(--muted);font-size:.8rem}
.empty{padding:2rem;text-align:center;color:var(--muted);background:var(--surface);border:1px dashed var(--border);border-radius:6px}
section.detail{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:1rem 1.1rem;margin-bottom:1rem}
.kv{display:grid;grid-template-columns:minmax(160px,max-content) 1fr;gap:.35rem 1rem;font-size:.86rem}
.kv>dt{color:var(--muted)}
.kv>dd{margin:0;word-break:break-all}
pre{white-space:pre-wrap;word-break:break-word;background:var(--bg);border:1px solid var(--border);border-radius:3px;padding:.8rem;font-size:.78rem;margin:0;max-height:600px;overflow:auto}
details{margin-top:.7rem}
details>summary{cursor:pointer;color:var(--muted);font-size:.78rem;text-transform:uppercase;letter-spacing:.06em;padding:.3rem 0}
details>summary:hover{color:var(--text)}
.role-user{color:var(--accent)}
.role-assistant{color:var(--good)}
.role-system{color:var(--warn)}
footer{margin-top:1.5rem;color:var(--muted);font-size:.75rem}
`;

export interface MessagesListSnapshot {
  readonly rows: readonly MessageLogSummary[];
  readonly filters: Readonly<{
    q: string;
    user: string;
    model: string;
    status: 'all' | 'success' | 'error';
    source: 'all' | MessageSource;
  }>;
  readonly nextCursor: string | null;
  readonly hasPrev: boolean;
}

const qs = (params: Record<string, string | null | undefined>): string => {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined && v !== '') out.set(k, v);
  }
  const s = out.toString();
  return s ? `?${s}` : '';
};

export const renderMessagesList = (s: MessagesListSnapshot): string => {
  const { rows, filters, nextCursor, hasPrev } = s;

  const rowsHtml =
    rows.length === 0
      ? `<div class="empty">no matching messages</div>`
      : `<table>
  <thead>
    <tr>
      <th>time (utc)</th><th>user</th><th>model</th><th>status</th><th>source</th>
      <th>stream</th><th class="num">dur</th><th class="num">in/out</th>
      <th>tier</th><th>preview</th>
    </tr>
  </thead>
  <tbody>
${rows
  .map(
    (r) => `    <tr>
      <td><a href="/admin/messages/${esc(r.id)}">${esc(fmtTs(r.ts))}</a></td>
      <td>${esc(r.userName)}</td>
      <td>${esc(r.model ?? '—')}</td>
      <td>${statusBadge(r.status)}</td>
      <td>${sourceBadge(r.source ?? null)}</td>
      <td>${r.streaming ? '<span class="badge b-mute">sse</span>' : '<span class="badge b-mute">json</span>'}</td>
      <td class="num">${esc(fmtDurMs(r.durationMs))}</td>
      <td class="num">${esc(r.inputTokens.toLocaleString())}/${esc(r.outputTokens.toLocaleString())}</td>
      <td>${tierBadge(r.serviceTier)}</td>
      <td class="preview" title="${esc(r.preview)}">${esc(r.preview)}</td>
    </tr>`,
  )
  .join('\n')}
  </tbody>
</table>`;

  const pagerHtml =
    nextCursor || hasPrev
      ? `<div class="pager">
  ${hasPrev ? `<a href="/admin/messages">← newest</a>` : ''}
  ${nextCursor ? `<a href="/admin/messages${qs({ q: filters.q, user: filters.user, model: filters.model, status: filters.status === 'all' ? null : filters.status, source: filters.source === 'all' ? null : filters.source, before: nextCursor })}">older →</a>` : ''}
</div>`
      : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>claude-for-you · messages</title>
<style>${STYLE}</style>
</head>
<body>
  <header>
    <h1>messages</h1>
    <span class="tag">full-content request/response log</span>
    <span style="margin-left:auto"><a href="/admin">← dashboard</a></span>
  </header>

  <form class="toolbar" method="get" action="/admin/messages">
    <label>search<input type="text" name="q" value="${esc(filters.q)}" placeholder="substring of last user message"></label>
    <label>user<input type="text" name="user" value="${esc(filters.user)}" placeholder="exact"></label>
    <label>model<input type="text" name="model" value="${esc(filters.model)}" placeholder="exact"></label>
    <label>status
      <select name="status">
        <option value="all"${filters.status === 'all' ? ' selected' : ''}>all</option>
        <option value="success"${filters.status === 'success' ? ' selected' : ''}>2xx</option>
        <option value="error"${filters.status === 'error' ? ' selected' : ''}>4xx/5xx</option>
      </select>
    </label>
    <label title="upstream = reached Anthropic (any status); proxy = our own limit/failure (429 cap, 5xx, 502); client = caller rejected (400/413)">source
      <select name="source">
        <option value="all"${filters.source === 'all' ? ' selected' : ''}>all</option>
        <option value="upstream"${filters.source === 'upstream' ? ' selected' : ''}>upstream (Anthropic)</option>
        <option value="proxy"${filters.source === 'proxy' ? ' selected' : ''}>proxy (our infra)</option>
        <option value="client"${filters.source === 'client' ? ' selected' : ''}>client (caller)</option>
      </select>
    </label>
    <button type="submit">filter</button>
    <a class="clear" href="/admin/messages">clear</a>
  </form>

  ${rowsHtml}
  ${pagerHtml}

  <footer>${esc(rows.length)} rows · server time ${esc(new Date().toISOString())}</footer>
</body>
</html>`;
};

/**
 * Reassemble streamed assistant text from raw SSE bytes. Walks each
 * `data:` line and concatenates `content_block_delta.delta.text` chunks
 * in the order they were emitted. Tool calls and thinking blocks are
 * surfaced as separate sections in the detail view, not folded into the
 * text reassembly — keeps the human-readable view honest about what
 * was generated vs. what was structural.
 */
const reassembleSseAssistant = (raw: string): { text: string; toolUses: ToolUseSummary[] } => {
  let text = '';
  const toolUses = new Map<number, ToolUseSummary>();
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.slice(6));
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== 'object') continue;
    const ev = parsed as Record<string, unknown>;
    if (ev.type === 'content_block_start') {
      const block = ev.content_block as Record<string, unknown> | undefined;
      const idx = typeof ev.index === 'number' ? ev.index : -1;
      if (block?.type === 'tool_use' && idx >= 0) {
        toolUses.set(idx, {
          name: typeof block.name === 'string' ? block.name : '?',
          id: typeof block.id === 'string' ? block.id : '?',
          input: '',
        });
      }
    } else if (ev.type === 'content_block_delta') {
      const delta = ev.delta as Record<string, unknown> | undefined;
      const idx = typeof ev.index === 'number' ? ev.index : -1;
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        text += delta.text;
      } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        const tu = toolUses.get(idx);
        if (tu) tu.input += delta.partial_json;
      }
    }
  }
  return { text, toolUses: Array.from(toolUses.values()) };
};

interface ToolUseSummary {
  name: string;
  id: string;
  input: string;
}

const renderRequestPreview = (requestBody: unknown): string => {
  if (requestBody === null || typeof requestBody !== 'object') {
    return `<pre>${esc(JSON.stringify(requestBody, null, 2))}</pre>`;
  }
  const body = requestBody as Record<string, unknown>;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const systemHtml = (() => {
    const sys = body.system;
    if (typeof sys === 'string' && sys.length > 0) {
      return `<details><summary>system (${esc(sys.length)} chars)</summary><pre>${esc(sys)}</pre></details>`;
    }
    if (Array.isArray(sys) && sys.length > 0) {
      const text = sys
        .map((b) => (b && typeof b === 'object' && typeof (b as Record<string, unknown>).text === 'string' ? String((b as Record<string, unknown>).text) : JSON.stringify(b)))
        .join('\n\n---\n\n');
      return `<details><summary>system (array, ${sys.length} blocks)</summary><pre>${esc(text)}</pre></details>`;
    }
    return '';
  })();

  const msgsHtml = messages
    .map((m, i) => {
      if (m === null || typeof m !== 'object') return '';
      const msg = m as Record<string, unknown>;
      const role = typeof msg.role === 'string' ? msg.role : '?';
      const roleClass = role === 'user' ? 'role-user' : role === 'assistant' ? 'role-assistant' : 'role-system';
      const c = msg.content;
      const body =
        typeof c === 'string'
          ? `<pre>${esc(c)}</pre>`
          : Array.isArray(c)
            ? `<pre>${esc(JSON.stringify(c, null, 2))}</pre>`
            : `<pre>${esc(String(c))}</pre>`;
      return `<details${i === messages.length - 1 ? ' open' : ''}><summary><span class="${roleClass}">[${esc(i)}] ${esc(role)}</span></summary>${body}</details>`;
    })
    .join('');

  return `${systemHtml}${msgsHtml}`;
};

const renderResponseBody = (rb: ResponseBody | null, streaming: boolean): string => {
  if (rb === null) return `<div class="tag">no body</div>`;
  if (rb.kind === 'json') {
    return `<pre>${esc(typeof rb.body === 'string' ? rb.body : JSON.stringify(rb.body, null, 2))}</pre>`;
  }
  if (rb.kind === 'text') {
    return `<div class="tag">non-JSON body (${esc(rb.raw.length.toLocaleString())} bytes)</div><pre>${esc(rb.raw)}</pre>`;
  }
  // SSE
  const { text, toolUses } = reassembleSseAssistant(rb.raw);
  const reassembled =
    text.length > 0
      ? `<details open><summary>assistant text (reassembled, ${esc(text.length)} chars)</summary><pre>${esc(text)}</pre></details>`
      : '';
  const tools =
    toolUses.length > 0
      ? `<details><summary>tool_use (${toolUses.length})</summary>${toolUses
          .map(
            (t) =>
              `<div style="margin-bottom:.5rem"><strong>${esc(t.name)}</strong> <span class="tag">${esc(t.id)}</span><pre>${esc(t.input)}</pre></div>`,
          )
          .join('')}</details>`
      : '';
  const rawSize = rb.raw.length;
  const rawView = `<details><summary>raw SSE (${esc(rawSize.toLocaleString())} bytes)</summary><pre>${esc(rb.raw)}</pre></details>`;
  return `${streaming ? '' : ''}${reassembled}${tools}${rawView}`;
};

/**
 * Render the bypass-metadata section. Defensive shape inspection — the JSONB
 * blob is `unknown` by contract, since the schema is owned by
 * usage/bypass-metadata.ts and the admin renderer must not crash on legacy
 * rows that predate any individual field.
 */
const renderHeaderTable = (
  title: string,
  headers: Readonly<Record<string, string>>,
): string => {
  const entries = Object.entries(headers).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) {
    return `<details><summary>${esc(title)} (empty)</summary></details>`;
  }
  const rows = entries
    .map(([k, v]) => `<tr><td><code>${esc(k)}</code></td><td><code>${esc(v)}</code></td></tr>`)
    .join('');
  return `<details><summary>${esc(title)} (${entries.length})</summary>
    <table><thead><tr><th>header</th><th>value</th></tr></thead>
    <tbody>${rows}</tbody></table></details>`;
};

const isStringRecord = (v: unknown): v is Record<string, string> => {
  if (v === null || typeof v !== 'object') return false;
  for (const value of Object.values(v as Record<string, unknown>)) {
    if (typeof value !== 'string') return false;
  }
  return true;
};

interface UnknownFingerprint {
  readonly name: string;
  readonly length: number;
}

const isUnknownFingerprintList = (v: unknown): v is readonly UnknownFingerprint[] => {
  if (!Array.isArray(v)) return false;
  for (const item of v) {
    if (item === null || typeof item !== 'object') return false;
    const it = item as Record<string, unknown>;
    if (typeof it.name !== 'string' || typeof it.length !== 'number') return false;
  }
  return true;
};

const renderUnknownHeaders = (
  title: string,
  list: readonly UnknownFingerprint[],
): string => {
  if (list.length === 0) {
    return `<details><summary>${esc(title)} (none)</summary></details>`;
  }
  const rows = list
    .map(
      (h) =>
        `<tr><td><code>${esc(h.name)}</code></td><td>${esc(h.length.toLocaleString())} bytes</td></tr>`,
    )
    .join('');
  return `<details><summary>${esc(title)} (${list.length})</summary>
    <p style="color:var(--muted);font-size:.75rem;margin:.4rem 0">
      values NOT stored — name + byte-length only. Use this to detect new SDK
      headers rolling out (length jumps) or unexpected clients without leaking
      cookies / auth / forwarded-IP chains.
    </p>
    <table><thead><tr><th>header</th><th>length</th></tr></thead>
    <tbody>${rows}</tbody></table></details>`;
};

const renderBypassMetadata = (m: unknown): string => {
  if (m === null || m === undefined || typeof m !== 'object') return '';
  const obj = m as Record<string, unknown>;
  const inbound = isStringRecord(obj.inboundHeaders) ? obj.inboundHeaders : {};
  const outbound = isStringRecord(obj.outboundHeaders) ? obj.outboundHeaders : {};
  const upstream = isStringRecord(obj.upstreamHeaders) ? obj.upstreamHeaders : {};
  const unknownInbound = isUnknownFingerprintList(obj.unknownInboundHeaders)
    ? obj.unknownInboundHeaders
    : [];
  const unknownOutbound = isUnknownFingerprintList(obj.unknownOutboundHeaders)
    ? obj.unknownOutboundHeaders
    : [];
  const unknownUpstream = isUnknownFingerprintList(obj.unknownUpstreamHeaders)
    ? obj.unknownUpstreamHeaders
    : [];
  const canary = obj.canary as Record<string, unknown> | null | undefined;
  const useCandidate =
    canary && typeof canary.useCandidate === 'boolean' ? canary.useCandidate : false;
  return `<section class="detail">
    <h2>proxy bypass metadata</h2>
    <dl class="kv">
      <dt>canary</dt><dd>${useCandidate ? '<span class="badge b-warn">candidate</span>' : '<span class="badge b-mute">stable</span>'}</dd>
    </dl>
    ${renderHeaderTable('inbound headers (client → proxy)', inbound)}
    ${renderHeaderTable('outbound headers (proxy → anthropic)', outbound)}
    ${renderHeaderTable('upstream response headers (anthropic → proxy)', upstream)}
    ${renderUnknownHeaders('unknown inbound headers', unknownInbound)}
    ${renderUnknownHeaders('unknown outbound headers', unknownOutbound)}
    ${renderUnknownHeaders('unknown upstream headers', unknownUpstream)}
  </section>`;
};

export const renderMessageDetail = (r: MessageLogRecord): string => {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>claude-for-you · message ${esc(r.id)}</title>
<style>${STYLE}</style>
</head>
<body>
  <header>
    <h1>message detail</h1>
    <span class="tag">${esc(r.id)}</span>
    <span style="margin-left:auto"><a href="/admin/messages">← list</a></span>
  </header>

  <section class="detail">
    <h2>meta</h2>
    <dl class="kv">
      <dt>timestamp</dt><dd>${esc(fmtTs(r.ts))} UTC</dd>
      <dt>user</dt><dd>${esc(r.userName)}</dd>
      <dt>model</dt><dd>${esc(r.model ?? '—')}</dd>
      <dt>status</dt><dd>${statusBadge(r.status)}</dd>
      <dt>source</dt><dd>${sourceBadge(r.source ?? null)}</dd>
      <dt>streaming</dt><dd>${r.streaming ? 'sse' : 'json'}</dd>
      <dt>duration</dt><dd>${esc(fmtDurMs(r.durationMs))}</dd>
      <dt>tokens (in / out)</dt><dd>${esc(r.inputTokens.toLocaleString())} / ${esc(r.outputTokens.toLocaleString())}</dd>
      <dt>cache (read / create)</dt><dd>${esc(r.cacheReadTokens.toLocaleString())} / ${esc(r.cacheCreationTokens.toLocaleString())}</dd>
      <dt>service_tier</dt><dd>${tierBadge(r.serviceTier)}</dd>
      <dt>stop_reason</dt><dd>${esc(r.stopReason ?? '—')}</dd>
      <dt>client ip</dt><dd>${esc(r.clientIp ?? '—')}</dd>
      <dt>user agent</dt><dd>${esc(r.userAgent ?? '—')}</dd>
      <dt>served by</dt><dd>${esc(r.servedBy ?? '—')}</dd>
      ${r.errorMessage ? `<dt>error</dt><dd><span class="badge b-bad">error</span> ${esc(r.errorMessage)}</dd>` : ''}
    </dl>
  </section>

  ${renderBypassMetadata(r.bypassMetadata)}

  <section class="detail">
    <h2>request</h2>
    ${renderRequestPreview(r.requestBody)}
    <details><summary>raw request JSON</summary><pre>${esc(JSON.stringify(r.requestBody, null, 2))}</pre></details>
  </section>

  <section class="detail">
    <h2>response</h2>
    ${renderResponseBody(r.responseBody, r.streaming)}
  </section>

  <footer>server time ${esc(new Date().toISOString())}</footer>
</body>
</html>`;
};
