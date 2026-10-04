import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AccountLearner } from '../account-learner.js';
import { ConfigError } from '../lib/errors.js';
import { log } from '../lib/logger.js';
import { redact } from '../lib/redact.js';
import type { ApplyInput, ClaudeTemplate, OutboundRequest } from './types.js';

// Real CC v2.1.145 POSTs to /v1/messages?beta=true on every request (verified
// 2026-05-29 via mitmproxy capture). The `?beta=true` query parameter is the
// upstream's gate for ALL anthropic-beta features — including `context-1m-*`.
// Without it, 1M requests are deterministically rejected with HTTP 429
// "Usage credits are required for long context requests" (a misleading error
// — it's a URL/flag misconfiguration, not a billing issue). Standard 200K
// traffic happens to work without `?beta=true` because beta gating only kicks
// in for flagged features. Treat the query param as part of the URL, not a
// toggle. See docs/operational-pitfalls.md #12 for the 36-hour misdiagnosis.
const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages?beta=true';
const SUPPORTED_SCHEMA_VERSION = 2;
const SNAPSHOT_AGE_WARN_DAYS = 60;

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SNAPSHOT_PATH = join(__dirname, 'cc-snapshot.json');
const CANDIDATE_SNAPSHOT_PATH = join(__dirname, 'cc-snapshot.candidate.json');

// Transport-layer / hop-by-hop headers — the HTTP stack recomputes them per
// request. Including them in our output map would either be no-op (host) or
// actively wrong (content-length).
const TRANSPORT: ReadonlySet<string> = new Set([
  'host',
  'content-length',
  'accept-encoding',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
]);

interface HeaderValue {
  readonly name: string;
  readonly value: string;
}

export interface SnapshotPacing {
  readonly samples: number;
  readonly minMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
}

interface SnapshotV2 {
  readonly schemaVersion: number;
  readonly extractedAt: string;
  readonly capturedCount: number;
  readonly capturedFrom?: string;
  readonly capturedTo?: string;
  readonly headerOrder: readonly string[];
  readonly headerValues: readonly HeaderValue[];
  readonly bodyKeyOrder: readonly string[];
  readonly pacing?: SnapshotPacing | null;
}

export interface ExtractedTemplateDeps {
  readonly accountLearner?: AccountLearner;
  /** Override snapshot file path. Defaults to `cc-snapshot.json`. */
  readonly snapshotPath?: string;
}

const loadSnapshot = (path: string): SnapshotV2 => {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    throw ConfigError(
      `snapshot not found at ${path}. Run \`bun run synthesize-snapshot\` after capturing live CC traffic.`,
    );
  }
  let parsed: SnapshotV2;
  try {
    parsed = JSON.parse(raw) as SnapshotV2;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw ConfigError(redact(`snapshot malformed (${path}): ${msg}`));
  }
  if (parsed.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    throw ConfigError(
      `snapshot schemaVersion ${parsed.schemaVersion} not supported (expected ${SUPPORTED_SCHEMA_VERSION}). Re-run synthesize-snapshot.`,
    );
  }
  if (!Array.isArray(parsed.headerOrder) || !Array.isArray(parsed.headerValues)) {
    throw ConfigError(`snapshot (${path}) missing headerOrder or headerValues`);
  }
  return parsed;
};

// Beta flags the gateway cannot honor because upstream auth is Claude.ai OAuth.
// EMPTY as of 2026-05-29 — the earlier `context-1m-` entry was a misdiagnosis.
// Real CC's `[1m]` model variant sends `context-1m-2025-08-07` over OAuth and
// upstream accepts it (verified by capturing CC v2.1.145 against a Pro/Max
// account). The 429s we attributed to OAuth entitlement were actually caused
// by our URL omitting `?beta=true` (see ANTHROPIC_MESSAGES_URL above). Keep
// the helper plumbing in place so future genuinely OAuth-incompatible betas
// can be added by appending a prefix here — but verify with an upstream-direct
// capture first, don't speculate.
const OAUTH_INCOMPATIBLE_BETA_PREFIXES: readonly string[] = [];

const isOAuthIncompatibleBeta = (flag: string): boolean =>
  OAUTH_INCOMPATIBLE_BETA_PREFIXES.some((p) => flag.startsWith(p));

/**
 * Pure merge+filter used by `mergeAnthropicBeta`. Exported for tests so the
 * strip rule can be exercised without loading a snapshot.
 */
export const mergeAndFilterAnthropicBeta = (
  baseValue: string,
  clientValue: string,
): { value: string; stripped: readonly string[] } => {
  const flags = new Set<string>();
  for (const f of baseValue.split(',').map((s) => s.trim())) if (f) flags.add(f);
  for (const f of clientValue.split(',').map((s) => s.trim())) if (f) flags.add(f);

  const stripped: string[] = [];
  for (const f of [...flags]) {
    if (isOAuthIncompatibleBeta(f)) {
      flags.delete(f);
      stripped.push(f);
    }
  }
  return { value: [...flags].join(','), stripped };
};

