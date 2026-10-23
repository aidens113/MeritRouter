import type { TaskLabAuthority } from "../runners/coding/task-lab.js";
import type { ResolvedConfig } from "../config/load.js";
import { TIER_NAMES, type Importance, type ProfileMode, type TierName, type VerificationConfig } from "../config/schema.js";
import { budgetInputFor, effectiveBudget, verificationTotal } from "../admission/admission.js";
import type { ArtifactStore } from "../storage/artifacts.js";
import type { StoredTask, TaskStore } from "../storage/tasks.js";
import type { Classification } from "../scoring/score.js";
import { compileContract, executionCap, type ContractStore, type StoredContract } from "../verification/contract.js";
import { evaluatePolicy, reevaluateOnResult, resolveLevel, type Reevaluation } from "../verification/policy.js";
import { runNamedChecks, selfReportFromOutput } from "../verification/checks.js";
import { applySupervisorDecision, decide, verificationRecord, type Decision, type ReviewOutcome } from "../verification/decide.js";
import { declaredPaths } from "../verification/match.js";
import { baseResult, type AcceptanceDecisionInput, type AcceptanceDecisionOutcome, type RetryContext, type RunOutcome, type RunnerResult } from "../runners/types.js";
import { MeritRouterError, TaskValidationError } from "./errors.js";
import { criteria, criterionTexts, isTerminal, type ReviewRecord, type WorkerResult, type WorkerTask } from "./task.js";

/**
 * The glue between the executor and the verification library: compiling and storing a task's
 * acceptance contract, the run caps its budget allocation implies, verifying a runner outcome
 * against it, the failure context an escalation retry gets, and supervisor decisions.
 */

export function nextTier(tier: TierName): TierName | null {
  return TIER_NAMES[TIER_NAMES.indexOf(tier) + 1] ?? null;
}

/** The parent job's importance: its contract's effective level, else what its spec asked for. */
export function parentImportance(tasks: TaskStore, contracts: ContractStore, spec: Pick<WorkerTask, "parentTaskId">): { taskId: string; importance: Importance } | null {
  const id = spec.parentTaskId;
  if (!id) return null;
  const stored = contracts.get(id);
  if (stored) return { taskId: id, importance: stored.contract.importance.level };
  const parent = tasks.get(id);
  return parent?.spec.importance ? { taskId: id, importance: parent.spec.importance } : null;
}

export interface ContractDeps {
  cfg: ResolvedConfig;
  tasks: TaskStore;
  contracts: ContractStore;
  /** Requests already charged to the task (classification, earlier runs). */
  requestsUsed: (taskId: string) => number;
  now: () => number;
}

export type EnsuredContract = { ok: true; stored: StoredContract; created: boolean } | { ok: false; message: string };

/** The result of a task whose verification policy needs more requests than it allows: failed, not run. */
export function contractShortfall(spec: WorkerTask, message: string): RunnerResult {
  return baseResult({
    executionStatus: "failed",
    stopReason: `verification_budget_insufficient: ${message}`,
    summary: `Not run. ${message}.`,
    unresolvedCriteria: criterionTexts(spec),
  });
}

/**
 * Compile the task's contract once, after classification and before its first run, and store
 * it. A task that already has one (a resumed or recovered run) keeps it unchanged.
 */
export function ensureContract(d: ContractDeps, task: StoredTask, tier: TierName, classification: Classification | null): EnsuredContract {
  const existing = d.contracts.get(task.row.id);
  if (existing) return { ok: true, stored: existing, created: false };
  const spec = task.spec;
  const compiled = compileContract({
    taskId: task.row.id,
    spec,
    tier,
    tags: classification?.tags ?? spec.hints?.tags ?? null,
    rulebookFingerprint: classification?.rulebookVersion ?? null,
    policy: d.cfg.verification,
    budget: budgetInputFor(d.cfg, spec, tier, d.requestsUsed(task.row.id)),
    parent: parentImportance(d.tasks, d.contracts, spec),
    now: d.now(),
  });
  if (!compiled.ok) return { ok: false, message: compiled.message };
  const { sha256, created } = d.contracts.save(compiled.contract);
  const c = compiled.contract;
  d.tasks.event(task.row.id, "contract_compiled", {
    sha256,
    level: c.verification.level,
    importance: c.importance.level,
    importanceSource: c.importance.source,
    rulesMatched: c.verification.rulesMatched,
    budget: c.budget,
  });
  return { ok: true, stored: { contract: c, sha256, createdAt: c.createdAt }, created };
}

