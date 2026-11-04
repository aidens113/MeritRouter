import { z } from "zod";
import type { Db } from "../storage/db.js";
import { ReserveRequestDTOSchema } from "../admission/request-ledger.js";
import { TASK_STATES } from "../core/task.js";
import { createHash } from "node:crypto";
import { canonicalJson } from "../storage/tasks.js";

export interface RequestLifecycle {
  activity: "active_owner" | "owner_lost" | "unknown";
  activityReason: string;
}
const requestSchema = z.object({ id: z.string().min(1).max(120), execution_id: z.string().min(1).max(500),
  project_id: z.string().max(200), status: z.enum(["reserved", "succeeded", "failed", "uncertain"]),
  finished_at: z.number().finite().nullable() });
const bindingRow = z.object({ binding_json: z.string().max(262144), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) });
const chargeRow = z.object({ task_id: z.string(), lease_incarnation: z.string().nullable(), run_count: z.number().int().nullable() });
const ownerRow = z.object({ state: z.enum(TASK_STATES), lease_owner: z.string().nullable(), lease_expires_at: z.number().finite().nullable(),
  lease_incarnation: z.string(), run_count: z.number().int().nonnegative() });
const unknown = (activityReason: string): RequestLifecycle => ({ activity: "unknown", activityReason });

/** Accounting state is unchanged: a lost local owner never proves remote non-consumption. */
export function requestLifecycle(db: Db, raw: unknown, now = Date.now()): RequestLifecycle {
  try {
    const request = requestSchema.parse(raw);
    z.number().finite().nonnegative().parse(now);
    if (request.status !== "reserved" || request.finished_at !== null) return unknown("The recorded request outcome is already available.");
    const project = bindingRow.optional().parse(db.prepare("SELECT binding_json,fingerprint FROM project_request_protocol WHERE request_id=? AND project_id=?").get(request.id, request.project_id));
    const legacy = bindingRow.optional().parse(db.prepare("SELECT binding_json,fingerprint FROM request_protocol WHERE request_id=?").get(request.id));
    if (Number(!!project) + Number(!!legacy) !== 1) return unknown("A unique persisted request-owner binding is unavailable.");
    const persisted = (project ?? legacy)!;
    const binding = ReserveRequestDTOSchema.parse(JSON.parse(persisted.binding_json));
    if (createHash("sha256").update(canonicalJson(binding)).digest("hex") !== persisted.fingerprint) return unknown("The persisted request-owner binding fingerprint is inconsistent.");
    if (binding.requestId !== request.id || binding.executionId !== request.execution_id
      || binding.participants.some(part => part.lease.project !== request.project_id)) return unknown("The persisted request-owner identity does not match this project request.");
    if (!binding.participants.length) return unknown("This taskless request has no captured task-owner lease.");
    const ids = new Set(binding.participants.map(part => part.taskId));
    if (ids.size !== binding.participants.length) return unknown("The persisted request-owner participants are ambiguous.");
    const charges = z.array(chargeRow).max(256).parse(db.prepare(`SELECT c.task_id,c.lease_incarnation,c.run_count FROM request_charges c
      JOIN tasks t ON t.id=c.task_id WHERE c.request_id=? AND t.project_id=? LIMIT 257`).all(request.id, request.project_id));
    const total = z.object({ n: z.number().int().nonnegative() }).parse(db.prepare("SELECT COUNT(*) n FROM request_charges WHERE request_id=?").get(request.id)).n;
    if (total !== charges.length || charges.length !== binding.participants.length || binding.participants.some(part =>
      !charges.some(charge => charge.task_id === part.taskId && charge.lease_incarnation === part.lease.incarnation && charge.run_count === part.lease.runCount)))
      return unknown("Captured request charges cannot establish exclusive owner generation and scope.");
    let live = false;
    for (const part of binding.participants) {
      const current = ownerRow.optional().parse(db.prepare(`SELECT state,lease_owner,lease_expires_at,lease_incarnation,run_count
        FROM tasks WHERE id=? AND project_id=?`).get(part.taskId, request.project_id));
      if (!current) return unknown("An original request participant is unavailable in its owning project.");
      live ||= ["running", "cancel_requested"].includes(current.state) && current.lease_owner === part.lease.owner
        && current.lease_incarnation === part.lease.incarnation && current.run_count === part.lease.runCount
        && current.lease_expires_at !== null && current.lease_expires_at > now;
    }
    return live ? { activity: "active_owner", activityReason: "The exact captured task-owner generation still holds an active lease; the provider outcome is pending." }
      : { activity: "owner_lost", activityReason: "The captured local task owner no longer holds its request lease. The remote outcome remains unknown; accounting reconciliation may be pending." };
  } catch {
    return unknown("Request-owner evidence is missing, malformed or unreadable; active execution cannot be established.");
  }
}

/** Clock-sensitive invalidation only, never a financial outcome or owner classification. */
export function requestLeaseActivityMark(db: Db, project: string, now: number): [number, number, number] {
  z.string().max(200).parse(project); z.number().finite().nonnegative().parse(now);
  const result = db.prepare(`SELECT COUNT(*) n,COALESCE(SUM(CASE WHEN t.state IN ('running','cancel_requested')
      AND t.lease_owner IS NOT NULL AND t.lease_incarnation=c.lease_incarnation AND t.run_count=c.run_count
      AND t.lease_expires_at>? THEN 1 ELSE 0 END),0) live,
    MIN(CASE WHEN t.state IN ('running','cancel_requested') AND t.lease_owner IS NOT NULL
      AND t.lease_incarnation=c.lease_incarnation AND t.run_count=c.run_count
      AND t.lease_expires_at>? THEN t.lease_expires_at ELSE NULL END) nextExpiry
    FROM model_requests r JOIN request_charges c ON c.request_id=r.id JOIN tasks t ON t.id=c.task_id
    WHERE r.project_id=? AND t.project_id=? AND r.status='reserved' AND r.finished_at IS NULL`).get(now, now, project, project);
  const parsed = z.object({ n: z.number().int().nonnegative(), live: z.number().int().nonnegative(), nextExpiry: z.number().finite().nullable() }).parse(result);
  return [parsed.n, parsed.live, parsed.nextExpiry ?? 0];
}
