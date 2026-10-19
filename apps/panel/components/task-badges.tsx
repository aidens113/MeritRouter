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

export function AcceptanceBadge({ status }: { status: string }) {
  if (status === "met") return <Badge tone="good">Criteria met</Badge>;
  if (status === "unmet") return <Badge tone="bad">Criteria unmet</Badge>;
  return <Badge tone="neutral" title="Only passing checks with in-scope changes count as met">Not verified</Badge>;
}

export function RequestStatusBadge({ status }: { status: string }) {
  const tone: Tone = status === "succeeded" ? "good" : status === "failed" ? "bad" : status === "uncertain" ? "warn" : "accent";
  return <Badge tone={tone}>{status === "reserved" ? "in flight" : status}</Badge>;
}
