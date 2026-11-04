import { z } from "zod";
import { loadConfig, type ResolvedConfig } from "../config/load.js";
import type { Db } from "./db.js";
import { LeaseRefSchema } from "./lease-ref.js";

const RowSchema = z.object({
  id: z.string(), task_id: z.string(), value_json: z.string(), action_project: z.string(), project_id: z.string(),
  lease_owner: z.string(), run_count: z.number().int(), lease_incarnation: z.string(),
}).strict();
const ActionSchema = z.object({
  status: z.enum(["pending", "running", "completed", "denied", "cancelled", "uncertain"]),
}).passthrough();
const LiveActionSchema = z.object({
  status: z.enum(["pending", "running"]), decidedBy: z.string().nullable(),
  action: z.object({ lease: LeaseRefSchema }).passthrough(),
}).passthrough();

/** Read-only veto over exact live action generations. Caller owns the mutation transaction.
 * Never reconciles action records or expands the cancellation effect set to descendants.
 */
export function assertSupervisorCancelUnprotected(db: Db, cfg: ResolvedConfig, project: string, ids: readonly string[], now: number): void {
  if (!db.inTransaction) throw new Error("supervisor cancellation protection requires a transaction");
  const humanOnly = loadConfig(cfg.configPath).security.outside_repository === "human_only";
  for (const id of ids) {
    // Validate relevant JSON before filtering by action status/lease fields. Corrupt live
    // authority must not disappear through json_extract comparisons and authorize cancellation.
    const rows = db.prepare(`WITH RECURSIVE owned(id) AS (
      SELECT id FROM tasks WHERE id=? AND project_id=?
      UNION SELECT t.id FROM tasks t JOIN owned p ON json_extract(t.spec_json,'$.parentTaskId')=p.id WHERE t.project_id=?
    ) SELECT w.id,w.task_id,w.value_json,w.project_id AS action_project,t.project_id,t.lease_owner,t.run_count,t.lease_incarnation
      FROM worker_action_requests w JOIN tasks t ON t.id=w.task_id
      WHERE w.task_id IN(SELECT id FROM owned) AND t.project_id=?
        AND t.state='running' AND t.cancel_requested=0 AND t.lease_expires_at>?
        AND (t.deadline_at IS NULL OR t.deadline_at>?)`).all(id,project,project,project,now,now);
    for (const raw of rows) {
      const row = RowSchema.parse(raw);
      if (row.action_project !== row.project_id) throw new Error("worker action project authority mismatch");
      const value: unknown = JSON.parse(row.value_json);
      const status = ActionSchema.parse(value).status;
      if (status !== "pending" && status !== "running") continue;
      const action = LiveActionSchema.parse(value), lease = action.action.lease;
      if (lease.taskId !== row.task_id || lease.project !== row.project_id || lease.owner !== row.lease_owner || lease.runCount !== row.run_count || lease.incarnation !== row.lease_incarnation) continue;
      if (action.status === "pending" && humanOnly || action.status === "running" && action.decidedBy === "operator")
        throw new Error(`cannot cancel ${row.task_id}: protected exact worker action ${row.id} is ${action.status === "pending" ? "awaiting human approval" : "operator-approved and running"}; continue await_tasks. External operator cancellation and runtime deadlines remain authoritative.`);
    }
  }
}
