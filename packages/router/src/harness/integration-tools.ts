import { taskLabAuthority,taskLabEvidenceProblem } from "../runners/coding/task-lab.js";
import { LabCheckResultSchema } from "../labs/checks.js";
import { z } from "zod";
import { existsSync } from "node:fs";
import path from "node:path";
import { newId } from "../storage/db.js";
import { TaskStore } from "../storage/tasks.js";
import { INTEGRATED_EVENT } from "../context/upstream.js";
import type { RunContext } from "../runners/types.js";
import { MergeQueue, ACTIVE_MERGE_STATES, type MergeHooks, type MergeItem } from "../workspaces/merge-queue.js";
import { resolveLevel } from "../verification/policy.js";
import { git } from "../workspaces/git.js";
import { recordIntegration, recordJobCheck } from "../verification/calibration.js";
import { minimalEnv } from "../runners/coding/process.js";
import { executeSupervisorCommand } from "./worker-actions.js";
import { mediateOutsideOperation, withOutsideAuthority } from "./outside-operation.js";
import type { HarnessEnv, HarnessTool } from "./tools.js";
import type { IntegrationRepo, SupervisorState } from "./supervisor-tools.js";
import { sealRetainedCheckedTask } from "./checked-task-candidate.js";

/**
 * Integration onto a job branch (`integrate_task`): the acceptance gate, where a finished task's
 * (or sub-job's) commits are, the job's merge queue and its hooks (acceptance once the picks
 * succeed, integration events, job checks after each integration, one re-delegation on conflict),
 * and how an outcome reads to the supervisor.
 */

/** What integration needs from the rest of the supervisor's tools (delegation, task ownership). */
export interface IntegrationSeam {
  /** Resolve a label or id to one of this job's own tasks; other jobs' tasks are refused. */
  ownTask(ref: unknown): string;
  /** The integration worktree of a writable repository (default: the first). */
  repoFor(alias: unknown): IntegrationRepo;
  /** The supervisor as recorded on acceptance decisions. */
  identity(): { kind: "supervisor"; id: string };
  /**
   * Dispatch a re-delegated brief once through the delegate path, under a label derived from
   * `name` (`brief(label)` builds it); returns the task id, or null when nothing was dispatched.
   */
  redelegate(name: string, brief: (label: string) => Record<string, unknown>, env: HarnessEnv, artifactRefs: string[]): Promise<string | null>;
}

/** The job's merge queue for this run. */
export function queueOf(s: SupervisorState): MergeQueue {
  s.queue ??= new MergeQueue(s.db, new TaskStore(s.db), newId("mqrun"));
  return s.queue;
}

/** What one integration brings onto one job branch: a coding task's worktree commits, or a sub-job's branch. */
interface IntegrationTarget {
  repo: IntegrationRepo;
  kind: "task" | "job";
  sourceWorktree: string | null;
  base: string;
  head: string;
  commits: string[];
}

type TaskView = NonNullable<ReturnType<NonNullable<RunContext["services"]>["getTask"]>>;

/**
 * The acceptance gate every integration passes before it is queued: unmet and out-of-scope
 * results are refused, changed tests need accept_test_changes, and a not_verified or
 * needs_supervisor result needs accept: true with a reason (recorded once the picks succeed).
 * Returns the acceptance to record, or null when the result needs none.
 */
