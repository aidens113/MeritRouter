import type { JobMetrics, JobMetricsSummary } from "../admin/job-metrics.js";
import { WAIT_REASONS } from "../admin/job-metrics.js";
import type { ComparisonPlan, ComparisonRecord, ComparisonRunRecord } from "../qualification/comparison.js";
import { duration, oneLine, plural, table } from "./terminal.js";

// Team metrics and team-vs-single comparisons as terminal text (`meritrouter metrics`,
// `meritrouter compare`).

const ms = (v: number | null) => (v === null ? "-" : duration(v));
const usd = (v: number | null) => (v === null ? "-" : `$${v.toFixed(4)}`);
const pct = (v: number | null) => (v === null ? "-" : `${Math.round(v * 100)}%`);

/** Bars of running agents over time, `width` columns wide (each column is the peak in its slice). */
function sparkline(m: JobMetrics, width = 48): string {
  const pts = m.parallelism.points;
  if (pts.length < 2 || m.parallelism.peak === 0) return "";
  const start = pts[0]!.at;
  const end = pts.at(-1)!.at;
  if (end <= start) return "";
  const glyphs = " ▁▂▃▄▅▆▇█";
  const cols: number[] = [];
  for (let c = 0; c < width; c++) {
    const a = start + ((end - start) * c) / width;
    const b = start + ((end - start) * (c + 1)) / width;
    let peak = 0;
    for (let i = 0; i < pts.length; i++) {
      const from = pts[i]!.at;
      const to = pts[i + 1]?.at ?? end;
      if (to > a && from < b) peak = Math.max(peak, pts[i]!.running);
    }
    cols.push(peak);
  }
  return cols.map((v) => glyphs[Math.round((v / m.parallelism.peak) * (glyphs.length - 1))]).join("");
}

/** `meritrouter metrics <job>`. */
export function metricsText(m: JobMetrics): string {
  const waits = WAIT_REASONS.filter((r) => m.waiting.byReason[r] > 0).map((r) => `${r.replace("_", " ")} ${duration(m.waiting.byReason[r])}`);
  const spark = sparkline(m);
  const lines = [
    `${m.kind === "team" ? "job" : "task"} ${m.jobId}${m.label ? ` (${m.label})` : ""} ${m.state}: ${oneLine(m.goal)}`,
    ...(m.parentJobId ? [`sub-job of ${m.parentJobId}; its tasks also count in the parent's metrics`] : []),
    `wall-clock ${ms(m.wallClockMs)}${m.finishedAt ? "" : m.state === "interrupted" ? " until it was interrupted" : " so far"}; queued ${ms(m.queuedMs)} before it started`,
    `agents ${m.tasks.agents} (${m.tasks.completed} completed, ${m.tasks.failed} failed or cancelled, ${m.tasks.open} open${m.tasks.subJobs ? `; ${plural(m.tasks.subJobs, "sub-job")}` : ""})`,
    `parallelism: peak ${m.parallelism.peak}, mean ${m.parallelism.mean.toFixed(2)} over the wall-clock; busy ${ms(m.parallelism.busyMs)}; agent time ${ms(m.parallelism.agentMs)}`,
    ...(spark ? [`running agents over time (peak ${m.parallelism.peak}): |${spark}|`] : []),
    `critical path (actual, by agent time): ${m.criticalPath.actual.labels.join(" -> ") || "(none)"} ${ms(m.criticalPath.actual.agentMs)}`,
    ...(m.criticalPath.planned ? [`critical path (planned, by estimated cost ${m.criticalPath.planned.cost}): ${m.criticalPath.planned.labels.join(" -> ")}; took ${ms(m.criticalPath.planned.agentMs)} of agent time`] : []),
    `requests ${m.requests} (${Object.entries(m.requestsByPurpose).filter(([, n]) => n > 0).map(([p, n]) => `${p} ${n}`).join(", ") || "none"}${m.failedRequests ? `; ${m.failedRequests} failed` : ""}); ${m.requestsPerCompletedTask ?? "-"} per completed task`,
    `cost ${usd(m.costUsd)}; ${usd(m.costPerCompletedTaskUsd)} per completed task; verification share ${pct(m.verificationShare)} of requests`,
    `waiting ${ms(m.waitingMs)} across ${plural(m.waiting.tasksThatWaited, "task")}${waits.length ? `: ${waits.join(", ")}` : ""}`,
  ];
  if (m.subJobs.length) {
    lines.push("", "sub-jobs:", table(m.subJobs.map(summaryRow)));
  }
  return lines.join("\n");
}

