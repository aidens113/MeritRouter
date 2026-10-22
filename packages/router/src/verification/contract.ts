import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ImportanceSchema,
  ProfileNameSchema,
  TierNameSchema,
  VerificationLevelSchema,
  type Importance,
  type TierName,
  type VerificationConfig,
  type VerificationLevel,
} from "../config/schema.js";
import { SwitchyardError } from "../core/errors.js";
import { criteria, CriterionVerifySchema, type WorkerTask } from "../core/task.js";
import { TagsSchema, type Tags } from "../scoring/rulebook.js";
import type { Db } from "../storage/db.js";
import { formatImportanceSource } from "./importance.js";
import { declaredPaths } from "./match.js";
import { evaluatePolicy, type PolicyEvaluation } from "./policy.js";

const count = z.number().int().min(0);

/**
 * Model requests reserved per purpose. The total is what the task may spend in all:
 * classification + execution + review + repair, never more than the ceiling
 * (verification.max_total_requests_per_task, or an explicit task budget).
 */
export const BudgetAllocationSchema = z
  .object({
    /** The task's total across every tier and purpose: the sum of the four reserves below. */
    total: count,
    /** Already spent classifying the task when the contract was compiled. */
    classification: count,
    /** What the first run may use (the profile and tier execution cap). */
    execution: count,
    /** Reserved for independent review: the level's, plus what a repair at a higher tier needs. */
    review: count,
    /** Reserved for quality retries (repairs and escalations). */
    repair: count,
    /** Room left under the ceiling; never spent. */
    unallocated: count,
  })
  .strict();
export type BudgetAllocation = z.infer<typeof BudgetAllocationSchema>;

const ReviewSchema = z.object({ required: z.boolean(), qualification: z.string().nullable(), minTotalParametersB: z.number().nullable(), independent: z.boolean() }).strict();

export const AcceptanceContractSchema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: z.string().min(1),
    goal: z.string(),
    profile: ProfileNameSchema,
    tier: TierNameSchema,
    criteria: z.array(z.object({ id: z.string(), text: z.string(), verify: CriterionVerifySchema, checks: z.array(z.string()) }).strict()).min(1),
    scope: z
      .object({
        repositoryAliases: z.array(z.string()),
        writableRepository: z.string().nullable(),
        allowedPaths: z.array(z.string()).nullable(),
        baseCommits: z.record(z.string(), z.string()),
      })
      .strict(),
    /** constraints.checks: the commands declared_checks requires. */
    declaredChecks: z.array(z.string()),
    declaredLabChecks: z.array(z.string()).max(10).default([]),
    hasOutputSchema: z.boolean(),
    importance: z
      .object({
        level: ImportanceSchema,
        requested: ImportanceSchema,
        reason: z.string().nullable(),
        /** e.g. "task", "default", "floor:risk-critical", "parent:<task id>". */
        source: z.string(),
        considered: z.array(z.string()),
      })
      .strict(),
    verification: z
      .object({
        level: VerificationLevelSchema,
        matrixLevel: VerificationLevelSchema,
        rulesMatched: z.array(z.string()),
        requiredChecks: z.array(z.string()),
        review: ReviewSchema,
        acceptance: z.enum(["automatic", "supervisor"]),
        strictAcceptor: z.enum(["supervisor", "human"]),
        maxQualityRetries: count,
      })
      .strict(),
    /** The policy inputs, kept so the result can be re-evaluated against the same facts. */
    inputs: z
      .object({
        tags: TagsSchema.partial().nullable(),
        requestedImportance: ImportanceSchema.nullable(),
        parent: z.object({ taskId: z.string(), importance: ImportanceSchema }).strict().nullable(),
        atLeast: VerificationLevelSchema.nullable(),
        addChecks: z.array(z.string()),
      })
      .strict(),
    budget: BudgetAllocationSchema,
    fingerprints: z.object({ rulebook: z.string().nullable(), policy: z.string() }).strict(),
    createdAt: z.number().int(),
  })
  .strict();
export type AcceptanceContract = z.infer<typeof AcceptanceContractSchema>;

