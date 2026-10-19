import type { ResolvedConfig } from "../config/load.js";
import { TIER_NAMES, type TierName } from "../config/schema.js";
import type { Db } from "../storage/db.js";
import type { ArtifactStore } from "../storage/artifacts.js";
import type { StoredTask, TaskStore } from "../storage/tasks.js";
import { taskUsage } from "../storage/usage.js";
import type { Gate, GateAttempt } from "../gateway/gate.js";
import type { Catalog } from "../models/catalog.js";
import type { TaskRouter, Prepared } from "../routing/router.js";
import type { RoutePlan } from "../routing/select.js";
import { effectiveBudget } from "../admission/admission.js";
import { AdmissionDenied, GatewayError } from "./errors.js";
import { WorkerResultSchema, type TaskState, type WorkerResult } from "./task.js";
import { baseResult, type RunContext, type RunOutcome, type RunnerResult } from "../runners/types.js";
import { runCompletion } from "../runners/completion.js";
import { runReadOnly } from "../runners/readonly.js";
import { runBatch } from "../runners/batch.js";
import type { Classification } from "../scoring/score.js";
import type { Brain } from "../brain/brain.js";
import type { BrainAccess } from "../brain/access.js";
import type { SupervisorServices } from "../runners/types.js";
import { writeWorkerReport } from "../harness/worker.js";
import { roleForProfile } from "../roles/index.js";

/** The working document a task belongs to: its job's, an explicit one, or the shared ad-hoc one. */
export function effortFor(spec: { profile: string; parentTaskId?: string | undefined; brain?: { effort?: string | undefined } | undefined }, taskId: string): string {
  if (spec.brain?.effort) return spec.brain.effort;
  if (spec.profile === "supervise") return `job-${taskId}`;
  if (spec.parentTaskId) return `job-${spec.parentTaskId}`;
  return "adhoc";
}

export type AbortReason = "cancel" | "deadline" | "lease_lost" | "shutdown";

export interface CodingRunner {
  run(ctx: RunContext): Promise<RunOutcome>;
}

export interface ExecutorDeps {
  cfg: ResolvedConfig;
  db: Db;
  gate: Gate;
  catalog: Catalog;
  router: TaskRouter;
  tasks: TaskStore;
  artifacts: ArtifactStore;
  owner: string;
  now: () => number;
  coding: CodingRunner | null;
  brain: Brain | null;
  access: BrainAccess | null;
  services: SupervisorServices | null;
  supervisor: CodingRunner | null;
  /** Called after any task reaches a new state, to wake waiters. */
  onSettled: (taskId: string) => void;
}

type Disposition =
  | { kind: "final"; state: RunOutcome["state"]; stopReason: string; summary?: string }
  | { kind: "defer"; at: number; reason: string }
  | { kind: "abandon"; reason: string };

interface Routing {
  classification: Classification | null;
  tier: TierName | null;
  escalatedFrom: TierName | null;
  attempts: GateAttempt[];
}

const ESCALATE_ON = new Set(["invalid_output", "budget_exhausted", "acceptance_unmet"]);

/** Runs claimed units (single tasks or prompt batches) and records their outcomes. */
export class Executor {
  readonly controllers = new Map<string, AbortController>();
  private readonly routing = new Map<string, Routing>();
  private readonly reports = new Set<Promise<unknown>>();

