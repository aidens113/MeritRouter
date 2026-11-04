import { z } from "zod";
import { AdmissionDenied } from "../core/errors.js";
import { ProfileNameSchema } from "../config/schema.js";
import type { Db } from "../storage/db.js";
import { paidTaskSetSpend } from "../paid/spend.js";

const money = z.number().finite().nonnegative();
const specSchema = z.object({ profile: ProfileNameSchema, parentTaskId: z.string().min(1).optional(),
  budget: z.object({ maxPaidUsd: money.optional() }).optional() });
const stored = z.object({ id: z.string().min(1), spec_json: z.string() });
const TREE_LIMIT = 4096;

function tree(db: Db, root: string, project: string): string[] {
  const rows = z.array(stored).parse(db.prepare(`WITH RECURSIVE tree(id) AS (
    SELECT id FROM tasks WHERE id=? AND project_id=? UNION
    SELECT t.id FROM tasks t JOIN tree p ON json_extract(t.spec_json,'$.parentTaskId')=p.id
    WHERE t.project_id=? LIMIT ${TREE_LIMIT + 1})
    SELECT t.id,t.spec_json FROM tree JOIN tasks t ON t.id=tree.id`).all(root, project, project));
  if (rows.length > TREE_LIMIT) throw new Error("job tree exceeds validated accounting bound");
  for (const row of rows) specSchema.parse(JSON.parse(row.spec_json));
  return rows.map(row => row.id);
}

function projectTreeSpend(db: Db, ids: string[]): number {
  const slots = ids.map(() => "?").join(",");
  const result = db.prepare(`SELECT
    COALESCE((SELECT SUM(COALESCE(p.actual_usd,p.liability_usd)) FROM project_request_spend p
      WHERE p.task_id IN (${slots})),0) +
    COALESCE((SELECT SUM(h.paid_usd) FROM project_request_holds h
      WHERE h.active=1 AND h.task_id IN (${slots}) AND NOT EXISTS(
        SELECT 1 FROM project_request_spend p WHERE p.request_id=h.request_id AND p.task_id=h.task_id)),0) usd`)
    .get(...ids, ...ids);
  return z.object({ usd: money }).parse(result).usd;
}

/** Caller owns the reservation/dispatch transaction. Submitted ancestry caps survive role changes. */
export function assertJobPaidBudget(db: Db, project: string, participants: Array<{ taskId: string }>,
  newPaidUsd: number, alreadyCounted: boolean, layout: "legacy" | "project", executionId?: string): void {
  try {
    money.parse(newPaidUsd);
    const ids = z.array(z.string().min(1)).max(256).parse(participants.map(part => part.taskId));
    if (!ids.length) {
      // Legacy Gate explicitly supports global, taskless requests. Prove that scope from the
      // actual execution rather than allowing a job to hide its members by omitting them.
      if (layout !== "legacy") throw new Error("project requests require owned participants");
      const id = z.string().min(1).max(500).parse(executionId);
      z.object({ status: z.literal("running") }).parse(db.prepare("SELECT status FROM executions WHERE id=?").get(id));
      if (db.prepare("SELECT 1 FROM execution_members WHERE execution_id=? LIMIT 1").get(id)) throw new Error("task-owned execution omitted its participants");
      return; // Global/key/balance limits still run in the existing accounting authority.
    }
    if (new Set(ids).size !== ids.length) throw new Error("duplicate request participant");
    const caps = new Map<string, { cap: number; participants: number }>();
    for (const id of ids) {
      const seen = new Set<string>();
      let next: string | undefined = id;
      while (next !== undefined) {
        if (seen.has(next) || seen.size >= 128) throw new Error("cyclic or excessive parent ancestry");
        seen.add(next);
        const row = stored.parse(db.prepare("SELECT id,spec_json FROM tasks WHERE id=? AND project_id=?").get(next, project));
        const spec = specSchema.parse(JSON.parse(row.spec_json));
        if (spec.budget?.maxPaidUsd !== undefined) {
          const entry = caps.get(row.id) ?? { cap: spec.budget.maxPaidUsd, participants: 0 };
          entry.participants++; caps.set(row.id, entry);
        }
        next = spec.parentTaskId;
      }
    }
    for (const [root, authority] of caps) {
      const descendants = tree(db, root, project);
      const used = layout === "project" ? projectTreeSpend(db, descendants) : paidTaskSetSpend(db, descendants, project);
      const extra = alreadyCounted ? 0 : newPaidUsd * authority.participants / ids.length;
      if (used + extra > authority.cap) throw new AdmissionDenied("paid_budget_exhausted",
        `job ${root} shared paid budget: $${used.toFixed(6)} held/spent + $${extra.toFixed(6)} exceeds submitted $${authority.cap}`, undefined, root);
    }
  } catch (error) {
    if (error instanceof AdmissionDenied) throw error;
    throw new AdmissionDenied("paid_budget_exhausted", "job paid budget accounting cannot validate same-project ancestry or exposure; reconcile retained accounting before paid dispatch", undefined, participants[0]?.taskId);
  }
}
