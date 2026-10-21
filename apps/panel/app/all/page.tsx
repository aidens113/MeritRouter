import Link from "next/link";
import { Globe } from "lucide-react";
import { insights } from "switchyard-router";
import { getSy } from "@/lib/sy";
import { projectBase } from "@/lib/links";
import { SetupScreen } from "@/components/setup";
import { Badge, Callout, Card, CardHeader, PageHeader, Stat } from "@/components/ui";
import { AutoRefresh } from "@/components/client/actions";
import { ago, compact, num } from "@/lib/format";
import { usd } from "@/components/job-metrics";

export const dynamic = "force-dynamic";
export const metadata = { title: "All projects" };

/**
 * Placeholder (J2 step 1) for the global dashboard: totals and one row per project from
 * `insights.globalDashboard`. j2-global replaces it with every project's jobs, queues, attention
 * items, and usage and spend by project.
 */
export default async function AllProjectsPage() {
  const r = getSy();
  if (!r.sy) return <SetupScreen error={r.error} configPath={r.configPath} />;
  const d = await insights.globalDashboard(r.sy);
  const now = Date.now();
  return (
    <div className="space-y-6">
      <PageHeader title="All projects" description="Every project on this install at a glance. The pages in the sidebar (models, routing, provider keys, settings) are shared by all projects." actions={<AutoRefresh seconds={10} />} />
      <Callout tone="accent" icon={<Globe size={16} />} title="A fuller dashboard is coming">
        This page will show every project&apos;s running jobs, queues, attention items, and usage and spend by project.
      </Callout>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Jobs running" value={num(d.totals.runningJobs)} sub={`${num(d.totals.queuedJobs)} queued`} />
        <Stat label="Tasks running" value={num(d.totals.runningTasks)} sub={`${num(d.totals.queuedTasks)} queued`} />
        <Stat label="Model requests (24h)" value={compact(d.totals.usage24h.requests)} sub={`${compact(d.totals.usage7d.requests)} in 7 days`} />
        <Stat label="Paid spend (24h)" value={usd(d.totals.usage24h.paidSpendUsd)} sub={`${usd(d.totals.usage7d.paidSpendUsd)} in 7 days`} />
      </div>
      <Card>
        <CardHeader title="Projects" />
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Project</th>
                <th>Jobs</th>
                <th>Tasks</th>
                <th>Requests (24h)</th>
                <th>Attention</th>
                <th>Last activity</th>
              </tr>
            </thead>
            <tbody>
              {d.projects.map((p) => (
                <tr key={p.slug}>
                  <td>
                    <Link href={projectBase(p.slug)} className="font-medium text-accent-ink hover:underline">
                      {p.name}
                    </Link>
                    <div className="font-mono text-[11px] text-ink-3">{p.slug}</div>
                  </td>
                  <td className="tabular text-xs">
                    {p.runningJobs} running · {p.queuedJobs} queued
                  </td>
                  <td className="tabular text-xs">
                    {p.runningTasks} running · {p.queuedTasks} queued
                  </td>
                  <td className="tabular text-xs">{compact(p.usage24h.requests)}</td>
                  <td>{p.attention ? <Badge tone="warn">{p.attention}</Badge> : <span className="text-xs text-ink-3">none</span>}</td>
                  <td className="text-xs text-ink-2">{ago(p.lastActivityAt, now)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
