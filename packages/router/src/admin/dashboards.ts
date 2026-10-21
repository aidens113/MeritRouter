import type { Switchyard } from "../core/service.js";
import type { TaskState } from "../core/task.js";
import type { UsageSummary } from "../storage/usage.js";
import { overview, workers, type Overview, type WorkerInfo } from "./insights.js";
import { projectActivity, projectAttention, projectInfo, projectList, QUEUED_STATES, RUNNING_STATES, type ProjectCard, type ProjectSummary } from "./projects.js";

// The global dashboard (every project's jobs, queues, attention, usage, and spend) and one
// project's overview. The install-wide `overview` (providers, keys, models) stays in insights.ts.

const DAY = 86_400_000;

/** A running or queued job, for dashboards. */
export interface ActiveJob {
  taskId: string;
  project: string;
  label: string | null;
  goal: string;
  state: TaskState;
  createdAt: number;
  startedAt: number | null;
  pendingQuestions: number;
}

/** Usage and paid spend of one project (or of requests charged to no project). */
export interface ProjectUsage {
  requests: number;
  failedRequests: number;
  inputTokens: number;
  outputTokens: number;
  tasksSubmitted: number;
  tasksCompleted: number;
  tasksFailed: number;
  /** Provider-reported cost of the window's requests (null when no provider reported one). */
  reportedCostUsd: number | null;
  /** Paid spend recorded against paid keys: settled where known, else the reservation. */
  paidSpendUsd: number;
}

