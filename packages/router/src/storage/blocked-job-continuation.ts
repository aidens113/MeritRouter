import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { effectiveBudget, heldRequests, UNLIMITED_REQUESTS } from "../admission/admission.js";
import { extraRequests } from "../admission/job-pool.js";
import type { ResolvedConfig } from "../config/load.js";
import { TaskValidationError } from "../core/errors.js";
import { TASK_STATES, TERMINAL_STATES, WorkerResultSchema } from "../core/task.js";
import { assertRunAuthority } from "../harness/task-authority.js";
import type { RunContext } from "../runners/types.js";
import { SessionStore } from "../sessions/store.js";
import { authorSessions } from "../sessions/run-sessions.js";
import { SessionWorkspaceSchema } from "../sessions/events.js";
import { replayTranscript } from "../sessions/resume.js";
import { ProductDeliveries } from "../verification/product-delivery.js";
import { exactRepositoryRoot } from "../workspaces/repository-root.js";
import { git } from "../workspaces/git.js";
import { withRepositoryMutation } from "../workspaces/repository-mutation.js";
import { projectRuntimeActivationRoots } from "../workspaces/worktree.js";
import { immediate } from "./db.js";
import { canonicalJson, type StoredTask, type TaskStore } from "./tasks.js";

const STOP = "supervisor_blocked", EVENT = "blocked_job_continued", NOTE = "blocked_job_continuation";
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const hash = z.string().regex(/^[a-f0-9]{64}$/), oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const BlockedJobContinuationSchema = z.object({
  operationId: z.string().min(1).max(200), project: z.string().min(1).max(128), taskId: z.string().min(1).max(200), sessionId: z.string().min(1).max(200),
  expectedDeadlineAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), expectedRunCount: z.number().int().positive(), expectedIncarnation: z.string().min(1).max(200),
  reason: z.string().trim().min(1).max(2000), additionalSeconds: z.number().int().positive().max(604800).optional(),
}).strict();
export type BlockedJobContinuationInput = z.input<typeof BlockedJobContinuationSchema>;
const RepoProof = z.object({ alias: z.string(), worktree: z.string(), configuredRoot: z.string(), commonDirectory: z.string(), base: oid, head: oid, tree: oid, branch: z.string().nullable() }).strict();
const Proof = z.object({ taskSpecDigest: hash, sessionDigest: hash, workspace: z.array(RepoProof).min(1).max(32) }).strict();
const Receipt = z.object({ version: z.literal(1), input: BlockedJobContinuationSchema, previousDeadlineAt: z.number().int().positive(), deadlineAt: z.number().int().positive(),
  continuedAt: z.number().int().nonnegative(), previousResult: WorkerResultSchema, proof: Proof, proofDigest: hash }).strict()
  .refine(receipt => receipt.previousDeadlineAt === receipt.input.expectedDeadlineAt && receipt.previousResult.stopReason === STOP, "receipt must preserve the exact prior blocked result and deadline");
const Note = z.object({ operationId: z.string().min(1), previousSessionId: z.string().min(1), receiptDigest: hash }).strict();
const ActionRow = z.object({ id: z.string().min(1), project_id: z.string().min(1), task_id: z.string().min(1), value_json: z.string().max(100000),
  task_project: z.string().min(1), task_state: z.enum(TASK_STATES), lease_owner: z.string().nullable(), lease_expires_at: z.number().int().nullable(), active_sessions: z.union([z.literal(0), z.literal(1)]) }).strict();
const HistoricalAction = z.object({ id: z.string().min(1), project: z.string().min(1), taskId: z.string().min(1),
  status: z.enum(["pending", "running", "completed", "denied", "cancelled", "uncertain"]),
  quiescedAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional() }).passthrough();
type ReceiptValue = z.infer<typeof Receipt>;
const samePath = (a: string, b: string) => process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
function refuse(reason: string): never { throw new TaskValidationError(`blocked_job_continuation_refused: ${reason}`); }

function receiptFor(tasks: TaskStore, taskId: string, operationId: string): ReceiptValue | null {
  const row = tasks.db.prepare("SELECT data_json FROM events WHERE task_id=? AND type=? AND json_extract(data_json,'$.input.operationId')=? ORDER BY id LIMIT 1")
    .get(taskId, EVENT, operationId) as { data_json: string } | undefined;
  if (!row) return null;
  const receipt = Receipt.parse(JSON.parse(row.data_json));
  if (receipt.input.taskId !== taskId || digest(receipt.proof) !== receipt.proofDigest) refuse("continuation receipt changed");
  return receipt;
}
const sessionProject = (tasks: TaskStore, id: string) => z.object({ project_id: z.string() }).parse(tasks.db.prepare("SELECT project_id FROM sessions WHERE id=?").get(id)).project_id;