  /** Wait for pending brain report writes (called on shutdown). */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.reports]);
  }

  constructor(private readonly d: ExecutorDeps) {}

  private context(task: StoredTask, signal: AbortSignal, plan: RoutePlan, routing: Routing): RunContext {
    return {
      cfg: this.d.cfg,
      profile: this.d.cfg.profiles[task.spec.profile]!,
      spec: task.spec,
      taskId: task.row.id,
      leaseOwner: this.d.owner,
      budget: effectiveBudget(this.d.cfg, task.spec, plan.tier),
      gate: this.d.gate,
      tasks: this.d.tasks,
      artifacts: this.d.artifacts,
      signal,
      now: this.d.now,
      tier: plan.tier,
      plan,
      attempts: routing.attempts,
      brain: this.d.brain,
      access: this.d.access,
      effort: effortFor(task.spec, task.row.id),
      jobId: task.spec.profile === "supervise" ? task.row.id : (task.spec.parentTaskId ?? null),
      services: this.d.services,
      session: null,
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

  private runMode(ctx: RunContext): Promise<RunOutcome> {
    if (ctx.profile.mode === "completion") return runCompletion(ctx);
    if (ctx.profile.mode === "read_only") return runReadOnly(ctx);
    if (ctx.profile.mode === "supervisor") {
      if (this.d.supervisor) return this.d.supervisor.run(ctx);
      return Promise.reject(new Error("no supervisor runner is configured"));
    }
    if (this.d.coding) return this.d.coding.run(ctx);
    return Promise.reject(new Error("no coding runner is configured"));
  }

  private tooDifficult(task: StoredTask, prepared: Prepared): void {
    const c = prepared.classification;
    this.record(task, "failed", baseResult({
      executionStatus: "failed",
      stopReason: `too_difficult_for_workers: ${c.rejectReason}`,
      summary: `Not delegated. ${c.rejectReason}. Score ${c.score}: ${c.breakdown.filter((l) => l.points).map((l) => `${l.detail} (+${l.points})`).join(", ")}.`,
      unresolvedCriteria: task.spec.constraints.acceptanceCriteria,
    }));
  }

  async runSingle(task: StoredTask): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(task.row.id, controller);
    const release = this.supervise(task, controller);
    const routing: Routing = { classification: null, tier: null, escalatedFrom: null, attempts: [] };
    this.routing.set(task.row.id, routing);
    try {
      let prepared: Prepared;
      try {
        prepared = await this.d.router.prepare(task, this.d.owner);
      } catch (err) {
        this.settle(task, this.classify(err, controller.signal, task));
        return;
      }
      routing.classification = prepared.classification;
      if (!prepared.plan) {
        this.tooDifficult(task, prepared);
        return;
      }
      let plan = prepared.plan;
      for (;;) {
        routing.tier = plan.tier;
        let outcome: RunOutcome;
        try {
          outcome = await this.runMode(this.context(task, controller.signal, plan, routing));
        } catch (err) {
          this.settle(task, this.classify(err, controller.signal, task));
          return;
        }
        if (controller.signal.aborted) {
          this.settle(task, this.classify(new Error("aborted"), controller.signal, task), outcome.result);
          return;
        }
        const failure = outcome.state === "budget_exhausted" ? "budget_exhausted" : outcome.result.stopReason === "invalid_output" ? "invalid_output" : outcome.result.acceptanceStatus === "unmet" && this.d.cfg.profiles[task.spec.profile]!.mode === "coding" ? "acceptance_unmet" : null;
        const next = TIER_NAMES[TIER_NAMES.indexOf(plan.tier) + 1];
        const budgetLeft = next ? effectiveBudget(this.d.cfg, task.spec, next).maxModelRequests - this.d.gate.admission.taskTotals(task.row.id).requests : 0;
        if (failure && ESCALATE_ON.has(failure) && this.d.cfg.routing.escalate_on_failure && !routing.escalatedFrom && next && budgetLeft > 0 && !task.spec.routing?.endpointId) {
          const nextPlan = this.d.router.plan(task.spec.profile, next, prepared.inputModalities);
          if (nextPlan.candidates.length) {
            this.d.tasks.event(task.row.id, "escalated", { from: plan.tier, to: next, reason: failure });
            routing.escalatedFrom = plan.tier;
            this.d.db.prepare("UPDATE tasks SET tier = ? WHERE id = ?").run(next, task.row.id);
            plan = nextPlan;
            continue;
          }
        }
        this.record(task, outcome.state, outcome.result);
        return;
      }
    } finally {
      this.routing.delete(task.row.id);
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
      // Classify each member; the shared request uses the hardest member's tier.
      const members: StoredTask[] = [];
      const prepared = new Map<string, Prepared>();
      for (const t of tasks) {
        const routing: Routing = { classification: null, tier: null, escalatedFrom: null, attempts: [] };
        this.routing.set(t.row.id, routing);
        try {
          const p = await this.d.router.prepare(t, this.d.owner);
          routing.classification = p.classification;
          if (!p.plan) this.tooDifficult(t, p);
          else {
            prepared.set(t.row.id, p);
            members.push(t);
          }
        } catch (err) {
          this.settle(t, this.classify(err, this.controllers.get(t.row.id)!.signal, t));
        }
      }
      if (!members.length) return;
      const tier = members.map((m) => prepared.get(m.row.id)!.plan!.tier).reduce((a, b) => (TIER_NAMES.indexOf(b) > TIER_NAMES.indexOf(a) ? b : a));
      const plan = prepared.get(members.find((m) => prepared.get(m.row.id)!.plan!.tier === tier)!.row.id)!.plan!;
      for (const m of members) this.routing.get(m.row.id)!.tier = tier;

      let outcomes: Map<string, RunOutcome>;
      try {
        outcomes = await runBatch(members.map((t) => this.context(t, shared.signal, plan, this.routing.get(t.row.id)!)));
      } catch (err) {
        const pendingIds = (err as { batchPendingTaskIds?: string[] }).batchPendingTaskIds ?? members.map((t) => t.row.id);
        for (const t of members) {
          if (!pendingIds.includes(t.row.id)) continue;
          this.settle(t, this.classify(err, this.controllers.get(t.row.id)?.signal ?? shared.signal, t));
        }
        return;
      }
      for (const t of members) {
        const o = outcomes.get(t.row.id);
        if (o) this.record(t, o.state, o.result);
        else this.settle(t, { kind: "final", state: "failed", stopReason: "batch_member_unaccounted" });
      }
    } finally {
      for (const t of tasks) this.routing.delete(t.row.id);
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
        case "paid_budget_exhausted":
          return { kind: "final", state: "failed", stopReason: `paid_budget_exhausted: ${err.message}` };
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
    const { usage, servedEndpoints } = taskUsage(this.d.db, this.d.catalog, task.row.id);
    const r = this.routing.get(task.row.id);
    const c = r?.classification;
    const result = WorkerResultSchema.parse({
      ...runner,
      taskId: task.row.id,
      usage,
      servedEndpoints,
      classification: c ? { tier: c.tier, score: c.score, basis: c.basis, rulebookVersion: c.rulebookVersion, breakdown: c.breakdown } : null,
      routing: r?.tier ? { tier: r.tier, escalatedFrom: r.escalatedFrom, attempts: r.attempts } : null,
    });
    const final = this.d.tasks.finish(task.row.id, this.d.owner, result, state);
    const mode = this.d.cfg.profiles[task.spec.profile]?.mode;
    if (this.d.brain && mode && mode !== "supervisor" && final !== "running") {
      const p = writeWorkerReport(
        { cfg: this.d.cfg, brain: this.d.brain, access: this.d.access, spec: task.spec, taskId: task.row.id, effort: effortFor(task.spec, task.row.id), jobId: task.spec.parentTaskId ?? null, tier: (r?.tier ?? null) as never },
        roleForProfile(task.spec.profile),
        runner,
        final,
      ).finally(() => {
        this.reports.delete(p);
        this.d.onSettled(task.row.id);
      });
      this.reports.add(p);
    }
    this.d.onSettled(task.row.id);
  }

  abortAll(reason: AbortReason): void {
    for (const c of this.controllers.values()) c.abort(reason);
  }
}
