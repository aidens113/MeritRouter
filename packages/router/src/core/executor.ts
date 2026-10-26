import { createProjectWorkerReadServices } from "./project-services.js";
import { projectToolIdentity } from "./supervisor-authority.js";
import { createHash } from "node:crypto";
import { TaskRunLeases } from "./task-run-leases.js";
import { leaseOperationId, reconcileLeaseOperation, receiptApplied, type LeaseRef, type LeaseReceipt, type TaskLeases } from "../storage/task-leases.js";
import { canonicalJson } from "../storage/tasks.js";
import type { ResolvedConfig } from "../config/load.js";
import { projectStoresForTask, type ProjectRuntimeStore } from "../projects/runtime-store.js";
import type { WebAccess } from "../web/access.js";
import { TIER_NAMES, type ProfileMode, type TierName } from "../config/schema.js";
import type { Db } from "../storage/db.js";
import type { ArtifactStore } from "../storage/artifacts.js";
import type { StoredTask, TaskStore } from "../storage/tasks.js";
import { taskUsage } from "../storage/usage.js";
import type { Gate, GateAttempt } from "../gateway/gate.js";
import type { Catalog } from "../models/catalog.js";
import type { TaskRouter, Prepared } from "../routing/router.js";
import type { RoutePlan } from "../routing/select.js";
import { effectiveBudget } from "../admission/admission.js";
import { extraRequests } from "../admission/job-pool.js";
import { criterionTexts, WorkerResultSchema, type TaskState, type WorkerResult } from "./task.js";
import { restoreRunState } from "./retry-state.js";
import { baseResult, type RetryContext, type RunContext, type RunOutcome, type RunnerResult } from "../runners/types.js";
import type { LabManager } from "../labs/lab.js";
import { repairCap, type ContractStore, type StoredContract } from "../verification/contract.js";
import { continueRun, planRetry, repairPossible, requestsUsed, verifyWithReview, type ReviewRun, type VerifiedRun } from "../verification/phase.js";
import { contractShortfall, ensureContract, runCap } from "./acceptance.js";
import { runCompletion } from "../runners/completion.js";
import { runReadOnly } from "../runners/readonly.js";
import { runBatch } from "../runners/batch.js";
import type { Classification } from "../scoring/score.js";
import type { Brain } from "../brain/brain.js";
import type { BrainAccess } from "../brain/access.js";
import type { SupervisorServices } from "../runners/types.js";
import { writeWorkerReport } from "../harness/worker.js";
import { roleForProfile } from "../roles/index.js";
import type { SessionStore } from "../sessions/store.js";
import type { SessionRecorder } from "../sessions/recorder.js";
import type { SessionEndStatus } from "../sessions/events.js";
import type { ResumePlan } from "../sessions/resume.js";
import { endRunSession, interruptedTier, jobIdFor, openRunSession, resumeFor, sessionEnd, type RunResume } from "../sessions/run-sessions.js";
import { isSimulatedCrash } from "./faults.js";
import { withUpstreamContext } from "../context/upstream.js";
import { abortStuckRuns, type WatchedRun } from "./watchdog.js";
import { classifyFailure, dispositionSessionEnd, WATCHDOG_STOP, type AbortReason, type Disposition } from "./disposition.js";
import { redundancyFor } from "../storage/plans.js";
import { planRedundancy, raceTwins, redundancyRefused, REDUNDANCY_SKIPPED, type RedundancyPlan, type TwinResult } from "./redundancy.js";

// Moved to their owning modules; re-exported so existing importers keep working.
export { authorSessions, DELEGATED_BY_SESSION, ResumeDirectiveSchema, sessionEnd, type ResumeDirective } from "../sessions/run-sessions.js";
export { WATCHDOG_STOP, type AbortReason } from "./disposition.js";

/** The working document a task belongs to: its job's, an explicit one, or the shared ad-hoc one. */
export function effortFor(spec: { profile: string; parentTaskId?: string | undefined; brain?: { effort?: string | undefined } | undefined }, taskId: string): string {
  if (spec.brain?.effort) return spec.brain.effort;
  if (spec.profile === "supervise") return `job-${taskId}`;
  if (spec.parentTaskId) return `job-${spec.parentTaskId}`;
  return "adhoc";
}

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
  servicesForLease?: (lease:LeaseRef)=>SupervisorServices;
  supervisor: CodingRunner | null;
  /** Agent sessions; null runs without recording (each run's `ctx.session` stays null). */
  sessions: SessionStore | null;
  /** Acceptance contracts, compiled after classification and before the first run. */
  contracts: ContractStore;
  /** Called after any task reaches a new state, to wake waiters. */
  onSettled: (taskId: string) => void;
  /**
   * A task's project: its configuration (a `ProjectContext`: the project's repositories, brain
   * scope, and overrides), brain, and brain access. Throws for a project no longer configured.
   * Absent: every task runs under the global `cfg`, `brain`, and `access`.
   */
  project?: (task: StoredTask) => ProjectDeps;
  /** Agents' web search and fetch, shared by every project (absent: no web tools). */
  web?: WebAccess | null;
  labs?: LabManager;
  ensureLabsSupervisor?: () => Promise<void>;
  taskLeases?: TaskLeases;
}

