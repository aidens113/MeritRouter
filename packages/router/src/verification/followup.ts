import type { ResolvedConfig } from "../config/load.js";
import type { Db } from "../storage/db.js";
import type { ArtifactStore } from "../storage/artifacts.js";
import type { StoredTask } from "../storage/tasks.js";
import { git } from "../workspaces/git.js";
import { commitAs } from "../attribution/index.js";
import { agentLabel } from "../roles/index.js";
import { commandAllowed } from "../harness/tools.js";
// A reviewer is a worker: no reviewer-authored command may execute on the host without a supervisor.
import type { ReviewRecord, WorkerResult } from "../core/task.js";
import type { RetryContext } from "../runners/types.js";
import type { RunContext } from "../runners/types.js";
import { awaitWorkerCommand, workerSourceIdentity } from "../harness/worker-actions.js";

/**
 * What verification does after a verdict: one bounded repair that continues from the submitted
 * revision with the reviewer's findings, or one targeted check that supplies missing evidence.
 */

interface WorkspaceRow {
  worktree_path: string;
  base_sha: string;
  repo_alias: string;
}

function workspaceOf(db: Db, taskId: string): WorkspaceRow | null {
  return (db.prepare("SELECT worktree_path, base_sha, repo_alias FROM workspaces WHERE task_id = ?").get(taskId) as WorkspaceRow | undefined) ?? null;
}

/**
 * The commit a coding repair starts from: the task worktree's HEAD once everything submitted
 * is committed, and only when that commit's tree is exactly the revision that was verified.
 * Null when there is no worktree (or it moved on), so the repair starts from the base.
 */
export async function submittedRevisionStart(db: Db, task: StoredTask, revision: string | null): Promise<{ alias: string; commit: string } | null> {
  const ws = workspaceOf(db, task.row.id);
  if (!ws || !revision) return null;
  try {
    let tree = (await git(ws.worktree_path, ["rev-parse", "HEAD^{tree}"])).trim();
    if (tree !== revision) {
      // Submitted but uncommitted edits (an external agent's last response): commit them as the
      // implementer, so the repair builds on exactly what was reviewed.
      await commitAs(ws.worktree_path, { agent: agentLabel("implementer", task.spec.label ?? task.row.id), role: "tool", model: null, task: task.row.id, job: task.spec.parentTaskId ?? null }, "implementer: submitted revision before repair");
      tree = (await git(ws.worktree_path, ["rev-parse", "HEAD^{tree}"])).trim();
    }
    if (tree !== revision) return null;
    return { alias: ws.repo_alias, commit: (await git(ws.worktree_path, ["rev-parse", "HEAD"])).trim() };
  } catch {
    return null;
  }
}

/**
 * The commit an escalated coding run starts from when the previous attempt ran out of requests:
 * that attempt's worktree HEAD, its uncommitted edits committed first, when it moved past the
 * base. Without this the escalation started from an empty worktree and redid (or lost) the work.
 * Null when there is no worktree or nothing was written.
 */
export async function unfinishedWorkStart(db: Db, task: StoredTask): Promise<{ alias: string; commit: string; files: string[] } | null> {
  const ws = workspaceOf(db, task.row.id);
  if (!ws) return null;
  try {
    if ((await git(ws.worktree_path, ["status", "--porcelain"])).trim()) {
      await git(ws.worktree_path, ["add", "-A"]);
      await commitAs(ws.worktree_path, { agent: agentLabel("implementer", task.spec.label ?? task.row.id), role: "tool", model: null, task: task.row.id, job: task.spec.parentTaskId ?? null }, "implementer: unfinished work before escalation");
    }
    const head = (await git(ws.worktree_path, ["rev-parse", "HEAD"])).trim();
    if (head === ws.base_sha) return null;
    const files = (await git(ws.worktree_path, ["diff", "--name-only", ws.base_sha, head])).split(/\r?\n/).filter(Boolean);
    return files.length ? { alias: ws.repo_alias, commit: head, files } : null;
  } catch {
    return null;
  }
}

/** An escalation's retry context when it continues the previous attempt's unfinished work. */
export function carryOverRetryContext(base: RetryContext, carried: { alias: string; commit: string; files: string[] }): RetryContext {
  const shown = carried.files.slice(0, 12).join(", ") + (carried.files.length > 12 ? `, and ${carried.files.length - 12} more` : "");
  return {
    ...base,
    verificationReasons: [
      ...base.verificationReasons,
      `Your workspace already contains the previous attempt's unfinished work (commit ${carried.commit.slice(0, 12)}; changed: ${shown}). Read those files and continue from them; do not start over.`,
    ],
    startFrom: { alias: carried.alias, commit: carried.commit },
  };
}

