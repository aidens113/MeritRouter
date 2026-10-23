import Link from "next/link";
import { notFound } from "next/navigation";
import { insights } from "meritrouter";
import { getSy } from "@/lib/sy";
import { project } from "@/lib/project";
import { projectBase, repoHref } from "@/lib/links";
import { dateTime } from "@/lib/format";
import { SetupScreen } from "@/components/setup";
import { PageHeader } from "@/components/page-header";
import { AgentLink, TaskLink, CommitLink } from "@/components/entity-links";
import { RelatedPanel } from "@/components/related";
import { Disclosure } from "@/components/disclosure";
import { Card, CardHeader, EmptyState, KeyValue, Callout } from "@/components/ui";

export const dynamic = "force-dynamic";
export default async function RepositoryPage({ params }: { params: Promise<{ slug: string; alias: string }> }) {
  const r = getSy();
  if (!r.sy) return <SetupScreen error={r.error} configPath={r.configPath} />;
  const { slug, alias } = await params;
  const p = project(r.sy, slug);
  const repo = await insights.repositoryView(r.sy, p.slug, alias);
  if (!repo) notFound();
  const base = projectBase(p.slug);
  const branches = [...repo.branches].sort((a, b) => Number(b.name.startsWith("meritrouter/")) - Number(a.name.startsWith("meritrouter/")) || b.date.localeCompare(a.date));
  const commits = repo.commits.map(c => <li key={c.commit} className="space-y-1 p-3 text-sm"><CommitLink base={base} repository={alias} sha={c.commit} /> {c.subject}<div className="flex flex-wrap gap-2 text-xs text-ink-3">{dateTime(c.date)} · +{c.added} −{c.removed} {c.agent && <AgentLink base={base} agent={c.agent} />} {c.task && <TaskLink base={base} id={c.task} />} {c.job && <TaskLink base={base} id={c.job} job />}</div></li>);
  return <div className="space-y-4"><PageHeader title={alias} description={repo.path} back={{ href: `${base}/repos`, label: "Repositories" }} live={["tasks", "brain"]} />
    {!repo.exists && <Callout tone="warn">This repository's directory does not exist.</Callout>}{repo.error && <Callout tone="warn">{repo.error}</Callout>}
    <Card><div className="p-4"><KeyValue items={[["Access", repo.writable ? "Writable" : "Read only"], ["Branch", repo.branch ?? "Unknown"], ["Head", repo.head ? <CommitLink base={base} repository={alias} sha={repo.head} /> : "No commits"]]} /></div></Card>
    <RelatedPanel groups={[{ label: "Project", items: [{ key: p.slug, node: <Link href={base}>{p.name}</Link> }] }]} />
    <Card><CardHeader title="Recent commits" />{commits.length ? <><ul className="divide-y divide-line">{commits.slice(0, 10)}</ul>{commits.length > 10 && <Disclosure summary={`Show ${commits.length - 10} more commits`}><ul className="divide-y divide-line">{commits.slice(10)}</ul></Disclosure>}</> : <EmptyState title="No commits found" />}</Card>
    <Disclosure summary="Branches" meta={branches.length}><ul className="space-y-2 text-sm">{branches.map(b => <li key={b.name} className="break-words">{b.name} · <CommitLink base={base} repository={alias} sha={b.commit} /> · {dateTime(b.date)} · {b.subject}</li>)}</ul></Disclosure>
  </div>;
}
