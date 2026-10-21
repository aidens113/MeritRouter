import path from "node:path";
import { z } from "zod";
import type { Db } from "../storage/db.js";
import type { TaskStore } from "../storage/tasks.js";
import { folderState, prepareRepository, type PrepareResult } from "../workspaces/repository-prepare.js";
import type { ProjectContext } from "./context.js";
import type { ProjectRegistry } from "./registry.js";

// Projects' repositories are prepared (see `prepareRepository`) when a project is created, when its
// repositories are saved, when a service starts or reloads its config, and before doctor checks
// them. Every preparation that did something, or failed, is recorded as a `repository_prepare`
// event; the project overview shows the recent ones as notices and the failures as attention.

export const REPOSITORY_PREPARE_EVENT = "repository_prepare";

/** How long a successful preparation stays on the project overview as a notice. */
export const PREPARE_NOTICE_MS = 7 * 24 * 3_600_000;

export interface RepositoryPreparation {
  project: string;
  alias: string;
  result: PrepareResult;
}

const PrepareEventSchema = z.object({
  project: z.string(),
  alias: z.string(),
  path: z.string(),
  action: z.enum(["created", "initialized", "snapshot", "error"]),
  error: z.string().optional(),
  message: z.string(),
});
type PrepareEvent = z.infer<typeof PrepareEventSchema>;

const samePath = (a: string, b: string) => (process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));

interface StoredPrepareEvent {
  ts: number;
  data: PrepareEvent;
}

/** The project's preparation events, newest first. */
function prepareEvents(db: Db, project: string, limit = 200): StoredPrepareEvent[] {
  const rows = db
    .prepare("SELECT ts, data_json FROM events WHERE task_id IS NULL AND type = ? AND json_extract(data_json, '$.project') = ? ORDER BY id DESC LIMIT ?")
    .all(REPOSITORY_PREPARE_EVENT, project, limit) as Array<{ ts: number; data_json: string | null }>;
  const out: StoredPrepareEvent[] = [];
  for (const r of rows) {
    try {
      const p = PrepareEventSchema.safeParse(JSON.parse(r.data_json ?? "null"));
      if (p.success) out.push({ ts: r.ts, data: p.data });
    } catch {
      // A malformed row is skipped.
    }
  }
  return out;
}

/** The latest preparation event of one repository (alias at that folder), if any. */
function latestFor(events: StoredPrepareEvent[], alias: string, dir: string): StoredPrepareEvent | undefined {
  return events.find((e) => e.data.alias === alias && samePath(e.data.path, dir));
}

/**
 * Record what a preparation did. Unchanged repositories are not recorded, and a failure is
 * recorded once until something changes (the same failure on every page load is not news).
 */
export function recordPreparation(db: Db, tasks: TaskStore, prep: RepositoryPreparation): void {
  const r = prep.result;
  if (r.ok && r.action === "unchanged") return;
  const data: PrepareEvent = r.ok
    ? { project: prep.project, alias: prep.alias, path: r.path, action: r.action as Exclude<typeof r.action, "unchanged">, message: r.message }
    : { project: prep.project, alias: prep.alias, path: r.path, action: "error", error: r.error, message: r.message };
  if (!r.ok) {
    const last = latestFor(prepareEvents(db, prep.project, 50), prep.alias, r.path);
    if (last?.data.action === "error" && last.data.message === r.message) return;
  }
  tasks.event(null, REPOSITORY_PREPARE_EVENT, data);
}

export interface RepositorySetupDeps {
  db: Db;
  tasks: TaskStore;
  projects: ProjectRegistry;
}

/**
 * Prepare the configured repositories of every project (or of `projects`), recording each
 * preparation. A folder shared by several projects is prepared once and recorded for each.
 */
export async function prepareProjectRepositories(deps: RepositorySetupDeps, opts: { projects?: string[] } = {}): Promise<RepositoryPreparation[]> {
  const contexts: ProjectContext[] = opts.projects ? opts.projects.map((s) => deps.projects.get(s)).filter((c): c is ProjectContext => c !== undefined) : deps.projects.list();
  const byPath = new Map<string, Promise<PrepareResult>>();
  const out: RepositoryPreparation[] = [];
  for (const ctx of contexts) {
    for (const [alias, repo] of Object.entries(ctx.repositoryPaths)) {
      const key = process.platform === "win32" ? path.resolve(repo.path).toLowerCase() : path.resolve(repo.path);
      let p = byPath.get(key);
      if (!p) {
        p = prepareRepository(repo.path);
        byPath.set(key, p);
      }
      const prep = { project: ctx.project.slug, alias, result: await p };
      recordPreparation(deps.db, deps.tasks, prep);
      out.push(prep);
    }
  }
  return out;
}

/**
 * The project overview's notices: each configured repository's latest successful preparation
 * from the last `PREPARE_NOTICE_MS` ("SwitchYard created D:\my-app and set up git").
 */
export function repositoryNotices(db: Db, ctx: ProjectContext, now: number): string[] {
  const events = prepareEvents(db, ctx.project.slug);
  const out: string[] = [];
  for (const [alias, repo] of Object.entries(ctx.repositoryPaths)) {
    const last = latestFor(events, alias, repo.path);
    if (!last || last.data.action === "error" || now - last.ts > PREPARE_NOTICE_MS) continue;
    out.push(`Repository ${alias}: ${last.data.message}.`);
  }
  return out;
}

/**
 * What still needs a person about the project's repositories: the problems preparation cannot fix
 * (git missing, a file where the folder should be, permissions). A folder not prepared yet is not
 * a problem: it is prepared on the next service start, save, or overview load.
 */
export function repositoryProblems(db: Db, ctx: ProjectContext): string[] {
  const events = prepareEvents(db, ctx.project.slug);
  const out: string[] = [];
  for (const [alias, repo] of Object.entries(ctx.repositoryPaths)) {
    const state = folderState(repo.path);
    if (state === "repository" || state === "unknown") continue;
    if (state === "file") {
      out.push(`Repository ${alias}: ${repo.path} is a file, not a folder. Choose a folder in the project settings.`);
      continue;
    }
    const last = latestFor(events, alias, repo.path);
    if (last?.data.action === "error") out.push(`Repository ${alias} could not be set up: ${last.data.message}`);
  }
  return out;
}
