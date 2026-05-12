import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import type { MiddlewareHandler } from 'hono';

/**
 * Phase 17 capture middleware.
 *
 * When CAPTURE_MODE=true, every authenticated /v1/messages request is
 * cloned and dumped to disk (headers in arrival order + raw body bytes).
 * The downstream handler is unaffected because we clone the Request first.
 *
 * Insight: Anthropic SDK only swaps host/path when ANTHROPIC_BASE_URL is set,
 * leaving headers and body byte-identical to a direct Anthropic call. So an
 * inbound dump on our proxy == the exact wire shape CC would send Anthropic.
 * No mitmproxy needed.
 *
 * Captures land under ./captures/ (or CAPTURE_DIR). Each call is one JSON file.
 * Phase 18's synthesis script reads these and produces cc-wire-snapshot.v2.json.
 */

const CAPTURE_DIR_DEFAULT = './captures';

export type CaptureConfig = Readonly<{
  enabled: boolean;
  dir: string;
}>;

export const loadCaptureConfig = (env: NodeJS.ProcessEnv = process.env): CaptureConfig => ({
  enabled: env.CAPTURE_MODE === 'true',
  dir: env.CAPTURE_DIR ?? CAPTURE_DIR_DEFAULT,
});

export const createCaptureMiddleware = (cfg: CaptureConfig): MiddlewareHandler => {
  if (!cfg.enabled) {
    return async (_c, next) => {
      await next();
    };
  }

  let writeQueue: Promise<void> = Promise.resolve();
  let seq = 0;

  return async (c, next) => {
    if (!c.req.path.startsWith('/v1/messages')) {
      await next();
      return;
    }

    // Clone the underlying Request so downstream handlers can still consume
    // the original body via c.req.json() / c.req.text().
    const cloned = c.req.raw.clone();

    // Header order: Web `Headers` iteration is sorted by spec (alphabetical),
    // which destroys wire fingerprint. Prefer Node http's `req.rawHeaders` —
    // a flat [name, value, name, value, ...] array in TCP arrival order. This
    // is exposed only when running under @hono/node-server (capture mode).
    const incoming = (c.env as { incoming?: IncomingMessage }).incoming;
    const rawHeaders = incoming?.rawHeaders;
    const headersInOrder: Array<[string, string]> = [];
    if (rawHeaders && rawHeaders.length > 0) {
      for (let i = 0; i < rawHeaders.length; i += 2) {
        const name = rawHeaders[i];
        const value = rawHeaders[i + 1];
        if (typeof name === 'string' && typeof value === 'string') {
          headersInOrder.push([name, value]);
        }
      }
    } else {
      cloned.headers.forEach((value, key) => headersInOrder.push([key, value]));
    }
    const wireOrderAvailable = rawHeaders !== undefined && rawHeaders.length > 0;

    // Read body as raw text to preserve key insertion order verbatim.
    const body = await cloned.text();

    const ts = new Date();
    const id = `${ts.toISOString().replace(/[:.]/g, '-')}_${String(++seq).padStart(4, '0')}_${randomUUID().slice(0, 8)}`;
    const dump = {
      capturedAt: ts.toISOString(),
      method: c.req.method,
      path: c.req.path,
      wireOrderAvailable,
      headersInOrder,
      bodyBytes: body.length,
      body,
    };

    // Serialize writes — never let dump I/O block the request chain. Failure
    // to dump is non-fatal: log and continue.
    writeQueue = writeQueue
      .then(async () => {
        await mkdir(cfg.dir, { recursive: true });
        await writeFile(join(cfg.dir, `${id}.json`), JSON.stringify(dump, null, 2));
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[capture] write failed: ${msg}`);
      });

    // Don't await writeQueue — let it flush in the background. The request
    // is already past the capture point and downstream can proceed.
    await next();
  };
};
