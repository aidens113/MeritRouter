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
} from "../config/schema.js";
import { SwitchyardError } from "../core/errors.js";
import { criteria, CriterionVerifySchema, type WorkerTask } from "../core/task.js";
import { TagsSchema, type Tags } from "../scoring/rulebook.js";
import type { Db } from "../storage/db.js";
import { formatImportanceSource } from "./importance.js";
import { declaredPaths } from "./match.js";
import { evaluatePolicy, type PolicyEvaluation } from "./policy.js";

const count = z.number().int().min(0);

/** Model requests reserved per purpose out of the task's total. */
export const BudgetAllocationSchema = z
  .object({
    /** The task's total request cap across every tier and purpose. */
    total: count,
    /** Already spent classifying the task when the contract was compiled. */
    classification: count,
    /** What the agent loop may use for the first run. */
    execution: count,
    /** Reserved for independent review (deep and strict). */
    review: count,
    /** Reserved for quality retries (repairs). */
    repair: count,
    /** Left over within the total. */
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
  /** The task's total cap across tiers: effectiveBudget(cfg, spec, null).maxModelRequests. */
  total: number;
  /** The run's cap at the contract tier: effectiveBudget(cfg, spec, tier).maxModelRequests. */
  tierExecution: number;
  /** The cap at the next tier (repair runs there), or null at T3. */
  nextTierExecution: number | null;
  /** Requests already charged to the task for classification. */
  classificationUsed: number;
}

export type AllocationResult =
  | { ok: true; allocation: BudgetAllocation }
  | { ok: false; needed: number; available: number };

/**
 * Reserve requests out of the total, in priority order: classification (already spent), review
 * (required by the level; never dropped), execution (up to the tier cap), then repair (up to
 * max_quality_retries x the per-retry amount, from what is left). The level is never lowered to
 * fit: when classification + review + one execution request exceed the total, it fails.
 */
export function allocateBudget(policy: VerificationConfig, ev: Pick<PolicyEvaluation, "level" | "review">, b: BudgetInput): AllocationResult {
  const review = ev.review.required ? (policy.budget.review_requests[ev.level] ?? 0) : 0;
  const needed = b.classificationUsed + review + 1;
  if (needed > b.total) return { ok: false, needed, available: b.total };
  const execution = Math.min(b.tierExecution, b.total - b.classificationUsed - review);
  const perRetry = typeof policy.budget.repair_requests === "number" ? policy.budget.repair_requests : (b.nextTierExecution ?? b.tierExecution);
  const repair = Math.max(0, Math.min(policy.failure.max_quality_retries * perRetry, b.total - b.classificationUsed - review - execution));
  return {
    ok: true,
    allocation: { total: b.total, classification: b.classificationUsed, execution, review, repair, unallocated: b.total - b.classificationUsed - review - execution - repair },
  };
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
  const alloc = allocateBudget(policy, evaluation, input.budget);
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
      requiredChecks: evaluation.checks,
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
