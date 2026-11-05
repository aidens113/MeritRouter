import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { afterEach, expect, it, vi } from "vitest";
import { MeritRouter } from "../src/core/service.js";
import * as validation from "../src/core/validate.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { loadConfig } from "../src/config/load.js";
import { ClientConnectionsConfigSchema } from "../src/config/schema.js";
import { ClientConnectionsController } from "../src/connections/server.js";
import { ClientJobRequestSchema, type ClientJobAccepted, type ClientJobAccess } from "../src/connections/jobs.js";
import { clientChatJobRequest, parseClientChat } from "../src/connections/protocol.js";
import { baseConfig, makeEnv, goodOutput, reply, ScriptedClient, type Env } from "./helpers.js";

const environments: Env[] = [], services: MeritRouter[] = [], controllers: ClientConnectionsController[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(controllers.splice(0).map(controller => controller.close()));
  await Promise.allSettled(services.splice(0).map(service => service.close()));
  for (const env of environments.splice(0)) env.cleanup();
});
async function fixture(options: { layout?: "legacy" | "split"; settings?: Record<string, unknown>; config?: Record<string, unknown>; client?: ScriptedClient } = {}) {
  const base = baseConfig();
  const raw = { ...base, profiles: { ...base.profiles, supervise: { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 30, max_model_requests: 32, max_output_tokens: 2000, classify: "never", min_tier: "T3" } },
    client_connections: { enabled: true, project: "demo", enabled_modes: ["direct", "agent", "team"], repositories: ["core"], agent_profile: "inspect", ...options.settings }, ...options.config };
  const env = makeEnv({ config: raw }); environments.push(env);
  if (options.layout === "split") {
    const installation = path.join(env.dir, "installation"), project = path.join(env.dir, "project"); mkdirSync(installation); mkdirSync(project);
    const split = { ...YAML.parse(readFileSync(env.cfg.configPath, "utf8")), storage: { directory: "state", layout: "split" }, models: { file: path.join(env.dir, "models.yaml") },
      repositories: {}, projects: { demo: { directory: project, repositories: { core: { path: env.repo } } } } };
    const configPath = path.join(installation, "meritrouter.config.yaml"); writeFileSync(configPath, YAML.stringify(split)); env.cfg = loadConfig(configPath);
  }
  const client = options.client ?? new ScriptedClient(() => reply("No provider request belongs to passive submission"));
  const open = (worker = false) => { const sy = new MeritRouter(loadConfig(env.cfg.configPath), { providerFetch: client.fetch, panelLifecycle: "passive", worker, pollIntervalMs: 20 }); services.push(sy); return sy; };
  const sy = open();
  if (options.layout === "split") await sy.createSplitProject({ slug: "demo", directory: path.join(env.dir, "project") });
  const edit = (change: (raw: Record<string, any>) => void) => { const raw = YAML.parse(readFileSync(env.cfg.configPath, "utf8")); change(raw); writeFileSync(env.cfg.configPath, YAML.stringify(raw)); };
  return { sy, env, client, open, edit };
}
const request = { mode: "agent" as const, project: "demo", goal: "Inspect the supplied fixture", context: "Fixture evidence supplied by the client." };
function access(job: ClientJobAccepted): ClientJobAccess { return { project: job.project, job_id: job.job_id, access_token: job.access_token }; }
async function port(): Promise<number> { const server = createServer(); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const port = (server.address() as AddressInfo).port; await new Promise<void>(resolve => server.close(() => resolve())); return port; }
const post = (url: string, body: unknown, token?: string) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: JSON.stringify(body) });
async function listen(sy: MeritRouter) {
  const controller = new ClientConnectionsController({ dispatch: (request, signal, token) => sy.requestClientConnection(request, signal, token), jobs: {
    submit: (request, signal, token) => sy.submitClientJob(request, signal, token), get: access => sy.getClientJob(access), cancel: access => sy.cancelClientJob(access),
  } }); controllers.push(controller);
  await controller.sync({ ...sy.cfg.client_connections, port: await port() }); return { controller, url: controller.status().ollamaBaseUrl };
}

