import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import picomatch from "picomatch";
import type { ResolvedConfig } from "../config/load.js";
import { SessionStore } from "../sessions/store.js";
import type { SessionEvent } from "../sessions/events.js";
import { immediate } from "../storage/db.js";
import { canonicalJson, type TaskStore } from "../storage/tasks.js";
import { git } from "../workspaces/git.js";
import { projectRuntimeActivationRoots } from "../workspaces/worktree.js";
import { withRepositoryMutation } from "../workspaces/repository-mutation.js";
import { exactRepositoryRoot } from "../workspaces/repository-root.js";
import { WorkerActionRequests } from "../harness/worker-actions.js";
import type { Actor } from "./actor.js";
import { normalizeRelPath } from "../context/repo-reader.js";
import { NativeRecipeSchema, nativeEditPathArgument, nativeOperationPath, nativeRecipeOperation, preflightNativeRecipe, projectNativeOperation, type NativeProjectionOperation } from "./native-edit-projection.js";

const objectId = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const EVENT = "recovered_edit_provenance_attested";
const MAX_BYTES = 2 * 1024 * 1024;
const opts = { timeoutMs: 30000, maxBuffer: MAX_BYTES };
export const RecoveredEditInspectionSchema = z.object({ project: z.string().min(1).max(128), taskId: z.string().min(1).max(200), alias: z.string().min(1).max(80), commit: objectId }).strict();
export const RecoveredEditAttestationSchema = RecoveredEditInspectionSchema.extend({ operationId: z.string().min(1).max(200), expectedDigest: z.string().regex(/^[a-f0-9]{64}$/), reason: z.string().trim().min(1).max(2000) }).strict();
export type RecoveredEditInspectionInput = z.input<typeof RecoveredEditInspectionSchema>;
export type RecoveredEditAttestationInput = z.input<typeof RecoveredEditAttestationSchema>;
export interface RecoveredEditContext { tasks: TaskStore; cfg: ResolvedConfig; now: () => number }
const OriginSchema = z.object({ sessionId: z.string(), responseSeq: z.number().int().positive(), intentSeq: z.number().int().positive(), outcomeSeq: z.number().int().positive().nullable(),
  callId: z.string(), requestId: z.string(), endpointId: z.string(), servedModel: z.string(), servedProvider: z.string(), eventsDigest: z.string(), ledgerDigest: z.string(), agent: z.string(), role: z.string(), job: z.string().nullable(), tier: z.string().nullable(),
  observedProjection: z.object({ version: z.literal(1), base: objectId, operationDigest: z.string(), beforeBlob: objectId.nullable(), afterBlob: objectId.nullable() }).strict().optional() }).strict();
const FileProofSchema = z.object({ path: z.string(), blob: objectId.nullable(), contentDigest: z.string().nullable(), origin: OriginSchema }).strict();
const ProofSchema = z.object({ version: z.literal(1), project: z.string(), taskId: z.string(), alias: z.string(), commit: objectId, parent: objectId, tree: objectId,
  sourceHead: objectId, sourceBase: objectId, sourceWorktree: z.string(), recoveryPointerDigest: z.string(), files: z.array(FileProofSchema).min(1).max(128) }).strict();
const ReceiptSchema = z.object({ input: RecoveredEditAttestationSchema, proof: ProofSchema, digest: z.string(), attestedAt: z.number().int().nonnegative() }).strict();
function refuse(reason: string): never { throw new Error(`recovered_edit_provenance_refused: ${reason}`); }
class NativeProjectionRequired extends Error {}
interface RecoveryDelta { path: string; blob: string | null; beforeBlob: string | null; beforeMode: string; afterMode: string }
const samePath = (a: string, b: string) => process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
async function ownWorktree(c: RecoveredEditContext, alias: string, worktree: string): Promise<void> {
  if (!c.cfg.repositoryPaths[alias]?.writable) refuse("repository is not currently writable");
  const root = realpathSync(projectRuntimeActivationRoots(c.cfg).worktrees), physical = realpathSync(worktree), rel = path.relative(root, physical);
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) || !samePath(physical, worktree)) refuse("worktree physical ownership");
  const common = async (cwd: string) => realpathSync((await exactRepositoryRoot(cwd)).commonDirectory);
  if (!samePath(await common(physical), await common(c.cfg.repositoryPaths[alias]!.path))) refuse("worktree belongs to a different configured repository");
}

