import path from "node:path";
import { lstatSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import type { LabManager } from "../../labs/lab.js";
import { LabRecordSchema } from "../../labs/store.js";
import { TaskAttemptRecordSchema, TaskLabRecordSchema, TaskLabEvidenceSchema, type TaskLabEvidence } from "../../labs/task-attempt-schema.js";
import { LabCheckResultSchema } from "../../labs/checks.js";
import { taskHash } from "../../labs/task-attempt-source.js";
import { validateRecipe } from "../../labs/recipe.js";
import { loadConfig } from "../../config/load.js";
import { ProjectRegistry } from "../../projects/registry.js";
import { ProjectConfigSchema } from "../../projects/schema.js";
import { canonicalJson } from "../../storage/tasks.js";
import type { WorkerTask } from "../../core/task.js";
import type { RunContext } from "../types.js";
import type { Workspace } from "../../workspaces/worktree.js";
const Sha = z.string().regex(/^[a-f0-9]{40,64}$/);
const Count = z.number().int().nonnegative();
export const TaskLabAuthoritySchema = z.object({
  taskId: z.string(), project: z.string(), runCount: z.number().int().positive(),
  attempt: TaskAttemptRecordSchema, request: TaskLabRecordSchema, lab: LabRecordSchema,
  canonicalCurrentRecipeDigest: z.string().regex(/^[a-f0-9]{64}$/), policyEnabled: z.boolean(), allowedCheckNames: z.array(z.string()).max(10),
  sourceHead: Sha, sourceTree: Sha, sourceClean: z.boolean(), labClean: z.boolean(), currentHeads: z.record(z.string(), Sha),
  activeServices: Count, activeProcesses: Count, reservedPorts: Count, activeOperations: Count,
  completedEvidence: TaskLabEvidenceSchema, storedChecks: z.array(LabCheckResultSchema).max(10),
}).strict();
export type TaskLabAuthority = z.infer<typeof TaskLabAuthoritySchema>;
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
/** Pure acceptance guard. Only a fresh trusted authority snapshot can establish a pass. */
export function taskLabEvidenceProblem(spec: WorkerTask, evidence: unknown, rawAuthority: TaskLabAuthority | null): string | null {
  const names = spec.constraints.labChecks ?? [];
  if (!names.length)
    return null;
  const parsed = TaskLabEvidenceSchema.safeParse(evidence), authority = TaskLabAuthoritySchema.safeParse(rawAuthority);
  if (!parsed.success || !authority.success)
    return "Required task Lab evidence or authoritative state is missing";
  const e = parsed.data, a = authority.data, r = a.attempt, q = a.request;
  if (!spec.id || a.taskId !== spec.id || r.taskId !== spec.id || r.project !== a.project || r.runCount !== a.runCount || q.attemptId !== r.id || q.labId !== a.lab.id || e.attemptId !== r.id || e.labId !== a.lab.id || a.lab.project !== a.project)
    return "Task Lab evidence belongs to another task, project, generation or attempt";
  if (!equal(e, q.result) || !equal(e, a.completedEvidence) || !equal(e.checks, a.storedChecks))
    return "Task Lab evidence differs from its durable completed operation or check records";
  if (!a.policyEnabled || names.some(name => !a.allowedCheckNames.includes(name)))
    return "Task Lab checks are no longer authorized by human project policy";
  if (!equal(names, q.checks) || !equal(e.checks.map(c => c.name), names))
    return "Required task Lab check selection is incomplete or changed";
  if (q.recipeDigest !== e.recipeDigest || e.recipeDigest !== a.canonicalCurrentRecipeDigest || taskHash(JSON.stringify(q.recipe)) !== e.recipeDigest)
    return "Task Lab recipe changed after its checks";
  if (r.state !== "submitted" || r.submittedCommit !== e.submittedCommit || r.submittedTree !== e.submittedTree || r.patchDigest !== e.patchDigest || a.sourceHead !== e.submittedCommit || a.sourceTree !== e.submittedTree || !a.sourceClean || !a.labClean)
    return "Task Lab evidence is stale for its submitted source commit, tree or patch";
  const aliases = spec.repositoryAliases, writable = spec.writableRepository;
  if (!writable || r.writableAlias !== writable || r.repositories.length !== aliases.length || Object.keys(e.heads).length !== aliases.length || Object.keys(a.currentHeads).length !== aliases.length || a.lab.repositories.length !== aliases.length)
    return "Task Lab repository scope differs from the task";
  for (const alias of aliases) {
    const repo = r.repositories.find(item => item.alias === alias), labRepo = a.lab.repositories.find(item => item.alias === alias), base = spec.context.baseCommits?.[alias];
    const expected = alias === writable ? e.submittedCommit : base;
    if (!repo || !labRepo || !base || repo.baseCommit !== base || !expected || e.heads[alias] !== expected || a.currentHeads[alias] !== expected || labRepo.base !== expected || (alias !== writable && repo.head !== base))
      return "Task Lab checks do not cover every immutable task repository head";
  }
  if (q.phase !== "retained" || q.desiredState !== "stopped" || a.lab.kind !== "task_attempt" || a.lab.state !== "stopped" || e.cleanup !== "complete" || a.activeServices || a.activeProcesses || a.reservedPorts || a.activeOperations)
    return "Task Lab resources are not durably stopped";
  if (e.status !== "passed" || e.error || e.checks.some(c => c.exitCode !== 0 || c.killed || c.revision !== e.heads[c.repository]))
    return "Required task Lab checks did not pass on the submitted heads";
  return null;
}
/** Read authoritative metadata and bounded Git state without starting a supervisor or mutating. */
export function taskLabAuthority(labs: LabManager, taskId: string, evidence: unknown): TaskLabAuthority | null {
  const parsed = TaskLabEvidenceSchema.safeParse(evidence);
  if (!parsed.success)
    return null;
  try {
    const e = parsed.data, attempt = labs.taskAttempts.store.get(e.attemptId), request = labs.taskAttempts.store.lab(attempt.id);
    if (attempt.taskId !== taskId || !request || request.labId !== e.labId)
      return null;
    const task = z.object({
      id: z.string(), project_id: z.string(), run_count: z.number().int().positive()
    }).parse(labs.options.db.prepare("SELECT id,project_id,run_count FROM tasks WHERE id=?").get(taskId));
    if (task.project_id !== attempt.project)
      return null;
    const lab = labs.store.byId(e.labId);
    if (!lab)
      return null;
    labs.taskAttempts.runner.assertLab(lab, attempt);
    const fresh = loadConfig(labs.options.cfg.configPath), project = new ProjectRegistry(fresh).get(attempt.project), config = ProjectConfigSchema.parse(fresh.projects[attempt.project]);
    if (!project || !config.lab || fresh.storageDir !== labs.options.storageDir)
      return null;
    if (!equal(Object.keys(project.repositoryPaths).filter(alias => attempt.repositories.some(repo => repo.alias === alias)), attempt.repositories.map(repo => repo.alias)))
      return null;
    const deadline = Date.now() + 10000;
    let inspectedBytes = 0;
    const git = (cwd: string, args: string[]) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new Error("task evidence inspection deadline");
      const output = execFileSync("git", args, {
        cwd, encoding: "utf8", windowsHide: true, timeout: Math.min(5000, remaining), maxBuffer: 256 * 1024, env: {
          ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0"
        }
      });
      inspectedBytes += Buffer.byteLength(output, "utf8");
      if (inspectedBytes > 2 * 1024 * 1024) throw new Error("task evidence inspection output limit");
      return output;
    };
    const common = (cwd: string) => realpathSync(git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim());
    const sourceRoot = path.resolve(labs.options.storageDir, "worktrees"), source = path.resolve(attempt.sourceWorktree), relative = path.relative(sourceRoot, source);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
      return null;
    let cursor = sourceRoot;
    for (const part of ["", ...relative.split(path.sep)]) {
      if (part)
        cursor = path.join(cursor, part);
      if (lstatSync(cursor).isSymbolicLink())
        return null;
    }
    const currentHeads: Record<string, string> = {};
    let labClean = true;
    for (const repo of attempt.repositories) {
      const configured = project.repositoryPaths[repo.alias], owned = lab.repositories.find(r => r.alias === repo.alias);
      if (!configured || !owned || (repo.alias === attempt.writableAlias && !configured.writable) || common(configured.path) !== repo.commonDirectory || common(owned.worktree) !== repo.commonDirectory)
        return null;
      const registered = git(configured.path, ["worktree", "list", "--porcelain", "-z"]).split("\0").filter(p => p.startsWith("worktree ")).map(p => path.resolve(p.slice(9)));
      if (!registered.includes(path.resolve(owned.worktree)) || git(owned.worktree, ["symbolic-ref", "--short", "HEAD"]).trim() !== owned.branch)
        return null;
      currentHeads[repo.alias] = Sha.parse(git(owned.worktree, ["rev-parse", "HEAD"]).trim());
      if (git(owned.worktree, ["status", "--porcelain=v1", "-z"]).length)
        labClean = false;
      if (repo.alias === attempt.writableAlias && (!registered.includes(source) || common(source) !== repo.commonDirectory))
        return null;
    }
    const count = (sql: string) => Count.parse(z.object({ n: Count }).parse(labs.options.db.prepare(sql).get(lab.id)).n);
    const completed = z.object({ result_json: z.string() }).optional().parse(labs.options.db.prepare("SELECT result_json FROM task_lab_operations WHERE attempt_id=? AND kind='check' AND state='completed' ORDER BY created_at DESC LIMIT 1").get(attempt.id));
    if (!completed)
      return null;
    const checks = e.checks.map(check => {
      const row = z.object({ result_json: z.string() }).parse(labs.options.db.prepare("SELECT result_json FROM lab_checks WHERE id=? AND lab_id=?").get(check.id, lab.id));
      return LabCheckResultSchema.parse(JSON.parse(row.result_json));
    });
    const activeOperations = Count.parse(z.object({ n: Count }).parse(labs.options.db.prepare("SELECT COUNT(*) n FROM task_lab_operations WHERE attempt_id=? AND state IN ('pending','running')").get(attempt.id)).n);
    return TaskLabAuthoritySchema.parse({
      taskId: task.id, project: task.project_id, runCount: task.run_count, attempt, request, lab,
      canonicalCurrentRecipeDigest: taskHash(JSON.stringify(validateRecipe(config.lab, attempt.repositories.map(r => r.alias)))), policyEnabled: config.labs.ephemeral.enabled, allowedCheckNames: config.labs.ephemeral.checks,
      sourceHead: git(source, ["rev-parse", "HEAD"]).trim(), sourceTree: git(source, ["rev-parse", "HEAD^{tree}"]).trim(), sourceClean: git(source, ["status", "--porcelain=v1", "-z"]).length === 0, labClean, currentHeads,
      activeServices: count("SELECT COUNT(*) n FROM lab_services WHERE lab_id=? AND (state!='stopped' OR pid IS NOT NULL OR token IS NOT NULL)"), activeProcesses: count("SELECT COUNT(*) n FROM lab_attempt_processes WHERE lab_id=? AND state!='stopped'"), reservedPorts: count("SELECT COUNT(*) n FROM lab_ports WHERE lab_id=?"), activeOperations,
      completedEvidence: JSON.parse(completed.result_json), storedChecks: checks
    });
  }
  catch {
    return null;
  }
}
/** Called only after the attributed coding outcome and its ordinary command checks exist. */
export async function runTaskLabChecks(ctx: RunContext, workspace: Workspace, executionId: string, tree: string, digest: string): Promise<TaskLabEvidence> {
  if (!ctx.taskLabs || !ctx.ensureLabsSupervisor || !ctx.session || ctx.claimedRunCount === undefined)
    throw new Error("task Lab execution requires its persisted session, claimed generation and supervisor");
  await ctx.ensureLabsSupervisor();
  if (ctx.signal.aborted)
    throw new Error("task Lab execution cancelled");
  const commit = (await import("../../workspaces/git.js")).git;
  const head = (await commit(workspace.worktreePath, ["rev-parse", "HEAD"])).trim();
  const aliases = Object.keys(ctx.cfg.repositoryPaths).filter(alias => ctx.spec.repositoryAliases.includes(alias));
  const handle = await ctx.taskLabs.taskAttempts.register({
    taskId: ctx.taskId, project: ctx.taskProject ?? ctx.cfg.brain.project, leaseOwner: ctx.leaseOwner, runCount: ctx.claimedRunCount, executionId, sessionId: ctx.session.id, sourceWorktree: workspace.worktreePath, writableAlias: workspace.repoAlias,
    repositories: aliases.map(alias => ({
      alias, sourcePath: ctx.cfg.repositoryPaths[alias]!.path, baseCommit: ctx.spec.context.baseCommits![alias]!, head: alias === workspace.repoAlias ? head : ctx.spec.context.baseCommits![alias]!
    }))
  });
  try {
    await ctx.taskLabs.taskAttempts.submit(handle, {
      commit: head, tree, patchDigest: digest
    });
    const op = ctx.taskLabs.taskAttempts.requestCheck(handle, { checks: ctx.spec.constraints.labChecks! });
    return await ctx.taskLabs.taskAttempts.wait(handle, op.id, {
      signal: ctx.signal, timeoutMs: Math.max(1, (ctx.spec.budget?.timeoutSeconds ?? ctx.cfg.execution.job_timeout_seconds) * 1000)
    });
  }
  catch (error) {
    if (ctx.taskLabs.taskAttempts.store.lab(handle.id))
      ctx.taskLabs.taskAttempts.cleanup(handle, "coding attempt did not complete Lab verification");
    throw error;
  }
}
