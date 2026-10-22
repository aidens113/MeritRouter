import { z } from "zod";
import { LabNameSchema, LabRecipeSchema } from "./recipe.js";
import { LabCheckResultSchema } from "./checks.js";
export const TaskAttemptIdSchema = z.string().regex(/^twa_[a-z0-9]+$/);
export const TaskAttemptHandleSchema = z.object({
  id: TaskAttemptIdSchema, taskId: z.string().min(1), project: z.string().min(1),
  runCount: z.number().int().positive(), leaseOwner: z.string().min(1), executionId: z.string().min(1),
}).strict();
export type TaskAttemptHandle = z.infer<typeof TaskAttemptHandleSchema>;
export const TaskAttemptRepositorySchema = z.object({
  alias: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/), sourcePath: z.string().min(1),
  baseCommit: z.string().regex(/^[a-f0-9]{40,64}$/), head: z.string().regex(/^[a-f0-9]{40,64}$/),
  commonDirectory: z.string().min(1),
}).strict();
export const RegisterTaskAttemptSchema = z.object({
  taskId: z.string().min(1), project: z.string().min(1), runCount: z.number().int().positive(),
  leaseOwner: z.string().min(1), executionId: z.string().min(1).max(200), sessionId: z.string().min(1),
  sourceWorktree: z.string().min(1), writableAlias: z.string().min(1),
  repositories: z.array(TaskAttemptRepositorySchema.omit({ commonDirectory: true })).min(1).max(32),
}).strict();
export type RegisterTaskAttempt = z.input<typeof RegisterTaskAttemptSchema>;
export const SubmitTaskAttemptSchema = z.object({ commit: z.string().regex(/^[a-f0-9]{40,64}$/), tree: z.string().regex(/^[a-f0-9]{40,64}$/), patchDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable() }).strict();
export const TaskLabEvidenceSchema = z.object({
  schemaVersion: z.literal(1), attemptId: TaskAttemptIdSchema, labId: z.string(),
  heads: z.record(z.string(), z.string().regex(/^[a-f0-9]{40,64}$/)), submittedCommit: z.string().regex(/^[a-f0-9]{40,64}$/), submittedTree: z.string().regex(/^[a-f0-9]{40,64}$/),
  patchDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(), recipeDigest: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(["passed", "failed", "environment_failure", "cancelled"]), cleanup: z.enum(["complete", "blocked"]),
  checks: z.array(LabCheckResultSchema.extend({ stdout: z.string().max(65536), stderr: z.string().max(65536) })).max(10), error: z.string().max(2000).nullable(),
}).strict();
export type TaskLabEvidence = z.infer<typeof TaskLabEvidenceSchema>;
export const TaskAttemptRecordSchema = TaskAttemptHandleSchema.extend({
  sourceWorktree: z.string(), writableAlias: z.string(), repositories: z.array(TaskAttemptRepositorySchema).min(1).max(32),
  submittedCommit: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(), submittedTree: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(), patchDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  state: z.enum(["working", "submitted", "closed"]), createdAt: z.number().int(),
}).strict();
export type TaskAttemptRecord = z.infer<typeof TaskAttemptRecordSchema>;
export const TaskLabRecordSchema = z.object({
  attemptId: TaskAttemptIdSchema, labId: z.string().nullable(), desiredState: z.enum(["running", "stopped"]),
  phase: z.enum(["queued", "creating", "starting", "checking", "stopping", "retained", "cleanup_blocked", "pruned"]),
  checks: z.array(LabNameSchema).min(1).max(10), recipe: LabRecipeSchema, recipeDigest: z.string(), deadlineAt: z.number().int(),
  result: TaskLabEvidenceSchema.nullable(), cleanupError: z.string().nullable(), createdAt: z.number().int(), updatedAt: z.number().int(),
}).strict();
export type TaskLabRecord = z.infer<typeof TaskLabRecordSchema>;
