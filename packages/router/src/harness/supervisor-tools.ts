import { existsSync } from "node:fs";
import path from "node:path";
import type { Db } from "../storage/db.js";
import { newId } from "../storage/db.js";
import { globsOverlap } from "../storage/file-leases.js";
import { MAX_PLAN_NODES, PlanStore, criticalPath, defaultRequiresAcceptedInputs, nodeWeight, type PlanDifficulty, type PlanNodeInput } from "../storage/plans.js";
import { AWAITING_ACCEPTANCE, TaskStore } from "../storage/tasks.js";
import { INTEGRATED_EVENT } from "../context/upstream.js";
import type { RunContext } from "../runners/types.js";
import { IMPORTANCE_LEVELS, MIN_CHILD_REQUESTS, PROFILE_NAMES, maxAgentsPerJob, type Importance } from "../config/schema.js";
import { ARTIFACT_REF_RE } from "../core/task.js";
import { carvedRequests, childRequestBudget, recordCarve } from "../admission/admission.js";
import { MergeQueue, ACTIVE_MERGE_STATES, type MergeHooks, type MergeItem } from "../workspaces/merge-queue.js";
import { resolveLevel } from "../verification/policy.js";
import { git } from "../workspaces/git.js";
import { blame, commitsMatching, revertCommits, undoLines, type Actor } from "../attribution/index.js";
import { calibrationUndoHook, recordIntegration, recordJobCheck } from "../verification/calibration.js";
import { formatBrief, parseDoc, replaceSection, section } from "../brain/protocol.js";
import type { ToolSideEffect } from "../sessions/events.js";
import { minimalEnv, runProcess } from "../runners/coding/process.js";
import { commandAllowed, type HarnessEnv, type HarnessTool } from "./tools.js";

export interface IntegrationRepo {
  alias: string;
  worktree: string;
  branch: string;
  baseSha: string;
}

export interface SupervisorState {
  ctx: RunContext;
  db: Db;
  actor: Actor;
  repos: Map<string, IntegrationRepo>;
  /** Checks named in this job's briefs; the supervisor may run them. */
  briefChecks: Set<string>;
  /** label -> task id for tasks this job dispatched. */
  children: Map<string, string>;
  /** The job's merge queue (one per supervisor run); created on first use when absent. */
  queue?: MergeQueue;
  /** Supervisor level of this job: 1 for a top-level job, parent's + 1 for a sub-job (computed when absent). */
  depth?: number;
  /** A sub-job's own section of its parent's working document (null or absent for a top-level job). */
  docSection?: string | null;
}

/** Marker before a sub-job's own status in its section (the brief above it is the parent's). */
const SUB_JOB_STATUS = "**Sub-job status:**";

/**
 * A sub-job's section in two parts: the record (its brief from the parent, branches, budget, and
 * the briefs it dispatched) and its status, which the sub-job rewrites in place.
 */
function subJobParts(text: string, heading: string): { record: string; status: string } {
  const body = section(parseDoc(text), heading)?.body ?? "";
  const at = body.indexOf(SUB_JOB_STATUS);
  return { record: (at >= 0 ? body.slice(0, at) : body).replace(/\s+$/, ""), status: at >= 0 ? body.slice(at).replace(/\s+$/, "") : "" };
}

function joinParts(...parts: string[]): string {
  return parts.filter(Boolean).join("\n\n");
}

/** Heading of a sub-job's section in its parent job's working document. */
export function subJobSection(label: string): string {
  return `Sub-job: ${label}`;
}

/** Supervisor level of a job: 1 at the top, plus one per supervising ancestor. */
export function jobDepth(tasks: Pick<TaskStore, "get">, jobId: string): number {
  let depth = 1;
  const seen = new Set<string>();
  let cur = tasks.get(jobId);
  while (cur?.spec.parentTaskId && !seen.has(cur.row.id)) {
    seen.add(cur.row.id);
    const parent = tasks.get(cur.spec.parentTaskId);
    if (!parent) break;
    if (parent.spec.profile === "supervise") depth++;
    cur = parent;
  }
  return depth;
}

function depthOf(s: SupervisorState): number {
  if (s.depth === undefined) {
    try {
      s.depth = jobDepth(new TaskStore(s.db), s.ctx.taskId);
    } catch {
      return 1; // no task store behind this state: a top-level job
    }
  }
  return s.depth;
}

/** The job's merge queue for this run. */
export function queueOf(s: SupervisorState): MergeQueue {
  s.queue ??= new MergeQueue(s.db, new TaskStore(s.db), newId("mqrun"));
  return s.queue;
}

/** May this job delegate a `supervise` sub-job (team.max_depth)? */
function maySupervise(s: SupervisorState): boolean {
  return depthOf(s) < (s.ctx.cfg.team?.max_depth ?? 2);
}

const MAX = 14_000;
const cap = (t: string) => (t.length > MAX ? `${t.slice(0, MAX)}\n[truncated]` : t);
const str = (v: unknown, n: string) => {
  if (typeof v !== "string" || !v) throw new Error(`${n} is required`);
  return v;
};
function tool(name: string, sideEffect: ToolSideEffect, description: string, properties: Record<string, unknown>, required: string[], run: HarnessTool["run"]): HarnessTool {
  return { def: { type: "function", function: { name, description, parameters: { type: "object", properties, required } } }, sideEffect, run };
}

/** How the supervisor judges a result; shared by the acceptance tools' descriptions. */
export const ACCEPTANCE_JUDGEMENT =
  "Judge the result against the job's goal and the specifications you were given (the goal, acceptance criteria, and checks in your brief), using evidence you checked yourself, not the worker's own report.";

/** The supervisor as recorded on acceptance decisions: this job's agent. */
function supervisorIdentity(s: SupervisorState): { kind: "supervisor"; id: string } {
  return { kind: "supervisor", id: `${s.actor.agent} (job ${s.ctx.taskId})` };
}

