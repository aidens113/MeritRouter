import { z } from "zod";
import { purposeCategory, REQUEST_PURPOSES, type RequestPurpose } from "../admission/admission.js";
import type { Switchyard } from "../core/service.js";
import type { TaskState } from "../core/task.js";
import { criticalPath as plannedPath, PlanStore } from "../storage/plans.js";
import { WAITING_FOR_FILE_LEASE, type StoredTask } from "../storage/tasks.js";

// Team metrics, derived from stored data (task events, plans, and the request ledger); nothing
// is sampled. For a job (a supervise task) they cover every task under it, sub-jobs included;
// for any other task they describe that one agent, so a team run and a single-agent run of the
// same goal compare on the same terms.

/** Why a task was not running. `queue`: ready, waiting for a worker or the job's agent cap (the scheduler records no reason for those). */
export const WAIT_REASONS = ["dependencies", "acceptance", "file_lease", "provider_slot", "capacity", "queue", "interrupted"] as const;
export type WaitReason = (typeof WAIT_REASONS)[number];

/** Task event (and state_reason prefix) of a queued task held for a free provider slot (T3 capacity). */
import { WAITING_FOR_PROVIDER_SLOT } from "../storage/tasks.js";
export { WAITING_FOR_PROVIDER_SLOT };

const TERMINAL_EVENTS: ReadonlySet<string> = new Set(["completed", "failed", "cancelled", "budget_exhausted"]);
const FAILED_STATES: ReadonlySet<string> = new Set(["failed", "cancelled", "budget_exhausted"]);

/** From `at` until the next point: agents running and tasks waiting. */
export interface ParallelismPoint {
  at: number;
  running: number;
  waiting: number;
}

export interface Interval {
  start: number;
  end: number;
}

export interface WaitInterval extends Interval {
  reason: WaitReason;
}

/** One agent's run intervals and waits (the timeline the metrics are computed from). */
export interface AgentTimeline {
  taskId: string;
  label: string | null;
  profile: string;
  state: TaskState;
  runs: Interval[];
  waits: WaitInterval[];
}

export interface JobMetricsSummary {
  jobId: string;
  label: string | null;
  goal: string;
  state: TaskState;
  /** `team`: a supervise task and everything under it; `single`: one agent's task. */
  kind: "team" | "single";
  parentJobId: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** First start to finish (or now while it runs); null before it starts. */
  wallClockMs: number | null;
  peakParallelism: number;
  meanParallelism: number;
  requests: number;
  costUsd: number;
  completedTasks: number;
  requestsPerCompletedTask: number | null;
  verificationShare: number | null;
  waitingMs: number;
}

export interface JobMetrics extends JobMetricsSummary {
  /** When the metrics were computed (open intervals end here). */
  computedAt: number;
  /** Submission to first start. */
  queuedMs: number | null;
  tasks: { agents: number; completed: number; failed: number; open: number; subJobs: number };
  parallelism: {
    points: ParallelismPoint[];
    peak: number;
    /** Time-weighted mean of running agents over the wall-clock span. */
    mean: number;
    /** Time with at least one agent running. */
    busyMs: number;
    /** Sum of every agent's running time. */
    agentMs: number;
  };
  criticalPath: {
    /** The latest plan's critical path by estimated cost, and the agent time its nodes took; null without a plan. */
    planned: { labels: string[]; cost: number; agentMs: number } | null;
    /** The longest dependency chain of the job's direct tasks by actual running time. */
    actual: { labels: string[]; agentMs: number };
  };
  requestsByPurpose: Record<RequestPurpose, number>;
  failedRequests: number;
  costPerCompletedTaskUsd: number | null;
  waiting: { byReason: Record<WaitReason, number>; tasksThatWaited: number };
  agents: AgentTimeline[];
  subJobs: JobMetricsSummary[];
}

const EventRow = z.object({ task_id: z.string(), ts: z.number(), type: z.string(), data_json: z.string().nullable() });
const SubmittedData = z.object({ state: z.string() }).partial().nullable();
const RequestRow = z.object({ purpose: z.string(), status: z.string(), cost: z.number().nullable() });

