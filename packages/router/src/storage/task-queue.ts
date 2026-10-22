import { z } from "zod";
import { ProfileNameSchema, TierNameSchema } from "../config/schema.js";
import { TASK_STATES, WorkerTaskSchema, WorkerResultSchema } from "../core/task.js";

const timestamp = z.number().int().nonnegative();
const json: z.ZodType<unknown> = z.lazy(() => z.union([z.null(), z.boolean(), z.string(), z.number().finite(), z.array(json), z.record(z.string(), json)]));
export const TaskAttemptSchema = z.object({ taskId: z.string().min(1), runCount: z.number().int().positive() }).strict();
export type TaskAttempt = z.infer<typeof TaskAttemptSchema>;
export const QueueClaimSchema = z.object({ owner: z.string().min(1) }).strict();
export const QueueCompanionsSchema = z.object({ owner: z.string().min(1), leader: TaskAttemptSchema, excludeTaskIds: z.array(z.string().min(1)) }).strict();
export type QueueClaim = z.infer<typeof QueueClaimSchema>;
export type QueueCompanions = z.infer<typeof QueueCompanionsSchema>;

/** SQLite nullable fields remain explicit; no database handle or policy callback crosses the port. */
export const StoredTaskDTOSchema = z.object({
  row: z.object({
    id: z.string().min(1), idempotency_key: z.string().nullable(), spec_hash: z.string(),
    tier: TierNameSchema.nullable(), classification_json: z.string().nullable(), purpose: z.string(),
    profile: ProfileNameSchema, spec_json: z.string(), state: z.enum(TASK_STATES), state_reason: z.string().nullable(),
    created_at: timestamp, updated_at: timestamp, started_at: timestamp.nullable(), deadline_at: timestamp.nullable(),
    finished_at: timestamp.nullable(), lease_owner: z.string().nullable(), lease_expires_at: timestamp.nullable(),
    run_count: z.number().int().nonnegative(), cancel_requested: z.union([z.literal(0), z.literal(1)]),
    next_attempt_at: timestamp.nullable(), writable_repo: z.string().nullable(), result_json: z.string().nullable(), project_id: z.string(),
  }).strict(),
  spec: WorkerTaskSchema,
  result: WorkerResultSchema.nullable(),
}).strict().superRefine((value, ctx) => {
  if (!json.safeParse(value).success) ctx.addIssue({ code: "custom", message: "queue receipts must contain JSON data only" });
  if (value.row.profile !== value.spec.profile || (value.spec.id && value.spec.id !== value.row.id)) ctx.addIssue({ code: "custom", message: "queue task identity does not match its stored row" });
});
export const QueueTasksSchema = z.array(StoredTaskDTOSchema);
export type StoredTaskDTO = z.infer<typeof StoredTaskDTOSchema>;

/** Async claim prerequisite only: renewal, recovery and finish still use synchronous TaskStore. */
export interface TaskQueue {
  claim(input: QueueClaim): Promise<StoredTaskDTO[]>;
  claimCompanions(input: QueueCompanions): Promise<StoredTaskDTO[]>;
}
