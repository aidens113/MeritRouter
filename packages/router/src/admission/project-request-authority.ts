import { z } from "zod";
import type { ResolvedConfig } from "../config/load.js";
import type { ProjectStoreIdentity } from "../projects/store-identity.js";
import { AdmissionDenied } from "../core/errors.js";
import { TIER_NAMES, UNLIMITED_REQUESTS, type TierName } from "../config/schema.js";
import { effectiveBudget, heldRequests, purposeCategory, verificationTotal, type Admission } from "./admission.js";
import { extraRequests, grantOf } from "./job-pool.js";
import { jobPool, protectedValidationRequests } from "./budget-requests.js";
import { projectTaskPaidSpend } from "./project-request-totals.js";
import type { ReserveRequestDTO } from "./request-ledger.js";

const cap = (requested: number | null, policy: number | null) => requested === null ? policy : policy === null ? requested : Math.min(requested, policy);
const addRequests = (base: number, extra: number) => base === UNLIMITED_REQUESTS ? base : base + extra;

/** Local task/grant authority only. It never consults global keys, package quota or shared spend. */
export function assertProjectRequestAuthority(admission: Admission, cfg: ResolvedConfig, identity: ProjectStoreIdentity,
  input: ReserveRequestDTO, alreadyCounted: boolean, paidOverride?: number): number {
  if (!input.participants.length || cfg.brain.project !== identity.slug) throw new Error("Project requests require explicit local participants and context");
  admission.assertDispatch(input.participants);
  if (input.paid && input.paid.key.ref !== input.keyRef) throw new Error("Private paid key reference disagrees with the request binding");
  const execution = z.object({ status: z.string() }).strict().optional().parse(admission.db.prepare("SELECT status FROM executions WHERE id=?").get(input.executionId));
  if (!execution || execution.status !== "running") throw new Error("Project execution is not active");
  let dispatchNotAfter = Number.MAX_SAFE_INTEGER;
  const extra = alreadyCounted ? 0 : 1;
  for (const part of input.participants) {
    const task = admission.tasks.get(part.taskId);
    if (!task || part.lease.project !== identity.slug || task.row.project_id !== identity.slug
      || task.row.lease_incarnation !== part.lease.incarnation || task.row.run_count !== part.lease.runCount
      || task.row.lease_owner !== part.lease.owner) throw new AdmissionDenied("lease_lost", "Project participant generation changed", undefined, part.taskId);
    if (!admission.db.prepare("SELECT 1 FROM execution_members WHERE execution_id=? AND task_id=?").get(input.executionId, part.taskId)) throw new Error("Project execution membership missing");
    dispatchNotAfter = Math.min(dispatchNotAfter, task.row.deadline_at ?? Number.MAX_SAFE_INTEGER, task.row.lease_expires_at ?? 0);
    const tier = input.tier !== null && TIER_NAMES.includes(input.tier as TierName) ? input.tier as TierName : null;
    const configured = effectiveBudget(cfg, task.spec, tier), approved = extraRequests(admission.db, part.taskId), grant = grantOf(admission.db, part.taskId);
    const totalCap = Math.min(part.budget.maxModelRequests, addRequests(verificationTotal(cfg, task.spec), approved), grant ? grant.requests + approved : UNLIMITED_REQUESTS);
    const used = admission.taskTotals(part.taskId), held = heldRequests(admission.db, part.taskId);
    if (used.requests + held + extra > totalCap) throw new AdmissionDenied("task_request_budget_exhausted", "Project request budget or delegated pool exhausted", undefined, part.taskId);
    if (purposeCategory(input.purpose) === "execution") {
      const executionUsed = admission.taskTotalsByPurpose(part.taskId).execution;
      if (executionUsed + extra > addRequests(configured.maxModelRequests, approved)) throw new AdmissionDenied("task_request_budget_exhausted", "Project execution request cap exhausted", undefined, part.taskId);
    }
    const inCap = cap(part.budget.maxInputTokens, configured.maxInputTokens), outCap = cap(part.budget.maxOutputTokens, configured.maxOutputTokens);
    if (inCap !== null && used.inputTokens + (alreadyCounted ? 0 : part.estInputTokens) > inCap)
      throw new AdmissionDenied("task_token_budget_exhausted", "Project input token budget exhausted", undefined, part.taskId);
    if (outCap !== null && used.outputTokens + (alreadyCounted ? 0 : part.reservedOutputTokens) > outCap)
      throw new AdmissionDenied("task_token_budget_exhausted", "Project output token budget exhausted", undefined, part.taskId);
    const paidCap = cap(part.budget.maxPaidUsd, configured.maxPaidUsd), paid = paidOverride ?? input.paid?.worstCaseUsd ?? 0;
    // On bind/dispatch, preparations or charge projections already include the request's held amount.
    const paidUsed = projectTaskPaidSpend(admission.db, part.taskId);
    if (paidCap !== null && paidUsed + (alreadyCounted ? 0 : paid / input.participants.length) > paidCap)
      throw new AdmissionDenied("paid_budget_exhausted", "Project participant paid budget exhausted", undefined, part.taskId);
    const pool = jobPool(admission.db, cfg, part.taskId), protectedRequests = protectedValidationRequests(admission.db, cfg, part.taskId);
    if (pool?.cap !== null && pool && protectedRequests > 0 && pool.cap - pool.used - pool.held - extra < protectedRequests)
      throw new AdmissionDenied("task_request_budget_exhausted", "Project integrated-validation reserve is protected", undefined, part.taskId);
  }
  if (dispatchNotAfter <= admission.serverNow()) throw new AdmissionDenied("deadline_exceeded", "Project dispatch authority expired");
  return dispatchNotAfter;
}