/** Read the same-task linked ancestry without manufacturing new provider response events. */
function histories(c: RecoveredEditContext, sessionId: string, taskId: string, alias: string, worktree: string) {
  const sessions = new SessionStore(c.tasks.db, c.cfg.storageDir, c.now), seen = new Set<string>(), history: Array<{ session: NonNullable<ReturnType<SessionStore["get"]>>; events: SessionEvent[] }> = [];
  let id: string | null = sessionId;
  let linkedAt: number | null = null;
  while (id) {
    if (seen.has(id) || seen.size >= 32) refuse("session ancestry is cyclic or exceeds bound");
    seen.add(id);
    const session = sessions.get(id), task = c.tasks.get(taskId);
    if (!session || !task || session.taskId !== taskId || session.profile !== task.spec.profile || session.jobId !== (task.spec.parentTaskId ?? (session.role === "supervisor" ? taskId : null))) refuse("foreign author session ancestry");
    const recorded = session.workspace?.repos.find(repo => repo.alias === alias);
    if (!recorded || !samePath(recorded.worktree, worktree)) refuse("origin workspace does not match recovered workspace");
    const page = sessions.events(id, { limit: 10000 });
    if (!page || page.corrupt.length || page.hasMore) refuse("incomplete or corrupt original session log");
    const cutoff = linkedAt;
    if (cutoff !== null && (session.status === "running" || session.endedAt === null || session.endedAt > cutoff || page.events.some(event => event.at > cutoff))) refuse("ancestor session changed after its linked continuation began");
    history.push({ session, events: page.events });
    linkedAt = session.createdAt;
    id = session.previousSessionId;
  }
  return history;
}

function historicalWindow(c: RecoveredEditContext, sessionId: string, taskId: string, alias: string, worktree: string, commit: string, parent: string) {
  const history = histories(c, sessionId, taskId, alias, worktree);
  for (let index = 0; index < history.length; index++) {
    const item = history[index]!, pointer = item.events.find(event => event.type === "workspace" && event.data.repos.some(repo => repo.alias === alias && repo.head === commit));
    if (!pointer) continue;
    const prior = item.events.filter(event => event.type === "workspace" && event.seq < pointer.seq).at(-1);
    if (!prior || prior.type !== "workspace" || !prior.data.repos.some(repo => repo.alias === alias && repo.head === parent)) refuse("historical recovery has no exact pre-commit workspace head");
    return { history: [{ ...item, events: item.events.filter(event => event.seq < pointer.seq) }, ...history.slice(index + 1)], digest: sha256(canonicalJson([item.session.id, prior, pointer])) };
  }
  return refuse("historical commit has no recorded recovery workspace transition");
}

