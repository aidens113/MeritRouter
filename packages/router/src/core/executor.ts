import type { ResolvedConfig } from "../config/load.js";
import type { Db } from "../storage/db.js";
import type { ArtifactStore } from "../storage/artifacts.js";
import type { StoredTask, TaskStore } from "../storage/tasks.js";
import { taskUsage } from "../storage/usage.js";
import type { Gate } from "../gateway/gate.js";
import { effectiveBudget } from "../admission/admission.js";
import { AdmissionDenied, GatewayError } from "./errors.js";
import { WorkerResultSchema, type TaskState, type WorkerResult } from "./task.js";
import { baseResult, type RunContext, type RunOutcome, type RunnerResult } from "../runners/types.js";
import { runCompletion } from "../runners/completion.js";
import { runReadOnly } from "../runners/readonly.js";
import { runBatch } from "../runners/batch.js";

export type AbortReason = "cancel" | "deadline" | "lease_lost" | "shutdown";

export interface CodingRunner {
  run(ctx: RunContext): Promise<RunOutcome>;
}

export interface ExecutorDeps {
  cfg: ResolvedConfig;
  db: Db;
  gate: Gate;
  tasks: TaskStore;
  artifacts: ArtifactStore;
  owner: string;
  now: () => number;
  coding: CodingRunner | null;
  /** Called after any task reaches a new state, to wake waiters. */
  onSettled: (taskId: string) => void;
}

type Disposition =
  | { kind: "final"; state: RunOutcome["state"]; stopReason: string; summary?: string }
  | { kind: "defer"; at: number; reason: string }
  | { kind: "abandon"; reason: string };

/** Runs claimed units (single tasks or prompt batches) and records their outcomes. */
export class Executor {
  readonly controllers = new Map<string, AbortController>();

  constructor(private readonly d: ExecutorDeps) {}

  private context(task: StoredTask, signal: AbortSignal): RunContext {
    return {
      cfg: this.d.cfg,
      profile: this.d.cfg.profiles[task.spec.profile]!,
      spec: task.spec,
      taskId: task.row.id,
      leaseOwner: this.d.owner,
      budget: effectiveBudget(this.d.cfg, task.spec),
      gate: this.d.gate,
      tasks: this.d.tasks,
      artifacts: this.d.artifacts,
      signal,
      now: this.d.now,
    };
  }

  /** Heartbeats the lease, watches for cancellation, and enforces the deadline. */
  private supervise(task: StoredTask, controller: AbortController): () => void {
    const leaseMs = this.d.cfg.execution.lease_seconds * 1000;
    const timer = setInterval(() => {
      const status = this.d.tasks.activeStatus(task.row.id, this.d.owner);
      if (status === "cancel_requested") controller.abort("cancel");
      else if (status !== "active" || !this.d.tasks.heartbeat(task.row.id, this.d.owner, leaseMs)) controller.abort("lease_lost");
    }, Math.max(1000, Math.floor(leaseMs / 4)));
    const deadline = this.d.tasks.get(task.row.id)?.row.deadline_at;
    const deadlineTimer = deadline ? setTimeout(() => controller.abort("deadline"), Math.max(0, deadline - this.d.now())) : null;
    return () => {
      clearInterval(timer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      this.controllers.delete(task.row.id);
    };
  }

  async runSingle(task: StoredTask): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(task.row.id, controller);
    const release = this.supervise(task, controller);
    try {
      const ctx = this.context(task, controller.signal);
      let outcome: RunOutcome;
      try {
        if (ctx.profile.mode === "completion") outcome = await runCompletion(ctx);
        else if (ctx.profile.mode === "read_only") outcome = await runReadOnly(ctx);
        else if (this.d.coding) outcome = await this.d.coding.run(ctx);
        else throw new Error("no coding runner is configured");
      } catch (err) {
        this.settle(task, this.classify(err, controller.signal, task));
        return;
      }
      if (controller.signal.aborted) {
        this.settle(task, this.classify(new Error("aborted"), controller.signal, task), outcome.result);
        return;
      }
      this.record(task, outcome.state, outcome.result);
    } finally {
      release();
    }
  }

  async runBatch(tasks: StoredTask[]): Promise<void> {
    // Members share one physical request; a member's cancellation is applied when it finishes.
    const shared = new AbortController();
    const releases = tasks.map((t) => {
      const c = new AbortController();
      this.controllers.set(t.row.id, c);
      c.signal.addEventListener("abort", () => {
        if (c.signal.reason === "shutdown" || tasks.every((x) => this.controllers.get(x.row.id)?.signal.aborted)) shared.abort(c.signal.reason);
      });
      return this.supervise(t, c);
    });
    try {
      let outcomes: Map<string, RunOutcome>;
      try {
        outcomes = await runBatch(tasks.map((t) => this.context(t, shared.signal)));
      } catch (err) {
        const pendingIds = (err as { batchPendingTaskIds?: string[] }).batchPendingTaskIds ?? tasks.map((t) => t.row.id);
        for (const t of tasks) {
          if (!pendingIds.includes(t.row.id)) continue;
          this.settle(t, this.classify(err, this.controllers.get(t.row.id)?.signal ?? shared.signal, t));
        }
        return;
      }
      for (const t of tasks) {
        const o = outcomes.get(t.row.id);
        if (o) this.record(t, o.state, o.result);
        else this.settle(t, { kind: "final", state: "failed", stopReason: "batch_member_unaccounted" });
      }
    } finally {
      for (const r of releases) r();
    }
  }

