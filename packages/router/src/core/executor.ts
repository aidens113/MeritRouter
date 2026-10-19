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
import { criterionTexts, WorkerResultSchema, type TaskState, type WorkerResult } from "./task.js";
import { restoreRunState, retryStarted, RETRY_STARTED, REVIEW_RECORDED, type VerificationState } from "./retry-state.js";
import type { ProfileName } from "../config/schema.js";
import { baseResult, type RetryContext, type RunContext, type RunOutcome, type RunnerResult } from "../runners/types.js";
import { repairCap, reviewReserveAdjustment, type ContractStore, type StoredContract } from "../verification/contract.js";
import { reviewResult, type ReviewPhaseResult } from "../verification/review.js";
import { repairRetryContext, runTargetedChecks, submittedRevisionStart, targetedCheckAllowed } from "../verification/followup.js";
import { ensureContract, failureContext, nextTier, runCap, verifyOutcome, type VerifiedOutcome } from "./acceptance.js";
import { runCompletion } from "../runners/completion.js";
import { runReadOnly } from "../runners/readonly.js";
import { runBatch } from "../runners/batch.js";
import type { Classification } from "../scoring/score.js";
import type { Brain } from "../brain/brain.js";
import type { BrainAccess } from "../brain/access.js";
import type { SupervisorServices } from "../runners/types.js";
import { writeWorkerReport } from "../harness/worker.js";
import { agentLabel, roleForProfile } from "../roles/index.js";
import type { SessionRecord, SessionStore } from "../sessions/store.js";
import type { SessionRecorder } from "../sessions/recorder.js";
import type { SessionEndStatus } from "../sessions/events.js";
import type { ResumePlan } from "../sessions/resume.js";
import { isSimulatedCrash } from "./faults.js";
import { sessionProgress, watchdogVerdict } from "./watchdog.js";
import { MAX_AUTO_RESUMES } from "./scheduler.js";
import { z } from "zod";

/** The working document a task belongs to: its job's, an explicit one, or the shared ad-hoc one. */
export function effortFor(spec: { profile: string; parentTaskId?: string | undefined; brain?: { effort?: string | undefined } | undefined }, taskId: string): string {
  if (spec.brain?.effort) return spec.brain.effort;
  if (spec.profile === "supervise") return `job-${taskId}`;
  if (spec.parentTaskId) return `job-${spec.parentTaskId}`;
  return "adhoc";
}

export type AbortReason = "cancel" | "deadline" | "lease_lost" | "shutdown" | "watchdog";

/** Stop reason of a session the progress watchdog aborted; the task is re-queued to resume it. */
export const WATCHDOG_STOP = "watchdog";

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
  /** Agent sessions; null runs without recording (each run's `ctx.session` stays null). */
  sessions: SessionStore | null;
  /** Acceptance contracts, compiled after classification and before the first run. */
  contracts: ContractStore;
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

/** Task event written when a session delegates the task (see `Switchyard.submitTasks`). */
export const DELEGATED_BY_SESSION = "delegated_by_session";
const DelegatedBySchema = z.object({ sessionId: z.string().min(1) });

/**
 * Data of the task event `resumed` (see `TaskStore.resume`): how the next run should start.
 * `sessionId` resumes that session; `freshWorkspace` starts a coding task over in a new
 * worktree (the operator's `resume <task>`). Without either, an interrupted latest session is
 * resumed when its role allows it.
 */
export const ResumeDirectiveSchema = z.object({ sessionId: z.string().min(1).optional(), freshWorkspace: z.boolean().optional() }).strict();
export type ResumeDirective = z.infer<typeof ResumeDirectiveSchema>;

/** Profile modes whose runs continue an interrupted session (agent loops); the others re-run fresh. */
const RESUMABLE_MODES = new Set(["read_only", "coding", "supervisor"]);

/** A run's outcome state as a session end status: a spent budget is a failure with that reason. */
export function sessionEnd(state: RunOutcome["state"], stopReason: string): { status: SessionEndStatus; stopReason: string } {
  if (state === "budget_exhausted") return { status: "failed", stopReason: "budget_exhausted" };
  return { status: state, stopReason: stopReason || state };
}

