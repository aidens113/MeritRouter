import { existsSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { PROJECT_SLUG_RE, REPOSITORY_ALIAS_RE } from "../config/schema.js";
import { SwitchyardError } from "../core/errors.js";
import type { Switchyard } from "../core/service.js";
import type { ProjectContext } from "../projects/context.js";
import type { SelectableProject } from "../cli/project-select.js";
import { recordPreparation, repositoryNotices, repositoryProblems } from "../projects/repository-setup.js";
import { folderState, prepareRepository } from "../workspaces/repository-prepare.js";
import { patchConfig, readConfigText, validateConfigText, writeConfigText } from "./config-edit.js";
import { projectFootprint, purgeProjectRows, removeProjectFiles, removeProjectWorktrees } from "../projects/deletion.js";
import { immediate } from "../storage/db.js";

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

function summary(sy: Switchyard, ctx: ProjectContext): ProjectSummary {
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
export function projectList(sy: Switchyard, opts: { includeArchived?: boolean } = {}): ProjectSummary[] {
  return sy.projects
    .list()
    .map((c) => summary(sy, c))
    .filter((p) => opts.includeArchived || !p.archived);
}

/** One configured project; throws not_found for an unknown slug. */
export function projectInfo(sy: Switchyard, slug: string): ProjectSummary {
  const ctx = sy.projects.get(slug);
  if (!ctx) throw new SwitchyardError("not_found", `unknown project ${slug}; projects: ${sy.projects.slugs().join(", ") || "none"}`);
  return summary(sy, ctx);
}

/**
 * The settings a task's views read (its project's verification, team, and supervisor overrides):
 * its project's context (the internal `_qualification` project for qualification and comparison
 * work), or the primary project's for a task whose project is unassigned or no longer configured
 * (views never fail on old rows).
 */
export function contextOfTask(sy: Switchyard, taskId: string): ProjectContext {
  const p = sy.tasks.projectOf(taskId);
  return (p ? sy.projects.context(p) : undefined) ?? sy.projects.primary;
}

/** Every configured project as the CLI and MCP choose among them (archived ones included, marked). */
export function selectableProjects(sy: Switchyard): SelectableProject[] {
  return projectList(sy, { includeArchived: true }).map((p) => ({ slug: p.slug, archived: p.archived, repositoryPaths: Object.fromEntries(p.repositories.map((r) => [r.alias, { path: r.path }])) }));
}

/**
 * What needs a person in one project: questions supervisors wait on, results waiting for an
 * acceptance decision, brain access requests, interrupted tasks, and repositories SwitchYard
 * could not set up itself (git missing, a file where the folder should be, permissions). A
 * missing folder or one without git is not listed: SwitchYard prepares it (see `projectNotices`).
 */
export function projectAttention(sy: Switchyard, slug: string): string[] {
  const out: string[] = [];
  const questions = sy.questions({ project: slug }).length;
  if (questions) out.push(`${questions} question(s) from supervisors are waiting for an answer.`);
  const awaiting = (sy.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND state = 'completed' AND json_extract(result_json, '$.acceptanceStatus') = 'needs_supervisor'").get(slug) as { n: number }).n;
  if (awaiting) out.push(`${awaiting} result(s) wait for an acceptance decision.`);
  const requests = (sy.db.prepare("SELECT COUNT(*) AS n FROM brain_access_requests WHERE project_id = ? AND status = 'pending'").get(slug) as { n: number }).n;
  if (requests) out.push(`${requests} brain access request(s) wait for a decision.`);
  const interrupted = (sy.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND state = 'interrupted'").get(slug) as { n: number }).n;
  if (interrupted) out.push(`${interrupted} task(s) were interrupted and can be resumed.`);
  const ctx = sy.projects.get(slug);
  if (ctx) out.push(...repositoryProblems(sy.db, ctx));
  return out;
}

/** Information for the project overview: repositories SwitchYard recently created or set up with git. */
export function projectNotices(sy: Switchyard, slug: string, now = Date.now()): string[] {
  const ctx = sy.projects.get(slug);
  return ctx ? repositoryNotices(sy.db, ctx, now) : [];
}

/**
 * Prepare repository folders (absolute paths) for a project being created or saved, recording each
 * preparation; returns the problems SwitchYard could not fix, by alias.
 */
export async function prepareRepositoryFolders(sy: Switchyard, slug: string, repos: Array<{ alias: string; path: string }>): Promise<{ problems: Map<string, string>; done: string[] }> {
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
export function projectActivity(sy: Switchyard, slug: string): Pick<ProjectCard, "runningJobs" | "queuedJobs" | "runningTasks" | "queuedTasks" | "lastActivityAt"> {
  const r = sy.db
    .prepare(
      `SELECT SUM(state IN (${inList(RUNNING_STATES)})) AS runningTasks, SUM(state IN (${inList(QUEUED_STATES)})) AS queuedTasks,
              SUM(profile = 'supervise' AND json_extract(spec_json, '$.parentTaskId') IS NULL AND state IN (${inList(RUNNING_STATES)})) AS runningJobs,
              SUM(profile = 'supervise' AND json_extract(spec_json, '$.parentTaskId') IS NULL AND state IN (${inList(QUEUED_STATES)})) AS queuedJobs,
              MAX(updated_at) AS lastTask
         FROM tasks WHERE project_id = ?`,
    )
    .get(slug) as { runningTasks: number | null; queuedTasks: number | null; runningJobs: number | null; queuedJobs: number | null; lastTask: number | null };
  const touched = sy.projects.rows().find((p) => p.id === slug)?.lastActiveAt ?? null;
  const last = Math.max(r.lastTask ?? -1, touched ?? -1);
  return { runningTasks: r.runningTasks ?? 0, queuedTasks: r.queuedTasks ?? 0, runningJobs: r.runningJobs ?? 0, queuedJobs: r.queuedJobs ?? 0, lastActivityAt: last < 0 ? null : last };
}

/** The projects grid: every project with its repositories, activity, and attention. */
export function projectsGrid(sy: Switchyard, opts: { includeArchived?: boolean } = {}): ProjectCard[] {
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
}

export type CreateProjectResult = { ok: true; project: ProjectSummary; convertedLegacy: string | null; /** What preparing the repositories did ("repository app: SwitchYard created ..."). */ prepared: string[] } | { ok: false; errors: string[] };

/**
 * Check a new project's slug and repositories. A repository folder that does not exist or is not
 * a git repository is fine (`createProject` prepares it); a path that is a file is not.
 */
export function validateNewProject(sy: Switchyard, input: CreateProjectInput): string[] {
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
export async function createProject(sy: Switchyard, input: CreateProjectInput): Promise<CreateProjectResult> {
  const errors = validateNewProject(sy, input);
  if (errors.length) return { ok: false, errors };
  const base = path.dirname(sy.cfg.configPath);
  const { problems, done: prepared } = await prepareRepositoryFolders(
    sy,
    input.slug,
    Object.entries(input.repositories ?? {}).map(([alias, r]) => ({ alias, path: path.resolve(base, r.path.trim()) })),
  );
  if (problems.size) return { ok: false, errors: [...problems].map(([alias, m]) => `repository ${alias}: ${m}`) };
  const entry: Record<string, unknown> = {
    ...(input.name ? { name: input.name.trim() } : {}),
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
  const r = patchConfig(sy, patch);
  if (!r.ok) return r;
  if (!sy.projects.get(input.slug)) sy.reloadIfChanged();
  const ctx = sy.projects.get(input.slug);
  if (!ctx) return { ok: false, errors: ["the config was written but this process did not reload it; restart SwitchYard"] };
  sy.db.prepare("UPDATE projects SET archived_at = NULL WHERE id = ?").run(input.slug);
  await sy.brainFor(input.slug).ensure();
  return { ok: true, project: summary(sy, ctx), convertedLegacy: legacy ? legacy.project.slug : null, prepared };
}

/**
 * Archive a project: it leaves the grid, project pickers, and implicit selection, and keeps its
 * settings, tasks, sessions, and brain. Refused while it has running or queued tasks.
 */
export function archiveProject(sy: Switchyard, slug: string, now = Date.now()): ProjectSummary {
  return immediate(sy.db, () => {
    sy.reloadIfChanged();
    const info = projectInfo(sy, slug);
    const a = projectActivity(sy, slug);
    if (a.runningTasks + a.queuedTasks > 0) throw new SwitchyardError("usage", `project ${slug} has ${a.runningTasks} running and ${a.queuedTasks} queued task(s); cancel them or let them finish before archiving`);
    if (!info.archived) sy.db.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").run(now, slug);
    return projectInfo(sy, slug);
  });
}

/** Bring an archived project back. */
export function unarchiveProject(sy: Switchyard, slug: string): ProjectSummary {
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
}

export interface ProjectDeletionResult {
  slug: string;
  removed: ProjectDeletionCounts;
  /** The brain commit that removed `projects/<slug>/`, when the brain commits. */
  brainCommit: string | null;
  /** The project that is now the primary one (`brain.project`) when the deleted project was. */
  newPrimary: string | null;
  /** Files or worktrees that could not be removed (the rows are gone either way). */
  problems: string[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Why a project cannot be deleted now: running or queued tasks, the last live project, or the single-project config. */
function deletionBlockers(sy: Switchyard, info: ProjectSummary): string[] {
  const out: string[] = [];
  const labs = sy.db.prepare("SELECT count(*) AS n FROM labs WHERE project_id = ? AND state != 'destroyed'").get(info.slug) as { n: number };
  if (labs.n) out.push(`it has ${labs.n} retained lab(s); destroy them first so their owned processes and worktrees can be cleaned up`);
  const a = projectActivity(sy, info.slug);
  if (a.runningTasks + a.queuedTasks > 0) out.push(`it has ${a.runningTasks} running and ${a.queuedTasks} queued task(s); cancel them or let them finish first`);
  if (info.legacy) out.push("it is the single-project config itself; an install needs at least one project");
  else if (!projectList(sy).some((p) => p.slug !== info.slug)) {
    out.push(sy.projects.list().length === 1 ? "it is the only project; an install needs at least one" : "it is the last project that is not archived; unarchive or create another first");
  }
  return out;
}

function footprintOf(sy: Switchyard, ctx: ProjectContext) {
  return projectFootprint(sy.db, sy.cfg.storageDir, ctx.project.slug, Object.values(ctx.repositoryPaths).map((r) => r.path));
}

/** What deleting a project removes and keeps, with counts, and whether it can be deleted now. */
export async function previewProjectDeletion(sy: Switchyard, slug: string): Promise<ProjectDeletionPreview> {
  const info = projectInfo(sy, slug);
  const fp = await footprintOf(sy, sy.projects.get(slug)!);
  const counts: ProjectDeletionCounts = { tasks: fp.taskIds.length, jobs: fp.jobs, sessions: fp.sessions, artifacts: fp.artifacts, brainEntries: sy.brain.projectFolderFiles(slug), worktrees: fp.worktrees.length };
  const repositories = info.repositories.map((r) => ({ alias: r.alias, path: r.path }));
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
      `${plural(counts.worktrees, "worktree")} SwitchYard made for its tasks (their branches stay).`,
      `Its brain folder projects/${slug}/ (${plural(counts.brainEntries, "file")}), removed in one brain commit.`,
    ],
    keeps: [
      repositories.length === 1 ? "Its repository folder and every branch in it, untouched." : `${plural(repositories.length, "repository folder")} and every branch in them, untouched.`,
      `${plural(fp.requests, "model request")} (${fp.paidRequests} paid), with their charges and spend, for accounting; they no longer belong to a project.`,
      "The brain's history: the removed folder stays in its git log.",
    ],
    blockers: deletionBlockers(sy, info),
  };
}

/**
 * Delete a project. `confirm` must equal the slug. Refused while it has running or queued tasks,
 * and for the last live project. The config edit is validated first; then its rows go in one
 * transaction (see `purgeProjectRows`), `projects.<slug>` is removed through the config editor
 * (previous file backed up; when it was the primary project, `brain.project` moves to another),
 * and its session logs, artifacts, SwitchYard worktrees (branches kept), and brain folder (one
 * commit) are removed. Repository folders are never touched.
 */
export async function deleteProject(sy: Switchyard, slug: string, opts: { confirm: string }): Promise<ProjectDeletionResult> {
  const info = projectInfo(sy, slug);
  if (opts.confirm !== slug) throw new SwitchyardError("usage", `type the project's slug to confirm: expected ${JSON.stringify(slug)}, got ${JSON.stringify(opts.confirm)}`);
  const blockers = deletionBlockers(sy, info);
  if (blockers.length) throw new SwitchyardError("usage", `project ${slug} cannot be deleted: ${blockers.join("; ")}`);

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
  if (!valid.ok) throw new SwitchyardError("config_invalid", `the config without projects.${slug} does not validate:\n  ${valid.errors.join("\n  ")}`);

  const fp = await footprintOf(sy, sy.projects.get(slug)!);
  const brainEntries = sy.brain.projectFolderFiles(slug);
  let configWritten = false;
  let purged: ReturnType<typeof purgeProjectRows>;
  try {
    purged = immediate(sy.db, () => {
      // Footprint discovery yields to other services. Serialize the final lifecycle/config
      // checks with archive writes, submissions, and other deletions before removing anything.
      if (readConfigText(sy) !== original) throw new SwitchyardError("config_changed", "The config changed during project deletion; reload it and retry.");
      sy.reloadIfChanged();
      const currentBlockers = deletionBlockers(sy, projectInfo(sy, slug));
      if (currentBlockers.length) throw new SwitchyardError("usage", `project ${slug} cannot be deleted: ${currentBlockers.join("; ")}`);
      const written = writeConfigText(sy, text, { expectedText: original });
      if (!written.ok) throw new SwitchyardError("config_write_failed", `the config could not be written: ${written.errors.join("; ")}`);
      configWritten = true;
      return purgeProjectRows(sy.db, slug, ACTIVE_STATES);
    });
  } catch (error) {
    // SQLite rolls the rows back if purge fails. Restore the file only if it is still the
    // exact file we wrote; an intervening external editor must never be overwritten.
    if (configWritten) {
      const restored = writeConfigText(sy, original, { expectedText: text });
      if (!restored.ok) throw new SwitchyardError("config_restore_failed", `${(error as Error).message}; the config could not be restored: ${restored.errors.join("; ")}`);
    }
    throw error;
  }
  const problems: string[] = [];
  if (sy.projects.get(slug)) sy.reloadIfChanged();
  // A process that reloaded the config between the purge and the write may have recorded the row again.
  sy.db.prepare("DELETE FROM projects WHERE id = ?").run(slug);
  problems.push(...removeProjectFiles(fp));
  const wt = await removeProjectWorktrees(fp.worktrees);
  problems.push(...wt.problems);
  let brainCommit: string | null = null;
  const keeper = sy.projects.primary.project.slug;
  if (keeper === slug || sy.projects.get(slug)) problems.push(`the brain folder projects/${slug}/ was not removed: this process has not reloaded the config yet`);
  else {
    try {
      brainCommit = (await sy.brainFor(keeper).removeProjectFolder(slug, { agent: "human", role: "human" }, `project ${slug} was deleted`)).commit;
    } catch (err) {
      problems.push(`brain folder projects/${slug}/: ${(err as Error).message}`);
    }
  }
  return {
    slug,
    removed: { tasks: purged.tasks, jobs: fp.jobs, sessions: purged.sessions, artifacts: fp.artifacts, brainEntries, worktrees: wt.removed },
    brainCommit,
    newPrimary,
    problems,
  };
}
