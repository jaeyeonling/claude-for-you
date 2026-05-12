/**
 * Phase 21 — best-effort account identity learning.
 *
 * Anthropic responses carry `anthropic-organization-id` (UUID). We cache
 * the most recent value seen and inject it into outbound body's
 * `metadata.user_id.account_uuid` when the client left it blank (the API-key
 * mode default). This pulls a captured fingerprint axis from "" (constant)
 * to a stable real UUID — closer to what CC's OAuth mode would emit.
 *
 * Caveat: organization-id is not strictly the same as the account_uuid CC
 * sends. It is, however, a stable identifier tied to the subscription and
 * good enough to avoid the "all proxy users share account_uuid='' fingerprint"
 * giveaway. A real-OAuth capture would let us replace this with the exact
 * value if/when an operator runs one.
 */

const ORG_HEADER = 'anthropic-organization-id';

// Endpoints CC binary references in its strings table. Tried in order at
// startup with our OAuth bearer to discover account_uuid more precisely than
// organization-id can. Any 200 response with an account-shaped field wins.
const BOOTSTRAP_CANDIDATES: readonly string[] = [
  'https://api.anthropic.com/api/claude_cli/bootstrap',
  'https://api.anthropic.com/api/claude_cli_profile',
];

export type AccountLearner = Readonly<{
  observe(headers: Headers): void;
  current(): string | null;
  override(uuid: string): void;
  bootstrap(accessToken: string): Promise<string | null>;
}>;

const extractAccountField = (data: unknown): string | null => {
  if (!data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;
  const candidates = [
    obj.account_uuid,
    obj.account_id,
    (obj.account as Record<string, unknown> | undefined)?.uuid,
    (obj.account as Record<string, unknown> | undefined)?.id,
    obj.user_id,
    (obj.user as Record<string, unknown> | undefined)?.uuid,
    (obj.user as Record<string, unknown> | undefined)?.id,
    obj.id,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
  }
  return null;
};

export const createAccountLearner = (initial?: string | null): AccountLearner => {
  let current: string | null = initial ?? null;

  return Object.freeze({
    observe(headers: Headers): void {
      const v = headers.get(ORG_HEADER);
      if (v && v.length > 0 && v !== current) {
        current = v;
      }
    },
    current(): string | null {
      return current;
    },
    override(uuid: string): void {
      // Operator can force a known-good value via env (overrides learning).
      if (uuid.length > 0) current = uuid;
    },
    async bootstrap(accessToken: string): Promise<string | null> {
      for (const url of BOOTSTRAP_CANDIDATES) {
        try {
          const res = await fetch(url, {
            method: 'GET',
            headers: { authorization: `Bearer ${accessToken}` },
            signal: AbortSignal.timeout(8_000),
          });
          if (!res.ok) continue;
          const data = await res.json().catch(() => null);
          const uuid = extractAccountField(data);
          if (uuid) {
            current = uuid;
            return uuid;
          }
        } catch {
          // network / shape mismatch — try the next candidate, then fall back
        }
      }
      return null;
    },
  });
};
