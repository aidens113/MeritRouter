import Link from "next/link";
import { notFound } from "next/navigation";
import { insights } from "meritrouter";
import { getSy } from "@/lib/sy";
import { project } from "@/lib/project";
import { brainHref, projectBase } from "@/lib/links";
import { SetupScreen } from "@/components/setup";
import { PageHeader } from "@/components/page-header";
import { RelatedPanel } from "@/components/related";
import { Card, CardHeader } from "@/components/ui";
import { dateTime } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Brain commit" };

export default async function BrainCommitPage({ params, searchParams }: {
  params: Promise<{ slug: string; sha: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const r = getSy();
  if (!r.sy) return <SetupScreen error={r.error} configPath={r.configPath} />;
  const { slug, sha } = await params;
  const p = project(r.sy, slug);
  const path = (await searchParams).path;
  if (typeof path !== "string") notFound();
  const detail = await insights.brainCommitDetail(r.sy, p.slug, path, sha);
  if (!detail) notFound();
  const base = projectBase(p.slug);
  const documentHref = brainHref(base, detail.path);
  return <div className="space-y-6">
    <PageHeader title={`Brain commit ${detail.commit.slice(0, 10)}`} description={`Document changes committed ${dateTime(detail.date)}. This view shows only the selected document.`} />
    <Card>
      <CardHeader title={detail.path} description={<span className="break-all font-mono">{detail.commit}</span>} />
      <pre className="overflow-x-auto p-4 text-xs"><code>{detail.diff}</code></pre>
      {detail.truncated ? <p className="p-4 text-sm text-ink-3">Diff truncated after 200,000 characters.</p> : null}
    </Card>
    <RelatedPanel groups={[
      { label: "Document", items: [{ key: detail.path, node: <Link href={documentHref} className="text-accent-ink hover:underline">{detail.path}</Link> }] },
      { label: "History", items: [{ key: "history", node: <Link href={`${documentHref}&tab=history`} className="text-accent-ink hover:underline">Document history</Link> }] },
      { label: "Project", items: [{ key: p.slug, node: <Link href={base} className="text-accent-ink hover:underline">{p.slug}</Link> }] },
    ]} />
  </div>;
}
