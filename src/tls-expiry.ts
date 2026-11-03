import { checkServerIdentity, connect, type PeerCertificate } from 'node:tls';
import type { AlertSink } from './alerts.js';
import { log } from './lib/logger.js';

/**
 * Certificate-expiry watch for the no-domain HTTPS path (#174).
 *
 * Caddy serves https://<TLS_IP> with a Let's Encrypt IP-address certificate
 * from the `shortlived` profile (~6-day validity) and renews it on its own.
 * That leaves almost no slack: if renewal quietly fails (ACME port blocked by
 * an SG edit, LE outage, Caddy down), every client breaks within days. This
 * checks the certificate a client would get — strict chain verification, no
 * SNI, identity = the public IP — and alerts before expiry or on persistent
 * failure.
 *
 * It dials Caddy over the compose network (`caddy:443`), not the public NLB
 * address: the only NLB target is this instance, and with client IP
 * preservation a target can't reach itself through its own NLB (no NAT
 * loopback) — every check would time out and raise a false alarm (R1 on
 * #174). A broken NLB path still surfaces here: ACME renewal goes through it,
 * so the certificate stops renewing and the expiry warning fires.
 */

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 6 * HOUR_MS;
// Fresh deploys need a couple of minutes for first issuance (ACME retries
// until NLB targets are healthy, see #173), so don't check immediately.
const DEFAULT_FIRST_DELAY_MS = 5 * 60 * 1000;
// A healthy shortlived cert is renewed with ~2+ days left; under 48h means
// renewal is already late.
const WARN_BEFORE_MS = 48 * HOUR_MS;
// ~18h at the default interval: long enough to ride out a blip, short enough
// to leave days before a 6-day cert runs out.
const FAILURES_BEFORE_ALERT = 3;
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * notAfter (epoch ms) of the certificate served at dialHost:port, verified as
 * if a client had connected to `identity` (the public IP).
 */
export const fetchCertNotAfter = (dialHost: string, identity: string, port = 443): Promise<number> =>
  new Promise((resolve, reject) => {
    // No `servername`: clients reach us by IP, which sends no SNI. Default
    // rejectUnauthorized=true, so an expired/untrusted cert rejects here, and
    // the identity check rejects a cert that isn't for the public IP.
    const socket = connect({
      host: dialHost,
      port,
      timeout: CONNECT_TIMEOUT_MS,
      checkServerIdentity: (_host: string, cert: PeerCertificate) => checkServerIdentity(identity, cert),
    }, () => {
      const notAfter = Date.parse(socket.getPeerCertificate().valid_to);
      socket.end();
      if (Number.isFinite(notAfter)) resolve(notAfter);
      else reject(new Error('peer certificate has no parsable valid_to'));
    });
    socket.on('timeout', () => socket.destroy(new Error(`TLS connect to ${dialHost}:${port} timed out`)));
    socket.on('error', reject);
  });

export type TlsExpiryWatch = Readonly<{
  tick(): Promise<void>;
  start(): void;
  stop(): void;
}>;

export const createTlsExpiryWatch = (params: {
  /** Public IP the certificate must be valid for (TLS_IP). */
  host: string;
  /** Where to dial. Default `caddy` = the compose service, see header comment. */
  dialHost?: string;
  sink: AlertSink;
  check?: () => Promise<number>;
  now?: () => number;
  intervalMs?: number;
  firstDelayMs?: number;
}): TlsExpiryWatch => {
  const dialHost = params.dialHost ?? 'caddy';
  const check = params.check ?? (() => fetchCertNotAfter(dialHost, params.host));
  const now = params.now ?? Date.now;
  const intervalMs = params.intervalMs ?? DEFAULT_INTERVAL_MS;
  const firstDelayMs = params.firstDelayMs ?? DEFAULT_FIRST_DELAY_MS;

  let expiryAlerted = false;
  let failures = 0;
  let failureAlerted = false;
  let firstTimer: ReturnType<typeof setTimeout> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const send = async (message: string): Promise<void> => {
    log.warn(message);
    try {
      await params.sink(message);
    } catch (err: unknown) {
      log.error(`[tls] alert send failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const tick = async (): Promise<void> => {
    let notAfter: number;
    try {
      notAfter = await check();
    } catch (err: unknown) {
      failures += 1;
      const reason = err instanceof Error ? err.message : String(err);
      log.warn(`[tls] check of https://${params.host} failed (${failures} in a row): ${reason}`);
      if (failures >= FAILURES_BEFORE_ALERT && !failureAlerted) {
        failureAlerted = true;
        await send(
          `[tls] 🔒 https://${params.host} failed ${failures} checks in a row: ${reason}. ` +
            'Clients may already be broken. Runbook: docs/operational-pitfalls.md "IP certificate"',
        );
      }
      return;
    }

    failures = 0;
    failureAlerted = false;
    const leftMs = notAfter - now();
    if (leftMs >= WARN_BEFORE_MS) {
      expiryAlerted = false; // renewed → re-arm
      return;
    }
    if (expiryAlerted) return;
    expiryAlerted = true;
    await send(
      `[tls] ⏳ certificate for https://${params.host} expires in ${Math.max(0, Math.floor(leftMs / HOUR_MS))}h ` +
        `(${new Date(notAfter).toISOString()}) — Caddy renewal is late. ` +
        'Runbook: docs/operational-pitfalls.md "IP certificate"',
    );
  };

  return Object.freeze({
    tick,
    start(): void {
      if (firstTimer || timer) return;
      firstTimer = setTimeout(() => {
        firstTimer = null;
        void tick();
        timer = setInterval(() => void tick(), intervalMs);
        timer.unref?.();
      }, firstDelayMs);
      firstTimer.unref?.();
    },
    stop(): void {
      if (firstTimer) clearTimeout(firstTimer);
      if (timer) clearInterval(timer);
      firstTimer = null;
      timer = null;
    },
  });
};