/** What differs per project in the executor's dependencies. */
export interface ProjectDeps {
  cfg: ResolvedConfig;
  brain: Brain | null;
  access: BrainAccess | null;
  /** Optional same-DB seam; omitted preserves legacy project callback behavior. */
  stores?: ProjectRuntimeStore;
}

interface Routing {
  classification: Classification | null;
  tier: TierName | null;
  escalatedFrom: TierName | null;
  attempts: GateAttempt[];
}

/** Runs claimed units (single tasks or prompt batches) and records their outcomes. */
export class Executor {
  readonly controllers: Map<string, AbortController>;
  private readonly routing = new Map<string, Routing>();
  readonly taskLeases: TaskLeases;
  private readonly runLeases: TaskRunLeases;
  private readonly published = new WeakSet<LeaseRef>();
  private readonly reports = new Set<Promise<unknown>>();
  /** Single-task runs the progress watchdog looks at (see `WatchedRun`). */
  private readonly watched = new Map<string, WatchedRun>();

  /** Wait for pending brain report writes (called on shutdown). */
  async flush(): Promise<void> {
    await this.runLeases.drain();
    while (this.reports.size) await Promise.allSettled([...this.reports]);
  }

  constructor(private readonly d: ExecutorDeps) {
    this.runLeases = new TaskRunLeases(d);
    this.controllers = this.runLeases.controllers;
    this.taskLeases = this.runLeases.port;
  }

  cancelTasksAsync(ids: string[], project?: string, actorLease?: LeaseRef): Promise<LeaseReceipt[]> {
    return this.runLeases.cancelTasksAsync(ids, project, actorLease);
  }
  abortLease(lease: LeaseRef, reason: AbortReason): void { this.runLeases.abortLease(lease, reason); }
  /**
   * The executor's dependencies as one task sees them: its project's configuration, brain, and
   * brain access in place of the global ones. Throws when the task's project is not configured.
   */
  private depsFor(task: StoredTask): ExecutorDeps {
    const project = this.d.project?.(task);
    let deps = project ? { ...this.d, cfg: project.cfg, brain: project.brain, access: project.access } : this.d;
    if (project?.stores) {
      const stores = projectStoresForTask(project.stores, task, project.cfg);
      deps = { ...deps, db: stores.db, tasks: stores.tasks, sessions: stores.sessions, artifacts: stores.artifacts, contracts: stores.contracts };
    }
    if (!deps.labs) return deps;
    const scoped = deps.labs.contextForTask(task.row.project_id || deps.cfg.brain.project, task.row.id, task.spec, deps.tasks);
    return { ...deps, cfg: scoped.cfg };
  }

  /** `depsFor`, or null when the task's project is not configured (reports are then skipped). */
  private tryDepsFor(task: StoredTask): ExecutorDeps | null {
    try {
      return this.depsFor(task);
    } catch {
      return null;
    }
  }

  /** Open the session for one run of a task (see `openRunSession`). */
  private openSession(task: StoredTask, plan: RoutePlan, previousSessionId?: string | null): SessionRecorder | null {
    return openRunSession(this.depsFor(task), task, plan, previousSessionId);
  }

  /** End a run's session; a recording failure is logged, not thrown (see `endRunSession`). */
  private endSession(task: StoredTask, session: SessionRecorder | null, status: SessionEndStatus, stopReason: string): void {
    endRunSession(this.d.tasks, task, session, status, stopReason);
  }

  /** End a session for a disposition reached without a runner outcome (errors, aborts, deferrals). */
  private endForDisposition(task: StoredTask, session: SessionRecorder | null, d: Disposition): void {
    const e = dispositionSessionEnd(d);
    this.endSession(task, session, e.status, e.stopReason);
  }

