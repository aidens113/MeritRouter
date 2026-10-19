import type { ResolvedConfig } from "../config/load.js";
import type { Db } from "../storage/db.js";

/** Slack added to a bounded operation's own timeout before the watchdog calls it stuck. */
export const WATCHDOG_MARGIN_MS = 60_000;

/** Tools that wait on purpose (other tasks, the user): a session inside one is never stuck. */
export const WATCHDOG_EXEMPT_TOOLS = new Set(["await_tasks", "ask_user"]);

/** The last durable event of a session, from the SQLite index. */
export interface SessionProgress {
  /** When the session last changed (its last event, or a reopen). */
  at: number;
  type: string | null;
  /** Tool name for `tool_intent`, purpose for `model_request`. */
  name: string | null;
}

export function sessionProgress(db: Db, sessionId: string): SessionProgress | null {
  const s = db.prepare("SELECT updated_at FROM sessions WHERE id = ?").get(sessionId) as { updated_at: number } | undefined;
  if (!s) return null;
  const e = db.prepare("SELECT type, name, at FROM session_events WHERE session_id = ? ORDER BY seq DESC LIMIT 1").get(sessionId) as { type: string; name: string | null; at: number } | undefined;
  return { at: Math.max(s.updated_at, e?.at ?? 0), type: e?.type ?? null, name: e?.name ?? null };
}

export type WatchdogVerdict =
  | { kind: "disabled" }
  | { kind: "exempt"; reason: string }
  | { kind: "ok" | "stuck"; idleMs: number; allowanceMs: number; waitingOn: string };

/**
 * How long a session may go without a new event. The base is `execution.watchdog_minutes`; work
 * that is bounded by its own timeout extends it so it never trips the watchdog:
 * - a pending model request: the gateway timeout for every endpoint the gate may try;
 * - a tool intent without outcome, or a model response whose tool calls an agent (native or
 *   external) is running: the check timeout;
 * - anything else while the task has checks (the final checks run unjournaled): every check.
 * Supervisors waiting in await_tasks or ask_user are exempt.
 */
export function watchdogVerdict(cfg: ResolvedConfig, progress: SessionProgress, now: number, task: { checks: number }): WatchdogVerdict {
  const base = cfg.execution.watchdog_minutes * 60_000;
  if (base <= 0) return { kind: "disabled" };
  const check = cfg.execution.check_timeout_seconds * 1000;
  let bound = 0;
  let waitingOn = progress.type ?? "start";
  if (progress.type === "model_request") {
    bound = cfg.gateway.request_timeout_seconds * 1000 * (cfg.routing.max_endpoint_fallbacks + cfg.paid.max_paid_attempts);
    waitingOn = `model request (${progress.name ?? "?"})`;
  } else if (progress.type === "tool_intent") {
    if (progress.name && WATCHDOG_EXEMPT_TOOLS.has(progress.name)) return { kind: "exempt", reason: `waiting in ${progress.name}` };
    bound = check;
    waitingOn = `tool ${progress.name ?? "?"}`;
  } else if (progress.type === "model_response") {
    bound = check;
    waitingOn = "tool calls of the last response";
  } else if (task.checks > 0) {
    bound = check * task.checks;
    waitingOn = `${progress.type ?? "start"} (checks may be running)`;
  }
  const allowanceMs = Math.max(base, bound > 0 ? bound + WATCHDOG_MARGIN_MS : 0);
  const idleMs = Math.max(0, now - progress.at);
  return { kind: idleMs > allowanceMs ? "stuck" : "ok", idleMs, allowanceMs, waitingOn };
}