/** Resolve a label or id to one of this job's own tasks; other jobs' tasks are refused. */
function ownTask(s: SupervisorState, ref: unknown): string {
  const key = String(ref ?? "");
  const id = s.children.get(key) ?? key;
  if (![...s.children.values()].includes(id)) throw new Error(`${key} is not a task of this job`);
  return id;
}

function repoFor(s: SupervisorState, alias: unknown): IntegrationRepo {
  const a = typeof alias === "string" && alias ? alias : [...s.repos.keys()][0];
  const r = a ? s.repos.get(a) : undefined;
  if (!r) throw new Error(`no integration worktree for ${String(alias)}; writable repositories: ${[...s.repos.keys()].join(", ") || "none"}`);
  return r;
}

/** Conservative path-set overlap test (the file leases' rule). */
export const overlaps = globsOverlap;

const slug = (l: unknown) => String(l ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 40);

/**
 * One brief's properties, shared by `delegate` tasks and `plan_work` nodes. `supervise` (a
 * sub-supervisor for a sub-goal) is offered only while the job is below `team.max_depth`.
 */
function briefProperties(allowSupervise: boolean): Record<string, unknown> {
  return {
    label: { type: "string", description: "short unique id, e.g. fix-parser" },
    profile: {
      type: "string",
      enum: PROFILE_NAMES.filter((p) => allowSupervise || p !== "supervise"),
      ...(allowSupervise ? { description: "supervise: a sub-supervisor for a sub-goal with its own workers, on its own branch forked from yours, with a share of your request budget; integrate its branch with integrate_task when it finishes" } : {}),
    },
    goal: { type: "string" },
    acceptance_criteria: { type: "array", items: { type: "string" } },
    file_refs: { type: "array", items: { type: "string" }, description: "<alias>:<path>[#Lx-Ly]" },
    repositories: { type: "array", items: { type: "string" } },
    writable_repository: { type: "string" },
    allowed_paths: { type: "array", items: { type: "string" } },
    must_not_touch: { type: "array", items: { type: "string" } },
    checks: { type: "array", items: { type: "string" } },
    difficulty: { type: "string", enum: ["T1", "T2", "T3", "T4"] },
    importance: { type: "string", enum: [...IMPORTANCE_LEVELS], description: "how much the result matters (default normal); raises verification, never difficulty" },
    importance_reason: { type: "string", description: "why; required for high and critical" },
    depends_on: { type: "array", items: { type: "string" }, description: "labels of tasks this one needs first (in this call, or dispatched earlier); it starts once they finish and sees their results" },
    brain_grants: { type: "array", items: { type: "object", properties: { pattern: { type: "string" }, mode: { type: "string", enum: ["read", "append"] } } } },
  };
}

/**
 * Nothing open in this job can move without the supervisor: no task of the job is queued or
 * running, and at least one awaited task waits for an upstream result to be accepted.
 */
function blockedOnAcceptance(s: SupervisorState, pending: Array<{ taskId: string; state: string }>): boolean {
  const svc = s.ctx.services!;
  const moving = [...s.children.values()].some((id) => ["queued", "running", "waiting_for_capacity", "cancel_requested"].includes(svc.getTask(id)?.state ?? ""));
  return !moving && pending.some((p) => p.state === "waiting_for_dependencies" && (stateReason(s, p.taskId) ?? "").startsWith(AWAITING_ACCEPTANCE));
}

/** The state reason of a task (why it is waiting), when the store has one. */
function stateReason(s: SupervisorState, id: string): string | null {
  try {
    return (s.db.prepare("SELECT state_reason FROM tasks WHERE id = ?").get(id) as { state_reason: string | null } | undefined)?.state_reason ?? null;
  } catch {
    return null;
  }
}

/** Write a working-document change through the brain (sub-job sections, their briefs). */
async function writeDoc(env: HarnessEnv, edit: (text: string) => string, message?: string): Promise<void> {
  const b = env.brain;
  if (!b?.workingDoc) return;
  const text = b.brain.read(b.principal(), b.workingDoc).content;
  await b.brain.write(b.principal(), b.actor, b.workingDoc, edit(text), message);
}

/** Record a brief: in the job's Worker Briefs, or in a sub-job's own section of its parent's document. */
async function recordBrief(s: SupervisorState, env: HarnessEnv, brief: string): Promise<void> {
  const b = env.brain;
  if (!b?.workingDoc) return;
  const title = `Brief: ${brief.split("\n")[0]!.replace(/^### Brief: /, "")}`;
  // A sub-job's briefs join its record, above the status it rewrites.
  const sec = s.docSection;
  if (sec)
    await writeDoc(
      env,
      (t) => {
        const p = subJobParts(t, sec);
        return replaceSection(t, sec, joinParts(p.record, brief.replace(/\n+$/, ""), p.status), "Work Ledger");
      },
      title,
    );
  else await b.brain.addBrief(b.principal(), b.actor, b.workingDoc, brief);
}

/**
 * Dispatch briefs through the delegate path: each new label's brief is recorded in the working
 * document, then all new tasks are submitted at once (dependencies by label, also within the
 * call). Labels already dispatched are not submitted again. Path overlap is advisory: the
 * scheduler's file leases keep overlapping writers apart, and the job's agent cap is applied by
 * the scheduler, so tasks over it wait queued.
 *
 * A `supervise` brief starts a sub-job (while this job is below `team.max_depth`): it works on
 * its own branch forked from this job's branch, gets its own section of this job's working
 * document, and a request budget carved from this job's remaining one (`team.child_budget_share`).
 */