  private context(
    task: StoredTask,
    signal: AbortSignal,
    plan: RoutePlan,
    routing: Routing,
    session: SessionRecorder | null,
    v: { contract: StoredContract | null; retry: RetryContext | null; repairCap?: number | null } = { contract: null, retry: null },
    resume: { plan: ResumePlan } | null = null,
  ): RunContext {
    // Runners see the task's project: its repositories, brain scope, and policy overrides.
    const d = this.depsFor(task);
    const lab = d.labs?.bindTask(task.row.project_id || d.cfg.brain.project, task.row.id, task.spec, d.tasks);
    const budget = effectiveBudget(d.cfg, task.spec, plan.tier);
    // A repair (or escalation) run draws on the repair reserve, on top of the execution cap. A
    // first run also gets every request its approved requests for more granted (budget control D3).
    const cap = v.repairCap ?? runCap(d.cfg, task.spec, plan.tier, v.contract) + extraRequests(this.d.db, task.row.id);
    if(d.cfg.profiles[task.spec.profile]?.mode==="supervisor"&&projectToolIdentity(d.db,d.cfg.brain.project)&&!this.d.servicesForLease)throw new Error("Split supervisor requires captured lease-bound services factory");
    return {
      cfg: d.cfg,
      profile: d.cfg.profiles[task.spec.profile]!,
      spec: task.spec,
      taskId: task.row.id,
      leaseOwner: this.d.owner,
      claimedRunCount: this.runLeases.lease(task).runCount,
      taskLease: this.runLeases.lease(task),
      taskProject: task.row.project_id || d.cfg.brain.project,
      taskLabs: d.labs,
      ensureLabsSupervisor: d.ensureLabsSupervisor,
      // The contract's allocation keeps the review (and, on the first run, repair) reserves free.
      budget: { ...budget, maxModelRequests: cap },
      contract: v.contract?.contract ?? null,
      retry: v.retry,
      ...(v.repairCap != null ? { purpose: "repair" as const } : {}),
      gate: this.d.gate,
      tasks: d.tasks,
      artifacts: d.artifacts,
      signal,
      now: this.d.now,
      tier: plan.tier,
      plan,
      attempts: routing.attempts,
      brain: d.brain,
      installBrain: this.d.brain,
      access: d.access,
      effort: effortFor(task.spec, task.row.id),
      jobId: jobIdFor(task),
      services: this.d.servicesForLease ? this.d.servicesForLease(this.runLeases.lease(task)) : this.d.services ? projectToolIdentity(d.db,d.cfg.brain.project) ? createProjectWorkerReadServices(d,this.runLeases.lease(task)) : { ...this.d.services, cancelTasks: ids => this.cancelTasksAsync(ids, task.row.project_id, this.runLeases.lease(task)) } : null,
      session,
      resume,
      web: this.d.web ?? null,
      ...(lab ? { lab } : {}),
    };
  }

  /** Heartbeats the lease, watches for cancellation, and enforces the deadline. */

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

  /**
   * The task's acceptance contract (compiled now or stored earlier). When the verification
   * policy needs more requests than the task allows, the task fails here and null is returned.
   */
  private async contractFor(task: StoredTask, tier: TierName, classification: Prepared["classification"]): Promise<StoredContract | null> {
    const c = ensureContract(
      { cfg: this.depsFor(task).cfg, tasks: this.d.tasks, contracts: this.d.contracts, requestsUsed: (id) => this.d.gate.admission.taskTotals(id).requests, now: this.d.now },
      task,
      tier,
      classification,
    );
    if (c.ok) {
      if (JSON.stringify(c.stored.contract.declaredLabChecks) !== JSON.stringify(task.spec.constraints.labChecks ?? [])) {
        await this.record(task, "failed", contractShortfall(task.spec, "Stored task Lab check selection differs from the submitted task"));
        return null;
      }
      return c.stored;
    }
    await this.record(task, "failed", contractShortfall(task.spec, c.message));
    return null;
  }

  /**
   * The verification phase's view of one run: its tier and session, and the executor's hooks
   * (the reviewer's run context, and the watchdog following the reviewer while it works).
   */
  private reviewRun(task: StoredTask, signal: AbortSignal, routing: Routing, session: SessionRecorder | null, contract: StoredContract, tier: TierName, repairPossible: boolean): ReviewRun {
    return {
      tier,
      signal,
      session,
      jobId: jobIdFor(task),
      repairPossible,
      reviewerContext: (plan, reviewer, maxModelRequests, attempts, profile) => {
        const ctx = this.context(task, signal, plan, routing, reviewer, { contract, retry: null });
        return { ...ctx, profile: this.d.cfg.profiles[profile]!, budget: { ...ctx.budget, maxModelRequests }, attempts, purpose: "verification" };
      },
      onReviewer: (reviewer) => {
        const watch = this.watched.get(task.row.id);
        if (watch?.task.row.lease_incarnation === task.row.lease_incarnation && watch.task.row.run_count === task.row.run_count && (reviewer || watch.reviewer)) Object.assign(watch, { reviewer, phaseAt: this.d.now() });
      },
    };
  }

