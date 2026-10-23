import { z } from "zod";
import { immediate } from "../storage/db.js";
import { MeritRouterError } from "../core/errors.js";
import { WorkerTaskSchema, isTerminal, type WorkerTask } from "../core/task.js";
import type { TaskStore } from "../storage/tasks.js";
import type { ResolvedConfig } from "../config/load.js";
import type { LabManager } from "./lab.js";
import { git } from "../workspaces/git.js";
export interface LabRunContext {
  manager: LabManager;
  project: string;
  name: string;
  rootJobId: string;
  labId: string;
}
function descendantsEnded(tasks: TaskStore, id: string): boolean {
  const pending = [id];
  const seen = new Set<string>();
  while (pending.length) {
    const next = pending.pop()!;
    if (seen.has(next) || seen.size >= 5000)
      return false;
    seen.add(next);
    const t = tasks.get(next);
    if (!t || !isTerminal(t.row.state))
      return false;
    pending.push(...tasks.childrenOf(next).map(c => c.row.id));
  }
  return true;
}
/** Synchronous and safe inside the service's task-submit transaction. */
export function claimLabJob(manager: LabManager, project: string, name: string, jobId: string, tasks: TaskStore): LabRunContext {
  const { lab } = manager.status(project, name);
  if(lab.kind!=="retained")throw new MeritRouterError("lab_scope_denied","task-owned Labs cannot claim a team");
  const job = tasks.get(jobId);
  if (!job || job.row.project_id !== project || job.spec.lab !== name || job.spec.parentTaskId || manager.options.project(project).profiles[job.spec.profile]?.mode !== "supervisor")
    throw new MeritRouterError("lab_scope_denied", "only a persisted root supervisor job of this project/lab can claim the team");
  for (const alias of job.spec.repositoryAliases)
    if (!lab.repositories.some(repo => repo.alias === alias))
      throw new MeritRouterError("lab_scope_denied", "root job repository is outside this lab");
  immediate(manager.options.db, () => {
    const prior = z.object({ root_job_id: z.string() }).optional().parse(manager.options.db.prepare("SELECT root_job_id FROM lab_teams WHERE lab_id=?").get(lab.id));
    if (prior && prior.root_job_id !== jobId && !descendantsEnded(tasks, prior.root_job_id))
      throw new MeritRouterError("lab_team_busy", `lab ${project}/${name} already has root team ${prior.root_job_id}`);
    manager.options.db.prepare("INSERT INTO lab_teams(lab_id,root_job_id,created_at) VALUES(?,?,?) ON CONFLICT(lab_id) DO UPDATE SET root_job_id=excluded.root_job_id,created_at=excluded.created_at").run(lab.id, jobId, Date.now());
  });
  manager.touch(project, name);
  return { manager, project, name, rootJobId: jobId, labId: lab.id };
}
export function bindLabTask(manager: LabManager, project: string, taskId: string, raw: WorkerTask, tasks: TaskStore): LabRunContext | null {
  const spec = WorkerTaskSchema.parse(raw);
  const stored = tasks.get(taskId);
  if (!stored || stored.row.project_id !== project || stored.spec.lab !== spec.lab)
    throw new MeritRouterError("lab_scope_denied", "task does not match its stored project/lab binding");
  if (!spec.lab) {
    if (spec.parentTaskId && tasks.get(spec.parentTaskId)?.spec.lab)
      throw new MeritRouterError("lab_scope_denied", "a child task cannot escape its parent's lab");
    return null;
  }
  const { lab } = manager.status(project, spec.lab);
  if(lab.kind!=="retained")throw new MeritRouterError("lab_scope_denied","task-owned Labs cannot bind team tasks");
  let current = stored;
  const seen = new Set<string>();
  while (current.spec.parentTaskId) {
    if (seen.has(current.row.id) || seen.size >= 64)
      throw new MeritRouterError("lab_scope_denied", "invalid lab task ancestry");
    seen.add(current.row.id);
    const parent = tasks.get(current.spec.parentTaskId);
    if (!parent || parent.row.project_id !== project || parent.spec.lab !== spec.lab)
      throw new MeritRouterError("lab_scope_denied", "lab scope must be inherited from every parent");
    current = parent;
  }
  const rootJobId = current.row.id;
  if (rootJobId === taskId)
    return claimLabJob(manager, project, spec.lab, rootJobId, tasks);
  const team = z.object({ root_job_id: z.string() }).optional().parse(manager.options.db.prepare("SELECT root_job_id FROM lab_teams WHERE lab_id=?").get(lab.id));
  if (team?.root_job_id !== rootJobId)
    throw new MeritRouterError("lab_scope_denied", "task is not in the lab's current root team");
  for (const alias of spec.repositoryAliases)
    if (!lab.repositories.some(r => r.alias === alias))
      throw new MeritRouterError("lab_scope_denied", `repository ${alias} is outside this lab`);
  return { manager, project, name: spec.lab, rootJobId, labId: lab.id };
}
export function labTaskContext(manager: LabManager, project: string, taskId: string, spec: WorkerTask, tasks: TaskStore): {
  binding: LabRunContext | null;
  cfg: ResolvedConfig;
} {
  const binding = bindLabTask(manager, project, taskId, spec, tasks);
  const original = manager.options.project(project);
  if (!binding)
    return { binding, cfg: original };
  return { binding, cfg: labConfiguration(manager, project, binding.name) };
}
/** Preview repository overlays without claiming or persisting a task. */
export function labConfiguration(manager: LabManager, project: string, name: string): ResolvedConfig {
  const original = manager.options.project(project);
  const { lab } = manager.status(project, name);
  if(lab.kind!=="retained")throw new MeritRouterError("lab_scope_denied","task-owned Labs cannot claim a team");
  const repositoryPaths = { ...original.repositoryPaths };
  const repositories = { ...original.repositories };
  for (const repo of lab.repositories) {
    const configured = original.repositoryPaths[repo.alias];
    if (!configured)
      throw new MeritRouterError("lab_scope_denied", "lab repository is no longer configured");
    repositoryPaths[repo.alias] = { ...configured, path: repo.worktree };
    repositories[repo.alias] = { path: repo.worktree, writable: configured.writable };
  }
  return { ...original, repositoryPaths, repositories };
}
/** Explicit task bases must be reachable through the lab or a supervising job in its lineage. */
export async function assertLabTaskBases(binding: LabRunContext, spec: WorkerTask, tasks: TaskStore): Promise<void> {
  const { lab } = binding.manager.status(binding.project, binding.name);
  const ancestors: string[] = [];
  let parent = spec.parentTaskId;
  const seen = new Set<string>();
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    ancestors.push(parent);
    parent = tasks.get(parent)?.spec.parentTaskId;
  }
  const prefix = binding.manager.options.project(binding.project).supervisor.branch_prefix;
  for (const [alias, base] of Object.entries(spec.context.baseCommits ?? {})) {
    const repo = lab.repositories.find(r => r.alias === alias);
    if (!repo)
      throw new MeritRouterError("lab_scope_denied", "base commit repository is outside the lab");
    let allowed = false;
    for (const ref of [repo.branch, ...ancestors.filter(id => id !== binding.rootJobId).map(id => `${prefix}${id}`)]) {
      try {
        await git(repo.source, ["merge-base", "--is-ancestor", base, `refs/heads/${ref}`]);
        allowed = true;
        break;
      }
      catch {
      }
    }
    if (!allowed)
      throw new MeritRouterError("lab_scope_denied", `base ${base} is not reachable from this lab/team's branches`);
  }
}