async function dispatchBriefs(s: SupervisorState, items: Array<Record<string, unknown>>, env: HarnessEnv, opts: { artifactRefs?: Record<string, string[]> } = {}): Promise<string> {
  const svc = s.ctx.services!;
  const jobId = s.ctx.taskId;
  const labels = items.map((it) => slug(str(it.label, "label")));
  const dup = labels.find((l, i) => labels.indexOf(l) !== i);
  if (dup) throw new Error(`label ${dup} is used more than once`);
  const fresh = items.map((it, i) => ({ it, label: labels[i]! })).filter((x) => !s.children.has(x.label));
  const ids = new Map(fresh.map((x) => [x.label, newId("t")]));
  for (const { it, label } of fresh) if (it.profile === "implement" && !((it.allowed_paths as string[] | undefined) ?? []).length) throw new Error(`${label}: implement briefs need allowed_paths`);
  const depIds = (it: Record<string, unknown>) =>
    ((it.depends_on as string[] | undefined) ?? []).map((l) => s.children.get(slug(l)) ?? ids.get(slug(l)) ?? (s.children.has(l) ? s.children.get(l)! : l));

  // Sub-supervisors: the depth limit, then a budget carved from what this job has left.
  const team = s.ctx.cfg.team;
  const subs = fresh.filter((x) => x.it.profile === "supervise");
  const carves = new Map<string, { requests: number; remaining: number }>();
  if (subs.length) {
    const depth = depthOf(s);
    if (!maySupervise(s)) throw new Error(`${subs[0]!.label}: sub-supervisors are limited to team.max_depth ${team.max_depth}; this job is at depth ${depth}, so delegate workers instead`);
    const used = s.ctx.gate.admission.taskTotals(jobId).requests;
    let carved = carvedRequests(s.db, jobId);
    for (const { label } of subs) {
      const c = childRequestBudget({ parentCap: s.ctx.budget.maxModelRequests, parentUsed: used, carved, share: team.child_budget_share, min: MIN_CHILD_REQUESTS });
      if (!c) throw new Error(`${label}: not enough request budget left for a sub-supervisor (${Math.max(0, s.ctx.budget.maxModelRequests - used - carved)} remaining, share ${team.child_budget_share}, at least ${MIN_CHILD_REQUESTS} needed); delegate workers instead`);
      carves.set(label, c);
      carved += c.requests;
    }
  }

  // Advisory: overlapping coding briefs in one repository run one after the other (file leases).
  const notes: string[] = [];
  const active = [...s.children.entries()].flatMap(([label, id]) => {
    const t = svc.getTask(id);
    return t && t.spec.writableRepository && !["completed", "failed", "cancelled", "budget_exhausted"].includes(t.state) ? [{ label, repo: t.spec.writableRepository, paths: t.spec.constraints.allowedPaths ?? ["**"] }] : [];
  });
  for (const { it, label } of fresh) {
    if (it.profile !== "implement") continue;
    const repo = String(it.writable_repository ?? [...s.repos.keys()][0] ?? "");
    const paths = (it.allowed_paths as string[] | undefined) ?? [];
    const deps = new Set(((it.depends_on as string[] | undefined) ?? []).map(slug));
    const clash = active.find((t) => t.repo === repo && !deps.has(t.label) && globsOverlap(t.paths, paths));
    if (clash) notes.push(`note: ${label} overlaps ${clash.label} in ${repo}; it waits until ${clash.label}'s file lease is released (add depends_on to order them, or narrow allowed_paths to run them in parallel)`);
    active.push({ label, repo, paths });
  }

  const specs = fresh.map(({ it, label }) => {
    const sub = it.profile === "supervise";
    const repos = (it.repositories as string[] | undefined) ?? [...new Set([...s.repos.keys(), ...s.ctx.spec.repositoryAliases])];
    const writable = it.profile === "implement" ? String(it.writable_repository ?? [...s.repos.keys()][0] ?? "") : undefined;
    const baseCommits: Record<string, string> = {};
    if (writable && s.repos.get(writable)) baseCommits[writable] = "HEAD_OF_JOB";
    // A sub-job's branches fork from this job's branches as integrated so far.
    if (sub) for (const alias of repos) if (s.repos.get(alias)) baseCommits[alias] = "HEAD_OF_JOB";
    const checks = (it.checks as string[] | undefined) ?? [];
    for (const c of checks) s.briefChecks.add(c);
    const deps = depIds(it);
    const carve = carves.get(label);
    const artifactRefs = (opts.artifactRefs?.[label] ?? []).filter((r) => ARTIFACT_REF_RE.test(r));
    return {
      label,
      sub,
      carve,
      brief: formatBrief({
        label,
        repository: writable ?? repos.join(", "),
        task: `${String(it.profile)}: ${String(it.goal)}`,
        requiredReads: ((it.file_refs as string[] | undefined) ?? []).join(", ") || "as needed",
        owns: sub ? `its own job branch ${s.ctx.cfg.supervisor.branch_prefix}${ids.get(label)!}, forked from this job's branch` : ((it.allowed_paths as string[] | undefined) ?? []).join(", ") || "nothing (read-only)",
        mustNotTouch: ((it.must_not_touch as string[] | undefined) ?? []).join(", ") || "everything else",
        done: `${((it.acceptance_criteria as string[] | undefined) ?? []).join("; ")}${checks.length ? `; checks: ${checks.join(", ")}` : ""}`,
        reportTo: `projects/${s.ctx.brain?.project ?? "default"}/working/${s.ctx.effort}/reports/${label}.md`,
      }),
      spec: {
        id: ids.get(label),
        profile: it.profile,
        label,
        goal: String(it.goal),
        parentTaskId: jobId,
        idempotencyKey: `${jobId}:${label}`,
        repositoryAliases: repos,
        ...(writable ? { writableRepository: writable } : {}),
        context: { ...(it.file_refs ? { fileRefs: it.file_refs } : {}), ...(artifactRefs.length ? { artifactRefs } : {}), baseCommits },
        constraints: { acceptanceCriteria: it.acceptance_criteria, ...(it.allowed_paths && !sub ? { allowedPaths: it.allowed_paths } : {}), ...(checks.length ? { checks } : {}) },
        ...(it.difficulty && !sub ? { hints: { difficulty: it.difficulty } } : {}),
        ...(it.importance ? { importance: it.importance } : {}),
        ...(it.importance_reason ? { importanceReason: it.importance_reason } : {}),
        ...(deps.length ? { dependsOn: deps } : {}),
        ...(carve ? { budget: { maxModelRequests: carve.requests } } : {}),
        brain: { effort: s.ctx.effort, ...(it.brain_grants ? { grants: it.brain_grants } : {}) },
      } as Record<string, unknown>,
    };
  });
  // Workers start from the job branch as integrated so far (a dependent's base is chosen again
  // when it starts: see context/upstream.ts).
  for (const sp of specs) {
    const bc = (sp.spec.context as { baseCommits: Record<string, string> }).baseCommits;
    for (const alias of Object.keys(bc)) bc[alias] = (await git(s.repos.get(alias)!.worktree, ["rev-parse", "HEAD"])).trim();
  }
  for (const sp of specs) {
    if (!sp.sub) {
      await recordBrief(s, env, sp.brief);
      continue;
    }
    // The sub-job's own section of this job's working document: its brief, branches, and budget.
    const bc = (sp.spec.context as { baseCommits: Record<string, string> }).baseCommits;
    const forks = Object.entries(bc).map(([alias, sha]) => `${alias}: ${s.ctx.cfg.supervisor.branch_prefix}${String(sp.spec.id)} forked from ${s.repos.get(alias)?.branch ?? "?"} at ${sha.slice(0, 12)}`);
    const body = `${sp.brief}\n\n- Sub-job ${String(sp.spec.id)} of job ${jobId} (depth ${depthOf(s) + 1}); request budget ${sp.carve!.requests} of ${sp.carve!.remaining} remaining (share ${team.child_budget_share})\n- Branches: ${forks.join("; ") || "none (read-only)"}`;
    await writeDoc(env, (t) => replaceSection(t, subJobSection(sp.label), body, "Work Ledger"), `Sub-job: ${sp.label}`);
  }
  // The delegating session becomes each new task's parent session.
  const out = specs.length ? await svc.submitTasks(specs.map((sp) => sp.spec), { purpose: "work", ...(s.ctx.session ? { parentSessionId: s.ctx.session.id } : {}) }) : [];
  out.forEach((o, i) => {
    const sp = specs[i]!;
    s.children.set(sp.label, o.taskId);
    // Recorded after the submission (the carve names the task); a crash in between is repaired
    // when the job resumes (see ensureCarves).
    if (sp.carve) recordCarve(s.db, { childTaskId: o.taskId, parentTaskId: jobId, requests: sp.carve.requests, parentRemaining: sp.carve.remaining, share: team.child_budget_share, depth: depthOf(s) + 1 }, Date.now());
  });
  const submitted = new Map(out.map((o, i) => [specs[i]!.label, o]));
  const lines = labels.map((label) => {
    const o = submitted.get(label);
    const carve = carves.get(label);
    if (o) return `${label} -> ${o.taskId} (${o.state}${o.deduplicated ? ", already submitted" : ""})${carve ? `; sub-supervisor with ${carve.requests} requests on branch ${s.ctx.cfg.supervisor.branch_prefix}${o.taskId}` : ""}`;
    const id = s.children.get(label)!;
    return `${label} -> ${id} (${svc.getTask(id)?.state ?? "unknown"}, already submitted)`;
  });
  const max = maxAgentsPerJob(s.ctx.cfg);
  const live = [...s.children.values()].filter((id) => {
    const st = svc.getTask(id)?.state;
    return st && !["completed", "failed", "cancelled", "budget_exhausted", "interrupted"].includes(st);
  }).length;
  if (out.length && live > max) notes.push(`note: ${live} tasks are open and at most ${max} run at once for this job (team.max_agents); the rest start as running ones finish`);
  return [...lines, ...notes].join("\n");
}