  /**
   * Context injection for dependents: the task as its runs see it, with its upstream results
   * frozen into its context (see context/upstream.ts). A failure to build it is recorded and
   * the task runs with its spec as submitted.
   */
  private async withUpstream(task: StoredTask): Promise<StoredTask> {
    try {
      const contextual = await withUpstreamContext({ cfg: this.depsFor(task).cfg, tasks: this.d.tasks, artifacts: this.d.artifacts }, task);
      if (task.spec.constraints.labChecks?.length) return { ...contextual, spec: { ...contextual.spec, context: { ...contextual.spec.context, baseCommits: task.spec.context.baseCommits } } };
      return contextual;
    } catch (err) {
      this.d.tasks.event(task.row.id, "upstream_context_failed", { error: (err as Error).message });
      return task;
    }
  }

  /** Whether this run is the redundant pair its plan node asked for (null: one run, as usual). */
  private redundancy(task: StoredTask, mode: ProfileMode, plan: RoutePlan, contract: StoredContract | null, o: { firstAttempt: boolean; pinned: boolean }): RedundancyPlan | null {
    const requested = redundancyFor(this.d.db, task.spec);
    if (requested < 2) return null;
    const used = requestsUsed(this.d.gate, task.row.id).total;
    const r = planRedundancy({ requested, mode, plan, contract, runCap: runCap(this.depsFor(task).cfg, task.spec, plan.tier, contract), used, ...o });
    if (r.kind === "skip") this.d.tasks.event(task.row.id, REDUNDANCY_SKIPPED, { reason: r.reason });
    if (r.kind === "refuse") this.d.tasks.event(task.row.id, REDUNDANCY_SKIPPED, { reason: r.reason, refused: true });
    return r.kind === "single" || r.kind === "skip" ? null : r;
  }

  /** The redundant pair of a task's first attempt (see `raceTwins`), wired to this executor. */
  private runTwins(task: StoredTask, parent: AbortController, routing: Routing, contract: StoredContract, mode: ProfileMode, st: Parameters<typeof verifyWithReview>[5], twin: Extract<RedundancyPlan, { kind: "twin" }>, previous: string | null | undefined, adopt: (session: SessionRecorder | null) => void): Promise<TwinResult> {
    const watch = this.watched.get(task.row.id);
    const own = watch?.session;
    return raceTwins(parent.signal, twin, previous, {
      open: (plan, prev) => this.openSession(task, plan, prev),
      run: (r) => {
        const ctx = this.context(task, r.controller.signal, r.plan, routing, r.session, { contract, retry: null });
        return this.runMode({ ...ctx, budget: { ...ctx.budget, maxModelRequests: twin.cap } });
      },
      verify: (r, outcome) => verifyWithReview(this.depsFor(task), task, contract, mode, outcome, st, this.reviewRun(task, r.controller.signal, routing, r.session, contract, r.plan.tier, repairPossible(this.d.gate, task, contract, st, false))),
      end: (s, status, stopReason) => this.endSession(task, s, status, stopReason),
      endWithError: (s, err) => this.endForDisposition(task, s, this.classify(err, parent.signal, task)),
      event: (type, data) => this.d.tasks.event(task.row.id, type, data),
      served: (s) => (s ? (this.d.db.prepare("SELECT DISTINCT name FROM session_events WHERE session_id = ? AND type = 'model_response' AND name IS NOT NULL").all(s.id) as Array<{ name: string }>).map((x) => x.name) : []),
      adopt,
      watch: (current) => {
        if (watch && own) watch.session = current ?? own;
      },
    });
  }

  private async tooDifficult(task: StoredTask, prepared: Prepared): Promise<void> {
    const c = prepared.classification;
    await this.record(task, "failed", baseResult({
      executionStatus: "failed",
      stopReason: `too_difficult_for_workers: ${c.rejectReason}`,
      summary: `Not delegated. ${c.rejectReason}. Score ${c.score}: ${c.breakdown.filter((l) => l.points).map((l) => `${l.detail} (+${l.points})`).join(", ")}.`,
      unresolvedCriteria: criterionTexts(task.spec),
    }));
  }

