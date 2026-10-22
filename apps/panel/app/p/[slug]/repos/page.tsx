import Link from "next/link";
import { getSy } from "@/lib/sy";
import { project } from "@/lib/project";
import { projectBase, repoHref } from "@/lib/links";
import { SetupScreen } from "@/components/setup";
import { PageHeader } from "@/components/page-header";
import { Card, EmptyState, Badge } from "@/components/ui";

export const dynamic = "force-dynamic";
export default async function RepositoriesPage({ params }: { params: Promise<{ slug: string }> }) {
  const r = getSy();
  if (!r.sy) return <SetupScreen error={r.error} configPath={r.configPath} />;
  const p = project(r.sy, (await params).slug);
  return <div className="space-y-4"><PageHeader title="Repositories" description="Code available to this project's agents." />
    <Card>{p.repositories.length ? <ul className="divide-y divide-line">{p.repositories.map(repo => <li key={repo.alias} className="p-4"><Link className="text-accent-ink hover:underline" href={repoHref(projectBase(p.slug), repo.alias)!}>{repo.alias}</Link> <Badge>{repo.writable ? "Writable" : "Read only"}</Badge><p className="mt-1 break-all text-xs text-ink-3">{repo.path}</p></li>)}</ul> : <EmptyState title="No repositories" />}</Card>
  </div>;
}
