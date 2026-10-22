import Link from "next/link";
import type { insights } from "switchyard-router";
import { Badge, EmptyState, type Tone } from "./ui";
import { AgentLink } from "./entity-links";
import { ago, dateTime, duration, humanize, shortId } from "@/lib/format";
import { jobHref, sessionHref, taskHref } from "@/lib/links";

export type SessionRow = ReturnType<typeof insights.sessionsView>[number];

export const SESSION_STATUS_LABEL: Record<string, string> = {
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  interrupted: "Interrupted",
  cancelled: "Cancelled",
};

const STATUS_TONE: Record<string, Tone> = {
  running: "accent",
  completed: "good",
  failed: "bad",
  interrupted: "serious",
  cancelled: "neutral",
};

export const ROLE_LABEL: Record<string, string> = {
  supervisor: "Supervisor",
  summarizer: "Summarizer",
  inspector: "Inspector",
  analyst: "Analyst",
  implementer: "Implementer",
  reviewer: "Reviewer",
  classifier: "Classifier",
};

export function SessionStatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status] ?? "neutral"}>{SESSION_STATUS_LABEL[status] ?? status}</Badge>;
}

export function roleLabel(role: string): string {
  return ROLE_LABEL[role] ?? humanize(role);
}

/** Where a session's task is best viewed: jobs (supervise) have their own page. */
export function sessionTaskHref(s: Pick<SessionRow, "taskId" | "profile">, base: string): string | null {
  if (!s.taskId) return null;
  return s.profile === "supervise" ? jobHref(base, s.taskId) : taskHref(base, s.taskId);
}

/** Sessions as a table; used by the Sessions page and the task, job, and session detail pages. `base` is the project path links start from. */
export function SessionsTable({ rows, base, now = Date.now(), hideTask = false, empty }: { rows: SessionRow[]; base: string; now?: number; hideTask?: boolean; empty?: string }) {
  if (!rows.length) return <EmptyState title={empty ?? "No sessions recorded"}>Sessions appear as agents run: one per classifier call, worker attempt, or supervisor.</EmptyState>;
  return (
    <div className="overflow-x-auto">
      <table className="data-table">
        <thead>
          <tr>
            <th>Started</th>
            <th>Session</th>
            <th>Status</th>
            {hideTask ? null : <th>Task</th>}
            <th>Spawned by</th>
            <th className="text-right">Requests</th>
            <th className="text-right">Tool calls</th>
            <th className="text-right">Events</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => {
            const href = sessionTaskHref(s, base);
            return (
              <tr key={s.id}>
                <td className="whitespace-nowrap">
                  <div title={dateTime(s.createdAt)}>{ago(s.createdAt, now)}</div>
                  <div className="text-[11px] text-ink-3">{s.status === "running" ? `last event at +${duration(s.durationMs)}` : `took ${duration(s.durationMs)}`}</div>
                </td>
                <td className="whitespace-nowrap">
                  <Link href={sessionHref(base, s.id)} className="font-medium text-accent-ink hover:underline" title={`Session ${s.id}`}>
                    {roleLabel(s.role)}
                  </Link>
                  <span className="ml-1.5 text-xs text-ink-3">
                    {s.profile ?? ""}
                    {s.tier ? ` · ${s.tier}` : ""}
                  </span>
                  <div>
                    <AgentLink base={base} agent={s.agentLabel} className="text-[11px]" />
                  </div>
                </td>
                <td>
                  <SessionStatusBadge status={s.status} />
                  {s.stopReason && s.status !== "running" ? (
                    <div className="mt-1 max-w-[14rem] truncate text-[11px] text-ink-3" title={s.stopReason}>
                      {humanize(s.stopReason)}
                    </div>
                  ) : null}
                  {s.resumable ? <div className="mt-0.5 text-[11px] font-medium text-accent-ink">can be resumed</div> : null}
                </td>
                {hideTask ? null : (
                  <td className="whitespace-nowrap">
                    {href ? (
                      <Link href={href} className="text-xs text-accent-ink hover:underline">
                        {s.taskLabel ?? <span className="font-mono">{shortId(s.taskId!, 18)}</span>}
                      </Link>
                    ) : (
                      <span className="text-xs text-ink-3">no task</span>
                    )}
                    {s.previousSessionId ? <div className="text-[11px] text-ink-3">retry of an earlier session</div> : null}
                  </td>
                )}
                <td className="whitespace-nowrap">
                  {s.parentSessionId ? (
                    <Link href={sessionHref(base, s.parentSessionId)} className="font-mono text-[11px] text-accent-ink hover:underline">
                      {shortId(s.parentSessionId, 18)}
                    </Link>
                  ) : (
                    <span className="text-xs text-ink-3">–</span>
                  )}
                </td>
                <td className="tabular text-right text-xs text-ink">{s.modelRequests}</td>
                <td className="tabular text-right text-xs text-ink">{s.toolCalls}</td>
                <td className="tabular text-right text-xs text-ink-2">{s.lastSeq}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
