/**
 * Entrypoint for the messages_log cold-storage archiver (#150).
 *
 *   bun src/usage/archive-cli.ts [--dry-run]
 *
 * Invoked by `scripts/archive-messages-log.sh` on the EC2 host, which fetches
 * temporary role credentials from IMDS and injects them into a one-shot
 * container. Do not add this to the long-running server: multi-MB JSONB batches
 * have no business sharing a heap with in-flight SSE streams, and the archiver
 * must be safe to run manually at any time.
 *
 * Why this file lives in `src/` and not `scripts/`: the runtime image copies
 * `src/` only (Dockerfile), so a `scripts/*.ts` entrypoint would not exist
 * inside the container it is supposed to run in.
 *
 * Exit codes: 0 = ran (possibly archiving nothing), 1 = misconfigured or failed.
 * A non-zero exit is what makes a silently broken cron visible in the mail
 * spool / journal instead of looking like "nothing needed archiving".
 */
import { archiveBatch, type ArchiveSource } from './messages-log-archive.js';
import { createPostgresArchiveSource } from './messages-log-postgres.js';
import { log } from '../lib/logger.js';
import { redact } from '../lib/redact.js';

const DEFAULT_CUTOFF_DAYS = 14;
const DEFAULT_BATCH_SIZE = 200;
/**
 * Hard stop on batches per run. A first run over a multi-GB backlog would
 * otherwise hold the DB and the network for an unbounded stretch; capping it
 * means the backlog drains over several nights instead of one heroic run that
 * nobody is awake to watch. Raise deliberately for a supervised backfill.
 */
const DEFAULT_MAX_BATCHES = 50;

const intFromEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive number, got: ${raw}`);
  }
  return Math.floor(n);
};

const main = async (): Promise<number> => {
  const dryRun = process.argv.includes('--dry-run');

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.length === 0) {
    log.error('[archive] DATABASE_URL is not set — nothing to archive from');
    return 1;
  }

  const bucket = process.env.MESSAGES_LOG_ARCHIVE_BUCKET;
  if (!bucket || bucket.length === 0) {
    log.error('[archive] MESSAGES_LOG_ARCHIVE_BUCKET is not set');
    return 1;
  }

  // Parsed inside its own guard: a typo'd env var must exit 1 with a readable
  // line in the cron log, not an unhandled rejection stack.
  let cutoffDays: number;
  let batchSize: number;
  let maxBatches: number;
  try {
    cutoffDays = intFromEnv('MESSAGES_LOG_ARCHIVE_AFTER_DAYS', DEFAULT_CUTOFF_DAYS);
    batchSize = intFromEnv('MESSAGES_LOG_ARCHIVE_BATCH', DEFAULT_BATCH_SIZE);
    maxBatches = intFromEnv('MESSAGES_LOG_ARCHIVE_MAX_BATCHES', DEFAULT_MAX_BATCHES);
  } catch (err) {
    log.error(`[archive] ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  // Credentials are passed EXPLICITLY, never left to Bun's env resolution.
  //
  // Bun reads S3_* first and falls back to AWS_* per-variable. This container
  // has both sets, for two different identities: docker-compose supplies
  // S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY (the long-lived read-only IAM user
  // the admin UI uses to display archived bodies, which has no session token),
  // while the host wrapper injects AWS_ACCESS_KEY_ID/SECRET/SESSION_TOKEN (the
  // instance role's temporary credentials). Implicit resolution therefore
  // assembled a Frankenstein identity — the read-only user's key paired with
  // the role's session token — and every PUT failed with "The provided token
  // is malformed or otherwise invalid" (#158, caught by the first supervised
  // production run).
  //
  // The archiver always wants the injected role credentials, so it says so.
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    log.error(
      '[archive] AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are not set — run via ' +
        'scripts/archive-messages-log.sh, which fetches them from IMDS on the host',
    );
    return 1;
  }
  const s3 = new Bun.S3Client({
    bucket,
    region: process.env.AWS_REGION ?? 'ap-northeast-2',
    accessKeyId,
    secretAccessKey,
    // Present for IMDS role credentials, absent for a static IAM user key.
    // Passing undefined is correct in the latter case; passing the OTHER
    // identity's token is what broke #158.
    ...(process.env.AWS_SESSION_TOKEN ? { sessionToken: process.env.AWS_SESSION_TOKEN } : {}),
  });

  // Credential preflight, in BOTH modes.
  //
  // #158's real damage was not the broken credentials — it was that --dry-run
  // reported success with them. The dry run never calls s3.write(), so it never
  // authenticated against S3 at all, and the rehearsal whose entire job is
  // "prove this will work" happily green-lit a run that could not upload a
  // single byte. A ListBucket probe costs one request and closes that gap; the
  // write policy grants ListBucket on this prefix precisely so this can work.
  try {
    await s3.list({ prefix: 'messages-log/', maxKeys: 1 });
    log.info(`[archive] S3 credentials OK for s3://${bucket}/messages-log/`);
  } catch (err) {
    log.error(
      `[archive] S3 credential check failed: ${redact(err instanceof Error ? err.message : String(err))}`,
    );
    log.error(
      '[archive] the archiver needs the INSTANCE ROLE credentials (AWS_*), not the ' +
        'read-only S3_* pair used by the admin UI — check scripts/archive-messages-log.sh',
    );
    return 1;
  }

  // Connecting is itself a failure mode worth reporting cleanly — this job runs
  // unattended, and "could not connect" in the cron log beats a stack trace.
  let source: Awaited<ReturnType<typeof createPostgresArchiveSource>>;
  try {
    source = await createPostgresArchiveSource({ databaseUrl });
  } catch (err) {
    log.error(
      `[archive] cannot reach the database: ${redact(err instanceof Error ? err.message : String(err))}`,
    );
    return 1;
  }

  let totalRows = 0;
  let totalBytes = 0;
  // Counts batches that actually moved rows. Kept separate from the loop
  // variable because the loop can exit via `break` before its increment runs,
  // which made the dry-run summary report "200 rows in 0 batch(es)".
  let batchesRun = 0;
  let attempts = 0;

  try {
    for (; attempts < maxBatches; attempts += 1) {
      const result = await archiveBatch({
        source: dryRun ? readOnly(source) : source,
        putObject: async (key, body) => {
          if (dryRun) {
            log.info(`[archive] DRY RUN would put s3://${bucket}/${key} (${body.byteLength} B)`);
            return;
          }
          await s3.write(key, body);
        },
        now: () => new Date(),
        cutoffDays,
        batchSize,
      });

      if (result.rowsArchived === 0) break;

      batchesRun += 1;
      totalRows += result.rowsArchived;
      for (const part of result.parts) {
        totalBytes += part.compressedBytes;
        log.info(
          `[archive] ${part.rows} rows → s3://${bucket}/${part.key} (${part.compressedBytes} B gz)`,
        );
      }

      // A dry run cannot make progress (nothing is marked), so one pass is all
      // that is meaningful — without this it would loop maxBatches times over
      // the identical rows.
      if (dryRun) break;
    }

    if (attempts === maxBatches) {
      // Not an error, but it must not be silent: the operator needs to know the
      // backlog is only partially drained and the next run has work left.
      log.warn(
        `[archive] hit MESSAGES_LOG_ARCHIVE_MAX_BATCHES=${maxBatches} — backlog remains, re-run to continue`,
      );
    }
    log.info(
      `[archive] done: ${totalRows} rows in ${batchesRun} batch(es), ${totalBytes} B compressed, cutoff=${cutoffDays}d${dryRun ? ' (dry run)' : ''}`,
    );
    return 0;
  } catch (err) {
    log.error(`[archive] failed: ${redact(err instanceof Error ? err.message : String(err))}`);
    if (err instanceof Error && err.stack) log.error(redact(err.stack));
    return 1;
  } finally {
    await source.close();
  }
};

/**
 * Dry-run guard: reads are allowed, the mutation is not. Enforced structurally
 * rather than by an `if (dryRun)` inside the write path — a flag check that far
 * from the SQL is one careless edit away from nulling bodies during what the
 * operator was told is a rehearsal.
 */
const readOnly = (source: ArchiveSource): ArchiveSource =>
  Object.freeze({
    selectBatch: source.selectBatch.bind(source),
    async markArchived(): Promise<void> {
      log.info('[archive] DRY RUN skipping markArchived');
    },
  });

process.exit(await main());