/**
 * Record carves a crash lost between a sub-job's submission and its carve (idempotent): the
 * sub-job's budget is in its spec, so the parent's admission counts it again.
 */
export function ensureCarves(s: SupervisorState): void {
  const tasks = new TaskStore(s.db);
  for (const id of s.children.values()) {
    const t = tasks.get(id);
    const requests = t?.spec.profile === "supervise" ? t.spec.budget?.maxModelRequests : undefined;
    if (requests) recordCarve(s.db, { childTaskId: id, parentTaskId: s.ctx.taskId, requests, parentRemaining: null, share: s.ctx.cfg.team.child_budget_share, depth: depthOf(s) + 1 }, Date.now());
  }
}

function summarizeResult(id: string, s: SupervisorState): string {
  const t = s.ctx.services!.getTask(id);
  if (!t) return `${id}: unknown`;
  const r = t.result;
  if (!r) return `${id} (${t.spec.label ?? t.spec.profile}): ${t.state}`;
  const v = r.verification;
  return [
    `${id} (${t.spec.label ?? t.spec.profile}): ${r.executionStatus}, acceptance ${r.acceptanceStatus}, ${r.stopReason}`,
    ...(v ? [`  verification ${r.verificationStatus ?? "?"} at level ${v.level}${v.raisedFrom ? ` (raised from ${v.raisedFrom})` : ""}, importance ${v.importance}${v.reasons.length ? `: ${v.reasons.slice(0, 3).join("; ").slice(0, 400)}` : ""}`] : []),
    ...(r.acceptanceStatus === "needs_supervisor" || r.acceptanceStatus === "not_verified" ? ["  decide: accept_task (with your reason) or reject_task after checking it against the goal and your brief"] : []),
    `  summary: ${r.summary.split("\n").slice(0, 3).join(" ").slice(0, 400)}`,
    ...r.findings.slice(0, 5).map((f) => `  finding: ${f.description.slice(0, 200)}${f.evidenceRefs.length ? ` [${f.evidenceRefs.slice(0, 3).join(", ")}]` : ""}`),
    ...(r.patchRefs.length ? [`  patch: ${r.patchRefs.join(", ")} (base ${Object.values(r.baseCommits).map((c) => c.slice(0, 12)).join(", ")})`] : []),
    ...(t.spec.profile === "supervise" && t.state === "completed" ? [`  sub-job: integrate_task ${t.spec.label ?? id} brings its branch ${s.ctx.cfg.supervisor.branch_prefix}${id} onto yours`] : []),
    ...r.checks.map((c) => `  check: ${c.command} -> ${c.exitCode} (${c.logRef})`),
    ...(r.unresolvedCriteria.length ? [`  unresolved: ${r.unresolvedCriteria.join("; ")}`] : []),
    `  requests ${r.usage.modelRequests}, served by ${r.servedEndpoints.join(", ") || "none"}`,
  ].join("\n");
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
  // Checks are bound to the tree they ran on: a worktree changed since then is not what was verified.
  const verifiedTree = r.checks.map((c) => c.revision).find((x): x is string => typeof x === "string");
  if (target.kind === "task" && verifiedTree && target.sourceWorktree) {
    const head = (await git(target.sourceWorktree, ["rev-parse", "HEAD^{tree}"])).trim();
    if (head !== verifiedTree) throw new Error(`refused: ${id}'s worktree (tree ${head.slice(0, 12)}) is not the revision its checks ran on (${verifiedTree.slice(0, 12)}); re-delegate it`);
  }
  // A strict result only a human may accept is refused before anything is integrated.
  const cfgV = s.ctx.cfg.verification;
  if (acceptance && r.verification && cfgV.strict_acceptor === "human" && resolveLevel(cfgV, r.verification.level).acceptance === "supervisor") {
    throw new Error(`refused: ${id} is ${r.verification.level}; verification.strict_acceptor is human, so only a human can accept it (panel or CLI)`);
  }
}

