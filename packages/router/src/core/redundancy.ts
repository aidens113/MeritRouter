import type { ProfileMode, TierName } from "../config/schema.js";
import type { RoutePlan } from "../routing/select.js";
import type { StoredContract } from "../verification/contract.js";
import type { RunOutcome, RunnerResult } from "../runners/types.js";
import type { VerifiedRun } from "../verification/phase.js";
import type { SessionRecorder } from "../sessions/recorder.js";
import type { SessionEndStatus } from "../sessions/events.js";
import { baseResult } from "../runners/types.js";
import { criterionTexts, type WorkerTask } from "./task.js";
import { isSimulatedCrash } from "./faults.js";

/**
 * Redundant execution (T2): a plan node with `redundancy: 2` runs its first attempt twice at
 * once, each run in its own session on its own endpoints (the plan's candidates split so the
 * two runs, fallbacks included, never share an endpoint). The first result that passes
 * verification wins; the other run is cancelled (session `cancelled` / `superseded`). Both runs
 * are charged to the task: they share one request cap, the first run's plus a second execution
 * allowance that must fit in the contract's unallocated room, or the node is refused.
 */

/** Task events. */
export const REDUNDANCY_STARTED = "redundancy_started";
export const REDUNDANCY_SKIPPED = "redundancy_skipped";
export const REDUNDANCY_SETTLED = "redundancy_settled";
/** Stop reason of the run a twin's verified result superseded. */
export const SUPERSEDED = "superseded";

/** Modes that may run redundantly: no worktree, so two runs never share one. */
const REDUNDANT_MODES: ReadonlySet<ProfileMode> = new Set(["read_only", "completion"]);
/** Tiers that may run redundantly (small nodes only). */
const REDUNDANT_TIERS: ReadonlySet<TierName> = new Set(["T1", "T2"]);

export type RedundancyPlan =
  | { kind: "single" }
  | { kind: "skip"; reason: string }
  | { kind: "refuse"; reason: string }
  | { kind: "twin"; plans: [RoutePlan, RoutePlan]; cap: number; perRun: number };

export interface RedundancyInput {
  /** Runs the node asked for (`redundancy`). */
  requested: number;
  mode: ProfileMode;
  plan: RoutePlan;
  contract: StoredContract | null;
  /** The first run's cumulative request cap (`runCap`). */
  runCap: number;
  /** Requests the task used before this run (classification). */
  used: number;
  /** False on a resumed run, a repair, or an escalation: those run once. */
  firstAttempt: boolean;
  /** A forced endpoint, or a qualification task: exactly one model may serve it. */
  pinned: boolean;
}

/** Whether, and how, a task's first attempt runs twice. */
export function planRedundancy(i: RedundancyInput): RedundancyPlan {
  if (i.requested < 2) return { kind: "single" };
  if (!i.firstAttempt) return { kind: "skip", reason: "a resumed, repaired, or escalated run runs once" };
  if (!REDUNDANT_MODES.has(i.mode)) return { kind: "skip", reason: `${i.mode} tasks run once (two runs would share the task's worktree)` };
  if (!REDUNDANT_TIERS.has(i.plan.tier)) return { kind: "skip", reason: `classified ${i.plan.tier}; redundancy is for T1 and T2 nodes only` };
  if (i.pinned || i.plan.forced) return { kind: "skip", reason: "one endpoint is forced for this task" };
  if (i.plan.candidates.length < 2) return { kind: "skip", reason: `only ${i.plan.candidates.length} eligible endpoint(s); the two runs need different endpoints` };
  if (!i.contract) return { kind: "skip", reason: "no acceptance contract to verify the runs against" };
  const perRun = Math.max(0, i.runCap - i.used);
  const room = i.contract.contract.budget.unallocated;
  if (perRun < 1) return { kind: "skip", reason: "no execution requests left" };
  if (room < perRun) {
    return {
      kind: "refuse",
      reason: `redundancy 2 needs a second execution allowance of ${perRun} model request(s), but the acceptance contract leaves ${room} unallocated (total ${i.contract.contract.budget.total}); raise budget.maxModelRequests or verification.max_total_requests_per_task, or drop redundancy`,
    };
  }
  return { kind: "twin", plans: splitPlan(i.plan), cap: i.runCap + perRun, perRun };
}

