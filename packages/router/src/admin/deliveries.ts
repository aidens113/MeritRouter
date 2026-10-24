import type { MeritRouter } from "../core/service.js";
import { ProductDeliveries } from "../verification/product-delivery.js";
import { z } from "zod";
import { TASK_STATES } from "../core/task.js";

export const ProjectDeliveryReportInputSchema = z.object({
  project: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(100).default(25),
  after: z.string().min(1).max(200).optional(),
}).strict();

/** Bounded metadata only. Readiness describes stored evidence, not freshly inspected Git/Lab state. */
export function projectDeliveryReport(sy: MeritRouter, input: unknown) {
  const { project, limit, after } = ProjectDeliveryReportInputSchema.parse(input);
  sy.projects.require(project);
  const rows = z.array(z.object({ task_id: z.string().min(1).max(200), state: z.enum(TASK_STATES) }).strict()).max(limit + 1).parse(
    sy.db.prepare("SELECT d.task_id,t.state FROM product_deliveries d JOIN tasks t ON t.id=d.task_id AND t.project_id=d.project_id WHERE d.project_id=? AND d.task_id>? ORDER BY d.task_id LIMIT ?").all(project, after ?? "", limit + 1),
  );
  const store = new ProductDeliveries(sy.db);
  const deliveries = rows.slice(0, limit).map(row => {
    const status = store.status(row.task_id, project)!;
    const reasons: string[] = [];
    if (!status.candidate) reasons.push("candidate_missing");
    if (status.readiness?.status === "blocked") reasons.push(...status.readiness.blockers.map(blocker => blocker.code));
    if (status.finalDecision?.decision === "reject") reasons.push("final_rejected");
    else if (!status.finalDecision) reasons.push("final_decision_pending");
    else if (!status.accepted) reasons.push("historical_acceptance_invalid");
    const effectiveAccepted = status.accepted && row.state === "completed";
    if (status.accepted && !effectiveAccepted) reasons.push("task_not_completed");
    return {
      taskId: row.task_id, taskState: row.state, stage: status.stage,
      readiness: status.readiness?.status ?? "candidate_missing",
      historicalFinalDecision: status.finalDecision?.decision ?? null,
      effectiveAccepted, needsAttention: !effectiveAccepted,
      reasons: [...new Set(reasons)].slice(0, 10),
    };
  });
  return { project, freshness: "stored_candidate_and_evidence" as const, sourceRevalidated: false as const,
    deliveries, nextAfter: rows.length > limit ? deliveries.at(-1)!.taskId : null };
}

/** Project-scoped read model shared by the panel and external clients. */
export function deliveryView(sy:MeritRouter,taskId:string,project:string){
  const task=sy.tasks.get(taskId);
  if(!task||task.row.project_id!==project)return null;
  return new ProductDeliveries(sy.db).status(taskId,project);
}