it("defaults to direct and validates explicit mode, repository and budget boundaries", () => {
  expect(ClientConnectionsConfigSchema.parse({})).toMatchObject({ enabled: false, enabled_modes: ["direct"], default_mode: "direct", agent_max_active_jobs: 2, agent_max_paid_usd: 0 });
  for (const value of [{ enabled_modes: ["direct"], default_mode: "team" }, { enabled_modes: ["direct", "direct"] }, { agent_max_active_jobs: 17 }])
    expect(ClientConnectionsConfigSchema.safeParse(value).success).toBe(false);
  expect(ClientConnectionsConfigSchema.safeParse({ enabled: true, project: null, enabled_modes: ["direct", "agent"] }).success).toBe(true);
  for (const value of [{ ...request, purpose: "work" }, { ...request, parentTaskId: "other" }, { ...request, project: "other" }, { ...request, budget: { max_model_requests: 0 } }])
    expect(ClientJobRequestSchema.safeParse(value).success).toBe(false);
});

it("enables direct with stale agent preferences, while job submission still refuses missing project/profile authority", async () => {
  const { sy, edit, client } = await fixture({ settings: { enabled: false, project: "removed-project", agent_profile: "analyze", repositories: ["removed-repository"] } });
  edit(raw => { raw.client_connections.enabled = true; delete raw.profiles.analyze; });
  const cfg = loadConfig(sy.cfg.configPath);
  expect(cfg.client_connections.enabled).toBe(true); expect(cfg.client_connections.project).toBe("removed-project");
  sy.reloadIfChanged();
  const response = await sy.requestClientConnection({ chat: { messages: [{ role: "user", content: "Global direct works" }], max_tokens: 100 } }, new AbortController().signal);
  expect(response.message.content).toContain("passive submission");
  await expect(sy.submitClientJob({ ...request, project: "removed-project" })).rejects.toThrow(/unknown project/);
  expect(sy.tasks.list()).toEqual([]); expect(client.requests).toHaveLength(1);
});

it.each(["legacy", "split"] as const)("persists %s ownership across restart, never stores the bearer token, and leaves jobs durable when disabled", async layout => {
  const { sy, env, open, edit, client } = await fixture({ layout });
  const job = await sy.submitClientJob(request);
  expect(job).toMatchObject({ object: "meritrouter.job", mode: "agent", state: "queued", execution: "queued_requires_worker", requests_used: 0 });
  const store = sy.projectStores("demo"), row = store.db.prepare("SELECT * FROM tasks WHERE id=?").get(job.job_id);
  expect(JSON.stringify(row)).not.toContain(job.access_token); expect(row).toMatchObject({ purpose: "client_agent", project_id: "demo" });
  expect(store.tasks.get(job.job_id)!.spec).toMatchObject({ profile: "inspect", repositoryAliases: ["core"], budget: { maxPaidUsd: 0, timeoutSeconds: 1200 } });
  await sy.close(); edit(raw => { raw.client_connections.enabled = false; });
  const restarted = open();
  expect(restarted.getClientJob(access(job))).toMatchObject({ state: "queued", execution: "queued_requires_worker" });
  expect(JSON.stringify(restarted.getClientJob(access(job)))).not.toContain(job.access_token);
  await expect(restarted.submitClientJob(request)).rejects.toMatchObject({ code: "connection_mode_disabled" });
  expect(await restarted.cancelClientJob(access(job))).toMatchObject({ state: "cancelled", execution: "finished", result: { acceptanceStatus: "not_verified" } });
  expect(client.requests).toHaveLength(0);
  expect(env.cfg.storageDir).not.toContain("D:\\MeritRouter\\");
});

it("refuses wrong tokens, cross-project access and ordinary-task provenance", async () => {
  const { sy } = await fixture({ config: { repositories: {}, projects: { demo: { repositories: { core: { path: "repo" } } }, other: { repositories: { core: { path: "repo" } } } } } });
  const job = await sy.submitClientJob(request);
  expect(() => sy.getClientJob({ ...access(job), access_token: "0".repeat(64) })).toThrow(/No connection-owned job/);
  expect(() => sy.getClientJob({ ...access(job), project: "other" })).toThrow(/No connection-owned job/);
  const before = sy.tasks.get(job.job_id)!.row.state;
  await expect(sy.cancelClientJob({ ...access(job), access_token: "0".repeat(64) })).rejects.toThrow(/No connection-owned job/);
  expect(sy.tasks.get(job.job_id)!.row.state).toBe(before);
  sy.db.prepare("UPDATE tasks SET purpose='work' WHERE id=?").run(job.job_id);
  expect(() => sy.getClientJob(access(job))).toThrow(/No connection-owned job/);
});

