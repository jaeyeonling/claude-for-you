import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { createLogger } from '../src/lib/logger.js';

type Captured = { level: string; msg: string; ctx?: Record<string, unknown> };

const captureStreams = (): { records: Captured[]; restore: () => void } => {
  const original = {
    stdout: process.stdout.write.bind(process.stdout) as typeof process.stdout.write,
    stderr: process.stderr.write.bind(process.stderr) as typeof process.stderr.write,
  };
  const records: Captured[] = [];
  const collect = (chunk: string | Uint8Array): boolean => {
    const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    for (const line of text.split('\n').filter(Boolean)) {
      try {
        records.push(JSON.parse(line) as Captured);
      } catch {
        // Pretty mode — capture raw text under a synthetic record.
        records.push({ level: 'raw', msg: line });
      }
    }
    return true;
  };
  process.stdout.write = collect as typeof process.stdout.write;
  process.stderr.write = collect as typeof process.stderr.write;
  return {
    records,
    restore: () => {
      process.stdout.write = original.stdout;
      process.stderr.write = original.stderr;
    },
  };
};

let captured: ReturnType<typeof captureStreams>;
beforeEach(() => {
  captured = captureStreams();
});
afterEach(() => {
  captured.restore();
});

describe('createLogger', () => {
  test('JSON output by default — one record per log call', () => {
    const log = createLogger({ level: 'debug', pretty: false });
    log.info('hello');
    log.warn('careful');
    expect(captured.records.map((r) => r.msg)).toEqual(['hello', 'careful']);
  });

  test('level filter suppresses below-threshold records', () => {
    const log = createLogger({ level: 'warn', pretty: false });
    log.debug('quiet');
    log.info('quiet');
    log.warn('loud');
    log.error('louder');
    expect(captured.records.map((r) => r.msg)).toEqual(['loud', 'louder']);
  });

  test('redacts token-shaped strings before write', () => {
    const log = createLogger({ level: 'debug', pretty: false });
    log.error('refresh failed: sk-ant-ort01-abcdef0123456789abcdef0123');
    const record = captured.records[0];
    expect(record?.msg).toContain('[REDACTED]');
    expect(record?.msg).not.toContain('sk-ant-ort01');
  });

  test('redacts inside ctx field too', () => {
    const log = createLogger({ level: 'debug', pretty: false });
    log.info('user request', { authHeader: 'Bearer sk-ant-oat01-secrethere1234567890abcd' });
    const record = captured.records[0];
    const ctx = record?.ctx ?? {};
    expect(JSON.stringify(ctx)).toContain('[REDACTED]');
    expect(JSON.stringify(ctx)).not.toContain('sk-ant-oat01');
  });

  test('error level writes to stderr, info to stdout', () => {
    // We use a tagged collector to know which stream a write came from.
    captured.restore();
    let toStdout = 0;
    let toStderr = 0;
    const origOut = process.stdout.write.bind(process.stdout) as typeof process.stdout.write;
    const origErr = process.stderr.write.bind(process.stderr) as typeof process.stderr.write;
    process.stdout.write = (() => {
      toStdout += 1;
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = (() => {
      toStderr += 1;
      return true;
    }) as typeof process.stderr.write;
    try {
      const log = createLogger({ level: 'debug', pretty: false });
      log.info('a');
      log.error('b');
      log.debug('c');
    } finally {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    }
    expect(toStdout).toBe(2); // info + debug
    expect(toStderr).toBe(1); // error
  });
});