/**
 * The task's own runs, oldest first: not its classifier sessions, and not the reviewer sessions
 * that are children of its runs (a reviewer's parent is a session of the same task).
 */
export function authorSessions(store: SessionStore, taskId: string): SessionRecord[] {
  const all = store.forTask(taskId);
  const ids = new Set(all.map((s) => s.id));
  return all.filter((s) => s.role !== "classifier" && !(s.parentSessionId && ids.has(s.parentSessionId)));
}

/** The author session a session belongs to: itself, or for a reviewer the run it reviewed. */
function authorOf(store: SessionStore, s: SessionRecord): SessionRecord | null {
  if (!s.taskId || !s.parentSessionId) return s;
  const parent = store.get(s.parentSessionId);
  return parent && parent.taskId === s.taskId ? parent : s;
}

/** The job a task belongs to: a supervise task is its own job; a delegated task belongs to its parent's. */
function jobIdFor(task: StoredTask): string | null {
  return task.spec.profile === "supervise" ? task.row.id : (task.spec.parentTaskId ?? null);
}

/** Runs claimed units (single tasks or prompt batches) and records their outcomes. */
export class Executor {
  readonly controllers = new Map<string, AbortController>();
  private readonly routing = new Map<string, Routing>();
  private readonly reports = new Set<Promise<unknown>>();
  /**
   * Single-task runs the progress watchdog looks at: the run's (author's) session, the reviewer
   * session while a review runs (the one making progress then), and when that phase began.
   */
  private readonly watched = new Map<string, { task: StoredTask; controller: AbortController; session: () => SessionRecorder | null; reviewer: SessionRecorder | null; phaseAt: number }>();

