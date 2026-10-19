import type { ResolvedConfig } from "../config/load.js";
import type { ProfileConfig } from "../config/schema.js";
import type { Gate } from "../gateway/gate.js";
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
    ...partial,
  };
}
