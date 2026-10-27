import type { MeritRouter } from "../core/service.js";
import type { TaskState } from "../core/task.js";
import type { UsageSummary } from "../storage/usage.js";
import { QUALIFICATION_PROJECT } from "../qualification/registry.js";
import { overview, workers, type Overview, type WorkerInfo } from "./insights.js";
import { projectActivity, projectAttention, projectInfo, projectList, projectNotices, QUEUED_STATES, RUNNING_STATES, type ProjectCard, type ProjectSummary } from "./projects.js";
import { adminProjectScopes, fanOutProjects, newestFirst, openProjectStores, projectQuestions, taskIn } from "./project-reads.js";
import type { ProjectRuntimeStore } from "../projects/runtime-store.js";

// The global dashboard (every project's jobs, queues, attention, usage, and spend) and one
// project's overview. The install-wide `overview` (providers, keys, models) stays in insights.ts.
//
// `tasks` reads below go through the named project's own store (`openProjectStores`), filtered to
// its own `project_id`; `activeJobs()` with no project fans out
// over every configured project and merges newest-first. `paid_spend` is a shared table (see
// `storage/store-role.ts`'s `sharedTables`): `paidSpendByProject` reads it per project by joining
// to that project's own `model_requests` rows (today the same physical database, so the join
// resolves; the '' / unattributed bucket, which has no project store, stays on `sy.db` directly).

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
  /** Every input token read, cached ones included. */
  inputTokens: number;
  /** Known cached input; a lower bound when cacheUsageKnown is false. */
  cachedInputTokens: number;
  cacheUsageKnown: boolean;
  requestsWithUnknownCacheUsage: number;
  /** New input: an upper bound when cache usage is partially unknown. */
  uncachedInputTokens: number;
  outputTokens: number;
  tasksSubmitted: number;
  tasksCompleted: number;
  tasksFailed: number;
  /** Provider-reported cost of the window's requests (null when no provider reported one). */
  reportedCostUsd: number | null;
  /** Paid spend recorded against paid keys: settled where known, else the reservation. */
  paidSpendUsd: number;
}

