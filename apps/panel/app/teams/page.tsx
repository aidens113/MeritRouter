import Link from "next/link";
import { FlaskConical, UsersRound } from "lucide-react";
import { insights, isTerminal } from "switchyard-router";
import { getSy } from "@/lib/sy";
import { SetupScreen } from "@/components/setup";
import { Badge, Card, CardHeader, EmptyState, Mono, PageHeader, Stat } from "@/components/ui";
import { AutoRefresh } from "@/components/client/actions";
import { JobMetricsCard, MetricsTable, share, usd } from "@/components/job-metrics";
import { AcceptanceBadge, TaskStateBadge } from "@/components/task-badges";
import { dateTime, duration, shortId } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Teams" };

type Run = insights.ComparisonRunRecord;

function RunCells({ run }: { run: Run }) {
  const m = run.metrics;
  return (
    <>
      <td>
        <div className="flex flex-wrap items-center gap-1">
          <TaskStateBadge state={m.state} />
          {run.acceptance ? <AcceptanceBadge status={run.acceptance} /> : null}
          {run.stoppedAtCap ? <Badge tone="warn">stopped at cap</Badge> : null}
          {run.timedOut ? <Badge tone="warn">timed out</Badge> : null}
        </div>
      </td>
      <td className="tabular whitespace-nowrap text-xs">{duration(m.wallClockMs)}</td>
      <td className="tabular text-xs">
        {m.peakParallelism} / {m.meanParallelism.toFixed(2)}
      </td>
      <td className="tabular whitespace-nowrap text-xs">
        {m.requests} <span className="text-ink-3">of {run.requestCap}</span>
      </td>
      <td className="tabular text-xs">{usd(m.costUsd)}</td>
      <td className="tabular whitespace-nowrap text-xs">{duration(m.criticalPathMs)}</td>
      <td className="tabular text-xs">{share(m.verificationShare)}</td>
    </>
  );
}

export default async function TeamsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const r = getSy();
  if (!r.sy) return <SetupScreen error={r.error} configPath={r.configPath} />;
  const sy = r.sy;
  const sp = await searchParams;
  const now = Date.now();
  const rows = insights.teamMetrics(sy, { limit: 100, now });
  const asked = typeof sp.job === "string" ? sp.job : null;
  // The selected job, else the newest job that delegated anything.
  const selectedId = asked && rows.some((x) => x.jobId === asked) ? asked : (rows.find((x) => x.peakParallelism > 0)?.jobId ?? rows[0]?.jobId ?? null);
  const selected = selectedId ? insights.jobMetrics(sy, selectedId, { now }) : null;
  const comparisons = insights.comparisons(sy, { limit: 10 });
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
        actions={live ? <AutoRefresh seconds={5} /> : null}
      />

      {rows.length === 0 ? (
        <Card>
          <EmptyState icon={<UsersRound size={22} />} title="No jobs yet">
            Team metrics appear once a job runs. Start one on the{" "}
            <Link href="/jobs#new" className="text-accent-ink hover:underline">
              Jobs page
            </Link>
            .
          </EmptyState>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Jobs measured" value={top.length} sub={rows.length > top.length ? `${rows.length - top.length} sub-job${rows.length - top.length === 1 ? "" : "s"} too` : "no sub-jobs"} />
            <Stat label="Most agents at once" help="parallelism" value={peak} sub={`team.max_agents ${sy.cfg.team.max_agents ?? sy.cfg.supervisor.max_workers_per_job ?? 8}`} />
            <Stat label="Requests per completed task" value={completed ? (Math.round((requests / completed) * 10) / 10).toString() : "–"} sub={`${requests} requests over ${completed} tasks`} />
            <Stat label="Comparisons" help="comparison" value={comparisons.length} sub={comparisons.length ? `latest ${dateTime(comparisons[0]!.startedAt)}` : "none recorded"} />
          </div>

          <Card>
            <CardHeader title="Jobs" description="Newest first. Pick a job to chart it below; a sub-job's tasks also count in its parent's row." />
            <MetricsTable rows={rows} select selected={selectedId} />
          </Card>

          {selected ? <JobMetricsCard m={selected} title={`Metrics: ${selected.label ?? shortId(selected.jobId, 18)}`} link /> : null}
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
            See the planned request budget with <Mono>switchyard compare --dry-run</Mono>, then run it with <Mono>switchyard compare --yes</Mono>. Nothing runs on its own.
          </EmptyState>
        ) : (
          <div className="divide-y divide-line">
            {comparisons.map((c) => (
              <div key={c.id} className="space-y-3 p-4">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium text-ink">{dateTime(c.startedAt)}</span>
                  <Badge tone={c.status === "finished" ? "good" : c.status === "running" ? "accent" : "serious"}>{c.status}</Badge>
                  <span className="text-xs text-ink-3">
                    {c.results.length} of {c.goals.length} goal{c.goals.length === 1 ? "" : "s"} · planned budget {c.plannedRequests} requests
                    {c.reason ? ` · ${c.reason}` : ""}
                  </span>
                  <Mono>{c.id}</Mono>
                </div>
                {c.results.length ? (
                  <div className="overflow-x-auto">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Goal</th>
                          <th>Run</th>
                          <th>Outcome</th>
                          <th>Wall-clock</th>
                          <th>Peak / mean</th>
                          <th>Requests</th>
                          <th>Cost</th>
                          <th>Critical path</th>
                          <th>Verification</th>
                        </tr>
                      </thead>
                      <tbody>
                        {c.results.flatMap((res) => {
                          const t = res.team.metrics.wallClockMs;
                          const s = res.single.metrics.wallClockMs;
                          const ratio = t && s ? s / t : null;
                          return [
                            <tr key={`${res.goalId}-team`}>
                              <td rowSpan={2} className="max-w-[16rem] align-top">
                                <div className="font-medium text-ink">{res.goalId}</div>
                                <div className="line-clamp-2 text-[11px] text-ink-3" title={res.goal}>
                                  {res.goal}
                                </div>
                                {ratio ? <div className="mt-1 text-[11px] text-ink-2">{ratio >= 1 ? `team ${ratio.toFixed(1)}× faster` : `single ${(1 / ratio).toFixed(1)}× faster`}</div> : null}
                              </td>
                              <td className="whitespace-nowrap text-xs">
                                <Link href={`/teams?job=${encodeURIComponent(res.team.taskId)}#metrics`} className="text-accent-ink hover:underline">
                                  Team
                                </Link>
                              </td>
                              <RunCells run={res.team} />
                            </tr>,
                            <tr key={`${res.goalId}-single`}>
                              <td className="whitespace-nowrap text-xs">
                                <Link href={`/tasks/${encodeURIComponent(res.single.taskId)}`} className="text-accent-ink hover:underline">
                                  Single
                                </Link>
                              </td>
                              <RunCells run={res.single} />
                            </tr>,
                          ];
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-sm text-ink-3">No goal has finished yet.</p>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
