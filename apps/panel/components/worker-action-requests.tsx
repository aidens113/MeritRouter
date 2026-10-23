import Link from "next/link";
import type { insights } from "switchyard-router";
import { itemBase } from "@/lib/links";
import { dateTime } from "@/lib/format";
import { Badge, Card, CardHeader } from "./ui";
import { TaskLink } from "./entity-links";
import { WorkerActionDecision } from "./client/worker-action-decision";

type Action = ReturnType<typeof insights.listWorkerActions>[number];
export function WorkerActionRequestsCard({ requests, decisions = true, policy }: { requests: Action[]; decisions?: boolean; policy: "disabled" | "human_only" | "supervisor" }) {
  if (!requests.length) return null;
  const pending = requests.filter(r => r.status === "pending");
  const settled = requests.filter(r => r.status !== "pending");
  const row = (r: Action) => <li key={r.id} id={`worker-action-${r.id}`} className="space-y-3 px-4 py-3 scroll-mt-20">
    <div className="flex flex-wrap items-center gap-2 text-sm"><Badge tone={r.status === "pending" ? "warn" : r.status === "completed" ? "good" : "neutral"}>{r.status}</Badge><TaskLink base={itemBase(r.project)} id={r.taskId} /><span className="font-mono text-xs text-ink-3">{r.id}</span></div>
    <p className="whitespace-pre-wrap break-words text-sm">{r.action.reason}</p>
    {r.action.operation ? <div className="space-y-1"><p className="text-sm font-medium">Requested operation: {r.action.operation.name}</p><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(r.action.operation.args, null, 2)}</pre></div> : <pre className="overflow-auto whitespace-pre-wrap break-words rounded border border-line p-3 text-xs">{r.action.command}</pre>}
    <dl className="grid gap-1 text-xs text-ink-3"><div><dt className="inline font-medium">Working directory: </dt><dd className="inline break-all">{r.action.cwd}</dd></div><div><dt className="inline font-medium">Timeout: </dt><dd className="inline">{r.action.timeoutMs / 1000}s</dd></div><div><dt className="inline font-medium">Source identity: </dt><dd className="inline break-all">{r.action.source}</dd></div></dl>
    <p className="text-xs text-ink-3">Asked {dateTime(r.createdAt)}{r.decidedBy ? ` | decided by ${r.decidedBy}` : ""}{r.exitCode !== null ? ` | exit ${r.exitCode}` : ""}</p>
    {r.decisionReason ? <p className="whitespace-pre-wrap text-sm">{r.decisionReason}</p> : null}
    {r.status === "pending" && decisions && policy !== "disabled" ? <WorkerActionDecision id={r.id} project={r.project} operation={Boolean(r.action.operation)} /> : null}
    {r.output !== null ? <details><summary className="cursor-pointer text-sm text-accent-ink">Recorded result</summary><pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs">{r.output}</pre></details> : null}
  </li>;
  return <Card id="worker-actions"><CardHeader title="Supervisor action requests" description={policy === "disabled" ? "Outside-repository actions are disabled in Security settings. Requests cannot be executed." : policy === "human_only" ? "Human approval required. Review each exact action here; automated supervisors cannot approve it." : "Supervisors or humans may approve each exact requested action. Workers remain inside their repository sandbox."} actions={pending.length ? <a href="#worker-actions" className="text-xs font-medium text-warn-ink hover:underline">{pending.length} pending</a> : <Link href="/all/settings?tab=security" className="text-xs text-accent-ink hover:underline">Security settings</Link>} />{pending.length ? <ul className="divide-y divide-line">{pending.map(row)}</ul> : null}{settled.length ? <details><summary className="cursor-pointer px-4 py-3 text-sm">Decision history ({settled.length})</summary><ul className="divide-y divide-line">{settled.map(row)}</ul></details> : null}</Card>;
}
