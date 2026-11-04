import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { BudgetRequests, jobPool } from "../admission/budget-requests.js";
import { effectiveBudget, UNLIMITED_REQUESTS } from "../admission/admission.js";
import { extraRequests } from "../admission/job-pool.js";
import type { ResolvedConfig } from "../config/load.js";
import { TaskValidationError } from "../core/errors.js";
import { TERMINAL_STATES, WorkerResultSchema } from "../core/task.js";
import { projectToolIdentity } from "../core/supervisor-authority.js";
import { SessionWorkspaceSchema } from "../sessions/events.js";
import { replayTranscript } from "../sessions/resume.js";
import type { SessionStore } from "../sessions/store.js";
import { git } from "../workspaces/git.js";
import { exactRepositoryRoot } from "../workspaces/repository-root.js";
import { withRepositoryMutation } from "../workspaces/repository-mutation.js";
import { projectRuntimeActivationRoots } from "../workspaces/worktree.js";
import { immediate } from "./db.js";
import { canonicalJson, type StoredTask, type TaskStore } from "./tasks.js";

export const SUPERVISOR_BUDGET_CONTINUED = "supervisor_budget_continued";
const STOP = "budget_exhausted", NOTE = "supervisor_budget_continuation";
const TaskStop = z.enum([STOP, "supervisor request budget exhausted"]);
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const hash = z.string().regex(/^[a-f0-9]{64}$/), oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const SupervisorBudgetContinuationSchema = z.object({
  operationId: z.string().min(1).max(200), project: z.string().min(1).max(128),
  taskId: z.string().min(1).max(200), sessionId: z.string().min(1).max(200), approvedBudgetRequestId: z.number().int().positive(),
  expectedDeadlineAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  expectedRunCount: z.number().int().positive(), expectedIncarnation: z.string().min(1).max(200), reason: z.string().trim().min(1).max(2000),
}).strict();
export type SupervisorBudgetContinuationInput = z.input<typeof SupervisorBudgetContinuationSchema>;
const Claim = z.object({ id: z.number().int().positive(), ts: z.number().int().nonnegative(), owner: z.string().min(1), run: z.number().int().positive() }).strict();
const RepoProof = z.object({ alias: z.string(), worktree: z.string(), configuredRoot: z.string(), commonDirectory: z.string(), base: oid, head: oid, tree: oid, branch: z.string().nullable() }).strict();
const Proof = z.object({ taskSpecDigest: hash, sessionDigest: hash, claim: Claim, grantDigest: hash, workspace: z.array(RepoProof).min(1).max(32) }).strict();
const Pool = z.object({ jobId: z.string(), cap: z.number().int().nonnegative(), used: z.number().int().nonnegative(), held: z.number().int().nonnegative(), reserve: z.number().int().nonnegative(), available: z.number().int().positive() }).strict();
const Receipt = z.object({ version: z.literal(1), input: SupervisorBudgetContinuationSchema, continuedAt: z.number().int().nonnegative(),
  deadlineAt: z.number().int().positive(), previousStateReason: TaskStop, previousResult: WorkerResultSchema, pool: Pool, proof: Proof, proofDigest: hash }).strict()
  .refine(value => value.deadlineAt === value.input.expectedDeadlineAt && value.previousResult.stopReason === value.previousStateReason && value.previousResult.executionStatus === STOP && value.proof.claim.run === value.input.expectedRunCount, "receipt must preserve the exact exhausted run and deadline");
type ReceiptValue = z.infer<typeof Receipt>;
const samePath = (a: string, b: string) => process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
function refuse(reason: string): never { throw new TaskValidationError(`supervisor_budget_continuation_refused: ${reason}`); }

function receiptFor(tasks: TaskStore, taskId: string, operationId: string): ReceiptValue | null {
  const row = tasks.db.prepare("SELECT data_json FROM events WHERE task_id=? AND type=? AND json_extract(data_json,'$.input.operationId')=? ORDER BY id LIMIT 1")
    .get(taskId, SUPERVISOR_BUDGET_CONTINUED, operationId) as { data_json: string } | undefined;
  if (!row) return null;
  const receipt = Receipt.parse(JSON.parse(row.data_json));
  if (receipt.input.taskId !== taskId || digest(receipt.proof) !== receipt.proofDigest) refuse("continuation receipt changed");
  return receipt;
}

