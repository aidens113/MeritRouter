import { insights } from "switchyard-router";
import { getSy } from "@/lib/sy";
import { project } from "@/lib/project";
import { projectBase } from "@/lib/links";
import { dateTime } from "@/lib/format";
import { SetupScreen } from "@/components/setup";
import { PageHeader } from "@/components/page-header";
import { AgentLink } from "@/components/entity-links";
import { Card, EmptyState } from "@/components/ui";

export const dynamic = "force-dynamic";
export default async function AgentsPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const r = getSy();
  if (!r.sy) return <SetupScreen error={r.error} configPath={r.configPath} />;
  const p = project(r.sy, (await params).slug);
  const sp = await searchParams;
  const role = typeof sp.role === "string" ? sp.role : undefined;
  const rows = insights.agentsView(r.sy, { project: p.slug, role });
  return <div className="space-y-4">
    <PageHeader title="Agents" description="The agents that worked in this project." live={["sessions"]} />
    <form className="flex gap-2"><label>Role <input name="role" defaultValue={role} className="rounded border border-line bg-surface px-2 py-1" placeholder="All roles" /></label><button type="submit">Filter</button></form>
    <Card>{rows.length ? <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr>{["Agent", "Tasks", "Sessions", "Last active", "Status"].map(x => <th key={x} className="p-3">{x}</th>)}</tr></thead><tbody>{rows.map(a => <tr key={a.id} className="border-t border-line"><td className="p-3"><AgentLink base={projectBase(p.slug)} agent={a.id} /></td><td className="p-3">{a.tasks}</td><td className="p-3">{a.sessions}</td><td className="p-3">{dateTime(a.lastAt)}</td><td className="p-3">{a.lastStatus}</td></tr>)}</tbody></table></div> : <EmptyState title="No agents found" />}</Card>
  </div>;
}
