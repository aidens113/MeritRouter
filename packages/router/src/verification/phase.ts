import { taskLabAuthority } from "../runners/coding/task-lab.js";
import type { LabManager } from "../labs/lab.js";
import type { ResolvedConfig } from "../config/load.js";
import type { ProfileMode, ProfileName, TierName } from "../config/schema.js";
import type { Db } from "../storage/db.js";
import type { ArtifactStore } from "../storage/artifacts.js";
import type { StoredTask, TaskStore } from "../storage/tasks.js";
import type { Gate, GateAttempt } from "../gateway/gate.js";
import type { Catalog } from "../models/catalog.js";
import type { TaskRouter } from "../routing/router.js";
import type { RoutePlan } from "../routing/select.js";
import type { SessionStore } from "../sessions/store.js";
import type { SessionRecorder } from "../sessions/recorder.js";
import type { RetryContext, RunContext, RunOutcome, RunnerResult } from "../runners/types.js";
import { failureContext, nextTier, runCap, verifyOutcome, type VerifiedOutcome, type VerifyOptions } from "../core/acceptance.js";
import { restoreRunState, retryStarted, RETRY_STARTED, REVIEW_RECORDED, type VerificationState } from "../core/retry-state.js";
import { repairCap, reviewReserveAdjustment, type StoredContract } from "./contract.js";
import type { ReviewPhaseResult } from "./review.js";
import { calibratedReview } from "./calibration.js";
import { carryOverRetryContext, repairRetryContext, runTargetedChecks, submittedRevisionStart, targetedCheckAllowed, unfinishedWorkStart } from "./followup.js";

/**
 * The verification phase of a task run, as the executor drives it: continue the verification
 * and retry state a task's earlier runs left (after an interruption), verify a runner outcome
 * against the task's acceptance contract (recording a level the actual change raised, with the
 * review reserve it draws), run the independent review and its targeted-check follow-up when
 * the level requires it, and plan the task's one bounded retry (a quality repair or an
 * execution-failure escalation) from the result.
 */

export interface PhaseDeps {
  labs?: LabManager;
  cfg: ResolvedConfig;
  db: Db;
  gate: Gate;
  catalog: Catalog;
  router: TaskRouter;
  tasks: TaskStore;
  artifacts: ArtifactStore;
  sessions: SessionStore | null;
  now: () => number;
}

/** Where a task's verification and retry stand when a run starts, and the tier it runs at. */
export interface ContinuedRun {
  st: VerificationState;
  /** The retry already started (this run is its repair run), or null. */
  retry: RetryContext | null;
  repairing: boolean;
  plan: RoutePlan;
  /** Set when the started retry escalated and this run is at its tier. */
  escalatedFrom: TierName | null;
}

/**
 * Restore the task's verification and retry state from its events, and keep the tier across an
 * interruption: the router counts any earlier run as a failed one, so a run after an
 * interruption continues at the tier of the run it continues (`interruptedTier`) and a started
 * retry at the retry's tier. Verification then judges the work at the tier it was produced at.
 * Supervisors, forced endpoints, and qualification tasks are `exempt`.
 */
export function continueRun(
  d: Pick<PhaseDeps, "db" | "router" | "tasks">,
  task: StoredTask,
  classified: RoutePlan,
  inputModalities: Parameters<TaskRouter["plan"]>[2],
  pin: { interruptedTier: () => TierName | null; exempt: boolean },
): ContinuedRun {
  const restored = restoreRunState(d.tasks, task.row.id);
  let plan = classified;
  const pinned = restored.retry?.toTier ?? pin.interruptedTier();
  if (pinned && pinned !== plan.tier && !pin.exempt) {
    const at = d.router.plan(task.spec.profile, pinned, inputModalities);
    if (at.candidates.length) {
      d.tasks.event(task.row.id, "tier_kept", { classified: plan.tier, tier: pinned, reason: restored.retry ? "retry_in_progress" : "after_interruption" });
      plan = at;
      d.db.prepare("UPDATE tasks SET tier = ? WHERE id = ?").run(plan.tier, task.row.id);
    }
  }
  const r = restored.retry;
  const escalatedFrom = r && r.toTier !== r.fromTier && plan.tier === r.toTier ? r.fromTier : null;
  return { st: restored.st, retry: r?.retry ?? null, repairing: !!r, plan, escalatedFrom };
}