function latestClaim(tasks: TaskStore, id: string) {
  const raw = z.object({ id: z.number().int().positive(), ts: z.number().int().nonnegative(), data_json: z.string() }).parse(
    tasks.db.prepare("SELECT id,ts,data_json FROM events WHERE task_id=? AND type='claimed' ORDER BY id DESC LIMIT 1").get(id));
  return Claim.parse({ id: raw.id, ts: raw.ts, ...z.object({ owner: z.string().min(1), run: z.number().int().positive() }).strict().parse(JSON.parse(raw.data_json)) });
}

/** Bounded settled memory only: neither reopening terminal logs nor replaying unknown effects. */
function budgetMemory(tasks: TaskStore, sessions: SessionStore, task: StoredTask, sessionId: string, claim: z.infer<typeof Claim>, linkedSessionId?: string) {
  const all = sessions.forTask(task.row.id), ids = new Set(all.map(session => session.id));
  const authors = all.filter(session => session.id !== linkedSessionId && session.role !== "classifier" && !(session.parentSessionId && ids.has(session.parentSessionId)));
  const session = sessions.get(sessionId);
  if (!session || authors.at(-1)?.id !== sessionId || session.taskId !== task.row.id || session.jobId !== task.row.id || session.parentSessionId !== null ||
      session.role !== "supervisor" || session.profile !== task.spec.profile || session.status !== "failed" || session.stopReason !== STOP) refuse("latest exact budget-exhausted supervisor memory is required");
  const scope = z.object({ project_id: z.string() }).parse(tasks.db.prepare("SELECT project_id FROM sessions WHERE id=?").get(sessionId));
  if (scope.project_id !== task.row.project_id || statSync(session.logPath).size > 32 * 1024 * 1024) refuse("retained session scope or log bound changed");
  const page = sessions.events(sessionId, { limit: 10000 }), ended = page?.events.at(-1);
  if (!page || page.corrupt.length || page.hasMore || ended?.type !== "ended" || ended.data.status !== "failed" || ended.data.stopReason !== STOP || ended.at < claim.ts) refuse("retained budget-failure log is incomplete or changed");
  // model_request does not persist its participant budget. This proves the local admission
  // failure and its run, not a historical wire-level stale cap that was never recorded.
  const tail = page.events.filter(event => ["model_request", "model_response", "model_error", "tool_intent", "tool_outcome"].includes(event.type));
  const failure = tail.at(-1), request = tail.at(-2);
  if (failure?.type !== "model_error" || failure.data.code !== "admission_denied:task_request_budget_exhausted" || failure.data.attempts.length || failure.at < claim.ts ||
      request?.type !== "model_request" || request.at < claim.ts || failure.data.executionId !== request.data.executionId) refuse("exact final pre-provider request-budget admission failure is required");
  if (!tasks.db.prepare("SELECT 1 FROM execution_members m JOIN executions e ON e.id=m.execution_id WHERE m.task_id=? AND e.id=? AND e.kind='task' AND e.profile=? AND e.created_at>=? LIMIT 1")
    .get(task.row.id, request.data.executionId, task.spec.profile, claim.ts)) refuse("failed model request does not belong to the exact supervisor claim");
  const plan = sessions.planResume(sessionId), pending = sessions.pendingIntents(sessionId);
  if (!plan?.messages.length || plan.actions.length || plan.warnings.length || plan.droppedRequestSeqs.length || !pending || pending.length ||
      canonicalJson(plan.messages) !== canonicalJson(replayTranscript(page.events).messages)) refuse("retained memory has unresolved effects, requests or transcript reconstruction");
  const lastAssistant = [...plan.messages].reverse().find(message => message.role === "assistant");
  if (lastAssistant?.role === "assistant" && lastAssistant.tool_calls?.some(call => call.function.name === "finish_job")) refuse("a retained terminal submission needs its existing delivery control path");
  const workspace = SessionWorkspaceSchema.parse(session.workspace);
  if (canonicalJson(workspace) !== canonicalJson(plan.workspace)) refuse("retained workspace differs from its typed log");
  return { session, plan, workspace, sessionDigest: digest({ session, events: page.events }), endedAt: ended.at };
}