it("enforces the durable active-root cap atomically across concurrent submissions", async () => {
  const { sy, client } = await fixture({ settings: { agent_max_active_jobs: 1 } });
  const results = await Promise.allSettled([sy.submitClientJob(request), sy.submitClientJob(request)]);
  expect(results.filter(value => value.status === "fulfilled")).toHaveLength(1);
  expect((results.find(value => value.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "active_job_limit", status: 429 });
  expect(sy.listTasks()).toHaveLength(1); expect(client.requests).toHaveLength(0);
});

it("infers the sole writable repository among read-only context and accepts an explicit saved default", async () => {
  const config = { repositories: { core: { path: "repo" }, docs: { path: "repo", writable: false } } };
  const { sy, edit } = await fixture({ settings: { agent_profile: "implement", repositories: ["core", "docs"] }, config });
  const job = await sy.submitClientJob(request);
  expect(sy.tasks.get(job.job_id)!.spec).toMatchObject({ repositoryAliases: ["core", "docs"], writableRepository: "core", constraints: { allowedPaths: ["**"] } });
  await sy.cancelClientJob(access(job));
  edit(raw => { raw.repositories.docs.writable = true; raw.client_connections.agent_writable_repository = "docs"; }); sy.reloadIfChanged();
  const explicit = await sy.submitClientJob(request);
  expect(sy.tasks.get(explicit.job_id)!.spec.writableRepository).toBe("docs");
});

it("refuses ambiguous coding repositories and writable/path scope outside the saved allowlist", async () => {
  const { sy } = await fixture({ settings: { agent_profile: "implement", repositories: ["core", "other"] }, config: { repositories: { core: { path: "repo" }, other: { path: "repo" } } } });
  await expect(sy.submitClientJob(request)).rejects.toMatchObject({ code: "writable_repository_required" });
  await expect(sy.submitClientJob({ ...request, writable_repository: "outside" })).rejects.toMatchObject({ code: "writable_repository_required" });
  await expect(sy.submitClientJob({ ...request, writable_repository: "core", allowed_paths: ["../outside"] })).rejects.toMatchObject({ code: "invalid_allowed_paths" });
  expect(sy.listTasks()).toHaveLength(0);
});

it.each(["disabled", "repository", "profile_mode", "request_budget", "timeout_budget", "paid_budget"] as const)("refuses %s revocation after asynchronous validation without inserting or spending", async kind => {
  const { sy, edit, client } = await fixture({ settings: { agent_max_paid_usd: kind === "paid_budget" ? 1 : 0 }, config: kind === "paid_budget" ? { paid: { enabled: true, budgets: { per_week_usd: 1 } } } : {} });
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const original = validation.validateTask;
  vi.spyOn(validation, "validateTask").mockImplementationOnce(async (...args) => { const result = await original(...args); enter(); await held; return result; });
  const pending = sy.submitClientJob({ ...request, ...(kind === "paid_budget" ? { budget: { max_paid_usd: 1 } } : {}) });
  const rejection = expect(pending).rejects.toThrow();
  await entered;
  edit(raw => {
    if (kind === "disabled") raw.client_connections.enabled = false;
    if (kind === "repository") { raw.repositories.other = { path: "repo" }; raw.client_connections.repositories = ["other"]; }
    if (kind === "profile_mode") { raw.profiles.inspect.mode = "coding"; raw.profiles.inspect.tools = "scoped_edit_and_checks"; }
    if (kind === "request_budget") raw.client_connections.agent_max_model_requests = 1;
    if (kind === "timeout_budget") raw.client_connections.agent_timeout_seconds = 1;
    if (kind === "paid_budget") raw.client_connections.agent_max_paid_usd = 0;
  });
  release(); await rejection;
  expect(sy.listTasks()).toHaveLength(0); expect(client.requests).toHaveLength(0);
});

it.each(["missing_proof", "automatic_qualification"] as const)("refuses team %s before qualification intents, tasks or transport", async kind => {
  const { sy, client } = await fixture({ config: { supervisor: { routing: kind === "missing_proof" ? { minimum_quality: "frontier_or_qualified_supervisor", quality_evidence: [] } : { minimum_quality: "ranked_capable" } } } });
  const preflight = vi.spyOn(sy.supervisorQualifier, "preflight");
  await expect(sy.submitClientJob({ ...request, mode: "team" })).rejects.toMatchObject({ code: "supervisor_qualification_required" });
  expect(preflight).not.toHaveBeenCalled(); expect(sy.listTasks()).toHaveLength(0); expect(client.requests).toHaveLength(0);
  expect(sy.db.prepare("SELECT key FROM meta WHERE key LIKE 'supervisor-submission:%'").all()).toEqual([]);
  expect(sy.projectStores("demo").db.prepare("SELECT id FROM artifacts WHERE kind='supervisor_submission'").all()).toEqual([]);
});

it("accepts an already proven team as a bounded supervisor and never invokes automatic qualification", async () => {
  const { sy, client } = await fixture();
  const preflight = vi.spyOn(sy.supervisorQualifier, "preflight");
  const job = await sy.submitClientJob({ ...request, mode: "team" });
  expect(job).toMatchObject({ mode: "team", state: "queued", execution: "queued_requires_worker" });
  expect(sy.tasks.get(job.job_id)!.spec).toMatchObject({ profile: "supervise", supervisionScope: "subtask", budget: { maxModelRequests: 32, maxPaidUsd: 0 } });
  expect(preflight).not.toHaveBeenCalled(); expect(client.requests).toHaveLength(0);
});

it("refuses a supervisor qualification policy revoked while task validation awaits", async () => {
  const { sy, edit, client } = await fixture();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const original = validation.validateTask;
  vi.spyOn(validation, "validateTask").mockImplementationOnce(async (...args) => { const result = await original(...args); enter(); await held; return result; });
  const pending = sy.submitClientJob({ ...request, mode: "team" }); const rejection = expect(pending).rejects.toMatchObject({ code: "supervisor_qualification_required" });
  await entered; edit(raw => { raw.supervisor.routing = { minimum_quality: "ranked_capable" }; }); release(); await rejection;
  expect(sy.listTasks()).toHaveLength(0); expect(client.requests).toHaveLength(0);
  expect(sy.db.prepare("SELECT key FROM meta WHERE key LIKE 'supervisor-submission:%'").all()).toEqual([]);
});

it("cancels raced descendants through the durable lease port and preserves unrelated tasks", async () => {
  const { sy } = await fixture();
  const job = await sy.submitClientJob({ ...request, mode: "team" });
  const child = WorkerTaskSchema.parse({ id: "raced-child", profile: "inspect", parentTaskId: job.job_id, goal: "Owned child", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["Inspect"] } });
  const unrelated = WorkerTaskSchema.parse({ ...child, id: "unrelated", parentTaskId: undefined }); sy.tasks.submit([unrelated], { project: "demo" });
  const original = sy.cancelTasksAsync.bind(sy); let inserted = false;
  vi.spyOn(sy, "cancelTasksAsync").mockImplementation(async (ids, project) => {
    const result = await original(ids, project);
    if (!inserted) { inserted = true; sy.tasks.submit([child], { project: "demo" }); }
    return result;
  });
  expect(await sy.cancelClientJob(access(job))).toMatchObject({ state: "cancelled", children: [{ job_id: "raced-child", state: "cancelled" }] });
  expect(sy.tasks.get("raced-child")!.row.state).toBe("cancelled"); expect(sy.tasks.get("unrelated")!.row.state).toBe("queued");
});

