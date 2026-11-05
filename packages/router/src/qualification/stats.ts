import type { Db } from "../storage/db.js";
import type { ResolvedConfig } from "../config/load.js";
import { TIER_NAMES, TierNameSchema, type ProfileMode, type RequestProfileName, type TierName } from "../config/schema.js";
import { z } from "zod";
import type { QualificationLookup } from "../routing/select.js";

export interface QualificationStat {
  passRate: number;
  trials: number;
  passes: number;
  qualified: boolean;
  /** Wilson 95% interval for the pass rate. */
  low: number;
  high: number;
}

/** Aggregate-only capability; never exposes another project's database or private rows. */
export type QualificationStatReader = (cfg: ResolvedConfig, endpointId: string, family: string, tier: TierName, threshold?: number) => QualificationStat | null;
const StatQuery = z.object({ endpointId: z.string().min(1), family: z.string().min(1), tier: TierNameSchema,
  threshold: z.number().min(0).max(1) }).strict();
const StatCounts = z.object({ n: z.number().int().min(0), passes: z.number().int().min(0).nullable() }).strict();

export function validateQualificationStatQuery(endpointId: string, family: string, tier: TierName, threshold: number): void {
  StatQuery.parse({ endpointId, family, tier, threshold });
}

export function qualificationLookupFrom(reader: QualificationStatReader, cfg: ResolvedConfig): QualificationLookup {
  return (endpointId, profile, tier, family) => {
    const mode = profile === "direct" ? "completion" : cfg.profiles[profile]?.mode;
    return family ? reader(cfg, endpointId, family.family, family.tier, family.threshold)
      : mode ? reader(cfg, endpointId, familyOf(mode), tier) : null;
  };
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
export function qualificationStat(db: Db, cfg: ResolvedConfig, endpointId: string, family: string, tier: TierName, threshold = cfg.qualification.pass_threshold): QualificationStat | null {
  validateQualificationStatQuery(endpointId, family, tier, threshold);
  const tiers = TIER_NAMES.slice(TIER_NAMES.indexOf(tier));
  const row = StatCounts.parse(db
    .prepare(
      `SELECT COUNT(*) AS n, SUM(outcome = 'pass') AS passes FROM qualification_results
        WHERE endpoint_id = ? AND family = ? AND outcome != 'infra_error' AND tier IN (${tiers.map(() => "?").join(",")})`,
    )
    .get(endpointId, family, ...tiers));
  if (row.n === 0) return null;
  const passes = row.passes ?? 0;
  const passRate = passes / row.n;
  return {
    passRate,
    trials: row.n,
    passes,
    qualified: row.n >= cfg.qualification.min_trials && passRate >= threshold,
    ...wilson(passes, row.n),
  };
}

/** One synchronous aggregate-only snapshot. No handle or private result rows escape this scope. */
export function withQualificationStats<T>(db: Db | null, work: (reader: QualificationStatReader) => T): T {
  const rows = db === null ? [] : z.array(z.object({
    endpointId: z.string().min(1), family: z.string().min(1), tier: TierNameSchema,
    n: z.number().int().positive(), passes: z.number().int().nonnegative(),
  }).strict().refine(row => row.passes <= row.n)).parse(db.prepare(
    `SELECT endpoint_id AS endpointId, family, tier, COUNT(*) AS n, SUM(outcome='pass') AS passes
     FROM qualification_results WHERE outcome != 'infra_error' GROUP BY endpoint_id, family, tier`,
  ).all());
  const counts = new Map<string, { n: number; passes: number }>();
  for (const row of rows) for (const tier of TIER_NAMES.slice(0, TIER_NAMES.indexOf(row.tier) + 1)) {
    const key = JSON.stringify([row.endpointId, row.family, tier]);
    const count = counts.get(key) ?? { n: 0, passes: 0 };
    count.n += row.n; count.passes += row.passes; counts.set(key, count);
  }
  let active = true;
  const reader: QualificationStatReader = (cfg, endpointId, family, tier, threshold = cfg.qualification.pass_threshold) => {
    if (!active) throw new Error("Qualification snapshot reader is no longer active");
    validateQualificationStatQuery(endpointId, family, tier, threshold);
    const count = counts.get(JSON.stringify([endpointId, family, tier]));
    if (!count) return null;
    const passRate = count.passes / count.n;
    return { passRate, trials: count.n, passes: count.passes,
      qualified: count.n >= cfg.qualification.min_trials && passRate >= threshold, ...wilson(count.passes, count.n) };
  };
  try {
    const result = work(reader);
    if (result !== null && (typeof result === "object" || typeof result === "function") && typeof (result as { then?: unknown }).then === "function")
      throw new Error("Qualification snapshot callback must be synchronous");
    return result;
  } finally { active = false; }
}

export function qualificationLookup(db: Db, cfg: ResolvedConfig) {
  return (endpointId: string, profile: RequestProfileName, tier: TierName, family?: { family: string; tier: TierName; threshold: number }) => {
    if (family) return qualificationStat(db, cfg, endpointId, family.family, family.tier, family.threshold);
    const mode = profile === "direct" ? "completion" : cfg.profiles[profile]?.mode;
    return mode ? qualificationStat(db, cfg, endpointId, familyOf(mode), tier) : null;
  };
}

/** Reviewers qualify on the review evaluation family, separately from worker qualification. */
export const REVIEW_FAMILY = "review";

/**
 * What a reviewer must hold for a level's `review.qualification`. review: the review family at
 * the task's tier and the usual pass threshold, preferred or required per
 * verification.reviewer_qualification. review_strict: the same family on T3 evaluations at the
 * higher review_strict threshold, always required. Any other name is its own family.
 */
export function reviewerQualification(cfg: ResolvedConfig, name: string, tier: TierName): { family: string; tier: TierName; threshold: number; mode: "preferred" | "required"; name: string } {
  if (name === "review_strict") return { family: REVIEW_FAMILY, tier: "T3", threshold: cfg.verification.review_strict_pass_threshold, mode: "required", name };
  return { family: name, tier, threshold: cfg.qualification.pass_threshold, mode: cfg.verification.reviewer_qualification, name };
}