/** The plan without some endpoints (the other run's), as `avoidEndpoints` excludes a reviewer's. */
export function withoutEndpoints(plan: RoutePlan, ids: ReadonlySet<string>, reason: string): RoutePlan {
  return {
    ...plan,
    candidates: plan.candidates.filter((c) => !ids.has(c.id)),
    explanations: plan.explanations.map((e) => (ids.has(e.endpointId) && e.eligible ? { ...e, eligible: false, rank: null, reasons: [...e.reasons, reason] } : e)),
  };
}

/**
 * Split a plan's candidates between two runs, alternating by rank, so each run starts on a
 * cheap endpoint and no endpoint serves both (fallbacks included).
 */
export function splitPlan(plan: RoutePlan): [RoutePlan, RoutePlan] {
  const a = new Set(plan.candidates.filter((_, i) => i % 2 === 0).map((c) => c.id));
  const b = new Set(plan.candidates.filter((_, i) => i % 2 === 1).map((c) => c.id));
  return [withoutEndpoints(plan, b, "serves the redundant twin run"), withoutEndpoints(plan, a, "serves the redundant twin run")];
}

/** A redundant run's result passes when it completed and verification passed it. */
export function passesVerification(outcome: RunOutcome, run: VerifiedRun): boolean {
  return outcome.state === "completed" && run.verified.decision.verificationStatus === "passed";
}

/** The result of a node whose redundancy the contract cannot pay for: failed, not run. */
export function redundancyRefused(spec: WorkerTask, reason: string): RunnerResult {
  return baseResult({
    executionStatus: "failed",
    stopReason: `redundancy_budget_insufficient: ${reason}`,
    summary: `Not run. ${reason}.`,
    unresolvedCriteria: criterionTexts(spec),
  });
}

/** One of the two runs. */
export interface TwinRun {
  i: number;
  plan: RoutePlan;
  controller: AbortController;
  session: SessionRecorder | null;
}

/** What the race needs from the executor. */
export interface TwinHooks {
  /** Open a run's session; `previous` links it (the second run links to the first). */
  open(plan: RoutePlan, previous: string | null | undefined): SessionRecorder | null;
  /** Run one attempt under the shared request cap, with the run's own signal. */
  run(r: TwinRun): Promise<RunOutcome>;
  /** Verify (and when its level requires it, review) a finished run. */
  verify(r: TwinRun, outcome: RunOutcome): Promise<VerifiedRun>;
  /** End a session the race settles (the adopted one is left to the caller). */
  end(session: SessionRecorder | null, status: SessionEndStatus, stopReason: string): void;
  /** End a session whose run threw, as the caller would for that error. */
  endWithError(session: SessionRecorder | null, error: unknown): void;
  event(type: string, data: unknown): void;
  /** Endpoints that served a session. */
  served(session: SessionRecorder | null): string[];
  /** Hand the caller the session it settles (the first run's until the race decides). */
  adopt(session: SessionRecorder | null): void;
  /** The session the progress watchdog should follow while the race runs; null when it ends. */
  watch(current: (() => SessionRecorder | null) | null): void;
}

export type TwinResult = { kind: "ok"; outcome: RunOutcome; verified: VerifiedRun } | { kind: "error"; error: unknown };

/**
 * Run a task's first attempt twice at once: each run its own session (the second linked to the
 * first) on its own half of the plan's endpoints, both under one shared request cap. Results
 * are verified one at a time as they finish (they share the task's verification state); the
 * first that passes wins and the other run is cancelled (`superseded`). Without a passing
 * result the first completed one is used, so a repair may follow. A simulated crash propagates
 * without ending any session, as process death would.
 */