/** All same-root work must be terminal and quiescent before another claim can be authorized. */
function quiescent(tasks: TaskStore, task: StoredTask, claimed = false, linkedSessionId?: string): void {
  const rows = tasks.db.prepare(`WITH RECURSIVE tree(id) AS (SELECT id FROM tasks WHERE id=? UNION
    SELECT t.id FROM tasks t JOIN tree p ON json_extract(t.spec_json,'$.parentTaskId')=p.id)
    SELECT id FROM tree LIMIT 5001`).all(task.row.id);
  if (rows.length > 5000) refuse("task subtree exceeds bounded proof");
  // A preparation may survive before a participant-hold/model-request projection exists.
  // owner_json identifies the project store; captured task participants live in binding_json.
  // Inspect those independently, preserving protocols belonging only to other roots/projects.
  const protocols = tasks.db.prepare(`WITH RECURSIVE tree(id) AS (SELECT id FROM tasks WHERE id=? UNION
    SELECT t.id FROM tasks t JOIN tree parent ON json_extract(t.spec_json,'$.parentTaskId')=parent.id)
    SELECT p.request_id,p.project_id,p.owner_json,p.binding_json FROM project_request_protocol p
    WHERE p.phase NOT IN ('settled','retired') AND EXISTS (
      SELECT 1 FROM json_each(p.binding_json,'$.participants') participant JOIN tree ON json_extract(participant.value,'$.taskId')=tree.id)
    LIMIT 5001`).all(task.row.id);
  if (protocols.length > 5000) refuse("unresolved split protocol history exceeds bounded proof");
  if (protocols.length) {
    z.array(z.object({ request_id: z.string().min(1), project_id: z.string(), owner_json: z.string().max(8192), binding_json: z.string().max(262144) }).strict()).parse(protocols);
    refuse("split model-request authority is unresolved before participant projection");
  }
  for (const raw of rows) {
    const id = z.object({ id: z.string().min(1) }).parse(raw).id, current = tasks.get(id);
    if (!current || current.row.project_id !== task.row.project_id || (current.row.cancel_requested && (id === task.row.id || !TERMINAL_STATES.has(current.row.state)))) refuse("subtree task project or cancellation changed");
    const isClaim = claimed && id === task.row.id;
    if ((!isClaim && (current.row.lease_owner !== null || current.row.lease_expires_at !== null)) || (id !== task.row.id && !TERMINAL_STATES.has(current.row.state))) refuse("task subtree is still owned or nonterminal");
    if (tasks.db.prepare("SELECT 1 FROM sessions WHERE task_id=? AND status='running' AND (? IS NULL OR id<>?) LIMIT 1").get(id, linkedSessionId ?? null, linkedSessionId ?? null)) refuse("author or reviewer session is active");
    if (tasks.db.prepare("SELECT 1 FROM model_requests r JOIN request_charges c ON c.request_id=r.id WHERE c.task_id=? AND r.status='reserved' LIMIT 1").get(id)) refuse("model request is active");
    if (tasks.db.prepare("SELECT 1 FROM project_request_holds h LEFT JOIN project_request_protocol p ON p.request_id=h.request_id WHERE h.task_id=? AND (h.active=1 OR p.phase IS NULL OR p.phase NOT IN ('settled','retired')) LIMIT 1").get(id)) refuse("split model-request authority is unresolved");
    if (tasks.db.prepare("SELECT 1 FROM merge_queue WHERE (job_id=? OR task_id=?) AND state IN ('queued','integrating','picked') LIMIT 1").get(id, id)) refuse("integration is active");
    if (tasks.db.prepare(`SELECT 1 FROM project_execution_claim_members m JOIN project_execution_claims c ON c.grant_id=m.grant_id
      WHERE m.task_id=? AND c.phase<>'terminal' AND NOT (?=1 AND m.run_count=? AND m.lease_incarnation=? AND m.lease_owner=? AND m.project_id=?) LIMIT 1`)
      .get(id, isClaim ? 1 : 0, current.row.run_count, current.row.lease_incarnation, current.row.lease_owner ?? "", current.row.project_id)) refuse("older execution claim is unresolved");
    const actions = tasks.db.prepare("SELECT id,project_id,task_id,value_json FROM worker_action_requests WHERE task_id=? LIMIT 5001").all(id);
    if (actions.length > 5000) refuse("command history exceeds bounded proof");
    for (const rawAction of actions) {
      const row = z.object({ id: z.string(), project_id: z.string(), task_id: z.string(), value_json: z.string().max(100000) }).strict().parse(rawAction);
      const action = z.object({ id: z.string(), project: z.string(), taskId: z.string(), status: z.enum(["pending", "running", "completed", "denied", "cancelled", "uncertain"]), quiescedAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional() }).passthrough().parse(JSON.parse(row.value_json));
      if (row.project_id !== task.row.project_id || action.project !== row.project_id || action.taskId !== id || action.id !== row.id) refuse("command action scope changed");
      if (["completed", "denied", "cancelled"].includes(action.status)) continue;
      // Same existing blocked-job predicate: retain host-quiesced terminal descendant
      // uncertainty as UNKNOWN history. It is neither declared successful nor replayed.
      if (action.status === "uncertain" && action.quiescedAt !== undefined && id !== task.row.id && TERMINAL_STATES.has(current.row.state) &&
          current.row.lease_owner === null && current.row.lease_expires_at === null &&
          !tasks.db.prepare("SELECT 1 FROM sessions WHERE task_id=? AND status='running' LIMIT 1").get(id)) continue;
      refuse("command action outcome is unresolved");
    }
  }
  // Lab services can own repository commands without a worker-action row. No Lab command
  // in this project is compatible with this deliberately quiescent recovery control.
  if (tasks.db.prepare("SELECT 1 FROM lab_command_owners WHERE project_id=? LIMIT 1").get(task.row.project_id)) refuse("project has retained Lab command ownership");
}