function integrationGate(s: SupervisorState, id: string, t: TaskView, a: Record<string, unknown>): { reason: string } | null {
  const r = t.result!;
  // Structured fields; results recorded before they existed fall back to the finding text.
  const findings = r.findings.map((f) => f.description);
  const outOfScope = r.scopeViolation ?? (findings.some((f) => f.startsWith("Out-of-scope changes")) ? ["(see findings)"] : []);
  if (outOfScope.length) throw new Error(`refused: out-of-scope changes (not allowed by allowedPaths): ${outOfScope.join(", ")}. Undo those files in a follow-up task or re-delegate with the right allowed_paths.`);
  if (r.acceptanceStatus === "unmet") throw new Error(`refused: ${id} is unmet (${r.stopReason}${r.verification?.reasons.length ? `; ${r.verification.reasons.slice(0, 3).join("; ")}` : ""}). Re-delegate or fix it; an unmet result is never integrated.`);
  const tests = r.protectedPathsChanged ?? (findings.some((f) => f.startsWith("Tests or evaluator files were modified")) ? ["(see findings)"] : []);
  if (tests.length && a.accept_test_changes !== true) throw new Error(`Tests or evaluator files were modified: ${tests.join(", ")}. Review the change, then call integrate_task again with accept_test_changes: true if it is legitimate.`);
  const needsAcceptance = r.acceptanceStatus === "not_verified" || r.acceptanceStatus === "needs_supervisor";
  const reason = typeof a.reason === "string" ? a.reason.trim() : "";
  if (needsAcceptance && (a.accept !== true || !reason)) {
    throw new Error(`${id} is ${r.acceptanceStatus}${r.verification?.reasons.length ? ` (${r.verification.reasons.slice(0, 3).join("; ")})` : ""}. Check it against the job's goal and the brief, then call integrate_task again with accept: true and a reason (or use accept_task / reject_task).`);
  }
  return needsAcceptance ? { reason } : null;
}

/** Checks run after the gate that need the item's commits: the verified revision, and who may accept a strict result. */
async function integrationGateAfter(s: SupervisorState, id: string, t: TaskView, target: IntegrationTarget, acceptance: { reason: string } | null): Promise<void> {
  const r = t.result!;
  if (t.spec.constraints.labChecks?.length) {
    const authority = s.ctx.taskLabs ? taskLabAuthority(s.ctx.taskLabs, id, r.taskLab) : null;
    const problem = taskLabEvidenceProblem(t.spec, r.taskLab, authority);
    if (problem) throw new Error(`refused: ${problem}`);
    if (target.sourceWorktree !== authority!.attempt.sourceWorktree || target.head !== authority!.attempt.submittedCommit) {
      throw new Error("refused: integration source is not the checked winning attempt");
    }
  }
  // Checks are bound to the tree they ran on: a worktree changed since then is not what was verified.
  const verifiedTree = r.checks.map((c) => c.revision).find((x): x is string => typeof x === "string");
  if (target.kind === "task" && verifiedTree && target.sourceWorktree) {
    let head = (await git(target.sourceWorktree, ["rev-parse", "HEAD^{tree}"])).trim();
    if (head !== verifiedTree) {
      target.head = await sealRetainedCheckedTask(s.ctx, { taskId: id, alias: target.repo.alias, worktree: target.sourceWorktree, head: target.head, base: target.base, tree: verifiedTree });
      target.commits = (await git(target.sourceWorktree, ["rev-list", "--reverse", `${target.base}..${target.head}`])).split("\n").map(line => line.trim()).filter(Boolean);
      head = (await git(target.sourceWorktree, ["rev-parse", "HEAD^{tree}"])).trim();
    }
    if (head !== verifiedTree) throw new Error(`refused: ${id}'s worktree (tree ${head.slice(0, 12)}) is not the revision its checks ran on (${verifiedTree.slice(0, 12)}); re-delegate it`);
  }
  // A strict result only a human may accept is refused before anything is integrated.
  const cfgV = s.ctx.cfg.verification;
  if (acceptance && r.verification && cfgV.strict_acceptor === "human" && resolveLevel(cfgV, r.verification.level).acceptance === "supervisor") {
    throw new Error(`refused: ${id} is ${r.verification.level}; verification.strict_acceptor is human, so only a human can accept it (panel or CLI)`);
  }
}

