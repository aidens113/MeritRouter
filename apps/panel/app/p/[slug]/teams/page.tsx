import Link from "next/link";
import { FlaskConical, UsersRound } from "lucide-react";
import { insights, isTerminal } from "switchyard-router";
import { getSy } from "@/lib/sy";
import { project, taskProject } from "@/lib/project";
import { projectBase, taskHref } from "@/lib/links";
import { SetupScreen } from "@/components/setup";
import { Card, CardHeader, EmptyState, Mono, Stat } from "@/components/ui";
import { PageHeader } from "@/components/page-header";
import { JobMetricsCard, MetricsTable } from "@/components/job-metrics";
import { ComparisonsList } from "@/components/comparisons";
import { dateTime, shortId } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Teams" };

export default async function TeamsPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const r = getSy();
  if (!r.sy) return <SetupScreen error={r.error} configPath={r.configPath} />;
  const sy = r.sy;
  const p = project(sy, (await params).slug);
  const base = projectBase(p.slug);
  const ctx = sy.projects.get(p.slug)!;
  const sp = await searchParams;
  const now = Date.now();
  const rows = insights.teamMetrics(sy, { limit: 100, now, project: p.slug });
  const asked = typeof sp.job === "string" ? sp.job : null;
  // The selected job, else the newest job that delegated anything.
  const selectedId = asked && rows.some((x) => x.jobId === asked) ? asked : (rows.find((x) => x.peakParallelism > 0)?.jobId ?? rows[0]?.jobId ?? null);
  const selected = selectedId ? insights.jobMetrics(sy, selectedId, { now }) : null;
  // Comparisons are recorded install-wide; show those whose runs belong to this project (one of
  // supplied goals not started yet runs in the primary project). Comparisons on eval goals run in
  // the reserved qualification project and are listed on /all/qualification.
  const comparisons = insights.comparisons(sy, { limit: 10 }).filter((c) => (c.results.length ? c.results.some((x) => taskProject(sy, x.team.taskId) === p.slug || taskProject(sy, x.single.taskId) === p.slug) : p.primary && !c.goals.every((g) => g.source === "eval")));
  const live = rows.some((x) => !isTerminal(x.state) && x.state !== "interrupted") || comparisons.some((c) => c.status === "running");
  const top = rows.filter((x) => !x.parentJobId);
  const peak = Math.max(0, ...rows.map((x) => x.peakParallelism));
  const requests = top.reduce((s, x) => s + x.requests, 0);
  const completed = top.reduce((s, x) => s + x.completedTasks, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Teams"
        description="How jobs ran as teams: how many agents worked at once, what the critical path cost, what each finished task took in requests and money, and why tasks waited. Comparisons run the same goals as a team and as a single agent."
        live={["jobs", "tasks"]}
      />

      {rows.length === 0 ? (
        <Card>
          <EmptyState icon={<UsersRound size={22} />} title="No jobs yet">
            Team metrics appear once a job runs. Start one on the{" "}
            <Link href={`${base}/jobs#new`} className="text-accent-ink hover:underline">
              Jobs page
            </Link>
            .
          </EmptyState>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Jobs measured" value={top.length} sub={rows.length > top.length ? `${rows.length - top.length} sub-job${rows.length - top.length === 1 ? "" : "s"} too` : "no sub-jobs"} />
            <Stat label="Most agents at once" help="parallelism" value={peak} sub={`team.max_agents ${ctx.team.max_agents ?? ctx.supervisor.max_workers_per_job ?? 8}`} />
            <Stat label="Requests per completed task" value={completed ? (Math.round((requests / completed) * 10) / 10).toString() : "–"} sub={`${requests} requests over ${completed} tasks`} />
            <Stat label="Comparisons" help="comparison" value={comparisons.length} sub={comparisons.length ? `latest ${dateTime(comparisons[0]!.startedAt)}` : "none recorded"} />
          </div>

          <Card>
            <CardHeader title="Jobs" description="Newest first. Pick a job to chart it below; a sub-job's tasks also count in its parent's row." />
            <MetricsTable rows={rows} base={base} select selected={selectedId} />
          </Card>

          {selected ? <JobMetricsCard m={selected} base={base} title={`Metrics: ${selected.label ?? shortId(selected.jobId, 18)}`} link /> : null}
        </>
      )}

      <Card id="comparisons">
        <CardHeader
          title="Team vs single agent"
          help="comparison"
          description={
            <>
              The same goals run as a team job and as one agent. Each run has a request cap, and the whole comparison must fit today&apos;s qualification allocation ({sy.cfg.qualification.max_requests_per_day} requests).
            </>
          }
        />
        {comparisons.length === 0 ? (
          <EmptyState icon={<FlaskConical size={22} />} title="No comparisons recorded">
            See the planned request budget with <Mono>switchyard compare --dry-run</Mono>, then run it with <Mono>switchyard compare --yes</Mono>. Nothing runs on its own. Comparisons on evaluation goals are on the{" "}
            <Link href="/all/qualification#comparisons" className="text-accent-ink hover:underline">
              Qualification
            </Link>{" "}
            page.
          </EmptyState>
        ) : (
          <ComparisonsList comparisons={comparisons} teamHref={(id) => `${base}/teams?job=${encodeURIComponent(id)}#metrics`} singleHref={(id) => taskHref(base, id)} />
        )}
      </Card>
    </div>
  );
}