function financed(tasks: TaskStore, cfg: ResolvedConfig, task: StoredTask, memory: ReturnType<typeof budgetMemory>, claim: z.infer<typeof Claim>, requestId: number) {
  const grant = new BudgetRequests(tasks.db).get(requestId);
  if (!grant || grant.taskId !== task.row.id || grant.project !== task.row.project_id || grant.jobId !== null || grant.role !== "supervisor" ||
      !["external", "human"].includes(grant.approver) || grant.status !== "approved" || grant.granted < 1 || !grant.decidedBy || grant.decidedAt === null ||
      grant.decidedAt <= claim.ts || grant.decidedAt > memory.endedAt) refuse("exact external approval decided during this failed claim is required");
  const pool = jobPool(tasks.db, cfg, task.row.id), base = effectiveBudget(cfg, task.spec, memory.session.tier).maxModelRequests;
  if (!pool || pool.cap === null || base === UNLIMITED_REQUESTS || pool.available === null || pool.available < 1 ||
      Math.min(pool.cap, base + extraRequests(tasks.db, task.row.id)) - pool.used - pool.held - pool.reserve < 1) refuse("current finite authorized pool is actually spent, held or protected");
  return { pool: Pool.parse(pool), grantDigest: digest(grant) };
}

async function workspaceProof(cfg: ResolvedConfig, task: StoredTask, workspace: z.infer<typeof SessionWorkspaceSchema>) {
  const assigned = task.spec.repositoryAliases.filter(alias => cfg.repositoryPaths[alias]?.writable);
  if (!assigned.length || workspace.repos.length > 32 || workspace.repos.length !== assigned.length || new Set(workspace.repos.map(repo => repo.alias)).size !== workspace.repos.length ||
      assigned.some(alias => !workspace.repos.some(repo => repo.alias === alias))) refuse("retained writable workspace is missing or ambiguous");
  const root = realpathSync(projectRuntimeActivationRoots(cfg).worktrees), result: z.infer<typeof RepoProof>[] = [];
  for (const repo of workspace.repos) {
    const configured = cfg.repositoryPaths[repo.alias];
    if (!assigned.includes(repo.alias) || !configured?.writable || !repo.baseCommit || !repo.head) refuse("workspace assignment changed");
    const physical = realpathSync(repo.worktree), relative = path.relative(root, physical);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !samePath(physical, repo.worktree)) refuse("workspace physical ownership changed");
    const configuredRoot = realpathSync(configured.path), actual = await exactRepositoryRoot(physical), expected = await exactRepositoryRoot(configuredRoot);
    const commonDirectory = realpathSync(actual.commonDirectory);
    if (!samePath(commonDirectory, realpathSync(expected.commonDirectory))) refuse("retained workspace has a foreign Git owner");
    const options = { timeoutMs: 30000, maxBuffer: 2 * 1024 * 1024 };
    if ((await git(physical, ["status", "--porcelain=v1", "--untracked-files=all"], options)).trim()) refuse("retained workspace is dirty");
    const head = (await git(physical, ["rev-parse", "HEAD"], options)).trim(), ref = (await git(physical, ["rev-parse", "--abbrev-ref", "HEAD"], options)).trim();
    if (head !== repo.head || (ref === "HEAD" ? null : ref) !== repo.branch) refuse("retained source HEAD or branch changed");
    result.push(RepoProof.parse({ alias: repo.alias, worktree: physical, configuredRoot, commonDirectory, base: repo.baseCommit, head,
      tree: (await git(physical, ["rev-parse", "HEAD^{tree}"], options)).trim(), branch: repo.branch }));
  }
  return result;
}