/**
 * The request cap (cumulative, as admission counts it) for a task's first run. Without a
 * contract it is the tier's cap, as before verification. With one, the run may not reach into
 * the review and repair reserves (repair and review caps: verification/contract.ts).
 */
export function runCap(cfg: ResolvedConfig, spec: WorkerTask, tier: TierName, stored: StoredContract | null): number {
  const tierCap = effectiveBudget(cfg, spec, tier).maxModelRequests;
  return stored ? executionCap(stored.contract.budget, tierCap) : tierCap;
}

/**
 * Submit-time check: when even the weakest level the task could get (over every tier it could
 * be classified at) needs more requests than its total cap allows, reject it now rather than
 * after classification. Returns the reason, or null when the budget may suffice.
 */
export function verificationBudgetShortfall(cfg: ResolvedConfig, spec: WorkerTask, parent: { taskId: string; importance: Importance } | null): string | null {
  const profile = cfg.profiles[spec.profile];
  if (!profile || profile.mode === "supervisor") return null;
  let start: number;
  if (spec.hints?.difficulty === "T4") {
    // T4 returns to the supervisor, unless premium paid routing runs it at T3.
    if (!(cfg.paid.enabled && cfg.paid.tiers.T4 === "premium")) return null;
    start = TIER_NAMES.indexOf("T3");
  } else {
    const floors = [profile.min_tier, spec.hints?.difficulty, spec.routing?.tier].filter((t): t is TierName => t !== undefined);
    start = Math.max(0, ...floors.map((t) => TIER_NAMES.indexOf(t)));
  }
  const policy = cfg.verification;
  const crit = criteria(spec);
  let least: { needed: number; level: string } | null = null;
  for (const tier of TIER_NAMES.slice(start)) {
    const ev = evaluatePolicy(policy, {
      tier,
      profile: spec.profile,
      tags: spec.hints?.tags ?? null,
      paths: declaredPaths(spec),
      protectedPathsChanged: null,
      criteria: crit,
      requestedImportance: spec.importance ?? null,
      importanceReason: spec.importanceReason ?? null,
      parent,
      atLeast: spec.verification?.atLeast ?? null,
      addChecks: spec.verification?.addChecks ?? [],
    });
    const needed = (ev.review.required ? (policy.budget.review_requests[ev.level] ?? 0) : 0) + 1;
    if (!least || needed < least.needed) least = { needed, level: ev.level };
  }
  const total = verificationTotal(cfg, spec);
  if (!least || least.needed <= total) return null;
  return `verification_budget_insufficient: verification level ${least.level} needs at least ${least.needed} model requests (review ${least.needed - 1}, execution 1) but the task allows ${total}; raise budget.maxModelRequests or lower the importance`;
}

export interface VerifiedOutcome {
  result: RunnerResult;
  decision: Decision;
  reevaluation: Reevaluation;
}

/** What the review phase adds to a verification (see verification/review.ts). */
export interface VerifyOptions {
  taskLabAuthority?: TaskLabAuthority | null;
  /** The tier the run actually ran at (escalation or repair); the level can only rise. */
  tier?: TierName;
  /** The latest review verdict, when a review ran. */
  review?: ReviewOutcome | null;
  /** The review allowance ran out before a required review finished. */
  verificationBudgetExhausted?: boolean;
  /** Every review of this task so far, recorded on the result. */
  reviews?: ReviewRecord[];
  /** Why a required review did not run or did not decide (reviewer unavailable, unqualified). */
  notes?: string[];
}

/**
 * Verify a runner outcome against the contract: re-evaluate the policy on what actually
 * changed and the tier it ran at (it can only rise), run the named checks on the submitted
 * revision, and decide (with the review verdict, when one ran). Unresolved criteria are those
 * neither verified nor claimed with evidence.
 */