/** Requests charged to the task so far: in total and per verification purpose. */
export function requestsUsed(gate: Gate, taskId: string): { total: number; verification: number; repair: number } {
  const p = gate.admission.taskTotalsByPurpose(taskId);
  return { total: gate.admission.taskTotals(taskId).requests, verification: p.verification, repair: p.repair };
}

/** Whether a repair could still follow this run's review (a retry left, not forced, repair reserve unspent). */
export function repairPossible(gate: Gate, task: StoredTask, contract: StoredContract, st: VerificationState, forced: boolean): boolean {
  const repairsLeft = contract.contract.verification.maxQualityRetries - st.qualityRetriesUsed;
  return repairsLeft > 0 && !forced && contract.contract.budget.repair > requestsUsed(gate, task.row.id).repair;
}

/** Verify one outcome against the contract; a level raised by the actual change (or tier) is recorded once. */
export function verifyRecorded(d: Pick<PhaseDeps, "cfg" | "tasks" | "labs">, task: StoredTask, contract: StoredContract, mode: ProfileMode, outcome: RunOutcome, qualityRetriesUsed: number, opts: VerifyOptions = {}, announce = true): VerifiedOutcome {
  const v = verifyOutcome(d.cfg.verification, contract, mode, outcome, qualityRetriesUsed, { ...opts, taskLabAuthority: task.spec.constraints.labChecks?.length && d.labs ? taskLabAuthority(d.labs,task.row.id,outcome.result.taskLab) : null });
  const re = v.reevaluation;
  if (re.raised && announce) {
    // A raised level that needs more review than the contract reserved draws it from the room under the ceiling.
    const reserve = reviewReserveAdjustment(d.cfg.verification, contract.contract.budget, re.level, re.review.required);
    d.tasks.event(task.row.id, "verification_raised", { from: contract.contract.verification.level, to: re.level, importance: re.importance, importanceSource: re.importanceSource, newRules: re.newRules, checks: re.checks, ...(opts?.tier ? { tier: opts.tier } : {}), ...(reserve ? { reserveAdjustment: { review: reserve } } : {}) });
  }
  return v;
}

/** The run a verification belongs to, and the executor's hooks into it. */
export interface ReviewRun {
  tier: TierName;
  signal: AbortSignal;
  session: SessionRecorder | null;
  jobId: string | null;
  repairPossible: boolean;
  /** Build the reviewer's run context: the task's, routed to the reviewer, capped at its share, purpose verification. */
  reviewerContext: (plan: RoutePlan, session: SessionRecorder | null, maxModelRequests: number, attempts: GateAttempt[], profile: ProfileName) => RunContext;
  /** Told when a reviewer session starts working (its session) and when the review ends (null). */
  onReviewer?: (session: SessionRecorder | null) => void;
}

export interface VerifiedRun {
  outcome: RunOutcome;
  verified: VerifiedOutcome;
  /** The same decision when no quality retry can run after all (a reviewer-only defect then goes to the supervisor). */
  settle: () => VerifiedOutcome;
}

/**
 * Verify a result and, when its level requires it, review it: cheap deterministic checks
 * first; an independent review only when they found no defect. A reviewer's request for a
 * targeted check runs once (coding) and is followed by a re-review while the allowance lasts.
 * Returns the (possibly extended) outcome, the verification, and `settle`.
 */