  async runSingle(task: StoredTask): Promise<void> {
    this.runLeases.lease(task);
    const controller = new AbortController();
    this.controllers.set(task.row.id, controller);
    const release = this.runLeases.supervise(task, controller);
    const routing: Routing = { classification: null, tier: null, escalatedFrom: null, attempts: [] };
    this.routing.set(task.row.id, routing);
    let session: SessionRecorder | null = null;
    this.watched.set(task.row.id, { task, controller, session: () => session, reviewer: null, phaseAt: this.d.now() });
    // A simulated crash (fault injection) skips every cleanup a dying process could not do.
    let crashed = false;
    try {
      // Sessions of this task still running belong to a dead process: this one holds the lease now.
      this.d.sessions?.markDeadRunning((s) => s.taskId !== task.row.id);
      let prepared: Prepared;
      let d: ExecutorDeps;
      try {
        d = this.depsFor(task);
        if (d.labs) {
          const binding = d.labs.bindTask(task.row.project_id || d.cfg.brain.project, task.row.id, task.spec, d.tasks);
          if (binding) await d.labs.assertTaskBases(binding, task.spec, d.tasks);
        }
        prepared = await this.d.router.prepare(task, this.d.owner, d.cfg);
      } catch (err) {
        if (isSimulatedCrash(err)) {
          crashed = true;
          return;
        }
        await this.settle(task, this.classify(err, controller.signal, task));
        return;
      }
      routing.classification = prepared.classification;
      if (!prepared.plan) {
        await this.tooDifficult(task, prepared);
        return;
      }
      // A dependent sees its upstream results (and, for coding, its chosen base commit) from here on.
      task = await this.withUpstream(task);
      let plan = prepared.plan;
      const mode = this.d.cfg.profiles[task.spec.profile]!.mode;
      // Supervisor jobs are judged by their own job checks; every other task gets a contract.
      let contract: StoredContract | null = null;
      if (mode !== "supervisor") {
        const c = await this.contractFor(task, plan.tier, prepared.classification);
        if (!c) return;
        contract = c;
      }
      let previous: string | null | undefined;
      const forced = !!task.spec.routing?.endpointId;
      // Only the first attempt resumes; an escalation always starts fresh.
      let resume: RunResume | null = null;
      try {
        resume = resumeFor(d, task);
      } catch (err) {
        // Explicit failed-supervisor recovery must retain its transcript/workspace or fail closed.
        if (this.d.tasks.events(task.row.id, 500).some(event => event.type === "resumed" && (event.data as { failedObservationRecovery?: boolean } | undefined)?.failedObservationRecovery)) throw err;
        // An unreadable or already-claimed session: run fresh (linked to it) rather than not at all.
        this.d.tasks.event(task.row.id, "session_resume_failed", { error: (err as Error).message });
      }
      // Verification and the one retry span the task's runs: a run after an interruption
      // continues them (the same repair run, at its tier) instead of starting over.
      const exempt = mode === "supervisor" || forced || (task.row as typeof task.row & { purpose?: string }).purpose === "qualification";
      const continued = continueRun(d, task, plan, prepared.inputModalities, { interruptedTier: () => interruptedTier(this.d.sessions, task, resume), exempt });
      const st = continued.st;
      let retry: RetryContext | null = continued.retry;
      let repairing = continued.repairing;
      plan = continued.plan;
      routing.escalatedFrom = continued.escalatedFrom;
      // Redundant execution (T2): a plan node's first attempt may run twice, on different endpoints.
      let twin = this.redundancy(task, mode, plan, contract, { firstAttempt: !resume && !repairing && !retry, pinned: exempt });
      if (twin?.kind === "refuse") {
        await this.record(task, "failed", redundancyRefused(task.spec, twin.reason));
        return;
      }
      for (;;) {
        routing.tier = plan.tier;
        let outcome: RunOutcome;
        let raced: VerifiedRun | null = null;
        try {
          if (twin?.kind === "twin" && contract) {
            const t = twin;
            twin = null;
            const r = await this.runTwins(task, controller, routing, contract, mode, st, t, previous, (s) => (session = s));
            if (r.kind === "error") throw r.error;
            outcome = r.outcome;
            raced = r.verified;
          } else {
            session = resume ? resume.session : this.openSession(task, plan, previous);
            // A repair run (also one resumed after an interruption) draws on the repair reserve.
            const cap = repairing && contract ? repairCap(contract.contract.budget, requestsUsed(this.d.gate, task.row.id)) : null;
            const ctx = this.context(task, controller.signal, plan, routing, session, { contract, retry, repairCap: cap }, resume ? { plan: resume.plan } : null);
            resume = null;
            outcome = await this.runMode(ctx);
          }
        } catch (err) {
          if (isSimulatedCrash(err)) {
            crashed = true;
            return;
          }
          const d = this.classify(err, controller.signal, task);
          this.endForDisposition(task, session, d);
          await this.settle(task, d);
          return;
        }
        if (controller.signal.aborted) {
          const d = this.classify(new Error("aborted"), controller.signal, task);
          this.endForDisposition(task, session, d);
          await this.settle(task, d, outcome.result);
          return;
        }
        let verified: VerifiedRun["verified"] | null = null;
        let settle: VerifiedRun["settle"] | null = null;
        if (raced) {
          // The redundant runs were verified as they finished.
          verified = raced.verified;
          settle = raced.settle;
        } else if (contract) {
          try {
            const run = this.reviewRun(task, controller.signal, routing, session, contract, plan.tier, repairPossible(this.d.gate, task, contract, st, forced));
            const v = await verifyWithReview(d, task, contract, mode, outcome, st, run);
            outcome = v.outcome;
            verified = v.verified;
            settle = v.settle;
          } catch (err) {
            if (isSimulatedCrash(err)) {
              crashed = true;
              return;
            }
            const d = this.classify(err, controller.signal, task);
            this.endForDisposition(task, session, d);
            await this.settle(task, d, outcome.result);
            return;
          }
        }
        let result: RunnerResult = verified ? verified.result : { ...outcome.result, verificationStatus: "not_required" };
        const planned = await planRetry(d, task, st, { mode, plan, inputModalities: prepared.inputModalities, outcome, result, verified, contract, escalatedFrom: routing.escalatedFrom, forced });
        if (planned) {
          retry = planned.retry;
          repairing = true;
          const e = sessionEnd(outcome.state, outcome.result.stopReason);
          this.endSession(task, session, e.status, planned.tier !== plan.tier ? `${e.stopReason}; escalated to ${planned.tier}` : `${e.stopReason}; repair at ${planned.tier}`);
          previous = session?.id ?? null;
          session = null;
          if (planned.tier !== plan.tier) {
            routing.escalatedFrom = plan.tier;
            this.d.db.prepare("UPDATE tasks SET tier = ? WHERE id = ?").run(planned.tier, task.row.id);
          }
          plan = planned.plan;
          continue;
        }
        // A repair was called for but cannot run (forced endpoint, no budget or candidates): decide
        // as if no retry remained.
        if (verified?.decision.action === "repair" && settle) result = settle().result;
        const e = sessionEnd(outcome.state, outcome.result.stopReason);
        this.endSession(task, session, e.status, e.stopReason);
        await this.record(task, outcome.state, result);
        return;
      }
    } finally {
      // Whatever escaped above (a store or recording failure), never leave the session running.
      if (!crashed) this.endSession(task, session, "failed", "executor_error");
      if (this.controllers.get(task.row.id) === controller) { this.watched.delete(task.row.id); this.routing.delete(task.row.id); }
      await release();
    }
  }

