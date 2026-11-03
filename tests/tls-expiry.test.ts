import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:tls';
import { createTlsExpiryWatch, fetchCertNotAfter } from '../src/tls-expiry.js';

const H = 60 * 60 * 1000;
const NOW = Date.parse('2026-11-03T00:00:00Z');

const collectSink = () => {
  const messages: string[] = [];
  return { messages, sink: async (m: string) => void messages.push(m) };
};

/** A check that returns notAfter = NOW + hoursLeft, or throws. */
const scripted = (steps: Array<number | Error>) => {
  let i = 0;
  return async (): Promise<number> => {
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    if (step instanceof Error) throw step;
    return NOW + step * H;
  };
};

const makeWatch = (steps: Array<number | Error>) => {
  const { messages, sink } = collectSink();
  const watch = createTlsExpiryWatch({ host: '203.0.113.7', sink, check: scripted(steps), now: () => NOW });
  return { messages, watch };
};

describe('createTlsExpiryWatch', () => {
  test('plenty of validity left → quiet', async () => {
    const { messages, watch } = makeWatch([150]);
    await watch.tick();
    expect(messages).toHaveLength(0);
  });

  test('under 48h left → one alert naming host and hours left', async () => {
    const { messages, watch } = makeWatch([30]);
    await watch.tick();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('[tls]');
    expect(messages[0]).toContain('203.0.113.7');
    expect(messages[0]).toContain('30h');
  });

  test('stays quiet while still expiring, re-arms after renewal', async () => {
    const { messages, watch } = makeWatch([30, 20, 10, 150, 30]);
    for (let i = 0; i < 5; i += 1) await watch.tick();
    expect(messages).toHaveLength(2); // 30 → alert, 20/10 quiet, 150 renewed, 30 → alert again
  });

  test('a single failed check is not an alert (transient)', async () => {
    const { messages, watch } = makeWatch([new Error('ECONNRESET'), 150]);
    await watch.tick();
    await watch.tick();
    expect(messages).toHaveLength(0);
  });

  test('three consecutive failures → one alert with the error, no repeat', async () => {
    const err = new Error('certificate has expired');
    const { messages, watch } = makeWatch([err, err, err, err, err]);
    for (let i = 0; i < 5; i += 1) await watch.tick();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('certificate has expired');
  });

  test('failure streak resets on success and can alert again later', async () => {
    const e = new Error('timeout');
    const { messages, watch } = makeWatch([e, e, e, 150, e, e, e]);
    for (let i = 0; i < 7; i += 1) await watch.tick();
    expect(messages).toHaveLength(2);
  });

  test('failures split by a success are not "in a row"', async () => {
    const e = new Error('timeout');
    const { messages, watch } = makeWatch([e, e, 150, e]);
    for (let i = 0; i < 4; i += 1) await watch.tick();
    expect(messages).toHaveLength(0);
  });

  test('a throwing sink never propagates', async () => {
    const watch = createTlsExpiryWatch({
      host: '203.0.113.7',
      sink: async () => {
        throw new Error('webhook down');
      },
      check: scripted([1]),
      now: () => NOW,
    });
    await watch.tick();
  });

  test('start schedules the first check after the delay; stop halts it', async () => {
    let checks = 0;
    const watch = createTlsExpiryWatch({
      host: '203.0.113.7',
      sink: async () => undefined,
      check: async () => {
        checks += 1;
        return NOW + 150 * H;
      },
      now: () => NOW,
      firstDelayMs: 1,
      intervalMs: 5,
    });
    watch.start();
    await Bun.sleep(30);
    expect(checks).toBeGreaterThan(0);
    watch.stop();
    watch.stop(); // idempotent
    const after = checks;
    await Bun.sleep(30);
    expect(checks).toBe(after);
  });
});

describe('fetchCertNotAfter (real TLS)', () => {
  // Reproduces #176: real clients reach us by IP and send no SNI, and Caddy
  // only has a certificate for the IP. If the check lets the runtime derive
  // SNI from the dial hostname, Caddy aborts the handshake. We record the SNI
  // the server actually saw (Bun's tls server doesn't invoke SNICallback, so a
  // rejecting callback would silently pass).
  const makeCert = (): { key: string; cert: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'cfy-tls-'));
    try {
      const r = spawnSync('openssl', [
        'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
        '-days', '1', '-subj', '/CN=cfy-test', '-addext', 'subjectAltName=IP:127.0.0.1',
        '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'),
      ]);
      if (r.status !== 0) throw new Error(`openssl failed: ${r.stderr}`);
      return { key: readFileSync(join(dir, 'k.pem'), 'utf8'), cert: readFileSync(join(dir, 'c.pem'), 'utf8') };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const listen = (server: Server): Promise<number> =>
    new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));

  test('connects without SNI and verifies the IP identity', async () => {
    const { key, cert } = makeCert();
    const seen: Array<string | false | undefined> = [];
    const server = createServer({ key, cert }, (socket) => {
      seen.push((socket as unknown as { servername?: string | false }).servername);
      socket.end();
    });
    const port = await listen(server);
    try {
      const notAfter = await fetchCertNotAfter('localhost', '127.0.0.1', port, cert);
      expect(notAfter).toBeGreaterThan(Date.now());
      await Bun.sleep(20);
      expect(seen).toHaveLength(1);
      expect(seen[0] || null).toBeNull(); // no SNI on the wire
    } finally {
      server.close();
    }
  });

  test('rejects a certificate that is not for the expected IP', async () => {
    const { key, cert } = makeCert();
    const server = createServer({ key, cert });
    const port = await listen(server);
    try {
      await expect(fetchCertNotAfter('localhost', '127.0.0.2', port, cert)).rejects.toThrow();
    } finally {
      server.close();
    }
  });
});
