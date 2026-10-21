import Link from "next/link";
import { Gauge } from "lucide-react";
import type { insights } from "switchyard-router";
import { Card, CardHeader, EmptyState, HelpTip, Stat } from "@/components/ui";
import { StackedBars, StepChart } from "@/components/client/charts";
import { TaskStateBadge } from "@/components/task-badges";
import { duration, humanize, shortId } from "@/lib/format";
import { jobHref, taskHref } from "@/lib/links";

// Team metrics for one job (or one agent's task): wall-clock, parallelism over time, critical
// paths, requests and cost per completed task, verification share, and waiting time by reason.

type Metrics = insights.JobMetrics;

const WAIT_LABEL: Record<string, string> = {
  dependencies: "Dependencies",
  acceptance: "Acceptance",
  file_lease: "File lease",
  provider_slot: "Provider slot",
  capacity: "Capacity",
  queue: "Queue",
  interrupted: "Interrupted",
};

export const usd = (v: number | null) => (v === null ? "–" : v === 0 ? "$0" : v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);
export const share = (v: number | null) => (v === null ? "–" : `${Math.round(v * 100)}%`);

export function ParallelismChart({ m, height = 200 }: { m: Metrics; height?: number }) {
  const pts = m.parallelism.points;
  if (pts.length < 2) return <p className="text-sm text-ink-3">Not started yet: the chart appears once the job runs.</p>;
  return (
    <StepChart
      points={pts.map((p) => ({ at: p.at, values: [p.running, p.waiting] }))}
      series={[
        { key: "running", label: "Agents running", color: "var(--series-1)" },
        { key: "waiting", label: "Tasks waiting", color: "var(--series-2)" },
      ]}
      start={pts[0]!.at}
      end={pts.at(-1)!.at}
      height={height}
    />
  );
}