/** Request counts the allocation is computed from (see allocateBudget). */
export interface BudgetInput {
  /**
   * The task's total across every purpose: verificationTotal(cfg, spec), that is
   * verification.max_total_requests_per_task narrowed by an explicit budget.maxModelRequests.
   * Profile and tier caps bound execution only; review and repair sit on top of them.
   */
  total: number;
  /** The run's cap at the contract tier: effectiveBudget(cfg, spec, tier).maxModelRequests. */
  tierExecution: number;
  /** The execution cap at the tier a repair runs at, or null for the contract tier. */
  nextTierExecution: number | null;
  /** Requests already charged to the task for classification. */
  classificationUsed: number;
  /**
   * The tier a quality repair runs at (the next tier when escalation is on). Its result is
   * re-evaluated there, so the review that level needs is reserved too. Null: no repair tier.
   */
  repairTier?: TierName | null;
}

export type AllocationResult =
  | { ok: true; allocation: BudgetAllocation }
  | { ok: false; needed: number; available: number };

/**
 * Reserve requests under the ceiling (b.total), in priority order: classification (already
 * spent), review (required by the level; never dropped), execution (up to the profile and tier
 * cap), repair (max_quality_retries x the per-retry amount), then the review a repaired result
 * needs when its tier raises the level (`repairReview`). The allocation's total is the sum of
 * what is reserved; the ceiling only bounds it. The level is never lowered to fit: when
 * classification + review + one execution request exceed the ceiling, it fails. With the
 * default ceiling (24) that only happens when an explicit task budget is too small.
 */
export function allocateBudget(policy: VerificationConfig, ev: Pick<PolicyEvaluation, "level" | "review">, b: BudgetInput, repairReview = 0): AllocationResult {
  const review = ev.review.required ? (policy.budget.review_requests[ev.level] ?? 0) : 0;
  const needed = b.classificationUsed + review + 1;
  if (needed > b.total) return { ok: false, needed, available: b.total };
  let left = b.total - b.classificationUsed - review;
  const execution = Math.min(b.tierExecution, left);
  left -= execution;
  const perRetry = typeof policy.budget.repair_requests === "number" ? policy.budget.repair_requests : (b.nextTierExecution ?? b.tierExecution);
  const repair = Math.max(0, Math.min(policy.failure.max_quality_retries * perRetry, left));
  left -= repair;
  const extraReview = repair > 0 ? Math.max(0, Math.min(repairReview, left)) : 0;
  const total = b.classificationUsed + execution + review + extraReview + repair;
  return {
    ok: true,
    allocation: { total, classification: b.classificationUsed, execution, review: review + extraReview, repair, unallocated: b.total - total },
  };
}

/**
 * Review requests the task may spend at its effective level. Normally the contract's review
 * reserve, which already covers the review a repair at a higher tier needs. When the actual
 * result raised the level to one that needs more (for example a protected-path edit on a
 * standard task), the difference is drawn from the unallocated room under the ceiling; if even
 * that cannot hold it, the review ends skipped_budget. The level is never lowered.
 */
export function reviewAllowance(policy: Pick<VerificationConfig, "budget">, budget: BudgetAllocation, level: VerificationLevel, required: boolean): number {
  if (!required) return budget.review;
  const wanted = policy.budget.review_requests[level] ?? 0;
  return Math.max(budget.review, Math.min(wanted, budget.review + budget.unallocated));
}

/** The reserve adjustment a raised level needs: review requests drawn from the unallocated room. */
export function reviewReserveAdjustment(policy: Pick<VerificationConfig, "budget">, budget: BudgetAllocation, level: VerificationLevel, required: boolean): { from: number; to: number; fromUnallocated: number; wanted: number } | null {
  if (!required) return null;
  const wanted = policy.budget.review_requests[level] ?? 0;
  if (wanted <= budget.review) return null;
  const to = reviewAllowance(policy, budget, level, required);
  return { from: budget.review, to, fromUnallocated: to - budget.review, wanted };
}

/** Requests used so far, as admission counts them (cumulative, by purpose). */
export interface RequestsUsed {
  total: number;
  verification: number;
  repair: number;
}

