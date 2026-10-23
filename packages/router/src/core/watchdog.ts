import type { ResolvedConfig } from "../config/load.js";
import type { Db } from "../storage/db.js";
import type { StoredTask, TaskStore } from "../storage/tasks.js";
import type { SessionRecorder } from "../sessions/recorder.js";
import type { AbortReason } from "./disposition.js";
import { MAX_AUTO_RESUMES } from "./scheduler.js";
import { z } from "zod";
import { LeaseRefSchema } from "../storage/task-leases.js";

/** Slack added to a bounded operation's own timeout before the watchdog calls it stuck. */
export const WATCHDOG_MARGIN_MS = 60_000;

/** Tools that wait on purpose (other tasks, the user, a budget decision): a session inside one is never stuck. */
export const WATCHDOG_EXEMPT_TOOLS = new Set(["await_tasks", "ask_user", "request_more_budget", "await_supervisor_action"]);

/**
 * Tools that run the task's checks inside one call: `integrate_task` runs every job check after
 * each integration, so its allowance is one check timeout per check, not one in all.
 */
export const WATCHDOG_CHECK_RUNNING_TOOLS = new Set(["integrate_task"]);

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
 *   external) is running: the check timeout; for a tool that runs the task's checks itself
 *   (`integrate_task`), the check timeout times the number of checks times the job's
 *   repositories (it runs the checks once per repository it integrates into);
 * - anything else while the task has checks (the final checks run unjournaled): every check.
 * Supervisors waiting in await_tasks or ask_user are exempt.
 */
export function watchdogVerdict(cfg: ResolvedConfig, progress: SessionProgress, now: number, task: { checks: number; repositories?: number }): WatchdogVerdict {
  const base = cfg.execution.watchdog_minutes * 60_000;
  if (base <= 0) return { kind: "disabled" };
  const check = cfg.execution.check_timeout_seconds * 1000;
  let bound = 0;
  let waitingOn = progress.type ?? "start";
  if (progress.type === "model_request") {
    bound = cfg.providers.request_timeout_seconds * 1000 * (cfg.routing.max_endpoint_fallbacks + cfg.paid.max_paid_attempts);
    waitingOn = `model request (${progress.name ?? "?"})`;
  } else if (progress.type === "tool_intent") {
    if (progress.name && WATCHDOG_EXEMPT_TOOLS.has(progress.name)) return { kind: "exempt", reason: `waiting in ${progress.name}` };
    bound = progress.name && WATCHDOG_CHECK_RUNNING_TOOLS.has(progress.name) ? check * Math.max(1, task.checks) * Math.max(1, task.repositories ?? 1) : check;
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

/**
 * A single-task run the progress watchdog looks at: the run's (author's) session, the reviewer
 * session while a review runs (the one making progress then), and when that phase began.
 */
export interface WatchedRun {
  task: StoredTask;
  controller: AbortController;
  session: () => SessionRecorder | null;
  reviewer: SessionRecorder | null;
  phaseAt: number;
}

/**
 * Progress watchdog (called on every scheduler tick): a running session with no new event for
 * longer than its allowance (see `watchdogVerdict`) is aborted with reason `watchdog`. The
 * run then ends its session `interrupted` (`watchdog`) and the task is re-queued, so the next
 * run resumes the session from its last durable event. Returns the aborted task ids.
 */
export function abortStuckRuns(d: { cfg: ResolvedConfig; db: Db; tasks: TaskStore; now: () => number }, watched: ReadonlyMap<string, WatchedRun>): string[] {
  if (d.cfg.execution.watchdog_minutes <= 0) return [];
  const aborted: string[] = [];
  for (const [taskId, w] of watched) {
    if (!d.tasks.dispatchable(taskId, w.task.row.lease_owner ?? "", w.task.row.run_count, w.task.row.lease_incarnation)) continue;
    // During a review the reviewer's session is the one that must make progress (it runs no checks).
    const reviewing = !!w.reviewer && !w.reviewer.ended;
    const session = reviewing ? w.reviewer : w.session();
    if (w.controller.signal.aborted || !session || session.ended) continue;
    const progress = sessionProgress(d.db, session.id);
    if (!progress) continue;
    // Post-submission checks also wait for operator/supervisor decisions without a model
    // tool intent. Only a current bounded wait from this exact live task is exempt.
    const actionWait = d.db.prepare("SELECT type, data_json FROM events WHERE task_id = ? AND type IN ('worker_action_wait','worker_action_wait_end') ORDER BY id DESC LIMIT 1").get(taskId) as { type: string; data_json: string } | undefined;
    if (actionWait?.type === "worker_action_wait") {
      try {
        const data = z.object({ id: z.string(), until: z.number().int() }).parse(JSON.parse(actionWait.data_json));
        const row = d.db.prepare("SELECT value_json FROM worker_action_requests WHERE id=? AND task_id=? AND project_id=?").get(data.id, taskId, w.task.row.project_id) as { value_json: string } | undefined;
        const action = row ? z.object({ status: z.enum(["pending", "running", "completed", "denied", "cancelled", "uncertain"]), action: z.object({ lease: LeaseRefSchema }) }).parse(JSON.parse(row.value_json)) : null;
        const lease = action?.action.lease;
        if (action && ["pending", "running"].includes(action.status) && lease?.taskId === taskId && lease.project === w.task.row.project_id && lease.owner === w.task.row.lease_owner && lease.runCount === w.task.row.run_count && lease.incarnation === w.task.row.lease_incarnation && data.until > Date.now() && data.until <= Date.now() + 60_000) continue;
      } catch { /* Invalid persisted wait data cannot exempt a run. */ }
    }
    // Idle time counts from the later of the session's last event and the last phase switch
    // (a review starting or ending), so time spent in another session is not held against it.
    const v = watchdogVerdict(d.cfg, { ...progress, at: Math.max(progress.at, w.phaseAt) }, d.now(), { checks: reviewing ? 0 : (w.task.spec.constraints.checks?.length ?? 0), repositories: w.task.spec.repositoryAliases.length });
    if (v.kind !== "stuck") continue;
    d.tasks.event(taskId, "watchdog_abort", { sessionId: session.id, ...(reviewing ? { role: "reviewer" } : {}), idleMs: v.idleMs, allowanceMs: v.allowanceMs, waitingOn: v.waitingOn });
    w.controller.abort("watchdog" satisfies AbortReason);
    aborted.push(taskId);
  }
  return aborted;
}

/**
 * A run the watchdog stopped: interrupted, then queued again to resume its session (bounded
 * like recovery). The author's session is named even when a reviewer was the one stuck.
 */
export function requeueStuck(tasks: TaskStore, owner: string, task: StoredTask, watched: WatchedRun | undefined): void {
  const current = tasks.get(task.row.id)?.row;
  if (current?.lease_incarnation !== task.row.lease_incarnation || current.run_count !== task.row.run_count || current.lease_owner !== owner) return;
  tasks.interrupt(task.row.id, owner, "no progress: stopped by the watchdog", task.row.run_count);
  const now = tasks.get(task.row.id);
  if (now?.row.state !== "interrupted" || now.row.run_count >= MAX_AUTO_RESUMES) return;
  const sessionId = watched?.session()?.id;
  tasks.resume(task.row.id, sessionId ? { sessionId } : {});
}
