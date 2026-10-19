import { stat } from "node:fs/promises";
import path from "node:path";
import picomatch from "picomatch";
import type { ResolvedConfig } from "../config/load.js";
import { TIER_NAMES, type Modality, type TierName, type TierOrRejected } from "../config/schema.js";
import type { WorkerTask } from "../core/task.js";
import type { ContextSource } from "../context/sources.js";
import { readersFor } from "../context/sources.js";
import { estimateTokens } from "../gateway/types.js";
import { bandPoints, maxTagPoints, MULTI_GROUPS, TAG_GROUPS, type Rulebook, type TagGroup } from "./rulebook.js";

export interface ScoreLine {
  rule: string;
  points: number;
  detail: string;
}

export interface TaskFeatures {
  mode: "completion" | "read_only" | "coding";
  linesInScope: number;
  linesApproximate: boolean;
  contextTokens: number;
  repositories: number;
  acceptanceCriteria: number;
  checksRequired: boolean;
  outputSchema: boolean;
  retryAfterFailure: boolean;
  inputModalities: Modality[];
  scopeSample: string[];
}

export { TagsSchema, type Tags } from "./rulebook.js";
import type { Tags } from "./rulebook.js";

export interface Classification {
  rulebookVersion: string;
  basis: "rules" | "rules+classifier" | "rules+hint" | "forced" | "rules+classifier_failed";
  score: number;
  tier: TierOrRejected;
  breakdown: ScoreLine[];
  features: TaskFeatures;
  tags: Partial<Tags> | null;
  classifierConfidence: number | null;
  classifierRationale: string | null;
  classifierSuggestedTier: string | null;
  rejectReason: string | null;
}

const LINE_BYTES = 35;
const MAX_SCOPE_FILES = 20_000;

/** Facts measured from the task without any model. */
export async function measureFeatures(
  cfg: ResolvedConfig,
  spec: WorkerTask,
  sources: ContextSource[],
  opts: { runCount: number; attachmentModalities: Modality[] },
): Promise<TaskFeatures> {
  const profile = cfg.profiles[spec.profile]!;
  let lines = sources.reduce((s, src) => s + (src.totalLines ?? src.text.split("\n").length), 0);
  let approximate = false;
  const scopeSample: string[] = sources.slice(0, 10).map((s) => s.ref);

  // Coding scope (allowedPaths) and repository-wide investigations are measured from file sizes.
  const globs = spec.constraints.allowedPaths ?? [];
  const repoWide = profile.mode === "read_only" && !(spec.context.fileRefs?.length);
  if (globs.length || repoWide) {
    approximate = true;
    const match = globs.length ? picomatch(globs, { dot: true }) : () => true;
    for (const [, reader] of readersFor(cfg, spec)) {
      if (profile.mode === "coding" && reader.alias !== spec.writableRepository) continue;
      const { files } = await reader.listFiles("", undefined, MAX_SCOPE_FILES);
      const inScope = files.filter((f) => match(f));
      for (const f of inScope.slice(0, 5)) if (scopeSample.length < 15) scopeSample.push(`${reader.alias}:${f}`);
      let bytes = 0;
      for (const f of inScope) {
        try {
          bytes += (await stat(path.join(reader.root, ...f.split("/")))).size;
        } catch {
          // deleted or at a pinned commit only; skip
        }
      }
      lines += Math.round(bytes / LINE_BYTES);
    }
  }

  return {
    // Supervisors are not difficulty-scored; treat them like the hardest worker mode if asked.
    mode: profile.mode === "supervisor" ? "coding" : profile.mode,
    linesInScope: lines,
    linesApproximate: approximate,
    contextTokens: estimateTokens([{ role: "user", content: sources.map((s) => s.text).join("\n") + spec.goal }]),
    repositories: spec.repositoryAliases.length,
    acceptanceCriteria: spec.constraints.acceptanceCriteria.length,
    checksRequired: Boolean(spec.constraints.checks?.length),
    outputSchema: Boolean(spec.constraints.outputSchema),
    retryAfterFailure: opts.runCount > 1,
    inputModalities: [...new Set<Modality>(["text", ...opts.attachmentModalities])],
    scopeSample,
  };
}

export function featureScore(r: Rulebook, f: TaskFeatures): ScoreLine[] {
  const lines: ScoreLine[] = [];
  const add = (rule: string, points: number, detail: string) => lines.push({ rule, points, detail });
  add("mode", r.features.mode[f.mode], `${f.mode.replace("_", "-")} task`);
  add("lines_in_scope", bandPoints(r.features.lines_in_scope, f.linesInScope), `${f.linesApproximate ? "~" : ""}${f.linesInScope} lines in scope`);
  add("context_tokens", bandPoints(r.features.context_tokens, f.contextTokens), `~${f.contextTokens} context tokens`);
  if (f.repositories > 1) add("extra_repository", r.features.extra_repository * (f.repositories - 1), `${f.repositories} repositories`);
  const crit = [...r.features.acceptance_criteria].sort((a, b) => b.min - a.min).find((b) => f.acceptanceCriteria >= b.min);
  if (crit) add("acceptance_criteria", crit.points, `${f.acceptanceCriteria} acceptance criteria`);
  if (f.checksRequired) add("checks_required", r.features.checks_required, "checks must pass");
  if (f.outputSchema) add("output_schema", r.features.output_schema, "structured output schema");
  if (f.retryAfterFailure) add("retry_after_failure", r.features.retry_after_failure, "retry after a failed attempt");
  if (f.inputModalities.some((m) => m !== "text")) add("non_text_input", r.features.non_text_input, `input includes ${f.inputModalities.filter((m) => m !== "text").join(", ")}`);
  return lines;
}

