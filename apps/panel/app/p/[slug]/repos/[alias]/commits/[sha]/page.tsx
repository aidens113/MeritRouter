import Link from "next/link";
import { notFound } from "next/navigation";
import { insights } from "meritrouter";
import { getSy } from "@/lib/sy";
import { project } from "@/lib/project";
import { projectBase, repoHref } from "@/lib/links";
import { dateTime } from "@/lib/format";
import { SetupScreen } from "@/components/setup";
import { PageHeader } from "@/components/page-header";
import { AgentLink, TaskLink, CommitLink, ModelLink, RequestLink } from "@/components/entity-links";
import { RelatedPanel } from "@/components/related";
import { Disclosure } from "@/components/disclosure";
import { Card, CardHeader, KeyValue } from "@/components/ui";

export const dynamic = "force-dynamic";
export default async function CommitPage({ params }: { params: Promise<{ slug: string; alias: string; sha: string }> }) {
  const r = getSy();
  if (!r.sy) return <SetupScreen error={r.error} configPath={r.configPath} />;
  const { slug, alias, sha } = await params;
  const p = project(r.sy, slug);
  const c = await insights.commitDetail(r.sy, p.slug, alias, sha);
  if (!c) notFound();
  const base = projectBase(p.slug);
  return <div className="space-y-4"><PageHeader title={c.subject} description={c.commit} back={{ href: repoHref(base, alias)!, label: alias }} />
    <Card><div className="p-4"><KeyValue items={[["Author", c.authorName], ["Date", dateTime(c.date)], ["Role", c.role ?? "—"], ["Changes", `${c.files} files · +${c.added} −${c.removed}`], ["Branches", c.branches.join(", ") || "None"]]} />{c.body && <p className="mt-4 whitespace-pre-wrap break-words text-sm">{c.body}</p>}</div></Card>
    <RelatedPanel groups={[
      { label: "Repository", items: [{ key: alias, node: <Link href={repoHref(base, alias)!}>{alias}</Link> }] },
      { label: "Agent", items: c.agent ? [{ key: c.agent, node: <AgentLink base={base} agent={c.agent} /> }] : [] },
      { label: "Task", items: c.task ? [{ key: c.task, node: <TaskLink base={base} id={c.task} /> }] : [] },
      { label: "Job", items: c.job ? [{ key: c.job, node: <TaskLink base={base} id={c.job} job /> }] : [] },
      { label: "Model", items: c.model ? [{ key: c.model, node: <ModelLink id={c.model} /> }] : [] },
      { label: "Request", items: c.request ? [{ key: c.request, node: <RequestLink base={base} id={c.request} /> }] : [] },
      { label: "Parents", items: c.parents.map(sha => ({ key: sha, node: <CommitLink base={base} repository={alias} sha={sha} /> })) },
    ]} />
    <Card><CardHeader title="Files changed" /><ul className="divide-y divide-line">{c.fileStats.map(f => <li key={f.path} className="break-all p-3 text-sm">{f.path} <span className="text-ink-3">{f.added === null ? "Binary" : `+${f.added} −${f.removed}`}</span></li>)}</ul></Card>
    <Disclosure summary="Diff" meta={c.diffTruncated ? "Truncated at 200,000 characters" : undefined}><pre className="overflow-x-auto text-xs">{c.diff || "No diff available."}</pre></Disclosure>
  </div>;
}
