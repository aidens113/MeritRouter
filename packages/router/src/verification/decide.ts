import type { VerificationConfig, VerificationLevel } from "../config/schema.js";
import type { AcceptanceStatus, ExecutionStatus, ReviewRecord, SupervisorDecision, VerificationRecord, VerificationStatus } from "../core/task.js";
import type { CheckReport, CriterionResult } from "./checks.js";
import type { AcceptanceContract } from "./contract.js";
import type { Reevaluation, ResolvedReview } from "./policy.js";

/** A reviewer's verdict as decide() consumes it (review.ts produces it through submit_verdict). */
export interface ReviewOutcome {
  verdict: "pass" | "fail" | "inconclusive";
  criteria?: Array<{ id: string; outcome: "pass" | "fail" | "inconclusive"; reason?: string }>;
  reason?: string;
}

/** The effective policy for the result: the contract's, or the re-evaluated one when it rose. */
export interface EffectiveLevel {
  level: VerificationLevel;
  review: ResolvedReview;
  acceptance: "automatic" | "supervisor";
}

export interface DecideInput {
  policy: Pick<VerificationConfig, "failure">;
  contract: Pick<AcceptanceContract, "verification">;
  /** Re-evaluated level (reevaluateOnResult); the contract's when omitted. */
  effective?: EffectiveLevel;
  executionStatus: ExecutionStatus;
  report: CheckReport;
  review?: ReviewOutcome | null;
  /** The review reserve ran out before a required review could finish. */
  verificationBudgetExhausted?: boolean;
  qualityRetriesUsed?: number;
  /** Why a required review did not run or did not decide (reviewer unavailable or unqualified). */
  notes?: string[];
}

export interface Decision {
  verificationStatus: VerificationStatus;
  acceptanceStatus: AcceptanceStatus;
  /** What the executor should do next: accept, run one repair, or wait for the supervisor. */
  action: "accept" | "repair" | "await_supervisor" | "none";
  /** Criteria after applying the review verdict. */
  criteria: CriterionResult[];
  unresolvedCriterionIds: string[];
  reasons: string[];
}

const INSUFFICIENT = new Set(["not_run", "stale", "environment_failure", "inconclusive", "not_implemented"]);

function applyReview(criteria: CriterionResult[], review: ReviewOutcome | null | undefined): CriterionResult[] {
  if (!review?.criteria?.length) return criteria;
  const byId = new Map(review.criteria.map((c) => [c.id, c]));
  return criteria.map((c) => {
    const v = byId.get(c.id);
    if (!v) return c;
    if (v.outcome === "fail") return { ...c, outcome: "failed", ...(v.reason ? { note: v.reason } : {}) };
    // A review pass never overrides a check: check-verified criteria keep their check outcome.
    if (v.outcome === "pass" && c.verify !== "check" && c.outcome !== "failed") return { ...c, outcome: "passed" };
    return c;
  });
}

/**
 * The acceptance decision. Defects (a failed check, a failed criterion, a failing review) make
 * the result unmet, with one repair while quality retries remain; once none remain, a defect
 * only the reviewer found goes to the supervisor (who may overrule it). A required review that has
 * not run or is inconclusive, missing or stale evidence, and strict acceptance send the result
 * to the supervisor. A passing review verifies review and evidence criteria; claims nothing
 * contradicts but nothing proves stay not_verified, as before.
 */
export function decide(input: DecideInput): Decision {
  const eff: EffectiveLevel = input.effective ?? input.contract.verification;
  const criteria = applyReview(input.report.criteria, input.review);
  const unresolvedCriterionIds = criteria.filter((c) => c.outcome !== "passed").map((c) => c.id);
  const reasons: string[] = [...(input.notes ?? [])];
  const failedChecks = input.report.checks.filter((c) => c.outcome === "failed");
  const failedCriteria = criteria.filter((c) => c.outcome === "failed");
  for (const c of failedChecks) reasons.push(`${c.name} failed: ${c.detail}`);
  if (failedCriteria.length) reasons.push(`criteria failed: ${failedCriteria.map((c) => c.id).join(", ")}`);
  if (input.review?.verdict === "fail") reasons.push(`review failed${input.review.reason ? `: ${input.review.reason}` : ""}`);
  const defect = failedChecks.length > 0 || failedCriteria.length > 0 || input.review?.verdict === "fail";
  // Deterministic evidence (a failed check, a check-verified or self-reported failure) is final;
  // a defect only the reviewer found can be overruled by the supervisor.
  const deterministicDefect = failedChecks.length > 0 || input.report.criteria.some((c) => c.outcome === "failed");
  const out = (verificationStatus: VerificationStatus, acceptanceStatus: AcceptanceStatus, action: Decision["action"]): Decision => ({ verificationStatus, acceptanceStatus, action, criteria, unresolvedCriterionIds, reasons });

  if (input.executionStatus !== "completed") {
    reasons.push(`execution ${input.executionStatus}`);
    return defect ? out("failed", "unmet", "none") : out("inconclusive", "not_verified", "none");
  }
  if (defect) {
    const left = input.contract.verification.maxQualityRetries - (input.qualityRetriesUsed ?? 0);
    if (left > 0) return out("failed", "unmet", "repair");
    if (!deterministicDefect) {
      reasons.push("the reviewer's defect stands with no quality retry left: the supervisor decides (accepting overrules the reviewer, rejecting closes it)");
      return out("failed", "needs_supervisor", "await_supervisor");
    }
    return out("failed", "unmet", "none");
  }
  if (eff.review.required && !input.review) {
    if (input.verificationBudgetExhausted) {
      reasons.push(`the review reserve ran out before the ${eff.level} review finished (${input.policy.failure.on_verification_budget_exhausted})`);
      return out("skipped_budget", "needs_supervisor", "await_supervisor");
    }
    reasons.push(`level ${eff.level} requires an independent review, which has not run`);
    return out("pending", "needs_supervisor", "await_supervisor");
  }
  if (input.review?.verdict === "inconclusive") {
    reasons.push(`review inconclusive${input.review.reason ? `: ${input.review.reason}` : ""}`);
    return out("inconclusive", "needs_supervisor", "await_supervisor");
  }
  const insufficient = input.report.checks.filter((c) => c.required && INSUFFICIENT.has(c.outcome));
  if (insufficient.length) {
    for (const c of insufficient) reasons.push(`${c.name} ${c.outcome}: ${c.detail}`);
    const acceptance = input.policy.failure.on_insufficient_evidence;
    return out("inconclusive", acceptance, acceptance === "needs_supervisor" ? "await_supervisor" : "none");
  }
  if (eff.acceptance === "supervisor") {
    reasons.push(`level ${eff.level} is accepted only by the supervisor`);
    return out("passed", "needs_supervisor", "await_supervisor");
  }
  if (unresolvedCriterionIds.length) {
    reasons.push(`criteria not independently verified: ${unresolvedCriterionIds.join(", ")}`);
    return out("passed", "not_verified", "none");
  }
  return out("passed", "met", "accept");
}

