import { delegatedSourceSnapshot } from "./delegated-source.js";
import { assertExplicitRepairReferences } from "./repair-reference.js";
import { resolveRepairSource } from "../workspaces/repair-hydration.js";
import { executeSupervisorCommand, WorkerActionRequests, type WorkerActionRequest } from "./worker-actions.js";
import { supervisorActionTools, workerActionCapability } from "./worker-action-tools.js";
import { z } from "zod";
import type { Db } from "../storage/db.js";
import { immediate, newId } from "../storage/db.js";
import { assertProjectServiceBinding } from "../core/project-services.js";
import { currentSupervisorAuthority,projectToolIdentity } from "../core/supervisor-authority.js";
import { LeaseRefSchema } from "../storage/lease-ref.js";
import { globsOverlap } from "../storage/file-leases.js";
import { MAX_PLAN_NODES, PlanStore, criticalPath, defaultRequiresAcceptedInputs, nodeWeight, type PlanDifficulty, type PlanNodeInput } from "../storage/plans.js";
import { AWAITING_ACCEPTANCE, TaskStore } from "../storage/tasks.js";
import type { RunContext } from "../runners/types.js";
import { IMPORTANCE_LEVELS, MIN_CHILD_REQUESTS, PROFILE_NAMES, maxAgentsPerJob, type Importance } from "../config/schema.js";
import { ARTIFACT_REF_RE, WorkerTaskSchema } from "../core/task.js";
import { childRequestBudget, heldRequests, recordCarve } from "../admission/admission.js";
import { grantOf, recordGrant } from "../admission/job-pool.js";
import { defaultTaskGrant } from "../admission/budget-requests.js";
import { grantBriefs, pendingBudgetLines, supervisorAsked, supervisorBudgetTools } from "./budget-tools.js";
import { SHARED_FILES_EVENT, sharedFilesArg } from "./coordination-edits.js";
import type { MergeHooks, MergeQueue } from "../workspaces/merge-queue.js";
import { git } from "../workspaces/git.js";
import { blame, commitsMatching, commitsOfTasks, revertCommits, undoLines, type Actor, type UndoHook } from "../attribution/index.js";
import { calibrationUndoHook, recordJobCheck } from "../verification/calibration.js";
import { formatBrief, parseDoc, replaceSection, section } from "../brain/protocol.js";
import type { ToolSideEffect } from "../sessions/events.js";
import { minimalEnv } from "../runners/coding/process.js";
import { commandAllowed, type HarnessEnv, type HarnessTool } from "./tools.js";
import { integrationHooks, integrationTools, type IntegrationSeam } from "./integration-tools.js";
import { rulebookTier } from "../routing/staffing.js";
import { liveSlotCounts, readConcurrencyRecords } from "../gateway/capacity.js";
import type { WorkerTaskInput } from "../core/task.js";
import { narrowedScope, taskWriteScope } from "./task-scope.js";
import { assertPlannedBriefs } from "./supervisor-lifecycle.js";

export { queueOf } from "./integration-tools.js";

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
  /** Files this job's briefs named as shared (interface contracts, docs): the supervisor may edit them. */
  sharedFiles?: Set<string>;
}

function assertSplitSupervisorState(s:SupervisorState):void {
    if(typeof s.ctx.tasks?.db?.prepare!=="function"||!projectToolIdentity(s.ctx.tasks.db,s.ctx.cfg.brain.project))return;
    if(s.db!==s.ctx.tasks.db||s.ctx.gate.admission.db!==s.db)throw new Error("Supervisor tools require one pinned local store graph");
    const lease=LeaseRefSchema.parse(s.ctx.taskLease);
    if(lease.taskId!==s.ctx.taskId||!currentSupervisorAuthority(s.db,s.ctx.cfg,lease,s.ctx.now()))throw new Error("Supervisor tool lost original authority");
    assertProjectServiceBinding(s.ctx.services,s.db,lease);
}

/** Marker before a sub-job's own status in its section (the brief above it is the parent's). */
const SUB_JOB_STATUS = "**Sub-job status:**";

const ObjectArray = z.array(z.record(z.string(), z.unknown()));

function parseObjectArray(value: unknown, name: string): Array<Record<string, unknown>> {
  let input = value;
  if (typeof value === "string") {
    try {
      input = JSON.parse(value) as unknown;
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(`${name} must be a JSON array of objects`);
      throw error;
    }
  }
  const parsed = ObjectArray.safeParse(input);
  if (!parsed.success) throw new Error(`${name} must be an array of objects`);
  return parsed.data;
}

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

/** Persisted running is an active execution claim only for its exact live task generation. */
function currentActionGeneration(s: SupervisorState, row: WorkerActionRequest): boolean {
  const lease = row.action.lease, now = s.ctx.now();
  if (row.taskId !== lease.taskId || row.project !== lease.project) return false;
  return !!s.db.prepare(`SELECT 1 FROM tasks WHERE id=? AND project_id=? AND state='running' AND cancel_requested=0
    AND lease_owner=? AND run_count=? AND lease_incarnation=? AND lease_expires_at>?
    AND (deadline_at IS NULL OR deadline_at>?)`).get(row.taskId, row.project, lease.owner, lease.runCount, lease.incarnation, now, now);
}

