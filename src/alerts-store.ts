import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Mutable webhook URL store. Env vars provide the boot baseline; the operator
 * can override at runtime via the admin UI (writes to filePath atomically).
 * Alert sinks read getter at call time so updates take effect immediately
 * without restart.
 */

export interface AlertConfig {
  readonly discordWebhookUrl: string | null;
  readonly slackWebhookUrl: string | null;
}

export interface AlertStore {
  get(): AlertConfig;
  setDiscord(url: string | null): Promise<void>;
  setSlack(url: string | null): Promise<void>;
}

interface PersistedFile {
  readonly discordWebhookUrl?: string | null;
  readonly slackWebhookUrl?: string | null;
}

const loadFile = async (path: string): Promise<PersistedFile | null> => {
  if (!existsSync(path)) return null;
  try {
    const text = await readFile(path, 'utf8');
    const parsed = JSON.parse(text) as PersistedFile;
    return parsed;
  } catch {
    return null;
  }
};

const writeAtomic = async (path: string, data: PersistedFile): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await rename(tmp, path);
};

const normalize = (url: string | null | undefined): string | null => {
  if (url === undefined || url === null) return null;
  const trimmed = url.trim();
  return trimmed.length === 0 ? null : trimmed;
};

export interface CreateAlertStoreParams {
  readonly filePath: string;
  readonly envDiscord: string | null;
  readonly envSlack: string | null;
}

export const createAlertStore = async (
  params: CreateAlertStoreParams,
): Promise<AlertStore> => {
  const fileState = await loadFile(params.filePath);
  // File overrides env when present — runtime mutations should outlive a
  // rebuild that re-injects the original env baseline.
  let current: AlertConfig = Object.freeze({
    discordWebhookUrl:
      normalize(fileState?.discordWebhookUrl) ?? normalize(params.envDiscord),
    slackWebhookUrl:
      normalize(fileState?.slackWebhookUrl) ?? normalize(params.envSlack),
  });

  const persist = async (next: AlertConfig): Promise<void> => {
    current = Object.freeze(next);
    await writeAtomic(params.filePath, {
      discordWebhookUrl: next.discordWebhookUrl,
      slackWebhookUrl: next.slackWebhookUrl,
    });
  };

  return Object.freeze({
    get: () => current,
    async setDiscord(url: string | null): Promise<void> {
      await persist({ ...current, discordWebhookUrl: normalize(url) });
    },
    async setSlack(url: string | null): Promise<void> {
      await persist({ ...current, slackWebhookUrl: normalize(url) });
    },
  });
};