/** Read original settled memory without reopening its log or replaying an effect. */
export function blockedJobMemory(tasks: TaskStore, sessions: SessionStore, cfg: ResolvedConfig, task: StoredTask, sessionId: string, latest = true) {
  const session = sessions.get(sessionId);
  if (!session || session.taskId !== task.row.id || sessionProject(tasks, session.id) !== task.row.project_id || session.role !== "supervisor" || session.profile !== task.spec.profile || session.jobId !== task.row.id ||
      session.status !== "completed" || session.stopReason !== STOP || (latest && authorSessions(sessions, task.row.id).at(-1)?.id !== sessionId) || cfg.profiles[task.spec.profile]?.mode !== "supervisor") refuse("latest exact completed blocked supervisor memory is required");
  if (statSync(session.logPath).size > 32 * 1024 * 1024) refuse("retained log exceeds bounded continuation proof");
  const page = sessions.events(session.id, { limit: 10000 });
  if (!page || page.corrupt.length || page.hasMore || page.events.at(-1)?.type !== "ended") refuse("retained log is incomplete or corrupt");
  const ended = page.events.at(-1)!;
  if (ended.type !== "ended" || ended.data.status !== "completed" || ended.data.stopReason !== STOP) refuse("retained terminal log does not match its blocked status");
  const plan = sessions.planResume(session.id, { recoverEdits: cfg.sessions.recover_edits });
  if (!plan?.messages.length || plan.actions.length || plan.warnings.length || plan.droppedRequestSeqs.length || sessions.pendingIntents(session.id)?.length) refuse("retained memory has unresolved effects or requests");
  const workspace = SessionWorkspaceSchema.parse(session.workspace);
  if (canonicalJson(workspace) !== canonicalJson(plan.workspace)) refuse("retained workspace row differs from its typed log");
  if (!workspace.repos.length || workspace.repos.length > 32 || new Set(workspace.repos.map(repo => repo.alias)).size !== workspace.repos.length) refuse("retained workspace is missing or ambiguous");
  const lastAssistant = [...plan.messages].reverse().find(message => message.role === "assistant");
  const finish = lastAssistant?.role === "assistant" ? lastAssistant.tool_calls?.find(call => call.function.name === "finish_job") : null;
  let args: unknown; try { args = finish ? JSON.parse(finish.function.arguments) : null; } catch { refuse("blocked terminal arguments are malformed"); }
  if (!finish || !z.object({ status: z.literal("blocked") }).passthrough().safeParse(args).success || !plan.messages.some(message => message.role === "tool" && message.tool_call_id === finish.id && message.content === "accepted")) refuse("original blocked terminal submission is not settled");
  return { session, plan, workspace, sessionDigest: digest({ session, events: page.events }) };
}

function quiescent(tasks: TaskStore, task: StoredTask, ignoreSession?: string, claimed = false): void {
  const id = task.row.id, project = task.row.project_id;
  if (!claimed && (task.row.lease_owner !== null || task.row.lease_expires_at !== null)) refuse("task still has an owner");
  if (task.row.cancel_requested) refuse("task is cancelled");
  if (tasks.db.prepare("SELECT 1 FROM sessions WHERE task_id=? AND status='running' AND (? IS NULL OR id<>?) LIMIT 1").get(id, ignoreSession ?? null, ignoreSession ?? null)) refuse("author or reviewer session is active");
  if (tasks.db.prepare("SELECT 1 FROM merge_queue WHERE (job_id=? OR task_id=?) AND state IN ('queued','integrating','picked') LIMIT 1").get(id, id)) refuse("job merge is active");
  if (tasks.db.prepare("SELECT 1 FROM model_requests r JOIN request_charges c ON c.request_id=r.id WHERE c.task_id=? AND r.status='reserved' LIMIT 1").get(id)) refuse("model request is still active");
  // Unlike WorkerActionRequests.list, this read must not reconcile or mutate old action state.
  const rows = tasks.db.prepare(`WITH RECURSIVE tree(id) AS (SELECT id FROM tasks WHERE id=? AND project_id=? UNION SELECT t.id FROM tasks t JOIN tree p ON json_extract(t.spec_json,'$.parentTaskId')=p.id WHERE t.project_id=?)
    SELECT a.id,a.project_id,a.task_id,a.value_json,t.project_id AS task_project,t.state AS task_state,t.lease_owner,t.lease_expires_at,
      EXISTS(SELECT 1 FROM sessions s WHERE s.task_id=t.id AND s.status='running') AS active_sessions
    FROM worker_action_requests a JOIN tasks t ON t.id=a.task_id WHERE a.project_id=? AND a.task_id IN (SELECT id FROM tree)
      AND COALESCE(json_extract(a.value_json,'$.status'),'') NOT IN ('completed','denied','cancelled') ORDER BY a.id LIMIT 501`).all(id, project, project, project);
  if (rows.length > 500) refuse("unsettled action history exceeds bounded continuation proof");
  for (const raw of rows) {
    const row = ActionRow.parse(raw), action = HistoricalAction.parse(JSON.parse(row.value_json));
    if (action.id !== row.id || action.project !== project || row.task_project !== project || action.taskId !== row.task_id) refuse("stored action scope differs from its task/project row");
    // A host-quiesced timeout remains UNKNOWN history, never a successful execution or a replay.
    if (action.status === "uncertain" && action.quiescedAt !== undefined && row.task_id !== id && TERMINAL_STATES.has(row.task_state) &&
        row.lease_owner === null && row.lease_expires_at === null && row.active_sessions === 0) continue;
    refuse("job has active or unresolved command actions");
  }
}