export function tagScore(r: Rulebook, tags: Partial<Tags>): { lines: ScoreLine[]; reject: string | null } {
  const lines: ScoreLine[] = [];
  let reject: string | null = null;
  for (const group of Object.keys(TAG_GROUPS) as TagGroup[]) {
    const v = tags[group];
    const values = (Array.isArray(v) ? v : v ? [v] : []) as string[];
    for (const value of values) {
      const pts = (r.tags[group] as Record<string, number | "reject">)[value];
      if (pts === undefined) continue;
      if (pts === "reject") {
        reject = `${group}=${value}`;
        continue;
      }
      if (pts !== 0 || !MULTI_GROUPS.has(group)) lines.push({ rule: `tag.${group}`, points: pts, detail: `${group}: ${value.replace(/_/g, " ")}` });
    }
  }
  return { lines, reject };
}

export function tierForScore(cfg: ResolvedConfig, score: number): TierOrRejected {
  for (const t of TIER_NAMES) if (score <= cfg.tiers[t].max_score) return t;
  return "T4";
}

export function tierIndex(t: TierOrRejected): number {
  return t === "T4" ? 3 : TIER_NAMES.indexOf(t);
}

export function maxTier(...tiers: TierOrRejected[]): TierOrRejected {
  return tiers.reduce((a, b) => (tierIndex(b) > tierIndex(a) ? b : a));
}

export function bumpTier(t: TierOrRejected): TierOrRejected {
  return t === "T4" ? "T4" : (TIER_NAMES[tierIndex(t) + 1] ?? "T4");
}

/** Does classifying have any chance of changing the outcome? */
export function classifierCouldMatter(cfg: ResolvedConfig, r: Rulebook, deterministicScore: number): boolean {
  const lo = tierForScore(cfg, deterministicScore);
  const hi = tierForScore(cfg, deterministicScore + maxTagPoints(r));
  return lo !== "T3" && lo !== "T4" && lo !== hi;
}

/** Final tier: the rulebook decides from measured features plus tags; tags only add points. */
export function decide(
  cfg: ResolvedConfig,
  r: Rulebook,
  spec: WorkerTask,
  features: TaskFeatures,
  input: { basis: Classification["basis"]; tags: Partial<Tags> | null; confidence: number | null; rationale: string | null; suggestedTier: string | null; rulebookVersion: string },
): Classification {
  const breakdown = featureScore(r, features);
  let rejectReason: string | null = null;
  if (features.contextTokens > r.features.split_above_context_tokens) {
    rejectReason = `context of ~${features.contextTokens} tokens exceeds ${r.features.split_above_context_tokens}; split the task`;
  }
  if (input.tags) {
    const t = tagScore(r, input.tags);
    breakdown.push(...t.lines);
    if (t.reject) rejectReason = `classifier tagged ${t.reject}: return to the supervisor for clarification`;
  }
  const score = breakdown.reduce((s, l) => s + l.points, 0);
  let tier: TierOrRejected = tierForScore(cfg, score);
  if (input.confidence !== null && input.confidence < r.low_confidence_threshold && tier !== "T4") {
    tier = bumpTier(tier);
    breakdown.push({ rule: "low_confidence", points: 0, detail: `classifier confidence ${input.confidence.toFixed(2)}: rounded up to ${tier}` });
  }
  tier = maxTier(tier, cfg.profiles[spec.profile]!.min_tier);
  if (spec.hints?.difficulty) tier = maxTier(tier, spec.hints.difficulty);
  if (spec.routing?.tier) tier = maxTier(tier, spec.routing.tier);
  if (rejectReason) tier = "T4";
  else if (tier === "T4" && spec.hints?.difficulty === "T4") rejectReason = "the supervisor marked this task T4: keep it rather than delegating";
  else if (tier === "T4") rejectReason = `difficulty score ${score} exceeds the T3 limit of ${cfg.tiers.T3.max_score}; split the task into smaller pieces`;
  return {
    rulebookVersion: input.rulebookVersion,
    basis: input.basis,
    score,
    tier,
    breakdown,
    features,
    tags: input.tags,
    classifierConfidence: input.confidence,
    classifierRationale: input.rationale,
    classifierSuggestedTier: input.suggestedTier,
    rejectReason,
  };
}

export type { TierName };
