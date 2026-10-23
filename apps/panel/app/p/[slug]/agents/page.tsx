import Link from "next/link";
import { insights } from "meritrouter";
import { getSy } from "@/lib/sy";
import { project } from "@/lib/project";
import { projectBase } from "@/lib/links";
import { ago, dateTime, num } from "@/lib/format";
import { SetupScreen } from "@/components/setup";
import { PageHeader } from "@/components/page-header";
import { AgentLink } from "@/components/entity-links";
import { ROLE_LABEL, roleLabel, SessionStatusBadge } from "@/components/sessions-table";
import { UrlFilters } from "@/components/client/url-filters";
import { Badge, Card, CardHeader, EmptyState, Stat } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Agents" };
const LIMIT = 200;

export default async function AgentsPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const r = getSy();
  if (!r.sy) return <SetupScreen error={r.error} configPath={r.configPath} />;
  const p = project(r.sy, (await params).slug);
  const base = projectBase(p.slug), sp = await searchParams;
  const role = typeof sp.role === "string" ? sp.role.trim() : "";
  const rows = insights.agentsView(r.sy, { project: p.slug, ...(role ? { role } : {}), limit: LIMIT });
  const now = Date.now();
  const running = rows.filter(agent => agent.running > 0).length;
  const liveSessions = rows.reduce((total, agent) => total + agent.running, 0);
  const sessions = rows.reduce((total, agent) => total + agent.sessions, 0);
  const assignments = rows.reduce((total, agent) => total + agent.tasks, 0);
  const roles = [...new Set([...Object.keys(ROLE_LABEL), ...rows.map(agent => agent.role), ...(role ? [role] : [])])].sort();

  return <div className="space-y-4">
    <PageHeader title="Agents" description="Who worked in this project, their activity, and the latest state of their sessions." live={["sessions"]} />
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Stat label="Agents shown" value={num(rows.length)} sub={role ? roleLabel(role) : "All roles"} />
      <Stat label="Running agents" value={num(running)} sub={`${num(liveSessions)} live sessions`} tone={running ? "good" : undefined} />
      <Stat label="Sessions" value={num(sessions)} sub="Across the listed agents" />
      <Stat label="Task assignments" value={num(assignments)} sub="Distinct tasks per listed agent" />
    </div>
    <Card>
      <CardHeader title="Agents in this project" description={`Most recently active first. Up to ${LIMIT} agents matching the role filter.`} />
      <div className="border-b border-line px-4 py-3"><UrlFilters values={{ role }} fields={[{ name: "role", label: "Role", kind: "select", anyLabel: "All roles", options: roles.map(value => [value, roleLabel(value)] as [string, string]) }]} /></div>
      {rows.length ? <div className="overflow-x-auto"><table className="data-table tabular">
        <thead><tr><th>Agent</th><th>Role</th><th>Activity</th><th className="text-right">Tasks</th><th className="text-right">Sessions</th><th>First seen</th><th>Last active</th></tr></thead>
        <tbody>{rows.map(agent => <tr key={agent.id}>
          <td className="min-w-[12rem] max-w-[22rem]"><AgentLink base={base} agent={agent.id}><span className="break-all text-sm font-medium">{agent.label}</span></AgentLink><div className="mt-1 break-all font-mono text-[11px] text-ink-3">{agent.id}</div></td>
          <td className="whitespace-nowrap"><Badge>{roleLabel(agent.role)}</Badge></td>
          <td className="whitespace-nowrap">{agent.running > 0 ? <div className="space-y-1"><Badge tone="good">{num(agent.running)} running</Badge>{agent.lastStatus !== "running" ? <div className="flex items-center gap-1 text-[11px] text-ink-3">Latest <SessionStatusBadge status={agent.lastStatus} /></div> : null}</div> : <SessionStatusBadge status={agent.lastStatus} />}</td>
          <td className="text-right">{num(agent.tasks)}</td><td className="text-right">{num(agent.sessions)}</td>
          <td className="whitespace-nowrap"><time dateTime={new Date(agent.firstAt).toISOString()} title={dateTime(agent.firstAt)}>{ago(agent.firstAt, now)}</time><div className="text-[11px] text-ink-3">{dateTime(agent.firstAt)}</div></td>
          <td className="whitespace-nowrap"><time dateTime={new Date(agent.lastAt).toISOString()} title={dateTime(agent.lastAt)}>{ago(agent.lastAt, now)}</time><div className="text-[11px] text-ink-3">{dateTime(agent.lastAt)}</div></td>
        </tr>)}</tbody>
      </table></div> : <EmptyState title={role ? "No agents match this role" : "No agents yet"} action={role ? <Link href={`${base}/agents`} className="text-sm text-accent-ink hover:underline">Show all roles</Link> : <Link href={`${base}/jobs#new`} className="text-sm text-accent-ink hover:underline">Start a job</Link>}>Agents appear when a supervisor or worker starts a session in this project.</EmptyState>}
    </Card>
  </div>;
}