async function legacyFileProofs(c: RecoveredEditContext, taskId: string, alias: string, worktree: string, sessionId: string, blobs: RecoveryDelta[], retained?: ReturnType<typeof histories>) {
  const task = c.tasks.get(taskId);
  if (!task || !task.spec.repositoryAliases.includes(alias) || task.row.project_id !== c.cfg.brain.project) refuse("task/project/repository ownership");
  const allowed = picomatch(task.spec.constraints.allowedPaths ?? [], { dot: true });
  await ownWorktree(c, alias, worktree);
  const history = retained ?? histories(c, sessionId, taskId, alias, worktree), proof: z.infer<typeof FileProofSchema>[] = [];
  let bytes = 0;
  for (const file of blobs) {
    if (!file.blob) throw new NativeProjectionRequired();
    if (!allowed(file.path) || file.path.includes("\0") || file.path.includes("\\") || path.posix.isAbsolute(file.path) || file.path.split("/").some(part => part === ".." || part === ".")) refuse("recovered path outside assigned write scope");
    const content = await git(worktree, ["cat-file", "blob", objectId.parse(file.blob)], opts);
    bytes += Buffer.byteLength(content);
    if (bytes > MAX_BYTES || content.includes("\0")) refuse("recovered content byte bound or unsupported binary");
    let matched: z.infer<typeof OriginSchema> | null = null;
    // Newest session and newest edit win. An unsupported later edit cannot be hidden by an older match.
    for (const item of history) {
      const edits = item.events.filter((event): event is Extract<SessionEvent, { type: "tool_intent" }> => event.type === "tool_intent" && event.data.sideEffect === "edit").reverse();
      for (const intent of edits) {
        const raw = intent.data.args;
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) refuse("ambiguous retained edit arguments");
        const args = raw as Record<string, unknown>;
        if (intent.data.name === "apply_edits") throw new NativeProjectionRequired();
        const suppliedPath = nativeEditPathArgument(args, intent.data.name);
        if (suppliedPath !== file.path) { if (normalizeRelPath(suppliedPath) === file.path) throw new NativeProjectionRequired(); continue; }
        if (intent.data.name !== "write_file" || typeof args.content !== "string" || args.content !== content) throw new NativeProjectionRequired();
        const blobId: string = createHash(file.blob.length === 40 ? "sha1" : "sha256").update(`blob ${Buffer.byteLength(args.content, "utf8")}\0`).update(args.content, "utf8").digest("hex");
        if (blobId !== file.blob) refuse("original UTF-8 model content does not match the exact Git blob bytes");
        const outcome = item.events.find((event): event is Extract<SessionEvent, { type: "tool_outcome" }> => event.type === "tool_outcome" && event.data.intentSeq === intent.seq);
        if (!outcome) throw new NativeProjectionRequired();
        if (!outcome.data.ok || outcome.data.callId !== intent.data.callId || outcome.data.name !== "write_file") refuse("original edit has no successful exact tool outcome");
        const response = item.events.filter((event): event is Extract<SessionEvent, { type: "model_response" }> => event.type === "model_response" && event.seq < intent.seq).at(-1);
        const call = response?.data.toolCalls.filter(call => call.id === intent.data.callId);
        if (!response || call?.length !== 1 || call[0]!.function.name !== "write_file") {
          if (intent.data.callId.includes(":file:")) throw new NativeProjectionRequired();
          refuse("original response does not own this tool call");
        }
        const request = item.events.filter((event): event is Extract<SessionEvent, { type: "model_request" }> => event.type === "model_request" && event.seq < response.seq).at(-1);
        if (!request || item.events.some(event => event.type === "model_error" && event.seq > request.seq && event.seq < response.seq)) refuse("original response has no unambiguous model request");
        let modelArgs: unknown;
        try { modelArgs = JSON.parse(call[0]!.function.arguments); } catch { refuse("malformed original model tool arguments"); }
        if (canonicalJson(modelArgs) !== canonicalJson(args)) refuse("tool intent differs from original model response");
        const ledger = z.object({ id: z.string(), execution_id: z.string(), status: z.literal("succeeded"), endpoint_id: z.string(), served_model: z.string(), served_provider: z.string(), project_id: z.string(),
          task_id: z.string(), run_count: z.number().int().positive(), lease_incarnation: z.string().min(1) }).parse(c.tasks.db.prepare("SELECT r.id,r.execution_id,r.status,r.endpoint_id,r.served_model,r.served_provider,r.project_id,c.task_id,c.run_count,c.lease_incarnation FROM model_requests r JOIN request_charges c ON c.request_id=r.id WHERE r.id=? AND c.task_id=?").get(response.data.requestId, taskId));
        if (ledger.execution_id !== request.data.executionId || ledger.id !== response.data.requestId || ledger.task_id !== taskId || ledger.project_id !== task.row.project_id || ledger.endpoint_id !== response.data.endpointId || ledger.served_model !== response.data.servedModel || ledger.served_provider !== response.data.servedProvider || ledger.lease_incarnation !== task.row.lease_incarnation) refuse("original served request and charge binding differ");
        const actualEndpoint = `${ledger.served_provider}/${ledger.served_model}`;
        if (ledger.endpoint_id !== actualEndpoint && ledger.endpoint_id !== `paid:${actualEndpoint}`) refuse("unsupported planned alias differs from the proven served model identity");
        if (!c.tasks.db.prepare("SELECT 1 FROM execution_members WHERE execution_id=? AND task_id=?").get(ledger.execution_id, taskId)) refuse("original execution has no task member");
        matched = OriginSchema.parse({ sessionId: item.session.id, responseSeq: response.seq, intentSeq: intent.seq, outcomeSeq: outcome.seq, callId: intent.data.callId,
          requestId: ledger.id, endpointId: ledger.endpoint_id, servedModel: ledger.served_model, servedProvider: ledger.served_provider,
          eventsDigest: sha256(canonicalJson([request, response, intent, outcome])), ledgerDigest: sha256(canonicalJson(ledger)), agent: item.session.agentLabel, role: item.session.role, job: item.session.jobId, tier: item.session.tier });
        break;
      }
      if (matched) break;
    }
    if (!matched) refuse("no exact originating model write exists in retained author ancestry");
    proof.push(FileProofSchema.parse({ path: file.path, blob: file.blob, contentDigest: sha256(content), origin: matched }));
  }
  return proof;
}