  /** Wait for pending brain report writes (called on shutdown). */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.reports]);
  }

  constructor(private readonly d: ExecutorDeps) {}

  /**
   * Open the session for one run of a task: a recovery re-run or an escalation links to the
   * task's previous run, and a delegated task to the session that delegated it.
   */
  private openSession(task: StoredTask, plan: RoutePlan, previousSessionId?: string | null): SessionRecorder | null {
    const store = this.d.sessions;
    if (!store) return null;
    const id = task.row.id;
    const role = roleForProfile(task.spec.profile);
    const previous = previousSessionId !== undefined ? previousSessionId : (authorSessions(store, id).at(-1)?.id ?? null);
    const delegatedBy = this.d.tasks
      .events(id, 500)
      .filter((e) => e.type === DELEGATED_BY_SESSION)
      .map((e) => DelegatedBySchema.safeParse(e.data))
      .find((r) => r.success)?.data?.sessionId;
    return store.create({
      taskId: id,
      jobId: jobIdFor(task),
      parentSessionId: delegatedBy ?? null,
      previousSessionId: previous,
      role,
      agentLabel: agentLabel(role, task.spec.label ?? id),
      profile: task.spec.profile,
      tier: plan.tier,
    });
  }

  /** The directive of the `resumed` task event that queued the current run, if any. */
  private resumeDirective(taskId: string): ResumeDirective {
    const events = this.d.tasks.events(taskId, 500);
    let claim = -1;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]!.type === "claimed") {
        claim = i;
        break;
      }
    }
    for (let i = claim - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.type === "claimed") break;
      if (e.type === "resumed") {
        const d = ResumeDirectiveSchema.safeParse(e.data ?? {});
        return d.success ? d.data : {};
      }
    }
    return {};
  }

  /**
   * The resume rule: a run continues the task's latest session (or the one a directive names)
   * when that session is `interrupted` and the task's mode is an agent loop, unless the
   * operator asked a coding task to start over. The session is reopened and its plan returned;
   * null means a fresh run (linked to the previous session).
   */
  private resumeFor(task: StoredTask): { session: SessionRecorder; plan: ResumePlan } | null {
    const store = this.d.sessions;
    const mode = this.d.cfg.profiles[task.spec.profile]?.mode;
    if (!store || !mode || !RESUMABLE_MODES.has(mode)) return null;
    const directive = this.resumeDirective(task.row.id);
    if (directive.freshWorkspace && mode === "coding" && !directive.sessionId) return null;
    const named = directive.sessionId ? store.get(directive.sessionId) : null;
    // A reviewer is never resumed: the run continues the author's session it reviewed (an
    // accepted submission then finishes without a request and verification runs again).
    const target = named ? authorOf(store, named) : (authorSessions(store, task.row.id).at(-1) ?? null);
    if (!target || target.taskId !== task.row.id || target.status !== "interrupted") return null;
    const plan = store.planResume(target.id, { recoverEdits: this.d.cfg.sessions.recover_edits });
    if (!plan || plan.messages.length === 0) return null; // nothing logged: start fresh
    const session = store.reopen(target.id);
    this.d.tasks.event(task.row.id, "session_resumed", { sessionId: target.id, actions: plan.actions.map((a) => a.kind), warnings: plan.warnings });
    return { session, plan };
  }

  /**
   * The tier of the run this one continues after an interruption: the resumed session's, or
   * the latest author session's when it ended `interrupted` (crash, shutdown, lease loss,
   * watchdog, capacity deferral). Null when the previous run ended otherwise or there is none.
   */
  private interruptedTier(task: StoredTask, resume: { session: SessionRecorder } | null): TierName | null {
    const store = this.d.sessions;
    if (!store) return null;
    const last = resume ? store.get(resume.session.id) : (authorSessions(store, task.row.id).at(-1) ?? null);
    if (!last || (!resume && last.status !== "interrupted")) return null;
    return last.tier;
  }

  /** End a run's session. The task outcome is already decided, so a recording failure is logged, not thrown. */
  private endSession(task: StoredTask, session: SessionRecorder | null, status: SessionEndStatus, stopReason: string): void {
    if (!session || session.ended) return;
    try {
      session.end(status, stopReason);
    } catch (err) {
      this.d.tasks.event(task.row.id, "session_record_failed", { sessionId: session.id, error: (err as Error).message });
    }
  }

  /** End a session for a disposition reached without a runner outcome (errors, aborts, deferrals). */
  private endForDisposition(task: StoredTask, session: SessionRecorder | null, d: Disposition): void {
    if (d.kind === "final") {
      const e = sessionEnd(d.state, d.stopReason);
      this.endSession(task, session, e.status, e.stopReason);
    } else if (d.kind === "defer") this.endSession(task, session, "interrupted", `deferred_for_capacity: ${d.reason}`);
    else this.endSession(task, session, "interrupted", d.reason);
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
    const budget = effectiveBudget(this.d.cfg, task.spec, plan.tier);
    // A repair (or escalation) run draws on the repair reserve, on top of the execution cap.
    const cap = v.repairCap ?? runCap(this.d.cfg, task.spec, plan.tier, v.contract);
    return {
      cfg: this.d.cfg,
      profile: this.d.cfg.profiles[task.spec.profile]!,
      spec: task.spec,
      taskId: task.row.id,
      leaseOwner: this.d.owner,
      // The contract's allocation keeps the review (and, on the first run, repair) reserves free.
      budget: { ...budget, maxModelRequests: cap },
      contract: v.contract?.contract ?? null,
      retry: v.retry,
      ...(v.repairCap != null ? { purpose: "repair" as const } : {}),
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
      jobId: jobIdFor(task),
      services: this.d.services,
      session,
      resume,
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

  /**
   * The task's acceptance contract (compiled now or stored earlier). When the verification
   * policy needs more requests than the task allows, the task fails here and null is returned.
   */
  private contractFor(task: StoredTask, tier: TierName, classification: Prepared["classification"]): StoredContract | null {
    const c = ensureContract(
      { cfg: this.d.cfg, tasks: this.d.tasks, contracts: this.d.contracts, requestsUsed: (id) => this.d.gate.admission.taskTotals(id).requests, now: this.d.now },
      task,
      tier,
      classification,
    );
    if (c.ok) return c.stored;
    this.record(task, "failed", baseResult({
      executionStatus: "failed",
      stopReason: `verification_budget_insufficient: ${c.message}`,
      summary: `Not run. ${c.message}.`,
      unresolvedCriteria: criterionTexts(task.spec),
    }));
    return null;
  }

  /** Verify one outcome against the contract; a level raised by the actual change (or tier) is recorded once. */
  private verify(task: StoredTask, contract: StoredContract, mode: Parameters<typeof verifyOutcome>[2], outcome: RunOutcome, qualityRetriesUsed: number, opts: Parameters<typeof verifyOutcome>[5] = {}, announce = true) {
    const v = verifyOutcome(this.d.cfg.verification, contract, mode, outcome, qualityRetriesUsed, opts);
    const re = v.reevaluation;
    if (re.raised && announce) {
      // A raised level that needs more review than the contract reserved draws it from the room under the ceiling.
      const reserve = reviewReserveAdjustment(this.d.cfg.verification, contract.contract.budget, re.level, re.review.required);
      this.d.tasks.event(task.row.id, "verification_raised", { from: contract.contract.verification.level, to: re.level, importance: re.importance, importanceSource: re.importanceSource, newRules: re.newRules, checks: re.checks, ...(opts?.tier ? { tier: opts.tier } : {}), ...(reserve ? { reserveAdjustment: { review: reserve } } : {}) });
    }
    return v;
  }

  /**
   * Verify a result and, when its level requires it, review it: cheap deterministic checks
   * first; an independent review only when they found no defect. A reviewer's request for a
   * targeted check runs once (coding) and is followed by a re-review while the allowance lasts.
   * Returns the (possibly extended) outcome, the verification, and `settle`: the same decision
   * when no quality retry can run after all (a reviewer-only defect then goes to the supervisor).
   */
  private async verifyWithReview(
    task: StoredTask,
    contract: StoredContract,
    mode: Parameters<typeof verifyOutcome>[2],
    start: RunOutcome,
    st: VerificationState,
    run: { tier: TierName; signal: AbortSignal; routing: Routing; session: SessionRecorder | null; repairPossible: boolean },
  ): Promise<{ outcome: RunOutcome; verified: VerifiedOutcome; settle: () => VerifiedOutcome }> {
    let outcome = start;
    let last: Parameters<typeof verifyOutcome>[5] = {};
    const opts = (extra: Parameters<typeof verifyOutcome>[5] = {}) => (last = { tier: run.tier, reviews: st.reviews, ...extra });
    const done = (verified: VerifiedOutcome) => ({ outcome, verified, settle: () => this.verify(task, contract, mode, outcome, Number.MAX_SAFE_INTEGER, last, false) });
    let verified = this.verify(task, contract, mode, outcome, st.qualityRetriesUsed, opts());
    const needsReview = (v: VerifiedOutcome) => v.reevaluation.review.required && outcome.result.executionStatus === "completed" && v.decision.acceptanceStatus !== "unmet";
    if (!needsReview(verified)) return done(verified);
    if ((task.row as typeof task.row & { purpose?: string }).purpose === "qualification") {
      // Qualification runs are graded by the evaluation suite; a reviewer would measure another model.
      return done(this.verify(task, contract, mode, outcome, st.qualityRetriesUsed, opts({ notes: ["qualification task: graded by the evaluation suite, not reviewed"] }), false));
    }
    const allowed = mode === "coding" ? targetedCheckAllowed(this.d.cfg, task.spec.constraints.checks ?? []) : null;
    let phase: ReviewPhaseResult | null = null;
    const notes: string[] = [];
    for (let round = 0; round < 2; round++) {
      const watch = this.watched.get(task.row.id);
      try {
        phase = await reviewResult(
        { cfg: this.d.cfg, db: this.d.db, gate: this.d.gate, catalog: this.d.catalog, router: this.d.router, tasks: this.d.tasks, artifacts: this.d.artifacts, sessions: this.d.sessions },
        {
          task,
          contract,
          outcome,
          reevaluation: verified.reevaluation,
          deterministic: verified.result.verification?.checks.map((c) => ({ name: c.name, outcome: c.outcome, detail: c.detail })) ?? [],
          tier: run.tier,
          attempt: ++st.attempts,
          // Keep half of the allowance for a re-review while a repair is still possible.
          share: run.repairPossible && round === 0 ? 0.5 : 1,
          parentSessionId: run.session?.id ?? null,
          jobId: jobIdFor(task),
          context: (plan, session, maxModelRequests, attempts, profile) => {
            // The watchdog follows the reviewer while it works (the author's session is idle then).
            if (watch) Object.assign(watch, { reviewer: session, phaseAt: this.d.now() });
            return this.reviewerContext(task, run.signal, plan, run.routing, session, contract, maxModelRequests, attempts, profile);
          },
          targetedChecksAllowed: allowed,
        },
        );
      } finally {
        if (watch?.reviewer) Object.assign(watch, { reviewer: null, phaseAt: this.d.now() });
      }
      st.reviews.push(phase.record);
      this.d.tasks.event(task.row.id, REVIEW_RECORDED, { record: phase.record });
      notes.push(...phase.notes);
      const v = phase.verdict;
      if (!v || v.recommendedAction !== "run_targeted_check" || st.targetedRan || mode !== "coding") break;
      // Missing evidence a check can supply: run it once on the submitted revision, then re-review.
      st.targetedRan = true;
      const ev = outcome.evidence ?? {};
      const t = await runTargetedChecks({ cfg: this.d.cfg, db: this.d.db, artifacts: this.d.artifacts, signal: run.signal }, task, outcome.result, ev.revision ?? null, ev.artifactDigest ?? null, v.targetedChecks ?? []);
      this.d.tasks.event(task.row.id, "targeted_check", { commands: v.targetedChecks ?? [], ran: t.records.map((c) => ({ command: c.command, exitCode: c.exitCode })), note: t.note });
      notes.push(t.note);
      if (!t.records.length) break;
      outcome = { ...outcome, result: { ...outcome.result, checks: [...outcome.result.checks, ...t.records] } };
      verified = this.verify(task, contract, mode, outcome, st.qualityRetriesUsed, opts({ notes }), false);
      if (!needsReview(verified)) return done(verified);
    }
    verified = this.verify(task, contract, mode, outcome, st.qualityRetriesUsed, opts({ review: phase?.outcome ?? null, verificationBudgetExhausted: phase?.budgetExhausted ?? false, notes }), false);
    return done(verified);
  }

  /** The reviewer's run context: the task's, routed to the reviewer, capped at its share, purpose verification. */
  private reviewerContext(task: StoredTask, signal: AbortSignal, plan: RoutePlan, routing: Routing, session: SessionRecorder | null, contract: StoredContract, maxModelRequests: number, attempts: GateAttempt[], profile: ProfileName): RunContext {
    const ctx = this.context(task, signal, plan, routing, session, { contract, retry: null });
    return { ...ctx, profile: this.d.cfg.profiles[profile]!, budget: { ...ctx.budget, maxModelRequests }, attempts, purpose: "verification" };
  }

  /** Requests charged to the task so far: in total and per verification purpose. */
  private used(taskId: string): { total: number; verification: number; repair: number } {
    const p = this.d.gate.admission.taskTotalsByPurpose(taskId);
    return { total: this.d.gate.admission.taskTotals(taskId).requests, verification: p.verification, repair: p.repair };
  }

  private tooDifficult(task: StoredTask, prepared: Prepared): void {
    const c = prepared.classification;
    this.record(task, "failed", baseResult({
      executionStatus: "failed",
      stopReason: `too_difficult_for_workers: ${c.rejectReason}`,
      summary: `Not delegated. ${c.rejectReason}. Score ${c.score}: ${c.breakdown.filter((l) => l.points).map((l) => `${l.detail} (+${l.points})`).join(", ")}.`,
      unresolvedCriteria: criterionTexts(task.spec),
    }));
  }

  async runSingle(task: StoredTask): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(task.row.id, controller);
    const release = this.supervise(task, controller);
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
      try {
        prepared = await this.d.router.prepare(task, this.d.owner);
      } catch (err) {
        if (isSimulatedCrash(err)) {
          crashed = true;
          return;
        }
        this.settle(task, this.classify(err, controller.signal, task));
        return;
      }
      routing.classification = prepared.classification;
      if (!prepared.plan) {
        this.tooDifficult(task, prepared);
        return;
      }
      let plan = prepared.plan;
      const mode = this.d.cfg.profiles[task.spec.profile]!.mode;
      // Supervisor jobs are judged by their own job checks; every other task gets a contract.
      let contract: StoredContract | null = null;
      if (mode !== "supervisor") {
        const c = this.contractFor(task, plan.tier, prepared.classification);
        if (!c) return;
        contract = c;
      }
      let previous: string | null | undefined;
      // Verification and the one retry span the task's runs: a run after an interruption
      // continues them (the same repair run, at its tier) instead of starting over.
      const restored = restoreRunState(this.d.tasks, task.row.id);
      const st = restored.st;
      let retry: RetryContext | null = restored.retry?.retry ?? null;
      let repairing = !!restored.retry;
      const forced = !!task.spec.routing?.endpointId;
      // Only the first attempt resumes; an escalation always starts fresh.
      let resume: ReturnType<Executor["resumeFor"]> = null;
      try {
        resume = this.resumeFor(task);
      } catch (err) {
        // An unreadable or already-claimed session: run fresh (linked to it) rather than not at all.
        this.d.tasks.event(task.row.id, "session_resume_failed", { error: (err as Error).message });
      }
      // An interruption never changes the tier (the router counts any earlier run as a failed
      // one): a run after it continues at the tier of the run it continues, a started retry at
      // the retry's tier. Verification then judges the work at the tier it was produced at.
      const pinned = restored.retry?.toTier ?? this.interruptedTier(task, resume);
      if (pinned && pinned !== plan.tier && mode !== "supervisor" && !forced && (task.row as typeof task.row & { purpose?: string }).purpose !== "qualification") {
        const at = this.d.router.plan(task.spec.profile, pinned, prepared.inputModalities);
        if (at.candidates.length) {
          this.d.tasks.event(task.row.id, "tier_kept", { classified: plan.tier, tier: pinned, reason: restored.retry ? "retry_in_progress" : "after_interruption" });
          plan = at;
          this.d.db.prepare("UPDATE tasks SET tier = ? WHERE id = ?").run(plan.tier, task.row.id);
        }
      }
      if (restored.retry && restored.retry.toTier !== restored.retry.fromTier && plan.tier === restored.retry.toTier) routing.escalatedFrom = restored.retry.fromTier;
      for (;;) {
        routing.tier = plan.tier;
        let outcome: RunOutcome;
        try {
          session = resume ? resume.session : this.openSession(task, plan, previous);
          // A repair run (also one resumed after an interruption) draws on the repair reserve.
          const cap = repairing && contract ? repairCap(contract.contract.budget, this.used(task.row.id)) : null;
          const ctx = this.context(task, controller.signal, plan, routing, session, { contract, retry, repairCap: cap }, resume ? { plan: resume.plan } : null);
          resume = null;
          outcome = await this.runMode(ctx);
        } catch (err) {
          if (isSimulatedCrash(err)) {
            crashed = true;
            return;
          }
          const d = this.classify(err, controller.signal, task);
          this.endForDisposition(task, session, d);
          this.settle(task, d);
          return;
        }
        if (controller.signal.aborted) {
          const d = this.classify(new Error("aborted"), controller.signal, task);
          this.endForDisposition(task, session, d);
          this.settle(task, d, outcome.result);
          return;
        }
        let verified: VerifiedOutcome | null = null;
        let settle: (() => VerifiedOutcome) | null = null;
        if (contract) {
          const repairsLeft = contract.contract.verification.maxQualityRetries - st.qualityRetriesUsed;
          try {
            const v = await this.verifyWithReview(task, contract, mode, outcome, st, {
              tier: plan.tier,
              signal: controller.signal,
              routing,
              session,
              repairPossible: repairsLeft > 0 && !forced && contract.contract.budget.repair > this.used(task.row.id).repair,
            });
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
            this.settle(task, d, outcome.result);
            return;
          }
        }
        let result: RunnerResult = verified ? verified.result : { ...outcome.result, verificationStatus: "not_required" };
        const next = nextTier(plan.tier);
        const execFailure = outcome.state === "budget_exhausted" ? "budget_exhausted" : result.stopReason === "invalid_output" ? "invalid_output" : null;
        // A concrete defect (a failed check, criterion, or review) gets one repair, in every mode.
        const quality = !execFailure && verified?.decision.action === "repair";
        const repairTier = execFailure ? next : quality ? (this.d.cfg.routing.escalate_on_failure && next ? next : plan.tier) : null;
        const allowed = execFailure ? this.d.cfg.routing.escalate_on_failure && !routing.escalatedFrom : quality;
        if (allowed && repairTier && !forced) {
          const used = this.used(task.row.id);
          const budgetLeft = contract ? repairCap(contract.contract.budget, used) - used.total : runCap(this.d.cfg, task.spec, repairTier, null) - used.total;
          const nextPlan = repairTier === plan.tier ? plan : this.d.router.plan(task.spec.profile, repairTier, prepared.inputModalities);
          if (budgetLeft > 0 && nextPlan.candidates.length) {
            const reason = execFailure ?? "acceptance_unmet";
            if (repairTier !== plan.tier) this.d.tasks.event(task.row.id, "escalated", { from: plan.tier, to: repairTier, reason });
            const lastReview = st.reviews.at(-1) ?? null;
            const startFrom = quality && mode === "coding" ? await submittedRevisionStart(this.d.db, task, outcome.evidence?.revision ?? null) : null;
            const baseRetry = failureContext(this.d.artifacts, plan.tier, reason, result);
            retry = quality ? repairRetryContext(baseRetry, lastReview, startFrom) : baseRetry;
            // Durable before the retry runs: a run after an interruption continues it, never repeats it.
            this.d.tasks.event(task.row.id, RETRY_STARTED, retryStarted(plan.tier, repairTier, reason, retry));
            if (quality) this.d.tasks.event(task.row.id, "quality_repair", { fromTier: plan.tier, toTier: repairTier, startFrom: startFrom?.commit ?? null, review: lastReview?.verdict ?? null, reasons: result.verification?.reasons.slice(0, 5) ?? [] });
            // The task's one bounded retry, whatever triggered it.
            st.qualityRetriesUsed++;
            repairing = true;
            const e = sessionEnd(outcome.state, outcome.result.stopReason);
            this.endSession(task, session, e.status, repairTier !== plan.tier ? `${e.stopReason}; escalated to ${repairTier}` : `${e.stopReason}; repair at ${repairTier}`);
            previous = session?.id ?? null;
            session = null;
            if (repairTier !== plan.tier) {
              routing.escalatedFrom = plan.tier;
              this.d.db.prepare("UPDATE tasks SET tier = ? WHERE id = ?").run(repairTier, task.row.id);
            }
            plan = nextPlan;
            continue;
          }
        }
        // A repair was called for but cannot run (forced endpoint, no budget or candidates): decide
        // as if no retry remained.
        if (verified?.decision.action === "repair" && settle) result = settle().result;
        const e = sessionEnd(outcome.state, outcome.result.stopReason);
        this.endSession(task, session, e.status, e.stopReason);
        this.record(task, outcome.state, result);
        return;
      }
    } finally {
      // Whatever escaped above (a store or recording failure), never leave the session running.
      if (!crashed) this.endSession(task, session, "failed", "executor_error");
      this.watched.delete(task.row.id);
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
      // Each member's contract is compiled at its own classified tier; a member whose policy
      // cannot fit its budget fails before the shared request.
      const contracts = new Map<string, StoredContract>();
      for (const m of [...members]) {
        const c = this.contractFor(m, prepared.get(m.row.id)!.plan!.tier, prepared.get(m.row.id)!.classification);
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
        const pendingIds = (err as { batchPendingTaskIds?: string[] }).batchPendingTaskIds ?? members.map((t) => t.row.id);
        for (const t of members) {
          if (!pendingIds.includes(t.row.id)) continue;
          const d = this.classify(err, this.controllers.get(t.row.id)?.signal ?? shared.signal, t);
          this.endForDisposition(t, sessions.get(t.row.id) ?? null, d);
          this.settle(t, d);
        }
        return;
      }
      for (const t of members) {
        const o = outcomes.get(t.row.id);
        const session = sessions.get(t.row.id) ?? null;
        if (o) {
          const e = sessionEnd(o.state, o.result.stopReason);
          this.endSession(t, session, e.status, e.stopReason);
          const contract = contracts.get(t.row.id);
          if (!contract) {
            this.record(t, o.state, o.result);
            continue;
          }
          // Members are reviewed one by one when their level requires it (no repair inside a batch).
          const signal = this.controllers.get(t.row.id)?.signal ?? shared.signal;
          try {
            const v = await this.verifyWithReview(t, contract, this.d.cfg.profiles[t.spec.profile]!.mode, o, restoreRunState(this.d.tasks, t.row.id).st, { tier, signal, routing: this.routing.get(t.row.id)!, session, repairPossible: false });
            this.record(t, o.state, v.verified.decision.action === "repair" ? v.settle().result : v.verified.result);
          } catch (err) {
            if (isSimulatedCrash(err)) {
              crashed = true;
              return;
            }
            this.settle(t, this.classify(err, signal, t), o.result);
          }
        } else {
          this.endSession(t, session, "failed", "batch_member_unaccounted");
          this.settle(t, { kind: "final", state: "failed", stopReason: "batch_member_unaccounted" });
        }
      }
    } finally {
      // Members that left the batch without an outcome (an error escaped) still end their sessions.
      if (!crashed) for (const t of tasks) this.endSession(t, sessions.get(t.row.id) ?? null, "failed", "batch_aborted");
      for (const t of tasks) this.routing.delete(t.row.id);
      for (const r of releases) r();
    }
  }

  private classify(err: unknown, signal: AbortSignal, task: StoredTask): Disposition {
    const reason = signal.aborted ? (signal.reason as AbortReason) : null;
    if (reason === "cancel") return { kind: "final", state: "cancelled", stopReason: "cancelled while running" };
    if (reason === "lease_lost") return { kind: "abandon", reason: "lease lost" };
    if (reason === "shutdown") return { kind: "abandon", reason: "shutdown" };
    if (reason === "watchdog") return { kind: "abandon", reason: WATCHDOG_STOP };
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
      if (d.reason === WATCHDOG_STOP) this.requeueStuck(task);
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
        unresolvedCriteria: partial?.unresolvedCriteria.length ? partial.unresolvedCriteria : criterionTexts(task.spec),
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

  /**
   * Progress watchdog (called on every scheduler tick): a running session with no new event for
   * longer than its allowance (see `watchdogVerdict`) is aborted with reason `watchdog`. The
   * run then ends its session `interrupted` (`watchdog`) and the task is re-queued, so the next
   * run resumes the session from its last durable event. Returns the aborted task ids.
   */
  checkWatchdog(): string[] {
    if (this.d.cfg.execution.watchdog_minutes <= 0) return [];
    const aborted: string[] = [];
    for (const [taskId, w] of this.watched) {
      // During a review the reviewer's session is the one that must make progress (it runs no checks).
      const reviewing = !!w.reviewer && !w.reviewer.ended;
      const session = reviewing ? w.reviewer : w.session();
      if (w.controller.signal.aborted || !session || session.ended) continue;
      const progress = sessionProgress(this.d.db, session.id);
      if (!progress) continue;
      // Idle time counts from the later of the session's last event and the last phase switch
      // (a review starting or ending), so time spent in another session is not held against it.
      const v = watchdogVerdict(this.d.cfg, { ...progress, at: Math.max(progress.at, w.phaseAt) }, this.d.now(), { checks: reviewing ? 0 : (w.task.spec.constraints.checks?.length ?? 0) });
      if (v.kind !== "stuck") continue;
      this.d.tasks.event(taskId, "watchdog_abort", { sessionId: session.id, ...(reviewing ? { role: "reviewer" } : {}), idleMs: v.idleMs, allowanceMs: v.allowanceMs, waitingOn: v.waitingOn });
      w.controller.abort("watchdog" satisfies AbortReason);
      aborted.push(taskId);
    }
    return aborted;
  }

  /**
   * A run the watchdog stopped: interrupted, then queued again to resume its session (bounded
   * like recovery). The author's session is named even when a reviewer was the one stuck.
   */
  private requeueStuck(task: StoredTask): void {
    this.d.tasks.interrupt(task.row.id, this.d.owner, "no progress: stopped by the watchdog");
    const now = this.d.tasks.get(task.row.id);
    if (now?.row.state !== "interrupted" || now.row.run_count >= MAX_AUTO_RESUMES) return;
    const sessionId = this.watched.get(task.row.id)?.session()?.id;
    this.d.tasks.resume(task.row.id, sessionId ? { sessionId } : {});
  }

  abortAll(reason: AbortReason): void {
    for (const c of this.controllers.values()) c.abort(reason);
  }
}
