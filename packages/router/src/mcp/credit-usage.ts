import { z } from "zod";
import type { MeritRouter } from "../core/service.js";
import type { ProjectRuntimeStore } from "../projects/runtime-store.js";
import type { ResolvedConfig } from "../config/load.js";

const money = z.number().finite().nonnegative();
const taskRow = z.object({ id: z.string(), spec_json: z.string() });
const taskBudget = z.object({ budget: z.object({ maxPaidUsd: money.optional() }).optional() });
const row = z.object({ id: z.string(), status: z.string(), reported: money.nullable(), estimated: money.nullable(),
  selected: z.number().int().positive(), participants: z.number().int().positive(),
  legacy_reserved: money.nullable(), legacy_actual: money.nullable(), legacy_basis: z.string().nullable(),
  projected: z.number().int().nonnegative(), projected_settled: money, projected_open: money });
const preparation = z.object({ id: z.string(), usd: money });
const TREE_LIMIT = 4096, REQUEST_LIMIT = 20000, JOB_LIMIT = 64;
const treeSql = `WITH RECURSIVE tree(id) AS (
  SELECT id FROM tasks WHERE id=? AND project_id=?
  UNION SELECT t.id FROM tasks t JOIN tree p ON json_extract(t.spec_json,'$.parentTaskId')=p.id
  WHERE t.project_id=? LIMIT ${TREE_LIMIT + 1})`;

export interface JobCreditUsage {
  jobId: string; settledUsd: number; outstandingUsd: number; exposureUsd: number;
  unpricedRequests: number; rootTaskCapUsd: number | null; incomplete: boolean;
}

/** Owning task/charge bindings authorize the scope; stale descriptive project labels cannot hide spend. */
export function jobCreditUsage(stores: ProjectRuntimeStore, project: string, jobId: string): JobCreditUsage | null {
  if (stores.project !== project) throw new Error("credit_usage_project_mismatch");
  const root = taskRow.nullable().parse(stores.db.prepare("SELECT id,spec_json FROM tasks WHERE id=? AND project_id=?").get(jobId, project) ?? null);
  if (!root) return null;
  const budget = taskBudget.parse(JSON.parse(root.spec_json));
  const args = [jobId, project, project];
  const count = z.object({ n: z.number().int().nonnegative() }).parse(stores.db.prepare(`${treeSql} SELECT COUNT(*) n FROM tree`).get(...args)).n;
  const rows = z.array(row).parse(stores.db.prepare(`${treeSql}, selected AS (
      SELECT c.request_id,COUNT(*) n FROM request_charges c JOIN tree ON tree.id=c.task_id
      JOIN tasks t ON t.id=c.task_id WHERE t.project_id=? GROUP BY c.request_id),
    projected AS (SELECT p.request_id,COUNT(*) n,
      SUM(CASE WHEN p.actual_usd IS NOT NULL AND r.status!='uncertain' THEN p.actual_usd ELSE 0 END) settled,
      SUM(CASE WHEN p.actual_usd IS NULL OR r.status='uncertain' THEN MAX(COALESCE(p.actual_usd,0),p.liability_usd) ELSE 0 END) open
      FROM project_request_spend p JOIN tree ON tree.id=p.task_id JOIN model_requests r ON r.id=p.request_id
      GROUP BY p.request_id)
    SELECT r.id,r.status,r.reported_cost_usd reported,r.estimated_cost_usd estimated,s.n selected,
      (SELECT COUNT(*) FROM request_charges c WHERE c.request_id=r.id) participants,
      old.reserved_usd legacy_reserved,old.actual_usd legacy_actual,old.cost_basis legacy_basis,
      COALESCE(p.n,0) projected,COALESCE(p.settled,0) projected_settled,COALESCE(p.open,0) projected_open
    FROM selected s JOIN model_requests r ON r.id=s.request_id
    LEFT JOIN projected p ON p.request_id=r.id LEFT JOIN paid_spend old ON old.request_id=r.id
    ORDER BY r.id LIMIT ${REQUEST_LIMIT + 1}`).all(...args, project));
  let settled = 0, outstanding = 0, unpriced = 0;
  const seen = new Set<string>();
  const projectedRequests = new Set<string>();
  for (const r of rows.slice(0, REQUEST_LIMIT)) {
    seen.add(r.id);
    if (r.projected) {
      projectedRequests.add(r.id); settled += r.projected_settled; outstanding += r.projected_open;
      if (r.projected < r.selected) unpriced++; // Partial participant accounting cannot establish a complete cost.
      continue;
    }
    const share = r.selected / r.participants;
    const amount = r.legacy_actual ?? r.legacy_reserved ?? r.reported ?? r.estimated;
    if (amount === null) { unpriced++; continue; }
    const uncertain = r.status === "reserved" || r.status === "uncertain" || r.legacy_basis === "uncertain"
      || r.legacy_reserved !== null && r.legacy_actual === null;
    if (uncertain) outstanding += Math.max(amount, r.legacy_reserved ?? 0) * share;
    else settled += amount * share;
  }
  // An active preparation precedes model_requests. Exclude already projected participants.
  const holds = z.array(preparation).parse(stores.db.prepare(`${treeSql}
    SELECT h.request_id id,SUM(h.paid_usd) usd FROM project_request_holds h JOIN tree ON tree.id=h.task_id
    WHERE h.active=1 AND NOT EXISTS(
      SELECT 1 FROM project_request_spend p WHERE p.request_id=h.request_id AND p.task_id=h.task_id)
    GROUP BY h.request_id ORDER BY h.request_id LIMIT ${REQUEST_LIMIT + 1}`).all(...args));
  for (const h of holds.slice(0, REQUEST_LIMIT)) if (!seen.has(h.id) || projectedRequests.has(h.id)) outstanding += h.usd;
  return { jobId, settledUsd: settled, outstandingUsd: outstanding, exposureUsd: settled + outstanding,
    unpricedRequests: unpriced, rootTaskCapUsd: budget.budget?.maxPaidUsd ?? null,
    incomplete: count > TREE_LIMIT || rows.length > REQUEST_LIMIT || holds.length > REQUEST_LIMIT };
}