type AuthorHistory = ReturnType<typeof histories>[number];
type Intent = Extract<SessionEvent, { type: "tool_intent" }>;
type Outcome = Extract<SessionEvent, { type: "tool_outcome" }>;
function originalOrigin(c: RecoveredEditContext, taskId: string, item: AuthorHistory, intent: Intent) {
  const task = c.tasks.get(taskId)!;
  const outcome = item.events.find((event): event is Outcome => event.type === "tool_outcome" && event.data.intentSeq === intent.seq);
  if (outcome && (outcome.data.callId !== intent.data.callId || outcome.data.name !== intent.data.name)) refuse("original outcome differs from its exact intent");
  const response = item.events.filter((event): event is Extract<SessionEvent, { type: "model_response" }> => event.type === "model_response" && event.seq < intent.seq).at(-1);
  const calls = response?.data.toolCalls.filter(call => call.id === intent.data.callId);
  if (!response || calls?.length !== 1 || calls[0]!.function.name !== intent.data.name) refuse("original response does not own this edit call");
  let args: unknown;
  try { args = JSON.parse(calls[0]!.function.arguments); } catch { refuse("malformed original edit call arguments"); }
  if (canonicalJson(args) !== canonicalJson(intent.data.args)) refuse("edit intent differs from original model response");
  const request = item.events.filter((event): event is Extract<SessionEvent, { type: "model_request" }> => event.type === "model_request" && event.seq < response.seq).at(-1);
  if (!request || item.events.some(event => event.type === "model_error" && event.seq > request.seq && event.seq < response.seq)) refuse("original response has no unambiguous model request");
  const ledger = z.object({ id: z.string(), execution_id: z.string(), status: z.literal("succeeded"), endpoint_id: z.string(), served_model: z.string(), served_provider: z.string(), project_id: z.string(), task_id: z.string(), run_count: z.number().int().positive(), lease_incarnation: z.string().min(1) }).parse(c.tasks.db.prepare("SELECT r.id,r.execution_id,r.status,r.endpoint_id,r.served_model,r.served_provider,r.project_id,c.task_id,c.run_count,c.lease_incarnation FROM model_requests r JOIN request_charges c ON c.request_id=r.id WHERE r.id=? AND c.task_id=?").get(response.data.requestId, taskId));
  if (ledger.execution_id !== request.data.executionId || ledger.project_id !== task.row.project_id || ledger.endpoint_id !== response.data.endpointId || ledger.served_model !== response.data.servedModel || ledger.served_provider !== response.data.servedProvider || ledger.lease_incarnation !== task.row.lease_incarnation) refuse("original served request and charge binding differ");
  const actualEndpoint = `${ledger.served_provider}/${ledger.served_model}`;
  if (ledger.endpoint_id !== actualEndpoint && ledger.endpoint_id !== `paid:${actualEndpoint}`) refuse("unsupported planned alias differs from the proven served model identity");
  if (!c.tasks.db.prepare("SELECT 1 FROM execution_members WHERE execution_id=? AND task_id=?").get(ledger.execution_id, taskId)) refuse("original execution has no task member");
  return OriginSchema.parse({ sessionId: item.session.id, responseSeq: response.seq, intentSeq: intent.seq, outcomeSeq: outcome?.seq ?? null, callId: intent.data.callId, requestId: ledger.id, endpointId: ledger.endpoint_id, servedModel: ledger.served_model, servedProvider: ledger.served_provider, eventsDigest: sha256(canonicalJson([request, response, intent, outcome ?? null])), ledgerDigest: sha256(canonicalJson(ledger)), agent: item.session.agentLabel, role: item.session.role, job: item.session.jobId, tier: item.session.tier });
}

