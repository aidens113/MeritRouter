import path from "node:path";
import { realpathSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { LabManager } from "./lab.js";
import { WorkerTaskSchema } from "../core/task.js";
import { SessionWorkspaceSchema } from "../sessions/events.js";
import { immediate, newId } from "../storage/db.js";
import { SwitchyardError } from "../core/errors.js";
import { dirtyPaths, git } from "../workspaces/git.js";
import { TaskAttemptStore } from "./task-attempt-store.js";
import { RegisterTaskAttemptSchema, SubmitTaskAttemptSchema, TaskAttemptHandleSchema, type RegisterTaskAttempt, type TaskAttemptHandle, TaskAttemptRepositorySchema } from "./task-attempt-schema.js";
export const taskHash = (text: string) => createHash("sha256").update(text).digest("hex");
const Identity = z.object({ project_id: z.string(), run_count: z.number().int(), lease_owner: z.string().nullable(), lease_expires_at: z.number().nullable(), state: z.string(), cancel_requested: z.number(), deadline_at: z.number().nullable(), spec_json: z.string() });
export async function taskCommonDirectory(directory: string) {
  return realpathSync((await git(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim());
}
export async function assertRegisteredTaskWorktree(source: string, worktree: string) {
  const paths = (await git(source, ["worktree", "list", "--porcelain", "-z"])).split("\0").filter(p => p.startsWith("worktree ")).map(p => path.resolve(p.slice(9)));
  if (!paths.includes(path.resolve(worktree)))
    throw new SwitchyardError("lab_scope_denied", "source is not a registered worktree of its repository");
}
export class TaskAttemptSource {
  readonly store: TaskAttemptStore;
  constructor(readonly manager: LabManager) {
    this.store = new TaskAttemptStore(manager.options.db);
  }
  identity(attempt: Pick<TaskAttemptHandle, "taskId" | "project" | "leaseOwner" | "runCount">) {
    const task = Identity.parse(this.store.db.prepare("SELECT * FROM tasks WHERE id=?").get(attempt.taskId));
    if (task.project_id !== attempt.project || task.run_count !== attempt.runCount || task.lease_owner !== attempt.leaseOwner || task.state !== "running" || task.cancel_requested || !task.lease_expires_at || task.lease_expires_at <= Date.now() || !task.deadline_at || task.deadline_at <= Date.now())
      throw new SwitchyardError("lab_scope_denied", "task attempt no longer owns the live task generation");
    return task;
  }
  get(handle: TaskAttemptHandle) {
    const parsed = TaskAttemptHandleSchema.parse(handle), record = this.store.get(parsed.id);
    for (const key of ["taskId", "project", "runCount", "leaseOwner", "executionId"] as const)
      if (record[key] !== parsed[key])
        throw new SwitchyardError("lab_scope_denied", "task attempt handle does not match persisted identity");
    return record;
  }
  private sourcePath(target: string) {
    const root = path.resolve(this.manager.options.storageDir, "worktrees"), resolved = path.resolve(target), rel = path.relative(root, resolved);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel))
      throw new SwitchyardError("lab_scope_denied", "source must be a managed isolated task worktree");
    let current = root;
    for (const part of ["", ...rel.split(path.sep)]) {
      current = part ? path.join(current, part) : current;
      if (lstatSync(current).isSymbolicLink())
        throw new SwitchyardError("lab_scope_denied", "source cannot contain symlinks");
    }
  }
  async register(raw: RegisterTaskAttempt): Promise<TaskAttemptHandle> {
    const input = RegisterTaskAttemptSchema.parse(raw), task = this.identity(input), spec = WorkerTaskSchema.parse(JSON.parse(task.spec_json)), cfg = this.manager.options.project(input.project);
    if (cfg.profiles[spec.profile]?.mode !== "coding" || spec.writableRepository !== input.writableAlias || !spec.constraints.allowedPaths?.length)
      throw new SwitchyardError("lab_scope_denied", "only scoped coding tasks may register task Labs");
    if (new Set(input.repositories.map(r => r.alias)).size !== input.repositories.length || input.repositories.length !== spec.repositoryAliases.length || input.repositories.some(r => !spec.repositoryAliases.includes(r.alias)))
      throw new SwitchyardError("lab_scope_denied", "repositories differ from task scope");
    if (!input.sessionId)
      throw new SwitchyardError("lab_scope_denied", "attempt requires persisted session provenance");
    const session = z.object({ task_id: z.string().nullable(), status: z.string(), workspace_json: z.string().nullable() }).parse(this.store.db.prepare("SELECT task_id,status,workspace_json FROM sessions WHERE id=?").get(input.sessionId));
    if (session.task_id !== input.taskId || session.status !== "running" || !session.workspace_json)
      throw new SwitchyardError("lab_scope_denied", "session is not owned by the running task");
    const owned = SessionWorkspaceSchema.parse(JSON.parse(session.workspace_json)).repos.find(r => r.alias === input.writableAlias && path.resolve(r.worktree) === path.resolve(input.sourceWorktree));
    if (!owned)
      throw new SwitchyardError("lab_scope_denied", "source is absent from persisted session workspace");
    if (!this.store.db.prepare("SELECT 1 FROM execution_members WHERE execution_id=? AND task_id=?").get(input.executionId, input.taskId))
      throw new SwitchyardError("lab_scope_denied", "execution membership is missing");
    this.sourcePath(input.sourceWorktree);
    const repositories: z.infer<typeof TaskAttemptRepositorySchema>[] = [];
    for (const repo of input.repositories) {
      const configured = cfg.repositoryPaths[repo.alias];
      if (!configured)
        throw new SwitchyardError("lab_scope_denied", "unknown repository");
      const common = await taskCommonDirectory(repo.sourcePath);
      if (common !== await taskCommonDirectory(configured.path))
        throw new SwitchyardError("lab_scope_denied", "physical Git repository differs from project");
      for (const sha of [repo.baseCommit, repo.head])
        if ((await git(repo.sourcePath, ["rev-parse", "--verify", "--end-of-options", `${sha}^{commit}`])).trim() !== sha)
          throw new SwitchyardError("lab_scope_denied", "source head must be a full immutable commit");
      const expectedHead = repo.alias === input.writableAlias ? (await git(input.sourceWorktree, ["rev-parse", "HEAD"])).trim() : spec.context.baseCommits?.[repo.alias] ?? (await git(configured.path, ["rev-parse", "HEAD"])).trim();
      if (repo.head !== expectedHead)
        throw new SwitchyardError("lab_scope_denied", "attempt head is not the task source snapshot");
      repositories.push({ ...repo, sourcePath: path.resolve(configured.path), commonDirectory: common });
    }
    const configuredOrder = Object.keys(cfg.repositoryPaths);
    repositories.sort((a, b) => configuredOrder.indexOf(a.alias) - configuredOrder.indexOf(b.alias));
    const writable = repositories.find(r => r.alias === input.writableAlias);
    if (!writable || !cfg.repositoryPaths[input.writableAlias]?.writable || await taskCommonDirectory(input.sourceWorktree) !== writable.commonDirectory || owned.baseCommit !== writable.baseCommit)
      throw new SwitchyardError("lab_scope_denied", "workspace Git/base identity differs from task provenance");
    await assertRegisteredTaskWorktree(writable.sourcePath, input.sourceWorktree);
    const id = newId("twa"), now = Date.now();
    immediate(this.store.db, () => {
      this.identity(input);
      this.store.db.prepare("INSERT INTO task_workspace_attempts(id,task_id,project_id,run_count,lease_owner,execution_id,session_id,source_worktree,writable_alias,repositories_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'working',?,?)").run(id, input.taskId, input.project, input.runCount, input.leaseOwner, input.executionId, input.sessionId, realpathSync(input.sourceWorktree), input.writableAlias, JSON.stringify(repositories), now, now);
    });
    return TaskAttemptHandleSchema.parse({ id, taskId: input.taskId, project: input.project, runCount: input.runCount, leaseOwner: input.leaseOwner, executionId: input.executionId });
  }
  async submit(handle: TaskAttemptHandle, raw: z.input<typeof SubmitTaskAttemptSchema>): Promise<void> {
    const record = this.get(handle), input = SubmitTaskAttemptSchema.parse(raw);
    this.identity(record);
    this.sourcePath(record.sourceWorktree);
    const writable = record.repositories.find(r => r.alias === record.writableAlias)!;
    if (await taskCommonDirectory(record.sourceWorktree) !== writable.commonDirectory)
      throw new SwitchyardError("lab_scope_denied", "source repository identity changed");
    await assertRegisteredTaskWorktree(writable.sourcePath, record.sourceWorktree);
    if ((await dirtyPaths(record.sourceWorktree)).length || (await git(record.sourceWorktree, ["rev-parse", "HEAD"])).trim() !== input.commit || (await git(record.sourceWorktree, ["rev-parse", "HEAD^{tree}"])).trim() !== input.tree)
      throw new SwitchyardError("lab_revision_changed", "submission must match clean committed source tree");
    await git(record.sourceWorktree, ["merge-base", "--is-ancestor", writable.baseCommit, input.commit]);
    const commits = (await git(record.sourceWorktree, ["rev-list", `${writable.baseCommit}..${input.commit}`])).trim().split("\n").filter(Boolean);
    if (!commits.length)
      throw new SwitchyardError("lab_scope_denied", "submission has no attributed changes");
    for (const commit of commits) {
      const message = await git(record.sourceWorktree, ["show", "-s", "--format=%B", commit]);
      if (!message.split(/\r?\n/).includes(`Task: ${record.taskId}`) || !/^Agent: .+/m.test(message) || !/^Model: .+/m.test(message))
        throw new SwitchyardError("lab_scope_denied", "source commit attribution does not belong to task");
    }
    const spec = WorkerTaskSchema.parse(JSON.parse(this.identity(record).spec_json)), { default: picomatch } = await import("picomatch"), allowed = picomatch(spec.constraints.allowedPaths!, { dot: true });
    if ((await git(record.sourceWorktree, ["diff", "--no-renames", "--name-only", "-z", writable.baseCommit, input.commit])).split("\0").filter(Boolean).some(file => !allowed(file)))
      throw new SwitchyardError("lab_scope_denied", "source changes exceed allowedPaths");
    if (input.patchDigest !== taskHash(await git(record.sourceWorktree, ["diff", "--binary", writable.baseCommit, input.commit])))
      throw new SwitchyardError("lab_revision_changed", "patch digest differs from source");
    immediate(this.store.db, () => {
      this.identity(record);
      const result = this.store.db.prepare("UPDATE task_workspace_attempts SET submitted_commit=?,submitted_tree=?,patch_digest=?,state='submitted',updated_at=? WHERE id=? AND state='working'").run(input.commit, input.tree, input.patchDigest, Date.now(), record.id);
      if (!result.changes)
        throw new SwitchyardError("lab_invalid_state", "attempt was already submitted");
    });
  }
}
