import { serve as honoServeNode } from '@hono/node-server';
import { composeApp } from './app.js';
import { loadConfig } from './config.js';
import { createLogger, log, setLogger } from './lib/logger.js';

const config = loadConfig();

// Initialize the structured logger early so every subsequent message goes
// through redact() + level filtering. Pretty mode is opt-in via LOG_PRETTY.
setLogger(
  createLogger({
    level: config.logLevel,
    pretty: process.env.LOG_PRETTY === 'true',
  }),
);

const { app, banner, dispose, captureModeEnabled } = await composeApp(config);

if (captureModeEnabled) {
  // node:http adapter exposes wire-order req.rawHeaders, which Bun.serve's
  // Web Request API does not. Outbound TLS is still Bun (Bun.fetch).
  honoServeNode(
    { fetch: app.fetch, port: config.port, hostname: config.host },
    (info) => banner(info.address, info.port, 'hono/node-server'),
  );
} else {
  const server = Bun.serve({
    fetch: app.fetch,
    port: config.port,
    hostname: config.host,
    // Disable per-connection idle timeout. Bun.serve's default (10s) can cut
    // SSE responses when Claude's upstream pauses between chunks (thinking
    // blocks, slow first-token). Abuse defense already lives in earlier
    // layers — Caddy edge limits + createIpRateLimiter + createConcurrencyLimiter
    // — so removing the runtime idle clamp is safe.
    idleTimeout: 0,
  });
  banner(server.hostname ?? config.host, server.port ?? config.port, 'Bun.serve');
}

// Graceful shutdown — close DB pools before the runtime tears them out from
// under in-flight queries. Docker sends SIGTERM, then SIGKILL after 10s by
// default; we finish within 5s thanks to per-tracker close() timeouts.
let shuttingDown = false;
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`[claude-for-you] ${signal} received, draining...`);
  await dispose();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

export { app };