/** Replay only model-owned native effects after an immutable recorded pre-effect HEAD. */
async function nativeFileProofs(c: RecoveredEditContext, taskId: string, alias: string, worktree: string, sessionId: string, base: string, delta: RecoveryDelta[], retained?: ReturnType<typeof histories>) {
  const task = c.tasks.get(taskId);
  if (!task || task.row.project_id !== c.cfg.brain.project || !task.spec.repositoryAliases.includes(alias)) refuse("task/project/repository ownership");
  await ownWorktree(c, alias, worktree);
  const history = (retained ?? histories(c, sessionId, taskId, alias, worktree)).slice().reverse();
  const ordered = history.flatMap(item => item.events.map(event => ({ item, event })));
  let boundary = -1, recordedHead: string | null = null;
  for (let index = 0; index < ordered.length; index++) {
    const event = ordered[index]!.event;
    if (event.type === "workspace") {
      const head = event.data.repos.find(repo => repo.alias === alias)?.head ?? null;
      // Reopened/linked continuations repeat the same pointer after the interrupted effect.
      // Only an actual HEAD transition establishes a new base window.
      if (head && head !== recordedHead) { recordedHead = head; boundary = head === base ? index : -1; }
    }
  }
  if (boundary < 0) refuse("native projection has no exact recorded pre-effect Git base");
  const window = ordered.slice(boundary + 1), consumed = new Set<string>();
  const steps: Array<{ item: AuthorHistory; intent: Intent; outcome: Outcome | undefined; operation: NativeProjectionOperation; origin: z.infer<typeof OriginSchema>; wrapper?: { intent: Intent; edits: z.infer<typeof NativeRecipeSchema>["edits"] } }> = [];
  const allowed = picomatch(task.spec.constraints.allowedPaths ?? [], { dot: true });
  const normalize = (operation: NativeProjectionOperation) => {
    const path = normalizeRelPath(nativeOperationPath(operation));
    if (!allowed(path)) refuse("recovered path outside assigned write scope");
    return { ...operation, args: { ...operation.args, path }, ...(operation.expected ? { expected: { ...operation.expected, path } } : {}) };
  };
  for (const { item, event } of window) {
    if (event.type !== "tool_intent" || event.data.sideEffect !== "edit" || consumed.has(`${item.session.id}:${event.seq}`)) continue;
    const origin = originalOrigin(c, taskId, item, event);
    if (event.data.name === "apply_edits") {
      const edits = NativeRecipeSchema.parse(event.data.args).edits;
      const paths = edits.map(edit => normalizeRelPath(edit.path));
      if (new Set(paths).size !== paths.length) refuse("native wrapper contains duplicate edit targets");
      const parentOutcome = item.events.find((e): e is Outcome => e.type === "tool_outcome" && e.data.intentSeq === event.seq);
      let missing = false;
      for (let index = 0; index < edits.length; index++) {
        const operation = nativeRecipeOperation(edits[index]!);
        const id = `${item.session.id}:${event.data.callId}:file:${index}`;
        const children = item.events.filter((e): e is Intent => e.type === "tool_intent" && e.data.callId === id && e.seq > event.seq && (!parentOutcome || e.seq < parentOutcome.seq));
        if (!children.length) { missing = true; continue; }
        if (missing || children.length !== 1) refuse("native wrapper child sequence is not one ordered applied prefix");
        const child = children[0]!;
        if (child.data.name !== operation.name || child.data.sideEffect !== "edit" || canonicalJson(child.data.args) !== canonicalJson(operation.args)) refuse("native wrapper child differs from its original model-owned operation");
        consumed.add(`${item.session.id}:${child.seq}`);
        const outcome = item.events.find((e): e is Outcome => e.type === "tool_outcome" && e.data.intentSeq === child.seq);
        if (outcome && (!outcome.data.ok || outcome.data.callId !== id || outcome.data.name !== operation.name)) refuse("native child has a failed or mismatched outcome");
        steps.push({ item, intent: child, outcome, operation: normalize(operation), origin, wrapper: { intent: event, edits } });
      }
    } else {
      if (!["write_file", "replace_in_file", "delete_file"].includes(event.data.name)) refuse("unsupported native edit operation");
      const args = z.record(z.string(), z.unknown()).parse(event.data.args);
      const outcome = item.events.find((e): e is Outcome => e.type === "tool_outcome" && e.data.intentSeq === event.seq);
      if (outcome && !outcome.data.ok) refuse("original native edit has a failed outcome");
      steps.push({ item, intent: event, outcome, operation: normalize({ name: event.data.name as NativeProjectionOperation["name"], args }), origin });
    }
  }
  if (!steps.length || steps.length > 128 || steps.filter(step => !step.outcome).length > 1) refuse("native effect replay is empty, exceeds bound or has ambiguous interruption order");
  const uncertain = steps.findIndex(step => !step.outcome);
  if (uncertain >= 0 && uncertain !== steps.length - 1) refuse("unresolved native edit precedes later effects");
  const paths = [...new Set([...delta.map(file => file.path), ...steps.map(step => nativeOperationPath(step.operation)), ...steps.flatMap(step => step.wrapper?.edits.map(edit => normalizeRelPath(edit.path)) ?? [])])];
  if (paths.length > 128) refuse("native projection file bound");
  const initial = new Map<string, { content: string | null; blob: string | null; mode: string }>();
  let bytes = 0;
  for (const path of paths) {
    if (!allowed(path)) refuse("recovered path outside assigned write scope");
    const listing = (await git(worktree, ["ls-tree", "-z", base, "--", `:(literal)${path}`], opts)).split("\0").filter(Boolean);
    if (listing.length > 1) refuse("ambiguous native base path");
    const match = listing.length ? /^(100644|100755) blob ([a-f0-9]+)\t/.exec(listing[0]!) : null;
    if (listing.length && !match) refuse("native base is not a regular file");
    const blob = match?.[2] ?? null;
    const content = blob ? await git(worktree, ["cat-file", "blob", blob], opts) : null;
    if (content !== null) {
      bytes += Buffer.byteLength(content);
      const exact = createHash(blob!.length === 40 ? "sha1" : "sha256").update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest("hex");
      if (exact !== blob || content.includes("\0") || bytes > MAX_BYTES) refuse("native base is not exact bounded UTF-8 text");
    }
    initial.set(path, { content, blob, mode: match?.[1] ?? "000000" });
  }
  const variants = uncertain >= 0 ? [true, false] : [true];
  for (const applyUncertain of variants) {
    const state = new Map([...initial].map(([path, value]) => [path, value.content]));
    const owners = new Map<string, typeof steps[number]>(), checkedWrappers = new Set<string>();
    for (const step of steps) {
      if (step.wrapper) {
        const key = `${step.item.session.id}:${step.wrapper.intent.seq}`;
        if (!checkedWrappers.has(key)) {
          for (const edit of step.wrapper.edits) preflightNativeRecipe(edit, state.get(normalizeRelPath(edit.path)) ?? null);
          checkedWrappers.add(key);
        }
      }
      if (!step.outcome && !applyUncertain) continue;
      const path = nativeOperationPath(step.operation);
      const next = projectNativeOperation(state.get(path) ?? null, step.operation);
      if (next !== null && (Buffer.byteLength(next) > MAX_BYTES || next.includes("\0"))) refuse("projected native content exceeds text bound");
      state.set(path, next); owners.set(path, step);
      if ([...state.values()].reduce((total, content) => total + (content === null ? 0 : Buffer.byteLength(content)), 0) > MAX_BYTES)
        refuse("projected native content exceeds the cumulative byte bound");
    }
    const proofs: z.infer<typeof FileProofSchema>[] = [];
    let matches = true;
    for (const path of paths) {
      const before = initial.get(path)!, after = state.get(path) ?? null, file = delta.find(file => file.path === path);
      if (!file) {
        if (after !== before.content && after?.replace(/\r\n/g, "\n") !== before.content) { matches = false; break; }
        continue;
      }
      const expectedMode = after === null ? "000000" : before.content === null ? "100644" : before.mode;
      if (file.beforeBlob !== before.blob || file.beforeMode !== before.mode || file.afterMode !== expectedMode) { matches = false; break; }
      const representations = after === null ? [null] : [...new Set([after, after.replace(/\r\n/g, "\n")])];
      const exact = representations.find(content => content === null ? file.blob === null : createHash(file.blob?.length === 64 ? "sha256" : "sha1").update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest("hex") === file.blob);
      if (exact === undefined) { matches = false; break; }
      const owner = owners.get(path);
      if (!owner) { matches = false; break; }
      const evidence = steps.map(step => [step.item.session.id, step.intent, step.outcome ?? null, step.wrapper?.intent ?? null]);
      proofs.push(FileProofSchema.parse({ path, blob: file.blob, contentDigest: exact === null ? null : sha256(exact), origin: { ...owner.origin, observedProjection: { version: 1, base, operationDigest: sha256(canonicalJson(evidence)), beforeBlob: before.blob, afterBlob: file.blob } } }));
    }
    if (matches && proofs.length === delta.length) return proofs;
  }
  return refuse("recovered blob differs from exact original native edit projection, or the observed delta includes an unproven path or mode change");
}

