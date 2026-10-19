import { z } from "zod";
import { CheckNameSchema, ImportanceSchema, ProfileNameSchema, TierNameSchema, VerificationLevelSchema } from "../config/schema.js";
import { TagsSchema } from "../scoring/rulebook.js";

/**
 * File reference: `<alias>:<relative/path>` with an optional `#L<start>-L<end>` range.
 * Artifact reference: `artifact:<id>`.
 */
export const FILE_REF_RE = /^([A-Za-z0-9._-]+):([^#]+?)(?:#L(\d+)(?:-L(\d+))?)?$/;
export const ARTIFACT_REF_RE = /^artifact:([A-Za-z0-9_-]+)$/;

/** How a criterion is verified: by declared checks, by an independent review, or by cited evidence. */
export const CRITERION_VERIFY_KINDS = ["check", "review", "evidence"] as const;
export const CriterionVerifySchema = z.enum(CRITERION_VERIFY_KINDS);
export type CriterionVerify = z.infer<typeof CriterionVerifySchema>;

export const CRITERION_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

/** A criterion with a stable id. Plain-string criteria get ids c1..cn by position. */
export const AcceptanceCriterionSchema = z
  .object({
    id: z.string().regex(CRITERION_ID_RE),
    text: z.string().min(1).max(4000),
    verify: CriterionVerifySchema.optional(),
    /** Commands from constraints.checks that decide this criterion (verify: check). */
    checks: z.array(z.string().min(1)).min(1).max(10).optional(),
  })
  .strict();
export type AcceptanceCriterionInput = z.infer<typeof AcceptanceCriterionSchema>;

export const WorkerTaskSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
    idempotencyKey: z.string().min(1).max(200).optional(),
    profile: ProfileNameSchema,
    goal: z.string().min(1).max(20_000),
    repositoryAliases: z.array(z.string().min(1)).default([]),
    /** Coding tasks: the one repository the worker may edit; others are read-only context. */
    writableRepository: z.string().min(1).optional(),
    context: z
      .object({
        fileRefs: z.array(z.string().min(1)).optional(),
        artifactRefs: z.array(z.string().regex(ARTIFACT_REF_RE)).optional(),
        inlineText: z.string().max(400_000).optional(),
        baseCommits: z.record(z.string(), z.string().regex(/^[0-9a-f]{7,64}$/)).optional(),
      })
      .strict()
      .prefault({}),
    constraints: z
      .object({
        allowedPaths: z.array(z.string().min(1)).optional(),
        acceptanceCriteria: z.array(z.union([z.string().min(1), AcceptanceCriterionSchema])).min(1),
        outputSchema: z.record(z.string(), z.unknown()).optional(),
        /** Supervisor-supplied acceptance commands run in the task worktree (coding tasks). */
        checks: z.array(z.string().min(1)).max(10).optional(),
      })
      .strict(),
    /** How much the result matters (default verification.default_importance). Raises verification only. */
    importance: ImportanceSchema.optional(),
    /** Why; required for high and critical. */
    importanceReason: z.string().min(1).max(2000).optional(),
    /** Strengthen the verification policy for this task; it can never be weakened. */
    verification: z
      .object({
        atLeast: VerificationLevelSchema.optional(),
        addChecks: z.array(CheckNameSchema).max(10).optional(),
      })
      .strict()
      .optional(),
    dependsOn: z.array(z.string().min(1)).optional(),
    /** The supervising job (a supervise task) that dispatched this task. */
    parentTaskId: z.string().min(1).optional(),
    /** Short agent label used for the report file and commit identity. */
    label: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/).optional(),
    /** Brain context: the working document (effort) this task reports into, and extra grants. */
    brain: z
      .object({
        effort: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,80}$/).optional(),
        grants: z.array(z.object({ pattern: z.string().min(1), mode: z.enum(["read", "append", "write"]) }).strict()).max(20).optional(),
      })
      .strict()
      .optional(),
    /** Supervisor's own difficulty read; skips the classifier and can only raise the tier. */
    hints: z
      .object({
        difficulty: z.enum(["T1", "T2", "T3", "T4"]).optional(),
        tags: TagsSchema.partial().optional(),
      })
      .strict()
      .optional(),
    /** Routing constraints: a minimum tier, or one specific endpoint (still subject to hard checks). */
    routing: z
      .object({
        tier: TierNameSchema.optional(),
        endpointId: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    budget: z
      .object({
        maxModelRequests: z.number().int().positive().optional(),
        maxInputTokens: z.number().int().positive().optional(),
        maxOutputTokens: z.number().int().positive().optional(),
        maxPaidUsd: z.number().min(0).optional(),
        timeoutSeconds: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((t, ctx) => {
    if ((t.importance === "high" || t.importance === "critical") && !t.importanceReason) {
      ctx.addIssue({ code: "custom", path: ["importanceReason"], message: `importance ${t.importance} needs an importanceReason` });
    }
    const declared = new Set(t.constraints.checks ?? []);
    const seen = new Set<string>();
    t.constraints.acceptanceCriteria.forEach((c, i) => {
      const id = typeof c === "string" ? autoCriterionId(i) : c.id;
      if (seen.has(id)) ctx.addIssue({ code: "custom", path: ["constraints", "acceptanceCriteria", i], message: `criterion id ${id} is used more than once` });
      seen.add(id);
      if (typeof c === "string") return;
      for (const cmd of c.checks ?? []) {
        if (!declared.has(cmd)) ctx.addIssue({ code: "custom", path: ["constraints", "acceptanceCriteria", i, "checks"], message: `criterion ${c.id} names check "${cmd}", which is not in constraints.checks` });
      }
      if (c.verify === "check" && !c.checks?.length && !declared.size) {
        ctx.addIssue({ code: "custom", path: ["constraints", "acceptanceCriteria", i, "verify"], message: `criterion ${c.id} is verified by checks but the task declares none` });
      }
      if (c.checks?.length && c.verify && c.verify !== "check") {
        ctx.addIssue({ code: "custom", path: ["constraints", "acceptanceCriteria", i, "checks"], message: `criterion ${c.id} lists checks but verify is ${c.verify}` });
      }
    });
  });
export type WorkerTaskInput = z.input<typeof WorkerTaskSchema>;
export type WorkerTask = z.infer<typeof WorkerTaskSchema>;

/** Id given to the plain-string criterion at position `index` (0-based). */
export function autoCriterionId(index: number): string {
  return `c${index + 1}`;
}

/** A criterion as the contract, results, and verdicts see it. */
export interface Criterion {
  id: string;
  text: string;
  verify: CriterionVerify;
  /** The declared check commands that decide it (empty unless verify is "check"). */
  checks: string[];
}

/**
 * Normalise a task's criteria to ids. A plain string is decided by every declared check when
 * the task declares checks (today's all-or-none coding semantics), otherwise by evidence. An
 * object without `verify` is check-verified when it names checks, otherwise evidence-verified;
 * `verify: "check"` without `checks` means every declared check.
 */
export function criteria(spec: Pick<WorkerTask, "constraints">): Criterion[] {
  const declared = spec.constraints.checks ?? [];
  return spec.constraints.acceptanceCriteria.map((c, i) => {
    if (typeof c === "string") {
      return declared.length ? { id: autoCriterionId(i), text: c, verify: "check", checks: [...declared] } : { id: autoCriterionId(i), text: c, verify: "evidence", checks: [] };
    }
    const verify: CriterionVerify = c.verify ?? (c.checks?.length ? "check" : "evidence");
    return { id: c.id, text: c.text, verify, checks: verify === "check" ? [...(c.checks ?? declared)] : [] };
  });
}

/** Criterion texts in order, for prompts and display. */
export function criterionTexts(spec: Pick<WorkerTask, "constraints">): string[] {
  return spec.constraints.acceptanceCriteria.map((c) => (typeof c === "string" ? c : c.text));
}

export const TASK_STATES = [
  "queued",
  "waiting_for_dependencies",
  "waiting_for_capacity",
  "running",
  "cancel_requested",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "budget_exhausted",
] as const;
export type TaskState = (typeof TASK_STATES)[number];
export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
  "completed",
  "failed",
  "cancelled",
  "budget_exhausted",
]);
/** Interrupted is not terminal: it waits for an explicit resume or resolution. */
export function isTerminal(state: TaskState): boolean {
  return TERMINAL_STATES.has(state);
}

export const ExecutionStatusSchema = z.enum(["completed", "failed", "cancelled", "interrupted", "budget_exhausted"]);
export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;

export const UsageSchema = z
  .object({
    modelRequests: z.number().int().min(0),
    providerAttempts: z.number().int().min(0).nullable(),
    providerAttemptsExact: z.boolean(),
    tokenUsageBasis: z.enum(["provider_reported", "estimated", "unknown"]),
    batchId: z.string().nullable(),
    inputTokens: z.number().int().min(0).nullable(),
    outputTokens: z.number().int().min(0).nullable(),
    cachedInputTokens: z.number().int().min(0).nullable(),
    reportedCostUsd: z.number().min(0).nullable(),
    estimatedCostUsd: z.number().min(0).nullable(),
  })
  .strict();
export type Usage = z.infer<typeof UsageSchema>;

/** met: the contract's policy is satisfied. needs_supervisor: waiting for the job's supervisor (or a human). */
export const ACCEPTANCE_STATUSES = ["met", "unmet", "not_verified", "needs_supervisor"] as const;
export const AcceptanceStatusSchema = z.enum(ACCEPTANCE_STATUSES);
export type AcceptanceStatus = z.infer<typeof AcceptanceStatusSchema>;

/** Whether the policy's required verification ran and passed; separate from execution and acceptance. */
export const VERIFICATION_STATUSES = ["not_required", "pending", "passed", "failed", "inconclusive", "skipped_budget"] as const;
export const VerificationStatusSchema = z.enum(VERIFICATION_STATUSES);
export type VerificationStatus = z.infer<typeof VerificationStatusSchema>;

/**
 * Outcome of one named check. stale: bound to a different revision or artifact than the one
 * submitted. environment_failure: could not run (not a defect). unverified: nothing contradicts
 * the claim but nothing proves it. not_implemented: a required check this version cannot run.
 */
export const CHECK_OUTCOMES = ["passed", "failed", "not_applicable", "not_run", "stale", "environment_failure", "inconclusive", "unverified", "not_implemented"] as const;
export const CheckOutcomeSchema = z.enum(CHECK_OUTCOMES);
export type CheckOutcome = z.infer<typeof CheckOutcomeSchema>;

/** Outcome of one criterion. claimed: the author says met with evidence, unverified by anyone else. */
export const CRITERION_OUTCOMES = ["passed", "failed", "claimed", "unknown", "not_run", "stale", "environment_failure", "pending_review"] as const;
export const CriterionOutcomeSchema = z.enum(CRITERION_OUTCOMES);
export type CriterionOutcome = z.infer<typeof CriterionOutcomeSchema>;

export const SupervisorDecisionSchema = z
  .object({
    decision: z.enum(["accepted", "rejected"]),
    by: z.object({ kind: z.enum(["supervisor", "human"]), id: z.string().min(1).max(200) }).strict(),
    reason: z.string().max(4000).nullable(),
    at: z.number().int(),
  })
  .strict();
export type SupervisorDecision = z.infer<typeof SupervisorDecisionSchema>;

/** What verification found, recorded on the result. */
export const VerificationRecordSchema = z
  .object({
    level: VerificationLevelSchema,
    /** The contract's level when re-evaluation on the result raised it. */
    raisedFrom: VerificationLevelSchema.nullable(),
    importance: ImportanceSchema,
    importanceSource: z.string(),
    rulesMatched: z.array(z.string()),
    contractSha256: z.string().nullable(),
    policyFingerprint: z.string(),
    checks: z.array(z.object({ name: z.string(), required: z.boolean(), outcome: CheckOutcomeSchema, detail: z.string() }).strict()),
    criteria: z.array(
      z
        .object({
          id: z.string(),
          text: z.string(),
          verify: CriterionVerifySchema,
          outcome: CriterionOutcomeSchema,
          checks: z.array(z.string()),
          evidenceRefs: z.array(z.string()),
          note: z.string().optional(),
        })
        .strict(),
    ),
    reasons: z.array(z.string()),
    decisions: z.array(SupervisorDecisionSchema).default([]),
  })
  .strict();
export type VerificationRecord = z.infer<typeof VerificationRecordSchema>;

export const WorkerResultSchema = z
  .object({
    taskId: z.string(),
    executionStatus: ExecutionStatusSchema,
    acceptanceStatus: AcceptanceStatusSchema,
    /** Absent on results recorded before verification existed (read as not_required). */
    verificationStatus: VerificationStatusSchema.optional(),
    verification: VerificationRecordSchema.optional(),
    stopReason: z.string(),
    summary: z.string(),
    findings: z.array(z.object({ description: z.string(), evidenceRefs: z.array(z.string()) }).strict()),
    /** Structured payload when the task supplied an outputSchema. */
    data: z.unknown().optional(),
    artifactRefs: z.array(z.string()),
    patchRefs: z.array(z.string()),
    baseCommits: z.record(z.string(), z.string()),
    checks: z.array(
      z
        .object({
          command: z.string(),
          exitCode: z.number().int().nullable(),
          logRef: z.string(),
          /** Commit (or tree) sha the check ran against; a later revision invalidates it. */
          revision: z.string().nullable().optional(),
          /** sha256 of the patch or artifact the check ran against. */
          artifactDigest: z.string().optional(),
        })
        .strict(),
    ),
    unresolvedCriteria: z.array(z.string()),
    /** Ids of the criteria in unresolvedCriteria, in the same order (absent on older results). */
    unresolvedCriterionIds: z.array(z.string()).optional(),
    /** Coding results: changed paths, paths outside allowedPaths, and protected paths changed. */
    changedPaths: z.array(z.string()).optional(),
    scopeViolation: z.array(z.string()).optional(),
    protectedPathsChanged: z.array(z.string()).optional(),
    usage: UsageSchema,
    servedEndpoints: z.array(z.string()),
    classification: z
      .object({
        tier: z.string(),
        score: z.number(),
        basis: z.string(),
        rulebookVersion: z.string(),
        breakdown: z.array(z.object({ rule: z.string(), points: z.number(), detail: z.string() })),
      })
      .nullable()
      .default(null),
    routing: z
      .object({
        tier: z.string(),
        escalatedFrom: z.string().nullable(),
        attempts: z.array(z.object({ endpointId: z.string(), outcome: z.string() })),
      })
      .nullable()
      .default(null),
  })
  .strict();
export type WorkerResult = z.infer<typeof WorkerResultSchema>;

export function emptyUsage(): Usage {
  return {
    modelRequests: 0,
    providerAttempts: 0,
    providerAttemptsExact: true,
    tokenUsageBasis: "unknown",
    batchId: null,
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    reportedCostUsd: null,
    estimatedCostUsd: null,
  };
}
