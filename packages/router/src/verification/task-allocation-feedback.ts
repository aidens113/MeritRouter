import type { ResolvedConfig } from "../config/load.js";
import { TIER_NAMES, type Importance } from "../config/schema.js";
import { budgetInputFor } from "../admission/admission.js";
import { WorkerTaskSchema, type WorkerTask } from "../core/task.js";
import { compileContract, declaredEvaluatorChanges, type AcceptanceContract } from "./contract.js";

export type TaskAllocationParent = { taskId: string; importance: Importance } | null;

/** Shared canonical estimates; actual classification draws inside the eventual pinned total. */
export function taskAllocationAlternatives(cfg: ResolvedConfig, input: WorkerTask,
  parent: TaskAllocationParent = null, classificationUsed = 0) {
  const spec = WorkerTaskSchema.parse(input);
  const profile = cfg.profiles[spec.profile];
  if (!profile || profile.mode === "supervisor" || spec.hints?.difficulty === "T4") return [];
  const floors = [profile.min_tier, spec.hints?.difficulty, spec.routing?.tier];
  const start = Math.max(0, ...floors.flatMap(tier => tier ? [TIER_NAMES.indexOf(tier)] : []));
  return TIER_NAMES.slice(start).map(tier => {
    const result = compileContract({ taskId: spec.id ?? "allocation-preview", spec, tier,
      tags: spec.hints?.tags ?? null, rulebookFingerprint: null, policy: cfg.verification,
      evaluatorChangeExpected: declaredEvaluatorChanges(spec, cfg.coding.protected_paths),
      budget: budgetInputFor(cfg, spec, tier, classificationUsed), parent, now: 0 });
    return { tier, result };
  });
}

/** Read-only forecast: the executor still compiles the authoritative contract after classification. */
export function taskAllocationForecast(cfg: ResolvedConfig, input: WorkerTask,
  parent: TaskAllocationParent = null): string {
  const alternatives = taskAllocationAlternatives(cfg, input, parent);
  if (!alternatives.length) return cfg.profiles[input.profile]?.mode === "supervisor" ? ""
    : "Allocation forecast unavailable: T4 requires routing resolution before worker execution.";
  const descriptions = alternatives.map(({ tier, result }) => {
    if (!result.ok) return `${tier}: ${result.message}`;
    const { budget, verification } = result.contract;
    return `${tier}/${verification.level}: first-run execution ${budget.execution}, review ${budget.review}, repair ${budget.repair}, total allocated ${budget.total}`;
  });
  return `Provisional allocation forecast (zero classification requests assumed; actual classification, policy and tier may change it): ${descriptions.join("; ")}. max_requests is the total across purposes, not coding turns. Execution must cover setup, reads, edits, checks and submit_result; its final request is submission-only. No requests or grants are consumed by this forecast.`;
}

/** The runner's effective cap includes approved extensions and already charged requests. */
export function executionAllocationNotice(contract: AcceptanceContract | null | undefined, cap: number, used: number): string {
  const allocation = contract?.budget;
  return `Current execution allowance: ${Math.max(0, cap - used)} model requests remain (${used} already charged; cumulative execution cap ${cap}).${allocation ? ` Contract total allocation ${allocation.total}: classification ${allocation.classification}, first-run execution ${allocation.execution}, reserved review ${allocation.review}, reserved repair ${allocation.repair}.` : ""} Reserved review/repair requests are not available for ordinary coding. Leave time for checks and a valid submit_result: the final execution request offers only submit_result. Ask for more before exhausting execution if the remaining work does not fit; an extension requires approval.`;
}