function eligible(tasks: TaskStore, sessions: SessionStore, cfg: ResolvedConfig, input: SupervisorBudgetContinuationInput) {
  projectToolIdentity(tasks.db, input.project);
  const task = tasks.get(input.taskId);
  if (!task || task.row.project_id !== input.project || task.spec.parentTaskId || cfg.profiles[task.spec.profile]?.mode !== "supervisor" ||
      task.row.state !== STOP || !TaskStop.safeParse(task.row.state_reason).success || task.result?.stopReason !== task.row.state_reason || task.result.executionStatus !== STOP || task.result.acceptanceStatus === "met") refuse("exact unaccepted terminal root supervisor budget failure is required");
  if (task.row.deadline_at !== input.expectedDeadlineAt || task.row.run_count !== input.expectedRunCount || task.row.lease_incarnation !== input.expectedIncarnation || input.expectedDeadlineAt <= tasks.serverNow()) refuse("original deadline or failed attempt changed or expired");
  quiescent(tasks, task);
  const claim = latestClaim(tasks, task.row.id);
  if (claim.run !== input.expectedRunCount) refuse("latest claim differs from the failed run");
  const memory = budgetMemory(tasks, sessions, task, input.sessionId, claim), funds = financed(tasks, cfg, task, memory, claim, input.approvedBudgetRequestId);
  return { task, claim, memory, ...funds };
}