  private classify(err: unknown, signal: AbortSignal, task: StoredTask): Disposition {
    const reason = signal.aborted ? (signal.reason as AbortReason) : null;
    if (reason === "cancel") return { kind: "final", state: "cancelled", stopReason: "cancelled while running" };
    if (reason === "lease_lost") return { kind: "abandon", reason: "lease lost" };
    if (reason === "shutdown") return { kind: "abandon", reason: "shutdown" };
    if (reason === "deadline") return { kind: "final", state: "failed", stopReason: "deadline_exceeded" };

    const now = this.d.now();
    const deadline = this.d.tasks.get(task.row.id)?.row.deadline_at ?? Infinity;
    const capacity = (at: number, why: string): Disposition =>
      this.d.cfg.execution.on_capacity_exhausted === "queue" && at < deadline
        ? { kind: "defer", at, reason: why }
        : { kind: "final", state: "failed", stopReason: `capacity_exhausted: ${why}` };

    if (err instanceof AdmissionDenied) {
      switch (err.reason) {
        case "cancel_requested":
          return { kind: "final", state: "cancelled", stopReason: "cancelled before dispatch" };
        case "lease_lost":
        case "task_not_active":
          return { kind: "abandon", reason: err.reason };
        case "deadline_exceeded":
          return { kind: "final", state: "failed", stopReason: "deadline_exceeded" };
        case "task_request_budget_exhausted":
        case "task_token_budget_exhausted":
          return { kind: "final", state: "budget_exhausted", stopReason: `${err.reason}: ${err.message}` };
        case "package_hourly_allocation_exhausted":
        case "package_daily_allocation_exhausted":
          return capacity(err.retryAt ?? now + 60_000, err.message);
        default:
          return { kind: "final", state: "failed", stopReason: `${err.reason}: ${err.message}` };
      }
    }
    if (err instanceof GatewayError) {
      switch (err.kind) {
        case "rate_limited":
        case "pool_exhausted":
          return capacity(now + Math.max(5_000, err.retryAfterMs ?? 60_000), err.message);
        case "transport":
        case "timeout":
        case "server":
          return capacity(now + 30_000, err.message);
        case "aborted":
          return { kind: "final", state: "cancelled", stopReason: "aborted" };
        default:
          return { kind: "final", state: "failed", stopReason: `gateway_${err.kind}: ${err.message}` };
      }
    }
    return { kind: "final", state: "failed", stopReason: `internal_error: ${(err as Error)?.message ?? String(err)}` };
  }

  private settle(task: StoredTask, d: Disposition, partial?: RunnerResult): void {
    if (d.kind === "abandon") {
      if (d.reason === "shutdown") this.d.tasks.interrupt(task.row.id, this.d.owner, "worker shut down");
      this.d.onSettled(task.row.id);
      return;
    }
    if (d.kind === "defer") {
      if (!this.d.tasks.deferForCapacity(task.row.id, this.d.owner, d.at, d.reason)) {
        // Cancellation landed meanwhile; record it.
        this.record(task, "cancelled", baseResult({ executionStatus: "cancelled", stopReason: "cancelled" }));
        return;
      }
      this.d.onSettled(task.row.id);
      return;
    }
    const status = d.state === "completed" ? "failed" : d.state;
    this.record(
      task,
      d.state,
      baseResult({
        ...(partial ?? {}),
        executionStatus: status as WorkerResult["executionStatus"],
        stopReason: d.stopReason,
        summary: d.summary ?? partial?.summary ?? "",
        acceptanceStatus: partial?.acceptanceStatus === "unmet" ? "unmet" : "not_verified",
        unresolvedCriteria: partial?.unresolvedCriteria.length ? partial.unresolvedCriteria : task.spec.constraints.acceptanceCriteria,
      }),
    );
  }

  private record(task: StoredTask, state: TaskState, runner: RunnerResult): void {
    const { usage, servedEndpoints } = taskUsage(this.d.db, this.d.cfg.catalog, task.row.id);
    const result = WorkerResultSchema.parse({ ...runner, taskId: task.row.id, usage, servedEndpoints });
    this.d.tasks.finish(task.row.id, this.d.owner, result, state);
    this.d.onSettled(task.row.id);
  }

  abortAll(reason: AbortReason): void {
    for (const c of this.controllers.values()) c.abort(reason);
  }
}