async function workspaceProof(cfg: ResolvedConfig, task: StoredTask, workspace: z.infer<typeof SessionWorkspaceSchema>) {
  const root = realpathSync(projectRuntimeActivationRoots(cfg).worktrees), result: z.infer<typeof RepoProof>[] = [];
  for (const repo of workspace.repos) {
    const configured = cfg.repositoryPaths[repo.alias];
    if (!task.spec.repositoryAliases.includes(repo.alias) || !configured?.writable || !repo.baseCommit || !repo.head) refuse("workspace is outside the current assigned writable repositories");
    const physical = realpathSync(repo.worktree), rel = path.relative(root, physical);
    if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) || !samePath(physical, repo.worktree)) refuse("workspace physical ownership changed");
    const configuredRoot = realpathSync(configured.path), actual = await exactRepositoryRoot(physical), expected = await exactRepositoryRoot(configuredRoot);
    const commonDirectory = realpathSync(actual.commonDirectory);
    if (!samePath(commonDirectory, realpathSync(expected.commonDirectory))) refuse("workspace belongs to a different configured Git owner");
    const opts = { timeoutMs: 30000, maxBuffer: 2 * 1024 * 1024 };
    if ((await git(physical, ["status", "--porcelain=v1", "--untracked-files=all"], opts)).trim()) refuse("retained workspace is dirty");
    const head = (await git(physical, ["rev-parse", "HEAD"], opts)).trim();
    if (head !== repo.head) refuse("retained workspace HEAD changed");
    const ref = (await git(physical, ["rev-parse", "--abbrev-ref", "HEAD"], opts)).trim(), branch = ref === "HEAD" ? null : ref;
    if (branch !== repo.branch) refuse("retained workspace branch changed");
    result.push(RepoProof.parse({ alias: repo.alias, worktree: physical, configuredRoot, commonDirectory, base: repo.baseCommit, head, tree: (await git(physical, ["rev-parse", "HEAD^{tree}"], opts)).trim(), branch: repo.branch }));
  }
  return result;
}

function eligible(tasks: TaskStore, sessions: SessionStore, cfg: ResolvedConfig, input: BlockedJobContinuationInput) {
  const task = tasks.get(input.taskId);
  if (!task || task.row.project_id !== input.project || task.row.state !== "completed" || task.row.state_reason !== STOP || task.result?.stopReason !== STOP || task.result.acceptanceStatus === "met") refuse("task is not an unaccepted honestly blocked terminal supervisor");
  if (task.row.run_count !== input.expectedRunCount || task.row.deadline_at !== input.expectedDeadlineAt || task.row.lease_incarnation !== input.expectedIncarnation) refuse("deadline or attempt changed");
  quiescent(tasks, task);
  const product = new ProductDeliveries(tasks.db).status(task.row.id, input.project);
  if (product?.candidate || product?.finalDecision) refuse("candidate decisions use the existing FINAL delivery path");
  const memory = blockedJobMemory(tasks, sessions, cfg, task, input.sessionId);
  const cap = effectiveBudget(cfg, task.spec, memory.session.tier).maxModelRequests;
  const allowed = cap === UNLIMITED_REQUESTS ? cap : cap + extraRequests(tasks.db, task.row.id);
  const used = z.object({ n: z.number().int().nonnegative() }).parse(tasks.db.prepare("SELECT COUNT(*) n FROM request_charges WHERE task_id=?").get(task.row.id)).n;
  if (used + heldRequests(tasks.db, task.row.id) >= allowed) refuse("existing request budget is exhausted or held");
  return { task, memory };
}

