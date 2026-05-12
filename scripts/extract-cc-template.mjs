#!/usr/bin/env node
/**
 * Phase 10 — extract Claude Code wire-level template from the installed
 * `claude` binary and write src/template/cc-snapshot.json.
 *
 * Self-contained: pure Node, no deps. Strings are extracted directly from
 * the binary buffer (no external `strings` utility required).
 *
 * Env override: CC_BINARY_PATH (skip auto-detection).
 *
 * Usage:
 *   node scripts/extract-cc-template.mjs
 *   CC_BINARY_PATH=/path/to/claude node scripts/extract-cc-template.mjs
 */

import { readFile, writeFile, stat, lstat, readlink, readdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const SNAPSHOT_OUT = join(PROJECT_ROOT, 'src', 'template', 'cc-snapshot.json');
const SCHEMA_VERSION = 1;

// ---------- binary detection ----------

const resolveSymlink = async (p) => {
  try {
    const s = await lstat(p);
    if (!s.isSymbolicLink()) return p;
    const target = await readlink(p);
    return resolve(dirname(p), target);
  } catch {
    return p;
  }
};

const isShellScript = (path) => {
  try {
    const head = readFileSync(path, { encoding: 'utf-8' }).slice(0, 64);
    return head.startsWith('#!');
  } catch {
    return false;
  }
};

const npmGlobalRoot = async () => {
  try {
    const { stdout } = await execFileP('npm', ['root', '-g']);
    return stdout.trim();
  } catch {
    return null;
  }
};

const detectBinary = async () => {
  const envPath = process.env.CC_BINARY_PATH;
  if (envPath) {
    if (!existsSync(envPath)) throw new Error(`CC_BINARY_PATH does not exist: ${envPath}`);
    return resolve(envPath);
  }

  const candidates = [];

  // Walk PATH for every `claude` (skip text shell wrappers like cmux's).
  for (const dir of (process.env.PATH ?? '').split(':')) {
    const p = join(dir, 'claude');
    if (existsSync(p)) candidates.push(p);
  }

  // Homebrew Cask canonical location
  const caskRoot = '/opt/homebrew/Caskroom/claude-code';
  if (existsSync(caskRoot)) {
    try {
      const versions = await readdir(caskRoot);
      for (const v of versions) {
        const p = join(caskRoot, v, 'claude');
        if (existsSync(p)) candidates.push(p);
      }
    } catch {}
  }

  // npm global (cli.js)
  const root = await npmGlobalRoot();
  if (root) {
    const cli = join(root, '@anthropic-ai', 'claude-code', 'cli.js');
    if (existsSync(cli)) candidates.push(cli);
  }

  for (const c of candidates) {
    const resolved = await resolveSymlink(c);
    if (isShellScript(resolved)) continue; // skip wrappers
    return resolved;
  }

  throw new Error(
    'Claude Code binary not found. Set CC_BINARY_PATH=/path/to/claude and retry.',
  );
};

// ---------- string extraction ----------

const MIN_STRING_LEN = 4;
const MAX_STRING_LEN = 32 * 1024;

const extractStrings = (buf) => {
  const out = [];
  let start = -1;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    const printable = (b >= 0x20 && b <= 0x7e) || b === 0x09;
    if (printable) {
      if (start < 0) start = i;
    } else {
      if (start >= 0) {
        const len = i - start;
        if (len >= MIN_STRING_LEN && len <= MAX_STRING_LEN) {
          out.push(buf.toString('utf8', start, i));
        }
        start = -1;
      }
    }
  }
  if (start >= 0 && buf.length - start >= MIN_STRING_LEN) {
    out.push(buf.toString('utf8', start, buf.length));
  }
  return out;
};

// ---------- extractors ----------

// anthropic-beta: 'kebab-words-YYYY-MM-DD' or 'kebab-words-YYYYMMDD'
const BETA_RE = /^(?:[a-z][a-z0-9]*-){1,6}(?:\d{4}-\d{2}-\d{2}|\d{8})$/;

