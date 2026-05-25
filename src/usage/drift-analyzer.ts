/**
 * Phase 27 — drift root cause analyzer.
 *
 * Keeps a tiny ring of recent request fingerprints. When a billing alarm
 * fires, computes a delta vs the previous N requests to surface the
 * axis-that-changed: header names, body keys, anthropic-beta flag set,
 * client identifier. This is the half-step that turns "service_tier
 * alarm at 3am" from "spend an hour grepping logs" into "the offender
 * is the request that started sending header X 4 calls ago".
 *
 * Storage: in-memory only — by design. Drift analysis is for the live
 * window right around the alarm; long-term forensic data lives in captures.
 */

const RING_SIZE = 100;

export type RequestFingerprint = Readonly<{
  ts: number;
  userKey: string;
  headerNames: readonly string[];
  bodyKeys: readonly string[];
  anthropicBeta: string;
  userAgent: string;
  model: string;
}>;

export type DriftReport = Readonly<{
  comparedAt: number;
  recentCount: number;
  changes: readonly string[];
}>;

export type DriftAnalyzer = Readonly<{
  record(fp: RequestFingerprint): void;
  analyze(splitAt: number): DriftReport;
}>;

const diffSets = (label: string, before: ReadonlySet<string>, after: ReadonlySet<string>): string[] => {
  const added = [...after].filter((x) => !before.has(x));
  const removed = [...before].filter((x) => !after.has(x));
  const out: string[] = [];
  if (added.length > 0) out.push(`${label} added: ${added.join(', ')}`);
  if (removed.length > 0) out.push(`${label} removed: ${removed.join(', ')}`);
  return out;
};

const diffValues = (label: string, beforeValues: Set<string>, afterValues: Set<string>): string[] => {
  const added = [...afterValues].filter((x) => !beforeValues.has(x));
  if (added.length === 0) return [];
  return [`${label} new value(s): ${[...added].join(' | ')}`];
};

export const createDriftAnalyzer = (): DriftAnalyzer => {
  const ring: RequestFingerprint[] = [];

  return Object.freeze({
    record(fp: RequestFingerprint): void {
      ring.push(fp);
      if (ring.length > RING_SIZE) ring.shift();
    },

    /**
     * `splitAt` is a timestamp (epoch ms). Requests <= splitAt form the
     * "before" baseline; > splitAt form the "after" window where the
     * problematic shape presumably lives. Typical call:
     *   analyzer.analyze(Date.now() - 5 * 60_000)   // last 5 min vs prior
     */
    analyze(splitAt: number): DriftReport {
      const before = ring.filter((fp) => fp.ts <= splitAt);
      const after = ring.filter((fp) => fp.ts > splitAt);
      if (after.length === 0) {
        return {
          comparedAt: Date.now(),
          recentCount: 0,
          changes: ['(no recent requests within window — drift cause unobservable)'],
        };
      }

      // collect set unions for each axis on each side
      const collect = (slice: RequestFingerprint[], pick: (fp: RequestFingerprint) => readonly string[]): Set<string> => {
        const s = new Set<string>();
        for (const fp of slice) for (const v of pick(fp)) s.add(v);
        return s;
      };
      const collectVal = (
        slice: RequestFingerprint[],
        pick: (fp: RequestFingerprint) => string,
      ): Set<string> => {
        const s = new Set<string>();
        for (const fp of slice) {
          const v = pick(fp);
          if (v) s.add(v);
        }
        return s;
      };

      const changes: string[] = [];

      changes.push(
        ...diffSets(
          'header names',
          collect(before, (fp) => fp.headerNames),
          collect(after, (fp) => fp.headerNames),
        ),
      );
      changes.push(
        ...diffSets(
          'body keys',
          collect(before, (fp) => fp.bodyKeys),
          collect(after, (fp) => fp.bodyKeys),
        ),
      );

      const betaBefore = new Set<string>();
      const betaAfter = new Set<string>();
      for (const fp of before) for (const f of fp.anthropicBeta.split(',')) if (f) betaBefore.add(f.trim());
      for (const fp of after) for (const f of fp.anthropicBeta.split(',')) if (f) betaAfter.add(f.trim());
      changes.push(...diffSets('anthropic-beta', betaBefore, betaAfter));

      changes.push(
        ...diffValues(
          'user-agent',
          collectVal(before, (fp) => fp.userAgent),
          collectVal(after, (fp) => fp.userAgent),
        ),
      );
      changes.push(
        ...diffValues(
          'model',
          collectVal(before, (fp) => fp.model),
          collectVal(after, (fp) => fp.model),
        ),
      );

      // userKey shifts — alarm immediately after a new user starts using us
      const userBefore = collectVal(before, (fp) => fp.userKey);
      const userAfter = collectVal(after, (fp) => fp.userKey);
      changes.push(...diffSets('users', userBefore, userAfter));

      return {
        comparedAt: Date.now(),
        recentCount: after.length,
        changes: changes.length > 0 ? changes : ['(no axis change detected — likely upstream-side classifier shift)'],
      };
    },
  });
};