/** Where a finished task's commits are: its worktree (coding task) or its job branches (sub-job). */
async function integrationTargets(s: SupervisorState, id: string, t: TaskView, repository: unknown): Promise<IntegrationTarget[]> {
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
  const ws = s.db.prepare("SELECT worktree_path, base_sha, repo_alias FROM workspaces WHERE task_id = ?").get(id) as { worktree_path: string; base_sha: string; repo_alias: string } | undefined;
  if (!ws) throw new Error("task has no worktree (not a coding task?)");
  const repo = repoFor(s, ws.repo_alias);
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
export function mergeHooks(s: SupervisorState, env: HarnessEnv): MergeHooks {
  const jobId = s.ctx.taskId;
  const svc = s.ctx.services!;
  return {
    committer: { name: s.actor.agent, email: `${s.actor.agent.replace(/[^A-Za-z0-9._-]+/g, ".")}@switchyard.local` },
    accept: (item) => {
      // Idempotent: a recovered item whose acceptance was already recorded is not accepted twice.
      if (svc.getTask(item.taskId)?.result?.acceptanceStatus === "met") return;
      svc.acceptTask(item.taskId, { by: supervisorIdentity(s), reason: item.acceptance!.reason });
    },
    integrated: (item, head) => {
      // Calibration: integration is a confirmation signal for the result's verification.
      recordIntegration(s.db, s.ctx.tasks ?? null, { taskId: item.taskId, jobId, repo: item.repo, commits: item.commits.length, head, now: Date.now() });
      // Written last, so it is the task's latest `integrated` event (dependents read it: context/upstream.ts).
      new TaskStore(s.db).event(item.taskId, INTEGRATED_EVENT, { repository: item.repo, branch: item.branch, head });
    },
    checks: async (item) => {
      const out: Array<{ command: string; exitCode: number | null; logRef?: string }> = [];
      for (const command of s.ctx.spec?.constraints.checks ?? []) {
        const r = await runProcess(command, [], { cwd: item.integrationWorktree, env: minimalEnv({ CI: "1" }), timeoutMs: s.ctx.cfg.execution.check_timeout_seconds * 1000, signal: s.ctx.signal, shell: true });
        const logRef = s.ctx.artifacts?.write({ taskId: jobId, kind: "check_log", label: `${command} (after integrating ${item.taskId})`, content: `$ ${command}\nexit ${r.exitCode}\n${r.stdout}\n${r.stderr}`, extension: ".log" });
        const exitCode = r.killed ? null : r.exitCode;
        recordJobCheck(s.db, { jobId, repo: item.repo, command, exitCode, now: Date.now() });
        out.push({ command, exitCode, ...(logRef ? { logRef } : {}) });
      }
      return out;
    },
    redelegate: async (item, conflict) => {
      const t = svc.getTask(item.taskId);
      if (!t) return null;
      const label = slug(`${(t.spec.label ?? item.taskId).slice(0, 32)}-rebase`);
      if (!s.children.has(label)) await dispatchBriefs(s, [redelegationBrief(t, item, conflict.files, conflict.stage, label)], env, { artifactRefs: { [label]: t.result?.patchRefs ?? [] } });
      return s.children.get(label) ?? null;
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
      return `conflict integrating ${item.taskId}; nothing was changed and no acceptance was recorded. Conflicting files: ${files(conflict)}. Rebasing it onto the job branch conflicted too, so it was re-delegated once as ${label} (${item.redelegatedTo}) based on the current job branch; await it and integrate that task instead.`;
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
async function integrate(s: SupervisorState, a: Record<string, unknown>, env: HarnessEnv): Promise<string> {
  const svc = s.ctx.services!;
  const jobId = s.ctx.taskId;
  const queue = queueOf(s);
  const id = ownTask(s, a.task_id);
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
      else lines.push(describeMerge(s, await queue.run(p.id, mergeHooks(s, env))));
    }
    return lines.join("\n");
  }
  // An earlier attempt was re-delegated: integrating the original again is an explicit retry.
  const redelegated = priors.find((p) => p.state === "redelegated");
  const acceptance = integrationGate(s, id, t, a);
  const targets = await integrationTargets(s, id, t, a.repository);
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
    lines.push(describeMerge(s, await queue.run(item.id, mergeHooks(s, env))));
  }
  if (redelegated) lines.unshift(`note: an earlier integration of ${id} conflicted and was re-delegated as ${redelegated.redelegatedTo}; this call tried the original again (it is not re-delegated a second time)`);
  return lines.join("\n");
}

/** Tools only supervisors get: delegation, waiting, integration, attribution, undo, questions. */
export function supervisorTools(s: SupervisorState): HarnessTool[] {
  const svc = s.ctx.services!;
  const jobId = s.ctx.taskId;

  return [
    tool(
      "delegate",
      "delegate",
      "Dispatch worker tasks. Each brief is recorded in the job's working document first. Coding briefs must name allowed_paths and should name checks. depends_on may name labels in the same call; a dependent starts when they finish and is given their results. Overlapping coding briefs in one repository are allowed but run one after the other (team-wide file leases); tasks beyond the job's agent cap wait queued. For a goal with several parts, prefer plan_work.",
      { tasks: { type: "array", items: { type: "object", properties: briefProperties(maySupervise(s)), required: ["label", "profile", "goal", "acceptance_criteria"] } } },
      ["tasks"],
      async (a, env) => {
        const items = Array.isArray(a.tasks) ? (a.tasks as Array<Record<string, unknown>>) : [];
        if (!items.length) throw new Error("tasks is empty");
        return dispatchBriefs(s, items, env);
      },
    ),

    tool(
      "plan_work",
      "delegate",
      "Record the job's decomposition as a task graph (a new plan version) and dispatch every node through delegate at once. Nodes with no unfinished dependencies run in parallel, up to the job's agent cap; a node starts when its depends_on nodes finish and is given their results (summary, findings, artifacts, patches, acceptance). requires_accepted_inputs (default true for high and critical importance) makes a node wait until its upstream results are accepted (met, or accepted by you with accept_task) instead of starting on unverified work. Re-planning: call again with the full plan; nodes already dispatched keep their tasks (changes to them are ignored; cancel and use a new label instead), dispatched nodes you leave out are carried over. Returns the critical path (longest chain by estimated cost).",
      {
        nodes: { type: "array", items: { type: "object", properties: { ...briefProperties(maySupervise(s)), requires_accepted_inputs: { type: "boolean", description: "start only on accepted upstream results (default: true for high/critical importance)" } }, required: ["label", "profile", "goal", "acceptance_criteria"] } },
        note: { type: "string", description: "what this version changes and why" },
      },
      ["nodes"],
      async (a, env) => {
        const items = Array.isArray(a.nodes) ? (a.nodes as Array<Record<string, unknown>>) : [];
        if (!items.length) throw new Error("nodes is empty");
        if (items.length > MAX_PLAN_NODES) throw new Error(`a plan holds at most ${MAX_PLAN_NODES} nodes`);
        const store = new PlanStore(s.db, s.ctx.now);
        const previous = store.latest(jobId);
        const nodes: PlanNodeInput[] = items.map((it) => {
          const label = slug(str(it.label, "label"));
          const profile = String(it.profile ?? "");
          const importance = (it.importance as Importance | undefined) ?? null;
          const difficulty = (it.difficulty as PlanDifficulty | undefined) ?? null;
          return {
            label,
            profile: profile as PlanNodeInput["profile"],
            goal: String(it.goal ?? ""),
            acceptanceCriteria: Array.isArray(it.acceptance_criteria) ? (it.acceptance_criteria as unknown[]).map(String) : [],
            dependsOn: ((it.depends_on as string[] | undefined) ?? []).map(slug),
            writableRepository: profile === "implement" ? String(it.writable_repository ?? [...s.repos.keys()][0] ?? "") || null : null,
            allowedPaths: (it.allowed_paths as string[] | undefined) ?? null,
            checks: (it.checks as string[] | undefined) ?? [],
            difficulty,
            importance,
            requiresAcceptedInputs: typeof it.requires_accepted_inputs === "boolean" ? it.requires_accepted_inputs : defaultRequiresAcceptedInputs(importance),
            weight: nodeWeight(difficulty, s.ctx.cfg.profiles[profile as keyof typeof s.ctx.cfg.profiles]?.min_tier ?? null),
          };
        });
        // Dispatched nodes keep their tasks: their recorded definition stays the one dispatched,
        // and dispatched nodes the new version leaves out are carried over.
        const named = new Set(nodes.map((n) => n.label));
        const kept: string[] = [];
        const recorded = nodes.map((n) => {
          if (!s.children.has(n.label)) return n;
          kept.push(n.label);
          return previous?.nodes.find((p) => p.label === n.label) ?? n;
        });
        const carried = (previous?.nodes ?? []).filter((p) => !named.has(p.label) && s.children.has(p.label));
        const all = [...recorded, ...carried];
        const external = new Set([...s.children.keys()].filter((l) => !all.some((n) => n.label === l)));
        const plan = store.record(jobId, all, { note: typeof a.note === "string" ? a.note : null, createdBy: s.actor.agent, external });
        let dispatched: string;
        try {
          const freshItems = items.filter((it) => !s.children.has(slug(it.label)));
          dispatched = freshItems.length ? await dispatchBriefs(s, freshItems, env) : "";
        } catch (err) {
          // Nothing was submitted: the version is withdrawn so the plan matches the tasks.
          if (!nodes.some((n) => !kept.includes(n.label) && s.children.has(n.label))) store.discard(jobId, plan.version);
          throw err;
        }
        const cp = criticalPath(plan.nodes);
        const fresh = nodes.length - kept.length;
        return [
          `plan v${plan.version} recorded: ${plan.nodes.length} node(s); ${fresh} dispatched now, ${kept.length} already dispatched (kept)${carried.length ? `, ${carried.length} carried over (${carried.map((c) => c.label).join(", ")})` : ""}`,
          `critical path: ${cp.labels.join(" -> ")} (estimated cost ${cp.cost}); at most ${maxAgentsPerJob(s.ctx.cfg)} task(s) of this job run at once`,
          ...(dispatched ? [dispatched] : []),
        ].join("\n");
      },
    ),

    tool("await_tasks", "none", "Wait (without model requests) until the given tasks, or all of this job's active tasks, finish or the timeout passes. Returns early when everything still open waits for you to accept or reject an upstream result. Returns compact results.", { task_ids: { type: "array", items: { type: "string" } }, timeout_seconds: { type: "integer" } }, [], async (a) => {
      const ids = Array.isArray(a.task_ids) && a.task_ids.length ? (a.task_ids as string[]).map((x) => ownTask(s, x)) : [...s.children.values()];
      if (!ids.length) return "no tasks dispatched yet";
      const until = Date.now() + Math.min(Number(a.timeout_seconds) || 1800, 3600) * 1000;
      // Wait in slices: a dependent waiting on this supervisor's acceptance would otherwise hold
      // the wait until the timeout while nothing else can happen.
      let r: Awaited<ReturnType<typeof svc.awaitResults>>;
      for (;;) {
        r = await svc.awaitResults(ids, { timeoutSeconds: Math.max(1, Math.min(3, Math.ceil((until - Date.now()) / 1000))), signal: s.ctx.signal, uncapped: true });
        if (!r.pending.length || Date.now() >= until || s.ctx.signal.aborted || blockedOnAcceptance(s, r.pending)) break;
      }
      return cap([...r.completed.map((c) => summarizeResult(c.taskId, s)), ...r.pending.map((p) => {
        const why = stateReason(s, p.taskId);
        return `${p.taskId}: still ${p.state}${why && why !== "resumed" ? ` (${why}${why.startsWith(AWAITING_ACCEPTANCE) ? "; accept_task or reject_task the upstream result" : ""})` : ""}`;
      })].join("\n"));
    }),

    tool("task_result", "read", "Full result of one task (findings, evidence, checks, patch references).", { task_id: { type: "string" } }, ["task_id"], async (a) => {
      const id = ownTask(s, a.task_id);
      const t = svc.getTask(id);
      if (!t) throw new Error("unknown task");
      return cap(JSON.stringify({ state: t.state, spec: { label: t.spec.label, profile: t.spec.profile, goal: t.spec.goal }, result: t.result }, null, 1));
    }),

    tool("cancel_tasks", "delegate", "Cancel tasks this job dispatched.", { task_ids: { type: "array", items: { type: "string" } } }, ["task_ids"], async (a) => {
      svc.cancelTasks((a.task_ids as string[]).map((x) => ownTask(s, x)));
      return "cancellation requested";
    }),

    tool(
      "accept_task",
      "delegate",
      `${ACCEPTANCE_JUDGEMENT} Accept a finished task's result for this job. Acceptance is recorded on the task with who accepted (this job's supervisor) and your reason, so state what you checked and how it meets the goal and the brief. A reason is required unless the result is already met. Unmet results cannot be accepted: reject them or re-delegate. When verification.strict_acceptor is human, strict results are refused here and wait for a human (CLI, MCP, or panel).`,
      { task_id: { type: "string" }, reason: { type: "string", description: "what you verified and why the result meets the job's goal and the brief's specifications" } },
      ["task_id"],
      async (a) => {
        const id = ownTask(s, a.task_id);
        const r = svc.acceptTask(id, { by: supervisorIdentity(s), reason: typeof a.reason === "string" ? a.reason : null });
        return `${id} accepted (acceptance ${r.acceptanceStatus}); recorded as ${r.decision.by.kind} ${r.decision.by.id}`;
      },
    ),

    tool(
      "reject_task",
      "delegate",
      `${ACCEPTANCE_JUDGEMENT} Reject a finished task's result for this job; it becomes unmet (dependents waiting on it fail). The rejection is recorded with who rejected and your reason, which is required.`,
      { task_id: { type: "string" }, reason: { type: "string" } },
      ["task_id", "reason"],
      async (a) => {
        const id = ownTask(s, a.task_id);
        const r = svc.rejectTask(id, { by: supervisorIdentity(s), reason: str(a.reason, "reason") });
        return `${id} rejected (acceptance ${r.acceptanceStatus})`;
      },
    ),

    tool(
      "integrate_task",
      "edit",
      "Integrate a finished coding task's commits, or a finished sub-job's branch, onto the job branch through the job's merge queue: one integration per branch at a time, commits cherry-picked one by one so per-line attribution is kept, and the job checks run after each. When a pick conflicts, the work is rebased onto the branch head in its own worktree and picked again; if that conflicts too, it is re-delegated once on the current branch (the result says which task to integrate instead) and nothing changes. Calling it again for an integrated task picks nothing twice. Refused for unmet results and for patches with out-of-scope edits. A result that is not_verified or needs_supervisor needs accept: true with a reason (judged against the job's goal and the brief; recorded as your acceptance once the integration succeeds); patches that changed tests or evaluator files also need accept_test_changes: true after you reviewed them.",
      { task_id: { type: "string" }, accept: { type: "boolean" }, reason: { type: "string" }, accept_test_changes: { type: "boolean" }, repository: { type: "string", description: "sub-jobs: only this repository's branch (default: all)" } },
      ["task_id"],
      async (a, env) => integrate(s, a, env),
    ),

    tool("run_check", "command", "Run a check command in the job's integration worktree (commands from your briefs' checks or the supervisor allowlist).", { command: { type: "string" }, repository: { type: "string" } }, ["command"], async (a) => {
      const repo = repoFor(s, a.repository);
      const command = str(a.command, "command");
      const allowed = s.briefChecks.has(command) || commandAllowed(command, [...s.ctx.cfg.supervisor.allowed_commands, ...s.ctx.cfg.coding.allowed_commands]);
      if (!allowed) throw new Error("command not allowed: use a check from one of your briefs or add it to supervisor.allowed_commands");
      const r = await runProcess(command, [], { cwd: repo.worktree, env: minimalEnv({ CI: "1" }), timeoutMs: s.ctx.cfg.execution.check_timeout_seconds * 1000, signal: s.ctx.signal, shell: true });
      const log = s.ctx.artifacts.write({ taskId: jobId, kind: "check_log", label: command, content: `$ ${command}\nexit ${r.exitCode}\n${r.stdout}\n${r.stderr}`, extension: ".log" });
      recordJobCheck(s.db, { jobId, repo: repo.alias, command, exitCode: r.killed ? null : r.exitCode, now: Date.now() });
      return cap(`$ ${command}\nexit ${r.exitCode}${r.killed ? ` (killed: ${r.killed})` : ""} (log ${log})\n${r.stdout.slice(-6000)}\n${r.stderr.slice(-3000)}`);
    }),

    tool("blame", "read", "Who wrote each line of a file on the job branch: agent, model, task, grouped into ranges.", { path: { type: "string" }, repository: { type: "string" } }, ["path"], async (a) => {
      const repo = repoFor(s, a.repository);
      const lines = await blame(repo.worktree, str(a.path, "path"));
      const ranges: string[] = [];
      let start = 0;
      for (let i = 1; i <= lines.length; i++) {
        const prev = lines[i - 1]!;
        const cur = lines[i];
        if (!cur || cur.commit !== prev.commit) {
          ranges.push(`L${lines[start]!.line}-L${prev.line}: ${prev.agent ?? prev.authorName} (${prev.model ?? prev.role ?? "?"}) ${prev.commit.slice(0, 10)}`);
          start = i;
        }
      }
      return cap(ranges.join("\n"));
    }),

    tool(
      "undo",
      "edit",
      "Undo changes on the job branch at your discretion: a whole task, everything a model did, one commit, or specific lines of a file. Every undo is a new commit with your reason; changes made before this job are never touched.",
      { kind: { type: "string", enum: ["task", "model", "agent", "commit", "lines"] }, target: { type: "string", description: "task id/label, model endpoint id, agent, or commit" }, path: { type: "string" }, ranges: { type: "array", items: { type: "array", items: { type: "integer" } } }, reason: { type: "string" }, repository: { type: "string" } },
      ["kind", "reason"],
      async (a) => {
        const repo = repoFor(s, a.repository);
        const reason = str(a.reason, "reason");
        if (a.kind === "lines") {
          const ranges = ((a.ranges as number[][] | undefined) ?? []).map((r) => [r[0]!, r[1] ?? r[0]!] as [number, number]);
          const r = await undoLines(repo.worktree, str(a.path, "path"), ranges, s.actor, reason, { sinceCommit: repo.baseSha, onUndone: calibrationUndoHook(s.db, s.ctx.tasks ?? null, { jobId, now: Date.now }) });
          return `undid lines ${r.undone.join(", ") || "none"}${r.skipped.length ? `; skipped ${r.skipped.map((x) => `${x.line} (${x.why})`).join(", ")}` : ""}${r.commit ? ` in ${r.commit.slice(0, 10)}` : ""}`;
        }
        const target = str(a.target, "target");
        let commits: string[];
        if (a.kind === "commit") {
          // Only commits made during this job (after its base) may be undone.
          const sha = (await git(repo.worktree, ["rev-parse", "--verify", `${target}^{commit}`])).trim();
          const jobCommits = new Set((await git(repo.worktree, ["rev-list", `${repo.baseSha}..HEAD`])).split("\n").filter(Boolean));
          if (!jobCommits.has(sha)) throw new Error(`${target} is not a commit made during this job; changes from before the job are never undone`);
          commits = [sha];
        }
        else {
          const key = a.kind === "task" ? "Task" : a.kind === "model" ? "Model" : "Agent";
          const value = a.kind === "task" ? (s.children.get(target) ?? target) : target;
          commits = (await commitsMatching(repo.worktree, `${repo.baseSha}..HEAD`, { [key]: value })).map((c) => c.commit);
        }
        if (!commits.length) return "no matching commits on the job branch";
        const c = await revertCommits(repo.worktree, commits, s.actor, reason, { onUndone: calibrationUndoHook(s.db, s.ctx.tasks ?? null, { jobId, now: Date.now }) });
        return `reverted ${commits.length} commit(s) in ${c?.slice(0, 10) ?? "(nothing to commit)"}`;
      },
    ),

    // A sub-job keeps its own section of its parent's working document instead of Current State.
    ...(s.docSection
      ? [
          tool("brain_set_job_section", "brain", `Rewrite your sub-job's section ("${s.docSection}") of the parent job's working document: your plan, what is done, what is not, what is next. The parent's Current State belongs to the parent supervisor.`, { body: { type: "string" } }, ["body"], async (a, env) => {
            if (!env.brain?.workingDoc) throw new Error("the brain is disabled for this job");
            const body = str(a.body, "body");
            await writeDoc(env, (t) => replaceSection(t, s.docSection!, joinParts(subJobParts(t, s.docSection!).record, `${SUB_JOB_STATUS}\n${body}`), "Work Ledger"), `Update ${s.docSection}`);
            return `${s.docSection} updated`;
          }),
        ]
      : []),

    tool("ask_user", "external", "Ask the user a question and wait for the answer. Use only when a decision belongs to them.", { question: { type: "string" }, options: { type: "array", items: { type: "string" } } }, ["question"], async (a) => {
      const id = Number(
        s.db.prepare("INSERT INTO job_questions (task_id, question, options_json, asked_at) VALUES (?, ?, ?, ?)").run(jobId, str(a.question, "question"), a.options ? JSON.stringify(a.options) : null, Date.now()).lastInsertRowid,
      );
      s.ctx.tasks.event(jobId, "question", { id, question: a.question });
      const until = Date.now() + s.ctx.cfg.supervisor.question_timeout_seconds * 1000;
      while (Date.now() < until && !s.ctx.signal.aborted) {
        const row = s.db.prepare("SELECT answer, answered_by FROM job_questions WHERE id = ?").get(id) as { answer: string | null; answered_by: string | null };
        if (row.answer !== null) return `answer from ${row.answered_by ?? "user"}: ${row.answer}`;
        await new Promise((r) => setTimeout(r, 1000));
      }
      // Interrupted while waiting: stop here; the question stays open and the resumed job sees the answer.
      if (s.ctx.signal.aborted) throw new Error("interrupted while waiting for the user's answer");
      return "no answer arrived; decide with a sensible default and record it";
    }),
  ];
}

export type { HarnessEnv };
