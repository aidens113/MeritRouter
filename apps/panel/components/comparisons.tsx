import Link from "next/link";
import type { insights } from "switchyard-router";
import { Badge, Mono } from "@/components/ui";
import { share, usd } from "@/components/job-metrics";
import { AcceptanceBadge, TaskStateBadge } from "@/components/task-badges";
import { dateTime, duration } from "@/lib/format";

// Team-vs-single comparisons: a project's Teams page (supplied goals) and the Qualification page
// (eval goals, run in the reserved `_qualification` project) list them the same way.

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

/** Recorded comparisons, each goal's team and single runs side by side; `teamHref` and `singleHref` link a run. */
export function ComparisonsList({ comparisons, teamHref, singleHref }: { comparisons: insights.ComparisonRecord[]; teamHref: (taskId: string) => string; singleHref: (taskId: string) => string }) {
  return (
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
                          <Link href={teamHref(res.team.taskId)} className="text-accent-ink hover:underline">
                            Team
                          </Link>
                        </td>
                        <RunCells run={res.team} />
                      </tr>,
                      <tr key={`${res.goalId}-single`}>
                        <td className="whitespace-nowrap text-xs">
                          <Link href={singleHref(res.single.taskId)} className="text-accent-ink hover:underline">
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
  );
}