/** Trusted FINAL control only. It consumes existing approval; never creates budget or time. */
export async function continueSupervisorBudget(tasks: TaskStore, sessions: SessionStore, cfg: ResolvedConfig, raw: SupervisorBudgetContinuationInput) {
  const input = SupervisorBudgetContinuationSchema.parse(raw), existing = receiptFor(tasks, input.taskId, input.operationId);
  if (existing) {
    if (canonicalJson(existing.input) !== canonicalJson(input) || tasks.get(input.taskId)?.row.project_id !== input.project) refuse("operation replay changed its input or project");
    return { ...existing, disposition: "replayed" as const };
  }
  const initial = eligible(tasks, sessions, cfg, input), preview = await workspaceProof(cfg, initial.task, initial.memory.workspace);
  return withRepositoryMutation(preview.map(repo => repo.worktree), async () => {
    // Another identical caller may have finished while this one waited for repository
    // ownership. Its settled receipt is replayable even though the task is now queued.
    const saved = receiptFor(tasks, input.taskId, input.operationId);
    if (saved) {
      if (canonicalJson(saved.input) !== canonicalJson(input) || tasks.get(input.taskId)?.row.project_id !== input.project) refuse("operation replay changed its input or project");
      return { ...saved, disposition: "replayed" as const };
    }
    const checked = eligible(tasks, sessions, cfg, input), repos = await workspaceProof(cfg, checked.task, checked.memory.workspace);
    if (canonicalJson(preview) !== canonicalJson(repos) || initial.memory.sessionDigest !== checked.memory.sessionDigest || initial.grantDigest !== checked.grantDigest) refuse("retained evidence changed during admission");
    return immediate(tasks.db, () => {
      const replay = receiptFor(tasks, input.taskId, input.operationId);
      if (replay) { if (canonicalJson(replay.input) !== canonicalJson(input) || tasks.get(input.taskId)?.row.project_id !== input.project) refuse("operation replay changed its input or project"); return { ...replay, disposition: "replayed" as const }; }
      const current = eligible(tasks, sessions, cfg, input);
      if (current.memory.sessionDigest !== checked.memory.sessionDigest || current.grantDigest !== checked.grantDigest || canonicalJson(current.claim) !== canonicalJson(checked.claim) || canonicalJson(current.task.spec) !== canonicalJson(checked.task.spec)) refuse("retained authority changed before continuation");
      const proof = Proof.parse({ taskSpecDigest: digest(current.task.spec), sessionDigest: current.memory.sessionDigest, claim: current.claim, grantDigest: current.grantDigest, workspace: repos });
      const now = tasks.serverNow(), receipt = Receipt.parse({ version: 1, input, continuedAt: now, deadlineAt: input.expectedDeadlineAt,
        previousStateReason: current.task.row.state_reason, previousResult: current.task.result, pool: current.pool, proof, proofDigest: digest(proof) });
      const changed = tasks.db.prepare("UPDATE tasks SET state='queued',state_reason='resumed',result_json=NULL,finished_at=NULL,updated_at=? WHERE id=? AND project_id=? AND state='budget_exhausted' AND state_reason=? AND deadline_at=? AND run_count=? AND lease_incarnation=? AND cancel_requested=0 AND lease_owner IS NULL AND lease_expires_at IS NULL")
        .run(now, input.taskId, input.project, current.task.row.state_reason, input.expectedDeadlineAt, input.expectedRunCount, input.expectedIncarnation);
      if (changed.changes !== 1) refuse("continuation authority changed");
      tasks.event(input.taskId, SUPERVISOR_BUDGET_CONTINUED, receipt);
      tasks.event(input.taskId, "resumed", { sessionId: input.sessionId, supervisorBudgetContinuation: true, supervisorBudgetOperationId: input.operationId });
      return { ...receipt, disposition: "fresh" as const };
    });
  }, { expectedCommonDirectories: preview.map(repo => repo.commonDirectory) });
}

