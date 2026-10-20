import type { ResolvedConfig } from "../config/load.js";
import type { TierOrRejected } from "../config/schema.js";
import { WorkerTaskSchema, type WorkerTaskInput } from "../core/task.js";
import { loadSources } from "../context/sources.js";
import type { ArtifactStore } from "../storage/artifacts.js";
import { loadRulebook, rulebookFingerprint } from "../scoring/rulebook.js";
import { decide, measureFeatures } from "../scoring/score.js";

export interface StaffedTier {
  tier: TierOrRejected;
  score: number;
  rulebookVersion: string;
}

/**
 * Cost-aware staffing: the tier the rulebook's deterministic score gives a brief (measured
 * features only: no classifier call, no tags), the same score the router computes when the
 * task runs. A plan node without a tier gets this one as its difficulty hint, so the cheapest
 * tier that fits is used and the classifier is skipped. T4 means the brief is too large for
 * any tier: split it. Null when the brief does not validate or its sources cannot be read
 * (the dispatch reports why).
 */
export async function rulebookTier(cfg: ResolvedConfig, brief: WorkerTaskInput, artifacts: ArtifactStore): Promise<StaffedTier | null> {
  const parsed = WorkerTaskSchema.safeParse(brief);
  if (!parsed.success || !cfg.profiles[parsed.data.profile]) return null;
  const spec = parsed.data;
  try {
    const rulebook = loadRulebook(cfg.rulebookPath);
    const sources = await loadSources(cfg, spec, artifacts);
    const features = await measureFeatures(cfg, spec, sources, { failedRuns: 0, attachmentModalities: [] });
    const c = decide(cfg, rulebook, spec, features, { basis: "rules", tags: null, confidence: null, rationale: null, suggestedTier: null, rulebookVersion: rulebookFingerprint(rulebook) });
    return { tier: c.tier, score: c.score, rulebookVersion: c.rulebookVersion };
  } catch {
    return null;
  }
}
