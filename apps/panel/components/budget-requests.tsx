import type { insights } from "switchyard-router";
import { itemBase } from "@/lib/links";
import { dateTime, humanize, num } from "@/lib/format";
import { Badge, Card, CardHeader, EmptyState, Stat } from "./ui";
import { TaskLink } from "./entity-links";
import { BudgetDecision } from "./client/budget-decision";

type RequestView = insights.BudgetRequestView;

export function BudgetRequestsCard({ requests, decisions = true, pendingOnly = false, id = "budget-requests" }: { requests: RequestView[]; decisions?: boolean; pendingOnly?: boolean; id?: string }) {
  const pending = requests.filter((r) => r.status === "pending");
  const settled = requests.filter((r) => r.status !== "pending");
  const row = (r: RequestView) => {
    const base = r.project ? itemBase(r.project) : "";
    return <li key={r.id} id={`budget-request-${r.id}`} className="space-y-3 px-4 py-3 scroll-mt-20">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <a href={`#budget-request-${r.id}`} className="font-medium text-ink hover:underline">Request #{r.id}</a>
        <Badge tone={r.status === "pending" ? "warn" : r.status === "approved" ? "good" : "neutral"}>{r.status}</Badge>
        <TaskLink base={base} id={r.taskId} label={r.label} />
        {r.jobId ? <><span className="text-ink-3">in job</span><TaskLink base={base} id={r.jobId} job /></> : null}
        <span className="text-xs text-ink-3">{r.project || "Unassigned"}</span>
      </div>
      <p className="text-sm text-ink-2">Asks for <strong>{num(r.requests)}</strong> more model requests; used {num(r.used)} of {num(r.cap)} when it asked. Approver: {humanize(r.approver)}.</p>
      <p className="whitespace-pre-wrap break-words text-sm text-ink">{r.reason}</p>
      <p className="text-xs text-ink-3">Asked {dateTime(r.createdAt)}{r.decidedAt ? `; decided ${dateTime(r.decidedAt)} by ${r.decidedBy}` : ""}</p>
      {r.status === "pending" && decisions ? <BudgetDecision id={r.id} project={r.project} requested={r.requests} available={r.pool?.available ?? null} /> : r.status !== "pending" ? <p className="whitespace-pre-wrap break-words text-sm text-ink-2">{r.status === "approved" ? `Granted ${num(r.granted)}. ` : ""}{r.decisionReason}</p> : null}
    </li>;
  };
  return <Card id={id}>
    <CardHeader title="Budget requests" description="Additional model requests keep workers going. Decisions are recorded with your reason; paid spending limits stay unchanged." actions={pending.length ? <a href={`#${id}`} className="text-xs font-medium text-warn-ink hover:underline">{num(pending.length)} pending</a> : undefined} />
    {pending.length ? <ul className="divide-y divide-line">{pending.map(row)}</ul> : <EmptyState title="No pending budget requests">Workers can ask for additional model requests when their budget runs low.</EmptyState>}
    {!pendingOnly && settled.length ? <details className="border-t border-line"><summary className="cursor-pointer px-4 py-3 text-sm text-ink-2">Decision history ({num(settled.length)})</summary><ul className="divide-y divide-line">{settled.map(row)}</ul></details> : null}
    {requests.length >= 200 ? <p className="border-t border-line px-4 py-2 text-xs text-ink-3">Showing the latest {num(requests.length)} requests in this view.</p> : null}
  </Card>;
}

export function JobBudgetCard({ budget, base }: { budget: insights.JobBudgetView; base: string }) {
  const p = budget.pool;
  const granted = budget.tasks.reduce((n, t) => n + t.granted + t.extra, 0);
  return <Card id="request-pool">
    <CardHeader title="Job request pool" description="Worker grants and sub-job carves hold requests while work is open. Unused requests return when work finishes." />
    <div className="grid grid-cols-2 gap-3 p-4 lg:grid-cols-3">
      <Stat label="Pool limit" value={num(p.cap)} />
      <Stat label="Supervisor used" value={num(p.used)} />
      <Stat label="Worker grants" value={num(granted)} sub="Initial grants plus approved extras" />
      <Stat label="Held by tasks and sub-jobs" value={num(p.held)} />
      <Stat label="Supervisor reserve" value={num(p.reserve)} />
      <Stat label="Available for grants" value={num(p.available)} tone={p.available ? undefined : "warn"} />
    </div>
    {budget.tasks.length ? <div className="overflow-x-auto border-t border-line"><table className="data-table"><thead><tr><th>Task</th><th>State</th><th>Initial grant</th><th>Approved extras</th><th>Used</th><th>Held now</th></tr></thead><tbody>{budget.tasks.map((t) => <tr key={t.taskId}><td><TaskLink base={base} id={t.taskId} label={t.label} /><div className="text-xs text-ink-3">{humanize(t.source)}</div></td><td>{humanize(t.state)}</td><td>{num(t.granted)}</td><td>{num(t.extra)}</td><td>{num(t.used)}</td><td>{num(t.held)}</td></tr>)}</tbody></table></div> : <EmptyState title="No worker grants yet">Grants appear when the supervisor delegates a task.</EmptyState>}
  </Card>;
}

export function TaskBudgetCard({ budget, used, base }: { budget: NonNullable<ReturnType<typeof insights.taskBudget>>; used: number; base: string }) {
  return <Card id="task-budget"><CardHeader title="Task request budget" description="The supervisor's grant plus approved extras. Paid limits are unchanged." /><div className="grid grid-cols-2 gap-3 p-4 lg:grid-cols-4"><Stat label="Initial grant" value={num(budget.granted)} sub={humanize(budget.source)} /><Stat label="Approved extras" value={num(budget.extra)} /><Stat label="Total granted" value={num(budget.granted + budget.extra)} /><Stat label="Used" value={num(used)} /></div><p className="border-t border-line px-4 py-2 text-xs text-ink-3">Pool and other task grants: <TaskLink base={base} id={budget.jobId} job />.</p></Card>;
}
