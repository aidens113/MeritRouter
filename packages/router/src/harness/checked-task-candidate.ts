import { createHash } from "node:crypto";
import { z } from "zod";
import { sealCheckedCandidate } from "../attribution/checked-candidate.js";
import { agentLabel } from "../roles/index.js";
import type { RunContext } from "../runners/types.js";
import { SessionStore } from "../sessions/store.js";
import { authorSessions } from "../sessions/run-sessions.js";
import { git } from "../workspaces/git.js";
import { assertRunAuthority } from "./task-authority.js";
import { WorkerActionRequests, workerSourceIdentity } from "./worker-actions.js";
import { currentSupervisorAuthority } from "../core/supervisor-authority.js";

/** Recover only an old, fully checked index omitted from its author's final commit. */
export async function sealRetainedCheckedTask(ctx: RunContext, input: {
  taskId: string; alias: string; worktree: string; head: string; base: string; tree: string;
}): Promise<string> {
  const assertAuthority = () => {
    assertRunAuthority(ctx);
    if (!ctx.taskLease || !currentSupervisorAuthority(ctx.tasks.db, ctx.cfg, ctx.taskLease, ctx.now())) throw new Error("Checked candidate sealing requires current supervisor authority");
  };
  assertAuthority();
  const task = ctx.tasks.get(input.taskId), result = task?.result;
  const refuse = () => new Error("Retained checked candidate lacks exact worker/source proof; re-delegate it");
  if (!task || task.row.state !== "completed" || task.spec.parentTaskId !== ctx.taskId || task.row.project_id !== ctx.tasks.projectOf(ctx.taskId) ||
    ctx.cfg.profiles[task.spec.profile]?.mode !== "coding" || result?.acceptanceStatus !== "met" || task.spec.constraints.labChecks?.length ||
    result.scopeViolation?.length || result.protectedPathsChanged?.length || !result.checks.length || !task.spec.constraints.checks?.length ||
    result.checks.length !== task.spec.constraints.checks.length) throw refuse();
  const digest = result.checks[0]?.artifactDigest;
  if (!digest || result.checks.some((check, i) => check.exitCode !== 0 || check.revision !== input.tree || check.artifactDigest !== digest || check.command !== task.spec.constraints.checks![i])) throw refuse();
  const sessions = new SessionStore(ctx.tasks.db, ctx.cfg.storageDir, ctx.now);
  const author = authorSessions(sessions, input.taskId).at(-1);
  const workspace = author?.workspace?.repos.find(repo => repo.alias === input.alias);
  if (!author || author.status !== "completed" || author.role !== "implementer" || author.profile !== task.spec.profile || !workspace ||
    workspace.worktree !== input.worktree || workspace.head !== input.head || workspace.baseCommit !== input.base || sessions.events(author.id, { limit: 1 })?.corrupt.length) throw refuse();
  const actionStore = new WorkerActionRequests(ctx.tasks.db, ctx.now);
  const scope = { project: task.row.project_id, taskId: input.taskId };
  if (actionStore.list({ ...scope, status: "pending" }).length || actionStore.list({ ...scope, status: "running" }).length) throw refuse();
  const uncertain = actionStore.list({ ...scope, status: "uncertain" });
  // The list is capped. At its cap, absence of older unresolved execution is unknown.
  if (uncertain.length >= 500 || uncertain.some(action => !action.quiescedAt)) throw refuse();
  const actions = actionStore.list(scope);
  const source = await workerSourceIdentity(input.worktree);
  for (const [index, check] of result.checks.entries()) {
    const log = ctx.artifacts.readScoped(check.logRef, task.row.project_id);
    if (log.row.task_id !== input.taskId || log.row.kind !== "check_log" || !log.row.execution_id) throw refuse();
    const action = actions.find(action => action.action.invocationId === `final_check:${log.row.execution_id}:${index}`);
    if (!action || action.taskId !== input.taskId || action.project !== task.row.project_id || action.action.lease.taskId !== input.taskId || action.action.lease.project !== task.row.project_id ||
      action.action.lease.runCount !== task.row.run_count || action.action.lease.incarnation !== task.row.lease_incarnation ||
      action.status !== "completed" || action.exitCode !== 0 || action.action.operation || action.action.command !== check.command ||
      action.action.source !== source || action.action.cwd !== input.worktree || action.action.jobId !== ctx.taskId) throw refuse();
  }
  const patch = await git(input.worktree, ["diff", "--cached", "--binary", input.base]);
  if (createHash("sha256").update(patch).digest("hex") !== digest) throw refuse();
  const response = z.object({ name: z.string().min(1) }).safeParse(ctx.tasks.db.prepare("SELECT name FROM session_events WHERE session_id=? AND type='model_response' ORDER BY seq DESC LIMIT 1").get(author.id));
  if (!response.success) throw refuse();
  const head = await sealCheckedCandidate({ worktree: input.worktree, head: input.head, tree: input.tree,
    actor: { agent: agentLabel("implementer", task.spec.label ?? input.taskId), role: "implementer", task: input.taskId, job: ctx.taskId, tier: author.tier, model: response.data.name },
    assertAuthority });
  ctx.tasks.event(input.taskId, "checked_candidate_sealed", { previousHead: input.head, head, tree: input.tree, sessionId: author.id, bySupervisor: ctx.taskId });
  return head;
}