it("refuses a legacy delegation whose validation completes after cancellation's final sweep", async () => {
  const { sy } = await fixture(), job = await sy.submitClientJob({ ...request, mode: "team" });
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const original = validation.validateTask;
  vi.spyOn(validation, "validateTask").mockImplementationOnce(async (...args) => { const result = await original(...args); enter(); await held; return result; });
  const pending = sy.submitTasks([{ id: "late-delegation", profile: "inspect", parentTaskId: job.job_id, goal: "Late delegated work", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["Done"] } }], { project: "demo" });
  const rejection = expect(pending).rejects.toMatchObject({ code: "job_delegation_cancelled" });
  await entered; expect((await sy.cancelClientJob(access(job))).execution).toBe("finished"); release(); await rejection;
  expect(sy.tasks.get("late-delegation")).toBeUndefined();
});

it.each(["queued", "running", "cancel_requested", "interrupted"] as const)("holds the active cap for a terminal root with a %s descendant", async childState => {
  const { sy } = await fixture({ settings: { agent_max_active_jobs: 1 } }), job = await sy.submitClientJob({ ...request, mode: "team" });
  sy.tasks.submit([WorkerTaskSchema.parse({ id: "active-orphan", parentTaskId: job.job_id, profile: "inspect", goal: "Owned child", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["Done"] } })], { project: "demo" });
  sy.db.prepare("UPDATE tasks SET state='budget_exhausted',finished_at=? WHERE id=?").run(Date.now(), job.job_id);
  sy.db.prepare("UPDATE tasks SET state=? WHERE id='active-orphan'").run(childState);
  const status = sy.getClientJob(access(job)); expect(status.state).toBe("budget_exhausted"); expect(status.execution).not.toBe("finished"); expect(status.finished_at).toBeNull();
  await expect(sy.submitClientJob(request)).rejects.toMatchObject({ code: "active_job_limit" });
  const cancelling = await sy.cancelClientJob(access(job));
  if (childState === "running" || childState === "cancel_requested") {
    expect(cancelling.execution).toBe("cancelling");
    await expect(sy.submitClientJob(request)).rejects.toMatchObject({ code: "active_job_limit" });
    sy.db.prepare("UPDATE tasks SET state='cancelled',finished_at=? WHERE id='active-orphan'").run(Date.now());
  } else expect(cancelling.execution).toBe("finished");
  await expect(sy.submitClientJob(request)).resolves.toHaveProperty("job_id");
});

