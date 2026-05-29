/**
 * Alert sink abstraction. Any monitor (billing drift, OAuth fail, 5xx burst)
 * sends through the same one-arg callable. Default sink is `noop`; production
 * wires in Discord (or Slack) by reading the webhook URL from env.
 *
 * Discord incoming webhook accepts `{ content: string }`. Slack accepts
 * `{ text: string }`. We default to Discord and provide Slack alongside for
 * operators who prefer it.
 */

import type { AlertStore } from './alerts-store.js';

const MAX_DISCORD_CONTENT_LENGTH = 1900;
const MAX_SLACK_TEXT_LENGTH = 3500;

export type AlertSink = (message: string) => Promise<void>;

const postJson = async (url: string, body: unknown): Promise<void> => {
  try {
    // Short-lived webhook POST — full-fetch wall-clock cap is correct here.
    // (See proxy/upstream.ts for the SSE exception that needs TTFB-only.)
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // Webhook flakiness must not propagate into the request path.
  }
};

export const createDiscordSink = (webhookUrl: string): AlertSink => {
  return async (message) => {
    const content = message.length > MAX_DISCORD_CONTENT_LENGTH
      ? `${message.slice(0, MAX_DISCORD_CONTENT_LENGTH - 1)}…`
      : message;
    await postJson(webhookUrl, { content });
  };
};

export const createSlackSink = (webhookUrl: string): AlertSink => {
  return async (message) => {
    const text = message.length > MAX_SLACK_TEXT_LENGTH
      ? `${message.slice(0, MAX_SLACK_TEXT_LENGTH - 1)}…`
      : message;
    await postJson(webhookUrl, { text });
  };
};

export const noopSink: AlertSink = async () => {};

/**
 * Dynamic sink — re-reads the webhook config on every send. Lets the operator
 * rotate the URL via the admin UI without restarting the proxy. Discord wins
 * when both URLs are set (matches the boot-time precedence).
 */
export const createDynamicSink = (store: AlertStore): AlertSink => {
  return async (message) => {
    const cfg = store.get();
    if (cfg.discordWebhookUrl) {
      const content =
        message.length > MAX_DISCORD_CONTENT_LENGTH
          ? `${message.slice(0, MAX_DISCORD_CONTENT_LENGTH - 1)}…`
          : message;
      await postJson(cfg.discordWebhookUrl, { content });
      return;
    }
    if (cfg.slackWebhookUrl) {
      const text =
        message.length > MAX_SLACK_TEXT_LENGTH
          ? `${message.slice(0, MAX_SLACK_TEXT_LENGTH - 1)}…`
          : message;
      await postJson(cfg.slackWebhookUrl, { text });
    }
  };
};

/** Wrap a sink with a per-instance cooldown to prevent message flooding. */
export const withCooldown = (sink: AlertSink, cooldownMs: number): AlertSink => {
  let lastAt = 0;
  return async (message) => {
    const now = Date.now();
    if (now - lastAt < cooldownMs) return;
    lastAt = now;
    await sink(message);
  };
};
