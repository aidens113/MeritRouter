import { z } from "zod";
import { MeritRouterError } from "../core/errors.js";
import type { MeritRouter } from "../core/service.js";
import type { Db } from "../storage/db.js";
import type { ProjectRuntimeStore } from "../projects/runtime-store.js";
import type { SessionStore } from "../sessions/store.js";
import { QUALIFICATION_PROJECT } from "../qualification/registry.js";
import type { StoredTask } from "../storage/tasks.js";
import { Admission } from "../admission/admission.js";

/**
 * Per-project reads for every admin view (jobs, plans, teams, metrics, sessions, budgets, usage,
 * request evidence). Project-private rows (tasks, sessions, requests, charges, artifacts, events,
 * job state, plans, channel, merge queue, budgets...) are read only through a project's own store
 * handle (`sy.projectStores(slug)`), always with an explicit `project_id` filter, so the same
 * query is correct when every project shares the installation database (today: no double
 * counting) and once each project has its own store. `sy.db` stays the installation database for
 * global/shared tables only (see `src/storage/store-role.ts`'s `sharedTables`).
 *
 * Cross-project views fan out over projects and merge in memory; a project whose store cannot be
 * opened or read is reported as an explicit `ProjectStoreUnavailable` marker, never a crash of the
 * whole view and never a silent omission. There is exactly one wrapper shape per result shape:
 * `RowsWithAvailability<T>` (a non-enumerable, read-only `unavailable` array) for array results,
 * and `WithUnavailable<T>` (an ordinary `unavailableProjects` field) for a single merged object
 * (e.g. a merged `UsageSummary`). Pick the one matching your return type; do not invent a third.
 */

/** A project whose store could not be opened or read for this view. */
export interface ProjectStoreUnavailable {
  project: string;
  /** A short machine-readable reason (an error code when one is known); never raw error text, which can carry paths. */
  reason: string;
}

/** Rows of a cross-project view plus the projects that could not be read. */
export type RowsWithAvailability<T> = T[] & { readonly unavailable: ProjectStoreUnavailable[] };

/** A single merged view (an object, not an array) plus the projects that could not be read. */
export type WithUnavailable<T> = T & { unavailableProjects?: ProjectStoreUnavailable[] };

/** Thrown for a single-project read whose store is unavailable (distinct from "not found"). */
export class ProjectStoreUnavailableError extends MeritRouterError {
  constructor(
    readonly project: string,
    readonly reason: string,
  ) {
    super("project_store_unavailable", `project ${project}'s store is unavailable (${reason}); its data cannot be read right now`);
  }
}

const REASON = /^[a-z][a-z0-9_:-]{0,79}$/;