/** Trusted operator control; absent from all runtime tools. */
export async function continueBlockedJob(tasks: TaskStore, sessions: SessionStore, cfg: ResolvedConfig, raw: BlockedJobContinuationInput) {
  const input = BlockedJobContinuationSchema.parse(raw), existing = receiptFor(tasks, input.taskId, input.operationId);
  if (existing) {
    if (canonicalJson(existing.input) !== canonicalJson(input)) refuse("operation replay changed its input");
    if (tasks.get(input.taskId)?.row.project_id !== input.project) refuse("replay task project changed");
    return { ...existing, disposition: "replayed" as const };
  }
  const initial = eligible(tasks, sessions, cfg, input);
  // Physical ownership is checked before mutation admission can create any repository lock.
  const preview = await workspaceProof(cfg, initial.task, initial.memory.workspace);
  return withRepositoryMutation(preview.map(repo => repo.worktree), async () => {
    const checked = eligible(tasks, sessions, cfg, input), repos = await workspaceProof(cfg, checked.task, checked.memory.workspace);
    if (canonicalJson(preview) !== canonicalJson(repos) || initial.memory.sessionDigest !== checked.memory.sessionDigest) refuse("retained evidence changed during admission");
    return immediate(tasks.db, () => {
      const replay = receiptFor(tasks, input.taskId, input.operationId);
      if (replay) { if (canonicalJson(replay.input) !== canonicalJson(input)) refuse("operation replay changed its input"); return { ...replay, disposition: "replayed" as const }; }
      const current = eligible(tasks, sessions, cfg, input);
      if (current.memory.sessionDigest !== checked.memory.sessionDigest || canonicalJson(current.task.spec) !== canonicalJson(checked.task.spec)) refuse("retained memory changed before continuation");
      const now = tasks.serverNow(), allowance = current.task.spec.budget?.timeoutSeconds ?? cfg.supervisor.job_timeout_seconds;
      if (input.additionalSeconds !== undefined && input.additionalSeconds > allowance) refuse("explicit time grant exceeds the task execution allowance");
      const deadlineAt = input.additionalSeconds === undefined ? input.expectedDeadlineAt : Math.max(now, input.expectedDeadlineAt) + input.additionalSeconds * 1000;
      if (deadlineAt <= now) refuse("deadline expired; explicit bounded execution time is required");
      const proof = Proof.parse({ taskSpecDigest: digest(current.task.spec), sessionDigest: current.memory.sessionDigest, workspace: repos });
      const receipt = Receipt.parse({ version: 1, input, previousDeadlineAt: input.expectedDeadlineAt, deadlineAt, continuedAt: now, previousResult: current.task.result, proof, proofDigest: digest(proof) });
      const changed = tasks.db.prepare("UPDATE tasks SET state='queued',state_reason='resumed',result_json=NULL,finished_at=NULL,deadline_at=?,updated_at=? WHERE id=? AND project_id=? AND state='completed' AND state_reason=? AND deadline_at=? AND run_count=? AND lease_incarnation=? AND cancel_requested=0 AND lease_owner IS NULL AND lease_expires_at IS NULL")
        .run(deadlineAt, now, input.taskId, input.project, STOP, input.expectedDeadlineAt, input.expectedRunCount, input.expectedIncarnation);
      if (changed.changes !== 1) refuse("continuation authority changed");
      tasks.event(input.taskId, EVENT, receipt);
      tasks.event(input.taskId, "resumed", { sessionId: input.sessionId, blockedJobContinuation: true, blockedJobOperationId: input.operationId });
      return { ...receipt, disposition: "fresh" as const };
    });
  });
}

