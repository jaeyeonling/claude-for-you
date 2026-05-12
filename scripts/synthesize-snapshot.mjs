#!/usr/bin/env bun
/**
 * Phase 18 — fold N captured /v1/messages requests into one
 * src/template/cc-snapshot.json (schemaVersion 2).
 *
 * Inputs : ./captures/*.json (from Phase 17 capture middleware)
 * Output : src/template/cc-snapshot.json
 *
 * Strategy:
 *   - header_order   : the most frequent ordered sequence of header names
 *   - header values  : the most frequent value per header (across captures)
 *   - body_key_order : the most frequent ordered sequence of body top-level keys
 *   - anthropic-beta : most frequent flag list (kept as-is, no whitelist —
 *                      live capture already shows what Anthropic accepts)
 *
 * Usage:
 *   bun scripts/synthesize-snapshot.mjs
 *   bun scripts/synthesize-snapshot.mjs --check    # diff only, no write
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CAPTURE_DIR = join(ROOT, 'captures');
const SNAPSHOT_OUT = join(ROOT, 'src', 'template', 'cc-snapshot.json');
const SCHEMA_VERSION = 2;

// Hop-by-hop and body-framing headers we should NOT replay (the HTTP stack
// recomputes them per request).
const TRANSPORT_HEADERS = new Set([
  'host',
  'content-length',
  'accept-encoding',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
]);

// Per-request dynamic values that should NOT be baked into the snapshot.
// These are forwarded from the client request at apply-time.
const DYNAMIC_HEADERS = new Set([
  'x-api-key',
  'authorization',
  'x-claude-code-session-id',
]);

const loadCaptures = async () => {
  if (!existsSync(CAPTURE_DIR)) {
    throw new Error(`capture dir not found: ${CAPTURE_DIR}`);
  }
  const files = (await readdir(CAPTURE_DIR)).filter((f) => f.endsWith('.json'));
  files.sort();
  const out = [];
  for (const f of files) {
    try {
      const raw = await readFile(join(CAPTURE_DIR, f), 'utf-8');
      const dump = JSON.parse(raw);
      if (dump.wireOrderAvailable !== true) continue; // skip sorted-only captures
      out.push(dump);
    } catch {
      // skip malformed
    }
  }
  return out;
};

const mostFrequent = (counter) => {
  let best = null;
  let bestCount = -1;
  for (const [key, cnt] of counter) {
    if (cnt > bestCount) {
      best = key;
      bestCount = cnt;
    }
  }
  return { value: best, count: bestCount };
};

const synthHeaderOrder = (dumps) => {
  // Group identical header-name sequences. Use the lowercased sequence as key.
  const seqCounter = new Map();
  for (const d of dumps) {
    const names = d.headersInOrder.map(([k]) => k.toLowerCase());
    const key = names.join('|');
    seqCounter.set(key, (seqCounter.get(key) ?? 0) + 1);
  }
  const arr = [...seqCounter.entries()].sort((a, b) => b[1] - a[1]);
  const dominant = arr[0]?.[0].split('|') ?? [];
  return { dominantOrder: dominant, distribution: arr.slice(0, 5) };
};

const synthHeaderValues = (dumps, orderedNames) => {
  // For each header name in the order, pick the most frequent value across
  // captures. Skip dynamic and transport headers.
  const result = [];
  const counters = new Map();
  for (const d of dumps) {
    for (const [k, v] of d.headersInOrder) {
      const kl = k.toLowerCase();
      if (!counters.has(kl)) counters.set(kl, new Map());
      const c = counters.get(kl);
      c.set(v, (c.get(v) ?? 0) + 1);
    }
  }
  for (const name of orderedNames) {
    if (TRANSPORT_HEADERS.has(name) || DYNAMIC_HEADERS.has(name)) continue;
    const c = counters.get(name);
    if (!c) continue;
    const { value } = mostFrequent(c);
    if (typeof value === 'string') result.push({ name, value });
  }
  return result;
};

// Measure inter-request gap distribution within a single CC session.
// CC typically reuses a session-id across the conversation; the time
// between consecutive same-session captures is its natural pacing.
const synthPacing = (dumps) => {
  const bySession = new Map();
  for (const d of dumps) {
    let sid = null;
    for (const [k, v] of d.headersInOrder) {
      if (k.toLowerCase() === 'x-claude-code-session-id') {
        sid = v;
        break;
      }
    }
    if (!sid) continue;
    const ts = new Date(d.capturedAt).getTime();
    if (!Number.isFinite(ts)) continue;
    if (!bySession.has(sid)) bySession.set(sid, []);
    bySession.get(sid).push(ts);
  }
  const gaps = [];
  for (const tss of bySession.values()) {
    tss.sort((a, b) => a - b);
    for (let i = 1; i < tss.length; i++) {
      const g = tss[i] - tss[i - 1];
      if (g >= 0 && g < 600_000) gaps.push(g); // ignore huge idle gaps
    }
  }
  if (gaps.length === 0) return null;
  gaps.sort((a, b) => a - b);
  const pick = (p) => gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))];
  return {
    samples: gaps.length,
    minMs: gaps[0],
    p50Ms: pick(0.5),
    p95Ms: pick(0.95),
    maxMs: gaps[gaps.length - 1],
  };
};

const synthBodyKeyOrder = (dumps) => {
  const seqCounter = new Map();
  for (const d of dumps) {
    try {
      const b = JSON.parse(d.body);
      if (b && typeof b === 'object' && !Array.isArray(b)) {
        const keys = Object.keys(b);
        const key = keys.join('|');
        seqCounter.set(key, (seqCounter.get(key) ?? 0) + 1);
      }
    } catch {
      // skip
    }
  }
  const arr = [...seqCounter.entries()].sort((a, b) => b[1] - a[1]);
  const dominant = arr[0]?.[0].split('|') ?? [];
  return { dominantOrder: dominant, distribution: arr.slice(0, 5) };
};

const buildSnapshot = (dumps) => {
  if (dumps.length === 0) throw new Error('no captures found');

  const headerOrder = synthHeaderOrder(dumps);
  const headerValues = synthHeaderValues(dumps, headerOrder.dominantOrder);
  const bodyKeyOrder = synthBodyKeyOrder(dumps);
  const pacing = synthPacing(dumps);

  return {
    schemaVersion: SCHEMA_VERSION,
    extractedAt: new Date().toISOString(),
    capturedCount: dumps.length,
    capturedFrom: dumps[0]?.capturedAt,
    capturedTo: dumps[dumps.length - 1]?.capturedAt,
    headerOrder: headerOrder.dominantOrder,
    headerOrderDistribution: headerOrder.distribution.map(([k, n]) => ({ count: n, names: k.split('|') })),
    headerValues, // [{name, value}, ...] in the same wire order
    bodyKeyOrder: bodyKeyOrder.dominantOrder,
    bodyKeyOrderDistribution: bodyKeyOrder.distribution.map(([k, n]) => ({ count: n, keys: k.split('|') })),
    pacing, // null if no same-session pairs available
  };
};

const main = async () => {
  const checkMode = process.argv.includes('--check');

  const dumps = await loadCaptures();
  console.log(`captures loaded: ${dumps.length}`);
  if (dumps.length === 0) {
    console.error('No captures with wireOrderAvailable=true found.');
    process.exit(1);
  }

  const snap = buildSnapshot(dumps);

  console.log('');
  console.log('--- synthesis summary ---');
  console.log('header order (wire):');
  for (const n of snap.headerOrder) console.log('  -', n);
  console.log('header values (replay-ready):');
  for (const h of snap.headerValues) {
    const display = h.value.length > 80 ? h.value.slice(0, 77) + '…' : h.value;
    console.log(`  ${h.name}: ${display}`);
  }
  console.log('body key order:');
  for (const k of snap.bodyKeyOrder) console.log('  -', k);
  console.log('pacing (same-session inter-arrival):');
  if (snap.pacing) {
    console.log(`  samples=${snap.pacing.samples}  min=${snap.pacing.minMs}ms  p50=${snap.pacing.p50Ms}ms  p95=${snap.pacing.p95Ms}ms  max=${snap.pacing.maxMs}ms`);
  } else {
    console.log('  (no same-session pairs — pacing unmeasurable from this batch)');
  }
  console.log('');
  console.log('header order distribution (top patterns):');
  for (const d of snap.headerOrderDistribution) console.log(`  [${d.count}x] ${d.names.length} headers`);
  console.log('body key distribution:');
  for (const d of snap.bodyKeyOrderDistribution) console.log(`  [${d.count}x] ${d.keys.length} keys: ${d.keys.slice(0, 6).join(', ')}…`);

  if (checkMode) {
    console.log('');
    console.log('mode: --check — no write.');
    return;
  }

  await writeFile(SNAPSHOT_OUT, JSON.stringify(snap, null, 2) + '\n');
  console.log('');
  console.log('wrote :', SNAPSHOT_OUT);
};

main().catch((e) => {
  console.error('ERROR:', e instanceof Error ? e.message : e);
  process.exit(1);
});
