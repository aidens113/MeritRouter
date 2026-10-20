import type { ResolvedConfig } from "../config/load.js";
import type { RunOutcome } from "../runners/types.js";
import type { SessionEndStatus } from "../sessions/events.js";
import { sessionEnd } from "../sessions/run-sessions.js";
import { AdmissionDenied, GatewayError } from "./errors.js";

/**
 * What becomes of a run that ended without an outcome (an error or an abort): a final state,
 * a deferral until capacity returns, or abandonment (the task is left to recovery or resume).
 */

export type AbortReason = "cancel" | "deadline" | "lease_lost" | "shutdown" | "watchdog";

/** Stop reason of a session the progress watchdog aborted; the task is re-queued to resume it. */
export const WATCHDOG_STOP = "watchdog";

export type Disposition =
  | { kind: "final"; state: RunOutcome["state"]; stopReason: string; summary?: string }
  | { kind: "defer"; at: number; reason: string }
  | { kind: "abandon"; reason: string };

/** The facts a failure is judged against (read only when needed): the clock, the task's deadline, and the capacity policy. */
export interface FailureContext {
  cfg: ResolvedConfig;
  now: () => number;
  /** The task's deadline (epoch ms), or Infinity when it has none. */
  deadline: () => number;
}

/** The disposition of a run that failed with `err` while its controller's signal was `signal`. */
export function classifyFailure(err: unknown, signal: AbortSignal, f: FailureContext): Disposition {
  const reason = signal.aborted ? (signal.reason as AbortReason) : null;
  if (reason === "cancel") return { kind: "final", state: "cancelled", stopReason: "cancelled while running" };
  if (reason === "lease_lost") return { kind: "abandon", reason: "lease lost" };
  if (reason === "shutdown") return { kind: "abandon", reason: "shutdown" };
  if (reason === "watchdog") return { kind: "abandon", reason: WATCHDOG_STOP };
  if (reason === "deadline") return { kind: "final", state: "failed", stopReason: "deadline_exceeded" };

  const now = f.now();
  const deadline = f.deadline();
  const capacity = (at: number, why: string): Disposition =>
    f.cfg.execution.on_capacity_exhausted === "queue" && at < deadline
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

/** How a session ends for a disposition reached without a runner outcome (errors, aborts, deferrals). */
export function dispositionSessionEnd(d: Disposition): { status: SessionEndStatus; stopReason: string } {
  if (d.kind === "final") return sessionEnd(d.state, d.stopReason);
  if (d.kind === "defer") return { status: "interrupted", stopReason: `deferred_for_capacity: ${d.reason}` };
  return { status: "interrupted", stopReason: d.reason };
}
