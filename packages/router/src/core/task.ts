import { z } from "zod";
import { ProfileNameSchema } from "../config/schema.js";

/**
 * File reference: `<alias>:<relative/path>` with an optional `#L<start>-L<end>` range.
 * Artifact reference: `artifact:<id>`.
 */
export const FILE_REF_RE = /^([A-Za-z0-9._-]+):([^#]+?)(?:#L(\d+)(?:-L(\d+))?)?$/;
export const ARTIFACT_REF_RE = /^artifact:([A-Za-z0-9_-]+)$/;

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
        acceptanceCriteria: z.array(z.string().min(1)).min(1),
        outputSchema: z.record(z.string(), z.unknown()).optional(),
        /** Supervisor-supplied acceptance commands run in the task worktree (coding tasks). */
        checks: z.array(z.string().min(1)).max(10).optional(),
      })
      .strict(),
    dependsOn: z.array(z.string().min(1)).optional(),
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
  .strict();
export type WorkerTaskInput = z.input<typeof WorkerTaskSchema>;
export type WorkerTask = z.infer<typeof WorkerTaskSchema>;

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

export const WorkerResultSchema = z
  .object({
    taskId: z.string(),
    executionStatus: ExecutionStatusSchema,
    acceptanceStatus: z.enum(["met", "unmet", "not_verified"]),
    stopReason: z.string(),
    summary: z.string(),
    findings: z.array(z.object({ description: z.string(), evidenceRefs: z.array(z.string()) }).strict()),
    /** Structured payload when the task supplied an outputSchema. */
    data: z.unknown().optional(),
    artifactRefs: z.array(z.string()),
    patchRefs: z.array(z.string()),
    baseCommits: z.record(z.string(), z.string()),
    checks: z.array(
      z.object({ command: z.string(), exitCode: z.number().int().nullable(), logRef: z.string() }).strict(),
    ),
    unresolvedCriteria: z.array(z.string()),
    usage: UsageSchema,
    servedEndpoints: z.array(z.string()),
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
