import { redact } from './redact.js';

/**
 * Minimal structured logger.
 *
 * - JSON output by default (one line per record, parseable by Loki, jq, etc.)
 * - Pretty mode for local dev (LOG_PRETTY=true)
 * - Every message goes through redact() so token-shaped strings never reach
 *   stdout/stderr/log aggregators.
 * - Level filter via process.env.LOG_LEVEL. The default is `info`.
 *
 * Why not pino?
 *   pino is great but ~150KB + transitive deps; this proxy ships ~80KB of
 *   first-party code. The native console + structured records is enough for
 *   trusted-few traffic, and keeps the dependency tree small.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Readonly<Record<LogLevel, number>> = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
});

export interface Logger {
  debug(message: string, ctx?: Record<string, unknown>): void;
  info(message: string, ctx?: Record<string, unknown>): void;
  warn(message: string, ctx?: Record<string, unknown>): void;
  error(message: string, ctx?: Record<string, unknown>): void;
}

export interface LoggerParams {
  readonly level: LogLevel;
  readonly pretty: boolean;
}

const stringifySafe = (value: unknown): string => {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
};

export const createLogger = (params: LoggerParams): Logger => {
  const threshold = LEVELS[params.level];

  const emit = (level: LogLevel, message: string, ctx?: Record<string, unknown>): void => {
    if (LEVELS[level] < threshold) return;
    const time = new Date().toISOString();
    const safeMessage = redact(message);
    const stream: NodeJS.WriteStream =
      level === 'error' || level === 'warn' ? process.stderr : process.stdout;

    if (params.pretty) {
      const ctxStr =
        ctx && Object.keys(ctx).length > 0 ? ` ${redact(stringifySafe(ctx))}` : '';
      stream.write(`${time} [${level}] ${safeMessage}${ctxStr}\n`);
      return;
    }

    const record: Record<string, unknown> = {
      time,
      level,
      msg: safeMessage,
    };
    if (ctx && Object.keys(ctx).length > 0) {
      // Stringify-then-parse to apply redact to nested string fields.
      record.ctx = JSON.parse(redact(stringifySafe(ctx))) as Record<string, unknown>;
    }
    stream.write(`${JSON.stringify(record)}\n`);
  };

  return Object.freeze({
    debug: (m: string, c?: Record<string, unknown>) => emit('debug', m, c),
    info: (m: string, c?: Record<string, unknown>) => emit('info', m, c),
    warn: (m: string, c?: Record<string, unknown>) => emit('warn', m, c),
    error: (m: string, c?: Record<string, unknown>) => emit('error', m, c),
  });
};

// ---------- Module-level default ----------
// Lazy-initialized so `import { log } from '../lib/logger'` works at the top
// of every file without forcing init order. server.ts calls `setLogger()`
// once at boot with config-driven params.

const fallbackLogger: Logger = createLogger({ level: 'info', pretty: true });
let active: Logger = fallbackLogger;

export const setLogger = (l: Logger): void => {
  active = l;
};

export const log: Logger = Object.freeze({
  debug: (m: string, c?: Record<string, unknown>) => active.debug(m, c),
  info: (m: string, c?: Record<string, unknown>) => active.info(m, c),
  warn: (m: string, c?: Record<string, unknown>) => active.warn(m, c),
  error: (m: string, c?: Record<string, unknown>) => active.error(m, c),
});
