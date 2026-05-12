/**
 * Phase 21 — inter-request pacing per session.
 *
 * When PACING_MIN_GAP_MS > 0, consecutive outbound requests sharing the same
 * x-claude-code-session-id are spaced by at least `minGapMs`. Without a
 * session-id (SDK-direct clients) or with gap = 0, this is a no-op.
 *
 * Default: 0 (off). CC's actual inter-request distribution is dominated by
 * user think-time, so for trusted-few traffic this rarely matters. Enable
 * if billing classifier appears time-aware.
 */

export type PacingConfig = Readonly<{ minGapMs: number }>;

export type PacingEnforcer = Readonly<{
  await(sessionId: string | null | undefined): Promise<void>;
}>;

export const createPacingEnforcer = (cfg: PacingConfig): PacingEnforcer => {
  const lastSent = new Map<string, number>();

  return Object.freeze({
    async await(sessionId: string | null | undefined): Promise<void> {
      if (cfg.minGapMs <= 0 || !sessionId) return;
      const last = lastSent.get(sessionId);
      const now = Date.now();
      if (last !== undefined) {
        const elapsed = now - last;
        if (elapsed < cfg.minGapMs) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, cfg.minGapMs - elapsed);
          });
        }
      }
      lastSent.set(sessionId, Date.now());
    },
  });
};