  async runBatch(tasks: StoredTask[]): Promise<void> {
    // Members share one physical request; a member's cancellation is applied when it finishes.
    for (const task of tasks) this.runLeases.lease(task);
    const shared = new AbortController();
    const ownControllers = new Map<string, AbortController>();
    const releases = tasks.map((t) => {
      const c = new AbortController();
      ownControllers.set(t.row.id, c);
      this.controllers.set(t.row.id, c);
      c.signal.addEventListener("abort", () => {
        if (c.signal.reason === "shutdown" || tasks.every((x) => ownControllers.get(x.row.id)?.signal.aborted)) shared.abort(c.signal.reason);
      });
      return this.runLeases.supervise(t, c);
    });
    const sessions = new Map<string, SessionRecorder>();
    let crashed = false;
    try {
      // Classify each member; the shared request uses the hardest member's tier.
      const members: StoredTask[] = [];
      const prepared = new Map<string, Prepared>();
      for (const t of tasks) {
        const routing: Routing = { classification: null, tier: null, escalatedFrom: null, attempts: [] };
        this.routing.set(t.row.id, routing);
        try {
          const deps = this.depsFor(t);
          const binding = deps.labs?.bindTask(t.row.project_id || deps.cfg.brain.project, t.row.id, t.spec, deps.tasks);
          if (binding) await deps.labs!.assertTaskBases(binding, t.spec, deps.tasks);
          const p = await this.d.router.prepare(t, this.d.owner, deps.cfg);
          routing.classification = p.classification;
          if (!p.plan) await this.tooDifficult(t, p);
          else {
            prepared.set(t.row.id, p);
            members.push(await this.withUpstream(t));
          }
        } catch (err) {
          await this.settle(t, this.classify(err, ownControllers.get(t.row.id)!.signal, t));
        }
      }
      if (!members.length) return;
      const tier = members.map((m) => prepared.get(m.row.id)!.plan!.tier).reduce((a, b) => (TIER_NAMES.indexOf(b) > TIER_NAMES.indexOf(a) ? b : a));
      const plan = prepared.get(members.find((m) => prepared.get(m.row.id)!.plan!.tier === tier)!.row.id)!.plan!;
      for (const m of members) this.routing.get(m.row.id)!.tier = tier;
      // Each member's contract is compiled at its own classified tier; a member whose policy
      // cannot fit its budget fails before the shared request.
      const contracts = new Map<string, StoredContract>();
      for (const m of [...members]) {
        const c = await this.contractFor(m, prepared.get(m.row.id)!.plan!.tier, prepared.get(m.row.id)!.classification);
        if (c) contracts.set(m.row.id, c);
        else members.splice(members.indexOf(m), 1);
      }
      if (!members.length) return;

      let outcomes: Map<string, RunOutcome>;
      try {
        // Each member is its own session; the batch runner records the shared request in every one.
        const ctxs: RunContext[] = [];
        for (const t of members) {
          const session = this.openSession(t, plan);
          if (session) sessions.set(t.row.id, session);
          ctxs.push(this.context(t, shared.signal, plan, this.routing.get(t.row.id)!, session, { contract: contracts.get(t.row.id) ?? null, retry: null }));
        }
        outcomes = await runBatch(ctxs);
      } catch (err) {
        if (isSimulatedCrash(err)) {
          crashed = true;
          return;
        }
        const retained = err as { batchOutcomes?: Map<string, RunOutcome>; batchPendingTaskIds?: string[] };
        outcomes = retained.batchOutcomes ?? new Map();
        const pendingIds = retained.batchPendingTaskIds ?? members.map((t) => t.row.id);
        for (const t of [...members]) {
          if (!pendingIds.includes(t.row.id)) continue;
          const d = this.classify(err, ownControllers.get(t.row.id)?.signal ?? shared.signal, t);
          this.endForDisposition(t, sessions.get(t.row.id) ?? null, d);
          await this.settle(t, d);
          members.splice(members.indexOf(t), 1);
        }
        // Retained completions go through the same session end, verification and recording
        // path as a successful batch. Pending members have already received their disposition.
      }
      for (const t of members) {
        const o = outcomes.get(t.row.id);
        const session = sessions.get(t.row.id) ?? null;
        if (o) {
          const e = sessionEnd(o.state, o.result.stopReason);
          this.endSession(t, session, e.status, e.stopReason);
          const contract = contracts.get(t.row.id);
          if (!contract) {
            await this.record(t, o.state, o.result);
            continue;
          }
          // Members are reviewed one by one when their level requires it (no repair inside a batch).
          const signal = ownControllers.get(t.row.id)?.signal ?? shared.signal;
          try {
            const run = this.reviewRun(t, signal, this.routing.get(t.row.id)!, session, contract, tier, false);
            const v = await verifyWithReview(this.depsFor(t), t, contract, this.d.cfg.profiles[t.spec.profile]!.mode, o, restoreRunState(this.d.tasks, t.row.id).st, run);
            await this.record(t, o.state, v.verified.decision.action === "repair" ? v.settle().result : v.verified.result);
          } catch (err) {
            if (isSimulatedCrash(err)) {
              crashed = true;
              return;
            }
            await this.settle(t, this.classify(err, signal, t), o.result);
          }
        } else {
          this.endSession(t, session, "failed", "batch_member_unaccounted");
          await this.settle(t, { kind: "final", state: "failed", stopReason: "batch_member_unaccounted" });
        }
      }
    } finally {
      // Members that left the batch without an outcome (an error escaped) still end their sessions.
      if (!crashed) for (const t of tasks) this.endSession(t, sessions.get(t.row.id) ?? null, "failed", "batch_aborted");
      for (const t of tasks) if (this.controllers.get(t.row.id) === ownControllers.get(t.row.id)) this.routing.delete(t.row.id);
      await Promise.all(releases.map(release => release()));
    }
  }