/** Cumulative cap for the first run: the tier's execution cap, never into the review or repair reserves. */
export function executionCap(budget: BudgetAllocation, tierCap: number): number {
  return Math.min(tierCap, budget.classification + budget.execution);
}

/** Cumulative cap for a repair (or escalation) run: what is used plus what is left of the repair reserve. */
export function repairCap(budget: BudgetAllocation, used: RequestsUsed): number {
  return used.total + Math.max(0, budget.repair - used.repair);
}

/**
 * Cumulative cap for one review session: what is used plus this session's share of what is
 * left of the review allowance. `share` < 1 keeps part of it for a re-review after a repair.
 */
export function reviewCap(allowance: number, used: RequestsUsed, share = 1): number {
  const left = Math.max(0, allowance - used.verification);
  return used.total + (share >= 1 ? left : Math.ceil(left * share));
}

export interface CompileInput {
  taskId: string;
  spec: WorkerTask;
  tier: TierName;
  /** Classifier tags, or the supervisor's hint tags; null when not classified. */
  tags: Partial<Tags> | null;
  rulebookFingerprint: string | null;
  policy: VerificationConfig;
  budget: BudgetInput;
  /** The parent job's effective importance (from its contract), if any. */
  parent?: { taskId: string; importance: Importance } | null;
  now: number;
}

export type CompileResult =
  | { ok: true; contract: AcceptanceContract; evaluation: PolicyEvaluation }
  | { ok: false; code: "verification_budget_insufficient"; message: string; needed: number; available: number; evaluation: PolicyEvaluation };

