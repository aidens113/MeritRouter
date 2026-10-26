import { hydrateRepairWorkspace, verifyRepairHydration } from "../../workspaces/repair-hydration.js";
import { runTaskLabChecks } from "./task-lab.js";
import type { TaskLabEvidence } from "../../labs/task-attempt-schema.js";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { Workspace, Worktrees } from "../../workspaces/worktree.js";
import type { SessionWorkspace } from "../../sessions/events.js";
import { git } from "../../workspaces/git.js";
import type { EvidenceUniverse, WorkerOutput } from "../../core/worker-output.js";
import { baseResult, type RunContext, type RunOutcome } from "../types.js";
import { awaitWorkerCommand, workerSourceIdentity } from "../../harness/worker-actions.js";
import { criteria } from "../../core/task.js";
import { checkRunOutcome } from "../../verification/checks.js";
import { sealCheckedCandidate } from "../../attribution/checked-candidate.js";
import { workerActor } from "../../harness/worker.js";
import { assertRunAuthority } from "../../harness/task-authority.js";
import { RepositoryMutationError, withRepositoryMutation } from "../../workspaces/repository-mutation.js";
import { SelectedCommitError } from "../../attribution/selected-commit.js";
import { CommitObjectSchema } from "../../attribution/selected-commit-receipts.js";

export function sourceDirtyFinding(ws: Workspace): RunOutcome["result"]["findings"] {
  return ws.sourceDirty
    ? [{ description: `The source checkout had ${ws.dirtyPaths.length} uncommitted change(s) that are NOT in this worktree (based on ${ws.baseSha.slice(0, 12)}).`, evidenceRefs: [] }]
    : [];
}

export async function prepareWorkspace(ctx: RunContext): Promise<{ ws: Workspace; worktrees: Worktrees }> {
  const { Worktrees } = await import("../../workspaces/worktree.js");
  const alias = ctx.spec.writableRepository!;
  const repo = ctx.cfg.repositoryPaths[alias]!;
  const worktrees = new Worktrees(ctx.tasks.db, path.join(ctx.cfg.storageDir, "worktrees"), ctx.now);
  const runNo = ctx.spec.constraints.labChecks?.length ? ctx.claimedRunCount : (ctx.claimedRunCount ?? ctx.tasks.get(ctx.taskId)!.row.run_count);
  if (runNo === undefined) throw new Error("task Lab workspace requires its captured claim generation");
  // A quality repair continues from the submitted revision; the diff is still taken against the base.
  const start = ctx.retry?.startFrom?.alias === alias ? ctx.retry.startFrom.commit : null;
  const ws = await worktrees.prepare({ taskId: ctx.taskId, run: runNo, alias, sourcePath: repo.path, ...(ctx.spec.context.baseCommits?.[alias] ? { baseCommit: ctx.spec.context.baseCommits[alias] } : {}), ...(start ? { startCommit: start } : {}) });
  await withRepositoryMutation([ws.sourcePath, ws.worktreePath], async mutation => {
    assertRunAuthority(ctx);
    await hydrateRepairWorkspace(ctx, ws, { mutation });
    assertRunAuthority(ctx);
    ctx.tasks.event(ctx.taskId, "worktree_ready", { path: ws.worktreePath, baseSha: ws.baseSha, sourceDirty: ws.sourceDirty, ...(start ? { startCommit: start } : {}) });
  });
  return { ws, worktrees };
}

/**
 * The worktree a resumed session recorded, when it still exists: the run continues there (its
 * commits and any reconciled edits included). Null when there is nothing to reuse.
 */
export async function resumeWorkspace(ctx: RunContext, recorded: SessionWorkspace | null): Promise<{ ws: Workspace; worktrees: Worktrees; head: string } | null> {
  const alias = ctx.spec.writableRepository!;
  const rec = recorded?.repos.find((r) => r.alias === alias);
  if (!rec || !rec.baseCommit || !existsSync(rec.worktree)) return null;
  const { Worktrees } = await import("../../workspaces/worktree.js");
  const worktrees = new Worktrees(ctx.tasks.db, path.join(ctx.cfg.storageDir, "worktrees"), ctx.now);
  const prev = worktrees.previous(ctx.taskId);
  const ws: Workspace =
    prev && path.resolve(prev.worktreePath) === path.resolve(rec.worktree)
      ? prev
      : { taskId: ctx.taskId, repoAlias: alias, sourcePath: ctx.cfg.repositoryPaths[alias]!.path, worktreePath: rec.worktree, baseSha: rec.baseCommit, sourceDirty: false, dirtyPaths: [] };
  return withRepositoryMutation([ws.sourcePath, ws.worktreePath], async mutation => {
    assertRunAuthority(ctx);
    await verifyRepairHydration(ctx, ws, { mutation });
    assertRunAuthority(ctx);
    worktrees.setStatus(ctx.taskId, "ready");
    ctx.tasks.event(ctx.taskId, "worktree_reused", { path: ws.worktreePath, baseSha: ws.baseSha });
    const head = (await git(ws.worktreePath, ["rev-parse", "HEAD"])).trim();
    return { ws, worktrees, head };
  });
}

