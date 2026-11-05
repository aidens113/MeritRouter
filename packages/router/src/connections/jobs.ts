import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { loadConfig, type ResolvedConfig } from "../config/load.js";
import { PROJECT_SLUG_RE, REPOSITORY_ALIAS_RE } from "../config/schema.js";
import { isTerminal, WorkerTaskSchema, type TaskState, type WorkerResult, type WorkerTask } from "../core/task.js";
import type { Db } from "../storage/db.js";
import type { StoredTask, SubmitOutcome, TaskStore } from "../storage/tasks.js";
import { ProjectRegistry } from "../projects/registry.js";
import type { ProjectContext } from "../projects/context.js";
import { jobPool } from "../admission/budget-requests.js";
import { effectiveBudget, type Admission } from "../admission/admission.js";
import { ClientConnectionError } from "./protocol.js";

export const ClientJobModeSchema = z.enum(["agent", "team"]);
const alias = z.string().regex(REPOSITORY_ALIAS_RE).max(128);
export const ClientJobRequestSchema = z.object({
  mode: ClientJobModeSchema,
  goal: z.string().trim().min(1).max(20000),
  context: z.string().max(400000).optional(),
  repository_aliases: z.array(alias).min(1).max(32).optional(),
  writable_repository: alias.optional(),
  allowed_paths: z.array(z.string().min(1).max(1024)).min(1).max(100).optional(),
  acceptance_criteria: z.array(z.string().min(1).max(4000)).min(1).max(30).optional(),
  budget: z.object({ max_model_requests: z.number().int().min(1).max(10000).optional(), timeout_seconds: z.number().int().min(1).max(7200).optional(), max_paid_usd: z.number().min(0).max(500).optional() }).strict().optional(),
}).strict();
export type ClientJobRequest = z.infer<typeof ClientJobRequestSchema>;
export const ClientJobSubmissionSchema = ClientJobRequestSchema.extend({ project: z.string().regex(PROJECT_SLUG_RE).max(128) }).strict();
export type ClientJobSubmission = z.infer<typeof ClientJobSubmissionSchema>;
export const ClientJobAccessSchema = z.object({ project: z.string().regex(PROJECT_SLUG_RE).max(128), job_id: z.string().regex(/^tclientjob_[a-f0-9]{32}$/), access_token: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type ClientJobAccess = z.infer<typeof ClientJobAccessSchema>;
export interface ClientJobStatus {
  object: "meritrouter.job";
  job_id: string;
  project: string;
  mode: "agent" | "team";
  state: TaskState;
  execution: "queued_requires_worker" | "running" | "cancelling" | "waiting_for_approval" | "interrupted" | "finished";
  status_url: string;
  cancel_url: string;
  created_at: string;
  finished_at: string | null;
  requests_used: number;
  requests_limit: number;
  children: Array<{ job_id: string; profile: string; state: TaskState }>;
  result: Pick<WorkerResult, "executionStatus" | "acceptanceStatus" | "verificationStatus" | "summary" | "findings" | "data" | "unresolvedCriteria"> | null;
}
export interface ClientJobAccepted extends ClientJobStatus { access_token: string }
export interface ClientJobCallbacks {
  submit(request: ClientJobSubmission, signal: AbortSignal, accessToken?: string): Promise<ClientJobAccepted>;
  get(access: ClientJobAccess): ClientJobStatus;
  cancel(access: ClientJobAccess): Promise<ClientJobStatus>;
}
export interface ClientJobStore { db: Db; tasks: TaskStore; admission: Admission; assertCurrent(): void }
export interface ClientJobHost {
  cfg: ResolvedConfig;
  assertAccess(cfg: ResolvedConfig): void;
  project(project: string): ProjectContext;
  store(project: string): ClientJobStore;
  assertTeamReady(project: string, cfg: ProjectContext): void;
  submit(spec: WorkerTask, project: string, purpose: "client_agent" | "client_team", beforeInsert: (specs: readonly WorkerTask[]) => void): Promise<SubmitOutcome>;
  cancel(ids: string[], project: string): Promise<unknown>;
}
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
const purpose = (mode: "agent" | "team") => mode === "agent" ? "client_agent" as const : "client_team" as const;
const terminal = "('completed','failed','cancelled','budget_exhausted')";
function refused(code: string, message: string): never { throw new ClientConnectionError(400, code, message); }
function selectedRepositories(request: ClientJobSubmission, cfg: ProjectContext): string[] {
  const allowed = cfg.client_connections.repositories, selected = request.repository_aliases ?? allowed;
  if (!selected.length || new Set(selected).size !== selected.length || selected.some(value => !allowed.includes(value) || !cfg.repositoryPaths[value]))
    refused("repository_scope_refused", "Choose only repositories enabled for this project's connections.");
  return selected;
}
function settingsAllow(request: ClientJobSubmission, cfg: ProjectContext): void {
  const settings = cfg.client_connections;
  if (!settings.enabled || settings.project !== request.project || !settings.enabled_modes.includes(request.mode))
    throw new ClientConnectionError(403, "connection_mode_disabled", "This connection mode or selected project is disabled.");
  const budget = request.budget;
  if ((budget?.max_model_requests ?? settings.agent_max_model_requests) > settings.agent_max_model_requests ||
    (budget?.timeout_seconds ?? settings.agent_timeout_seconds) > settings.agent_timeout_seconds ||
    (budget?.max_paid_usd ?? settings.agent_max_paid_usd) > settings.agent_max_paid_usd)
    refused("job_budget_exceeded", "Requested job limits exceed the configured connection limits.");
  selectedRepositories(request, cfg);
}
function safePaths(paths: string[]): string[] {
  if (paths.some(value => value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value) || value.replaceAll("\\", "/").split("/").includes("..")))
    refused("invalid_allowed_paths", "Allowed paths must stay relative to the selected repository.");
  return paths;
}
function descendants(store: ClientJobStore, root: StoredTask): StoredTask[] {
  const ids = z.array(z.object({ id: z.string() }).strict()).max(10001).parse(store.db.prepare(`WITH RECURSIVE tree(id) AS (
    SELECT id FROM tasks WHERE id=? AND project_id=? UNION SELECT t.id FROM tasks t JOIN tree p ON json_extract(t.spec_json,'$.parentTaskId')=p.id WHERE t.project_id=?)
    SELECT id FROM tree LIMIT 10001`).all(root.row.id, root.row.project_id, root.row.project_id));
  if (ids.length > 10000) throw new ClientConnectionError(409, "job_tree_too_large", "This job needs cancellation or inspection in the project panel.");
  return ids.map(row => store.tasks.get(row.id)!).filter(Boolean);
}
/** Narrow legacy insertion fence: an awaited delegation cannot outlive its connection job. */
export function assertClientJobAncestorsActive(db: Db, specs: readonly WorkerTask[], project: string): void {
  for (const spec of specs) {
    if (!spec.parentTaskId) continue;
    const chain = z.array(z.object({ id: z.string(), purpose: z.string(), state: z.string(), cancel_requested: z.number().int() }).strict()).max(1001).parse(db.prepare(`WITH RECURSIVE ancestors(id) AS (
      SELECT id FROM tasks WHERE id=? AND project_id=? UNION SELECT t.id FROM tasks t JOIN tasks child ON json_extract(child.spec_json,'$.parentTaskId')=t.id JOIN ancestors a ON child.id=a.id WHERE t.project_id=?)
      SELECT t.id,t.purpose,t.state,t.cancel_requested FROM tasks t JOIN ancestors a ON t.id=a.id LIMIT 1001`).all(spec.parentTaskId, project, project));
    const client = chain.some(row => /^tclientjob_[a-f0-9]{32}$/.test(row.id) && ["client_agent", "client_team"].includes(row.purpose));
    if (client && (chain.length > 1000 || chain.some(row => row.cancel_requested || isTerminal(row.state as TaskState))))
      throw new ClientConnectionError(409, "job_delegation_cancelled", "The owning connection job or an ancestor ended before this delegation could be inserted.");
  }
}
function owned(host: ClientJobHost, input: ClientJobAccess): { store: ClientJobStore; root: StoredTask; mode: "agent" | "team" } {
  const access = ClientJobAccessSchema.parse(input);
  host.project(access.project);
  const store = host.store(access.project); store.assertCurrent();
  const root = store.tasks.get(access.job_id), storedPurpose = root?.row as (StoredTask["row"] & { purpose?: string }) | undefined;
  const mode = storedPurpose?.purpose === "client_agent" ? "agent" : storedPurpose?.purpose === "client_team" ? "team" : null;
  const actual = root?.spec.idempotencyKey, expected = mode ? "connection:" + mode + ":" + digest(access.access_token) : "";
  if (!root || root.row.project_id !== access.project || !mode || root.spec.parentTaskId || !actual || actual.length !== expected.length || !timingSafeEqual(Buffer.from(actual), Buffer.from(expected)))
    throw new ClientConnectionError(404, "job_not_found", "No connection-owned job matches this project and token.");
  return { store, root, mode };
}
export function getClientJob(host: ClientJobHost, input: ClientJobAccess): ClientJobStatus {
  const { store, root, mode } = owned(host, input), members = descendants(store, root), result = root.result;
  const pool = mode === "team" ? jobPool(store.db, host.project(input.project), root.row.id) : null;
  // Count physical requests once even if a batch or review charged several descendants.
  // Active split-store preparations count until their atomic conversion to ordinary charges.
  const used = z.object({ n: z.number().int().nonnegative() }).strict().parse(store.db.prepare(`WITH RECURSIVE tree(id) AS (
    SELECT id FROM tasks WHERE id=? AND project_id=? UNION SELECT t.id FROM tasks t JOIN tree p ON json_extract(t.spec_json,'$.parentTaskId')=p.id WHERE t.project_id=?)
    SELECT COUNT(*) n FROM (SELECT c.request_id FROM request_charges c JOIN tree t ON c.task_id=t.id
      UNION SELECT h.request_id FROM project_request_holds h JOIN tree t ON h.task_id=t.id WHERE h.active=1)`).get(root.row.id, input.project, input.project)).n;
  const statusUrl = "/api/jobs/" + encodeURIComponent(input.project) + "/" + encodeURIComponent(root.row.id);
  const state = root.row.state;
  const active = members.filter(member => !isTerminal(member.row.state));
  const execution: ClientJobStatus["execution"] = !active.length ? "finished" : active.some(member => member.row.state === "cancel_requested") ? "cancelling"
    : active.some(member => member.row.state === "running") ? "running" : active.some(member => member.row.state === "interrupted") ? "interrupted" : "queued_requires_worker";
  return { object: "meritrouter.job", job_id: root.row.id, project: input.project, mode, state,
    execution,
    status_url: statusUrl, cancel_url: statusUrl + "/cancel", created_at: new Date(root.row.created_at).toISOString(), finished_at: active.length || root.row.finished_at === null ? null : new Date(Math.max(...members.map(member => member.row.finished_at ?? 0))).toISOString(),
    requests_used: used, requests_limit: pool?.cap ?? effectiveBudget(host.project(input.project), root.spec, null).maxModelRequests,
    children: members.filter(member => member.row.id !== root.row.id).slice(0, 100).map(member => ({ job_id: member.row.id, profile: member.spec.profile, state: member.row.state })),
    result: result ? { executionStatus: result.executionStatus, acceptanceStatus: result.acceptanceStatus, verificationStatus: result.verificationStatus,
      summary: result.summary.slice(0, 20000), findings: result.findings.slice(0, 100), ...(result.data === undefined ? {} : { data: result.data }), unresolvedCriteria: result.unresolvedCriteria.slice(0, 100) } : null,
  };
}
export async function submitClientJob(host: ClientJobHost, raw: ClientJobSubmission, signal?: AbortSignal): Promise<ClientJobAccepted> {
  const request = ClientJobSubmissionSchema.parse(raw);
  if (signal?.aborted) throw signal.reason;
  const cfg = host.project(request.project); settingsAllow(request, cfg); host.assertAccess(cfg);
  const store = host.store(request.project); store.assertCurrent();
  const settings = cfg.client_connections, repositories = selectedRepositories(request, cfg);
  if (request.mode === "team") host.assertTeamReady(request.project, cfg);
  const profile = request.mode === "team" ? "supervise" : settings.agent_profile;
  const mode = cfg.profiles[profile]?.mode;
  const profilePolicy = JSON.stringify(cfg.profiles[profile]);
  if (request.mode === "agent" && mode !== "read_only" && mode !== "coding") refused("invalid_agent_profile", "Select a configured read-only or coding profile for single agents.");
  const writableCandidates = repositories.filter(alias => cfg.repositoryPaths[alias]?.writable);
  const writable = mode === "coding" ? request.writable_repository ?? settings.agent_writable_repository ?? (writableCandidates.length === 1 ? writableCandidates[0] : undefined) : request.writable_repository;
  if (mode === "coding" && (!writable || !repositories.includes(writable) || !cfg.repositoryPaths[writable]?.writable)) refused("writable_repository_required", "Choose one enabled writable repository for the coding agent.");
  if (request.mode === "team" && (request.writable_repository || request.allowed_paths)) refused("unsupported_team_options", "The supervisor scopes its workers; team requests cannot set worker edit paths.");
  if (mode !== "coding" && request.mode === "agent" && (request.writable_repository || request.allowed_paths)) refused("unsupported_agent_options", "Read-only agents cannot request edit paths.");
  const token = randomBytes(32).toString("hex"), key = "connection:" + request.mode + ":" + digest(token);
  const limits = { maxModelRequests: request.budget?.max_model_requests ?? settings.agent_max_model_requests,
    timeoutSeconds: request.budget?.timeout_seconds ?? settings.agent_timeout_seconds, maxPaidUsd: request.budget?.max_paid_usd ?? settings.agent_max_paid_usd };
  const spec = WorkerTaskSchema.parse({ id: "tclientjob_" + randomUUID().replaceAll("-", ""), idempotencyKey: key, profile, goal: request.goal,
    repositoryAliases: repositories, ...(writable ? { writableRepository: writable } : {}), context: request.context ? { inlineText: request.context } : {},
    constraints: { acceptanceCriteria: request.acceptance_criteria ?? ["Complete the requested work and report the verified outcome."], ...(mode === "coding" ? { allowedPaths: safePaths(request.allowed_paths ?? ["**"]) } : {}) },
    ...(request.mode === "team" ? { supervisionScope: "subtask", ...(cfg.client_supervision.workflow === "delegated_delivery" ? { deliveryVersion: 2 } : {}) } : {}), budget: limits });
  const paths = Object.fromEntries(repositories.map(alias => [alias, { ...cfg.repositoryPaths[alias]! }]));
  await host.submit(spec, request.project, purpose(request.mode), finalSpecs => {
    if (signal?.aborted) throw signal.reason;
    store.assertCurrent();
    const fresh = new ProjectRegistry(loadConfig(host.cfg.configPath)).require(request.project);
    settingsAllow(request, fresh);
    host.assertAccess(fresh);
    if (repositories.some(alias => !fresh.client_connections.repositories.includes(alias)) ||
      fresh.client_connections.agent_profile !== settings.agent_profile || fresh.profiles[profile]?.mode !== mode ||
      fresh.client_connections.agent_writable_repository !== settings.agent_writable_repository ||
      JSON.stringify(fresh.profiles[profile]) !== profilePolicy ||
      JSON.stringify(repositories.map(alias => fresh.repositoryPaths[alias])) !== JSON.stringify(repositories.map(alias => paths[alias])))
      refused("connection_scope_changed", "Connection profile or repository scope changed during submission; retry with current settings.");
    if (limits.maxModelRequests > fresh.client_connections.agent_max_model_requests || limits.timeoutSeconds > fresh.client_connections.agent_timeout_seconds || limits.maxPaidUsd > fresh.client_connections.agent_max_paid_usd)
      refused("job_budget_exceeded", "Connection job limits changed during submission.");
    if (finalSpecs.length !== 1 || finalSpecs[0]?.id !== spec.id || finalSpecs[0]?.idempotencyKey !== key || finalSpecs[0]?.profile !== profile)
      throw new Error("Connection job submission authority changed");
    if (request.mode === "team") host.assertTeamReady(request.project, fresh);
    const count = z.object({ n: z.number().int().nonnegative() }).strict().parse(store.db.prepare(`WITH RECURSIVE owned(root,id) AS (
      SELECT id,id FROM tasks WHERE project_id=? AND purpose IN ('client_agent','client_team')
      UNION SELECT o.root,t.id FROM tasks t JOIN owned o ON json_extract(t.spec_json,'$.parentTaskId')=o.id WHERE t.project_id=?)
      SELECT COUNT(DISTINCT o.root) n FROM owned o JOIN tasks t ON t.id=o.id WHERE t.state NOT IN ${terminal}`).get(request.project, request.project));
    if (count.n >= fresh.client_connections.agent_max_active_jobs) throw new ClientConnectionError(429, "active_job_limit", "The connection's active job limit is reached; wait or cancel an owned job.");
  });
  return { ...getClientJob(host, { project: request.project, job_id: spec.id!, access_token: token }), access_token: token };
}
export async function cancelClientJob(host: ClientJobHost, input: ClientJobAccess): Promise<ClientJobStatus> {
  const { store, root } = owned(host, input);
  // The lease port is asynchronous. Fence the root first, then re-enumerate after every
  // round so a child inserted by an in-flight supervisor is captured as well. A task in
  // cancel_requested cannot acquire fresh delegation authority in the existing executor.
  await host.cancel([root.row.id], input.project);
  for (let round = 0; round < 32; round++) {
    store.assertCurrent();
    const pending = descendants(store, root).filter(member => !isTerminal(member.row.state) && member.row.state !== "cancel_requested").map(member => member.row.id);
    if (!pending.length) return getClientJob(host, input);
    for (let offset = 0; offset < pending.length; offset += 500) await host.cancel(pending.slice(offset, offset + 500), input.project);
  }
  throw new ClientConnectionError(409, "job_cancellation_pending", "Cancellation is recorded, but the job tree is still changing. Retry this job's cancellation URL.");
}