function chunks<T>(xs: T[], n = 400): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** The task and every task under it (sub-jobs' tasks included), root first. */
function treeOf(sy: Switchyard, root: StoredTask): StoredTask[] {
  const all = [root];
  let level = [root];
  for (let depth = 0; depth < 8 && level.length; depth++) {
    level = level.filter((t) => t.spec.profile === "supervise").flatMap((t) => sy.tasks.childrenOf(t.row.id));
    all.push(...level);
  }
  return all;
}

function eventsByTask(sy: Switchyard, ids: string[]): Map<string, Array<{ ts: number; type: string; data: string | null }>> {
  const out = new Map<string, Array<{ ts: number; type: string; data: string | null }>>();
  for (const part of chunks(ids)) {
    const rows = sy.db.prepare(`SELECT task_id, ts, type, data_json FROM events WHERE task_id IN (${part.map(() => "?").join(",")}) ORDER BY id`).all(...part);
    for (const raw of rows) {
      const r = EventRow.safeParse(raw);
      if (!r.success) continue;
      const list = out.get(r.data.task_id) ?? [];
      list.push({ ts: r.data.ts, type: r.data.type, data: r.data.data_json });
      out.set(r.data.task_id, list);
    }
  }
  return out;
}

/**
 * Replay a task's events into run intervals and waits. Running starts at `claimed`; it ends at
 * a terminal event, `interrupted`, or `waiting_for_capacity`. A wait's reason follows the
 * events that explain it (dependencies, acceptance, a file lease, a provider slot, capacity).
 */
export function agentTimeline(t: StoredTask, events: Array<{ ts: number; type: string; data: string | null }>, now: number): AgentTimeline {
  const runs: Interval[] = [];
  const waits: WaitInterval[] = [];
  let mode: { kind: "run"; since: number } | { kind: "wait"; reason: WaitReason; since: number } | null = null;
  const close = (at: number) => {
    if (mode?.kind === "run") runs.push({ start: mode.since, end: Math.max(mode.since, at) });
    else if (mode?.kind === "wait" && at > mode.since) waits.push({ reason: mode.reason, start: mode.since, end: at });
    mode = null;
  };
  const wait = (reason: WaitReason, at: number) => {
    close(at);
    mode = { kind: "wait", reason, since: at };
  };
  /** A reason change while waiting (no effect while running). */
  const because = (reason: WaitReason, at: number) => {
    if (mode?.kind === "wait" && mode.reason !== reason) wait(reason, at);
  };
  if (!events.some((e) => e.type === "submitted")) wait("queue", t.row.created_at);
  for (const e of events) {
    switch (e.type) {
      case "submitted": {
        const d = SubmittedData.safeParse(e.data ? JSON.parse(e.data) : null);
        wait(d.success && d.data?.state === "waiting_for_dependencies" ? "dependencies" : "queue", e.ts);
        break;
      }
      case "dependency_awaiting_acceptance":
        because("acceptance", e.ts);
        break;
      case "dependencies_satisfied":
        because("queue", e.ts);
        break;
      case WAITING_FOR_FILE_LEASE:
        because("file_lease", e.ts);
        break;
      case WAITING_FOR_PROVIDER_SLOT:
        because("provider_slot", e.ts);
        break;
      case "waiting_for_capacity":
        wait("capacity", e.ts);
        break;
      case "claimed":
        close(e.ts);
        mode = { kind: "run", since: e.ts };
        break;
      case "interrupted":
        wait("interrupted", e.ts);
        break;
      case "resumed":
        wait("queue", e.ts);
        break;
      default:
        if (TERMINAL_EVENTS.has(e.type)) close(e.ts);
    }
  }
  // A ready task held for a provider slot may carry only the state reason (set when it changed).
  const open = mode as { kind: "run"; since: number } | { kind: "wait"; reason: WaitReason; since: number } | null;
  if (open?.kind === "wait" && open.reason === "queue" && t.row.state_reason?.startsWith(WAITING_FOR_PROVIDER_SLOT)) because("provider_slot", Math.max(open.since, Math.min(now, t.row.updated_at)));
  close(t.row.finished_at ?? now);
  return { taskId: t.row.id, label: t.spec.label ?? null, profile: t.spec.profile, state: t.row.state, runs, waits };
}

/** Cut a timeline at `end` (a task under a finished or stalled job). */
function clip(t: AgentTimeline, end: number): AgentTimeline {
  const cut = <T extends Interval>(xs: T[]) => xs.filter((i) => i.start < end || (i.start === end && i.end === end)).map((i) => ({ ...i, end: Math.min(i.end, end) }));
  return { ...t, runs: cut(t.runs), waits: cut(t.waits).filter((w) => w.end > w.start) };
}

const sum = (xs: Interval[]) => xs.reduce((s, i) => s + (i.end - i.start), 0);

/** Running and waiting counts over time, as change points (value holds until the next point). */
export function parallelismSeries(agents: AgentTimeline[], span: Interval): ParallelismPoint[] {
  const deltas = new Map<number, { running: number; waiting: number }>();
  const add = (at: number, key: "running" | "waiting", d: number) => {
    const v = deltas.get(at) ?? { running: 0, waiting: 0 };
    v[key] += d;
    deltas.set(at, v);
  };
  for (const a of agents) {
    for (const r of a.runs) if (r.end > r.start) (add(r.start, "running", 1), add(r.end, "running", -1));
    for (const w of a.waits) (add(w.start, "waiting", 1), add(w.end, "waiting", -1));
  }
  const points: ParallelismPoint[] = [{ at: span.start, running: 0, waiting: 0 }];
  let running = 0;
  let waiting = 0;
  for (const at of [...deltas.keys()].sort((a, b) => a - b)) {
    const d = deltas.get(at)!;
    running += d.running;
    waiting += d.waiting;
    const p = { at: Math.max(at, span.start), running, waiting };
    const last = points.at(-1)!;
    if (last.at === p.at) Object.assign(last, p);
    else if (last.running !== p.running || last.waiting !== p.waiting) points.push(p);
  }
  if (points.at(-1)!.at < span.end) points.push({ at: span.end, running, waiting });
  return points;
}

/** Peak, time-weighted mean over `span`, and busy time of a series from `parallelismSeries`. */
export function seriesStats(points: ParallelismPoint[], span: Interval): { peak: number; mean: number; busyMs: number } {
  let area = 0;
  let busy = 0;
  let peak = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const end = Math.min(points[i + 1]?.at ?? span.end, span.end);
    const dt = Math.max(0, end - Math.max(p.at, span.start));
    area += p.running * dt;
    if (p.running > 0) busy += dt;
    if (dt > 0 || i === points.length - 1) peak = Math.max(peak, p.running);
  }
  const width = span.end - span.start;
  return { peak, mean: width > 0 ? Math.round((area / width) * 100) / 100 : 0, busyMs: busy };
}