/** Internal model cancellation cannot revoke the operator's active exact-generation work. */
function cancelUnprotectedChildren(s: SupervisorState, ids: string[]): unknown {
  return immediate(s.db, () => {
    const actor = LeaseRefSchema.parse(s.ctx.taskLease);
    if (actor.taskId !== s.ctx.taskId || !currentSupervisorAuthority(s.db, s.ctx.cfg, actor, s.ctx.now())) throw new Error("active owning supervisor authority required for cancellation");
    for (const id of ids) {
      const task = s.ctx.tasks.get(id);
      if (!task || task.row.project_id !== actor.project || task.spec.parentTaskId !== actor.taskId) throw new Error("only this supervisor's current project children may be cancelled");
    }
    const humanOnly = workerActionCapability(s.ctx.cfg).approvalPolicy === "human_only";
    const now = s.ctx.now();
    for (const id of ids) {
      const rows = s.db.prepare(`WITH RECURSIVE owned(id) AS (
        SELECT id FROM tasks WHERE id=? AND project_id=?
        UNION SELECT t.id FROM tasks t JOIN owned p ON json_extract(t.spec_json,'$.parentTaskId')=p.id WHERE t.project_id=?
      ) SELECT w.id,w.task_id,w.value_json FROM worker_action_requests w JOIN tasks t ON t.id=w.task_id AND t.project_id=w.project_id
      WHERE w.project_id=? AND w.task_id IN (SELECT id FROM owned) AND t.state='running' AND t.cancel_requested=0
        AND t.lease_expires_at>? AND (t.deadline_at IS NULL OR t.deadline_at>?)
        AND json_extract(w.value_json,'$.status') IN ('pending','running')
        AND json_extract(w.value_json,'$.action.lease.taskId')=t.id
        AND json_extract(w.value_json,'$.action.lease.project')=t.project_id
        AND json_extract(w.value_json,'$.action.lease.owner')=t.lease_owner
        AND json_extract(w.value_json,'$.action.lease.runCount')=t.run_count
        AND json_extract(w.value_json,'$.action.lease.incarnation')=t.lease_incarnation`).all(id, actor.project, actor.project, actor.project, now, now);
      const actions = z.array(z.object({ id: z.string(), task_id: z.string(), value_json: z.string() }).strict()).parse(rows);
      for (const record of actions) {
        const action = z.object({ status: z.enum(["pending", "running"]), decidedBy: z.string().nullable(), action: z.object({ lease: LeaseRefSchema }).passthrough() }).passthrough().parse(JSON.parse(record.value_json));
        if ((action.status === "pending" && humanOnly) || (action.status === "running" && action.decidedBy === "operator"))
          throw new Error(`cannot cancel ${record.task_id}: exact worker action ${record.id} is ${action.status === "pending" ? "awaiting human approval" : "operator-approved and running"}; continue await_tasks. External operator cancellation and runtime deadlines remain authoritative.`);
      }
    }
    // This service facade is synchronous. There is no await between action/lease preflight
    // and logical cancellation, so approval and mixed-batch cancellation serialize atomically.
    return s.ctx.services!.cancelTasks(ids);
  });
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
    repair_from_task: { type: "string", description: "Owned terminal coding task whose retained commits should hydrate this repair workspace; all inherited paths must fit allowed_paths. Does not accept its result." },
    file_refs: { type: "array", items: { type: "string" }, description: "<alias>:<path>[#Lx-Ly]" },
    repositories: { type: "array", items: { type: "string" } },
    writable_repository: { type: "string" },
    allowed_paths: { type: "array", items: { type: "string" } },
    must_not_touch: { type: "array", items: { type: "string" } },
    checks: { type: "array", items: { type: "string" } },
    lab_checks: { type: "array", items: { type: "string" }, description: "Declared human-authorized task Lab check names" },
    difficulty: { type: "string", enum: ["T1", "T2", "T3", "T4"] },
    web: { type: "boolean", description: "true: the task needs current web information (models that search the web inside the call are preferred); false: it must not touch the web" },
    importance: { type: "string", enum: [...IMPORTANCE_LEVELS], description: "how much the result matters (default normal); raises verification, never difficulty" },
    importance_reason: { type: "string", description: "why; required for high and critical" },
    depends_on: { type: "array", items: { type: "string" }, description: "labels of tasks this one needs first (in this call, or dispatched earlier); it starts once they finish and sees their results" },
    max_requests: { type: "integer", minimum: 1, description: "the task's model request budget, held from your job's budget while it runs (default: team.default_task_requests, else its tier's cap); it must fit in what your job has left. Workers can ask you for more." },
    shared_files: { type: "array", items: { type: "string" }, description: "repository-relative files you maintain yourself for the workers (interface contracts, shared docs such as INTERFACES.md); you may edit these, workers read them" },
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

/** Preserve a draft's explicit recovery binding and require explicit choices for prose references. */
async function assertRepairBriefSources(s:SupervisorState,items:Array<Record<string,unknown>>):Promise<void> {
  const previous=new PlanStore(s.db,s.ctx.now).latest(s.ctx.taskId);
  for(const item of items){
    const node=previous?.nodes.find(node=>node.label===slug(item.label));
    if(node?.repairFromTask && item.repair_from_task===undefined)
      throw new Error(`repair_reference_required: ${node.label} already has planned repair_from_task ${node.repairFromTask}. Keep that explicit field or choose a fresh label; a partial plan update cannot silently remove its retained source.`);
  }
  await assertExplicitRepairReferences(s.ctx,s.children,items,[...s.repos.keys()][0],s.repos);
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
async function dispatchBriefs(s: SupervisorState, items: Array<Record<string, unknown>>, env: HarnessEnv, opts: { artifactRefs?: Record<string, string[]>; sourceSnapshot?: Record<string,string> } = {}): Promise<string> {
  const svc = s.ctx.services!;
  const jobId = s.ctx.taskId;
  const labels = items.map((it) => slug(str(it.label, "label")));
  const dup = labels.find((l, i) => labels.indexOf(l) !== i);
  if (dup) throw new Error(`label ${dup} is used more than once`);
  const fresh = items.map((it, i) => ({ it, label: labels[i]! })).filter((x) => !s.children.has(x.label));
  await assertRepairBriefSources(s,fresh.map(item=>item.it));
  assertPlannedBriefs(s.ctx, fresh.map(item => item.it), [...s.repos.keys()][0]);
  const sourceSnapshot = opts.sourceSnapshot ?? (fresh.length ? await delegatedSourceSnapshot(s.ctx, s.repos, fresh.flatMap(({it}) => (it.repositories as string[] | undefined) ?? s.ctx.spec.repositoryAliases)) : {});
  const ids = new Map(fresh.map((x) => [x.label, newId("t")]));
  for (const { it, label } of fresh) if (it.profile === "implement" && !((it.allowed_paths as string[] | undefined) ?? []).length) throw new Error(`${label}: implement briefs need allowed_paths`);
  const depIds = (it: Record<string, unknown>) =>
    ((it.depends_on as string[] | undefined) ?? []).map((l) => s.children.get(slug(l)) ?? ids.get(slug(l)) ?? (s.children.has(l) ? s.children.get(l)! : l));

  // Worker budgets (budget control D1): each new worker task is granted a request budget, held
  // from this job's pool while it is open; together they must fit in what the job has left.
  const team = s.ctx.cfg.team;
  const { grants, total: granting } = grantBriefs(s.db, s.ctx.cfg, jobId, fresh.filter((x) => x.it.profile !== "supervise"));

  // Sub-supervisors: the depth limit, then a budget carved from what this job has left.
  const subs = fresh.filter((x) => x.it.profile === "supervise");
  const carves = new Map<string, { requests: number; remaining: number }>();
  if (subs.length) {
    const depth = depthOf(s);
    if (!maySupervise(s)) throw new Error(`${subs[0]!.label}: sub-supervisors are limited to team.max_depth ${team.max_depth}; this job is at depth ${depth}, so delegate workers instead`);
    const used = s.ctx.gate.admission.taskTotals(jobId).requests;
    let carved = heldRequests(s.db, jobId) + granting;
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
    if (repos.some(alias => !s.ctx.spec.repositoryAliases.includes(alias))) throw new Error(`${label}: repositories exceeds parent repository scope`);
    const writable = it.profile === "implement" ? String(it.writable_repository ?? [...s.repos.keys()][0] ?? "") : undefined;
    const paths = sub || writable ? narrowedScope(taskWriteScope(s.ctx.spec, s.ctx.tasks), it.allowed_paths) : undefined;
    const baseCommits = Object.fromEntries(repos.map(alias => [alias, sourceSnapshot[alias]!]));
    const checks = (it.checks as string[] | undefined) ?? [];
    for (const c of checks) s.briefChecks.add(c);
    const deps = depIds(it);
    const carve = carves.get(label);
    const grant = grants.get(label);
    const shared = sharedFilesArg(it);
    const artifactRefs = (opts.artifactRefs?.[label] ?? []).filter((r) => ARTIFACT_REF_RE.test(r));
    return {
      label,
      sub,
      carve,
      grant,
      shared,
      brief: formatBrief({
        label,
        repository: writable ?? repos.join(", "),
        task: `${String(it.profile)}: ${String(it.goal)}${grant ? ` (request budget ${grant.requests})` : ""}`,
        requiredReads: [...((it.file_refs as string[] | undefined) ?? []), ...shared.map((f) => `${f} (shared, kept by the supervisor)`)].join(", ") || "as needed",
        owns: sub ? `its own job branch ${s.ctx.cfg.supervisor.branch_prefix}${ids.get(label)!}, forked from this job's branch; paths: ${paths?.join(", ") ?? "parent repository scope"}` : (paths ?? []).join(", ") || "nothing (read-only)",
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
        ...(s.ctx.spec.deliveryVersion === 2 && it.profile === "supervise" ? {deliveryVersion:2 as const} : {}),
      ...(s.ctx.spec.lab ? { lab: s.ctx.spec.lab } : {}),
        idempotencyKey: `${jobId}:${label}`,
        repositoryAliases: repos,
        ...(writable ? { writableRepository: writable } : {}),
        context: { ...(it.file_refs ? { fileRefs: it.file_refs } : {}), ...(artifactRefs.length ? { artifactRefs } : {}), baseCommits },
        constraints: { acceptanceCriteria: it.acceptance_criteria, ...(paths ? { allowedPaths: paths } : {}), ...(checks.length ? { checks } : {}), ...(it.lab_checks ? { labChecks: it.lab_checks } : {}) },
        ...((it.difficulty && !sub) || typeof it.web === "boolean" ? { hints: { ...(it.difficulty && !sub ? { difficulty: it.difficulty } : {}), ...(typeof it.web === "boolean" ? { web: it.web } : {}) } } : {}),
        ...(it.importance ? { importance: it.importance } : {}),
        ...(it.importance_reason ? { importanceReason: it.importance_reason } : {}),
        ...(deps.length ? { dependsOn: deps } : {}),
        ...(carve ? { budget: { maxModelRequests: carve.requests } } : grant?.setBudget ? { budget: { maxModelRequests: grant.requests } } : {}),
        brain: { effort: s.ctx.effort, ...(it.brain_grants ? { grants: it.brain_grants } : {}) },
      } as Record<string, unknown>,
    };
  });
  // Staffing, explicit context validation and dispatch share one immutable parent snapshot.
  for (const sp of specs) {
    const item = fresh.find(x => x.label === sp.label)!.it;
    if (item.repair_from_task !== undefined) {
      if (item.profile !== "implement" || typeof item.repair_from_task !== "string") throw new Error("repair_from_task requires an implementation task and owned task reference");
      const sourceId = ownTask(s, item.repair_from_task);
      const alias = String(sp.spec.writableRepository);
      const context = sp.spec.context as { baseCommits: Record<string,string>; repairSource?: unknown };
      context.repairSource = await resolveRepairSource(s.ctx, sourceId, alias, sp.spec.constraints as {allowedPaths?:string[]}, jobId);
    }
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
  immediate(s.db,()=>{assertSplitSupervisorState(s);
  out.forEach((o, i) => {
    const sp = specs[i]!;
    s.children.set(sp.label, o.taskId);
    // Recorded after the submission (the carve names the task); a crash in between is repaired
    // when the job resumes (see ensureCarves).
    if (sp.carve) recordCarve(s.db, { childTaskId: o.taskId, parentTaskId: jobId, requests: sp.carve.requests, parentRemaining: sp.carve.remaining, share: team.child_budget_share, depth: depthOf(s) + 1 }, Date.now());
    if (sp.grant) recordGrant(s.db, { taskId: o.taskId, jobId, requests: sp.grant.requests, source: sp.grant.source }, Date.now());
    if (sp.shared.length) {
      for (const f of sp.shared) (s.sharedFiles ??= new Set()).add(f);
      s.ctx.tasks.event(jobId, SHARED_FILES_EVENT, { label: sp.label, taskId: o.taskId, files: sp.shared });
    }
  });
  });
  const submitted = new Map(out.map((o, i) => [specs[i]!.label, o]));
  const lines = labels.map((label) => {
    const o = submitted.get(label);
    const carve = carves.get(label);
    const grant = grants.get(label);
    if (o) return `${label} -> ${o.taskId} (${o.state}${o.deduplicated ? ", already submitted" : ""})${carve ? `; sub-supervisor with ${carve.requests} requests on branch ${s.ctx.cfg.supervisor.branch_prefix}${o.taskId}` : ""}${grant ? `; budget ${grant.requests} requests` : ""}`;
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
 * Cost-aware staffing: a new worker node without a difficulty is planned at the tier the
 * rulebook's deterministic score gives it (plan node only: the task itself is still classified,
 * so semantic tags can raise its tier and set importance floors). A node scoring above T3 is
 * reported so the supervisor splits it. Returns the planned tiers and one note per node scored.
 */
async function staffNodes(s: SupervisorState, items: Array<Record<string, unknown>>, sourceSnapshot: Record<string,string>): Promise<{ tiers: Map<string, PlanDifficulty>; notes: string[] }> {
  const notes: string[] = [];
  const tiers = new Map<string, PlanDifficulty>();
  if (!s.ctx.artifacts) return { tiers, notes };
  for (const it of items) {
    if (it.difficulty || it.profile === "supervise" || typeof it.label !== "string" || s.children.has(slug(it.label))) continue;
    const repos = (it.repositories as string[] | undefined) ?? [...new Set([...s.repos.keys(), ...s.ctx.spec.repositoryAliases])];
    const writable = it.profile === "implement" ? String(it.writable_repository ?? [...s.repos.keys()][0] ?? "") : "";
    const brief = {
      profile: it.profile,
      goal: String(it.goal ?? ""),
      repositoryAliases: repos,
      ...(writable ? { writableRepository: writable } : {}),
      context: { ...(it.file_refs ? { fileRefs: it.file_refs } : {}), baseCommits: Object.fromEntries(repos.map(alias => [alias, sourceSnapshot[alias]!])) },
      constraints: { acceptanceCriteria: it.acceptance_criteria, ...(it.allowed_paths ? { allowedPaths: it.allowed_paths } : {}), ...(it.checks ? { checks: it.checks } : {}), ...(it.lab_checks ? { labChecks: it.lab_checks } : {}) },
    } as WorkerTaskInput;
    const staffed = await rulebookTier(s.ctx.cfg, brief, s.ctx.artifacts);
    if (!staffed) continue;
    const label = slug(it.label);
    if (staffed.tier === "T4") {
      notes.push(`${label} scores ${staffed.score}, above T3: split it into smaller nodes`);
      continue;
    }
    tiers.set(label, staffed.tier as PlanDifficulty);
    notes.push(`${label} ${staffed.tier} (score ${staffed.score})`);
  }
  return { tiers, notes };
}

/** Provider slots in use right now, so the supervisor can size its plan to free capacity. */
function capacityLine(s: SupervisorState): string[] {
  // A context without a gate (a stubbed supervisor) has no slots to show.
  const capacity = s.ctx.gate?.health?.capacity;
  if (!capacity) return [];
  if (!capacity.enabled) return ["provider slots: not limited (team.provider_concurrency_enabled is off)"];
  if(projectToolIdentity(s.db,s.ctx.cfg.brain.project)){
    const platforms=[...new Set(s.ctx.plan.candidates.map(endpoint=>endpoint.providerId))].sort();
    return [`provider slots (in flight/limit): ${platforms.map(platform=>{const use=capacity.usage(platform);return `${platform} ${use.requests}/${use.limit}${use.waiting?`, ${use.waiting} waiting`:""}`;}).join("; ")||"none in current route"}`];
  }
  const counts = liveSlotCounts(s.db, s.ctx.now());
  const platforms = [...new Set([...readConcurrencyRecords(s.db).map((r) => r.platform), ...counts.map((c) => c.platform)])].sort();
  if (!platforms.length) return [`provider slots: none in use (each platform starts with ${s.ctx.cfg.team.provider_concurrency_start})`];
  const n = (p: string, kind: string) => counts.find((c) => c.platform === p && c.kind === kind)?.n ?? 0;
  return [`provider slots (in flight/limit): ${platforms.map((p) => `${p} ${n(p, "request")}/${capacity.limit(p)}${n(p, "wait") ? `, ${n(p, "wait")} waiting` : ""}`).join("; ")}`];
}

/**
 * Record carves a crash lost between a sub-job's submission and its carve (idempotent): the
 * sub-job's budget is in its spec, so the parent's admission counts it again.
 */
export function ensureCarves(s: SupervisorState): void {
  const tasks = new TaskStore(s.db);
  for (const id of s.children.values()) {
    const t = tasks.get(id);
    if (!t) continue;
    if (t.spec.profile === "supervise") {
      const requests = t.spec.budget?.maxModelRequests;
      if (requests) recordCarve(s.db, { childTaskId: id, parentTaskId: s.ctx.taskId, requests, parentRemaining: null, share: s.ctx.cfg.team.child_budget_share, depth: depthOf(s) + 1 }, Date.now());
    } else if (!grantOf(s.db, id)) {
      // A worker's grant (budget control D1): its explicit budget, else the default it was given.
      const explicit = t.spec.budget?.maxModelRequests;
      recordGrant(s.db, { taskId: id, jobId: s.ctx.taskId, requests: explicit ?? defaultTaskGrant(s.ctx.cfg, t.spec.profile, t.spec.hints?.difficulty ?? null), source: explicit ? "supervisor" : "default" }, Date.now());
    }
  }
}

/** What integration (integration-tools.ts) needs from this job's delegation and task ownership. */
function seamOf(s: SupervisorState): IntegrationSeam {
  return {
    ownTask: (ref) => ownTask(s, ref),
    repoFor: (alias) => repoFor(s, alias),
    identity: () => supervisorIdentity(s),
    redelegate: async (name, brief, env, artifactRefs) => {
      const label = slug(name);
      if (!s.children.has(label)) await dispatchBriefs(s, [brief(label)], env, { artifactRefs: { [label]: artifactRefs } });
      return s.children.get(label) ?? null;
    },
  };
}

/** What the job's merge queue calls back into (see `integrationHooks`). */
export function mergeHooks(s: SupervisorState, env: HarnessEnv): MergeHooks {
  return integrationHooks(s, env, seamOf(s));
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

/**
 * A sub-job of this job and every task under it (its workers, their re-delegations, and nested
 * sub-jobs): their commits reach this job's branch with the workers' Task trailers. Null when
 * the task is not a sub-job.
 */
function subJobTasks(s: SupervisorState, id: string): { id: string; tasks: Set<string> } | null {
  let tasks: TaskStore;
  try {
    tasks = new TaskStore(s.db);
    if (tasks.get(id)?.spec.profile !== "supervise") return null;
  } catch {
    return null; // no task store behind this state
  }
  const all = new Set<string>([id]);
  const queue = [id];
  while (queue.length) {
    for (const c of tasks.childrenOf(queue.shift()!)) {
      if (all.has(c.row.id)) continue;
      all.add(c.row.id);
      queue.push(c.row.id);
    }
  }
  return { id, tasks: all };
}

/** Undoing a sub-job also takes back the sub-job's own integrated result (a calibration signal for it). */
function withSubJob(hook: UndoHook, subJobId: string): UndoHook {
  return (change) => hook({ ...change, undone: [...change.undone, ...change.undone.filter((u) => u.task !== subJobId).map((u) => ({ ...u, task: subJobId }))] });
}

/** Tools only supervisors get: delegation, waiting, integration, attribution, undo, questions. */
export function supervisorTools(s: SupervisorState): HarnessTool[] {
  const assertLocal=()=>assertSplitSupervisorState(s);
  assertLocal();
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
        const items = parseObjectArray(a.tasks, "tasks");
        if (!items.length) throw new Error("tasks is empty");
        return dispatchBriefs(s, items, env);
      },
    ),

    tool(
      "plan_work",
      "delegate",
      "Record the job's decomposition as a task graph (a new plan version). Set dispatch:false to publish a draft without staffing, reserving budgets or starting workers. Default dispatch:true dispatches only fresh nodes supplied in this call. Delivery-v2 replanning preserves omitted future nodes unless replace_undispatched:true; execute a draft in phases by supplying each phase's full briefs with dispatch:true. Nodes with no unfinished dependencies run in parallel up to the job's agent cap. Include implementation, independent review and product testing work when applicable. Replanning retains already dispatched nodes; cancel and use a new label to change them. Returns the critical path.",
      {
        nodes: { type: "array", items: { type: "object", properties: { ...briefProperties(maySupervise(s)), requires_accepted_inputs: { type: "boolean", description: "start only on accepted upstream results (default: true for high/critical importance)" }, redundancy: { type: "integer", enum: [1, 2], description: "2 runs a small (T1/T2) non-coding node twice on different models and keeps the first verified result; both are charged" } }, required: ["label", "profile", "goal", "acceptance_criteria"] } },
        note: { type: "string", description: "what this version changes and why" },
        dispatch: { type: "boolean", description: "false records a validated visible draft only; default true dispatches supplied fresh nodes" },
        replace_undispatched: { type: "boolean", description: "true deliberately drops omitted undispatched nodes; delivery-v2 defaults to retaining them. Already dispatched history is always retained." },
      },
      ["nodes"],
      async (a, env) => {
        const items = parseObjectArray(a.nodes, "nodes").map((it) => ({ ...it }));
        if (!items.length) throw new Error("nodes is empty");
        if (items.length > MAX_PLAN_NODES) throw new Error(`a plan holds at most ${MAX_PLAN_NODES} nodes`);
        await assertRepairBriefSources(s,items.filter(it=>!s.children.has(slug(str(it.label,"label")))));
        const dispatch = z.boolean().parse(a.dispatch ?? true);
        const replaceUndispatched = z.boolean().parse(a.replace_undispatched ?? false);
        const preserveFuture = s.ctx.spec.deliveryVersion === 2 && !replaceUndispatched;
        // Drafts validate scope and task inputs without Gate/classification or budget effects.
        for (const it of items) {
          const profile = String(it.profile ?? "");
          const repositories = (it.repositories as string[] | undefined) ?? s.ctx.spec.repositoryAliases;
          if (repositories.some(alias => !s.ctx.spec.repositoryAliases.includes(alias))) throw new Error(`${String(it.label)}: repositories exceeds parent repository scope`);
          const writable = profile === "implement" ? String(it.writable_repository ?? [...s.repos.keys()][0] ?? "") : undefined;
          if (writable && (!s.repos.has(writable) || !repositories.includes(writable))) throw new Error(`${String(it.label)}: writable repository exceeds parent scope`);
          if (profile === "implement" && !((it.allowed_paths as string[] | undefined) ?? []).length) throw new Error(`${String(it.label)}: implement briefs need allowed_paths`);
          if (profile === "supervise" && !maySupervise(s)) throw new Error(`${slug(it.label)}: sub-supervisors are limited to team.max_depth ${s.ctx.cfg.team.max_depth}; this job is at depth ${depthOf(s)}, so delegate workers instead`);
          const paths = writable || profile === "supervise" ? narrowedScope(taskWriteScope(s.ctx.spec, s.ctx.tasks), it.allowed_paths) : undefined;
          sharedFilesArg(it);
          WorkerTaskSchema.parse({ profile, goal: it.goal, repositoryAliases: repositories, ...(writable ? { writableRepository: writable } : {}), context: { ...(it.file_refs ? { fileRefs: it.file_refs } : {}) }, constraints: { acceptanceCriteria: it.acceptance_criteria, ...(paths ? { allowedPaths: paths } : {}), ...(it.checks ? { checks: it.checks } : {}), ...(it.lab_checks ? { labChecks: it.lab_checks } : {}) }, ...(it.max_requests !== undefined ? { budget: { maxModelRequests: it.max_requests } } : {}), ...(it.importance ? { importance: it.importance } : {}), ...(it.importance_reason ? { importanceReason: it.importance_reason } : {}), ...(it.difficulty || it.web !== undefined ? { hints: { ...(it.difficulty ? { difficulty: it.difficulty } : {}), ...(it.web !== undefined ? { web: it.web } : {}) } } : {}), ...(it.brain_grants ? { brain: { grants: it.brain_grants } } : {}) });
        }
        const sourceSnapshot = dispatch && items.some(it => !s.children.has(slug(it.label))) ? await delegatedSourceSnapshot(s.ctx, s.repos, items.filter(it => !s.children.has(slug(it.label))).flatMap(it => (it.repositories as string[] | undefined) ?? s.ctx.spec.repositoryAliases)) : {};
        const { tiers: plannedTiers, notes: staffed } = dispatch ? await staffNodes(s, items, sourceSnapshot) : { tiers: new Map<string, PlanDifficulty>(), notes: [] as string[] };
        const store = new PlanStore(s.db, s.ctx.now);
        const previous = store.latest(jobId);
        const nodes: PlanNodeInput[] = items.map((it) => {
          const label = slug(str(it.label, "label"));
          const profile = String(it.profile ?? "");
          const importance = (it.importance as Importance | undefined) ?? null;
          const difficulty = (it.difficulty as PlanDifficulty | undefined) ?? plannedTiers.get(label) ?? null;
          return {
            label,
            profile: profile as PlanNodeInput["profile"],
            repairFromTask: it.repair_from_task === undefined ? null : z.string().min(1).parse(it.repair_from_task),
            goal: String(it.goal ?? ""),
            acceptanceCriteria: Array.isArray(it.acceptance_criteria) ? (it.acceptance_criteria as unknown[]).map(String) : [],
            dependsOn: ((it.depends_on as string[] | undefined) ?? []).map(slug),
            writableRepository: profile === "implement" ? String(it.writable_repository ?? [...s.repos.keys()][0] ?? "") || null : null,
            allowedPaths: (it.allowed_paths as string[] | undefined) ?? null,
            checks: (it.checks as string[] | undefined) ?? [],
            labChecks: (it.lab_checks as string[] | undefined) ?? [],
            difficulty,
            importance,
            requiresAcceptedInputs: typeof it.requires_accepted_inputs === "boolean" ? it.requires_accepted_inputs : defaultRequiresAcceptedInputs(importance),
            weight: nodeWeight(difficulty, s.ctx.cfg.profiles[profile as keyof typeof s.ctx.cfg.profiles]?.min_tier ?? null),
            ...(typeof it.redundancy === "number" ? { redundancy: it.redundancy } : {}),
          };
        });
        // Dispatched nodes keep their tasks: their recorded definition stays the one dispatched,
        // and omitted future nodes remain visible for delivery-v2 phased execution.
        // Retention changes the recorded graph only, never the dispatch/grant input list.
        const named = new Set(nodes.map((n) => n.label));
        const kept: string[] = [];
        const recorded = nodes.map((n) => {
          if (!s.children.has(n.label)) return n;
          kept.push(n.label);
          return previous?.nodes.find((p) => p.label === n.label) ?? n;
        });
        const carried = (previous?.nodes ?? []).filter((p) => !named.has(p.label) && (s.children.has(p.label) || preserveFuture));
        const all = [...recorded, ...carried];
        const external = new Set([...s.children.keys()].filter((l) => !all.some((n) => n.label === l)));
        const plan = store.record(jobId, all, { note: typeof a.note === "string" ? a.note : null, createdBy: s.actor.agent, external });
        let dispatched: string;
        try {
          const freshItems = items.filter((it) => !s.children.has(slug(it.label)));
          dispatched = dispatch && freshItems.length ? await dispatchBriefs(s, freshItems, env, { sourceSnapshot }) : "";
        } catch (err) {
          // Nothing was submitted: the version is withdrawn so the plan matches the tasks.
          if (!nodes.some((n) => !kept.includes(n.label) && s.children.has(n.label))) store.discard(jobId, plan.version);
          throw err;
        }
        const cp = criticalPath(plan.nodes);
        const fresh = nodes.length - kept.length;
        return [
          `plan v${plan.version} recorded: ${plan.nodes.length} node(s); ${dispatch ? fresh : 0} dispatched now${dispatch ? "" : " (draft; dispatch:false)"}, ${kept.length} already dispatched (kept)${carried.length ? `, ${carried.length} carried over (${carried.map((c) => c.label).join(", ")})` : ""}`,
          `critical path: ${cp.labels.join(" -> ")} (estimated cost ${cp.cost}); at most ${maxAgentsPerJob(s.ctx.cfg)} task(s) of this job run at once`,
          ...(staffed.length ? [`tiers from the rulebook (nodes without difficulty): ${staffed.join("; ")}`] : []),
          ...capacityLine(s),
          ...(dispatched ? [dispatched] : []),
        ].join("\n");
      },
    ),

    {
      ...tool("await_tasks", "none", "Wait without model requests for task completion or timeout. Wake for upstream acceptance, budget requests and worker actions you can approve under current supervisor policy. Human-only pending actions wait here for the operator without model polling; an explicit timeout reports that human wait clearly. Do not cancel workers merely because human approval is pending. Returns compact results.", { task_ids: { type: "array", items: { type: "string" } }, timeout_seconds: { type: "integer" } }, [], async (a, env) => {
      const ids = Array.isArray(a.task_ids) && a.task_ids.length ? (a.task_ids as string[]).map((x) => ownTask(s, x)) : [...s.children.values()];
      if (!ids.length) return "no tasks dispatched yet";
      const until = Date.now() + Math.min(Number(a.timeout_seconds) || 1800, 3600) * 1000;
      const actionStore = new WorkerActionRequests(s.db, s.ctx.now);
      const project = s.ctx.taskProject ?? s.ctx.cfg.brain.project;
      const humanWaiting = new Set<string>();
      const pendingActions = () => actionStore.list({ project, jobId, status: "pending" });
      const rememberHumanWaits = () => {
        if (workerActionCapability(s.ctx.cfg).approvalPolicy === "human_only") for (const action of pendingActions()) humanWaiting.add(action.id);
      };
      rememberHumanWaits();
      let operatorDecisions: string[] = [];
      let waited = false;
      // Wait in slices: a dependent waiting on this supervisor's acceptance, or a worker waiting on
      // its budget request, would otherwise hold the wait until the timeout.
      let r: Awaited<ReturnType<typeof svc.awaitResults>>;
      for (;;) {
        r = await svc.awaitResults(ids, { timeoutSeconds: Math.max(1, Math.min(3, Math.ceil((until - Date.now()) / 1000))), signal: s.ctx.signal, uncapped: true });
        // This metric comes from the service's measured wait, never model output or
        // requested timeout. Immediate returns cannot erase no-progress history.
        waited ||= (r.waitedSeconds ?? 0) > 0;
        const capability = workerActionCapability(s.ctx.cfg);
        if (capability.approvalPolicy === "human_only") for (const action of pendingActions()) humanWaiting.add(action.id);
        operatorDecisions = [...humanWaiting].flatMap(id => {
          const action = actionStore.get(project, id);
          return action && !["pending", "running"].includes(action.status) ? [`worker action ${id}: ${action.status}${action.decisionReason ? `; ${action.decisionReason}` : ""}`] : [];
        });
        if (!r.pending.length || Date.now() >= until || s.ctx.signal.aborted || blockedOnAcceptance(s, r.pending) || supervisorAsked(s.db, jobId) || operatorDecisions.length || (capability.canApprove && pendingActions().length > 0)) break;
      }
      if (waited && !s.ctx.signal.aborted && env.observationWait) env.observationWait.epoch++;
      const budget = pendingBudgetLines(s.db, s.ctx.cfg, jobId);
      const actions = [...pendingActions(), ...actionStore.list({ project, jobId, status: "running" })];
      const capability = workerActionCapability(s.ctx.cfg);
      const guidance = capability.canApprove ? "decide_worker_action" : capability.approvalPolicy === "human_only" ? "awaiting human operator approval; supervisor cannot approve; continue await_tasks without model polling" : "outside-repository execution disabled; operator policy change or cancellation required";
      return cap([...operatorDecisions, ...actions.map(row => `worker action ${row.id} from ${row.taskId}: ${row.action.operation?.name ?? row.action.command}; ${row.status === "running" ? currentActionGeneration(s, row) ? `running; approved by ${row.decidedBy ?? "recorded decision"}; execution in progress; continue await_tasks` : "persisted running from inactive generation; unresolved, requires operator reconciliation" : guidance}`), ...budget, ...r.completed.map((c) => summarizeResult(c.taskId, s)), ...r.pending.map((p) => {
        const why = stateReason(s, p.taskId);
        return `${p.taskId}: still ${p.state}${why && why !== "resumed" ? ` (${why}${why.startsWith(AWAITING_ACCEPTANCE) ? "; accept_task or reject_task the upstream result" : ""})` : ""}`;
      })].join("\n"));
      }),
      repeatBehavior: "execute",
    },

    tool("task_result", "read", "Full result of one task (findings, evidence, checks, patch references).", { task_id: { type: "string" } }, ["task_id"], async (a) => {
      const id = ownTask(s, a.task_id);
      const t = svc.getTask(id);
      if (!t) throw new Error("unknown task");
      return cap(JSON.stringify({ state: t.state, spec: { label: t.spec.label, profile: t.spec.profile, goal: t.spec.goal }, result: t.result }, null, 1));
    }),

    tool("cancel_tasks", "delegate", "Cancel this job's unprotected tasks. Pending human-only approvals and operator-approved running actions must settle through await_tasks; only the external operator or runtime cancellation may interrupt those exact active generations.", { task_ids: { type: "array", items: { type: "string" } } }, ["task_ids"], async (a) => {
      const ids = z.array(z.string().min(1)).min(1).max(MAX_PLAN_NODES).parse(a.task_ids).map(id => ownTask(s, id));
      cancelUnprotectedChildren(s, [...new Set(ids)]);
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

    ...integrationTools(s, seamOf(s)),

    ...supervisorBudgetTools(jobId),
    ...supervisorActionTools(jobId),

    tool("run_check", "command", "Run a check command in the job's integration worktree (commands from your briefs' checks or the supervisor allowlist).", { command: { type: "string" }, repository: { type: "string" } }, ["command"], async (a, env) => {
      const repo = repoFor(s, a.repository);
      const command = str(a.command, "command");
      const allowed = s.briefChecks.has(command) || commandAllowed(command, [...s.ctx.cfg.supervisor.allowed_commands, ...s.ctx.cfg.coding.allowed_commands]);
      if (!allowed) throw new Error("command not allowed: use a check from one of your briefs or add it to supervisor.allowed_commands");
      const r = await executeSupervisorCommand(s.ctx, { command, cwd: repo.worktree, invocationId: env.toolInvocationId, env: minimalEnv({ CI: "1" }), timeoutMs: s.ctx.cfg.execution.check_timeout_seconds * 1000, reason: "Supervisor declared integration check" });
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
      "Undo changes on the job branch at your discretion: a whole task (for a sub-job, everything its tasks committed), everything a model did, one commit, or specific lines of a file. Every undo is a new commit with your reason; changes made before this job are never touched.",
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
        let subJob: { id: string; tasks: Set<string> } | null = null;
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
          // A sub-job's commits carry its workers' Task trailers: undo every task under it.
          subJob = a.kind === "task" ? subJobTasks(s, value) : null;
          commits = (subJob ? await commitsOfTasks(repo.worktree, `${repo.baseSha}..HEAD`, subJob.tasks) : await commitsMatching(repo.worktree, `${repo.baseSha}..HEAD`, { [key]: value })).map((c) => c.commit);
        }
        if (!commits.length) return "no matching commits on the job branch";
        const onUndone = calibrationUndoHook(s.db, s.ctx.tasks ?? null, { jobId, now: Date.now });
        const c = await revertCommits(repo.worktree, commits, s.actor, reason, { onUndone: subJob ? withSubJob(onUndone, subJob.id) : onUndone });
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
  ].map(entry=>({...entry,run:async(args,env)=>{assertLocal();return entry.run(args,env);}}));
}

export type { HarnessEnv };