const mergeAnthropicBeta = (baseValue: string, clientHeaders: Headers | undefined): string => {
  const clientRaw = clientHeaders?.get('anthropic-beta') ?? '';
  const { value, stripped } = mergeAndFilterAnthropicBeta(baseValue, clientRaw);
  if (stripped.length > 0) {
    log.info(
      `[template] stripped OAuth-incompatible anthropic-beta flag(s): ${stripped.join(',')} ` +
        `(gateway has no Console-API entitlement; request downgraded to 200K window)`,
    );
  }
  return value;
};

/**
 * #163 — forward a real Claude Code client's `user-agent` when it is NEWER
 * than the snapshot's; otherwise replay the snapshot's.
 *
 * Why: upstream gates each model family on the CC version in this header
 * (as of 2026-10: claude-opus-5-5 → ≥2.1.280, claude-fable-5-1 → ≥2.1.251).
 * Replaying a fixed snapshot value gated every user on *our* capture age,
 * not their CLI (#160). Verified 2026-10-04 that upstream tolerates a UA
 * newer than the rest of the replayed fingerprint (2.1.400 UA + 2.1.288
 * beta/stainless set → 200 standard) and ignores the `cli`/`sdk-cli`
 * suffix — see #163 for the matrix.
 *
 * Policy, and what is deliberately NOT forwarded:
 *  - SDK-direct / cc-maxed / absent UAs → snapshot. Looking like CC for them
 *    is the template's whole job.
 *  - A claude-cli UA OLDER than the snapshot → snapshot. The user is never
 *    worse off than before this change, and extreme values (`0.0.1`) can't
 *    skew the shared account's fingerprint.
 *  - Anything not matching the strict shape below (pre-release tags, extra
 *    parentheticals, non-ASCII, control chars) → snapshot, with one warn per
 *    distinct value so a future CC UA format change is visible in logs
 *    instead of silently re-introducing the #160 gate.
 * CR/LF is additionally impossible here: the Fetch `Headers` API rejects it
 * before this code runs.
 */
const CLAUDE_CLI_UA =
  /^claude-cli\/(\d{1,4})\.(\d{1,4})\.(\d{1,4})(?: \([A-Za-z0-9 ,._:+/-]{1,60}\))?$/;
// Generous pre-check so the regex never sees pathological input. Real values
// are ~40 chars (`claude-cli/2.1.288 (external, sdk-cli)`).
const MAX_FORWARDED_UA_LENGTH = 120;
const MAX_WARNED_UA_SHAPES = 50;
const warnedUaShapes = new Set<string>();

type CliVersion = readonly [number, number, number];

const parseClaudeCliUa = (ua: string): CliVersion | null => {
  const m = CLAUDE_CLI_UA.exec(ua);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};

const compareVersions = (a: CliVersion, b: CliVersion): number =>
  a[0] !== b[0] ? a[0] - b[0] : a[1] !== b[1] ? a[1] - b[1] : a[2] - b[2];

const warnUnrecognizedCliUa = (ua: string): void => {
  if (warnedUaShapes.has(ua) || warnedUaShapes.size >= MAX_WARNED_UA_SHAPES) return;
  warnedUaShapes.add(ua);
  log.warn(
    `[template] claude-cli user-agent not forwarded (unrecognized shape, replaying snapshot): ${JSON.stringify(ua.slice(0, MAX_FORWARDED_UA_LENGTH))}`,
  );
};

export const resolveUserAgent = (
  snapshotUserAgent: string,
  clientHeaders: Headers | undefined,
): string => {
  const fromClient = clientHeaders?.get('user-agent');
  if (!fromClient || !fromClient.startsWith('claude-cli/')) return snapshotUserAgent;

  const clientVersion =
    fromClient.length <= MAX_FORWARDED_UA_LENGTH ? parseClaudeCliUa(fromClient) : null;
  if (clientVersion === null) {
    warnUnrecognizedCliUa(fromClient);
    return snapshotUserAgent;
  }

  // An unparseable snapshot UA (hand-edited snapshot?) can't be compared —
  // forward the well-formed client value rather than replay something odd.
  const snapshotVersion = parseClaudeCliUa(snapshotUserAgent);
  if (snapshotVersion === null) return fromClient;

  return compareVersions(clientVersion, snapshotVersion) > 0 ? fromClient : snapshotUserAgent;
};

