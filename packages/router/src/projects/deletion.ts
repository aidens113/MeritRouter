import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { SwitchyardError } from "../core/errors.js";
import { immediate, type Db } from "../storage/db.js";
import { git } from "../workspaces/git.js";

// Deleting a project (the mechanics; `admin/projects.ts` checks, confirms, and edits the config):
// what a project leaves in the store and on disk, and removing it. Its per-project rows, session
// logs, artifacts, and SwitchYard's worktrees go; model requests, their charges, and paid spend
// stay for accounting (requests are unlinked from the project); branches and the repository
// folders are never touched.

/** A git worktree SwitchYard made for one of the project's tasks or jobs. */
export interface WorktreeRef {
  /** The repository it is registered in; null for a leftover folder git no longer knows. */
  repo: string | null;
  path: string;
}

/** What a project holds in the store and on disk. */
export interface ProjectFootprint {
  slug: string;
  taskIds: string[];
  /** Top-level jobs (supervise tasks without a parent job). */
  jobs: number;
  sessions: number;
  /** Session logs (JSONL) under `<storage>/sessions`. */
  sessionLogs: string[];
  artifacts: number;
  /** Artifact files and the per-task artifact folders under `<storage>/artifacts`. */
  artifactPaths: string[];
  worktrees: WorktreeRef[];
  /** Kept: model requests recorded for the project, and those with paid spend. */
  requests: number;
  paidRequests: number;
}

const ids = (taskIds: string[]) => JSON.stringify(taskIds);
const IN_TASKS = "(SELECT value FROM json_each(@ids))";
const SESSIONS = `(project_id = @slug OR task_id IN ${IN_TASKS} OR job_id IN ${IN_TASKS})`;