function summaryRow(s: JobMetricsSummary): Record<string, unknown> {
  return {
    job: s.label ?? s.jobId,
    state: s.state,
    "wall-clock": ms(s.wallClockMs),
    peak: s.peakParallelism,
    mean: s.meanParallelism.toFixed(2),
    requests: s.requests,
    "req/task": s.requestsPerCompletedTask ?? "-",
    cost: usd(s.costUsd),
    verification: pct(s.verificationShare),
    waiting: ms(s.waitingMs),
  };
}

/** The plan `meritrouter compare` states before it runs (and all of `--dry-run`). */
export function comparisonPlanText(p: ComparisonPlan): string {
  const rows = p.goals.map((g) => ({ goal: g.id, source: g.source, profile: g.profile, "single cap": g.singleRequests, "team cap": g.teamRequests, repository: g.repository ?? "fixture copy" }));
  return [
    `comparison plan: ${plural(p.goals.length, "goal")}, each run as a team job and as a single agent`,
    table(rows),
    `planned request budget: up to ${p.plannedRequests} requests`,
    `qualification allocation today: ${p.usedToday} of ${p.dailyAllocation} used, ${p.remaining} left -> ${p.fits ? "fits" : "DOES NOT FIT"}`,
    ...p.notes.map((n) => `note: ${n}`),
  ].join("\n");
}

function runCell(r: ComparisonRunRecord): string {
  const flags = [r.stoppedAtCap ? "stopped at cap" : "", r.timedOut ? "timed out" : ""].filter(Boolean).join(", ");
  return `${r.metrics.state}${r.acceptance ? `/${r.acceptance}` : ""}${flags ? ` (${flags})` : ""}`;
}

/** One recorded comparison: per goal, team vs single side by side. */
export function comparisonText(c: ComparisonRecord): string {
  const rows = c.results.flatMap((r) =>
    (["team", "single"] as const).map((k) => {
      const run = r[k];
      return {
        goal: k === "team" ? r.goalId : "",
        run: k,
        outcome: runCell(run),
        "wall-clock": ms(run.metrics.wallClockMs),
        peak: run.metrics.peakParallelism,
        mean: run.metrics.meanParallelism.toFixed(2),
        requests: `${run.metrics.requests}/${run.requestCap}`,
        cost: usd(run.metrics.costUsd),
        "critical path": ms(run.metrics.criticalPathMs),
        task: run.taskId,
      };
    }),
  );
  return [
    `comparison ${c.id} ${c.status}${c.reason ? ` (${c.reason})` : ""}: ${c.results.length} of ${plural(c.goals.length, "goal")} recorded; planned budget ${c.plannedRequests} requests`,
    table(rows),
  ].join("\n");
}

/** `meritrouter compare list`. */
export function comparisonsTable(list: ComparisonRecord[]): string {
  return table(
    list.map((c) => {
      const team = c.results.reduce((s, r) => s + (r.team.metrics.wallClockMs ?? 0), 0);
      const single = c.results.reduce((s, r) => s + (r.single.metrics.wallClockMs ?? 0), 0);
      return {
        comparison: c.id,
        status: c.status,
        goals: `${c.results.length}/${c.goals.length}`,
        "team wall-clock": duration(team),
        "single wall-clock": duration(single),
        "team requests": c.results.reduce((s, r) => s + r.team.metrics.requests, 0),
        "single requests": c.results.reduce((s, r) => s + r.single.metrics.requests, 0),
      };
    }),
  );
}