export function agentHome(ctx: RunContext, ws: Workspace): string {
  const home = path.join(ctx.cfg.storageDir, "agent-home", path.basename(ws.worktreePath));
  mkdirSync(home, { recursive: true });
  return home;
}

/** The tree the worktree is submitted at (everything staged): what the checks are bound to. */
async function stagedTree(worktree: string): Promise<string> {
  return CommitObjectSchema.parse((await git(worktree, ["write-tree"])).trim());
}

/**
 * Shared end of every coding run: diff against the recorded base, scope and protected-file
 * checks, the supervisor's checks bound to the submitted tree, and a preliminary acceptance
 * from that evidence alone (the executor's verification decides the final one).
 */
export async function finishCoding(
  ctx: RunContext,
  o: {
    ws: Workspace;
    worktrees: Worktrees;
    executionId: string;
    findings: RunOutcome["result"]["findings"];
    artifactRefs: string[];
    stopReason: string;
    /** Agent-level outcome before evidence: completed, budget_exhausted, cancelled, interrupted. */
    state: RunOutcome["state"];
    summaryLead: string;
    /** What the worker had and read (native runner); refs it cited are checked against it. */
    universe?: EvidenceUniverse | null;
    /** The worker's own per-criterion assessment, when it submitted one. */
    output?: Pick<WorkerOutput, "criteria"> | null;
  },
): Promise<RunOutcome> {
  const spec = ctx.spec;
  const alias = spec.writableRepository!;
  const { changes, revision } = await withRepositoryMutation([o.ws.sourcePath, o.ws.worktreePath], async mutation => {
    assertRunAuthority(ctx);
    const changes = await o.worktrees.collect(o.ws, spec.constraints.allowedPaths ?? [], ctx.cfg.coding.protected_paths, { mutation });
    // Collection and sealing share one short mutation scope; checks/approval waits below do not.
    const revision = await stagedTree(o.ws.worktreePath);
    if (!ctx.signal.aborted && o.state === "completed" && changes.changed.length && !changes.outOfScope.length) {
      const head = (await git(o.ws.worktreePath, ["rev-parse", "HEAD"])).trim();
      const sealed = await sealCheckedCandidate({ worktree: o.ws.worktreePath, head, tree: revision, mutation,
        actor: workerActor(ctx, "implementer", ctx.attempts.at(-1)?.endpointId ?? null), assertAuthority: () => assertRunAuthority(ctx) });
      assertRunAuthority(ctx);
      if (sealed !== head) ctx.session?.setWorkspace({ repos: [{ alias, worktree: o.ws.worktreePath, branch: null, baseCommit: o.ws.baseSha, head: sealed }] });
    }
    return { changes, revision };
  });
  const artifactDigest = changes.patch ? createHash("sha256").update(changes.patch).digest("hex") : null;
  const patchRef = changes.patch
    ? ctx.artifacts.write({ taskId: ctx.taskId, executionId: o.executionId, kind: "patch", label: `patch against ${o.ws.baseSha.slice(0, 12)}`, content: changes.patch, mediaType: "text/x-diff", extension: ".patch" })
    : null;
  const findings = [...o.findings];
  if (changes.outOfScope.length) findings.push({ description: `Out-of-scope changes (not allowed by allowedPaths): ${changes.outOfScope.join(", ")}`, evidenceRefs: patchRef ? [patchRef] : [] });
  if (changes.protectedChanged.length) findings.push({ description: `Tests or evaluator files were modified: ${changes.protectedChanged.join(", ")}. Verify the behaviour independently.`, evidenceRefs: patchRef ? [patchRef] : [] });
  findings.push({ description: `Changed ${changes.changed.length} file(s): ${changes.changed.map((c) => `${c.status} ${c.path}`).join(", ") || "none"}`, evidenceRefs: patchRef ? [patchRef] : [] });

  const aborted = ctx.signal.aborted;
  const checks: RunOutcome["result"]["checks"] = [];
  if (!aborted && changes.changed.length) {
    for (const command of spec.constraints.checks ?? []) {
      const action = await awaitWorkerCommand(ctx, { command, cwd: o.ws.worktreePath, invocationId: `final_check:${o.executionId}:${checks.length}`, timeoutMs: ctx.cfg.execution.check_timeout_seconds * 1000, reason: "Post-submission source check requires exact supervisor execution, not unsandboxed worker shell." });
      const unchanged = action.action.source === await workerSourceIdentity(o.ws.worktreePath);
      const logRef = ctx.artifacts.write({ taskId: ctx.taskId, executionId: o.executionId, kind: "check_log", label: command, content: `${action.output ?? `Supervisor action ${action.id}: ${action.status}`}\nrevision ${revision}\n${unchanged ? "source unchanged" : "source changed; check is not valid evidence"}`, extension: ".log" });
      checks.push({ command, exitCode: action.status === "completed" && unchanged ? action.exitCode : null, logRef, revision, ...(artifactDigest ? { artifactDigest } : {}) });
    }
  }
  let taskLab: TaskLabEvidence | undefined;
  const artifactRefs = [...o.artifactRefs];
  if (spec.constraints.labChecks?.length && !ctx.signal.aborted && o.state === "completed" && changes.changed.length && !changes.outOfScope.length && checks.every(check => check.exitCode === 0) && revision && artifactDigest) {
    try {
      taskLab = await runTaskLabChecks(ctx, o.ws, o.executionId, revision, artifactDigest);
      artifactRefs.push(ctx.artifacts.writeJson({ taskId: ctx.taskId, executionId: o.executionId, kind: "task_lab", label: "Task attempt Lab evidence", value: taskLab }));
    } catch (error) {
      if (error instanceof RepositoryMutationError || error instanceof SelectedCommitError) throw error;
      findings.push({ description: "Required task Lab checks did not complete; the result cannot be accepted or integrated.", evidenceRefs: [] });
    }
  }
  await withRepositoryMutation([o.ws.sourcePath, o.ws.worktreePath], async () => {
    assertRunAuthority(ctx); o.worktrees.setStatus(ctx.taskId, "collected");
  });

  const labRequired = !!spec.constraints.labChecks?.length;
  const labPassed = taskLab?.status === "passed" && taskLab.cleanup === "complete";
  const checksPassed = (checks.length > 0 || labPassed) && checks.every((c) => c.exitCode === 0);
  const anyCheckFailed = checks.some((c) => c.exitCode !== 0);
  const acceptance =
    changes.outOfScope.length || anyCheckFailed || (labRequired && !labPassed) || changes.changed.length === 0
      ? "unmet"
      : checksPassed && !changes.protectedChanged.length && (spec.constraints.checks?.length ?? 0) === checks.length
        ? "met"
        : "not_verified";
  const state: RunOutcome["state"] = ctx.signal.aborted ? (ctx.signal.reason === "cancel" ? "cancelled" : "interrupted") : o.state;
  // Per criterion: a check-verified criterion is resolved when its own checks passed on this
  // revision; anything else is unresolved until someone verifies it.
  const unresolved =
    acceptance === "met"
      ? []
      : criteria(spec)
          .filter((c) => c.verify !== "check" || changes.outOfScope.length > 0 || c.checks.some((cmd) => checkRunOutcome(cmd, checks, revision, artifactDigest).outcome !== "passed"))
          .map((c) => c.text);
  return {
    state,
    result: baseResult({
      executionStatus: state === "completed" ? "completed" : state,
      acceptanceStatus: acceptance === "met" && state !== "completed" ? "not_verified" : acceptance,
      stopReason: o.stopReason,
      summary: `${changes.changed.length} file(s) changed in an isolated worktree based on ${o.ws.baseSha.slice(0, 12)}. Checks: ${checks.length ? checks.map((c) => `${c.command} -> ${c.exitCode}`).join("; ") : "none run"}.${o.summaryLead ? `\n${o.summaryLead}` : ""}`,
      findings,
      artifactRefs,
      ...(taskLab ? { taskLab } : {}),
      patchRefs: patchRef ? [patchRef] : [],
      baseCommits: { [alias]: o.ws.baseSha },
      checks,
      unresolvedCriteria: unresolved,
      changedPaths: changes.changed.map((c) => c.path),
      scopeViolation: changes.outOfScope,
      protectedPathsChanged: changes.protectedChanged,
    }),
    evidence: { revision, artifactDigest, universe: o.universe ?? null, output: o.output ?? null },
  };
}