/** Running and queued top-level jobs, newest first; `project` limits them to one project. */
export function activeJobs(sy: Switchyard, project?: string, limit = 50): ActiveJob[] {
  const states = [...RUNNING_STATES, ...QUEUED_STATES];
  const rows = sy.db
    .prepare(
      `SELECT id FROM tasks WHERE profile = 'supervise' AND json_extract(spec_json, '$.parentTaskId') IS NULL
          AND state IN (${states.map(() => "?").join(",")})${project ? " AND project_id = ?" : ""} ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...states, ...(project ? [project] : []), limit) as Array<{ id: string }>;
  return rows.flatMap((r) => {
    const t = sy.tasks.get(r.id);
    if (!t) return [];
    return [{ taskId: r.id, project: t.row.project_id, label: t.spec.label ?? null, goal: t.spec.goal, state: t.row.state, createdAt: t.row.created_at, startedAt: t.row.started_at, pendingQuestions: sy.questions({ taskId: r.id }).length }];
  });
}

/** Paid spend per project since `sinceMs` ('' = requests charged to no task, such as probes). */
export function paidSpendByProject(sy: Switchyard, sinceMs: number): Map<string, number> {
  const rows = sy.db
    .prepare("SELECT COALESCE(m.project_id, '') AS project, SUM(COALESCE(s.actual_usd, s.reserved_usd)) AS usd FROM paid_spend s LEFT JOIN model_requests m ON m.id = s.request_id WHERE s.created_at > ? GROUP BY project")
    .all(sinceMs) as Array<{ project: string; usd: number | null }>;
  return new Map(rows.map((r) => [r.project, r.usd ?? 0]));
}

function projectUsage(s: UsageSummary, paid: number): ProjectUsage {
  return {
    requests: s.modelRequests,
    failedRequests: s.failedRequests,
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    tasksSubmitted: s.logicalTasks.submitted,
    tasksCompleted: s.logicalTasks.completed,
    tasksFailed: s.logicalTasks.failed,
    reportedCostUsd: s.reportedCostUsd,
    paidSpendUsd: paid,
  };
}

/** Requests in a window that no project owns (provider probes, scans, classification without a task). */
function unattributedUsage(sy: Switchyard, sinceMs: number, paid: number): ProjectUsage {
  const r = sy.db
    .prepare(
      `SELECT COUNT(*) AS n, SUM(status = 'failed') AS failed, COALESCE(SUM(input_tokens),0) AS inTok, COALESCE(SUM(output_tokens),0) AS outTok, SUM(reported_cost_usd) AS cost
         FROM model_requests WHERE reserved_at > ? AND project_id = ''`,
    )
    .get(sinceMs) as { n: number; failed: number | null; inTok: number; outTok: number; cost: number | null };
  return { requests: r.n, failedRequests: r.failed ?? 0, inputTokens: r.inTok, outputTokens: r.outTok, tasksSubmitted: 0, tasksCompleted: 0, tasksFailed: 0, reportedCostUsd: r.cost, paidSpendUsd: paid };
}

function tasksByState(sy: Switchyard, project?: string): Record<string, number> {
  const rows = sy.db.prepare(`SELECT state, COUNT(*) AS n FROM tasks${project ? " WHERE project_id = ?" : ""} GROUP BY state`).all(...(project ? [project] : [])) as Array<{ state: string; n: number }>;
  return Object.fromEntries(rows.map((r) => [r.state, r.n]));
}

export interface DashboardProject extends ProjectCard {
  tasksByState: Record<string, number>;
  usage24h: ProjectUsage;
  usage7d: ProjectUsage;
}

export interface GlobalDashboard {
  generatedAt: number;
  /** Install-wide state: keys, workers, providers, models, last scan, and install-level attention. */
  install: Overview;
  /** Every non-archived project (archived ones with `includeArchived`). */
  projects: DashboardProject[];
  /** Running and queued top-level jobs of every project, newest first. */
  jobs: ActiveJob[];
  /** Attention items of every project, each prefixed with its project. */
  attention: Array<{ project: string | null; text: string }>;
  /** Requests charged to no project (probes, scans). */
  unattributed: { usage24h: ProjectUsage; usage7d: ProjectUsage };
  totals: { runningJobs: number; queuedJobs: number; runningTasks: number; queuedTasks: number; usage24h: ProjectUsage; usage7d: ProjectUsage };
}

/**
 * The global dashboard: every project's running and queued jobs, its queue, what needs
 * attention, and usage and paid spend by project, plus the install-wide overview.
 */
export async function globalDashboard(sy: Switchyard, opts: { includeArchived?: boolean } = {}): Promise<GlobalDashboard> {
  const install = await overview(sy);
  const now = install.generatedAt;
  const paid1 = paidSpendByProject(sy, now - DAY);
  const paid7 = paidSpendByProject(sy, now - 7 * DAY);
  const projects: DashboardProject[] = projectList(sy, opts).map((p) => {
    const attentionItems = projectAttention(sy, p.slug);
    return {
      ...p,
      ...projectActivity(sy, p.slug),
      attention: attentionItems.length,
      attentionItems,
      tasksByState: tasksByState(sy, p.slug),
      usage24h: projectUsage(sy.usage(now - DAY, now, p.slug), paid1.get(p.slug) ?? 0),
      usage7d: projectUsage(sy.usage(now - 7 * DAY, now, p.slug), paid7.get(p.slug) ?? 0),
    };
  });
  const shown = new Set(projects.map((p) => p.slug));
  const sum = (k: "usage24h" | "usage7d", unattributed: ProjectUsage): ProjectUsage => {
    const all = [...projects.map((p) => p[k]), unattributed];
    const add = (f: keyof ProjectUsage) => all.reduce((n, u) => n + ((u[f] as number | null) ?? 0), 0);
    const reported = all.some((u) => u.reportedCostUsd !== null);
    return { requests: add("requests"), failedRequests: add("failedRequests"), inputTokens: add("inputTokens"), outputTokens: add("outputTokens"), tasksSubmitted: add("tasksSubmitted"), tasksCompleted: add("tasksCompleted"), tasksFailed: add("tasksFailed"), reportedCostUsd: reported ? add("reportedCostUsd") : null, paidSpendUsd: add("paidSpendUsd") };
  };
  const unattributed = { usage24h: unattributedUsage(sy, now - DAY, paid1.get("") ?? 0), usage7d: unattributedUsage(sy, now - 7 * DAY, paid7.get("") ?? 0) };
  return {
    generatedAt: now,
    install,
    projects,
    jobs: activeJobs(sy).filter((j) => shown.has(j.project)),
    attention: [...install.attention.map((text) => ({ project: null, text })), ...projects.flatMap((p) => p.attentionItems.map((text) => ({ project: p.slug, text })))],
    unattributed,
    totals: {
      runningJobs: projects.reduce((n, p) => n + p.runningJobs, 0),
      queuedJobs: projects.reduce((n, p) => n + p.queuedJobs, 0),
      runningTasks: projects.reduce((n, p) => n + p.runningTasks, 0),
      queuedTasks: projects.reduce((n, p) => n + p.queuedTasks, 0),
      usage24h: sum("usage24h", unattributed.usage24h),
      usage7d: sum("usage7d", unattributed.usage7d),
    },
  };
}

export interface ProjectOverview {
  generatedAt: number;
  project: ProjectSummary;
  workers: WorkerInfo[];
  tasksByState: Record<string, number>;
  activity: ReturnType<typeof projectActivity>;
  jobs: ActiveJob[];
  attention: string[];
  usage24h: UsageSummary;
  usage7d: UsageSummary;
  paidSpendUsd: { last24h: number; last7d: number };
}

/** One project's overview: its jobs and queue, attention items, usage, and paid spend. */
export function projectOverview(sy: Switchyard, slug: string): ProjectOverview {
  const project = projectInfo(sy, slug);
  const now = Date.now();
  return {
    generatedAt: now,
    project,
    workers: workers(sy),
    tasksByState: tasksByState(sy, slug),
    activity: projectActivity(sy, slug),
    jobs: activeJobs(sy, slug),
    attention: projectAttention(sy, slug),
    usage24h: sy.usage(now - DAY, now, slug),
    usage7d: sy.usage(now - 7 * DAY, now, slug),
    paidSpendUsd: { last24h: paidSpendByProject(sy, now - DAY).get(slug) ?? 0, last7d: paidSpendByProject(sy, now - 7 * DAY).get(slug) ?? 0 },
  };
}