/** The longest chain of `nodes` along `dependsOn` by agent time. */
export function longestChain(nodes: Array<{ id: string; label: string; agentMs: number; dependsOn: string[] }>): { labels: string[]; agentMs: number } {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const best = new Map<string, { ms: number; via: string | null }>();
  const solve = (id: string, guard: Set<string>): number => {
    const known = best.get(id);
    if (known) return known.ms;
    const n = byId.get(id)!;
    let via: string | null = null;
    let up = 0;
    for (const d of n.dependsOn) {
      if (!byId.has(d) || guard.has(d)) continue;
      const ms = solve(d, new Set([...guard, id]));
      if (ms > up) (up = ms, via = d);
    }
    best.set(id, { ms: up + n.agentMs, via });
    return up + n.agentMs;
  };
  let end: string | null = null;
  for (const n of nodes) {
    const ms = solve(n.id, new Set());
    if (end === null || ms > best.get(end)!.ms) end = n.id;
  }
  if (end === null) return { labels: [], agentMs: 0 };
  const labels: string[] = [];
  for (let at: string | null = end; at; at = best.get(at)!.via) labels.unshift(byId.get(at)!.label);
  return { labels, agentMs: best.get(end)!.ms };
}

function requestTotals(sy: Switchyard, taskIds: string[]): { total: number; failed: number; costUsd: number; byPurpose: Record<RequestPurpose, number> } {
  const byPurpose = Object.fromEntries(REQUEST_PURPOSES.map((p) => [p, 0])) as Record<RequestPurpose, number>;
  const seen = new Set<string>();
  let failed = 0;
  let costUsd = 0;
  for (const part of chunks(taskIds)) {
    const rows = sy.db
      .prepare(
        `SELECT r.id AS id, r.purpose AS purpose, r.status AS status, COALESCE(r.reported_cost_usd, r.estimated_cost_usd) AS cost
           FROM model_requests r WHERE r.id IN (SELECT request_id FROM request_charges WHERE task_id IN (${part.map(() => "?").join(",")}))`,
      )
      .all(...part) as Array<{ id: string }>;
    for (const raw of rows) {
      if (seen.has(raw.id)) continue;
      const r = RequestRow.safeParse(raw);
      if (!r.success) continue;
      seen.add(raw.id);
      byPurpose[purposeCategory(r.data.purpose)]++;
      if (r.data.status === "failed") failed++;
      costUsd += r.data.cost ?? 0;
    }
  }
  return { total: seen.size, failed, costUsd: Math.round(costUsd * 1e6) / 1e6, byPurpose };
}

