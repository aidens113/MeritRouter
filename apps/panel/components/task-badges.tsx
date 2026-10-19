import { Badge, type Tone } from "./ui";

export const TASK_STATE_LABEL: Record<string, string> = {
  queued: "Queued",
  waiting_for_dependencies: "Waiting on dependencies",
  waiting_for_capacity: "Waiting for capacity",
  running: "Running",
  cancel_requested: "Cancelling",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
  budget_exhausted: "Budget exhausted",
};

const TONE: Record<string, Tone> = {
  queued: "neutral",
  waiting_for_dependencies: "neutral",
  waiting_for_capacity: "warn",
  running: "accent",
  cancel_requested: "warn",
  completed: "good",
  failed: "bad",
  cancelled: "neutral",
  interrupted: "serious",
  budget_exhausted: "bad",
};

export function TaskStateBadge({ state, count }: { state: string; count?: number }) {
  return (
    <Badge tone={TONE[state] ?? "neutral"}>
      {TASK_STATE_LABEL[state] ?? state}
      {count !== undefined ? <span className="tabular opacity-80">· {count}</span> : null}
    </Badge>
  );
}

export function TierBadge({ tier }: { tier: string | null }) {
  if (!tier) return <span className="text-xs text-ink-3">–</span>;
  const tone: Tone = tier === "T4" ? "serious" : "accent";
  return (
    <Badge tone={tone} title={tier === "T4" ? "Too hard for workers: returned to the supervisor" : `Difficulty tier ${tier}`}>
      {tier}
    </Badge>
  );
}

export const ACCEPTANCE_LABEL: Record<string, string> = {
  met: "Criteria met",
  unmet: "Criteria unmet",
  not_verified: "Not verified",
  needs_supervisor: "Needs supervisor",
};

const ACCEPTANCE_TONE: Record<string, Tone> = { met: "good", unmet: "bad", not_verified: "neutral", needs_supervisor: "warn" };

const ACCEPTANCE_TITLE: Record<string, string> = {
  met: "The verification policy was satisfied, or a supervisor or person accepted the result",
  unmet: "A check, criterion, or review failed, or the result was rejected",
  not_verified: "Some criteria rest only on the worker's own claims; nothing failed",
  needs_supervisor: "Waiting for a supervisor's or a person's decision: strict verification, missing evidence, or a review that has not run",
};

export function AcceptanceBadge({ status }: { status: string }) {
  return (
    <Badge tone={ACCEPTANCE_TONE[status] ?? "neutral"} title={ACCEPTANCE_TITLE[status]}>
      {ACCEPTANCE_LABEL[status] ?? status}
    </Badge>
  );
}

export const VERIFICATION_LABEL: Record<string, string> = {
  not_required: "No verification",
  pending: "Verification pending",
  passed: "Verification passed",
  failed: "Verification failed",
  inconclusive: "Inconclusive",
  skipped_budget: "Skipped: budget",
};

const VERIFICATION_TONE: Record<string, Tone> = { not_required: "neutral", pending: "warn", passed: "good", failed: "bad", inconclusive: "serious", skipped_budget: "serious" };

export function VerificationBadge({ status }: { status: string }) {
  return <Badge tone={VERIFICATION_TONE[status] ?? "neutral"}>{VERIFICATION_LABEL[status] ?? status}</Badge>;
}

const IMPORTANCE_TONE: Record<string, Tone> = { low: "neutral", normal: "neutral", high: "warn", critical: "serious" };

export function ImportanceBadge({ level }: { level: string }) {
  return (
    <Badge tone={IMPORTANCE_TONE[level] ?? "neutral"} title="Task importance: with the tier and the actual change, it picks how much evidence the result needs">
      {level} importance
    </Badge>
  );
}

/** Outcome of one named check or criterion on a verification record. */
export function OutcomeBadge({ outcome }: { outcome: string }) {
  const tone: Tone =
    outcome === "passed" ? "good" : outcome === "failed" ? "bad" : outcome === "claimed" ? "accent" : ["stale", "environment_failure", "inconclusive", "not_implemented"].includes(outcome) ? "serious" : outcome === "pending_review" ? "warn" : "neutral";
  return <Badge tone={tone}>{outcome.replace(/_/g, " ")}</Badge>;
}

export function RequestStatusBadge({ status }: { status: string }) {
  const tone: Tone = status === "succeeded" ? "good" : status === "failed" ? "bad" : status === "uncertain" ? "warn" : "accent";
  return <Badge tone={tone}>{status === "reserved" ? "in flight" : status}</Badge>;
}
