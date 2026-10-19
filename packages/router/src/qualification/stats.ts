import type { Db } from "../storage/db.js";
import type { ResolvedConfig } from "../config/load.js";
import { TIER_NAMES, type ProfileMode, type ProfileName, type TierName } from "../config/schema.js";

export interface QualificationStat {
  passRate: number;
  trials: number;
  passes: number;
  qualified: boolean;
  /** Wilson 95% interval for the pass rate. */
  low: number;
  high: number;
}

export function wilson(passes: number, n: number): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 1 };
  const z = 1.96;
  const p = passes / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/** Qualification is tracked per task family (the profile's mode) and tier. */
export function familyOf(mode: ProfileMode): string {
  return mode;
}

/**
 * Pass rate at a tier counts results at that tier and harder ones: passing hard evaluations is
 * evidence for easier work. Infrastructure failures are excluded.
 */
export function qualificationStat(db: Db, cfg: ResolvedConfig, endpointId: string, family: string, tier: TierName): QualificationStat | null {
  const tiers = TIER_NAMES.slice(TIER_NAMES.indexOf(tier));
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n, SUM(outcome = 'pass') AS passes FROM qualification_results
        WHERE endpoint_id = ? AND family = ? AND outcome != 'infra_error' AND tier IN (${tiers.map(() => "?").join(",")})`,
    )
    .get(endpointId, family, ...tiers) as { n: number; passes: number | null };
  if (row.n === 0) return null;
  const passes = row.passes ?? 0;
  const passRate = passes / row.n;
  return {
    passRate,
    trials: row.n,
    passes,
    qualified: row.n >= cfg.qualification.min_trials && passRate >= cfg.qualification.pass_threshold,
    ...wilson(passes, row.n),
  };
}

export function qualificationLookup(db: Db, cfg: ResolvedConfig) {
  return (endpointId: string, profile: ProfileName, tier: TierName) => {
    const mode = cfg.profiles[profile]?.mode;
    return mode ? qualificationStat(db, cfg, endpointId, familyOf(mode), tier) : null;
  };
}