/**
 * The repair's retry context: the failure context plus the reviewer's findings and failed
 * criteria (data about the previous attempt, never instructions), and where the work resumes.
 */
export function repairRetryContext(base: RetryContext, review: ReviewRecord | null, startFrom: { alias: string; commit: string } | null): RetryContext {
  const fromReview = review?.verdict === "fail"
    ? [
        ...review.blockingFindings.map((f) => `Reviewer: ${f.description}${f.evidenceRefs.length ? ` (${f.evidenceRefs.join(", ")})` : ""}`.slice(0, 600)),
        ...review.criteria.filter((c) => c.outcome === "fail").map((c) => `Reviewer: criterion ${c.id} fails: ${c.reason ?? ""}`.slice(0, 600)),
      ]
    : [];
  return {
    ...base,
    findings: [...fromReview, ...base.findings].slice(0, 16),
    verificationReasons: [
      ...base.verificationReasons,
      ...(startFrom ? [`Your workspace starts at the revision you submitted (${startFrom.commit.slice(0, 12)}); fix the defects above rather than starting over.`] : []),
    ],
    startFrom,
  };
}

/** A targeted check may run a declared check or a command the coding allowlist permits. */
export function targetedCheckAllowed(cfg: ResolvedConfig, declared: string[]): (command: string) => boolean {
  return (command) => declared.includes(command.trim()) || commandAllowed(command, cfg.coding.allowed_commands);
}

/**
 * Run the reviewer's targeted checks once, in the task's worktree, bound to the submitted
 * revision. Nothing runs when the worktree is no longer at that revision. Returns the new check
 * records (appended to the result's checks) or an explanation.
 */
export async function runTargetedChecks(
  d: { cfg: ResolvedConfig; db: Db; artifacts: ArtifactStore; signal: AbortSignal; context?: RunContext },
  task: StoredTask,
  result: Pick<WorkerResult, "checks">,
  revision: string | null,
  artifactDigest: string | null,
  commands: string[],
): Promise<{ records: WorkerResult["checks"]; note: string }> {
  const ws = workspaceOf(d.db, task.row.id);
  if (!ws || !revision) return { records: [], note: "no worktree at the submitted revision; the targeted check did not run" };
  const allowed = targetedCheckAllowed(d.cfg, task.spec.constraints.checks ?? []);
  let tree: string;
  try {
    // The index is the submitted state (collect staged everything); it must still be the revision.
    tree = (await git(ws.worktree_path, ["write-tree"])).trim();
  } catch (err) {
    return { records: [], note: `the worktree cannot be read (${(err as Error).message.slice(0, 200)}); the targeted check did not run` };
  }
  if (tree !== revision) return { records: [], note: `the worktree moved from the submitted revision ${revision.slice(0, 12)}; the targeted check did not run` };
  const records: WorkerResult["checks"] = [];
  for (const command of commands.slice(0, 3)) {
    if (!allowed(command)) continue;
    if (!d.context) return { records, note: "targeted check lacks its captured execution context; no host command ran" };
    const action = await awaitWorkerCommand(d.context, { command, cwd: ws.worktree_path, invocationId: `targeted:${d.context.session?.id ?? task.row.run_count}:${result.checks.length}:${records.length}`, timeoutMs: d.cfg.execution.check_timeout_seconds * 1000, reason: "Independent reviewer requested this exact targeted check; supervisor host authority is required." });
    const unchanged = action.action.source === await workerSourceIdentity(ws.worktree_path);
    const logRef = d.artifacts.write({ taskId: task.row.id, kind: "check_log", label: `targeted: ${command}`, content: `${action.output ?? `Supervisor action ${action.id}: ${action.status}`}\nrevision ${revision}`, extension: ".log" });
    records.push({ command, exitCode: unchanged && action.status === "completed" ? action.exitCode : null, logRef, revision, ...(artifactDigest ? { artifactDigest } : {}) });
  }
  return { records, note: records.length ? `targeted check(s) ran on ${revision.slice(0, 12)}: ${records.map((c) => `${c.command} -> ${c.exitCode ?? "killed"}`).join("; ")}` : "no requested check is declared or allowed; nothing ran" };
}