/** `base` is the project path (`/p/<slug>`) links start from. */
export function JobMetricsCard({ m, base, title = "Team metrics", link = false }: { m: Metrics; base: string; title?: string; link?: boolean }) {
  // Seconds with one decimal; waits under a twentieth of a second round to nothing and are left out.
  const reasons = Object.entries(m.waiting.byReason).filter(([, v]) => v >= 50);
  const purposes = Object.entries(m.requestsByPurpose).filter(([, n]) => n > 0);
  const cp = m.criticalPath;
  return (
    <Card id="metrics">
      <CardHeader
        title={title}
        help="parallelism"
        description={
          <>
            Derived from the job&apos;s task events, plan, and request ledger{m.kind === "team" ? "; sub-jobs and their tasks count here too" : "; one agent"}.{" "}
            {link ? (
              <Link href={jobHref(base, m.jobId)} className="text-accent-ink hover:underline">
                Open the job →
              </Link>
            ) : null}
          </>
        }
      />
      <div className="space-y-5 p-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 2xl:grid-cols-6">
          <Stat label="Wall-clock" value={duration(m.wallClockMs)} sub={m.finishedAt ? `queued ${duration(m.queuedMs)} first` : m.state === "interrupted" ? "until it was interrupted" : "so far"} />
          <Stat label="Parallelism" help="parallelism" value={`${m.parallelism.peak} peak`} sub={`mean ${m.parallelism.mean.toFixed(2)} · ${m.tasks.agents} agent${m.tasks.agents === 1 ? "" : "s"}`} />
          <Stat label="Critical path" help="criticalPath" value={duration(cp.actual.agentMs)} sub={cp.actual.labels.length ? `actual: ${cp.actual.labels.join(" → ")}` : "no tasks yet"} />
          <Stat label="Requests per task" value={m.requestsPerCompletedTask ?? "–"} sub={`${m.requests} request${m.requests === 1 ? "" : "s"} · ${m.completedTasks} completed`} />
          <Stat label="Cost per task" value={usd(m.costPerCompletedTaskUsd)} sub={`${usd(m.costUsd)} in all`} />
          <Stat label="Verification share" value={share(m.verificationShare)} sub={purposes.map(([p, n]) => `${p} ${n}`).join(" · ") || "no requests"} />
        </div>

        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-3">Agents over time</h3>
          <ParallelismChart m={m} />
          <p className="mt-2 text-xs text-ink-3">
            Busy {duration(m.parallelism.busyMs)} of {duration(m.wallClockMs)}; {duration(m.parallelism.agentMs)} of agent time in all.
            {cp.planned ? (
              <>
                {" "}
                Planned critical path {cp.planned.labels.join(" → ")} (estimated cost {cp.planned.cost}) took {duration(cp.planned.agentMs)}.
              </>
            ) : null}
          </p>
        </div>

        <div className="grid gap-5 lg:grid-cols-2">
          <div className="min-w-0">
            <h3 className="mb-2 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-ink-3">
              Waiting time by reason, seconds <HelpTip term="waitReason" />
            </h3>
            {reasons.length ? (
              <StackedBars rows={reasons.map(([r]) => ({ key: r, label: WAIT_LABEL[r] ?? humanize(r) }))} series={[{ key: "seconds", label: "Seconds waiting", color: "var(--series-1)", values: reasons.map(([, v]) => Math.round(v / 100) / 10) }]} unit="seconds" />
            ) : (
              <p className="text-sm text-ink-3">{m.waitingMs ? `Tasks waited only moments (${duration(m.waitingMs)} in all).` : "No task waited."}</p>
            )}
          </div>
          <div className="min-w-0">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-3">Agents</h3>
            {m.agents.length ? (
              <div className="max-h-72 overflow-auto rounded-lg border border-line">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Task</th>
                      <th>State</th>
                      <th>Running</th>
                      <th>Waited</th>
                    </tr>
                  </thead>
                  <tbody>
                    {m.agents.map((a) => {
                      const ran = a.runs.reduce((s, r) => s + r.end - r.start, 0);
                      const byReason = new Map<string, number>();
                      for (const w of a.waits) byReason.set(w.reason, (byReason.get(w.reason) ?? 0) + w.end - w.start);
                      const top = [...byReason.entries()].sort((x, y) => y[1] - x[1])[0];
                      return (
                        <tr key={a.taskId}>
                          <td className="max-w-[12rem]">
                            <Link href={a.profile === "supervise" ? jobHref(base, a.taskId) : taskHref(base, a.taskId)} className="block truncate text-accent-ink hover:underline" title={a.taskId}>
                              {a.label ?? shortId(a.taskId, 16)}
                            </Link>
                            <div className="text-[11px] text-ink-3">{a.profile}</div>
                          </td>
                          <td>
                            <TaskStateBadge state={a.state} />
                          </td>
                          <td className="tabular whitespace-nowrap text-xs">
                            {duration(ran)}
                            {a.runs.length > 1 ? <span className="text-ink-3"> · {a.runs.length} runs</span> : null}
                          </td>
                          <td className="tabular whitespace-nowrap text-xs">{top ? `${duration(top[1])} ${(WAIT_LABEL[top[0]] ?? top[0]).toLowerCase()}` : "–"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState icon={<Gauge size={20} />} title="No agents yet">
                Agents appear when the supervisor delegates.
              </EmptyState>
            )}
          </div>
        </div>

        {m.subJobs.length ? (
          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-3">Sub-jobs</h3>
            <MetricsTable rows={m.subJobs} base={base} />
          </div>
        ) : null}
      </div>
    </Card>
  );
}

/** Metric summaries, one row per job; `select` links rows to `<base>/teams?job=<id>`. */
export function MetricsTable({ rows, base, select, selected }: { rows: insights.JobMetricsSummary[]; base: string; select?: boolean; selected?: string | null }) {
  return (
    <div className="overflow-x-auto">
      <table className="data-table">
        <thead>
          <tr>
            <th>Job</th>
            <th>State</th>
            <th>Wall-clock</th>
            <th>Peak</th>
            <th>Mean</th>
            <th>Requests / task</th>
            <th>Cost</th>
            <th>Verification</th>
            <th>Waiting</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.jobId} className={selected === s.jobId ? "bg-accent-soft" : undefined}>
              <td className="max-w-[16rem]">
                <Link href={select ? `${base}/teams?job=${encodeURIComponent(s.jobId)}#metrics` : jobHref(base, s.jobId)} className="block truncate font-medium text-accent-ink hover:underline" title={s.goal}>
                  {s.label ?? shortId(s.jobId, 18)}
                </Link>
                <div className="truncate text-[11px] text-ink-3">{s.parentJobId ? `sub-job of ${shortId(s.parentJobId, 14)}` : s.goal}</div>
              </td>
              <td>
                <TaskStateBadge state={s.state} />
              </td>
              <td className="tabular whitespace-nowrap text-xs">{duration(s.wallClockMs)}</td>
              <td className="tabular text-xs">{s.peakParallelism}</td>
              <td className="tabular text-xs">{s.meanParallelism.toFixed(2)}</td>
              <td className="tabular text-xs">
                {s.requestsPerCompletedTask ?? "–"} <span className="text-ink-3">({s.requests})</span>
              </td>
              <td className="tabular text-xs">{usd(s.costUsd)}</td>
              <td className="tabular text-xs">{share(s.verificationShare)}</td>
              <td className="tabular whitespace-nowrap text-xs">{duration(s.waitingMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