  private classify(err: unknown, signal: AbortSignal, task: StoredTask): Disposition {
    return classifyFailure(err, signal, { cfg: this.d.cfg, now: () => this.d.now(), deadline: () => this.d.tasks.get(task.row.id)?.row.deadline_at ?? Infinity });
  }

  private async settle(task: StoredTask, d: Disposition, partial?: RunnerResult): Promise<void> {
    if (d.kind === "abandon") {
      if (d.reason === "shutdown" || d.reason === WATCHDOG_STOP) {
        const lease = this.runLeases.lease(task), operationId = leaseOperationId(this.d.now());
        const receipt = await this.runLeases.trackLease(reconcileLeaseOperation(() => this.taskLeases.interrupt({ lease, operationId, reason: d.reason === "shutdown" ? "worker shut down" : "no progress: stopped by the watchdog", resume: d.reason === WATCHDOG_STOP, sessionId: this.watched.get(task.row.id)?.session()?.id })));
        if (receipt.kind !== "interrupt" || receipt.operationId !== operationId || canonicalJson(receipt.lease) !== canonicalJson(lease)) throw new Error("interrupt receipt identity mismatch");
        if (receiptApplied(receipt) && this.sameGeneration(lease)) this.d.onSettled(task.row.id);
      }
      return;
    }
    if (d.kind === "defer") {
      const lease = this.runLeases.lease(task), operationId = leaseOperationId(this.d.now());
      const receipt = await this.runLeases.trackLease(reconcileLeaseOperation(() => this.taskLeases.defer({ lease, operationId, nextAttemptAt: d.at, reason: d.reason })));
      if (receipt.kind !== "defer" || receipt.operationId !== operationId || canonicalJson(receipt.lease) !== canonicalJson(lease)) throw new Error("defer receipt identity mismatch");
      if (receiptApplied(receipt) && this.sameGeneration(lease)) this.d.onSettled(task.row.id);
      return;
    }
    const status = d.state === "completed" ? "failed" : d.state;
    await this.record(
      task,
      d.state,
      baseResult({
        ...(partial ?? {}),
        executionStatus: status as WorkerResult["executionStatus"],
        stopReason: d.stopReason,
        summary: d.summary ?? partial?.summary ?? "",
        acceptanceStatus: partial?.acceptanceStatus === "unmet" ? "unmet" : "not_verified",
        unresolvedCriteria: partial?.unresolvedCriteria.length ? partial.unresolvedCriteria : criterionTexts(task.spec),
      }),
    );
  }