/** Metrics for a job and everything under it, or for one agent's task; null for an unknown id. */
export function jobMetrics(sy: Switchyard, id: string, opts: { now?: number } = {}): JobMetrics | null {
  const root = sy.tasks.get(id);
  if (!root) return null;
  const now = opts.now ?? Date.now();
  const team = root.spec.profile === "supervise";
  const tree = treeOf(sy, root);
  const events = eventsByTask(sy, tree.map((t) => t.row.id));
  // Open intervals end now, or where the run stopped: a finished task's finish, or an interrupted
  // root's last event (an interrupted job is stalled, not running, until it is resumed).
  const horizon = root.row.finished_at ?? (root.row.state === "interrupted" ? Math.min(now, events.get(root.row.id)?.at(-1)?.ts ?? now) : now);
  const timelines = new Map(tree.map((t) => [t.row.id, clip(agentTimeline(t, events.get(t.row.id) ?? [], horizon), horizon)]));
  // A team's agents are the tasks under its supervisor; a single run's agent is the task itself.
  const agentTasks = team ? tree.slice(1) : [root];
  const agents = agentTasks.map((t) => timelines.get(t.row.id)!);
  const rootRuns = timelines.get(root.row.id)!.runs;
  const startedAt = rootRuns[0]?.start ?? root.row.started_at;
  const finishedAt = root.row.finished_at;
  const span = { start: startedAt ?? root.row.created_at, end: Math.max(startedAt ?? root.row.created_at, horizon) };
  const points = parallelismSeries(agents, span);
  const stats = seriesStats(points, span);

  // Critical path: the job's direct tasks along their dependencies (a sub-job counts as one node).
  const direct = team ? tree.filter((t) => t.spec.parentTaskId === root.row.id) : [root];
  const directIds = new Set(direct.map((t) => t.row.id));
  const agentMsOf = (taskId: string) => sum(timelines.get(taskId)?.runs ?? []);
  const actual = longestChain(direct.map((t) => ({ id: t.row.id, label: t.spec.label ?? t.row.id, agentMs: agentMsOf(t.row.id), dependsOn: sy.tasks.dependenciesOf(t.row.id).filter((d) => directIds.has(d)) })));
  const plan = team ? new PlanStore(sy.db).latest(root.row.id) : null;
  let planned: JobMetrics["criticalPath"]["planned"] = null;
  if (plan) {
    const cp = plannedPath(plan.nodes);
    const byLabel = new Map(direct.filter((t) => t.spec.label).map((t) => [t.spec.label!, t.row.id]));
    planned = { labels: cp.labels, cost: cp.cost, agentMs: cp.labels.reduce((s, l) => s + (byLabel.has(l) ? agentMsOf(byLabel.get(l)!) : 0), 0) };
  }

  const req = requestTotals(sy, tree.map((t) => t.row.id));
  const workers = agentTasks.filter((t) => t.spec.profile !== "supervise");
  const completed = team ? workers.filter((t) => t.row.state === "completed").length : root.row.state === "completed" ? 1 : 0;
  const byReason = Object.fromEntries(WAIT_REASONS.map((r) => [r, 0])) as Record<WaitReason, number>;
  for (const a of agents) for (const w of a.waits) byReason[w.reason] += w.end - w.start;
  const waitingMs = Object.values(byReason).reduce((s, v) => s + v, 0);
  const subJobs = team
    ? direct
        .filter((t) => t.spec.profile === "supervise")
        .flatMap((t) => {
          const m = jobMetrics(sy, t.row.id, { now });
          return m ? [summaryOf(m)] : [];
        })
    : [];
  const parent = root.spec.parentTaskId ? sy.tasks.get(root.spec.parentTaskId) : undefined;

  return {
    jobId: root.row.id,
    label: root.spec.label ?? null,
    goal: root.spec.goal,
    state: root.row.state,
    kind: team ? "team" : "single",
    parentJobId: parent?.spec.profile === "supervise" ? parent.row.id : null,
    createdAt: root.row.created_at,
    startedAt: startedAt ?? null,
    finishedAt,
    wallClockMs: startedAt === null || startedAt === undefined ? null : span.end - span.start,
    peakParallelism: stats.peak,
    meanParallelism: stats.mean,
    requests: req.total,
    costUsd: req.costUsd,
    completedTasks: completed,
    requestsPerCompletedTask: completed ? Math.round((req.total / completed) * 100) / 100 : null,
    verificationShare: req.total ? Math.round((req.byPurpose.verification / req.total) * 1000) / 1000 : null,
    waitingMs,
    computedAt: now,
    queuedMs: startedAt === null || startedAt === undefined ? null : Math.max(0, startedAt - root.row.created_at),
    tasks: {
      agents: agentTasks.length,
      completed,
      failed: (team ? workers : [root]).filter((t) => FAILED_STATES.has(t.row.state)).length,
      open: agentTasks.filter((t) => t.row.state !== "completed" && !FAILED_STATES.has(t.row.state)).length,
      subJobs: tree.filter((t) => t !== root && t.spec.profile === "supervise").length,
    },
    parallelism: { points, peak: stats.peak, mean: stats.mean, busyMs: stats.busyMs, agentMs: agents.reduce((s, a) => s + sum(a.runs), 0) },
    criticalPath: { planned, actual },
    requestsByPurpose: req.byPurpose,
    failedRequests: req.failed,
    costPerCompletedTaskUsd: completed ? Math.round((req.costUsd / completed) * 1e6) / 1e6 : null,
    waiting: { byReason, tasksThatWaited: agents.filter((a) => a.waits.some((w) => w.end > w.start)).length },
    agents,
    subJobs,
  };
}