async function fileProofs(c: RecoveredEditContext, taskId: string, alias: string, worktree: string, sessionId: string, base: string, delta: RecoveryDelta[], retained?: ReturnType<typeof histories>) {
  try { return await legacyFileProofs(c, taskId, alias, worktree, sessionId, delta, retained); }
  catch (error) { if (!(error instanceof NativeProjectionRequired)) throw error; }
  return nativeFileProofs(c, taskId, alias, worktree, sessionId, base, delta, retained);
}

/** Attribute a future staged recovery to the model/request that actually wrote its exact bytes. */
export async function recoveredEditActor(c: RecoveredEditContext, input: { taskId: string; sessionId: string; alias: string; worktree: string; actor: Actor }) {
  const head = objectId.parse((await git(input.worktree, ["rev-parse", "HEAD"], opts)).trim());
  const tree = objectId.parse((await git(input.worktree, ["write-tree"], opts)).trim());
  const raw = await git(input.worktree, ["diff", "--raw", "--no-abbrev", "--no-renames", "-z", head, tree], opts);
  const parts = raw.split("\0"), files: RecoveryDelta[] = [];
  for (let i = 0; i < parts.length - 1; i += 2) {
    const header = /^:(\d{6}) (\d{6}) ([a-f0-9]+) ([a-f0-9]+) ([AMD])$/.exec(parts[i]!);
    if (!header || (header[5] === "D" ? !["100644", "100755"].includes(header[1]!) || header[2] !== "000000" : !["100644", "100755"].includes(header[2]!) || (header[5] === "A" ? header[2] !== "100644" : header[1] !== header[2]))) refuse("unsupported staged recovery delta or unproven mode change");
    files.push({ path: parts[i + 1]!, blob: header[5] === "D" ? null : objectId.parse(header[4]), beforeBlob: header[5] === "A" ? null : objectId.parse(header[3]), beforeMode: header[1]!, afterMode: header[2]! });
  }
  if (!files.length || files.length > 128) refuse("staged recovery file bound");
  const proof = await fileProofs(c, input.taskId, input.alias, input.worktree, input.sessionId, head, files), origin = proof[0]!.origin;
  if (proof.some(file => file.origin.endpointId !== origin.endpointId || file.origin.requestId !== origin.requestId || file.origin.agent !== origin.agent || file.origin.role !== origin.role || file.origin.job !== origin.job || file.origin.tier !== origin.tier)) refuse("mixed original requests require separate proven recovery commits");
  if (input.actor.task !== input.taskId || input.actor.agent !== origin.agent || input.actor.role !== origin.role) refuse("recovery actor differs from original author");
  return { actor: { ...input.actor, model: origin.endpointId, request: origin.requestId, job: origin.job, tier: origin.tier }, head, tree, ...(proof.some(file => file.origin.observedProjection) ? { observedProjection: { version: 1, base: head, tree, files: proof } } : {}) };
}