it("counts distinct physical charges across the owned tree without treating unused grants as spent", async () => {
  const { sy } = await fixture(), job = await sy.submitClientJob({ ...request, mode: "team" });
  sy.tasks.submit([WorkerTaskSchema.parse({ id: "charged-child", parentTaskId: job.job_id, profile: "inspect", goal: "Owned", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["done"] } })], { project: "demo" });
  const execution = sy.admission.createExecution("task", "supervise", [{ taskId: job.job_id, itemId: job.job_id }]);
  for (const id of ["one", "two"]) sy.db.prepare("INSERT INTO model_requests(id,execution_id,purpose,gateway_model,status,reserved_at,est_input_tokens,reserved_output_tokens) VALUES(?,?,'execution','test','succeeded',?,0,0)").run(id, execution, Date.now());
  for (const [id, task] of [["one", job.job_id], ["one", "charged-child"], ["two", "charged-child"]]) sy.db.prepare("INSERT INTO request_charges(request_id,task_id,input_tokens,output_tokens) VALUES(?,?,0,0)").run(id, task);
  expect(sy.getClientJob(access(job)).requests_used).toBe(2);
});

it("lists only enabled aliases, acknowledges async chats, enforces Bearer ownership and cancels through HTTP", async () => {
  const { sy, client } = await fixture({ settings: { enabled_modes: ["direct", "agent"], default_mode: "agent" } }), { url } = await listen(sy);
  const models = await (await fetch(url + "/v1/models")).json() as { data: Array<{ id: string }> };
  expect(models.data.map(value => value.id)).toEqual(["meritrouter", "meritrouter-direct", "meritrouter-agent"]);
  const rejected = await post(url + "/v1/chat/completions", { model: "meritrouter-team", messages: [{ role: "user", content: "Do it" }] }); expect(rejected.status).toBe(400);
  const created = await post(url + "/v1/chat/completions", { model: "meritrouter", messages: [{ role: "system", content: "Preserve this client context exactly" }, { role: "user", content: "Inspect the fixture" }] });
  expect(created.status).toBe(200);
  const ack = await created.json() as { model: string; choices: Array<{ message: { content: string } }> };
  expect(ack.model).toBe("meritrouter"); const job = JSON.parse(ack.choices[0]!.message.content) as ClientJobAccepted;
  expect(job).toMatchObject({ object: "meritrouter.job", state: "queued", execution: "queued_requires_worker" });
  expect(sy.tasks.get(job.job_id)!.spec.context.inlineText).toContain("Preserve this client context exactly");
  expect((await fetch(url + job.status_url)).status).toBe(401);
  expect((await fetch(url + job.status_url, { headers: { authorization: "Bearer " + "0".repeat(64) } })).status).toBe(404);
  const status = await (await fetch(url + job.status_url, { headers: { authorization: "Bearer " + job.access_token } })).json();
  expect(status).not.toHaveProperty("access_token"); expect(JSON.stringify(status)).not.toContain("Preserve this client context exactly");
  const cancelled = await post(url + job.cancel_url, {}, job.access_token); expect(cancelled.status).toBe(200); expect(await cancelled.json()).toMatchObject({ state: "cancelled" });
  const direct = await post(url + "/api/jobs", { mode: "agent", goal: "Dedicated job" }); expect(direct.status).toBe(202);
  expect(client.requests).toHaveLength(0);
});

