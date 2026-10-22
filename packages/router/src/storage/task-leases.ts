import { randomBytes } from "node:crypto";
import { z } from "zod";
import { TASK_STATES, WorkerResultSchema } from "../core/task.js";
import type { StoredTask } from "./tasks.js";
export const LEASE_RECEIPT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const RECOVERY_RECEIPT_WINDOW_MS = 5 * 60 * 1000;
export const LEASE_RECEIPT_CAPACITY = 100_000;
export const RECOVERY_RECEIPT_CAPACITY = 20_000;
export const RECOVERY_TOTAL_THRESHOLD = 80_000;
export const LeaseRefSchema = z.object({
  taskId: z.string().min(1).max(64), owner: z.string().min(1).max(200),
  runCount: z.number().int().positive(), project: z.string().max(200), incarnation: z.string().regex(/^[a-f0-9]{32}$/),
}).strict();
export type LeaseRef = Readonly<z.infer<typeof LeaseRefSchema>>;
export function capturedLease(task: StoredTask): LeaseRef {
  return Object.freeze(LeaseRefSchema.parse({
    taskId: task.row.id, owner: task.row.lease_owner,
    runCount: task.row.run_count, project: task.row.project_id, incarnation: task.row.lease_incarnation
  }));
}
export function leaseOperationId(now = Date.now()): string {
  return `tlease_${now.toString(36)}_${randomBytes(12).toString("hex")}`;
}
/** Recovery keys cannot become seven-day mutation authority after their shorter expiry. */
export function recoveryOperationId(now = Date.now()): string {
  return `trecover_${now.toString(36)}_${randomBytes(12).toString("hex")}`;
}
const recoveryId = z.string().regex(/^trecover_[a-z0-9]{1,12}_[a-f0-9]{24}$/);
const operationId = z.string().regex(/^tlease_[a-z0-9]{1,12}_[a-f0-9]{24}$/);
const json: z.ZodType<unknown> = z.lazy(() => z.union([z.null(), z.boolean(), z.string(), z.number().finite(), z.array(json), z.record(z.string(), json)]));
const identity = {
  lease: LeaseRefSchema, operationId
};
export const RenewLeaseSchema = z.object(identity).strict();
export const FinishLeaseSchema = z.object({
  ...identity,
  state: z.enum(["completed", "failed", "cancelled", "budget_exhausted", "interrupted"]),
  result: WorkerResultSchema,
}).strict().superRefine((value, ctx) => {
  if (!json.safeParse(value.result).success)
    ctx.addIssue({
      code: "custom", message: "finish result must contain JSON data only"
    });
  if (value.result.taskId !== value.lease.taskId || value.result.executionStatus !== value.state)
    ctx.addIssue({
      code: "custom", message: "finish result must match its lease task and terminal state"
    });
});
export const InterruptLeaseSchema = z.object({
  ...identity, reason: z.string().min(1).max(2000), resume: z.boolean().default(false), sessionId: z.string().optional()
}).strict();
export const DeferLeaseSchema = z.object({
  ...identity, nextAttemptAt: z.number().int().nonnegative(), reason: z.string().min(1).max(2000)
}).strict();
export const RecoverLeasesSchema = z.object({
  operationId: recoveryId, mode: z.enum(["expired_only", "startup"])
}).strict();
export const CancelTargetSchema = LeaseRefSchema.pick({
  taskId: true, incarnation: true, runCount: true
}).extend({ runCount: z.number().int().nonnegative() }).strict();
export const CancelLeasesSchema = z.object({
  operationId, project: z.string(), targets: z.array(CancelTargetSchema).min(1).max(500),
  actor: z.enum(["control", "supervisor"]), actorLease: LeaseRefSchema.optional(),
}).strict();
const disposition = z.enum(["applied", "replayed", "stale", "expired", "not_active", "cancel_requested", "deadline_exceeded"]);
export const LeaseReceiptSchema = z.object({
  operationId: z.union([operationId, recoveryId]), kind: z.enum(["renew", "finish", "interrupt", "defer", "recover", "cancel"]),
  disposition, original: disposition.exclude(["replayed"]), serverNow: z.number().int().nonnegative(),
  lease: LeaseRefSchema.optional(), leaseExpiresAt: z.number().int().nonnegative().nullable().optional(),
  state: z.enum(TASK_STATES).optional(),
  resultDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  affected: z.array(z.object({
    target: CancelTargetSchema, owner: z.string().nullable(), state: z.union([z.enum(TASK_STATES), z.literal("unknown")])
  }).strict()).max(1000).default([]),
}).strict().superRefine((value, ctx) => {
  if ((value.kind === "recover") !== value.operationId.startsWith("trecover_"))
    ctx.addIssue({ code: "custom", message: "task lease receipt key must match its operation kind" });
});
export type LeaseReceipt = z.infer<typeof LeaseReceiptSchema>;
export interface TaskLeases {
  renew(input: z.input<typeof RenewLeaseSchema>): Promise<LeaseReceipt>;
  finish(input: z.input<typeof FinishLeaseSchema>): Promise<LeaseReceipt>;
  interrupt(input: z.input<typeof InterruptLeaseSchema>): Promise<LeaseReceipt>;
  defer(input: z.input<typeof DeferLeaseSchema>): Promise<LeaseReceipt>;
  recover(input: z.input<typeof RecoverLeasesSchema>): Promise<LeaseReceipt>;
  cancel(input: z.input<typeof CancelLeasesSchema>): Promise<LeaseReceipt>;
  drain(): Promise<void>;
}
/** One bounded replay reconciles a possibly committed acknowledgement; it never retries model work. */
export async function reconcileLeaseOperation(call: () => Promise<LeaseReceipt>): Promise<LeaseReceipt> {
  try {
    return LeaseReceiptSchema.parse(await call());
  }
  catch {
    return LeaseReceiptSchema.parse(await call());
  }
}
export function receiptApplied(receipt: LeaseReceipt): boolean {
  return receipt.disposition === "applied" || (receipt.disposition === "replayed" && receipt.original === "applied");
}
