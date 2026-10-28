import { existsSync, mkdirSync, rmdirSync } from "node:fs";
import { projectDeliveryReport } from "./deliveries.js";
import path from "node:path";
import YAML from "yaml";
import { PROJECT_SLUG_RE, REPOSITORY_ALIAS_RE } from "../config/schema.js";
import { MeritRouterError } from "../core/errors.js";
import type { MeritRouter } from "../core/service.js";
import type { ProjectContext } from "../projects/context.js";
import type { SelectableProject } from "../cli/project-select.js";
import { recordPreparation, repositoryNotices, repositoryProblems } from "../projects/repository-setup.js";
import { folderState, prepareRepository } from "../workspaces/repository-prepare.js";
import { patchConfig, readConfigText, validateConfigText, writeConfigText } from "./config-edit.js";
import {
  projectAccounting, projectFootprint, projectMutationRepositories, projectStoreCounts, projectStoreRegistrations, projectTaskSnapshot, purgeProjectRows,
  removeCreatedRuntimeRoot, removeProjectFiles, removeProjectRuntimeRoot, removeProjectWorktrees, runtimeRootWorktrees, verifyProjectRuntimeRoot,
} from "../projects/deletion.js";
import { PROJECT_RUNTIME_DIRECTORY, projectRuntimePaths, type ProjectRuntimePaths } from "../projects/runtime-paths.js";
import type { ProjectStoreRegistration } from "../projects/store-identity.js";
import { LabRepositorySchema } from "../labs/store.js";
import { z } from "zod";
import { legacyStores, locateProjectTask, locateSession, openProjectStores } from "./project-reads.js";
import { immediate, openDatabase, type Db } from "../storage/db.js";
import { RequestReceipts } from "../admission/request-receipts.js";
import { RepositoryMutationError, withRepositoryMutation, type RepositoryMutationCapability } from "../workspaces/repository-mutation.js";

// Projects for the panel's grid, the CLI's `projects` command, and project selection: listing,
// per-project activity and attention, and creating or archiving a project. Settings live in the
// global config under `projects.<slug>` (decision D2); the `projects` table holds lifecycle only.

/** Task states counted as running and as queued. */
export const RUNNING_STATES = ["running", "cancel_requested"] as const;
export const QUEUED_STATES = ["queued", "waiting_for_dependencies", "waiting_for_capacity"] as const;
const inList = (states: readonly string[]) => states.map((s) => `'${s}'`).join(",");

export interface ProjectRepositoryView {
  alias: string;
  /** Absolute path. */
  path: string;
  writable: boolean;
  /** The folder exists and is a git repository (has `.git`). */
  exists: boolean;
}

export interface ProjectSummary {
  slug: string;
  name: string;
  /** Read from the single-project config shape (top-level `repositories`, decision D3). */
  legacy: boolean;
  /** The project system tasks and rows from before projects existed belong to. */
  primary: boolean;
  archived: boolean;
  archivedAt: number | null;
  createdAt: number | null;
  repositories: ProjectRepositoryView[];
}

export interface ProjectCard extends ProjectSummary {
  /** Top-level jobs (supervise tasks without a parent job) running and queued. */
  runningJobs: number;
  queuedJobs: number;
  /** Every task of the project, jobs included. */
  runningTasks: number;
  queuedTasks: number;
  /** Latest submission or task update; null when the project never ran anything. */
  lastActivityAt: number | null;
  attention: number;
  attentionItems: string[];
}

function repoViews(ctx: ProjectContext): ProjectRepositoryView[] {
  return Object.entries(ctx.repositoryPaths).map(([alias, r]) => ({ alias, path: r.path, writable: r.writable, exists: existsSync(path.join(r.path, ".git")) }));
}

function summary(sy: MeritRouter, ctx: ProjectContext): ProjectSummary {
  const row = sy.projects.rows().find((r) => r.id === ctx.project.slug);
  return {
    slug: ctx.project.slug,
    name: ctx.project.name,
    legacy: ctx.project.legacy,
    primary: sy.projects.primary.project.slug === ctx.project.slug,
    archived: row?.archivedAt != null,
    archivedAt: row?.archivedAt ?? null,
    createdAt: row?.createdAt ?? null,
    repositories: repoViews(ctx),
  };
}

/** Configured projects in config order; archived ones only with `includeArchived`. */
export function projectList(sy: MeritRouter, opts: { includeArchived?: boolean } = {}): ProjectSummary[] {
  return sy.projects
    .list()
    .map((c) => summary(sy, c))
    .filter((p) => opts.includeArchived || !p.archived);
}

/** One configured project; throws not_found for an unknown slug. */
export function projectInfo(sy: MeritRouter, slug: string): ProjectSummary {
  const ctx = sy.projects.get(slug);
  if (!ctx) throw new MeritRouterError("not_found", `unknown project ${slug}; projects: ${sy.projects.slugs().join(", ") || "none"}`);
  return summary(sy, ctx);
}

/**
 * The settings a task's views read (its project's verification, team, and supervisor overrides):
 * its project's context (the internal `_qualification` project for qualification and comparison
 * work), or the primary project's for a task whose project is unassigned or no longer configured
 * (views never fail on old rows).
 */
export function contextOfTask(sy: MeritRouter, taskId: string, project?: string): ProjectContext {
  // The owning project's own store (a split installation keeps no project rows in `sy.tasks`).
  const p = locateProjectTask(sy, taskId, project)?.project;
  return (p ? sy.projects.context(p) : undefined) ?? sy.projects.primary;
}

/**
 * The project a task belongs to (its own, the primary project for an unassigned row, or
 * `_qualification` for qualification and comparison work), found in the owning project's own
 * store; null for an unknown task. Without `project` every project is searched and an id held by
 * two projects is refused (`ambiguous_id`); with it, only that project is searched.
 */
export function taskOwner(sy: MeritRouter, taskId: string, project?: string): string | null {
  return locateProjectTask(sy, taskId, project)?.project ?? null;
}

/** The project a session belongs to (its own store's project; the primary project for a legacy task-less session); null for an unknown session. */
export function sessionOwner(sy: MeritRouter, sessionId: string, project?: string): string | null {
  // A legacy session charged to no project ('') is owned through its task, so it is looked up too.
  const located = locateSession(sy, sessionId, project) ?? (project && legacyStores(sy) ? locateSession(sy, sessionId, "") : null);
  if (!located) return null;
  if (located.project) return located.project;
  // A legacy row charged to no project belongs to its task's project (the primary project without one).
  const taskId = legacyStores(sy)?.sessions?.get(sessionId)?.taskId;
  return (taskId ? taskOwner(sy, taskId) : null) ?? sy.projects.primary.project.slug;
}

