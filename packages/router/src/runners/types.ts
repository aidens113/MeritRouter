import type { ResolvedConfig } from "../config/load.js";
import type { ProfileConfig } from "../config/schema.js";
import type { Gate, GateAttempt, GateRequest, GateResponse } from "../gateway/gate.js";
import type { RoutePlan } from "../routing/select.js";
import type { TierName } from "../config/schema.js";
import type { ArtifactStore } from "../storage/artifacts.js";
import type { TaskStore } from "../storage/tasks.js";
import type { EffectiveBudget } from "../admission/admission.js";
import type { TaskState, WorkerResult, WorkerTask } from "../core/task.js";

export interface RunContext {
  cfg: ResolvedConfig;
  profile: ProfileConfig;
  spec: WorkerTask;
  taskId: string;
  leaseOwner: string;
  budget: EffectiveBudget;
  gate: Gate;
  tasks: TaskStore;
  artifacts: ArtifactStore;
  signal: AbortSignal;
  now: () => number;
  tier: TierName;
  plan: RoutePlan;
  /** Every endpoint attempt made for this task (fallbacks included). */
  attempts: GateAttempt[];
}

/** Send one model request for this task through the gate, recording endpoint attempts. */
export async function ask(ctx: RunContext, req: Omit<GateRequest, "plan" | "participants" | "signal"> & { participants?: GateRequest["participants"] }): Promise<GateResponse> {
  try {
    const res = await ctx.gate.request({
      ...req,
      plan: ctx.plan,
      participants: req.participants ?? [{ taskId: ctx.taskId, leaseOwner: ctx.leaseOwner, budget: ctx.budget }],
      signal: ctx.signal,
    });
    ctx.attempts.push(...res.attempts);
    return res;
  } catch (err) {
    const attempts = (err as { attempts?: GateAttempt[] }).attempts;
    if (attempts) ctx.attempts.push(...attempts);
    throw err;
  }
}

/** Runner output before ledger-derived usage is attached by the executor. */
export type RunnerResult = Omit<WorkerResult, "usage" | "servedEndpoints" | "taskId">;

export interface RunOutcome {
  state: Extract<TaskState, "completed" | "failed" | "budget_exhausted" | "cancelled" | "interrupted">;
  result: RunnerResult;
}

export function baseResult(partial: Partial<RunnerResult> = {}): RunnerResult {
  return {
    executionStatus: "completed",
    acceptanceStatus: "not_verified",
    stopReason: "",
    summary: "",
    findings: [],
    artifactRefs: [],
    patchRefs: [],
    baseCommits: {},
    checks: [],
    unresolvedCriteria: [],
    classification: null,
    routing: null,
    ...partial,
  };
}