/** Rechecked against current captured claim before any terminal history can be cloned. */
export function assertSupervisorBudgetContinuation(tasks: TaskStore, sessions: SessionStore, cfg: ResolvedConfig, task: StoredTask, sessionId: string, operationId: string, linkedSessionId?: string) {
  projectToolIdentity(tasks.db, task.row.project_id);
  const receipt = receiptFor(tasks, task.row.id, operationId), row = task.row;
  const current = tasks.dispatchable(row.id, row.lease_owner ?? "", row.run_count, row.lease_incarnation, row.project_id);
  if (!receipt || !current || current.spec.parentTaskId || cfg.profiles[current.spec.profile]?.mode !== "supervisor" || receipt.input.project !== row.project_id || receipt.input.sessionId !== sessionId ||
      receipt.input.expectedRunCount + 1 !== row.run_count || receipt.input.expectedIncarnation !== row.lease_incarnation || receipt.deadlineAt !== row.deadline_at || receipt.deadlineAt !== current.row.deadline_at || receipt.proof.taskSpecDigest !== digest(current.spec)) refuse("receipt does not authorize this exact live claimed continuation");
  const claim = latestClaim(tasks, row.id);
  if (claim.run !== row.run_count || claim.owner !== row.lease_owner || claim.ts < receipt.continuedAt) refuse("latest claim changed after continuation");
  const directive = tasks.db.prepare("SELECT data_json FROM events WHERE task_id=? AND type='resumed' AND id>? AND id<? ORDER BY id DESC LIMIT 1")
    .get(row.id, receipt.proof.claim.id, claim.id) as { data_json: string } | undefined;
  const expectedDirective = { sessionId, supervisorBudgetContinuation: true, supervisorBudgetOperationId: operationId };
  const parsedDirective = directive ? z.object({ sessionId: z.string().min(1), supervisorBudgetContinuation: z.literal(true), supervisorBudgetOperationId: z.string().min(1).max(200) }).strict().safeParse(JSON.parse(directive.data_json)) : null;
  if (!parsedDirective?.success || canonicalJson(parsedDirective.data) !== canonicalJson(expectedDirective)) refuse("exact live claimed continuation directive changed");
  const oldClaim = tasks.db.prepare("SELECT ts,data_json FROM events WHERE id=? AND task_id=? AND type='claimed'").get(receipt.proof.claim.id, row.id);
  const old = z.object({ ts: z.number().int(), data_json: z.string() }).parse(oldClaim);
  if (canonicalJson({ id: receipt.proof.claim.id, ts: old.ts, ...JSON.parse(old.data_json) }) !== canonicalJson(receipt.proof.claim)) refuse("original failed claim changed");
  if (linkedSessionId) {
    const linked = sessions.get(linkedSessionId), page = sessions.events(linkedSessionId, { limit: 10000 });
    if (!linked || linked.taskId !== row.id || linked.jobId !== row.id || linked.previousSessionId !== sessionId || linked.role !== "supervisor" || linked.profile !== current.spec.profile || linked.status !== "running" ||
        !page || page.corrupt.length || page.hasMore || page.events.some(event => ["model_request", "model_response", "model_error", "tool_intent", "tool_outcome"].includes(event.type)) ||
        !page.events.some(event => event.type === "note" && event.data.text === NOTE && canonicalJson(event.data.data) === canonicalJson(supervisorBudgetContinuationNote(receipt)))) refuse("linked author session changed before execution");
  }
  quiescent(tasks, current, true, linkedSessionId);
  const memory = budgetMemory(tasks, sessions, current, sessionId, receipt.proof.claim, linkedSessionId);
  if (receipt.proof.sessionDigest !== memory.sessionDigest || financed(tasks, cfg, current, memory, receipt.proof.claim, receipt.input.approvedBudgetRequestId).grantDigest !== receipt.proof.grantDigest) refuse("original memory or approved grant changed after continuation");
  if (linkedSessionId) {
    const linked = sessions.get(linkedSessionId)!;
    if (canonicalJson(linked.workspace) !== canonicalJson(memory.workspace) || canonicalJson(replayTranscript(sessions.events(linkedSessionId, { limit: 10000 })!.events).messages) !== canonicalJson(memory.plan.messages)) refuse("linked author memory changed before execution");
  }
  return { receipt, memory };
}

export function supervisorBudgetContinuationNote(receipt: ReceiptValue) {
  return { operationId: receipt.input.operationId, previousSessionId: receipt.input.sessionId, receiptDigest: digest(receipt) };
}

/** Source and lease revalidation before routing and again immediately before runner effects. */
export async function assertSupervisorBudgetContinuationSource(tasks: TaskStore, sessions: SessionStore, cfg: ResolvedConfig, task: StoredTask, sessionId: string, operationId: string, linkedSessionId?: string) {
  const initial = assertSupervisorBudgetContinuation(tasks, sessions, cfg, task, sessionId, operationId, linkedSessionId);
  // Prove the current physical/Git owner before a saved path may acquire any repository lock.
  const preview = await workspaceProof(cfg, task, initial.memory.workspace);
  const admitted = assertSupervisorBudgetContinuation(tasks, sessions, cfg, task, sessionId, operationId, linkedSessionId);
  if (canonicalJson(preview) !== canonicalJson(admitted.receipt.proof.workspace) || canonicalJson(initial.receipt) !== canonicalJson(admitted.receipt)) refuse("retained source or receipt changed before repository admission");
  await withRepositoryMutation(preview.map(repo => repo.worktree), async () => {
    const source = await workspaceProof(cfg, task, initial.memory.workspace);
    const current = assertSupervisorBudgetContinuation(tasks, sessions, cfg, task, sessionId, operationId, linkedSessionId);
    if (canonicalJson(source) !== canonicalJson(current.receipt.proof.workspace) || canonicalJson(initial.receipt) !== canonicalJson(current.receipt)) refuse("retained source or receipt changed before execution");
  }, { expectedCommonDirectories: initial.receipt.proof.workspace.map(repo => repo.commonDirectory) });
}
