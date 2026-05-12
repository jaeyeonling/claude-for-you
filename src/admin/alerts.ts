import type { Context } from 'hono';
import type { AlertStore } from '../alerts-store.js';
import { InvalidRequest } from '../lib/errors.js';

/**
 * POST /admin/alerts/discord
 * POST /admin/alerts/slack
 *
 * Form-friendly endpoints to rotate webhook URLs. Body field `url`:
 *   - non-empty string → store the URL (validated against known prefixes)
 *   - empty string     → clear the URL (alerts fall back to the other channel)
 */

const DISCORD_PREFIX = 'https://discord.com/api/webhooks/';
const DISCORD_PTB_PREFIX = 'https://ptb.discord.com/api/webhooks/';
const DISCORD_CANARY_PREFIX = 'https://canary.discord.com/api/webhooks/';
const SLACK_PREFIX = 'https://hooks.slack.com/';

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

const readUrlField = (raw: Record<string, unknown>): string => {
  const value = raw.url;
  if (typeof value !== 'string') {
    throw InvalidRequest('url field must be a string');
  }
  return value.trim();
};

const validateDiscord = (url: string): void => {
  if (url.length === 0) return;
  if (
    !url.startsWith(DISCORD_PREFIX) &&
    !url.startsWith(DISCORD_PTB_PREFIX) &&
    !url.startsWith(DISCORD_CANARY_PREFIX)
  ) {
    throw InvalidRequest('Discord webhook must start with https://discord.com/api/webhooks/');
  }
};

const validateSlack = (url: string): void => {
  if (url.length === 0) return;
  if (!url.startsWith(SLACK_PREFIX)) {
    throw InvalidRequest('Slack webhook must start with https://hooks.slack.com/');
  }
};

export const createAlertsHandlers = (store: AlertStore) => {
  const setDiscord = async (c: Context): Promise<Response> => {
    const raw = await parseFormOrJson(c).catch(() => null);
    if (!raw) throw InvalidRequest('invalid request body');
    const url = readUrlField(raw);
    validateDiscord(url);
    await store.setDiscord(url.length > 0 ? url : null);
    return c.redirect('/admin');
  };

  const setSlack = async (c: Context): Promise<Response> => {
    const raw = await parseFormOrJson(c).catch(() => null);
    if (!raw) throw InvalidRequest('invalid request body');
    const url = readUrlField(raw);
    validateSlack(url);
    await store.setSlack(url.length > 0 ? url : null);
    return c.redirect('/admin');
  };

  return { setDiscord, setSlack };
};
