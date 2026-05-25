import { ConfigError } from './lib/errors.js';

export type ApiKeyEntry = Readonly<{ name: string; key: string }>;

export type AppConfig = Readonly<{
  port: number;
  host: string;
  oauth: Readonly<{
    refreshToken: string;
    accessToken: string | null;
    expiresAt: number | null;
  }>;
  tokenStorePath: string;
  apiKeys: readonly ApiKeyEntry[];
  apiKeysFilePath: string | null;
  dailyTokenLimitPerKey: number;
  databaseUrl: string | null;
  globalSubscriptionThresholdTokens: number;
  maxConcurrentRequests: number;
  /** Per-IP rate limit (requests/sec). 0 = disabled. */
  perIpRateLimitPerSecond: number;
  pacingMinGapMs: number;
  accountUuidOverride: string | null;
  accountsPath: string;
  canaryPercent: number;
  discordWebhookUrl: string | null;
  slackWebhookUrl: string | null;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}>;

const required = (name: string, value: string | undefined): string => {
  if (!value || value.length === 0) {
    throw ConfigError(`Missing required env var: ${name}`);
  }
  return value;
};

const parseApiKeys = (raw: string | undefined): readonly ApiKeyEntry[] => {
  if (!raw) return [];
  return raw
    .split(',')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const idx = pair.indexOf(':');
      if (idx < 0) throw ConfigError(`API_KEYS entry malformed (expected name:key): ${pair}`);
      const name = pair.slice(0, idx).trim();
      const key = pair.slice(idx + 1).trim();
      if (key.length < 16) throw ConfigError(`API_KEYS key for "${name}" too short (<16 chars)`);
      return { name, key } as const;
    });
};

const parseLogLevel = (raw: string | undefined): AppConfig['logLevel'] => {
  const v = (raw ?? 'info').toLowerCase();
  if (v === 'debug' || v === 'info' || v === 'warn' || v === 'error') return v;
  throw ConfigError(`Invalid LOG_LEVEL: ${raw}`);
};

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): AppConfig => {
  const apiKeysFilePath =
    env.API_KEYS_PATH && env.API_KEYS_PATH.length > 0 ? env.API_KEYS_PATH : null;
  const apiKeys = parseApiKeys(env.API_KEYS);
  // If the operator runs in file-only mode (no env keys), boot is fine —
  // the store loads from file. If neither source provides a key, boot fails
  // later when the store is empty.
  if (apiKeys.length === 0 && !apiKeysFilePath) {
    throw ConfigError('Provide API_KEYS env or API_KEYS_PATH (file-based store)');
  }

  return Object.freeze({
    port: Number(env.PORT ?? 3456),
    host: env.HOST ?? '127.0.0.1',
    oauth: Object.freeze({
      // Optional when ACCOUNTS_PATH points at a valid accounts.json (multi-
      // account mode). Validated by server.ts at startup.
      refreshToken: env.ANTHROPIC_OAUTH_REFRESH_TOKEN ?? '',
      accessToken: env.ANTHROPIC_OAUTH_ACCESS_TOKEN ?? null,
      expiresAt: env.ANTHROPIC_OAUTH_EXPIRES_AT ? Number(env.ANTHROPIC_OAUTH_EXPIRES_AT) : null,
    }),
    tokenStorePath: env.TOKEN_STORE_PATH ?? './data/tokens.json',
    apiKeys,
    apiKeysFilePath,
    dailyTokenLimitPerKey: Number(env.DAILY_TOKEN_LIMIT_PER_KEY ?? 0),
    databaseUrl: env.DATABASE_URL && env.DATABASE_URL.length > 0 ? env.DATABASE_URL : null,
    globalSubscriptionThresholdTokens: Number(env.GLOBAL_SUBSCRIPTION_THRESHOLD_TOKENS ?? 0),
    maxConcurrentRequests: Number(env.MAX_CONCURRENT_REQUESTS ?? 8),
    perIpRateLimitPerSecond: Number(env.PER_IP_RATE_LIMIT_PER_SECOND ?? 0),
    pacingMinGapMs: Number(env.PACING_MIN_GAP_MS ?? 0),
    accountUuidOverride:
      env.ACCOUNT_UUID_OVERRIDE && env.ACCOUNT_UUID_OVERRIDE.length > 0
        ? env.ACCOUNT_UUID_OVERRIDE
        : null,
    canaryPercent: Number(env.CANARY_PERCENT ?? 0),
    accountsPath: env.ACCOUNTS_PATH ?? './data/accounts.json',
    discordWebhookUrl:
      env.DISCORD_WEBHOOK_URL && env.DISCORD_WEBHOOK_URL.length > 0
        ? env.DISCORD_WEBHOOK_URL
        : null,
    slackWebhookUrl:
      env.SLACK_WEBHOOK_URL && env.SLACK_WEBHOOK_URL.length > 0
        ? env.SLACK_WEBHOOK_URL
        : null,
    logLevel: parseLogLevel(env.LOG_LEVEL),
  });
};