/** Build the record stored on the result. */
export function verificationRecord(args: {
  contract: AcceptanceContract;
  contractSha256: string | null;
  reevaluation?: Reevaluation | null;
  report: CheckReport;
  decision: Decision;
  decisions?: SupervisorDecision[];
  reviews?: ReviewRecord[];
}): VerificationRecord {
  const { contract, reevaluation: re } = args;
  return {
    level: re?.level ?? contract.verification.level,
    raisedFrom: re?.raisedFrom ?? null,
    importance: re?.importance ?? contract.importance.level,
    importanceSource: re?.importanceSource ?? contract.importance.source,
    rulesMatched: re?.rulesMatched ?? contract.verification.rulesMatched,
    contractSha256: args.contractSha256,
    policyFingerprint: re?.fingerprint ?? contract.fingerprints.policy,
    checks: args.report.checks.map((c) => ({ name: c.name, required: c.required, outcome: c.outcome, detail: c.detail })),
    criteria: args.decision.criteria.map((c) => ({ id: c.id, text: c.text, verify: c.verify, outcome: c.outcome, checks: c.checks, evidenceRefs: c.evidenceRefs, ...(c.note ? { note: c.note } : {}) })),
    reasons: args.decision.reasons,
    decisions: args.decisions ?? [],
    ...(args.reviews?.length ? { reviews: args.reviews } : {}),
  };
}

export interface SupervisorDecisionInput {
  decision: "accept" | "reject";
  by: SupervisorDecision["by"];
  reason?: string | null;
  at: number;
}

export type SupervisorDecisionResult =
  | { ok: true; acceptanceStatus: AcceptanceStatus; record: SupervisorDecision }
  | { ok: false; code: "reason_required" | "cannot_accept_unmet" | "human_acceptance_required"; message: string };

/**
 * Accept or reject a result on behalf of the job's supervisor or a human. Rejecting always
 * needs a reason. Accepting an unmet result is refused (reject it or repair it); accepting a
 * not_verified or needs_supervisor result needs a reason; strict results with
 * strict_acceptor: human accept only a human.
 */
export function applySupervisorDecision(current: { acceptanceStatus: AcceptanceStatus }, contract: Pick<AcceptanceContract, "verification"> | null, d: SupervisorDecisionInput): SupervisorDecisionResult {
  const reason = d.reason?.trim() || null;
  const record = (decision: SupervisorDecision["decision"]): SupervisorDecision => ({ decision, by: d.by, reason, at: d.at });
  if (d.decision === "reject") {
    if (!reason) return { ok: false, code: "reason_required", message: "rejecting a result needs a reason" };
    return { ok: true, acceptanceStatus: "unmet", record: record("rejected") };
  }
  if (current.acceptanceStatus === "unmet") return { ok: false, code: "cannot_accept_unmet", message: "an unmet result cannot be accepted; reject it or repair it" };
  if (current.acceptanceStatus === "met") return { ok: true, acceptanceStatus: "met", record: record("accepted") };
  if (!reason) return { ok: false, code: "reason_required", message: `accepting a ${current.acceptanceStatus} result needs a reason` };
  if (contract?.verification.acceptance === "supervisor" && contract.verification.strictAcceptor === "human" && d.by.kind !== "human") {
    return { ok: false, code: "human_acceptance_required", message: "verification.strict_acceptor is human: only a human can accept this result" };
  }
  return { ok: true, acceptanceStatus: "met", record: record("accepted") };
}
