import { createHash } from "node:crypto";
import {
  levelChain,
  TIER_NAMES,
  VERIFICATION_LEVELS,
  type Importance,
  type ProfileName,
  type TierName,
  type VerificationConfig,
  type VerificationLevel,
} from "../config/schema.js";
import type { Criterion } from "../core/task.js";
import type { Tags } from "../scoring/rulebook.js";
import { effectiveImportance, formatImportanceSource, strongerImportance, type EffectiveImportance } from "./importance.js";
import { matchesWhen, type MatchFacts } from "./match.js";
import type { AcceptanceContract } from "./contract.js";

export const LEVEL_RANK: Readonly<Record<VerificationLevel, number>> = Object.fromEntries(VERIFICATION_LEVELS.map((l, i) => [l, i])) as Record<VerificationLevel, number>;

export function strongerLevel(a: VerificationLevel, b: VerificationLevel): VerificationLevel {
  return LEVEL_RANK[b] > LEVEL_RANK[a] ? b : a;
}

/** Built-in rule ids recorded alongside configured ones. */
export const BUILTIN_RULES = {
  /** A criterion marked verify: review needs an independent review, so at least deep. */
  criterionReview: "criterion-review",
  /** The task's own verification.atLeast. */
  taskAtLeast: "task-at-least",
  /** The task's own verification.addChecks. */
  taskAddChecks: "task-add-checks",
} as const;

export interface ResolvedReview {
  required: boolean;
  qualification: string | null;
  minTotalParametersB: number | null;
  independent: boolean;
}

/** A level with `extends` resolved: checks unioned, review fields inherited where unset. */
export interface ResolvedLevel {
  level: VerificationLevel;
  checks: string[];
  review: ResolvedReview;
  acceptance: "automatic" | "supervisor";
}

export function resolveLevel(policy: VerificationConfig, level: VerificationLevel): ResolvedLevel {
  const chain = levelChain(policy.levels, level);
  const bundles = chain.map((l) => policy.levels[l]);
  const first = <T>(pick: (b: (typeof bundles)[number]) => T | undefined): T | undefined => bundles.map(pick).find((v) => v !== undefined);
  const checks = new Set<string>();
  for (const b of [...bundles].reverse()) for (const c of b.checks) checks.add(c);
  return {
    level,
    checks: [...checks],
    review: {
      required: first((b) => b.review?.required) ?? false,
      qualification: first((b) => b.review?.qualification) ?? null,
      minTotalParametersB: first((b) => b.review?.min_total_parameters_b) ?? null,
      independent: first((b) => b.review?.independent) ?? false,
    },
    acceptance: first((b) => b.acceptance) ?? "automatic",
  };
}

/** `<version>:<sha256 prefix>` over the whole policy, like the rulebook fingerprint. */
export function policyFingerprint(policy: VerificationConfig): string {
  return `${policy.version}:${createHash("sha256").update(JSON.stringify(policy)).digest("hex").slice(0, 8)}`;
}

export interface PolicyInput {
  tier: TierName;
  profile: ProfileName;
  tags: Partial<Tags> | null;
  /** Declared paths before dispatch (see declaredPaths), changed paths on a result. */
  paths: string[];
  protectedPathsChanged: boolean | null;
  criteria: Criterion[];
  requestedImportance?: Importance | null;
  importanceReason?: string | null;
  parent?: { taskId: string; importance: Importance } | null;
  /** Task-level strengthening; it can only raise. */
  atLeast?: VerificationLevel | null;
  addChecks?: string[];
}

export interface PolicyEvaluation {
  importance: EffectiveImportance;
  /** The level the matrix gives for the tier and effective importance. */
  matrixLevel: VerificationLevel;
  /** Final level: the strongest of the matrix level and every matching minimum. */
  level: VerificationLevel;
  /** Ids of rules (configured and built-in) that raised the level or added checks. */
  rulesMatched: string[];
  /** Required named checks: the level's checks plus every added check. */
  checks: string[];
  review: ResolvedReview;
  acceptance: "automatic" | "supervisor";
  fingerprint: string;
}

/**
 * Pick the verification level and required checks. Level minimums take the strongest, checks
 * combine as a union, and task-level settings only raise.
 */