/** A short, safe reason code for an unavailable marker; never the raw error message. */
function unavailableReason(error: unknown): string {
  const code = error instanceof MeritRouterError ? error.code : (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && REASON.test(code) ? code : "store_unavailable";
}

export type ProjectStoreOpen = { ok: true; project: string; stores: ProjectRuntimeStore } | { ok: false; marker: ProjectStoreUnavailable };

/** Whether a stored project id names a configured project or the internal qualification project. */
export function isKnownProject(sy: MeritRouter, project: string): boolean {
  return sy.projects.context(project) !== undefined;
}

/** Open a project's store handle, converting failure into an explicit marker (never throws). */
export function openProjectStores(sy: MeritRouter, project: string): ProjectStoreOpen {
  try {
    const stores = sy.projectStores(project);
    if (stores.project !== project) throw new MeritRouterError("store_identity_mismatch", "project store identity mismatch");
    return { ok: true, project, stores };
  } catch (error) {
    return { ok: false, marker: { project, reason: unavailableReason(error) } };
  }
}

/** A single-project store, or a typed `ProjectStoreUnavailableError`. */
export function requireProjectStores(sy: MeritRouter, project: string): ProjectRuntimeStore {
  const opened = openProjectStores(sy, project);
  if (!opened.ok) throw new ProjectStoreUnavailableError(project, opened.marker.reason);
  return opened.stores;
}

/** A project's session store; throws `ProjectStoreUnavailableError` when its bundle has none. */
export function projectSessionsOf(stores: ProjectRuntimeStore): SessionStore {
  if (!stores.sessions) throw new ProjectStoreUnavailableError(stores.project, "its session store is not open");
  return stores.sessions;
}

/**
 * The projects a listing view covers: the named one (empty when it is not configured), or every
 * configured project, plus the internal qualification project unless `opts.qualification` is
 * `false` (the default includes it: most installation-wide views historically did).
 */
export function projectScope(sy: MeritRouter, project: string | undefined, opts: { qualification?: boolean } = {}): string[] {
  if (project !== undefined) return project && isKnownProject(sy, project) ? [project] : [];
  return [...sy.projects.slugs(), ...(opts.qualification === false ? [] : [QUALIFICATION_PROJECT])];
}

/** Every project an installation-wide view reads (every configured project, plus qualification unless excluded). */
export function adminProjectScopes(sy: MeritRouter, opts: { qualification?: boolean } = {}): string[] {
  return projectScope(sy, undefined, opts);
}

/**
 * One project (trusted as given, even if unknown: opening its store then fails and reports
 * unavailable rather than silently searching nothing), or every scope `projectScope` lists.
 * Use this for a direct lookup by a caller-supplied project; use `projectScope` for a listing view.
 */
export function scopesFor(sy: MeritRouter, project?: string | null, opts: { qualification?: boolean } = {}): string[] {
  return project ? [project] : adminProjectScopes(sy, opts);
}

/** Read each project's rows from its own store; an unavailable project contributes no rows and a marker. */
export function fanOutProjects<T>(sy: MeritRouter, projects: readonly string[], read: (stores: ProjectRuntimeStore, project: string) => T[]): { rows: T[]; unavailable: ProjectStoreUnavailable[] } {
  const rows: T[] = [];
  const unavailable: ProjectStoreUnavailable[] = [];
  for (const project of [...new Set(projects)]) {
    const opened = openProjectStores(sy, project);
    if (!opened.ok) {
      unavailable.push(opened.marker);
      continue;
    }
    try {
      rows.push(...read(opened.stores, project));
    } catch (error) {
      unavailable.push({ project, reason: unavailableReason(error) });
    }
  }
  return { rows, unavailable };
}

/** Attach the unavailable projects to an array view as a non-enumerable, read-only `unavailable` field. */
export function withAvailability<T>(rows: T[], unavailable: ProjectStoreUnavailable[]): RowsWithAvailability<T> {
  Object.defineProperty(rows, "unavailable", { value: unavailable, enumerable: false, writable: false, configurable: false });
  return rows as RowsWithAvailability<T>;
}

/** Attach the unavailable projects to a merged object view as an ordinary `unavailableProjects` field. */
export function withUnavailable<T extends object>(value: T, unavailable: ProjectStoreUnavailable[]): WithUnavailable<T> {
  return Object.assign(value, { unavailableProjects: unavailable });
}

/** The projects (one, or every project) whose stores cannot be opened right now, for a page banner. */
export function unavailableProjectStores(sy: MeritRouter, project?: string): ProjectStoreUnavailable[] {
  return fanOutProjects(sy, scopesFor(sy, project), () => []).unavailable;
}

/** One db scope to read rows from, tagged with the project they belong to ('' for the installation database's unattributed rows). */
export interface ProjectDbScope {
  db: Db;
  project: string;
}

/**
 * The db scopes a parameter-less (or optionally-project-scoped) cross-project view reads: with
 * `project` given, that single project's own store (or the installation database directly for
 * `''`, matching `locateRequest`'s and `budgetRequestsView`'s `''` case); without it, every
 * configured project (plus qualification unless excluded) and, last, the installation database's
 * unattributed (`project_id = ''`) rows — never both for the same physical row. Callers must
 * still filter every query by `project_id = scope.project` (even a real split store only ever
 * holds its own rows) because today every scope can share one database handle.
 */
export function projectDbScopes(sy: MeritRouter, project: string | undefined, opts: { qualification?: boolean } = {}): { scopes: ProjectDbScope[]; unavailable: ProjectStoreUnavailable[] } {
  if (project === "") return { scopes: [{ db: sy.db, project: "" }], unavailable: [] };
  if (project) {
    const opened = openProjectStores(sy, project);
    return opened.ok ? { scopes: [{ db: opened.stores.db, project }], unavailable: [] } : { scopes: [], unavailable: [opened.marker] };
  }
  const unavailable: ProjectStoreUnavailable[] = [];
  const scopes: ProjectDbScope[] = [];
  for (const p of adminProjectScopes(sy, opts)) {
    const opened = openProjectStores(sy, p);
    if (opened.ok) scopes.push({ db: opened.stores.db, project: p });
    else unavailable.push(opened.marker);
  }
  scopes.push({ db: sy.db, project: "" });
  return { scopes, unavailable };
}

/** `projectDbScopes` plus running `read` over each scope and flattening the rows (see its doc comment for what each scope means). */
export function fanOutProjectRows<T>(sy: MeritRouter, project: string | undefined, opts: { qualification?: boolean } = {}, read: (db: Db, project: string) => T[]): { rows: T[]; unavailable: ProjectStoreUnavailable[] } {
  const { scopes, unavailable } = projectDbScopes(sy, project, opts);
  return { rows: scopes.flatMap((s) => read(s.db, s.project)), unavailable };
}

// ---------- locating a task, session or request by id across (or within) a project ----------

export interface LocatedProject {
  /** The owning project, or '' for a row charged to no project (an installation-level task or a legacy taskless session). */
  project: string;
  db: Db;
  /** The project's own store, or null for '' (there is no store for "no project"). */
  stores: ProjectRuntimeStore | null;
}

/** Thrown when an id given without a project is found in more than one project's store. */
export class AmbiguousProjectIdError extends MeritRouterError {
  constructor(kind: string, id: string, readonly projects: string[]) {
    super("ambiguous_id", `${kind} ${id} exists in several projects (${projects.join(", ")}); name the project`);
  }
}

/**
 * The single match of an id lookup run across project stores. With a named project only that
 * project was searched, so its first match is the answer; without one, every store was searched
 * and an id found in two projects (possible only once projects keep their own stores, where ids
 * are unique per store, not per installation) is refused rather than resolved to either.
 */
function single<T extends { project: string }>(kind: string, id: string, matches: T[]): T | null {
  if (matches.length > 1) throw new AmbiguousProjectIdError(kind, id, matches.map((m) => m.project));
  return matches[0] ?? null;
}

function locate(sy: MeritRouter, table: "tasks" | "sessions" | "model_requests", id: string, project?: string): LocatedProject | null {
  const found: LocatedProject[] = [];
  if (project !== "") {
    for (const p of scopesFor(sy, project)) {
      const opened = openProjectStores(sy, p);
      if (!opened.ok) continue;
      if (opened.stores.db.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND project_id = ?`).get(id, p)) {
        found.push({ project: p, db: opened.stores.db, stores: opened.stores });
        if (project !== undefined) break;
      }
    }
  }
  if (project === undefined || project === "") {
    if (sy.db.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND project_id = ''`).get(id)) found.push({ project: "", db: sy.db, stores: null });
  }
  return single(table === "tasks" ? "task" : table === "sessions" ? "session" : "request", id, found);
}

/** The project (and its stores) holding a task; with `project`, only that project is searched. */
export function locateTask(sy: MeritRouter, taskId: string, project?: string): LocatedProject | null {
  return locate(sy, "tasks", taskId, project);
}

/** The project (and its stores) holding a session; with `project`, only that project is searched. */
export function locateSession(sy: MeritRouter, sessionId: string, project?: string): LocatedProject | null {
  return locate(sy, "sessions", sessionId, project);
}

export interface LocatedRequest {
  /** The owning project, or '' for an installation request charged to no project (probes, scans). */
  project: string;
  db: Db;
  stores: ProjectRuntimeStore | null;
}

/**
 * Where a model request's row lives: its project's store (with `project_id` = that project), or
 * the installation database for a request charged to no project. With `project` ('' = only
 * unattributed), only that scope is searched.
 */
export function locateRequest(sy: MeritRouter, requestId: string, project?: string): LocatedRequest | null {
  return locate(sy, "model_requests", requestId, project);
}

// ---------- tasks and jobs within a known project store ----------

/** A task found in its own project's store. */
export interface ProjectTask {
  project: string;
  stores: ProjectRuntimeStore;
  task: StoredTask;
}

/** Whether a task row belongs to `project` (legacy rows without a project belong to the primary project). */
function ownedBy(sy: MeritRouter, task: StoredTask, project: string): boolean {
  return task.row.project_id === project || (task.row.project_id === "" && project === sy.projects.primary.project.slug);
}

/** The task in `stores` when it belongs to that store's project. */
export function taskIn(sy: MeritRouter, stores: ProjectRuntimeStore, id: string): StoredTask | undefined {
  const t = stores.tasks.get(id);
  return t && ownedBy(sy, t, stores.project) ? t : undefined;
}

/**
 * A raw-SQL `project_id` filter agreeing with `ownedBy`'s convention: a row with `project_id=''`
 * belongs to the primary project, so scanning the primary project's slug must also match `''`
 * rows. Use this (not a bare `project_id = ?`) whenever a listing scan filters `tasks` (or a
 * table following the same convention) by a scope's project slug.
 */
export function projectIdFilter(sy: MeritRouter, project: string): { sql: string; args: unknown[] } {
  return project === sy.projects.primary.project.slug ? { sql: "project_id IN (?, '')", args: [project] } : { sql: "project_id = ?", args: [project] };
}

/**
 * Find a task by id in its project's store: the named project only, or each project (configured,
 * then qualification) in turn. Null when no available store holds it. When it was not found and a
 * candidate store was unavailable, throw ProjectStoreUnavailableError rather than report "unknown".
 */
export function locateProjectTask(sy: MeritRouter, id: string, project?: string): ProjectTask | null {
  const candidates = project !== undefined ? (isKnownProject(sy, project) ? [project] : []) : [...sy.projects.slugs(), QUALIFICATION_PROJECT];
  let missing: ProjectStoreUnavailable | null = null;
  const found: ProjectTask[] = [];
  for (const p of candidates) {
    const opened = openProjectStores(sy, p);
    if (!opened.ok) {
      missing ??= opened.marker;
      continue;
    }
    const task = taskIn(sy, opened.stores, id);
    if (task) found.push({ project: p, stores: opened.stores, task });
  }
  const match = single("task", id, found);
  if (match) return match;
  if (missing) throw new ProjectStoreUnavailableError(missing.project, missing.reason);
  return null;
}

/**
 * The installation's own task, session and artifact stores, for a legacy installation only (where
 * every project's rows live in them). A split installation's installation store is the
 * coordination store, which holds no project rows and refuses private-evidence reads, so a
 * split installation gets null: a row whose project store cannot be opened is simply not shown.
 */
export function legacyStores(sy: MeritRouter): Pick<ProjectRuntimeStore, "db" | "tasks" | "sessions" | "artifacts" | "contracts"> | null {
  return sy.layout === "split" ? null : { db: sy.db, tasks: sy.tasks, sessions: sy.sessions, artifacts: sy.artifacts, contracts: sy.contracts };
}

/**
 * Admission reads (request totals) over a project's own store: the service's own admission when
 * the store is the installation's (legacy), else a read-only view over the project's database.
 * `Admission`'s constructor only wires objects; nothing here writes.
 */
export function admissionOf(sy: MeritRouter, stores: Pick<ProjectRuntimeStore, "db" | "tasks">): Admission {
  return stores.db === sy.db ? sy.admission : new Admission(stores.db, stores.tasks, sy.cfg);
}

/** Requests charged (or prepared) for a task, read from its project's store. */
export function taskRequestsUsed(stores: ProjectRuntimeStore, taskId: string): number {
  const charged = z.object({ n: z.number().int().nonnegative() }).parse(
    stores.db.prepare("SELECT COUNT(*) AS n FROM request_charges c JOIN tasks t ON t.id = c.task_id WHERE c.task_id = ? AND t.project_id = ?").get(taskId, stores.project),
  ).n;
  const prepared = z.object({ n: z.number().int().nonnegative() }).parse(stores.db.prepare("SELECT COUNT(*) AS n FROM project_request_holds WHERE task_id = ? AND active = 1").get(taskId)).n;
  return charged + prepared;
}

export interface ProjectQuestion {
  id: number;
  taskId: string;
  project: string;
  question: string;
  options: string[] | null;
  answer: string | null;
  askedAt: number;
  answeredAt: number | null;
}

const QuestionRow = z.object({
  id: z.number().int(),
  task_id: z.string(),
  project_id: z.string(),
  question: z.string(),
  options_json: z.string().nullable(),
  answer: z.string().nullable(),
  asked_at: z.number(),
  answered_at: z.number().nullable(),
});

/** A job's questions from its project's store (the shape `MeritRouter.questions` returns), newest first, at most 100. */
export function projectQuestions(stores: ProjectRuntimeStore, opts: { taskId?: string; pendingOnly?: boolean } = {}): ProjectQuestion[] {
  const where = ["t.project_id = ?"];
  const args: unknown[] = [stores.project];
  if (opts.pendingOnly ?? true) where.push("q.answer IS NULL");
  if (opts.taskId) (where.push("q.task_id = ?"), args.push(opts.taskId));
  const rows = stores.db
    .prepare(`SELECT q.id, q.task_id, t.project_id, q.question, q.options_json, q.answer, q.asked_at, q.answered_at FROM job_questions q JOIN tasks t ON t.id = q.task_id WHERE ${where.join(" AND ")} ORDER BY q.id DESC LIMIT 100`)
    .all(...args);
  return rows.flatMap((raw) => {
    const r = QuestionRow.safeParse(raw);
    if (!r.success) return [];
    let options: string[] | null = null;
    if (r.data.options_json) {
      try {
        const parsed = z.array(z.string()).safeParse(JSON.parse(r.data.options_json));
        options = parsed.success ? parsed.data : null;
      } catch {
        options = null;
      }
    }
    return [{ id: r.data.id, taskId: r.data.task_id, project: r.data.project_id, question: r.data.question, options, answer: r.data.answer, askedAt: r.data.asked_at, answeredAt: r.data.answered_at }];
  });
}

/** Merge newest-first rows from several projects, keeping each project's own order for ties. */
export function newestFirst<T>(rows: T[], at: (row: T) => number, limit: number): T[] {
  return [...rows].sort((a, b) => at(b) - at(a)).slice(0, limit);
}