/** Exact receipt gate before terminal history is cloned into the next claimed author log. */
export function assertBlockedJobContinuation(tasks: TaskStore, sessions: SessionStore, cfg: ResolvedConfig, task: StoredTask, sessionId: string, operationId: string) {
  const receipt = receiptFor(tasks, task.row.id, operationId);
  if (!receipt || receipt.input.project !== task.row.project_id || receipt.input.sessionId !== sessionId || receipt.input.expectedRunCount + 1 !== task.row.run_count || receipt.input.expectedIncarnation !== task.row.lease_incarnation || receipt.deadlineAt !== task.row.deadline_at || receipt.proof.taskSpecDigest !== digest(task.spec)) refuse("receipt does not authorize this claimed continuation");
  const memory = blockedJobMemory(tasks, sessions, cfg, task, sessionId);
  if (receipt.proof.sessionDigest !== memory.sessionDigest) refuse("original settled memory changed after continuation");
  return { receipt, memory };
}

export function blockedJobContinuationNote(receipt: ReceiptValue) { return { operationId: receipt.input.operationId, previousSessionId: receipt.input.sessionId, receiptDigest: digest(receipt) }; }

/** Validate the new linked log and its source before any supervisor repository/brain effects. */
export async function blockedJobRunPolicy(ctx: RunContext): Promise<{ skipSettledTerminal: true } | null> {
  if (!ctx.session || !ctx.resume) return null;
  const latest = ctx.tasks.db.prepare("SELECT data_json FROM events WHERE task_id=? AND type=? ORDER BY id DESC LIMIT 1").get(ctx.taskId, EVENT) as { data_json: string } | undefined;
  // This control operation must not impose new log bounds or reads on unrelated resumes.
  if (!latest) return null;
  const expected = Receipt.parse(JSON.parse(latest.data_json));
  const sessions = new SessionStore(ctx.tasks.db, ctx.cfg.storageDir, ctx.now), current = sessions.get(ctx.session.id), task = ctx.tasks.get(ctx.taskId);
  if (!current || !task) refuse("linked author session disappeared");
  const page = sessions.events(current.id, { limit: 10000 });
  if (!page || page.corrupt.length || page.hasMore) refuse("linked author log is incomplete");
  const note = [...page.events].reverse().find(event => event.type === "note" && event.data.text === NOTE);
  if (!note) {
    if (expected?.input.sessionId === current.previousSessionId) refuse("linked continuation note is missing");
    return null;
  }
  if (note.type !== "note") return null;
  const data = Note.parse(note.data.data), receipt = receiptFor(ctx.tasks, ctx.taskId, data.operationId);
  if (!receipt || data.receiptDigest !== digest(receipt) || data.previousSessionId !== receipt.input.sessionId || current.previousSessionId !== receipt.input.sessionId || current.taskId !== ctx.taskId || sessionProject(ctx.tasks, current.id) !== receipt.input.project || task.row.project_id !== receipt.input.project ||
      current.role !== "supervisor" || current.profile !== task.spec.profile || current.jobId !== ctx.taskId || receipt.input.expectedIncarnation !== task.row.lease_incarnation || receipt.input.expectedRunCount >= task.row.run_count) refuse("linked continuation note lacks exact operator receipt authority");
  // Once a real new response exists, normal accepted-terminal crash recovery is mandatory.
  if (page.events.some(event => event.type === "model_response" && event.seq > note.seq)) return null;
  assertRunAuthority(ctx);
  if (receipt.proof.taskSpecDigest !== digest(task.spec) || cfgMode(ctx.cfg, task) !== "supervisor") refuse("continued task assignment changed");
  const memory = blockedJobMemory(ctx.tasks, sessions, ctx.cfg, task, receipt.input.sessionId, false);
  const initialMessages = replayTranscript(page.events.filter(event => event.seq < note.seq)).messages;
  if (memory.sessionDigest !== receipt.proof.sessionDigest || canonicalJson(initialMessages) !== canonicalJson(memory.plan.messages)) refuse("linked original native memory changed");
  quiescent(ctx.tasks, task, current.id, true);
  const checked = await workspaceProof(ctx.cfg, task, memory.workspace);
  assertRunAuthority(ctx);
  if (canonicalJson(checked) !== canonicalJson(receipt.proof.workspace)) refuse("continued workspace no longer matches its receipt");
  assertRunAuthority(ctx);
  return withRepositoryMutation(checked.map(repo => repo.worktree), async () => {
    assertRunAuthority(ctx);
    const again = await workspaceProof(ctx.cfg, task, memory.workspace);
    assertRunAuthority(ctx);
    if (canonicalJson(again) !== canonicalJson(checked)) refuse("continued workspace changed during dispatch admission");
    return { skipSettledTerminal: true as const };
  });
}
const cfgMode = (cfg: ResolvedConfig, task: StoredTask) => cfg.profiles[task.spec.profile]?.mode;
