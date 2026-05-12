import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AccountLearner } from '../account-learner.js';
import { ConfigError } from '../lib/errors.js';
import type { ApplyInput, ClaudeTemplate, OutboundRequest } from './types.js';

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
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
    throw ConfigError(`snapshot malformed (${path}): ${msg}`);
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

const mergeAnthropicBeta = (baseValue: string, clientHeaders: Headers | undefined): string => {
  const clientRaw = clientHeaders?.get('anthropic-beta') ?? '';
  if (clientRaw.length === 0) return baseValue;
  const flags = new Set<string>();
  for (const f of baseValue.split(',').map((s) => s.trim())) if (f) flags.add(f);
  for (const f of clientRaw.split(',').map((s) => s.trim())) if (f) flags.add(f);
  return [...flags].join(',');
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
    console.warn(
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