export function summaryOf(m: JobMetrics): JobMetricsSummary {
  return {
    jobId: m.jobId,
    label: m.label,
    goal: m.goal,
    state: m.state,
    kind: m.kind,
    parentJobId: m.parentJobId,
    createdAt: m.createdAt,
    startedAt: m.startedAt,
    finishedAt: m.finishedAt,
    wallClockMs: m.wallClockMs,
    peakParallelism: m.peakParallelism,
    meanParallelism: m.meanParallelism,
    requests: m.requests,
    costUsd: m.costUsd,
    completedTasks: m.completedTasks,
    requestsPerCompletedTask: m.requestsPerCompletedTask,
    verificationShare: m.verificationShare,
    waitingMs: m.waitingMs,
  };
}

/** Metric summaries of the newest jobs (sub-jobs included), newest first; `project` limits them to one project's jobs. */
export function teamMetrics(sy: Switchyard, opts: { limit?: number; now?: number; project?: string } = {}): JobMetricsSummary[] {
  const rows = (
    opts.project
      ? sy.db.prepare("SELECT id FROM tasks WHERE profile = 'supervise' AND project_id = ? ORDER BY created_at DESC LIMIT ?").all(opts.project, opts.limit ?? 50)
      : sy.db.prepare("SELECT id FROM tasks WHERE profile = 'supervise' ORDER BY created_at DESC LIMIT ?").all(opts.limit ?? 50)
  ) as Array<{ id: string }>;
  return rows.flatMap((r) => {
    const m = jobMetrics(sy, r.id, opts.now !== undefined ? { now: opts.now } : {});
    return m ? [summaryOf(m)] : [];
  });
}