function quiescent(c: RecoveredEditContext, input: RecoveredEditInspectionInput) {
  const task = c.tasks.get(input.taskId);
  if (!task || task.row.project_id !== input.project || !["completed", "failed", "cancelled", "budget_exhausted"].includes(task.row.state) || task.row.lease_owner !== null || task.row.lease_expires_at !== null) refuse("historical source is missing, foreign or active");
  if (c.tasks.db.prepare("SELECT 1 FROM sessions WHERE task_id=? AND status='running'").get(input.taskId) || c.tasks.db.prepare("SELECT 1 FROM merge_queue WHERE task_id=? AND state IN ('queued','integrating','picked')").get(input.taskId)) refuse("historical sessions or merge are active");
  const actions = new WorkerActionRequests(c.tasks.db, c.now), scope = { project: input.project, taskId: input.taskId };
  if (actions.list({ ...scope, status: "pending" }).length || actions.list({ ...scope, status: "running" }).length || actions.list({ ...scope, status: "uncertain" }).length) refuse("historical source has unsettled actions");
  return task;
}

export async function inspectRecoveredEditProvenance(c: RecoveredEditContext, raw: RecoveredEditInspectionInput) {
  const input = RecoveredEditInspectionSchema.parse(raw), task = quiescent(c, input);
  const workspace = z.object({ worktree_path: z.string(), base_sha: objectId, repo_alias: z.string() }).parse(c.tasks.db.prepare("SELECT worktree_path,base_sha,repo_alias FROM workspaces WHERE task_id=?").get(input.taskId));
  if (workspace.repo_alias !== input.alias || task.spec.writableRepository !== input.alias) refuse("historical source repository binding");
  await ownWorktree(c, input.alias, workspace.worktree_path);
  const cwd = workspace.worktree_path;
  if ((await git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"], opts)).trim()) refuse("historical source is dirty");
  const sourceHead = objectId.parse((await git(cwd, ["rev-parse", "HEAD"], opts)).trim());
  const rows = (await git(cwd, ["rev-list", "--parents", "--reverse", "--max-count=101", `${workspace.base_sha}..${sourceHead}`], opts)).trim().split(/\r?\n/).filter(Boolean).map(line => line.split(" "));
  const chain = rows.map(row => row[0]!);
  if (!chain.length || chain.length > 100 || !chain.includes(input.commit)) refuse("historical commit is outside the bounded retained chain");
  let previous = workspace.base_sha;
  for (const row of rows) { if (row.length !== 2 || row[1] !== previous) refuse("retained source is not a bounded linear chain"); previous = objectId.parse(row[0]); }
  const parent = objectId.parse(rows[chain.indexOf(input.commit)]![1]);
  const message = await git(cwd, ["show", "-s", "--format=%B", input.commit], opts);
  if (!/^\w+: recovered edits after interruption\r?$/m.test(message) || /^Model: /m.test(message) || /^Request: /m.test(message) || !new RegExp(`^Task: ${input.taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\r?$`, "m").test(message)) refuse("not a historical missing-attribution recovered-edit commit");
  const sessions = new SessionStore(c.tasks.db, c.cfg.storageDir, c.now), authors = sessions.forTask(input.taskId).filter(session => session.role !== "classifier" && session.role !== "reviewer"), latest = authors.at(-1);
  if (!latest || !latest.workspace?.repos.some(repo => repo.alias === input.alias && samePath(repo.worktree, cwd) && repo.head === sourceHead)) refuse("latest author workspace head does not bind the retained source");
  const rawDelta = await git(cwd, ["diff-tree", "--no-commit-id", "--raw", "--no-abbrev", "--no-renames", "-r", "-z", input.commit], opts), parts = rawDelta.split("\0"), blobs: RecoveryDelta[] = [];
  for (let i = 0; i < parts.length - 1; i += 2) {
    const delta = /^:(\d{6}) (\d{6}) ([a-f0-9]+) ([a-f0-9]+) ([AMD])$/.exec(parts[i]!);
    if (!delta || (delta[5] === "D" ? !["100644", "100755"].includes(delta[1]!) || delta[2] !== "000000" : !["100644", "100755"].includes(delta[2]!) || (delta[5] === "A" ? delta[2] !== "100644" : delta[1] !== delta[2]))) refuse("unsupported historical recovered delta or unproven mode change");
    blobs.push({ path: parts[i + 1]!, blob: delta[5] === "D" ? null : objectId.parse(delta[4]), beforeBlob: delta[5] === "A" ? null : objectId.parse(delta[3]), beforeMode: delta[1]!, afterMode: delta[2]! });
  }
  if (!blobs.length || blobs.length > 128) refuse("historical recovered file bound");
  const window = historicalWindow(c, latest.id, input.taskId, input.alias, cwd, input.commit, parent);
  const files = await fileProofs(c, input.taskId, input.alias, cwd, latest.id, parent, blobs, window.history);
  for (const file of files) for (const [key, expected] of [["Agent", file.origin.agent], ["Role", file.origin.role], ["Task", input.taskId], ["Job", task.spec.parentTaskId ?? ""], ["Tier", file.origin.tier ?? ""]] as const) {
    const values = message.split(/\r?\n/).filter(line => line.startsWith(`${key}: `)).map(line => line.slice(key.length + 2));
    if (expected ? values.length !== 1 || values[0] !== expected : values.length !== 0) refuse("historical actor trailers disagree with original evidence");
  }
  const proof = ProofSchema.parse({ version: 1, ...input, parent, tree: (await git(cwd, ["rev-parse", `${input.commit}^{tree}`], opts)).trim(), sourceHead, sourceBase: workspace.base_sha, sourceWorktree: cwd, recoveryPointerDigest: window.digest, files });
  quiescent(c, input);
  return { proof, digest: sha256(canonicalJson(proof)) };
}

export async function attestRecoveredEditProvenance(c: RecoveredEditContext, raw: RecoveredEditAttestationInput) {
  const input = RecoveredEditAttestationSchema.parse(raw), { operationId, expectedDigest, reason, ...inspection } = input;
  const previous = c.tasks.db.prepare("SELECT data_json FROM events WHERE task_id=? AND type=? AND json_extract(data_json,'$.input.operationId')=? ORDER BY id LIMIT 1").get(input.taskId, EVENT, operationId) as { data_json: string } | undefined;
  if (previous) {
    const receipt = ReceiptSchema.parse(JSON.parse(previous.data_json));
    if (canonicalJson(receipt.input) !== canonicalJson(input)) refuse("attestation replay input changed");
    const current = await inspectRecoveredEditProvenance(c, inspection);
    if (current.digest !== receipt.digest) refuse("attestation replay proof changed");
    return { ...receipt, disposition: "replayed" as const };
  }
  // Validate project/physical ownership before taking a filesystem lock; a stored path is not authority.
  const preview = await inspectRecoveredEditProvenance(c, inspection);
  if (preview.digest !== expectedDigest) refuse("attestation snapshot digest changed");
  return withRepositoryMutation([preview.proof.sourceWorktree], async () => {
    const current = await inspectRecoveredEditProvenance(c, inspection);
    if (current.digest !== expectedDigest) refuse("attestation snapshot digest changed");
    return immediate(c.tasks.db, () => {
      quiescent(c, inspection);
      const raced = c.tasks.db.prepare("SELECT 1 FROM events WHERE task_id=? AND type=? AND json_extract(data_json,'$.input.operationId')=?").get(input.taskId, EVENT, operationId);
      if (raced) refuse("attestation operation raced; inspect or replay it again");
      const receipt = ReceiptSchema.parse({ input, ...current, attestedAt: c.now() });
      c.tasks.event(input.taskId, EVENT, receipt);
      return { ...receipt, disposition: "fresh" as const };
    });
  });
}

/** Missing commit trailers require an independently revalidated exact origin receipt. */
export async function verifyRecoveredEditAttestation(c: RecoveredEditContext, raw: RecoveredEditInspectionInput) {
  const input = RecoveredEditInspectionSchema.parse(raw);
  const rows = c.tasks.db.prepare("SELECT data_json FROM events WHERE task_id=? AND type=? AND json_extract(data_json,'$.proof.commit')=? ORDER BY id LIMIT 2").all(input.taskId, EVENT, input.commit) as Array<{ data_json: string }>;
  if (rows.length !== 1) refuse("missing or ambiguous historical attribution receipt");
  const receipt = ReceiptSchema.parse(JSON.parse(rows[0]!.data_json));
  if (receipt.input.project !== input.project || receipt.input.taskId !== input.taskId || receipt.input.alias !== input.alias || receipt.input.commit !== input.commit || receipt.input.expectedDigest !== receipt.digest) refuse("foreign attribution receipt");
  const current = await inspectRecoveredEditProvenance(c, input);
  if (current.digest !== receipt.digest || canonicalJson(current.proof) !== canonicalJson(receipt.proof)) refuse("historical attribution proof changed");
  return current.proof;
}