const buildHeaders = (
  snapshot: SnapshotV2,
  valueByHeader: ReadonlyMap<string, string>,
  accessToken: string,
  clientHeaders: Headers | undefined,
): Record<string, string> => {
  const out: Record<string, string> = {};
  let authSlotFilled = false;

  for (const name of snapshot.headerOrder) {
    if (TRANSPORT.has(name)) continue;

    if (name === 'x-api-key' || name === 'authorization') {
      if (!authSlotFilled) {
        out.authorization = `Bearer ${accessToken}`;
        authSlotFilled = true;
      }
      continue;
    }

    if (name === 'x-claude-code-session-id') {
      const fromClient = clientHeaders?.get('x-claude-code-session-id');
      out['x-claude-code-session-id'] =
        fromClient && fromClient.length > 0 ? fromClient : randomUUID();
      continue;
    }

    if (name === 'anthropic-beta') {
      out['anthropic-beta'] = mergeAnthropicBeta(
        valueByHeader.get('anthropic-beta') ?? '',
        clientHeaders,
      );
      continue;
    }

    if (name === 'user-agent') {
      const ua = resolveUserAgent(valueByHeader.get('user-agent') ?? '', clientHeaders);
      if (ua.length > 0) out['user-agent'] = ua;
      continue;
    }

    const val = valueByHeader.get(name);
    if (val !== undefined) out[name] = val;
  }

  if (!authSlotFilled) out.authorization = `Bearer ${accessToken}`;
  if (!('content-type' in out)) out['content-type'] = 'application/json';

  return out;
};

const enrichAccountUuid = (clientBody: unknown, accountUuid: string | null): unknown => {
  if (!accountUuid) return clientBody;
  if (typeof clientBody !== 'object' || clientBody === null || Array.isArray(clientBody)) {
    return clientBody;
  }
  const body = clientBody as Record<string, unknown>;
  const meta = body.metadata;
  if (typeof meta !== 'object' || meta === null) return clientBody;
  const m = meta as Record<string, unknown>;
  if (typeof m.user_id !== 'string') return clientBody;

  try {
    const userIdObj = JSON.parse(m.user_id) as Record<string, unknown>;
    const existing = userIdObj.account_uuid;
    if (typeof existing === 'string' && existing.length > 0) return clientBody;
    const next = { ...userIdObj, account_uuid: accountUuid };
    return {
      ...body,
      metadata: { ...m, user_id: JSON.stringify(next) },
    };
  } catch {
    return clientBody;
  }
};

const reorderBody = (snapshot: SnapshotV2, clientBody: unknown): unknown => {
  if (typeof clientBody !== 'object' || clientBody === null || Array.isArray(clientBody)) {
    return clientBody;
  }
  const obj = clientBody as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of snapshot.bodyKeyOrder) {
    if (k in obj) out[k] = obj[k];
  }
  for (const k of Object.keys(obj)) {
    if (!(k in out)) out[k] = obj[k];
  }
  return out;
};

const warnIfStale = (snapshot: SnapshotV2, label: string): void => {
  const ageDays = Math.floor((Date.now() - new Date(snapshot.extractedAt).getTime()) / 86_400_000);
  if (ageDays > SNAPSHOT_AGE_WARN_DAYS) {
    log.warn(
      `[template] WARNING: ${label} snapshot is ${ageDays} days old. ` +
        `Re-capture with CAPTURE_MODE then \`bun run synthesize-snapshot\`.`,
    );
  }
};

export const createExtractedTemplate = (deps?: ExtractedTemplateDeps): ClaudeTemplate => {
  const path = deps?.snapshotPath ?? DEFAULT_SNAPSHOT_PATH;
  const snapshot = loadSnapshot(path);
  const valueByHeader = new Map<string, string>(
    snapshot.headerValues.map((h) => [h.name, h.value]),
  );
  const label =
    path === DEFAULT_SNAPSHOT_PATH
      ? 'stable'
      : path === CANDIDATE_SNAPSHOT_PATH
        ? 'candidate'
        : path;
  warnIfStale(snapshot, label);

  return Object.freeze({
    source: 'extracted',
    description: `cc-snapshot/v2 [${label}] (${snapshot.capturedCount} captures, extracted ${snapshot.extractedAt.slice(0, 10)})`,

    apply: async ({
      clientBody,
      accessToken,
      clientHeaders,
    }: ApplyInput): Promise<OutboundRequest> => {
      const accountUuid = deps?.accountLearner?.current() ?? null;
      const enrichedBody = enrichAccountUuid(clientBody, accountUuid);
      const orderedBody = reorderBody(snapshot, enrichedBody);
      const body = JSON.stringify(orderedBody);
      return {
        url: ANTHROPIC_MESSAGES_URL,
        method: 'POST',
        headers: buildHeaders(snapshot, valueByHeader, accessToken, clientHeaders),
        body,
      };
    },
  });
};

/** Returns a candidate template if `cc-snapshot.candidate.json` exists,
 *  otherwise null. Used by canary deploy. */
export const tryCreateCandidateTemplate = (
  deps?: Omit<ExtractedTemplateDeps, 'snapshotPath'>,
): ClaudeTemplate | null => {
  try {
    return createExtractedTemplate({ ...deps, snapshotPath: CANDIDATE_SNAPSHOT_PATH });
  } catch {
    return null;
  }
};

/** Recommended minGapMs from live captures (p50). */
export const recommendedMinGapMs = (): number | null => {
  try {
    const snap = loadSnapshot(DEFAULT_SNAPSHOT_PATH);
    return snap.pacing?.p50Ms ?? null;
  } catch {
    return null;
  }
};