export async function raceTwins(parent: AbortSignal, twin: Extract<RedundancyPlan, { kind: "twin" }>, previous: string | null | undefined, h: TwinHooks): Promise<TwinResult> {
  type Done = { run: TwinRun; ok: true; outcome: RunOutcome; v: VerifiedRun } | { run: TwinRun; ok: false; error: unknown };
  const runs: TwinRun[] = twin.plans.map((plan, i) => ({ i, plan, controller: new AbortController(), session: null }));
  const onAbort = () => runs.forEach((r) => r.controller.abort(parent.reason));
  parent.addEventListener("abort", onAbort);
  let crashed = false;
  let adopted: SessionRecorder | null = null;
  const adopt = (s: SessionRecorder | null) => h.adopt((adopted = s));
  try {
    runs[0]!.session = h.open(runs[0]!.plan, previous);
    runs[1]!.session = h.open(runs[1]!.plan, runs[0]!.session?.id ?? previous ?? null);
    adopt(runs[0]!.session);
    for (const r of runs) r.session?.note(`redundant run ${r.i + 1} of 2`, { twinSessionId: runs[1 - r.i]!.session?.id ?? null, endpoints: r.plan.candidates.map((c) => c.id) });
    h.event(REDUNDANCY_STARTED, { sessions: runs.map((r) => r.session?.id ?? null), endpoints: runs.map((r) => r.plan.candidates.map((c) => c.id)), cap: twin.cap, perRun: twin.perRun });
    h.watch(() => runs.find((r) => r.session && !r.session.ended)?.session ?? runs[0]!.session);

    let queue: Promise<unknown> = Promise.resolve();
    const verify = (r: TwinRun, outcome: RunOutcome): Promise<VerifiedRun> => {
      const p = queue.then(() => h.verify(r, outcome));
      queue = p.catch(() => undefined);
      return p;
    };
    const go = async (r: TwinRun): Promise<Done> => {
      try {
        const outcome = await h.run(r);
        if (r.controller.signal.aborted) throw new Error(`aborted: ${String(r.controller.signal.reason)}`);
        const v = await verify(r, outcome);
        return { run: r, ok: true, outcome: v.outcome, v };
      } catch (error) {
        return { run: r, ok: false, error };
      }
    };
    const crash = (d: Done) => {
      if (d.ok || !isSimulatedCrash(d.error)) return;
      crashed = true;
      for (const r of runs) r.controller.abort("shutdown");
      throw d.error;
    };
    const pending = new Map(runs.map((r) => [r.i, go(r)]));
    const done: Done[] = [];
    let winner: Done | null = null;
    while (pending.size && !winner) {
      const d = await Promise.race(pending.values());
      pending.delete(d.run.i);
      done.push(d);
      crash(d);
      if (d.ok && passesVerification(d.outcome, d.v)) winner = d;
    }
    // A run still working is cancelled: its result is no longer needed.
    for (const r of runs) if (pending.has(r.i)) r.controller.abort(SUPERSEDED);
    const late = await Promise.all(pending.values());
    late.forEach(crash);

    const chosen = winner ?? done.find((d) => d.ok) ?? done[0]!;
    adopt(chosen.run.session);
    for (const d of [...done, ...late]) {
      if (d === chosen) continue;
      if (late.includes(d)) h.end(d.run.session, "cancelled", SUPERSEDED);
      else if (d.ok) {
        const status: SessionEndStatus = d.outcome.state === "budget_exhausted" ? "failed" : d.outcome.state;
        h.end(d.run.session, status, `${d.outcome.result.stopReason || d.outcome.state}; not used: ${winner ? `twin ${chosen.run.session?.id ?? chosen.run.i} passed verification` : "the twin's result was used"}`);
      } else h.endWithError(d.run.session, d.error);
    }
    h.event(REDUNDANCY_SETTLED, {
      winner: winner ? (chosen.run.session?.id ?? null) : null,
      used: chosen.run.session?.id ?? null,
      outcome: winner ? "verified" : chosen.ok ? "none_passed" : "both_failed",
      runs: [...done, ...late].map((d) => ({
        sessionId: d.run.session?.id ?? null,
        finished: done.includes(d),
        state: d.ok ? d.outcome.state : "error",
        verification: d.ok ? d.v.verified.decision.verificationStatus : null,
        servedEndpoints: h.served(d.run.session),
      })),
    });
    return chosen.ok ? { kind: "ok", outcome: chosen.outcome, verified: chosen.v } : { kind: "error", error: chosen.error };
  } finally {
    parent.removeEventListener("abort", onAbort);
    h.watch(null);
    // Whatever escaped, never leave a run's session running (the adopted one is the caller's).
    if (!crashed) for (const r of runs) if (r.session !== adopted) h.end(r.session, "failed", "executor_error");
  }
}