function activeJobRows(stores: ProjectRuntimeStore, states: readonly string[], project: string | undefined, limit: number): Array<{ id: string; stores: ProjectRuntimeStore }> {
  return (stores.db
    .prepare(
      `SELECT id FROM tasks WHERE profile = 'supervise' AND json_extract(spec_json, '$.parentTaskId') IS NULL
          AND state IN (${states.map(() => "?").join(",")})${project !== undefined ? " AND project_id = ?" : ""} ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...states, ...(project !== undefined ? [project] : []), limit) as Array<{ id: string }>).map((r) => ({ ...r, stores }));
}

/**
 * Running and queued top-level jobs, newest first; `project` limits them to one project's own
 * store. Without `project`, every configured project (plus qualification) is read from its own
 * store and merged back down to the top `limit` by `createdAt` (never more, never duplicated).
 * The task row (label, goal, state) and its pending questions are read from that same row's own
 * store, never the installation-wide `sy.tasks`/`sy.questions`.
 */
export function activeJobs(sy: MeritRouter, project?: string, limit = 50): ActiveJob[] {
  const states = [...RUNNING_STATES, ...QUEUED_STATES];
  let rows: Array<{ id: string; stores: ProjectRuntimeStore }>;
  if (project !== undefined) {
    const opened = openProjectStores(sy, project);
    rows = opened.ok ? activeJobRows(opened.stores, states, project, limit) : [];
  } else {
    rows = fanOutProjects(sy, adminProjectScopes(sy), (stores) => activeJobRows(stores, states, stores.project, limit)).rows;
  }
  const withTask = rows.flatMap((r) => {
    const t = taskIn(sy, r.stores, r.id);
    if (!t) return [];
    return [{ taskId: r.id, project: t.row.project_id, label: t.spec.label ?? null, goal: t.spec.goal, state: t.row.state, createdAt: t.row.created_at, startedAt: t.row.started_at, pendingQuestions: projectQuestions(r.stores, { taskId: r.id, pendingOnly: true }).length }];
  });
  return project !== undefined ? withTask : newestFirst(withTask, (j) => j.createdAt, limit);
}

/**
 * Paid spend per project since `sinceMs` ('' = requests charged to no task, such as probes).
 * `paid_spend` is a shared table with no `project_id` of its own; each configured project's own
 * store is read, joining its own `model_requests` rows to that project's slice of `paid_spend`
 * (today the same physical database, so the join resolves), and the '' bucket (no project store)
 * is read from `sy.db` directly.
 */
export function paidSpendByProject(sy: MeritRouter, sinceMs: number): Map<string, number> {
  const { rows } = fanOutProjects(sy, adminProjectScopes(sy), (stores, project) =>
    [stores.db.prepare("SELECT SUM(COALESCE(s.actual_usd, s.reserved_usd)) AS usd FROM paid_spend s JOIN model_requests m ON m.id = s.request_id WHERE s.created_at > ? AND m.project_id = ?").get(sinceMs, project) as { usd: number | null }].map((r) => ({ project, usd: r.usd ?? 0 })),
  );
  const unattributed = sy.db.prepare("SELECT SUM(COALESCE(s.actual_usd, s.reserved_usd)) AS usd FROM paid_spend s LEFT JOIN model_requests m ON m.id = s.request_id WHERE s.created_at > ? AND (m.project_id IS NULL OR m.project_id = '')").get(sinceMs) as { usd: number | null };
  return new Map([...rows.map((r) => [r.project, r.usd] as const), ["", unattributed.usd ?? 0] as const]);
}

function projectUsage(s: UsageSummary, paid: number): ProjectUsage {
  return {
    requests: s.modelRequests,
    failedRequests: s.failedRequests,
    inputTokens: s.inputTokens,
    cachedInputTokens: s.cachedInputTokens,
    cacheUsageKnown: s.cacheUsageKnown,
    requestsWithUnknownCacheUsage: s.requestsWithUnknownCacheUsage,
    uncachedInputTokens: s.uncachedInputTokens,
    outputTokens: s.outputTokens,
    tasksSubmitted: s.logicalTasks.submitted,
    tasksCompleted: s.logicalTasks.completed,
    tasksFailed: s.logicalTasks.failed,
    reportedCostUsd: s.reportedCostUsd,
    paidSpendUsd: paid,
  };
}

/** Requests in a window that no project owns (provider probes, scans, classification without a task). */
function unattributedUsage(sy: MeritRouter, sinceMs: number, paid: number): ProjectUsage {
  const r = sy.db
    .prepare(
      `SELECT COUNT(*) AS n, SUM(status = 'failed') AS failed, COALESCE(SUM(input_tokens),0) AS inTok,
              COALESCE(SUM(cached_input_tokens),0) AS cachedTok, COALESCE(SUM(cached_input_tokens IS NULL),0) AS unknownCache, COALESCE(SUM(MAX(0, input_tokens - COALESCE(cached_input_tokens, 0))),0) AS newTok,
              COALESCE(SUM(output_tokens),0) AS outTok, SUM(reported_cost_usd) AS cost
         FROM model_requests WHERE reserved_at > ? AND project_id = ''`,
    )
    .get(sinceMs) as { n: number; failed: number | null; inTok: number; cachedTok: number; unknownCache: number; newTok: number; outTok: number; cost: number | null };
  return { requests: r.n, failedRequests: r.failed ?? 0, inputTokens: r.inTok, cachedInputTokens: r.cachedTok, cacheUsageKnown: r.unknownCache === 0, requestsWithUnknownCacheUsage: r.unknownCache, uncachedInputTokens: r.newTok, outputTokens: r.outTok, tasksSubmitted: 0, tasksCompleted: 0, tasksFailed: 0, reportedCostUsd: r.cost, paidSpendUsd: paid };
}

/** With `project`, read only that project's own store; without one, every project (install-wide total), merged. */
export function tasksByState(sy: MeritRouter, project?: string): Record<string, number> {
  if (project !== undefined) {
    const opened = openProjectStores(sy, project);
    if (!opened.ok) return {};
    const rows = opened.stores.db.prepare("SELECT state, COUNT(*) AS n FROM tasks WHERE project_id = ? GROUP BY state").all(project) as Array<{ state: string; n: number }>;
    return Object.fromEntries(rows.map((r) => [r.state, r.n]));
  }
  const { rows } = fanOutProjects(sy, adminProjectScopes(sy), (stores) => stores.db.prepare("SELECT state, COUNT(*) AS n FROM tasks WHERE project_id = ? GROUP BY state").all(stores.project) as Array<{ state: string; n: number }>);
  const totals = new Map<string, number>();
  for (const r of rows) totals.set(r.state, (totals.get(r.state) ?? 0) + r.n);
  return Object.fromEntries(totals);
}

/** Submission time of a project's oldest queued task (how long its queue has been waiting). */
function oldestQueuedAt(sy: MeritRouter, project: string): number | null {
  const opened = openProjectStores(sy, project);
  if (!opened.ok) return null;
  const r = opened.stores.db.prepare(`SELECT MIN(created_at) AS t FROM tasks WHERE project_id = ? AND state IN (${QUEUED_STATES.map(() => "?").join(",")})`).get(project, ...QUEUED_STATES) as { t: number | null };
  return r.t ?? null;
}

export interface DashboardProject extends ProjectCard {
  tasksByState: Record<string, number>;
  /** When the oldest of the project's queued tasks was submitted (null when nothing is queued). */
  oldestQueuedAt: number | null;
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
  /** Qualification runs and eval comparisons (the reserved `_qualification` project, never listed as a project). */
  qualification: { usage24h: ProjectUsage; usage7d: ProjectUsage };
  totals: { runningJobs: number; queuedJobs: number; runningTasks: number; queuedTasks: number; usage24h: ProjectUsage; usage7d: ProjectUsage };
}

/**
 * The global dashboard: every project's running and queued jobs, its queue, what needs
 * attention, and usage and paid spend by project, plus the install-wide overview.
 */
export async function globalDashboard(sy: MeritRouter, opts: { includeArchived?: boolean } = {}): Promise<GlobalDashboard> {
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
      oldestQueuedAt: oldestQueuedAt(sy, p.slug),
      usage24h: projectUsage(sy.usage(now - DAY, now, p.slug), paid1.get(p.slug) ?? 0),
      usage7d: projectUsage(sy.usage(now - 7 * DAY, now, p.slug), paid7.get(p.slug) ?? 0),
    };
  });
  const shown = new Set(projects.map((p) => p.slug));
  const sum = (k: "usage24h" | "usage7d", ...rest: ProjectUsage[]): ProjectUsage => {
    const all = [...projects.map((p) => p[k]), ...rest];
    const add = (f: keyof ProjectUsage) => all.reduce((n, u) => n + ((u[f] as number | null) ?? 0), 0);
    const reported = all.some((u) => u.reportedCostUsd !== null);
    return { requests: add("requests"), failedRequests: add("failedRequests"), inputTokens: add("inputTokens"), cachedInputTokens: add("cachedInputTokens"), cacheUsageKnown: all.every(u => u.cacheUsageKnown), requestsWithUnknownCacheUsage: add("requestsWithUnknownCacheUsage"), uncachedInputTokens: add("uncachedInputTokens"), outputTokens: add("outputTokens"), tasksSubmitted: add("tasksSubmitted"), tasksCompleted: add("tasksCompleted"), tasksFailed: add("tasksFailed"), reportedCostUsd: reported ? add("reportedCostUsd") : null, paidSpendUsd: add("paidSpendUsd") };
  };
  const unattributed = { usage24h: unattributedUsage(sy, now - DAY, paid1.get("") ?? 0), usage7d: unattributedUsage(sy, now - 7 * DAY, paid7.get("") ?? 0) };
  const q = QUALIFICATION_PROJECT;
  const qualification = { usage24h: projectUsage(sy.usage(now - DAY, now, q), paid1.get(q) ?? 0), usage7d: projectUsage(sy.usage(now - 7 * DAY, now, q), paid7.get(q) ?? 0) };
  return {
    generatedAt: now,
    install,
    projects,
    jobs: activeJobs(sy).filter((j) => shown.has(j.project)),
    attention: [...install.attention.map((text) => ({ project: null, text })), ...projects.flatMap((p) => p.attentionItems.map((text) => ({ project: p.slug, text })))],
    unattributed,
    qualification,
    totals: {
      runningJobs: projects.reduce((n, p) => n + p.runningJobs, 0),
      queuedJobs: projects.reduce((n, p) => n + p.queuedJobs, 0),
      runningTasks: projects.reduce((n, p) => n + p.runningTasks, 0),
      queuedTasks: projects.reduce((n, p) => n + p.queuedTasks, 0),
      usage24h: sum("usage24h", unattributed.usage24h, qualification.usage24h),
      usage7d: sum("usage7d", unattributed.usage7d, qualification.usage7d),
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
  /** Information, not problems: repositories MeritRouter recently created or set up with git. */
  notices: string[];
  usage24h: UsageSummary;
  usage7d: UsageSummary;
  paidSpendUsd: { last24h: number; last7d: number };
}

/** One project's overview: its jobs and queue, attention items, usage, and paid spend. */
export function projectOverview(sy: MeritRouter, slug: string): ProjectOverview {
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
    notices: projectNotices(sy, slug, now),
    usage24h: sy.usage(now - DAY, now, slug),
    usage7d: sy.usage(now - 7 * DAY, now, slug),
    paidSpendUsd: { last24h: paidSpendByProject(sy, now - DAY).get(slug) ?? 0, last7d: paidSpendByProject(sy, now - 7 * DAY).get(slug) ?? 0 },
  };
}