/** Where a finished task's commits are: its worktree (coding task) or its job branches (sub-job). */
async function integrationTargets(s: SupervisorState, seam: IntegrationSeam, id: string, t: TaskView, repository: unknown): Promise<IntegrationTarget[]> {
  const commitsOf = async (cwd: string, base: string, head: string) => (await git(cwd, ["rev-list", "--reverse", `${base}..${head}`])).split("\n").map((l) => l.trim()).filter(Boolean);
  if (t.spec.profile === "supervise") {
    const out: IntegrationTarget[] = [];
    for (const repo of s.repos.values()) {
      if (typeof repository === "string" && repository && repo.alias !== repository) continue;
      const branch = `${s.ctx.cfg.supervisor.branch_prefix}${id}`;
      const head = (await git(repo.worktree, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`], { allowExit: [1] }).catch(() => "")).trim();
      if (!head) continue;
      const base = t.spec.context.baseCommits?.[repo.alias] ?? (await git(repo.worktree, ["merge-base", "HEAD", head])).trim();
      const wt = path.join(s.ctx.cfg.storageDir, "worktrees", `job-${id}-${repo.alias}`);
      out.push({ repo, kind: "job", sourceWorktree: existsSync(wt) ? wt : null, base, head, commits: await commitsOf(repo.worktree, base, head) });
    }
    if (!out.length) throw new Error(`${id} has no job branch to integrate in ${typeof repository === "string" && repository ? repository : "this job's writable repositories"}`);
    return out;
  }
  if (t.spec.constraints.labChecks?.length) {
    const authority = s.ctx.taskLabs ? taskLabAuthority(s.ctx.taskLabs, id, t.result?.taskLab) : null;
    const problem = taskLabEvidenceProblem(t.spec, t.result?.taskLab, authority);
    if (problem) throw new Error(`refused: ${problem}`);
    const source = authority!.attempt;
    const repo = seam.repoFor(source.writableAlias);
    const base = source.repositories.find(r => r.alias === source.writableAlias)!.baseCommit;
    return [{ repo, kind: "task", sourceWorktree: source.sourceWorktree, base, head: source.submittedCommit!, commits: await commitsOf(source.sourceWorktree, base, source.submittedCommit!) }];
  }
  const ws = s.db.prepare("SELECT worktree_path, base_sha, repo_alias FROM workspaces WHERE task_id = ?").get(id) as { worktree_path: string; base_sha: string; repo_alias: string } | undefined;
  if (!ws) throw new Error("task has no worktree (not a coding task?)");
  const repo = seam.repoFor(ws.repo_alias);
  const head = (await git(ws.worktree_path, ["rev-parse", "HEAD"])).trim();
  return [{ repo, kind: "task", sourceWorktree: ws.worktree_path, base: ws.base_sha, head, commits: await commitsOf(ws.worktree_path, ws.base_sha, head) }];
}

/** The re-delegated brief for a task whose integration conflicted: same task, based on the current job branch. */
function redelegationBrief(t: TaskView, item: MergeItem, files: string[], stage: string, label: string): Record<string, unknown> {
  const spec = t.spec;
  const done = spec.label ?? item.taskId;
  return {
    label,
    profile: spec.profile,
    goal: `${spec.goal}\n\nRedo of ${done} (task ${item.taskId}): its commits conflicted with the job branch ${item.branch} when they were integrated (${stage}; files: ${files.join(", ") || "unknown"}). Start from the current job branch, which already has other tasks' changes, and make the same change on top of it. The earlier attempt's patch is attached for reference.`,
    acceptance_criteria: spec.constraints.acceptanceCriteria,
    repositories: spec.repositoryAliases,
    ...(spec.writableRepository ? { writable_repository: spec.writableRepository } : {}),
    ...(spec.constraints.allowedPaths ? { allowed_paths: spec.constraints.allowedPaths } : {}),
    ...(spec.constraints.checks ? { checks: spec.constraints.checks } : {}),
    ...(spec.constraints.labChecks ? { lab_checks: spec.constraints.labChecks } : {}),
    ...(spec.context.fileRefs ? { file_refs: spec.context.fileRefs } : {}),
    ...(spec.hints?.difficulty ? { difficulty: spec.hints.difficulty } : {}),
    ...(spec.importance ? { importance: spec.importance } : {}),
    ...(spec.importanceReason ? { importance_reason: spec.importanceReason } : {}),
  };
}

/**
 * What the merge queue calls back into for this job: acceptance (recorded only once the picks
 * succeeded), the integration events and calibration signal, the job checks after each
 * integration, and one re-delegation of a task whose integration conflicted.
 */
export function integrationHooks(s: SupervisorState, env: HarnessEnv, seam: IntegrationSeam): MergeHooks {
  const jobId = s.ctx.taskId;
  const svc = s.ctx.services!;
  return {
    allowRebase: item => !svc.getTask(item.taskId)?.spec.constraints.labChecks?.length,
    validateSource: async item => {
      const task = svc.getTask(item.taskId);
      if (!task?.spec.constraints.labChecks?.length) return;
      const authority = s.ctx.taskLabs ? taskLabAuthority(s.ctx.taskLabs, item.taskId, task.result?.taskLab) : null;
      const problem = taskLabEvidenceProblem(task.spec, task.result?.taskLab, authority);
      if (problem) throw new Error(`refused: ${problem}`);
      const source = authority!.attempt;
      const base = source.repositories.find(repo => repo.alias === source.writableAlias)!.baseCommit;
      if (item.sourceHead !== source.submittedCommit || item.sourceBase !== base || item.sourceWorktree !== source.sourceWorktree) {
        throw new Error("refused: merge queue source differs from checked winning attempt");
      }
    },
    committer: { name: s.actor.agent, email: `${s.actor.agent.replace(/[^A-Za-z0-9._-]+/g, ".")}@meritrouter.local` },
    accept: (item) => {
      // Idempotent: a recovered item whose acceptance was already recorded is not accepted twice.
      if (svc.getTask(item.taskId)?.result?.acceptanceStatus === "met") return;
      svc.acceptTask(item.taskId, { by: seam.identity(), reason: item.acceptance!.reason });
    },
    integrated: (item, head) => {
      // Calibration: integration is a confirmation signal for the result's verification (its own event type).
      recordIntegration(s.db, s.ctx.tasks ?? null, { taskId: item.taskId, jobId, repo: item.repo, commits: item.commits.length, head, now: Date.now() });
      // Dependents read the task's latest `integrated` event (context/upstream.ts).
      new TaskStore(s.db).event(item.taskId, INTEGRATED_EVENT, { repository: item.repo, branch: item.branch, head });
    },
    checks: async (item) => {
      const out: Array<{ command: string; exitCode: number | null; logRef?: string }> = [];
      for (const command of s.ctx.spec?.constraints.checks ?? []) {
        const r = await executeSupervisorCommand(s.ctx, { command, cwd: item.integrationWorktree, invocationId: `integration_check:${item.id}:${item.attempts}:${out.length}`, env: minimalEnv({ CI: "1" }), timeoutMs: s.ctx.cfg.execution.check_timeout_seconds * 1000, reason: `Verify integration of task ${item.taskId}` });
        const logRef = s.ctx.artifacts?.write({ taskId: jobId, kind: "check_log", label: `${command} (after integrating ${item.taskId})`, content: `$ ${command}\nexit ${r.exitCode}\n${r.stdout}\n${r.stderr}`, extension: ".log" });
        const exitCode = r.killed ? null : r.exitCode;
        recordJobCheck(s.db, { jobId, repo: item.repo, command, exitCode, now: Date.now() });
        out.push({ command, exitCode, ...(logRef ? { logRef } : {}) });
      }
      if (s.ctx.lab && s.ctx.lab.rootJobId === jobId && item.afterHead) {
        const binding = s.ctx.lab;
        const input = {kind:"after_integrate" as const,expectedHeads:{[item.repo]:item.afterHead}};
        const mediated = await mediateOutsideOperation(env, "lab_check", { phase: "after_integrate", ...input });
        if (mediated !== null) throw new Error(`Lab integration checks require supervisor host authority; operator reports cannot replace execution proof: ${mediated}`);
        const op = await withOutsideAuthority(env, signal => binding.manager.control(binding.project, binding.name, input, `task:${jobId}`, {signal,taskLease:s.ctx.taskLease}));
        const results = z.array(LabCheckResultSchema).parse(op.result);
        for (const result of results) {
          const command = `lab:${result.name}`;
          const exitCode = result.killed ? null : result.exitCode;
          recordJobCheck(s.db, { jobId, repo: item.repo, command, exitCode, now: Date.now() });
          out.push({ command, exitCode });
        }
      }
      return out;
    },
    // A Lab's root job integrates into the Lab worktree, where the Lab's own services run: the
    // queue admits past exactly those services (the same scope as the supervisor's own admissions).
    admission: async item => s.ctx.lab && s.ctx.lab.rootJobId === jobId && item.jobId === jobId ? s.ctx.lab.integrationPermits(jobId, [item.repo]) : [],
    redelegate: async (item, conflict) => {
      const t = svc.getTask(item.taskId);
      if (!t) return null;
      return seam.redelegate(`${(t.spec.label ?? item.taskId).slice(0, 32)}-rebase`, (label) => redelegationBrief(t, item, conflict.files, conflict.stage, label), env, t.result?.patchRefs ?? []);
    },
  };
}

/** The supervisor's view of one integration's outcome. Refusals and failures throw. */
function describeMerge(s: SupervisorState, item: MergeItem): string {
  const files = (c: unknown) => ((c as { files?: string[] } | undefined)?.files ?? []).join(", ") || "unknown";
  const conflict = item.detail.conflict as { files?: string[]; message?: string; stage?: string } | undefined;
  switch (item.state) {
    case "integrated": {
      const checks = (item.detail.checks as Array<{ command: string; exitCode: number | null }> | undefined) ?? [];
      const failed = checks.filter((c) => c.exitCode !== 0);
      return [
        item.commits.length
          ? `integrated ${item.commits.length} commit(s) from ${item.taskId} onto ${item.branch}; head is now ${(item.afterHead ?? "").slice(0, 7)}`
          : `nothing new to integrate from ${item.taskId}: ${item.branch} already has its changes`,
        item.rebased ? `; it was rebased onto the branch head first (a pick failed: ${files(conflict)})` : "",
        item.acceptance ? "; your acceptance is recorded" : "",
        checks.length ? `; job checks after it: ${failed.length ? `${failed.length} FAILED (${failed.map((c) => `${c.command} -> ${c.exitCode}`).join(", ")}); undo it or fix the branch` : `${checks.length} passed`}` : "",
      ].join("");
    }
    case "redelegated": {
      const label = [...s.children.entries()].find(([, v]) => v === item.redelegatedTo)?.[0] ?? item.redelegatedTo;
      return `conflict integrating ${item.taskId}; nothing was changed and no acceptance was recorded. Conflicting files: ${files(conflict)}. Its checked source was preserved and it was re-delegated once as ${label} (${item.redelegatedTo}) based on the current job branch; await it and integrate that task instead.`;
    }
    case "conflict":
      return `conflict integrating ${item.taskId}; nothing was changed and no acceptance was recorded. Conflicting files: ${files(conflict)}.${conflict?.stage === "rebase" ? " Rebasing it onto the job branch conflicted too." : ""} Re-delegate based on the current job branch, or edit the files yourself. (${(conflict?.message ?? "").slice(0, 200)})`;
    case "refused":
      throw new Error(`refused: ${String(item.detail.error ?? "acceptance refused")}; the integration of ${item.taskId} was rolled back`);
    case "failed":
      throw new Error(`integrating ${item.taskId} failed: ${String(item.detail.error ?? "unknown error")}; ${item.branch} is as it was before`);
    default:
      return `${item.taskId}: integration ${item.state} on ${item.branch}`;
  }
}

/** Integrate a finished task (or sub-job) through the job's merge queue. */
async function integrate(s: SupervisorState, seam: IntegrationSeam, a: Record<string, unknown>, env: HarnessEnv): Promise<string> {
  const svc = s.ctx.services!;
  const jobId = s.ctx.taskId;
  const queue = queueOf(s);
  const id = seam.ownTask(a.task_id);
  const t = svc.getTask(id);
  if (!t?.result) throw new Error("task has not finished");
  // Already queued or integrated: continue or report it without the gate again.
  const repoFilter = typeof a.repository === "string" && a.repository ? a.repository : null;
  const priors = [...s.repos.keys()].filter((r) => !repoFilter || r === repoFilter).flatMap((r) => queue.latest(jobId, id, r) ?? []);
  const settled = (i: MergeItem) => ACTIVE_MERGE_STATES.has(i.state) || i.state === "integrated";
  if (priors.length && priors.every(settled)) {
    const lines: string[] = [];
    for (const p of priors) {
      if (p.state === "integrated") lines.push(`${id} is already integrated onto ${p.branch} (head ${(p.afterHead ?? "").slice(0, 7)}); nothing was picked again`);
      else lines.push(describeMerge(s, await queue.run(p.id, integrationHooks(s, env, seam))));
    }
    return lines.join("\n");
  }
  // An earlier attempt was re-delegated: integrating the original again is an explicit retry.
  const redelegated = priors.find((p) => p.state === "redelegated");
  const acceptance = integrationGate(s, id, t, a);
  const targets = await integrationTargets(s, seam, id, t, a.repository);
  for (const x of targets) await integrationGateAfter(s, id, t, x, acceptance);
  const lines: string[] = [];
  for (const x of targets) {
    const prior = queue.latest(jobId, id, x.repo.alias);
    if (prior?.state === "integrated") {
      lines.push(`${id} is already integrated onto ${prior.branch} (head ${(prior.afterHead ?? "").slice(0, 7)}); nothing was picked again`);
      continue;
    }
    if (!x.commits.length && !(prior && ACTIVE_MERGE_STATES.has(prior.state))) {
      lines.push(x.kind === "task" ? "nothing to integrate: the task made no commits (no acceptance was recorded)" : `nothing to integrate: ${id}'s branch has no commits for ${x.repo.alias}`);
      continue;
    }
    const item = queue.enqueue({
      jobId,
      taskId: id,
      kind: x.kind,
      repo: x.repo.alias,
      branch: x.repo.branch,
      integrationWorktree: x.repo.worktree,
      sourceWorktree: x.sourceWorktree,
      sourceBase: x.base,
      sourceHead: x.head,
      commits: x.commits,
      acceptance,
    });
    lines.push(describeMerge(s, await queue.run(item.id, integrationHooks(s, env, seam))));
  }
  if (redelegated) lines.unshift(`note: an earlier integration of ${id} conflicted and was re-delegated as ${redelegated.redelegatedTo}; this call tried the original again (it is not re-delegated a second time)`);
  return lines.join("\n");
}

/** The supervisor's integration tool: `integrate_task`. */
export function integrationTools(s: SupervisorState, seam: IntegrationSeam): HarnessTool[] {
  return [
    {
      def: {
        type: "function",
        function: {
          name: "integrate_task",
          description:
            "Integrate a finished coding task's commits, or a finished sub-job's branch, onto the job branch through the job's merge queue: one integration per branch at a time, commits cherry-picked one by one so per-line attribution is kept, and the job checks run after each. When a pick conflicts, ordinary work may be rebased once; tasks with required Lab checks preserve their checked source and are re-delegated with those checks on the current branch. A conflict that cannot be resolved is re-delegated once (the result says which task to integrate instead). Calling it again for an integrated task picks nothing twice. Refused for unmet results and for patches with out-of-scope edits. A result that is not_verified or needs_supervisor needs accept: true with a reason (judged against the job's goal and the brief; recorded as your acceptance once the integration succeeds); patches that changed tests or evaluator files also need accept_test_changes: true after you reviewed them.",
          parameters: {
            type: "object",
            properties: { task_id: { type: "string" }, accept: { type: "boolean" }, reason: { type: "string" }, accept_test_changes: { type: "boolean" }, repository: { type: "string", description: "sub-jobs: only this repository's branch (default: all)" } },
            required: ["task_id"],
          },
        },
      },
      sideEffect: "edit",
      // MergeQueue reconciles original operations durably. A resumed call must reach it;
      // stable repeated outcomes are still bounded by the loop's observation guard.
      repeatBehavior: "observe",
      run: async (a, env) => integrate(s, seam, a, env),
    },
  ];
}