export async function verifyWithReview(d: PhaseDeps, task: StoredTask, contract: StoredContract, mode: ProfileMode, start: RunOutcome, st: VerificationState, run: ReviewRun): Promise<VerifiedRun> {
  let outcome = start;
  let last: VerifyOptions = {};
  const opts = (extra: VerifyOptions = {}) => (last = { tier: run.tier, reviews: st.reviews, ...extra });
  const done = (verified: VerifiedOutcome): VerifiedRun => ({ outcome, verified, settle: () => verifyRecorded(d, task, contract, mode, outcome, Number.MAX_SAFE_INTEGER, last, false) });
  let verified = verifyRecorded(d, task, contract, mode, outcome, st.qualityRetriesUsed, opts());
  const needsReview = (v: VerifiedOutcome) => v.reevaluation.review.required && outcome.result.executionStatus === "completed" && v.decision.acceptanceStatus !== "unmet";
  if (!needsReview(verified)) return done(verified);
  const purpose = (task.row as typeof task.row & { purpose?: string }).purpose;
  if (purpose === "qualification" || purpose === "audit") {
    // Qualification runs are graded by the evaluation suite; a reviewer would measure another model.
    // An audit is itself a review, recorded for calibration; reviewing it would never end.
    const note = purpose === "audit" ? "audit task: its verdict is recorded for calibration, not reviewed" : "qualification task: graded by the evaluation suite, not reviewed";
    return done(verifyRecorded(d, task, contract, mode, outcome, st.qualityRetriesUsed, opts({ notes: [note] }), false));
  }
  const allowed = mode === "coding" ? targetedCheckAllowed(d.cfg, task.spec.constraints.checks ?? []) : null;
  let phase: ReviewPhaseResult | null = null;
  let actionContext: RunContext | null = null;
  const notes: string[] = [];
  for (let round = 0; round < 2; round++) {
    let reviewing = false;
    try {
      // Calibrated: a cached verdict for the same contract, artifact, policy, and sources is reused; every verdict is recorded.
      phase = await calibratedReview(
        { cfg: d.cfg, db: d.db, gate: d.gate, catalog: d.catalog, router: d.router, tasks: d.tasks, artifacts: d.artifacts, sessions: d.sessions },
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
          jobId: run.jobId,
          context: (plan, session, maxModelRequests, attempts, profile) => {
            // The watchdog follows the reviewer while it works (the author's session is idle then).
            reviewing = true;
            run.onReviewer?.(session);
            const context = run.reviewerContext(plan, session, maxModelRequests, attempts, profile);
            actionContext = context;
            return context;
          },
          targetedChecksAllowed: allowed,
        },
        d.now,
      );
    } finally {
      if (reviewing) run.onReviewer?.(null);
    }
    st.reviews.push(phase.record);
    d.tasks.event(task.row.id, REVIEW_RECORDED, { record: phase.record });
    notes.push(...phase.notes);
    const v = phase.verdict;
    if (!v || v.recommendedAction !== "run_targeted_check" || st.targetedRan || mode !== "coding") break;
    // Missing evidence a check can supply: run it once on the submitted revision, then re-review.
    st.targetedRan = true;
    const ev = outcome.evidence ?? {};
    const t = await runTargetedChecks({ cfg: d.cfg, db: d.db, artifacts: d.artifacts, signal: run.signal, ...(actionContext ? { context: actionContext } : {}) }, task, outcome.result, ev.revision ?? null, ev.artifactDigest ?? null, v.targetedChecks ?? []);
    d.tasks.event(task.row.id, "targeted_check", { commands: v.targetedChecks ?? [], ran: t.records.map((c) => ({ command: c.command, exitCode: c.exitCode })), note: t.note });
    notes.push(t.note);
    if (!t.records.length) break;
    outcome = { ...outcome, result: { ...outcome.result, checks: [...outcome.result.checks, ...t.records] } };
    verified = verifyRecorded(d, task, contract, mode, outcome, st.qualityRetriesUsed, opts({ notes }), false);
    if (!needsReview(verified)) return done(verified);
  }
  verified = verifyRecorded(d, task, contract, mode, outcome, st.qualityRetriesUsed, opts({ review: phase?.outcome ?? null, verificationBudgetExhausted: phase?.budgetExhausted ?? false, notes }), false);
  return done(verified);
}