it("rejects caller tools, tool history, images and generation constraints in agent aliases", () => {
  const config = ClientConnectionsConfigSchema.parse({ enabled: true, project: "demo", enabled_modes: ["direct", "agent"], repositories: ["core"] });
  const base = { model: "meritrouter-agent", messages: [{ role: "user", content: "Do work" }] };
  for (const extra of [{ max_tokens: 10 }, { temperature: 0.2 }, { tools: [{ type: "function", function: { name: "tool", parameters: { type: "object" } } }] }, { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.test/image.png" } }] }] }])
    expect(() => parseClientChat("/v1/chat/completions", { ...base, ...extra }, config)).toThrow();
  const parsed = parseClientChat("/v1/chat/completions", base, config); expect(clientChatJobRequest(parsed)).toMatchObject({ mode: "agent", goal: "Do work" });
});

it.each(["legacy", "split"] as const)("keeps passive %s panel jobs queued until a separate existing worker executes real fake completion", async layout => {
  const client = new ScriptedClient(req => reply(null, { model: req.model, provider: req.provider, toolCalls: [{ id: "result", type: "function", function: { name: "submit_result", arguments: JSON.stringify(goodOutput()) } }] }));
  const { sy, open } = await fixture({ layout, client });
  const job = await sy.submitClientJob(request);
  // A passive host can accept/cancel other jobs without starting dispatch.
  const cancelled = await sy.submitClientJob(request); await sy.cancelClientJob(access(cancelled));
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(sy.getClientJob(access(job)).state).toBe("queued"); expect(client.requests).toHaveLength(0);
  const worker = open(true);
  const finished = await worker.awaitResults([job.job_id], { timeoutSeconds: 30, project: "demo" });
  expect(finished.timedOut, JSON.stringify(worker.getStatus([job.job_id], "demo"))).toBe(false);
  const status = sy.getClientJob(access(job));
  expect(status.execution).toBe("finished"); expect(status.state).toBe("completed"); expect(status.requests_used).toBeGreaterThan(0);
  expect(status.result).toMatchObject({ executionStatus: "completed" });
  expect(client.requests.length).toBeGreaterThan(0);
  expect(client.requests.some(req => req.messages.some(message => typeof message.content === "string" && message.content.includes("Fixture evidence supplied by the client.")))).toBe(true);
}, 45000);

it("executes an accepted bounded team with the existing supervisor runner and reports acceptance separately", async () => {
  const client = new ScriptedClient(req => reply(null, { model: req.model, provider: req.provider, toolCalls: [{ id: "finish", type: "function", function: { name: "finish_job", arguments: JSON.stringify({ status: "completed", summary: "Bounded report complete; human acceptance remains outstanding", verified: [{ claim: "Received fixture context", evidence: "The client supplied: Fixture evidence supplied by the client." }], not_verified: ["Final project acceptance"] }) } }] }));
  const { sy, open } = await fixture({ client }), job = await sy.submitClientJob({ ...request, mode: "team" });
  const worker = open(true);
  const finished = await worker.awaitResults([job.job_id], { timeoutSeconds: 40, project: "demo" });
  expect(finished.timedOut, JSON.stringify(worker.getStatus([job.job_id], "demo"))).toBe(false);
  const status = sy.getClientJob(access(job));
  expect(status.execution).toBe("finished"); expect(status.state).toBe("completed"); expect(status.result).not.toBeNull(); expect(status.requests_used).toBeGreaterThan(0);
  expect(status.result!.summary).toContain("human acceptance remains outstanding");
  expect(status.result!.acceptanceStatus).not.toBe("met");
  expect(client.requests.some(req => String(req.messages[0]?.content).includes("Bounded delegated subtask"))).toBe(true);
}, 55000);
