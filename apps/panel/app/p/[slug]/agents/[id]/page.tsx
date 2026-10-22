import Link from "next/link";
import { notFound } from "next/navigation";
import { insights } from "switchyard-router";
import { getSy } from "@/lib/sy";
import { project } from "@/lib/project";
import { projectBase, agentHref, sessionHref } from "@/lib/links";
import { dateTime } from "@/lib/format";
import { SetupScreen } from "@/components/setup";
import { PageHeader } from "@/components/page-header";
import { AgentLink, TaskLink, ModelLink, RequestLink, CommitLink } from "@/components/entity-links";
import { RelatedPanel } from "@/components/related";
import { Tabs, pickTab } from "@/components/tabs";
import { Card, EmptyState, Stat, Callout } from "@/components/ui";

export const dynamic = "force-dynamic";
export default async function AgentPage({ params, searchParams }: { params: Promise<{ slug: string; id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const r = getSy();
  if (!r.sy) return <SetupScreen error={r.error} configPath={r.configPath} />;
  const { slug, id } = await params;
  const p = project(r.sy, slug);
  const a = await insights.agentDetail(r.sy, p.slug, decodeURIComponent(id));
  if (!a) notFound();
  const base = projectBase(p.slug);
  const ids = ["tasks", "sessions", "models", "requests", "changes"];
  const tab = pickTab(await searchParams, ids);
  const rows = tab === "tasks" ? a.tasks.map(t => <div key={t.taskId}><TaskLink base={base} id={t.taskId} label={t.label} /> <span className="text-ink-3">{t.state}</span></div>)
    : tab === "sessions" ? a.sessions.map(s => <div key={s.id}><Link className="text-accent-ink hover:underline" href={sessionHref(base, s.id)}>{s.id}</Link> · {s.status} · {dateTime(s.createdAt)}</div>)
    : tab === "models" ? a.models.map(m => <div key={m.endpointId}><ModelLink id={m.endpointId} name={m.servedModel} /> · {m.requests} requests · {m.inputTokens + m.outputTokens} tokens · ${m.costUsd.toFixed(4)}</div>)
    : tab === "requests" ? a.requests.map(q => <div key={q.id}><RequestLink base={base} id={q.id} /> · {q.status} · {q.endpointId ? <ModelLink id={q.endpointId} name={q.servedModel} /> : q.servedModel ?? "Unknown"} · {dateTime(q.reservedAt)}</div>)
    : a.commits.map(c => <div key={`${c.repository}:${c.commit}`}><CommitLink base={base} repository={c.repository} sha={c.commit} /> {c.subject} <span className="text-ink-3">+{c.added} −{c.removed}</span></div>);
  return <div className="space-y-4">
    <PageHeader title={a.agent.label} description={a.agent.role} live={["sessions", "tasks", "requests", "brain"]} back={{ href: `${base}/agents`, label: "Agents" }} />
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-5"><Stat label="Tasks" value={a.totals.tasks} /><Stat label="Sessions" value={a.totals.sessions} /><Stat label="Requests" value={a.totals.requests} /><Stat label="Lines written" value={a.totals.linesAdded} sub={`${a.totals.linesRemoved} removed`} /><Stat label="Cost" value={`$${a.totals.costUsd.toFixed(4)}`} /></div>
    <p className="text-xs text-ink-3">Requests and usage cover the newest 60 session logs. Changes cover up to 200 recent commits across this project's repositories.</p>
    <RelatedPanel groups={[{ label: "Jobs", items: a.jobs.map(j => ({ key: j.jobId, node: <TaskLink base={base} id={j.jobId} label={j.label} job /> })) }, { label: "Supervisors", items: [...new Set(a.jobs.map(j => j.supervisor))].map(id => ({ key: id, node: <AgentLink base={base} agent={id} /> })) }]} />
    <Tabs items={ids.map(id => ({ id, label: id[0]!.toUpperCase() + id.slice(1) }))} active={tab} path={agentHref(base, a.agent.id)!} label="Agent sections" />
    {tab === "changes" && a.commitsErrors.map(e => <Callout key={e} tone="warn">{e}</Callout>)}
    <Card>{rows.length ? <div className="space-y-3 p-4 text-sm break-words">{rows}</div> : <EmptyState title={`No ${tab} recorded`} />}</Card>
  </div>;
}
