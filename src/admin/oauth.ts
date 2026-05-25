import type { Context } from 'hono';
import type { AccountPool } from '../auth/account-pool.js';
import { InvalidRequest } from '../lib/errors.js';

/**
 * POST /admin/oauth/replace
 *
 * Form-friendly endpoint to paste fresh OAuth tokens without redeploying.
 * Body (form-urlencoded or JSON):
 *   memberName   — optional, defaults to "default" (single-account mode)
 *   refreshToken — required, the long-lived token
 *   accessToken  — optional, omit to force a refresh on the next request
 *   expiresAt    — optional epoch ms, defaults to 0 (forces immediate refresh)
 *
 * On success: redirects back to /admin so the operator sees the new state.
 */

interface ReplacePayload {
  readonly memberName: string;
  readonly refreshToken: string;
  readonly accessToken: string;
  readonly expiresAt: number;
}

const parseFormOrJson = async (c: Context): Promise<Record<string, unknown>> => {
  const contentType = c.req.header('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return (await c.req.json()) as Record<string, unknown>;
  }
  const form = await c.req.formData();
  const out: Record<string, unknown> = {};
  form.forEach((value, key) => {
    out[key] = typeof value === 'string' ? value : '';
  });
  return out;
};

const asString = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const REFRESH_PREFIX = 'sk-ant-ort01-';
const ACCESS_PREFIX = 'sk-ant-oat01-';

const validate = (raw: Record<string, unknown>): ReplacePayload => {
  const refreshToken = asString(raw.refreshToken);
  if (refreshToken.length === 0) {
    throw InvalidRequest('refreshToken is required');
  }
  if (!refreshToken.startsWith(REFRESH_PREFIX)) {
    // Catches the common mistake of pasting an access token into the
    // refresh field — would otherwise surface as a confusing 502 on the
    // next /v1/messages call.
    throw InvalidRequest(`refreshToken must start with "${REFRESH_PREFIX}"`);
  }
  if (refreshToken.length < 32) {
    throw InvalidRequest('refreshToken looks too short (<32 chars)');
  }
  const memberName = asString(raw.memberName) || 'default';
  const accessToken = asString(raw.accessToken);
  if (accessToken.length > 0 && !accessToken.startsWith(ACCESS_PREFIX)) {
    throw InvalidRequest(`accessToken must start with "${ACCESS_PREFIX}" if provided`);
  }
  const expiresAtRaw = asString(raw.expiresAt);
  const expiresAt = expiresAtRaw.length > 0 ? Number(expiresAtRaw) : 0;
  if (!Number.isFinite(expiresAt) || expiresAt < 0) {
    throw InvalidRequest('expiresAt must be a non-negative number');
  }
  return { memberName, refreshToken, accessToken, expiresAt };
};

export const createOAuthReplaceHandler =
  (pool: AccountPool) =>
  async (c: Context): Promise<Response> => {
    const raw = await parseFormOrJson(c).catch(() => null);
    if (!raw) {
      throw InvalidRequest('invalid request body');
    }
    const payload = validate(raw);

    await pool.replaceOAuth(payload.memberName, {
      accessToken: payload.accessToken,
      refreshToken: payload.refreshToken,
      expiresAt: payload.expiresAt,
    });

    // Form-friendly: redirect back to /admin so the operator sees updated state.
    return c.redirect('/admin');
  };