/** The task's one bounded retry, planned and made durable: the run continues at `plan` with `retry`. */
export interface PlannedRetry {
  tier: TierName;
  plan: RoutePlan;
  retry: RetryContext;
}

export interface RetryInput {
  mode: ProfileMode;
  plan: RoutePlan;
  inputModalities: Parameters<TaskRouter["plan"]>[2];
  outcome: RunOutcome;
  result: RunnerResult;
  verified: VerifiedOutcome | null;
  contract: StoredContract | null;
  /** The tier this task already escalated from (an execution failure escalates once). */
  escalatedFrom: TierName | null;
  /** A forced endpoint never retries. */
  forced: boolean;
}

/**
 * Plan the retry a result calls for, if any: an execution failure (spent budget, invalid output)
 * escalates once to the next tier; a concrete defect (a failed check, criterion, or review) gets
 * one repair, in every mode. It runs only with requests left and candidates at its tier. A
 * planned retry is written (`escalated`, `retry_started`, `quality_repair`) before it runs, so a
 * run after an interruption continues it and never repeats it; `st` counts it.
 */
export async function planRetry(d: Pick<PhaseDeps, "cfg" | "db" | "gate" | "router" | "tasks" | "artifacts">, task: StoredTask, st: VerificationState, i: RetryInput): Promise<PlannedRetry | null> {
  const { plan, outcome, result, contract } = i;
  if (result.stopReason.startsWith("repeated_tool_call:")) return null;
  const next = nextTier(plan.tier);
  const execFailure = outcome.state === "budget_exhausted" ? "budget_exhausted" : result.stopReason === "invalid_output" ? "invalid_output" : null;
  const quality = !execFailure && i.verified?.decision.action === "repair";
  const repairTier = execFailure ? next : quality ? (d.cfg.routing.escalate_on_failure && next ? next : plan.tier) : null;
  const allowed = execFailure ? d.cfg.routing.escalate_on_failure && !i.escalatedFrom : quality;
  if (!allowed || !repairTier || i.forced) return null;
  const used = requestsUsed(d.gate, task.row.id);
  const budgetLeft = contract ? repairCap(contract.contract.budget, used) - used.total : runCap(d.cfg, task.spec, repairTier, null) - used.total;
  const nextPlan = repairTier === plan.tier ? plan : d.router.plan(task.spec.profile, repairTier, i.inputModalities);
  if (budgetLeft <= 0 || !nextPlan.candidates.length) return null;
  const reason = execFailure ?? "acceptance_unmet";
  if (repairTier !== plan.tier) d.tasks.event(task.row.id, "escalated", { from: plan.tier, to: repairTier, reason });
  const lastReview = st.reviews.at(-1) ?? null;
  const startFrom = quality && i.mode === "coding" ? await submittedRevisionStart(d.db, task, outcome.evidence?.revision ?? null) : null;
  // A coding run that ran out of requests hands its unfinished work to the escalation.
  const carried = execFailure === "budget_exhausted" && i.mode === "coding" ? await unfinishedWorkStart(d.db, task) : null;
  const baseRetry = failureContext(d.artifacts, plan.tier, reason, result);
  const retry = quality ? repairRetryContext(baseRetry, lastReview, startFrom) : carried ? carryOverRetryContext(baseRetry, carried) : baseRetry;
  // Durable before the retry runs: a run after an interruption continues it, never repeats it.
  d.tasks.event(task.row.id, RETRY_STARTED, retryStarted(plan.tier, repairTier, reason, retry));
  if (quality) d.tasks.event(task.row.id, "quality_repair", { fromTier: plan.tier, toTier: repairTier, startFrom: startFrom?.commit ?? null, review: lastReview?.verdict ?? null, reasons: result.verification?.reasons.slice(0, 5) ?? [] });
  // The task's one bounded retry, whatever triggered it.
  st.qualityRetriesUsed++;
  return { tier: repairTier, plan: nextPlan, retry };
}