/** Compile the acceptance contract once, after classification and before the first run. */
export function compileContract(input: CompileInput): CompileResult {
  const { spec, policy } = input;
  const crit = criteria(spec);
  const evaluation = evaluatePolicy(policy, {
    tier: input.tier,
    profile: spec.profile,
    tags: input.tags,
    paths: declaredPaths(spec),
    protectedPathsChanged: null,
    criteria: crit,
    requestedImportance: spec.importance ?? null,
    importanceReason: spec.importanceReason ?? null,
    parent: input.parent ?? null,
    atLeast: spec.verification?.atLeast ?? null,
    addChecks: spec.verification?.addChecks ?? [],
  });
  // A repair at a higher tier is re-evaluated there; reserve the review that level needs beyond this one.
  const repairTier = input.budget.repairTier ?? null;
  let repairReview = 0;
  if (repairTier && repairTier !== input.tier && policy.failure.max_quality_retries > 0) {
    const atRepair = evaluatePolicy(policy, {
      tier: repairTier,
      profile: spec.profile,
      tags: input.tags,
      paths: declaredPaths(spec),
      protectedPathsChanged: null,
      criteria: crit,
      requestedImportance: spec.importance ?? null,
      importanceReason: spec.importanceReason ?? null,
      parent: input.parent ?? null,
      atLeast: spec.verification?.atLeast ?? null,
      addChecks: spec.verification?.addChecks ?? [],
    });
    const need = atRepair.review.required ? (policy.budget.review_requests[atRepair.level] ?? 0) : 0;
    const have = evaluation.review.required ? (policy.budget.review_requests[evaluation.level] ?? 0) : 0;
    repairReview = Math.max(0, need - have);
  }
  const alloc = allocateBudget(policy, evaluation, input.budget, repairReview);
  if (!alloc.ok) {
    return {
      ok: false,
      code: "verification_budget_insufficient",
      message: `verification level ${evaluation.level} needs ${alloc.needed} model requests (classification ${input.budget.classificationUsed}, review ${alloc.needed - input.budget.classificationUsed - 1}, execution 1) but the task allows ${alloc.available}; raise budget.maxModelRequests or lower the importance`,
      needed: alloc.needed,
      available: alloc.available,
      evaluation,
    };
  }
  const contract = AcceptanceContractSchema.parse({
    schemaVersion: 1,
    taskId: input.taskId,
    goal: spec.goal,
    profile: spec.profile,
    tier: input.tier,
    criteria: crit,
    scope: {
      repositoryAliases: spec.repositoryAliases,
      writableRepository: spec.writableRepository ?? null,
      allowedPaths: spec.constraints.allowedPaths ?? null,
      baseCommits: spec.context.baseCommits ?? {},
    },
    declaredChecks: spec.constraints.checks ?? [],
    declaredLabChecks: spec.constraints.labChecks ?? [],
    hasOutputSchema: spec.constraints.outputSchema !== undefined,
    importance: {
      level: evaluation.importance.importance,
      requested: evaluation.importance.requested,
      reason: evaluation.importance.reason,
      source: formatImportanceSource(evaluation.importance.source),
      considered: evaluation.importance.considered.map((s) => `${formatImportanceSource(s)}=${s.importance}`),
    },
    verification: {
      level: evaluation.level,
      matrixLevel: evaluation.matrixLevel,
      rulesMatched: evaluation.rulesMatched,
      requiredChecks: [...new Set([...evaluation.checks, ...(spec.constraints.labChecks?.length ? ["ephemeral_lab_checks"] : [])])],
      review: evaluation.review,
      acceptance: evaluation.acceptance,
      strictAcceptor: policy.strict_acceptor,
      maxQualityRetries: policy.failure.max_quality_retries,
    },
    inputs: {
      tags: input.tags,
      requestedImportance: spec.importance ?? null,
      parent: input.parent ?? null,
      atLeast: spec.verification?.atLeast ?? null,
      addChecks: spec.verification?.addChecks ?? [],
    },
    budget: alloc.allocation,
    fingerprints: { rulebook: input.rulebookFingerprint, policy: evaluation.fingerprint },
    createdAt: input.now,
  });
  return { ok: true, contract, evaluation };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** Canonical JSON (sorted keys) of a contract: what is stored and hashed. */
export function canonicalContractJson(contract: AcceptanceContract): string {
  return JSON.stringify(canonical(contract));
}

export function contractDigest(contract: AcceptanceContract): string {
  return createHash("sha256").update(canonicalContractJson(contract)).digest("hex");
}

export interface StoredContract {
  contract: AcceptanceContract;
  sha256: string;
  createdAt: number;
}

/** Contracts are written once per task; a second, different contract or a changed row is refused. */
export class ContractStore {
  constructor(private readonly db: Db) {}

  /**
   * Store the task's contract. Saving the identical contract again returns the stored digest
   * (created: false); a different one throws `contract_immutable`.
   */
  save(contract: AcceptanceContract): { sha256: string; created: boolean } {
    const parsed = AcceptanceContractSchema.parse(contract);
    const json = canonicalContractJson(parsed);
    const sha256 = createHash("sha256").update(json).digest("hex");
    const existing = this.db.prepare("SELECT sha256 FROM task_contracts WHERE task_id = ?").get(parsed.taskId) as { sha256: string } | undefined;
    if (existing) {
      if (existing.sha256 !== sha256) throw new SwitchyardError("contract_immutable", `task ${parsed.taskId} already has a contract (${existing.sha256.slice(0, 12)}); contracts never change`);
      return { sha256, created: false };
    }
    this.db.prepare("INSERT INTO task_contracts (task_id, contract_json, sha256, created_at) VALUES (?, ?, ?, ?)").run(parsed.taskId, json, sha256, parsed.createdAt);
    return { sha256, created: true };
  }

  /** The stored contract, validated and checked against its digest (a mismatch throws). */
  get(taskId: string): StoredContract | null {
    const row = this.db.prepare("SELECT contract_json, sha256, created_at FROM task_contracts WHERE task_id = ?").get(taskId) as
      | { contract_json: string; sha256: string; created_at: number }
      | undefined;
    if (!row) return null;
    const actual = createHash("sha256").update(row.contract_json).digest("hex");
    if (actual !== row.sha256) throw new SwitchyardError("contract_corrupt", `task ${taskId} contract does not match its digest`);
    const contract = AcceptanceContractSchema.parse(JSON.parse(row.contract_json));
    return { contract, sha256: row.sha256, createdAt: row.created_at };
  }
}