function inside(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * The project's footprint. `repositories` are the folders whose git worktree lists are searched
 * (the project's configured repositories; the source folders its workspaces recorded are added).
 * Only worktrees under `<storage>/worktrees` named for one of its tasks count
 * (`<task>-r<n>-<stamp>` for coding tasks, `job-<task>-<alias>` for a job's integration worktree).
 */
export async function projectFootprint(db: Db, storageDir: string, slug: string, repositories: string[]): Promise<ProjectFootprint> {
  const taskIds = (db.prepare("SELECT id FROM tasks WHERE project_id = ? ORDER BY created_at").pluck().all(slug) as string[]) ?? [];
  const p = { slug, ids: ids(taskIds) };
  const jobs = (db.prepare("SELECT COUNT(*) FROM tasks WHERE project_id = ? AND profile = 'supervise' AND json_extract(spec_json, '$.parentTaskId') IS NULL").pluck().get(slug) as number) ?? 0;
  const sessionsDir = path.join(storageDir, "sessions");
  const sessionRows = db.prepare(`SELECT log_path FROM sessions WHERE ${SESSIONS}`).pluck().all(p) as string[];
  const artifactsRoot = path.join(storageDir, "artifacts");
  const artifactRows = db.prepare(`SELECT rel_path FROM artifacts WHERE task_id IN ${IN_TASKS}`).pluck().all(p) as string[];
  const artifactPaths = [
    ...artifactRows.map((r) => path.join(artifactsRoot, ...r.split("/"))),
    ...taskIds.map((id) => path.join(artifactsRoot, id)).filter((d) => existsSync(d)),
  ].filter((f) => inside(artifactsRoot, f));
  const requests = (db.prepare("SELECT COUNT(*) FROM model_requests WHERE project_id = ?").pluck().get(slug) as number) ?? 0;
  const paidRequests = (db.prepare("SELECT COUNT(*) FROM paid_spend WHERE request_id IN (SELECT id FROM model_requests WHERE project_id = ?)").pluck().get(slug) as number) ?? 0;
  const sources = db.prepare(`SELECT DISTINCT source_path FROM workspaces WHERE task_id IN ${IN_TASKS}`).pluck().all(p) as string[];
  return {
    slug,
    taskIds,
    jobs,
    sessions: sessionRows.length,
    // log_path is relative to the storage folder (`sessions/<id>.jsonl`).
    sessionLogs: sessionRows.map((f) => path.resolve(storageDir, f)).filter((f) => inside(sessionsDir, f)),
    artifacts: artifactRows.length,
    artifactPaths: [...new Set(artifactPaths)],
    worktrees: await projectWorktrees(storageDir, taskIds, [...repositories, ...sources]),
    requests,
    paidRequests,
  };
}

/** SwitchYard's worktrees for these tasks: registered in one of `repositories`, or leftover folders. */
async function projectWorktrees(storageDir: string, taskIds: string[], repositories: string[]): Promise<WorktreeRef[]> {
  const root = path.join(storageDir, "worktrees");
  const owned = new Set(taskIds);
  // <task>-r<n>-<stamp> or job-<task>-<alias>; task ids contain no '-'.
  const ownedName = (name: string) => owned.has(name.replace(/^job-/, "").split("-")[0]!);
  const ownedPath = (p: string) => inside(root, p) && path.dirname(path.resolve(p)).toLowerCase() === path.resolve(root).toLowerCase() && ownedName(path.basename(p));
  const out = new Map<string, WorktreeRef>();
  const key = (p: string) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
  if (!owned.size) return [];
  const seenRepos = new Set<string>();
  for (const repo of repositories) {
    if (seenRepos.has(key(repo)) || !existsSync(path.join(repo, ".git"))) continue;
    seenRepos.add(key(repo));
    const list = await git(repo, ["worktree", "list", "--porcelain"]).catch(() => "");
    for (const line of list.split(/\r?\n/)) {
      if (!line.startsWith("worktree ")) continue;
      const wt = path.resolve(line.slice("worktree ".length).trim());
      if (ownedPath(wt) && !out.has(key(wt))) out.set(key(wt), { repo, path: wt });
    }
  }
  if (existsSync(root)) {
    for (const name of readdirSync(root)) {
      const wt = path.join(root, name);
      if (ownedName(name) && !out.has(key(wt)) && statSync(wt).isDirectory()) out.set(key(wt), { repo: null, path: wt });
    }
  }
  return [...out.values()];
}

/**
 * Delete the project's rows in one transaction: its tasks and everything hanging off them
 * (dependencies, executions' memberships, artifacts' rows, events, workspaces, contracts,
 * verdicts and audits, plans, leases, carves, the merge queue, the team channel, provider slots),
 * its sessions and their events, supervisor transcripts and questions, brain access requests and
 * grants, and the project's row. Model requests and paid spend are kept for accounting, unlinked
 * from the project (`project_id` ''); their per-task charges go with the tasks they name, so
 * foreign keys hold throughout. Refused when the project has a task in one of `activeStates`
 * (checked inside the transaction).
 */
export function purgeProjectRows(db: Db, slug: string, activeStates: readonly string[]): { tasks: number; sessions: number } {
  return immediate(db, () => {
    const active = db.prepare("SELECT COUNT(*) FROM tasks WHERE project_id = ? AND state IN (SELECT value FROM json_each(?))").pluck().get(slug, JSON.stringify(activeStates)) as number;
    if (active) throw new SwitchyardError("usage", `project ${slug} has ${active} running or queued task(s); cancel them or let them finish before deleting it`);
    const p = { slug, ids: ids(db.prepare("SELECT id FROM tasks WHERE project_id = ?").pluck().all(slug) as string[]) };
    const run = (sql: string) => db.prepare(sql).run(p).changes;
    // Private runtime ownership records may only go after their resources were proved removed.
    // In particular, removing a task must not orphan a recoverable task-Lab process intent.
    if (db.prepare("SELECT 1 FROM labs WHERE project_id=? AND state!='destroyed' LIMIT 1").get(slug)
      || db.prepare(`SELECT 1 FROM lab_task_attempts l JOIN task_workspace_attempts a ON a.id=l.attempt_id WHERE a.task_id IN ${IN_TASKS} AND l.phase!='pruned' LIMIT 1`).get(p)
      || db.prepare(`SELECT 1 FROM task_lab_operations WHERE attempt_id IN (SELECT id FROM task_workspace_attempts WHERE task_id IN ${IN_TASKS}) AND state IN ('pending','running') LIMIT 1`).get(p)
      || db.prepare(`SELECT 1 FROM lab_attempt_processes WHERE attempt_id IN (SELECT id FROM task_workspace_attempts WHERE task_id IN ${IN_TASKS}) AND state!='stopped' LIMIT 1`).get(p)
      || db.prepare("SELECT 1 FROM lab_operations WHERE project_id=? AND state IN ('pending','running') LIMIT 1").get(slug)) {
      throw new SwitchyardError("usage", `project ${slug} still has Lab resources or pending cleanup; finish owned Lab cleanup before deleting it`);
    }
    const attempts = `(SELECT id FROM task_workspace_attempts WHERE task_id IN ${IN_TASKS})`;
    const labs = "(SELECT id FROM labs WHERE project_id=@slug)";
    run(`DELETE FROM lab_attempt_processes WHERE attempt_id IN ${attempts}`);
    run(`DELETE FROM task_lab_operations WHERE attempt_id IN ${attempts}`);
    run(`DELETE FROM lab_task_attempts WHERE attempt_id IN ${attempts}`);
    run(`DELETE FROM task_workspace_attempts WHERE task_id IN ${IN_TASKS}`);
    run(`DELETE FROM lab_teams WHERE lab_id IN ${labs} OR root_job_id IN ${IN_TASKS}`);
    run(`DELETE FROM lab_operations WHERE lab_id IN ${labs} OR project_id=@slug`);
    for (const table of ["lab_ports", "lab_services", "lab_checks", "lab_events", "lab_promotions"]) run(`DELETE FROM ${table} WHERE lab_id IN ${labs}`);
    run("DELETE FROM labs WHERE project_id=@slug");
    run(`DELETE FROM session_events WHERE session_id IN (SELECT id FROM sessions WHERE ${SESSIONS})`);
    const sessions = run(`DELETE FROM sessions WHERE ${SESSIONS}`);
    run(`DELETE FROM task_deps WHERE task_id IN ${IN_TASKS} OR depends_on IN ${IN_TASKS}`);
    run(`DELETE FROM execution_members WHERE task_id IN ${IN_TASKS}`);
    run(`DELETE FROM artifacts WHERE task_id IN ${IN_TASKS}`);
    run(
      `DELETE FROM events WHERE project_id = @slug OR task_id IN ${IN_TASKS}
         OR (type = 'repository_prepare' AND (CASE WHEN json_valid(data_json) THEN json_extract(data_json, '$.project') END) = @slug)`,
    );
    run(`DELETE FROM workspaces WHERE task_id IN ${IN_TASKS}`);
    run(`DELETE FROM qualification_tasks WHERE task_id IN ${IN_TASKS}`);
    run(`DELETE FROM brain_access_requests WHERE project_id = @slug OR task_id IN ${IN_TASKS} OR job_id IN ${IN_TASKS}`);
    run(`DELETE FROM brain_grants WHERE project_id = @slug OR task_id IN ${IN_TASKS}`);
    run(`DELETE FROM job_state WHERE project_id = @slug OR task_id IN ${IN_TASKS}`);
    run(`DELETE FROM job_questions WHERE task_id IN ${IN_TASKS}`);
    run(`DELETE FROM task_contracts WHERE task_id IN ${IN_TASKS}`);
    run(`DELETE FROM verdict_records WHERE task_id IN ${IN_TASKS}`);
    run(`DELETE FROM verification_signals WHERE task_id IN ${IN_TASKS} OR job_id IN ${IN_TASKS}`);
    run(`DELETE FROM verification_audits WHERE task_id IN ${IN_TASKS}`);
    run(`DELETE FROM job_plans WHERE project_id = @slug OR job_id IN ${IN_TASKS}`);
    run(`DELETE FROM file_leases WHERE task_id IN ${IN_TASKS} OR job_id IN ${IN_TASKS}`);
    run(`DELETE FROM job_budget_carves WHERE child_task_id IN ${IN_TASKS} OR parent_task_id IN ${IN_TASKS}`);
    run(`DELETE FROM task_request_grants WHERE task_id IN ${IN_TASKS} OR job_id IN ${IN_TASKS}`);
    run(`DELETE FROM budget_requests WHERE project_id = @slug OR task_id IN ${IN_TASKS}`);
    run(`DELETE FROM merge_queue WHERE task_id IN ${IN_TASKS} OR job_id IN ${IN_TASKS}`);
    // Channel posts are append-only for agents; deleting the whole project removes its jobs' posts.
    const guard = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'job_channel_no_delete'").pluck().get() as string | undefined;
    if (guard) db.exec("DROP TRIGGER job_channel_no_delete");
    run(`DELETE FROM job_channel WHERE job_id IN ${IN_TASKS}`);
    if (guard) db.exec(guard);
    run(`DELETE FROM provider_slots WHERE task_id IN ${IN_TASKS}`);
    run("UPDATE model_requests SET project_id = '' WHERE project_id = @slug");
    run(`DELETE FROM request_charges WHERE task_id IN ${IN_TASKS}`);
    const tasks = run(`DELETE FROM tasks WHERE id IN ${IN_TASKS}`);
    run("DELETE FROM projects WHERE id = @slug");
    return { tasks, sessions };
  });
}

/** Remove session logs and artifact files; returns what could not be removed. */
export function removeProjectFiles(fp: ProjectFootprint): string[] {
  const problems: string[] = [];
  for (const f of [...fp.sessionLogs, ...fp.artifactPaths]) {
    try {
      rmSync(f, { recursive: true, force: true });
    } catch (err) {
      problems.push(`${f}: ${(err as Error).message}`);
    }
  }
  return problems;
}

/** Remove the worktrees (`git worktree remove --force`, then prune); branches are kept. */
export async function removeProjectWorktrees(worktrees: WorktreeRef[]): Promise<{ removed: number; problems: string[] }> {
  const problems: string[] = [];
  let removed = 0;
  const repos = new Set<string>();
  for (const wt of worktrees) {
    try {
      if (wt.repo) {
        repos.add(wt.repo);
        await git(wt.repo, ["worktree", "remove", "--force", "--force", wt.path]).catch(() => undefined);
      }
      rmSync(wt.path, { recursive: true, force: true });
      removed++;
    } catch (err) {
      problems.push(`worktree ${wt.path}: ${(err as Error).message}`);
    }
  }
  for (const repo of repos) await git(repo, ["worktree", "prune"]).catch((err: Error) => problems.push(`git worktree prune in ${repo}: ${err.message}`));
  return { removed, problems };
}