/** Per-connection high-water marks; reconnecting deliberately reviews current exposure again. */
export function creditUsageFeedback(sy: Pick<MeritRouter, "projectStores" | "projectContext">) {
  const delivered = new Map<string, Set<string>>();
  const unavailable = new Set<string>();
  return (project: string): string[] => {
    try {
      const cfg: ResolvedConfig = sy.projectContext(project), settings = cfg.supervisor.credit_usage_alerts;
      if (!settings.enabled) return [];
      const stores = sy.projectStores(project);
      if (stores.project !== project) throw new Error("credit_usage_project_mismatch");
      const profiles = Object.entries(cfg.profiles).filter(([, profile]) => profile?.mode === "supervisor").map(([name]) => name);
      if (!profiles.length) return [];
      const marks = profiles.map(() => "?").join(",");
      const roots = z.array(z.object({ id: z.string() })).parse(stores.db.prepare(`SELECT t.id FROM tasks t
        WHERE t.project_id=? AND t.profile IN (${marks}) AND NOT EXISTS(SELECT 1 FROM tasks p
          WHERE p.id=json_extract(t.spec_json,'$.parentTaskId') AND p.project_id=? AND p.profile IN (${marks}))
        ORDER BY t.updated_at DESC,t.id LIMIT ${JOB_LIMIT + 1}`).all(project, ...profiles, project, ...profiles));
      const messages: string[] = [];
      for (const root of roots.slice(0, JOB_LIMIT)) {
        const current = jobCreditUsage(stores, project, root.id);
        if (!current) continue;
        const key = `${project}:${stores.identity ? `${stores.identity.storeId}/${stores.identity.generation}` : "legacy"}:${root.id}`;
        const previous = delivered.get(key) ?? new Set<string>();
        const crossed = settings.usd_thresholds.filter(value => current.exposureUsd >= value).map(value => `USD:${value}`);
        if (current.rootTaskCapUsd !== null && current.rootTaskCapUsd > 0) crossed.push(...settings.cap_fraction_thresholds
          .filter(value => current.exposureUsd >= current.rootTaskCapUsd! * value).map(value => `root-cap:${value}`));
        if (current.rootTaskCapUsd === 0 && current.exposureUsd > 0) crossed.push("root-cap:zero-exceeded");
        if (current.incomplete) crossed.push("incomplete");
        if (current.unpricedRequests > 0) crossed.push("unknown-cost");
        const fresh = crossed.filter(value => !previous.has(value));
        if (!fresh.length) continue;
        for (const threshold of fresh) previous.add(threshold);
        delivered.set(key, previous);
        if (delivered.size > 2048) delivered.delete(delivered.keys().next().value!);
        messages.push(`MeritRouter credit usage notice for FINAL — project ${project}, job ${root.id}: `
          + `$${current.settledUsd.toFixed(4)} settled accounting spend, $${current.outstandingUsd.toFixed(4)} outstanding reservations/uncertain liability; `
          + `$${current.exposureUsd.toFixed(4)} measured job-tree exposure. New thresholds: ${fresh.join(", ")}. `
          + (current.rootTaskCapUsd === null ? "No explicit job paid cap was recorded. " : `Shared job paid cap: $${current.rootTaskCapUsd.toFixed(2)}, including all descendants; nested caps can narrow it. `)
          + `${current.unpricedRequests} requests have unknown prices or incomplete accounting coverage${current.incomplete ? "; query bounds reached, totals are incomplete" : ""}. Provider account credit balance is not established by this usage report. `
          + "Review actual progress, failures and served models; tell the user material spend and correct waste while continuing authorized work. This notice changes no caps or permissions and does not require new consent for already authorized work.");
      }
      if (roots.length > JOB_LIMIT && !unavailable.has(`${project}:bounded`)) {
        unavailable.add(`${project}:bounded`);
        messages.push(`MeritRouter credit usage coverage for FINAL: project ${project} has more than ${JOB_LIMIT} root jobs; only the most recently updated jobs were inspected. Other job costs remain unknown to this notice.`);
      }
      return messages;
    } catch {
      if (unavailable.has(project)) return [];
      unavailable.add(project);
      return [`MeritRouter credit usage unavailable for FINAL in project ${project}: accounting could not be read or validated. No zero-spend or remaining-credit claim can be made; the original tool result is unchanged.`];
    }
  };
}