/** Every configured project as the CLI and MCP choose among them (archived ones included, marked). */
export function selectableProjects(sy: MeritRouter): SelectableProject[] {
  return projectList(sy, { includeArchived: true }).map((p) => ({ slug: p.slug, archived: p.archived, repositoryPaths: Object.fromEntries(p.repositories.map((r) => [r.alias, { path: r.path }])) }));
}

/**
 * What needs a person in one project: questions supervisors wait on, results waiting for an
 * acceptance decision, brain access requests, interrupted tasks, and repositories MeritRouter
 * could not set up itself (git missing, a file where the folder should be, permissions). A
 * missing folder or one without git is not listed: MeritRouter prepares it (see `projectNotices`).
 */
export function projectAttention(sy: MeritRouter, slug: string): string[] {
  const out: string[] = [];
  const ctx = sy.projects.get(slug);
  // Project rows live in the project's own store (the installation's in a legacy layout).
  const opened = openProjectStores(sy, slug);
  if (!opened.ok) {
    out.push(sy.layout === "split" && !projectStoreRegistrations(sy.db, slug).some((r) => r.state === "registered")
      ? `Project ${slug} has no store yet; create it with its directory (meritrouter projects create ${slug} <directory>).`
      : `Project ${slug}'s store is unavailable (${opened.marker.reason}); its tasks cannot be read.`);
    if (ctx) out.push(...repositoryProblems(sy.db, ctx));
    return out;
  }
  const db = opened.stores.db;
  const questions = sy.questions({ project: slug }).length;
  if (questions) out.push(`${questions} question(s) from supervisors are waiting for an answer.`);
  const awaiting = (db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND state = 'completed' AND json_extract(result_json, '$.acceptanceStatus') IN ('needs_supervisor','not_verified')").get(slug) as { n: number }).n;
  if (awaiting) out.push(`${awaiting} result(s) wait for an acceptance decision.`);
  const deliveryReport = projectDeliveryReport(sy, { project: slug, limit: 100 });
  for (const delivery of deliveryReport.deliveries.filter(item => item.needsAttention)) {
    out.push(`Product delivery ${delivery.taskId} needs attention: ${delivery.reasons.join(", ")}.`);
  }
  if (deliveryReport.nextAfter) out.push("More product delivery statuses remain to review; continue the project delivery report after its first 100 entries.");
  const requests = (db.prepare("SELECT COUNT(*) AS n FROM brain_access_requests WHERE project_id = ? AND status = 'pending'").get(slug) as { n: number }).n;
  if (requests) out.push(`${requests} brain access request(s) wait for a decision.`);
  const interrupted = (db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND state = 'interrupted'").get(slug) as { n: number }).n;
  if (interrupted) out.push(`${interrupted} task(s) were interrupted and can be resumed.`);
  if (ctx) out.push(...repositoryProblems(sy.db, ctx));
  return out;
}

/** Information for the project overview: repositories MeritRouter recently created or set up with git. */
export function projectNotices(sy: MeritRouter, slug: string, now = Date.now()): string[] {
  const ctx = sy.projects.get(slug);
  return ctx ? repositoryNotices(sy.db, ctx, now) : [];
}

/**
 * Prepare repository folders (absolute paths) for a project being created or saved, recording each
 * preparation; returns the problems MeritRouter could not fix, by alias.
 */
export async function prepareRepositoryFolders(sy: MeritRouter, slug: string, repos: Array<{ alias: string; path: string }>): Promise<{ problems: Map<string, string>; done: string[] }> {
  const problems = new Map<string, string>();
  const done: string[] = [];
  for (const r of repos) {
    const result = await prepareRepository(r.path);
    recordPreparation(sy.db, sy.tasks, { project: slug, alias: r.alias, result });
    if (!result.ok) problems.set(r.alias, result.message);
    else if (result.action !== "unchanged") done.push(`repository ${r.alias}: ${result.message}`);
  }
  return { problems, done };
}

/** Running and queued counts of one project (all tasks, and top-level jobs). */
export function projectActivity(sy: MeritRouter, slug: string): Pick<ProjectCard, "runningJobs" | "queuedJobs" | "runningTasks" | "queuedTasks" | "lastActivityAt"> {
  // The project's own store (the installation's in a legacy layout); a split project without a
  // readable store has no activity to show (its attention item says why).
  const opened = openProjectStores(sy, slug);
  const r = opened.ok ? storeActivity(opened.stores.db, slug) : { runningTasks: 0, queuedTasks: 0, runningJobs: 0, queuedJobs: 0, lastTask: null };
  const touched = sy.projects.rows().find((p) => p.id === slug)?.lastActiveAt ?? null;
  const last = Math.max(r.lastTask ?? -1, touched ?? -1);
  return { runningTasks: r.runningTasks ?? 0, queuedTasks: r.queuedTasks ?? 0, runningJobs: r.runningJobs ?? 0, queuedJobs: r.queuedJobs ?? 0, lastActivityAt: last < 0 ? null : last };
}

/** Running and queued counts of one project's tasks in one store. */
function storeActivity(db: Db, slug: string) {
  return db
    .prepare(
      `SELECT SUM(state IN (${inList(RUNNING_STATES)})) AS runningTasks, SUM(state IN (${inList(QUEUED_STATES)})) AS queuedTasks,
              SUM(profile = 'supervise' AND json_extract(spec_json, '$.parentTaskId') IS NULL AND state IN (${inList(RUNNING_STATES)})) AS runningJobs,
              SUM(profile = 'supervise' AND json_extract(spec_json, '$.parentTaskId') IS NULL AND state IN (${inList(QUEUED_STATES)})) AS queuedJobs,
              MAX(updated_at) AS lastTask
         FROM tasks WHERE project_id = ?`,
    )
    .get(slug) as { runningTasks: number | null; queuedTasks: number | null; runningJobs: number | null; queuedJobs: number | null; lastTask: number | null };
}

/** The projects grid: every project with its repositories, activity, and attention. */
export function projectsGrid(sy: MeritRouter, opts: { includeArchived?: boolean } = {}): ProjectCard[] {
  return projectList(sy, opts).map((p) => {
    const attentionItems = projectAttention(sy, p.slug);
    return { ...p, ...projectActivity(sy, p.slug), attention: attentionItems.length, attentionItems };
  });
}

// ---------- create and archive ----------

export interface CreateProjectInput {
  slug: string;
  name?: string;
  /** Paths relative to the config file's folder, or absolute. */
  repositories?: Record<string, { path: string; writable?: boolean }>;
  /** Extra brain mounts for this project. */
  mounts?: Array<{ prefix: string; path: string; commit?: boolean }>;
  /**
   * The project's folder, relative to the config file's folder or absolute; persisted as
   * `projects.<slug>.directory`. Required in a split installation, where the project's private
   * store is created in `<directory>/.MeritRouter`; optional (ownership metadata only) otherwise.
   */
  directory?: string;
}

export type CreateProjectResult =
  | {
      ok: true;
      project: ProjectSummary;
      convertedLegacy: string | null;
      /** What preparing the repositories did ("repository app: MeritRouter created ..."). */
      prepared: string[];
      /** The project's own store (`<directory>/.MeritRouter`) in a split installation; null in a legacy one. */
      runtimeRoot: string | null;
    }
  | { ok: false; errors: string[] };

/**
 * Check a new project's slug and repositories. A repository folder that does not exist or is not
 * a git repository is fine (`createProject` prepares it); a path that is a file is not.
 */
export function validateNewProject(sy: MeritRouter, input: CreateProjectInput): string[] {
  const errors: string[] = [];
  if (!PROJECT_SLUG_RE.test(input.slug)) errors.push(`slug ${JSON.stringify(input.slug)}: lower-case letters, digits, '.', '_', '-', starting with a letter or digit`);
  if (sy.projects.get(input.slug)) errors.push(`project ${input.slug} already exists`);
  if (input.name !== undefined && (!input.name.trim() || input.name.length > 80)) errors.push("name: 1 to 80 characters");
  const base = path.dirname(sy.cfg.configPath);
  for (const [alias, repo] of Object.entries(input.repositories ?? {})) {
    if (!REPOSITORY_ALIAS_RE.test(alias)) {
      errors.push(`repository alias ${JSON.stringify(alias)}: letters, digits, '.', '_', '-' only`);
      continue;
    }
    if (!repo.path.trim()) {
      errors.push(`repository ${alias}: enter the repository's folder`);
      continue;
    }
    const abs = path.resolve(base, repo.path.trim());
    if (folderState(abs) === "file") errors.push(`repository ${alias}: ${abs} is a file, not a folder`);
  }
  const directory = input.directory?.trim();
  if (input.directory !== undefined && !directory) errors.push("directory: enter the project's folder");
  else if (!directory && sy.layout === "split") errors.push(`directory: enter the project's folder; this installation keeps each project's private data in <directory>/${PROJECT_RUNTIME_DIRECTORY}`);
  if (directory) {
    const abs = path.resolve(base, directory);
    if (folderState(abs) === "file") errors.push(`directory: ${abs} is a file, not a folder`);
    else {
      try { projectRuntimePaths(abs); }
      catch (error) { errors.push(`directory: ${abs}: ${(error as Error).message}`); }
    }
  }
  return errors;
}

/**
 * Prepare each repository folder (create it, set up git, commit a first snapshot, as needed; see
 * `prepareRepository`), then add `projects.<slug>` to the global config through the config editor (validated, previous file
 * backed up, running workers reload it), record the project, and create its brain folders. A
 * single-project config is first converted to the projects shape: its top-level repositories move
 * under `projects.<its slug>` (the slug every existing row already carries), and nothing else
 * changes.
 */
export async function createProject(sy: MeritRouter, input: CreateProjectInput): Promise<CreateProjectResult> {
  const errors = validateNewProject(sy, input);
  if (errors.length) return { ok: false, errors };
  const base = path.dirname(sy.cfg.configPath);
  const { problems, done: prepared } = await prepareRepositoryFolders(
    sy,
    input.slug,
    Object.entries(input.repositories ?? {}).map(([alias, r]) => ({ alias, path: path.resolve(base, r.path.trim()) })),
  );
  if (problems.size) return { ok: false, errors: [...problems].map(([alias, m]) => `repository ${alias}: ${m}`) };
  const directory = input.directory?.trim() || null;
  const split = sy.layout === "split";
  const absolute = directory ? path.resolve(base, directory) : null;
  // A split project's folder must exist before its store can be provisioned in it.
  let createdFolder: string | null = null;
  if (split && absolute && !existsSync(absolute)) {
    try { createdFolder = mkdirSync(absolute, { recursive: true }) ?? null; }
    catch (error) { return { ok: false, errors: [`directory: ${absolute} could not be created: ${(error as Error).message}`] }; }
  }
  const hadRoot = !!absolute && existsSync(path.join(absolute, PROJECT_RUNTIME_DIRECTORY));
  const entry: Record<string, unknown> = {
    ...(input.name ? { name: input.name.trim() } : {}),
    ...(directory ? { directory } : {}),
    repositories: Object.fromEntries(Object.entries(input.repositories ?? {}).map(([alias, r]) => [alias, { path: r.path, ...(r.writable === false ? { writable: false } : {}) }])),
    ...(input.mounts?.length ? { brain: { mounts: input.mounts.map((m) => ({ prefix: m.prefix, path: m.path, ...(m.commit ? { commit: true } : {}) })) } } : {}),
  };
  const patch: Array<{ path: Array<string | number>; value: unknown }> = [];
  const legacy = sy.projects.list().find((c) => c.project.legacy) ?? null;
  if (legacy) {
    // The single-project shape keeps its repositories at the top level; projects cannot sit beside them.
    const doc = YAML.parseDocument(readConfigText(sy));
    const raw = (doc.getIn(["repositories"]) as YAML.Node | undefined)?.toJSON?.() ?? {};
    patch.push({ path: ["repositories"], value: null }, { path: ["projects", legacy.project.slug], value: { repositories: raw } });
  }
  patch.push({ path: ["projects", input.slug], value: entry });
  const before = readConfigText(sy);
  const r = patchConfig(sy, patch);
  if (!r.ok) {
    removeCreatedFolder(createdFolder, absolute);
    return r;
  }
  const written = readConfigText(sy);
  if (!sy.projects.get(input.slug)) sy.reloadIfChanged();
  const ctx = sy.projects.get(input.slug);
  let runtimeRoot: string | null = null;
  if (split) {
    const registeredBefore = projectStoreRegistrations(sy.db, input.slug).some((row) => row.state === "registered");
    try {
      if (!ctx?.projectDirectory) throw new Error("the config was written but this process did not reload it; restart MeritRouter");
      runtimeRoot = (await sy.createSplitProject({ slug: input.slug, directory: ctx.projectDirectory })).paths.root;
    } catch (error) {
      const undo = await rollbackSplitCreate(sy, { slug: input.slug, before, written, absolute, hadRoot, createdFolder, registeredBefore });
      return { ok: false, errors: [`directory: the project's store could not be created: ${(error as Error).message}`, ...undo] };
    }
  }
  if (!ctx) return { ok: false, errors: ["the config was written but this process did not reload it; restart MeritRouter"] };
  sy.db.prepare("UPDATE projects SET archived_at = NULL WHERE id = ?").run(input.slug);
  await sy.brainFor(input.slug).ensure();
  return { ok: true, project: summary(sy, ctx), convertedLegacy: legacy ? legacy.project.slug : null, prepared, runtimeRoot };
}

/** Remove the folders `mkdirSync` created for a project that was not created, innermost first, while they are empty. */
function removeCreatedFolder(createdFolder: string | null, absolute: string | null): void {
  if (!createdFolder || !absolute) return;
  for (let dir = absolute; ; dir = path.dirname(dir)) {
    try { rmdirSync(dir); } catch { return; }
    if (path.resolve(dir) === path.resolve(createdFolder) || path.dirname(dir) === dir) return;
  }
}

/**
 * Undo a split project creation whose store could not be provisioned: retire a registration this
 * call made, remove the `.MeritRouter` folder it created (never one that was there before), put
 * the config back (only if it is still the file this call wrote), and remove a folder it created.
 * Returns what could not be undone.
 */
async function rollbackSplitCreate(
  sy: MeritRouter,
  o: { slug: string; before: string; written: string; absolute: string | null; hadRoot: boolean; createdFolder: string | null; registeredBefore: boolean },
): Promise<string[]> {
  const problems: string[] = [];
  if (!o.registeredBefore && projectStoreRegistrations(sy.db, o.slug).some((row) => row.state === "registered")) {
    try { await sy.retireProject(o.slug); }
    catch (error) { problems.push(`its partly created store could not be retired: ${(error as Error).message}`); }
  }
  if (o.absolute && !o.hadRoot) {
    const root = path.join(o.absolute, PROJECT_RUNTIME_DIRECTORY);
    try { removeCreatedRuntimeRoot(root); }
    catch (error) { problems.push(`its partly created store ${root} could not be removed: ${(error as Error).message}`); }
  }
  const restored = writeConfigText(sy, o.before, { expectedText: o.written });
  if (!restored.ok) problems.push(`projects.${o.slug} stays in the config: ${restored.errors.join("; ")}`);
  else if (sy.projects.get(o.slug)) sy.reloadIfChanged();
  removeCreatedFolder(o.createdFolder, o.absolute);
  return problems;
}

/**
 * Archive a project: it leaves the grid, project pickers, and implicit selection, and keeps its
 * settings, tasks, sessions, and brain. Refused while it has running or queued tasks.
 */
export function archiveProject(sy: MeritRouter, slug: string, now = Date.now()): ProjectSummary {
  return immediate(sy.db, () => {
    sy.reloadIfChanged();
    const info = projectInfo(sy, slug);
    const a = projectActivity(sy, slug);
    if (a.runningTasks + a.queuedTasks > 0) throw new MeritRouterError("usage", `project ${slug} has ${a.runningTasks} running and ${a.queuedTasks} queued task(s); cancel them or let them finish before archiving`);
    if (!info.archived) sy.db.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").run(now, slug);
    return projectInfo(sy, slug);
  });
}

/** Bring an archived project back. */
export function unarchiveProject(sy: MeritRouter, slug: string): ProjectSummary {
  return immediate(sy.db, () => {
    sy.reloadIfChanged();
    projectInfo(sy, slug);
    sy.db.prepare("UPDATE projects SET archived_at = NULL WHERE id = ?").run(slug);
    return projectInfo(sy, slug);
  });
}

// ---------- delete ----------

/** Task states that block deleting a project (running and queued). */
const ACTIVE_STATES = [...RUNNING_STATES, ...QUEUED_STATES] as const;

export interface ProjectDeletionCounts {
  tasks: number;
  jobs: number;
  sessions: number;
  artifacts: number;
  /** Files under the project's brain folder (`projects/<slug>/`). */
  brainEntries: number;
  worktrees: number;
}

export interface ProjectDeletionPreview {
  slug: string;
  name: string;
  archived: boolean;
  legacy: boolean;
  counts: ProjectDeletionCounts;
  /** Kept for accounting: model requests recorded for the project, and those with paid spend. */
  kept: { requests: number; paidRequests: number; repositories: Array<{ alias: string; path: string }> };
  /** What deleting removes and what it keeps, as sentences with the counts (for the panel and CLI). */
  removes: string[];
  keeps: string[];
  /** Why the project cannot be deleted now; empty when it can. */
  blockers: string[];
  /** Conservative accounting and quarantined physical transport retained outside project scope. */
  retainedRequests: { pendingRequests: number; retainedTransportHolds: number };
  /** Where the project's data lives: the installation's store (`legacy`) or its own (`split`). */
  layout: "legacy" | "split";
  /** Split layout: the project's own store folder that deleting removes; null when there is none. */
  runtimeRoot: string | null;
}

export interface ProjectDeletionResult {
  slug: string;
  removed: ProjectDeletionCounts;
  /** The brain commit that removed `projects/<slug>/`, when the brain commits. */
  brainCommit: string | null;
  /** The project that is now the primary one (`brain.project`) when the deleted project was. */
  newPrimary: string | null;
  /** Session/artifact files that could not be removed after confirmed publication and row purge. */
  problems: string[];
  retainedRequests: { pendingRequests: number; retainedTransportHolds: number };
  /** Split layout: the project's store folder that was removed; null when none was (legacy, or already gone). */
  runtimeRoot: string | null;
}

const plural =(n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Why a project cannot be deleted now: running or queued tasks, retained Labs or claims, the last
 * live project, or the single-project config. `db` is the store holding the project's rows (the
 * installation's in a legacy layout, the project's own in a split one); null when a split project
 * has no open store, so only the config-level checks apply.
 */
function deletionBlockers(sy: MeritRouter, info: ProjectSummary, allowTaskPrune = false, db: Db | null = sy.db): string[] {
  const out: string[] = [];
  if (db) {
    const commandOwners = db.prepare("SELECT count(*) AS n FROM lab_command_owners WHERE project_id=?").get(info.slug) as { n: number };
    if (commandOwners.n) out.push(`it has ${commandOwners.n} retained Lab command owner(s); prove kernel process quiescence through owned Lab recovery before deletion`);
    if (db.prepare("SELECT 1 FROM lab_capacity_owners WHERE project_id=? LIMIT 1").get(info.slug)) out.push("it has a retained Lab capacity owner; finish exact command retirement and capacity reconciliation before deletion");
    if (db.prepare("SELECT 1 FROM project_execution_claims WHERE project_id=? AND phase!='terminal' LIMIT 1").get(info.slug)) out.push("it has unreconciled project execution claims; finish exact grant reconciliation before deletion");
    try { new RequestReceipts(db).assertProjectPurge(info.slug); }
    catch (error) { out.push(`request cleanup cannot prove safe project ownership: ${(error as Error).message}`); }
    const labs = db.prepare("SELECT count(*) AS n FROM labs WHERE project_id = ? AND state != 'destroyed' AND (?=0 OR kind!='task_attempt' OR state!='stopped')").get(info.slug, allowTaskPrune ? 1 : 0) as { n: number };
    if (labs.n) out.push(`it has ${labs.n} retained or unresolved lab(s); destroy retained Labs or finish owned task-Lab cleanup first`);
    const a = storeActivity(db, info.slug);
    const running = a.runningTasks ?? 0, queued = a.queuedTasks ?? 0;
    if (running + queued > 0) out.push(`it has ${running} running and ${queued} queued task(s); cancel them or let them finish first`);
  }
  if (info.legacy) out.push("it is the single-project config itself; an install needs at least one project");
  else if (!projectList(sy).some((p) => p.slug !== info.slug)) {
    out.push(sy.projects.list().length === 1 ? "it is the only project; an install needs at least one" : "it is the last project that is not archived; unarchive or create another first");
  }
  return out;
}

function footprintOf(sy: MeritRouter, ctx: ProjectContext) {
  return projectFootprint(sy.db, sy.cfg.storageDir, ctx.project.slug, Object.values(ctx.repositoryPaths).map((r) => r.path));
}

/** What deleting a project removes and keeps, with counts, and whether it can be deleted now. */
export async function previewProjectDeletion(sy: MeritRouter, slug: string): Promise<ProjectDeletionPreview> {
  const info = projectInfo(sy, slug);
  if (sy.layout === "split") return previewSplitDeletion(sy, info);
  const fp = await footprintOf(sy, sy.projects.get(slug)!);
  const counts: ProjectDeletionCounts = { tasks: fp.taskIds.length, jobs: fp.jobs, sessions: fp.sessions, artifacts: fp.artifacts, brainEntries: sy.brain.projectFolderFiles(slug), worktrees: fp.worktrees.length };
  const repositories = info.repositories.map((r) => ({ alias: r.alias, path: r.path }));
  const retainedRequests = new RequestReceipts(sy.db).retention(slug);
  return {
    slug,
    name: info.name,
    archived: info.archived,
    legacy: info.legacy,
    counts,
    kept: { requests: fp.requests, paidRequests: fp.paidRequests, repositories },
    removes: [
      `Its settings: projects.${slug} in the config (the previous file is kept as a .bak).`,
      `${plural(counts.tasks, "task")} (${counts.jobs} of them ${counts.jobs === 1 ? "a job" : "jobs"}) with their results, plans, questions, and team channels.`,
      `${plural(counts.sessions, "session")} with ${counts.sessions === 1 ? "its log" : "their logs"}, and ${plural(counts.artifacts, "artifact")}.`,
      `${plural(fp.requestCaptures.captures, "private model request capture")} (${fp.requestCaptures.bytes.toLocaleString()} bytes), including shared payloads containing this project's data. Accounting history stays.`,
      "Stopped task verification Labs are removed only after terminal-task, resource ownership and clean Git identity checks; unresolved cleanup blocks deletion.",
      `${plural(counts.worktrees, "worktree")} MeritRouter made for its tasks (their branches stay).`,
      `Its brain folder projects/${slug}/ (${plural(counts.brainEntries, "file")}), removed in one brain commit.`,
    ],
    keeps: [
      repositories.length === 1 ? "Its repository folder and every branch in it, untouched." : `${plural(repositories.length, "repository folder")} and every branch in them, untouched.`,
      `${plural(fp.requests, "model request")} (${fp.paidRequests} paid), with their charges and spend, for accounting; they no longer belong to a project.`,
      "The brain's history: the removed folder stays in its git log.",
      `${retainedRequests.pendingRequests} pending model request(s) are revoked without retry; dispatched requests with unknown outcomes retain conservative charges. ${retainedRequests.retainedTransportHolds} physical transport hold(s) remain quarantined outside the project until safe recovery; deleting the project does not cancel remote billing. Minimal opaque anti-replay records remain.`,
    ],
    blockers: deletionBlockers(sy, info, true),
    retainedRequests,
    layout: "legacy",
    runtimeRoot: null,
  };
}

/**
 * Delete a project. `confirm` must equal the slug. Refused while it has running or queued tasks,
 * and for the last live project. The config edit is validated first; then its rows go in one
 * transaction (see `purgeProjectRows`), `projects.<slug>` is removed through the config editor
 * (previous file backed up; when it was the primary project, `brain.project` moves to another),
 * and its session logs, artifacts, MeritRouter worktrees (branches kept), and brain folder (one
 * commit) are removed. Repository folders are never touched.
 */
export async function deleteProject(sy: MeritRouter, slug: string, opts: { confirm: string }): Promise<ProjectDeletionResult> {
  const info = projectInfo(sy, slug);
  if (opts.confirm !== slug) throw new MeritRouterError("usage", `type the project's slug to confirm: expected ${JSON.stringify(slug)}, got ${JSON.stringify(opts.confirm)}`);
  const blockers = deletionBlockers(sy, info, true);
  if (blockers.length) throw new MeritRouterError("usage", `project ${slug} cannot be deleted: ${blockers.join("; ")}`);

  // The config without the project, validated before anything is removed.
  const original = readConfigText(sy);
  const doc = YAML.parseDocument(original);
  doc.deleteIn(["projects", slug]);
  let newPrimary: string | null = null;
  if (sy.projects.primary.project.slug === slug) {
    newPrimary = projectList(sy).find((p) => p.slug !== slug)?.slug ?? null;
    if (newPrimary) doc.setIn(["brain", "project"], newPrimary);
  }
  const text = doc.toString();
  const valid = validateConfigText(text, sy.cfg.configPath);
  if (!valid.ok) throw new MeritRouterError("config_invalid", `the config without projects.${slug} does not validate:\n  ${valid.errors.join("\n  ")}`);
  if (sy.layout === "split") return deleteSplitProject(sy, info, { original, text, newPrimary });

  const context = sy.projects.get(slug)!;
  const repositories = Object.values(context.repositoryPaths).map(repo => repo.path);
  const keeper = newPrimary ?? projectList(sy).find(project => project.slug !== slug)!.slug;
  const brain = sy.brainFor(keeper);
  const initial = await footprintOf(sy, context);
  // Read-only discovery proves every physical owner before a lifecycle lock is written.
  await projectMutationRepositories(sy.db, initial, repositories, brain.root);
  const owners = [...repositories, ...(existsSync(brain.root) ? [brain.root] : [])];
  const perform = async (mutation?: RepositoryMutationCapability): Promise<ProjectDeletionResult> => {
    const beforeCleanup = await footprintOf(sy, context);
    const admission = await projectMutationRepositories(sy.db, beforeCleanup, repositories, brain.root);
    // A large history can have many worktrees sharing a few physical owners. Admission batches
    // stay bounded while the outer owner capability remains held through the entire lifecycle.
    for (let offset = 0; offset < admission.length; offset += 64)
      await withRepositoryMutation(admission.slice(offset, offset + 64), async () => undefined, { capability: mutation });
    // Confirmed deletion may bypass retention age, never positive ownership checks.
    // Validate config first; the prune keeps recovery proof on any partial refusal.
    const cleanup = await sy.labs.taskAttempts.pruneProject(slug, { mutation });
    if (cleanup.blocked) throw new MeritRouterError("usage", `project ${slug} has ${cleanup.blocked} task Lab cleanup(s) that could not be proved safe; recovery evidence was retained`);
    const afterCleanup = deletionBlockers(sy, projectInfo(sy, slug));
    if (afterCleanup.length) throw new MeritRouterError("usage", `project ${slug} cannot be deleted: ${afterCleanup.join("; ")}`);
    const fp = await footprintOf(sy, sy.projects.get(slug)!);
    const covered = new Set([...repositories, brain.root, ...fp.worktrees.map(worktree => worktree.path)].map(root => process.platform === "win32" ? path.resolve(root).toLowerCase() : path.resolve(root)));
    const retained = await projectMutationRepositories(sy.db, fp, repositories, brain.root);
    for (const root of retained) if (!covered.has(process.platform === "win32" ? path.resolve(root).toLowerCase() : path.resolve(root)))
      throw new RepositoryMutationError("ownership_changed", `Retained workspace ${root} is outside the authorized deletion footprint; project-local layout migration/deletion manifest recovery is required before purge`);
    const brainEntries = sy.brain.projectFolderFiles(slug);
    // Destructive Git cleanup precedes config/row purge, so failure retains the authority and
    // accounting context required to recover. There is no rollback claim for partial cleanup.
    const wt = await removeProjectWorktrees(fp.worktrees, { mutation });
    let brainCommit: string | null = null;
    if (existsSync(brain.root)) brainCommit = (await brain.removeProjectFolder(slug, { agent: "human", role: "human" }, `project ${slug} was deleted`, { mutation, deferPush: true })).commit;
    let configWritten = false;
    let purged: ReturnType<typeof purgeProjectRows>;
    try {
      purged = immediate(sy.db, () => {
        // Footprint discovery yields to other services. Serialize the final lifecycle/config
        // checks with archive writes, submissions, and other deletions before removing anything.
        if (readConfigText(sy) !== original) throw new MeritRouterError("config_changed", "The config changed during project deletion; reload it and retry.");
        sy.reloadIfChanged();
        const currentBlockers = deletionBlockers(sy, projectInfo(sy, slug));
        if (currentBlockers.length) throw new MeritRouterError("usage", `project ${slug} cannot be deleted: ${currentBlockers.join("; ")}`);
        const written = writeConfigText(sy, text, { expectedText: original });
        if (!written.ok) throw new MeritRouterError("config_write_failed", `the config could not be written: ${written.errors.join("; ")}`);
        configWritten = true;
        return purgeProjectRows(sy.db, slug, ACTIVE_STATES);
      });
    } catch (error) {
      // SQLite rolls the rows back if purge fails. Restore the file only if it is still the
      // exact file we wrote; an intervening external editor must never be overwritten.
      if (configWritten) {
        const restored = writeConfigText(sy, original, { expectedText: text });
        if (!restored.ok) throw new MeritRouterError("config_restore_failed", `${(error as Error).message}; the config could not be restored: ${restored.errors.join("; ")}`);
      }
      if (wt.removed || brainEntries || brainCommit) throw new RepositoryMutationError("ownership_changed", `Project ${slug} repository cleanup partially completed before config/row finalization failed: ${(error as Error).message}. Retained rows/config describe recovery context; removed files were not rolled back`);
      throw error;
    }
    const problems: string[] = [];
    if (sy.projects.get(slug)) sy.reloadIfChanged();
    // A process that reloaded the config between the purge and the write may have recorded the row again.
    sy.db.prepare("DELETE FROM projects WHERE id = ?").run(slug);
    problems.push(...removeProjectFiles(fp));
    return {
      slug,
      removed: { tasks: purged.tasks, jobs: fp.jobs, sessions: purged.sessions, artifacts: fp.artifacts, brainEntries, worktrees: wt.removed },
      brainCommit,
      newPrimary,
      problems,
      retainedRequests: { pendingRequests: purged.pendingRequests, retainedTransportHolds: purged.retainedTransportHolds },
      runtimeRoot: null,
    };
  };
  const result = owners.length ? await withRepositoryMutation(owners, perform) : await perform();
  await brain.pushPending(); // Remote waits must never hold project/common-Git mutation authority.
  return result;
}

// ---------- delete (split installations) ----------

/** The installation's own folders a project's store must never overlap. */
const installationRoots = (sy: MeritRouter) => [path.dirname(sy.cfg.configPath), sy.cfg.storageDir];
const pathKey = (value: string) => (process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value));
const NO_RETAINED = { pendingRequests: 0, retainedTransportHolds: 0 };
const NO_STORE = { taskIds: [] as string[], jobs: 0, sessions: 0, artifacts: 0, requests: 0 };

function orElse<T>(read: () => T, fallback: T): T {
  try { return read(); } catch { return fallback; }
}

/** What deleting a split project acts on: its store registration, folder and open database. */
interface SplitDeletionTarget {
  /** The live registration, or a retired one whose folder an interrupted deletion left in place. */
  registration: ProjectStoreRegistration | null;
  live: boolean;
  /** The live store's database; null when the store is retired, missing, or cannot be opened. */
  db: Db | null;
  paths: ProjectRuntimePaths | null;
  /** The store folder exists (and was verified as the registration's own). */
  present: boolean;
  blockers: string[];
}

function splitDeletionTarget(sy: MeritRouter, slug: string): SplitDeletionTarget {
  const ctx = sy.projects.get(slug)!;
  const rows = projectStoreRegistrations(sy.db, slug);
  const blockers: string[] = [];
  if (rows.some((row) => row.state === "migrating")) blockers.push("its store is being migrated; finish or roll back the migration first");
  const live = rows.find((row) => row.state === "registered") ?? null;
  const retired = live
    ? null
    : (rows.find((row) => row.state === "retired" && !!ctx.projectDirectory && pathKey(row.projectDirectory) === pathKey(ctx.projectDirectory) && existsSync(path.join(row.projectDirectory, PROJECT_RUNTIME_DIRECTORY))) ?? null);
  const registration = live ?? retired;
  if (!registration) return { registration: null, live: false, db: null, paths: null, present: false, blockers };
  let paths: ProjectRuntimePaths | null = null;
  let present = false;
  try {
    ({ paths, present } = verifyProjectRuntimeRoot(registration, ctx.projectDirectory, installationRoots(sy)));
  } catch (error) {
    blockers.push((error as Error).message);
  }
  let db: Db | null = null;
  if (live) {
    const opened = openProjectStores(sy, slug);
    if (opened.ok) db = opened.stores.db;
    else blockers.push(`its store cannot be opened (${opened.marker.reason}), so it cannot be shown to be idle`);
  }
  return { registration, live: !!live, db, paths, present, blockers };
}

/** Read a retired (closed) project store read-only; `fallback` when it cannot be read. */
function readRetiredStore<T>(paths: ProjectRuntimePaths, fallback: T, read: (db: Db) => T): T {
  let db: Db | null = null;
  try {
    db = openDatabase(paths.state, { readonly: true, fileMustExist: true });
    return read(db);
  } catch {
    return fallback;
  } finally {
    db?.close();
  }
}

/** Repository folders a store's workspaces and Labs used (their worktrees may live in the store folder). */
function storeSources(db: Db): string[] {
  const sources = db.prepare("SELECT DISTINCT source_path FROM workspaces").pluck().all() as string[];
  for (const json of db.prepare("SELECT repositories_json FROM labs").pluck().all() as string[]) {
    try {
      for (const repo of z.array(LabRepositorySchema).parse(JSON.parse(json))) sources.push(repo.source);
    } catch {
      /* an unreadable Lab row names no source */
    }
  }
  return sources;
}

async function previewSplitDeletion(sy: MeritRouter, info: ProjectSummary): Promise<ProjectDeletionPreview> {
  const slug = info.slug;
  const ctx = sy.projects.get(slug)!;
  const target = splitDeletionTarget(sy, slug);
  const repositories = info.repositories.map((r) => ({ alias: r.alias, path: r.path }));
  const retired = target.paths && target.present && !target.db ? target.paths : null;
  const store = target.db ? projectStoreCounts(target.db) : retired ? readRetiredStore(retired, NO_STORE, projectStoreCounts) : NO_STORE;
  const sources = target.db ? storeSources(target.db) : retired ? readRetiredStore(retired, [], storeSources) : [];
  const worktrees = target.paths && target.present ? await runtimeRootWorktrees(target.paths.root, [...repositories.map((r) => r.path), ...sources]).catch(() => []) : [];
  const brainEntries = target.db ? orElse(() => sy.brainFor(slug).projectFolderFiles(slug), 0) : 0;
  const accounting = target.registration ? projectAccounting(sy.db, target.registration.projectId) : { requests: 0, paidRequests: 0, unsettled: 0 };
  const retainedRequests = target.db ? orElse(() => new RequestReceipts(target.db!).retention(slug), NO_RETAINED) : NO_RETAINED;
  const counts: ProjectDeletionCounts = { tasks: store.taskIds.length, jobs: store.jobs, sessions: store.sessions, artifacts: store.artifacts, brainEntries, worktrees: worktrees.length };
  const root = target.paths && target.present ? target.paths.root : null;
  return {
    slug,
    name: info.name,
    archived: info.archived,
    legacy: info.legacy,
    counts,
    kept: { requests: accounting.requests, paidRequests: accounting.paidRequests, repositories },
    removes: [
      `Its settings: projects.${slug} in the config (the previous file is kept as a .bak).`,
      root
        ? `Its own store ${root} and everything in it: ${plural(counts.tasks, "task")} (${counts.jobs} of them ${counts.jobs === 1 ? "a job" : "jobs"}) with their results, plans, questions, and team channels; ${plural(counts.sessions, "session")} with ${counts.sessions === 1 ? "its log" : "their logs"}; ${plural(counts.artifacts, "artifact")}; ${plural(store.requests, "recorded model request")} with their private captures; and its brain (${plural(counts.brainEntries, "file")}).`
        : "It has no store folder to remove.",
      "Stopped task verification Labs are removed only after terminal-task, resource ownership and clean Git checks; unresolved cleanup blocks deletion.",
      `${plural(counts.worktrees, "worktree")} MeritRouter made in that folder, unregistered from their repositories with git (their branches stay).`,
    ],
    keeps: [
      repositories.length === 1 ? "Its repository folder and every branch in it, untouched." : `${plural(repositories.length, "repository folder")} and every branch in them, untouched.`,
      ctx.projectDirectory ? `The project folder ${ctx.projectDirectory} and everything in it outside ${PROJECT_RUNTIME_DIRECTORY}.` : "Every folder outside the project's store.",
      `${plural(accounting.requests, "physical model request")} (${accounting.paidRequests} paid) in the installation's accounting, with their charges and spend.${accounting.unsettled ? ` ${accounting.unsettled} not yet settled keep conservative charges; deleting the project does not cancel remote billing.` : ""}`,
      "The store's retired registration, so its identity is never reused.",
    ],
    blockers: [...target.blockers, ...deletionBlockers(sy, info, true, target.db)],
    retainedRequests,
    layout: "split",
    runtimeRoot: root,
  };
}

/**
 * Delete a split project (`deleteProject` has confirmed the slug and validated the config without
 * it). Refused while it has running or queued tasks or retained Labs, like a legacy project. Its
 * stopped task Labs are pruned, its runtime is retired (dispatch stopped, store and Labs closed),
 * the worktrees MeritRouter made in its store folder are removed with git (branches kept), and
 * `<directory>/.MeritRouter` is removed after it is proved to be the registered store folder;
 * nothing else on disk is touched. Then `projects.<slug>` leaves the config. The installation's
 * accounting and the retired registration (the tombstone) stay. A deletion interrupted after the
 * retirement is finished by running it again.
 */
async function deleteSplitProject(sy: MeritRouter, info: ProjectSummary, o: { original: string; text: string; newPrimary: string | null }): Promise<ProjectDeletionResult> {
  const slug = info.slug;
  const ctx = sy.projects.get(slug)!;
  const refuse = (blockers: string[]) => {
    if (blockers.length) throw new MeritRouterError("usage", `project ${slug} cannot be deleted: ${blockers.join("; ")}`);
  };
  let target = splitDeletionTarget(sy, slug);
  refuse([...target.blockers, ...deletionBlockers(sy, info, true, target.db)]);
  const repositories = Object.values(ctx.repositoryPaths).map((repo) => repo.path);
  let store = NO_STORE;
  let sources: string[] = [];
  let brainEntries = 0;
  let retainedRequests = NO_RETAINED;
  if (target.live) {
    // Stopped task verification Labs go through the project's own Lab manager while it is open.
    const cleanup = await sy.labsFor(slug).taskAttempts.pruneProject(slug);
    if (cleanup.blocked) throw new MeritRouterError("usage", `project ${slug} has ${cleanup.blocked} task Lab cleanup(s) that could not be proved safe; recovery evidence was retained`);
    target = splitDeletionTarget(sy, slug);
    const db = target.db;
    if (!db || !target.live) throw new MeritRouterError("usage", `project ${slug}'s store changed during deletion; retry`);
    brainEntries = orElse(() => sy.brainFor(slug).projectFolderFiles(slug), 0);
    sources = storeSources(db);
    retainedRequests = orElse(() => new RequestReceipts(db).retention(slug), NO_RETAINED);
    // The last checks and the retirement run with no await between them: retiring fences new work
    // on the project before it first yields, so nothing can start in this process in between.
    refuse([...target.blockers, ...deletionBlockers(sy, projectInfo(sy, slug), false, db)]);
    if (readConfigText(sy) !== o.original) throw new MeritRouterError("config_changed", "The config changed during project deletion; reload it and retry.");
    store = projectStoreCounts(db);
    const snapshot = projectTaskSnapshot(db);
    const retired = await sy.retireProject(slug);
    if (readRetiredStore(retired.paths, null, projectTaskSnapshot) !== snapshot)
      throw new MeritRouterError("usage", `project ${slug}'s tasks changed while its store was being closed; its store is retired and its files are kept. Delete it again to finish.`);
  } else if (target.paths && target.present) {
    // An earlier deletion retired the store but did not finish removing it.
    store = readRetiredStore(target.paths, NO_STORE, projectStoreCounts);
    sources = readRetiredStore(target.paths, [], storeSources);
  }
  let worktrees = 0;
  let runtimeRoot: string | null = null;
  if (target.registration && target.paths && target.present) {
    // Worktrees first (natively, so their repositories forget them), then the verified folder.
    worktrees = (await removeProjectWorktrees(await runtimeRootWorktrees(target.paths.root, [...repositories, ...sources]))).removed;
    if (removeProjectRuntimeRoot(target.registration, ctx.projectDirectory, installationRoots(sy))) runtimeRoot = target.paths.root;
  }
  // The config without the project, and the installation's lifecycle rows for it. Its accounting
  // (physical requests, charges, spend) and its retired registration stay.
  immediate(sy.db, () => {
    if (readConfigText(sy) !== o.original) throw new MeritRouterError("config_changed", `The config changed during project deletion; ${runtimeRoot ? "the project's store was removed, but " : ""}projects.${slug} stays. Reload and delete it again to finish.`);
    const written = writeConfigText(sy, o.text, { expectedText: o.original });
    if (!written.ok) throw new MeritRouterError("config_write_failed", `the config could not be written: ${written.errors.join("; ")}`);
    sy.db
      .prepare("DELETE FROM events WHERE project_id = ? OR (type = 'repository_prepare' AND (CASE WHEN json_valid(data_json) THEN json_extract(data_json, '$.project') END) = ?)")
      .run(slug, slug);
    sy.db.prepare("DELETE FROM projects WHERE id = ?").run(slug);
  });
  if (sy.projects.get(slug)) sy.reloadIfChanged();
  // A process that reloaded the config in between may have recorded the row again.
  sy.db.prepare("DELETE FROM projects WHERE id = ?").run(slug);
  return {
    slug,
    removed: { tasks: store.taskIds.length, jobs: store.jobs, sessions: store.sessions, artifacts: store.artifacts, brainEntries, worktrees },
    brainCommit: null,
    newPrimary: o.newPrimary,
    problems: [],
    retainedRequests,
    runtimeRoot,
  };
}