export function evaluatePolicy(policy: VerificationConfig, input: PolicyInput): PolicyEvaluation {
  const facts: MatchFacts = { profile: input.profile, tags: input.tags, paths: input.paths, protectedPathsChanged: input.protectedPathsChanged };
  const importance = effectiveImportance(policy, { requested: input.requestedImportance ?? null, reason: input.importanceReason ?? null, parent: input.parent ?? null, facts });
  const matrixLevel = policy.matrix[input.tier][importance.importance];
  let level = matrixLevel;
  const rulesMatched: string[] = [];
  const added = new Set<string>();
  for (const r of policy.rules) {
    if (!matchesWhen(r.when, facts)) continue;
    rulesMatched.push(r.id);
    if (r.require_at_least) level = strongerLevel(level, r.require_at_least);
    for (const c of r.add_checks ?? []) added.add(c);
  }
  if (input.criteria.some((c) => c.verify === "review")) {
    rulesMatched.push(BUILTIN_RULES.criterionReview);
    level = strongerLevel(level, "deep");
  }
  if (input.atLeast) {
    rulesMatched.push(BUILTIN_RULES.taskAtLeast);
    level = strongerLevel(level, input.atLeast);
  }
  if (input.addChecks?.length) {
    rulesMatched.push(BUILTIN_RULES.taskAddChecks);
    for (const c of input.addChecks) added.add(c);
  }
  const resolved = resolveLevel(policy, level);
  const checks = [...resolved.checks];
  for (const c of added) if (!checks.includes(c)) checks.push(c);
  return { importance, matrixLevel, level, rulesMatched, checks, review: resolved.review, acceptance: resolved.acceptance, fingerprint: policyFingerprint(policy) };
}

/** What a result reveals that the spec could not: the actual changes. Never the worker's own claims. */
export interface ResultFacts {
  changedPaths: string[];
  protectedPathsChanged: string[];
  /** The tier the result was produced at (an escalation or repair runs higher); never below the contract's. */
  tier?: TierName;
}

export interface Reevaluation {
  level: VerificationLevel;
  /** The contract's level when this one is stronger, else null. */
  raisedFrom: VerificationLevel | null;
  importance: Importance;
  importanceSource: string;
  /** Contract rules plus any that matched only on the result. */
  rulesMatched: string[];
  /** Rule ids that matched on the result but not in the contract. */
  newRules: string[];
  checks: string[];
  review: ResolvedReview;
  acceptance: "automatic" | "supervisor";
  raised: boolean;
  fingerprint: string;
}

/**
 * Re-run the policy against the actual result. Inputs are the contract's own (profile, tags,
 * request, parent), the tier the result was produced at, and the changed paths and
 * protected-path flag; nothing the worker says is an input. Level, importance, and checks can
 * only rise above the contract's.
 */
export function reevaluateOnResult(policy: VerificationConfig, contract: AcceptanceContract, facts: ResultFacts): Reevaluation {
  const ev = evaluatePolicy(policy, {
    tier: facts.tier && TIER_NAMES.indexOf(facts.tier) > TIER_NAMES.indexOf(contract.tier) ? facts.tier : contract.tier,
    profile: contract.profile,
    tags: contract.inputs.tags,
    paths: facts.changedPaths,
    protectedPathsChanged: facts.protectedPathsChanged.length > 0,
    criteria: contract.criteria,
    requestedImportance: contract.inputs.requestedImportance,
    importanceReason: contract.importance.reason,
    parent: contract.inputs.parent,
    atLeast: contract.inputs.atLeast,
    addChecks: contract.inputs.addChecks,
  });
  const c = contract.verification;
  const level = strongerLevel(c.level, ev.level);
  const importance = strongerImportance(contract.importance.level, ev.importance.importance);
  const importanceSource = importance === contract.importance.level ? contract.importance.source : formatImportanceSource(ev.importance.source);
  const newRules = ev.rulesMatched.filter((r) => !c.rulesMatched.includes(r));
  const checks = [...c.requiredChecks];
  const resolved = resolveLevel(policy, level);
  if (contract.declaredLabChecks.length && !checks.includes("ephemeral_lab_checks")) checks.push("ephemeral_lab_checks");
  for (const x of [...resolved.checks, ...ev.checks]) if (!checks.includes(x)) checks.push(x);
  const raised = level !== c.level || importance !== contract.importance.level || checks.length !== c.requiredChecks.length;
  // Review and acceptance never weaken below the contract's even if the policy changed since.
  const review: ResolvedReview = {
    required: resolved.review.required || c.review.required,
    qualification: resolved.review.qualification ?? c.review.qualification,
    minTotalParametersB: Math.max(resolved.review.minTotalParametersB ?? 0, c.review.minTotalParametersB ?? 0) || null,
    independent: resolved.review.independent || c.review.independent,
  };
  const acceptance = resolved.acceptance === "supervisor" || c.acceptance === "supervisor" ? "supervisor" : "automatic";
  return {
    level,
    raisedFrom: level !== c.level ? c.level : null,
    importance,
    importanceSource,
    rulesMatched: [...c.rulesMatched, ...newRules],
    newRules,
    checks,
    review,
    acceptance,
    raised,
    fingerprint: ev.fingerprint,
  };
}

