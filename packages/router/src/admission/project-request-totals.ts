import { z } from "zod";
import type { Db } from "../storage/db.js";

const nonnegative = z.number().finite().nonnegative();
/** Active preparation is counted until the same local transaction installs ordinary request charges. */
export function preparedTaskTotals(db: Db, taskId: string): { requests: number; inputTokens: number; outputTokens: number; paidUsd: number } {
  return z.object({ requests: nonnegative.int(), inputTokens: nonnegative.int(), outputTokens: nonnegative.int(), paidUsd: nonnegative }).strict().parse(
    db.prepare(`SELECT COUNT(*) AS requests,COALESCE(SUM(input_tokens),0) AS inputTokens,COALESCE(SUM(output_tokens),0) AS outputTokens,
      COALESCE(SUM(paid_usd),0) AS paidUsd FROM project_request_holds WHERE task_id=? AND active=1`).get(z.string().min(1).parse(taskId)));
}
export function taskRequestsIncludingPreparations(db: Db, taskId: string): number {
  const charged = z.object({ n: nonnegative.int() }).strict().parse(db.prepare("SELECT COUNT(*) AS n FROM request_charges WHERE task_id=?").get(taskId)).n;
  return charged + preparedTaskTotals(db, taskId).requests;
}
export function projectTaskPaidSpend(db: Db, taskId: string): number {
  const bound = z.object({ usd: nonnegative }).strict().parse(db.prepare(`SELECT COALESCE(SUM(COALESCE(actual_usd,liability_usd)),0) AS usd
    FROM project_request_spend WHERE task_id=?`).get(taskId)).usd;
  return bound + preparedTaskTotals(db, taskId).paidUsd;
}
export function preparedTaskPurposes(db: Db, taskId: string): Array<{ purpose: string; n: number }> {
  return z.array(z.object({ purpose: z.string(), n: nonnegative.int() }).strict()).parse(db.prepare(`SELECT json_extract(p.binding_json,'$.purpose') AS purpose,COUNT(*) AS n
    FROM project_request_holds h JOIN project_request_protocol p ON p.request_id=h.request_id
    WHERE h.task_id=? AND h.active=1 GROUP BY purpose`).all(taskId));
}