export function verifyOutcome(policy: VerificationConfig, stored: StoredContract, mode: ProfileMode, outcome: RunOutcome, qualityRetriesUsed: number, opts: VerifyOptions = {}): VerifiedOutcome {
  const r = outcome.result;
  const contract = stored.contract;
  const reevaluation = reevaluateOnResult(policy, contract, { changedPaths: r.changedPaths ?? [], protectedPathsChanged: r.protectedPathsChanged ?? [], ...(opts.tier ? { tier: opts.tier } : {}) });
  const ev = outcome.evidence ?? {};
  const report = runNamedChecks({
    contract,
    mode,
    requiredChecks: reevaluation.checks,
    result: r,
    revision: ev.revision ?? null,
    artifactDigest: ev.artifactDigest ?? null,
    universe: ev.universe ?? null,
    selfReport: ev.output ? selfReportFromOutput(ev.output, contract) : null,
    review: opts.review?.criteria ?? null,
    taskLabAuthority: opts.taskLabAuthority,
  });
  const decision = decide({
    policy,
    contract,
    effective: reevaluation,
    executionStatus: r.executionStatus,
    report,
    qualityRetriesUsed,
    review: opts.review ?? null,
    verificationBudgetExhausted: opts.verificationBudgetExhausted ?? false,
    notes: opts.notes ?? [],
  });
  const unresolved = decision.criteria.filter((c) => c.outcome !== "passed" && c.outcome !== "claimed");
  return {
    decision,
    reevaluation,
    result: {
      ...r,
      acceptanceStatus: decision.acceptanceStatus,
      verificationStatus: decision.verificationStatus,
      verification: verificationRecord({ contract, contractSha256: stored.sha256, reevaluation, report, decision, reviews: opts.reviews ?? [] }),
      unresolvedCriteria: unresolved.map((c) => c.text),
      unresolvedCriterionIds: unresolved.map((c) => c.id),
    },
  };
}

const LOG_TAIL = 2000;

/** What the escalation retry is told about the attempt that failed. */
export function failureContext(artifacts: ArtifactStore, fromTier: TierName, reason: string, result: RunnerResult): RetryContext {
  const failing = result.checks.filter((c) => c.exitCode !== 0).slice(0, 3);
  return {
    fromTier,
    reason,
    stopReason: result.stopReason,
    findings: result.findings.slice(0, 10).map((f) => f.description.slice(0, 400)),
    unresolvedCriteria: result.unresolvedCriteria.slice(0, 20),
    failingChecks: failing.map((c) => {
      let log = "";
      try {
        log = artifacts.read(c.logRef)?.content.toString("utf8") ?? "";
      } catch {
        log = "";
      }
      return { command: c.command, exitCode: c.exitCode, logRef: c.logRef, logTail: log.length > LOG_TAIL ? `[...]\n${log.slice(-LOG_TAIL)}` : log };
    }),
    verificationReasons: (result.verification?.reasons ?? []).slice(0, 10),
  };
}

export interface DecisionDeps {
  /** Synchronous metadata fence under the result update transaction; must not wait or inspect Git. */
  beforeAccept?: (task: StoredTask) => void;
  cfg: ResolvedConfig;
  tasks: TaskStore;
  contracts: ContractStore;
  now: () => number;
}

/**
 * Accept or reject a finished task's result on behalf of the job's supervisor or a human.
 * The decision (who, why, when) is appended to the result's verification record and written as
 * a task event. Refusals throw a MeritRouterError with the library's code.
 */
export function recordAcceptanceDecision(d: DecisionDeps, id: string, decision: "accept" | "reject", input: AcceptanceDecisionInput): AcceptanceDecisionOutcome {
  return d.tasks.updateResult(id, (t) => {
    if (!t.result || !isTerminal(t.row.state)) throw new TaskValidationError(`task ${id} has not finished (${t.row.state})`);
    if (decision === "accept" && t.row.state !== "completed") throw new TaskValidationError(`task ${id} ended ${t.row.state}; only a completed task can be accepted`);
    if (decision === "accept") d.beforeAccept?.(t);
    const stored = d.contracts.get(id);
    // A level raised on the result (for example to strict) governs, not only the contract's.
    const raisedToSupervisor = t.result.verification ? resolveLevel(d.cfg.verification, t.result.verification.level).acceptance === "supervisor" : false;
    const contract = stored ? { verification: { ...stored.contract.verification, acceptance: raisedToSupervisor ? ("supervisor" as const) : stored.contract.verification.acceptance } } : null;
    const res = applySupervisorDecision(t.result, contract, { decision, by: input.by, reason: input.reason ?? null, at: d.now() });
    if (!res.ok) throw new MeritRouterError(res.code, res.message);
    const v = t.result.verification;
    const result: WorkerResult = { ...t.result, acceptanceStatus: res.acceptanceStatus, ...(v ? { verification: { ...v, decisions: [...v.decisions, res.record] } } : {}) };
    return {
      result,
      event: { type: res.record.decision === "accepted" ? "result_accepted" : "result_rejected", data: { by: res.record.by, reason: res.record.reason, acceptanceStatus: res.acceptanceStatus, previous: t.result.acceptanceStatus } },
      value: { taskId: id, acceptanceStatus: res.acceptanceStatus, decision: res.record },
    };
  });
}