  private async record(task: StoredTask, state: TaskState, runner: RunnerResult): Promise<void> {
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
    const submittedResult = structuredClone(result);
    const lease = this.runLeases.lease(task), operationId = leaseOperationId(this.d.now());
    const receipt = await this.runLeases.trackLease(reconcileLeaseOperation(() => this.taskLeases.finish({ lease, operationId, result: submittedResult, state: state as "completed" | "failed" | "cancelled" | "budget_exhausted" | "interrupted" })));
    if (receipt.kind !== "finish" || receipt.operationId !== operationId || canonicalJson(receipt.lease) !== canonicalJson(lease) || !receiptApplied(receipt) || !this.sameGeneration(lease) || this.published.has(lease)) return;
    const persisted = this.d.tasks.get(task.row.id);
    if (!persisted?.result || !receipt.state || persisted.row.state !== receipt.state || !receipt.resultDigest || receipt.resultDigest !== createHash("sha256").update(canonicalJson(persisted.result)).digest("hex")) return;
    this.published.add(lease);
    const final = receipt.state!;
    const mode = this.d.cfg.profiles[task.spec.profile]?.mode;
    const d = this.tryDepsFor(task);
    if (d?.brain && mode && mode !== "supervisor" && final !== "running") {
      const p = writeWorkerReport(
        { cfg: d.cfg, brain: d.brain, access: d.access, spec: task.spec, taskId: task.row.id, effort: effortFor(task.spec, task.row.id), jobId: task.spec.parentTaskId ?? null,taskLease:lease,taskReceipt:receipt, tier: (r?.tier ?? null) as never },
        roleForProfile(task.spec.profile),
        runner,
        final,
      ).finally(() => {
        this.reports.delete(p);
      });
      this.reports.add(p);
    }
    this.d.onSettled(task.row.id);
  }

  private sameGeneration(lease: LeaseRef): boolean {
    const row = this.d.tasks.get(lease.taskId)?.row;
    return row?.lease_incarnation === lease.incarnation && row.run_count === lease.runCount;
  }

  /** Progress watchdog, called on every scheduler tick (see `abortStuckRuns`). Returns the aborted task ids. */
  checkWatchdog(): string[] {
    return abortStuckRuns(this.d, this.watched);
  }

  abortAll(reason: AbortReason): void {
    for (const c of this.controllers.values()) c.abort(reason);
  }
}