const extractBetaFlags = (strings) => {
  const seen = new Set();
  for (const s of strings) {
    if (s.length > 60) continue;
    if (BETA_RE.test(s)) seen.add(s);
  }
  return [...seen].sort();
};

// CC bundles its metadata block as a single object literal. Parsing it is far
// more reliable than scanning loose strings.
//   {ISSUES_EXPLAINER:"…",PACKAGE_URL:"@anthropic-ai/claude-code",
//    README_URL:"…",VERSION:"2.1.126",FEEDBACK_CHANNEL:"…",
//    BUILD_TIME:"2026-04-30T16:01:00Z",GIT_SHA:"e44c1d97…"}
const META_RE =
  /\{ISSUES_EXPLAINER:"[^"]*",PACKAGE_URL:"(@anthropic-ai\/claude-code)",README_URL:"[^"]*",VERSION:"(\d+\.\d+\.\d+)",FEEDBACK_CHANNEL:"[^"]*",BUILD_TIME:"([^"]+)",GIT_SHA:"([0-9a-f]+)"\}/;

const extractCcMeta = (strings) => {
  for (const s of strings) {
    const m = s.match(META_RE);
    if (m) return { packageUrl: m[1], version: m[2], buildTime: m[3], gitSha: m[4] };
  }
  return null;
};

// user-agent is generated at runtime by the SDK from navigator.userAgent
// (Bun-provided). Statically we can only synthesize a plausible value from
// the version we extracted. Override manually in the snapshot if you've
// captured the real value via mitmproxy.
const synthUserAgent = (meta) => {
  if (meta?.version) return `claude-cli/${meta.version}`;
  return 'claude-cli/unknown';
};

const X_STAINLESS_NAME = /^x-stainless-[a-z][a-z0-9-]*$/;

const extractStainlessHeaderNames = (strings) => {
  const seen = new Set();
  for (const s of strings) {
    if (s.length > 60) continue;
    if (X_STAINLESS_NAME.test(s)) seen.add(s);
  }
  return [...seen].sort();
};

// x-stainless values are not recoverable by name-position alone; the SDK
// fills them at runtime from the build environment. We seed defaults that
// match CC's actual build (Bun, user's OS/arch) — operators can override
// per-axis manually in the snapshot if needed.
const stainlessValueDefaults = () => ({
  'x-stainless-lang': 'js',
  'x-stainless-os':
    process.platform === 'darwin'
      ? 'MacOS'
      : process.platform === 'linux'
        ? 'Linux'
        : 'Windows',
  'x-stainless-arch':
    process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : process.arch,
  'x-stainless-runtime': 'bun',
  'x-stainless-runtime-version': 'unknown',
  'x-stainless-package-version': 'unknown',
  'x-stainless-retry-count': '0',
  'x-stainless-timeout': '600',
  'x-stainless-helper-method': '',
  'x-stainless-poll-helper': '',
  'x-stainless-custom-poll-interval': '',
  'x-stainless-read-timeout': '',
});

const buildStainlessHeaders = (names) => {
  const defaults = stainlessValueDefaults();
  const out = {};
  for (const n of names) out[n] = defaults[n] ?? '';
  return out;
};

// ---------- drift diff ----------

const loadExistingSnapshot = async () => {
  try {
    const raw = await readFile(SNAPSHOT_OUT, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const splitFlags = (s) =>
  new Set(
    (s ?? '')
      .split(',')
      .map((f) => f.trim())
      .filter(Boolean),
  );

const diffSnapshots = (oldSnap, newSnap) => {
  if (!oldSnap) return ['(no existing snapshot — first extraction)'];
  const lines = [];

  if (oldSnap.ccVersion !== newSnap.ccVersion) {
    lines.push(`ccVersion : ${oldSnap.ccVersion} → ${newSnap.ccVersion}`);
  }
  if (oldSnap.ccBinarySha256 !== newSnap.ccBinarySha256) {
    lines.push(
      `sha256    : ${oldSnap.ccBinarySha256.slice(0, 12)}… → ${newSnap.ccBinarySha256.slice(0, 12)}…`,
    );
  }
  if (oldSnap.ccBuildTime !== newSnap.ccBuildTime) {
    lines.push(`buildTime : ${oldSnap.ccBuildTime ?? '?'} → ${newSnap.ccBuildTime ?? '?'}`);
  }

  const oldBeta = splitFlags(oldSnap.headers?.['anthropic-beta']);
  const newBeta = splitFlags(newSnap.headers?.['anthropic-beta']);
  const added = [...newBeta].filter((f) => !oldBeta.has(f));
  const removed = [...oldBeta].filter((f) => !newBeta.has(f));
  if (added.length > 0) lines.push(`anthropic-beta + (${added.length}): ${added.join(', ')}`);
  if (removed.length > 0) lines.push(`anthropic-beta - (${removed.length}): ${removed.join(', ')}`);

  const oldUA = oldSnap.headers?.['user-agent'];
  const newUA = newSnap.headers?.['user-agent'];
  if (oldUA !== newUA) lines.push(`user-agent: ${oldUA} → ${newUA}`);

  return lines.length === 0 ? ['(no changes)'] : lines;
};

// ---------- main ----------

const main = async () => {
  const checkMode = process.argv.includes('--check');

  const binPath = await detectBinary();
  const st = await stat(binPath);
  const buf = await readFile(binPath);
  const sha256 = createHash('sha256').update(buf).digest('hex');

  console.log('binary :', binPath);
  console.log('size   :', st.size, 'bytes');
  console.log('sha256 :', sha256.slice(0, 16) + '…');

  const strings = extractStrings(buf);
  console.log('strings:', strings.length, '(>= 4 chars)');

  const betaFlags = extractBetaFlags(strings);
  const meta = extractCcMeta(strings);
  const userAgent = synthUserAgent(meta);
  const stainlessNames = extractStainlessHeaderNames(strings);
  const stainlessHeaders = buildStainlessHeaders(stainlessNames);

  const headers = {
    'anthropic-version': '2023-06-01',
    'anthropic-beta': betaFlags.join(','),
    'user-agent': userAgent,
    'x-app': 'cli',
    accept: 'application/json',
    ...stainlessHeaders,
  };

  const snapshot = {
    schemaVersion: SCHEMA_VERSION,
    extractedAt: new Date().toISOString(),
    ccBinaryPath: binPath,
    ccBinarySize: st.size,
    ccBinarySha256: sha256,
    ccVersion: meta?.version ?? 'unknown',
    ccBuildTime: meta?.buildTime ?? null,
    ccGitSha: meta?.gitSha ?? null,
    headers,
    // Phase 12 will populate these:
    systemPrompt: null,
    tools: null,
  };

  const existing = await loadExistingSnapshot();
  const diffLines = diffSnapshots(existing, snapshot);

  console.log('');
  console.log('--- diff vs existing snapshot ---');
  for (const line of diffLines) console.log(' ', line);

  const hasDrift = diffLines.length > 0 && diffLines[0] !== '(no changes)';

  if (checkMode) {
    console.log('');
    console.log(`mode: --check (no write). drift: ${hasDrift ? 'yes' : 'no'}`);
    process.exit(hasDrift ? 1 : 0);
  }

  await writeFile(SNAPSHOT_OUT, JSON.stringify(snapshot, null, 2) + '\n');

  console.log('');
  console.log('--- extracted ---');
  console.log('cc version           :', snapshot.ccVersion);
  console.log('cc build time        :', snapshot.ccBuildTime ?? '(unknown)');
  console.log('cc git sha           :', snapshot.ccGitSha?.slice(0, 12) ?? '(unknown)');
  console.log('anthropic-beta flags :', betaFlags.length);
  for (const f of betaFlags) console.log('  -', f);
  console.log('user-agent           :', headers['user-agent'], '(synthesized)');
  console.log('x-stainless headers  :', stainlessNames.length);
  for (const n of stainlessNames) {
    const v = stainlessHeaders[n];
    console.log(`  - ${n} = ${v === '' ? '<default empty>' : v}`);
  }
  console.log('');
  console.log('wrote :', SNAPSHOT_OUT);
};

main().catch((e) => {
  console.error('ERROR:', e.message);
  process.exitCode = 1;
});
