import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { afterEach, expect, it, vi } from "vitest";
import { MeritRouter } from "../src/core/service.js";
import type { ProjectRuntimeHost } from "../src/core/project-runtime-host.js";
import type { ProjectRuntimeBundle } from "../src/projects/runtime-registry.js";
import { loadConfig } from "../src/config/load.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { AdmissionDenied } from "../src/core/errors.js";
import { effectiveBudget } from "../src/admission/admission.js";
import { physicalRequestCount } from "../src/admission/accounting-usage.js";
import { ClientConnectionRequestSchema } from "../src/connections/protocol.js";
import type { GateRequest } from "../src/gateway/gate.js";
import { capturedLease, leaseOperationId, receiptApplied } from "../src/storage/task-leases.js";
import { syntheticResult } from "../src/storage/tasks.js";
import { baseConfig, directEndpoint, FakeProvider, makeEnv, providerChat, providerJson, type Env, type FakeProviderHandler } from "./helpers.js";

const services: MeritRouter[] = [], environments: Env[] = [], releases: Array<() => void> = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.all(services.splice(0).map(service => service.close()));
  vi.restoreAllMocks();
  for (const env of environments.splice(0)) env.cleanup();
});
type Layout = "legacy" | "split";
type PaidMode = "free" | "never" | "zero_budget" | "allowed";
interface Fixture { sy: MeritRouter; env: Env; fake: FakeProvider; layout: Layout }
interface Options {
  layout?: Layout; project?: boolean; allocation?: Record<string, number>; paid?: PaidMode;
  singleSlot?: boolean; handler?: FakeProviderHandler; token?: string; projectLimits?: Record<string, unknown>;
}
const TOKEN = "ab".repeat(32);
const request = () => ClientConnectionRequestSchema.parse({ chat: { messages: [{ role: "user", content: "A global caller supplies this conversation." }], max_tokens: 128 } });
const profiles = {
  inspect: { mode: "read_only", min_total_parameters_b: 30, max_model_requests: 8, max_output_tokens: 2000, tools: "repository_read", classify: "never" },
  implement: { mode: "coding", min_total_parameters_b: 100, max_model_requests: 8, max_output_tokens: 2000, tools: "scoped_edit_and_checks", workspace: "isolated_worktree" },
};
async function fixture(options: Options = {}): Promise<Fixture> {
  const layout = options.layout ?? "split", paid = options.paid ?? "free", priced = paid !== "free";
  const raw: Record<string, unknown> = baseConfig({
    storage: { directory: "installation-state", layout }, repositories: {}, projects: {}, profiles,
    providers: { acme: { base_url: "https://api.acme.test/v1", keys: [{ api_key: "test-global-key", billing_class: priced ? "paid_credits" : "free_tier" }] } },
    client_connections: { enabled: true, enabled_modes: ["direct"], default_mode: "direct", max_output_tokens: 128, request_timeout_seconds: 30,
      ...(options.token ? { host: "0.0.0.0", access_token_hash: createHash("sha256").update(options.token).digest("hex") } : {}) },
    ...(options.allocation ? { allocation: options.allocation } : {}),
    ...(options.singleSlot ? { team: { provider_concurrency_start: 1, provider_concurrency_max: 1 } } : {}),
    paid: { enabled: priced, budgets: { per_day_usd: paid === "zero_budget" ? 0 : 1, per_week_usd: 1 },
      tiers: { T1: paid === "never" || !priced ? "never" : "on_free_exhaustion", T2: "never", T3: "never", T4: "never" }, max_paid_attempts: 1 },
  });
  const env = makeEnv({ config: raw, endpoints: [directEndpoint("acme", "fixture", { totalParametersB: 120,
    ...(priced ? { pricing: { freeVerified: false, inputUsdPerMillion: 2, outputUsdPerMillion: 8, source: "manual" } } : {}),
  })] }); environments.push(env);
  let configPath = env.cfg.configPath;
  if (options.project) {
    const installation = path.join(env.dir, "installation"), directory = path.join(env.dir, "project");
    mkdirSync(installation); mkdirSync(directory);
    raw.models = { file: path.join(env.dir, "models.yaml") };
    raw.brain = { path: "brain", project: "alpha" };
    raw.projects = { alpha: { directory, repositories: {}, ...options.projectLimits } };
    configPath = path.join(installation, "meritrouter.config.yaml"); writeFileSync(configPath, YAML.stringify(raw));
  }
  const fake = new FakeProvider(options.handler ?? (call => providerChat(String(call.body?.model), { content: "global response" })));
  const sy = new MeritRouter(loadConfig(configPath), { worker: false, panelLifecycle: "passive", providerFetch: fake.fetch }); services.push(sy);
  if (options.project && layout === "split") await sy.createSplitProject({ slug: "alpha", directory: path.join(env.dir, "project") });
  expect(sy.cfg.profiles.summarize).toBeUndefined();
  expect(Object.values(sy.cfg.profiles).some(profile => profile?.mode === "completion")).toBe(false);
  return { sy, env, fake, layout };
}
function grants(f: Fixture) { return f.sy.db.prepare("SELECT * FROM project_execution_grants ORDER BY rowid").all(); }
function projectRows(f: Fixture) { return f.sy.db.prepare("SELECT * FROM projects ORDER BY rowid").all(); }
function expectTaskless(f: Fixture, beforeProjects: unknown[]) {
  expect(f.sy.db.prepare("SELECT COUNT(*) n FROM tasks").get()).toEqual({ n: 0 });
  expect(f.sy.db.prepare("SELECT COUNT(*) n FROM execution_members").get()).toEqual({ n: 0 });
  expect(f.sy.db.prepare("SELECT COUNT(*) n FROM request_charges").get()).toEqual({ n: 0 });
  expect(projectRows(f)).toEqual(beforeProjects);
  expect(grants(f)).toEqual([]);
  expect(f.sy.db.prepare("SELECT COUNT(*) n FROM project_store_registrations").get()).toEqual({ n: 0 });
}
async function projectRequest(f: Fixture) {
  const local = f.sy.projectStores("alpha") as ProjectRuntimeBundle;
  const host = (f.sy as unknown as { host: ProjectRuntimeHost }).host, queue = host.bindings.forProject(local.identity);
  const spec = WorkerTaskSchema.parse({ id: "project-request", profile: "inspect", goal: "Independent project request", constraints: { acceptanceCriteria: ["Return a fixture answer"] }, budget: { maxModelRequests: 4, timeoutSeconds: 60 } });
  local.tasks.submit([spec], { project: "alpha" });
  const claimed = await queue.claimTurn({ owner: f.sy.owner }, [queue.hint()!]);
  expect(claimed).toHaveLength(1); expect(queue.authorizeStart(claimed)).toBe("fresh");
  const lease = capturedLease(local.tasks.get(spec.id!)!), executionId = local.admission.createExecution("task", "inspect", [{ taskId: lease.taskId, itemId: "project" }]);
  const value: GateRequest = { plan: local.router.plan("inspect", "T1", ["text"]), executionId, purpose: "global-quota-fixture",
    participants: [{ taskId: lease.taskId, leaseOwner: lease.owner, lease, budget: effectiveBudget(local.cfg, spec, "T1") }],
    chat: { messages: [{ role: "user", content: "A private project conversation." }], max_tokens: 128 } };
  const finish = async (state: "completed" | "failed") => {
    local.admission.setMemberOutcome(executionId, lease.taskId, state); local.admission.finishExecution(executionId, state);
    const result = syntheticResult(lease.taskId, state, "fixture_done");
    result.usage.modelRequests = local.admission.taskTotals(lease.taskId).requests;
    const receipt = await queue.taskLeases.finish({ lease, operationId: leaseOperationId(Date.now()), state, result });
    expect(receiptApplied(receipt)).toBe(true); await queue.taskLeases.drain();
  };
  return { local, value, finish };
}
function barrier() {
  let release!: () => void, enter!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { enter = resolve; });
  releases.push(release); return { release, enter, held, entered };
}

it("refuses caller-supplied project, profile and host proof instead of converting them into authority", () => {
  for (const extra of [{ project: "alpha" }, { profile: "summarize" }, { installationExecution: { executionId: "forged", owner: "caller", nonce: "a".repeat(32), deadlineAt: Date.now() + 10000 } }])
    expect(ClientConnectionRequestSchema.safeParse({ ...request(), ...extra }).success).toBe(false);
});

it.each([["hour", "direct"], ["hour", "project"], ["day", "direct"], ["day", "project"]] as const)("shares the last %s quota reservation across direct/project ledgers when %s dispatches first", async (window, first) => {
  const allocation = { [window === "hour" ? "max_model_requests_per_hour" : "max_model_requests_per_day"]: 1 };
  const f = await fixture({ project: true, allocation }), p = await projectRequest(f);
  const direct = () => f.sy.requestClientConnection(request(), new AbortController().signal);
  try {
    if (first === "direct") {
      await direct();
      const denied = await p.local.gate.request(p.value).catch((error: unknown) => error);
      expect(denied).toBeInstanceOf(AdmissionDenied);
      expect(denied).toMatchObject({ reason: "project_allocation_exhausted" });
      const refusalState = {
        slots: f.sy.db.prepare("SELECT id,platform,kind,task_id,uncertain,project_uuid,lease_json,nonce FROM provider_slots WHERE kind='request'").all(),
        localProtocol: p.local.db.prepare("SELECT phase,dispatch_id,transport_consumed,reason_code FROM project_request_protocol ORDER BY rowid").all(),
        globalReceipts: f.sy.db.prepare("SELECT id,status,dispatch_id FROM physical_requests ORDER BY rowid").all(),
        localRequests: p.local.db.prepare("SELECT id,status FROM model_requests ORDER BY rowid").all(),
      };
      expect(refusalState.slots, JSON.stringify(refusalState)).toEqual([]);
      expect(refusalState.localProtocol).toEqual([{ phase: "retired", dispatch_id: null, transport_consumed: 0, reason_code: "never_globally_admitted" }]);
      expect(refusalState.globalReceipts).toEqual([]);
      expect(refusalState.localRequests).toEqual([]);
      expect(p.local.db.prepare("SELECT COUNT(*) n FROM project_request_holds WHERE active=1").get()).toEqual({ n: 0 });
    } else {
      await p.local.gate.request(p.value);
      await expect(direct()).rejects.toMatchObject({ reason: window === "hour" ? "package_hourly_allocation_exhausted" : "package_daily_allocation_exhausted" });
    }
    expect(f.fake.chats()).toHaveLength(1);
    expect(physicalRequestCount(f.sy.db, Date.now() - 86400000)).toBe(1);
    expect(f.sy.db.prepare("SELECT COUNT(*) n FROM model_requests").get()).toEqual({ n: first === "direct" ? 1 : 0 });
    expect(f.sy.db.prepare("SELECT COUNT(*) n FROM physical_requests").get()).toEqual({ n: first === "project" ? 1 : 0 });
    expect(f.sy.db.prepare("SELECT COUNT(*) n FROM tasks").get()).toEqual({ n: 0 });
    expect(p.local.db.prepare("SELECT COUNT(*) n FROM tasks").get()).toEqual({ n: 1 });
  } finally { await p.finish(first === "project" ? "completed" : "failed"); }
});

it("counts ten global direct requests globally without exhausting a project's untouched ten-request share", async () => {
  const f = await fixture({ project: true, allocation: { max_model_requests_per_hour: 100 }, projectLimits: { request_share: 0.1 } });
  for (let index = 0; index < 10; index++) await f.sy.requestClientConnection(request(), new AbortController().signal);
  const local = f.sy.projectStores("alpha") as ProjectRuntimeBundle;
  expect(physicalRequestCount(f.sy.db, 0)).toBe(10);
  expect(physicalRequestCount(f.sy.db, 0, local.identity.projectId)).toBe(0);
  expect(local.db.prepare("SELECT COUNT(*) n FROM model_requests").get()).toEqual({ n: 0 });
  const p = await projectRequest(f);
  try {
    await p.local.gate.request(p.value);
    expect(f.fake.chats()).toHaveLength(11);
    expect(physicalRequestCount(f.sy.db, 0)).toBe(11);
    expect(physicalRequestCount(f.sy.db, 0, local.identity.projectId)).toBe(1);
    expect(f.sy.db.prepare("SELECT COUNT(*) n FROM model_requests").get()).toEqual({ n: 10 });
    expect(f.sy.db.prepare("SELECT COUNT(*) n FROM physical_requests").get()).toEqual({ n: 1 });
  } finally { await p.finish("completed"); }
});

it("keeps direct paid spend in global/key caps while leaving a project's individual paid window untouched", async () => {
  const f = await fixture({ project: true, paid: "allowed", projectLimits: { paid_budgets: { per_day_usd: 0.0015 } } });
  for (let index = 0; index < 3; index++) await f.sy.requestClientConnection(request(), new AbortController().signal);
  const local = f.sy.projectStores("alpha") as ProjectRuntimeBundle;
  expect(f.sy.spend.windowSpend(0)).toBeCloseTo(0.0018, 8);
  expect(f.sy.spend.keySpendSince("config:acme:literal:0", 0)).toBeCloseTo(0.0018, 8);
  expect(f.sy.spend.projectAccountingSpendSince(local.identity.projectId, 0)).toBe(0);
  expect(f.sy.spend.globalDenial(0.999)).toMatch(/daily paid budget/);
  const p = await projectRequest(f);
  try {
    await p.local.gate.request(p.value);
    expect(f.fake.chats()).toHaveLength(4);
    expect(f.sy.spend.projectAccountingSpendSince(local.identity.projectId, 0)).toBeCloseTo(0.0006, 8);
    expect(f.sy.spend.windowSpend(0)).toBeCloseTo(0.0024, 8);
    expect(f.sy.spend.keySpendSince("config:acme:literal:0", 0)).toBeCloseTo(0.0024, 8);
    expect(f.sy.spend.globalDenial(0.998)).toMatch(/daily paid budget/);
    expect(f.sy.db.prepare("SELECT COUNT(*) n FROM paid_spend").get()).toEqual({ n: 3 });
    expect(f.sy.db.prepare("SELECT COUNT(*) n FROM broker_paid_spend").get()).toEqual({ n: 1 });
  } finally { await p.finish("completed"); }
});

it("shares a held provider slot with a real project request and never borrows or mutates its execution grant", async () => {
  const held = barrier(); let calls = 0;
  const f = await fixture({ project: true, singleSlot: true, handler: async call => {
    if (++calls === 1) { held.enter(); await held.held; }
    return providerChat(String(call.body?.model), { content: "held fixture" });
  } }), p = await projectRequest(f), originalGrants = grants(f);
  const projectRun = p.local.gate.request(p.value);
  let directRun: ReturnType<MeritRouter["requestClientConnection"]> | undefined;
  try {
    await Promise.race([held.entered, projectRun.then(() => { throw new Error("Project transport completed before the fixture hold"); })]);
    directRun = f.sy.requestClientConnection(request(), new AbortController().signal);
    await vi.waitFor(() => expect(f.sy.db.prepare("SELECT COUNT(*) n FROM executions WHERE profile='direct' AND status='running'").get()).toEqual({ n: 1 }), { timeout: 5000 });
    expect(f.fake.chats()).toHaveLength(1);
    expect(f.sy.health.capacity.usage("acme").requests).toBe(1);
    expect(grants(f)).toEqual(originalGrants);
    held.release(); await projectRun; await directRun;
    expect(f.fake.chats()).toHaveLength(2);
    expect(grants(f)).toEqual(originalGrants);
    expect(physicalRequestCount(f.sy.db, 0)).toBe(2);
    expect(f.sy.db.prepare("SELECT COUNT(*) n FROM provider_slots WHERE kind='request'").get()).toEqual({ n: 0 });
  } finally { held.release(); await Promise.allSettled([projectRun, ...(directRun ? [directRun] : [])]); await p.finish("completed"); }
});

it("captures a live installation-only host proof and keeps project Gate participant requirements strict", async () => {
  const held = barrier();
  const f = await fixture({ project: true, handler: async call => { held.enter(); await held.held; return providerChat(String(call.body?.model)); } });
  const local = f.sy.projectStores("alpha") as ProjectRuntimeBundle, beforeGrants = grants(f), beforeTasks = local.db.prepare("SELECT * FROM tasks").all();
  const directRun = f.sy.requestClientConnection(request(), new AbortController().signal);
  try {
    await Promise.race([held.entered, directRun.then(() => { throw new Error("Direct transport completed before the fixture hold"); })]);
    const row = f.sy.db.prepare("SELECT id,profile,status,detail_json FROM executions WHERE profile='direct'").get() as { id: string; profile: string; status: string; detail_json: string };
    const detail = JSON.parse(row.detail_json) as { scope: string; executionId: string; owner: string; nonce: string; deadlineAt: number };
    expect(row.status).toBe("running"); expect(detail.scope).toBe("client_connection"); expect(detail.executionId).toBe(row.id);
    expect(detail.owner.startsWith(hostname() + ":" + process.pid + ":")).toBe(true);
    expect(detail.nonce).toMatch(/^[a-f0-9]{32}$/); expect(detail.deadlineAt).toBeGreaterThan(Date.now());
    expect(f.sy.db.prepare("SELECT holder,task_id,lease_owner,project_uuid,execution_grants_json FROM provider_slots WHERE kind='request'").get()).toEqual({
      holder: "installation_" + row.id + "_" + detail.nonce, task_id: "", lease_owner: null, project_uuid: null, execution_grants_json: null,
    });
    expect(grants(f)).toEqual(beforeGrants); expect(local.db.prepare("SELECT * FROM tasks").all()).toEqual(beforeTasks);
    await expect(local.gate.request({ plan: local.router.plan("inspect", "T1", ["text"]), executionId: row.id, purpose: "client_connection",
      installationExecution: { executionId: detail.executionId, owner: detail.owner, nonce: detail.nonce, deadlineAt: detail.deadlineAt }, participants: [], chat: request().chat })).rejects.toThrow();
    expect(f.fake.chats()).toHaveLength(1); expect(local.db.prepare("SELECT COUNT(*) n FROM model_requests").get()).toEqual({ n: 0 });
  } finally { held.release(); await directRun; }
  expect(grants(f)).toEqual(beforeGrants);
});

it("rechecks captured host authority after awaited reservation without dispatching or discarding the admitted row", async () => {
  const f = await fixture(), original = f.sy.gate.ledger.reserve.bind(f.sy.gate.ledger);
  vi.spyOn(f.sy.gate.ledger, "reserve").mockImplementationOnce(async value => {
    const reserved = await original(value);
    f.sy.db.prepare("UPDATE executions SET detail_json=json_set(detail_json,'$.nonce',?) WHERE id=?").run("0".repeat(32), value.executionId);
    return reserved;
  });
  await expect(f.sy.requestClientConnection(request(), new AbortController().signal)).rejects.toBeInstanceOf(Error);
  expect(f.fake.chats()).toHaveLength(0);
  expect(f.sy.db.prepare("SELECT COUNT(*) n FROM model_requests").get()).toEqual({ n: 1 });
  expect(physicalRequestCount(f.sy.db, 0)).toBe(1);
  expect(f.sy.db.prepare("SELECT COUNT(*) n FROM request_charges").get()).toEqual({ n: 0 });
  expect(grants(f)).toEqual([]);
});

it.each(["legacy", "split"] as const)("refuses paid direct dispatch at the shared global budget in %s without reserving or sending", async layout => {
  const f = await fixture({ layout, paid: "zero_budget" }), beforeProjects = projectRows(f);
  expect(f.sy.router.plan("direct", "T1", ["text"]).candidates.map(ep => ep.id)).toEqual(["acme/fixture"]);
  expect(f.sy.spend.globalDenial(0.001)).toMatch(/daily paid budget/);
  await expect(f.sy.requestClientConnection(request(), new AbortController().signal)).rejects.toBeInstanceOf(Error);
  expect(f.fake.chats()).toHaveLength(0);
  expect(f.sy.db.prepare("SELECT COUNT(*) n FROM model_requests").get()).toEqual({ n: 0 });
  expect(f.sy.db.prepare("SELECT COUNT(*) n FROM paid_spend").get()).toEqual({ n: 0 });
  expectTaskless(f, beforeProjects);
});

it.each(["legacy", "split"] as const)("accounts one admitted paid direct response globally in %s with no task shares or broker project spend", async layout => {
  const f = await fixture({ layout, paid: "allowed" }), beforeProjects = projectRows(f);
  await f.sy.requestClientConnection(request(), new AbortController().signal);
  expect(f.fake.chats()).toHaveLength(1);
  const paid = f.sy.db.prepare("SELECT reserved_usd,actual_usd,cost_basis,settled_at FROM paid_spend").get() as { reserved_usd: number; actual_usd: number; cost_basis: string; settled_at: number };
  expect(paid.reserved_usd).toBeGreaterThan(0); expect(paid.actual_usd).toBeCloseTo(0.0006, 8); expect(paid.cost_basis).toBe("computed"); expect(paid.settled_at).toBeGreaterThan(0);
  expect(f.sy.spend.windowSpend(0)).toBeCloseTo(0.0006, 8);
  expect(f.sy.db.prepare("SELECT status FROM model_requests").all()).toEqual([{ status: "succeeded" }]);
  expect(f.sy.db.prepare("SELECT COUNT(*) n FROM broker_paid_spend").get()).toEqual({ n: 0 });
  expect(f.sy.db.prepare("SELECT COUNT(*) n FROM physical_requests").get()).toEqual({ n: 0 });
  expectTaskless(f, beforeProjects);
});

it("retains the full paid reservation after an uncertain provider failure", async () => {
  const f = await fixture({ paid: "allowed", handler: () => providerJson({ error: { message: "fixture overloaded after accepting request" } }, 503) });
  await expect(f.sy.requestClientConnection(request(), new AbortController().signal)).rejects.toBeInstanceOf(Error);
  expect(f.fake.chats()).toHaveLength(1);
  expect(f.sy.db.prepare("SELECT status,http_status FROM model_requests").get()).toEqual({ status: "uncertain", http_status: 503 });
  const paid = f.sy.db.prepare("SELECT reserved_usd,actual_usd,cost_basis FROM paid_spend").get() as { reserved_usd: number; actual_usd: number; cost_basis: string };
  expect(paid.actual_usd).toBe(paid.reserved_usd); expect(paid.actual_usd).toBeGreaterThan(0); expect(paid.cost_basis).toBe("uncertain");
  expect(f.sy.spend.windowSpend(0)).toBe(paid.reserved_usd);
});

it("uses global T1 paid policy and the configured access token without exposing project authority", async () => {
  const f = await fixture({ paid: "never", token: TOKEN }), beforeProjects = projectRows(f);
  await expect(f.sy.requestClientConnection(request(), new AbortController().signal, "cd".repeat(32))).rejects.toMatchObject({ status: 401, code: "connection_token_required" });
  await expect(f.sy.requestClientConnection(request(), new AbortController().signal, TOKEN)).rejects.toMatchObject({ reason: "no_eligible_endpoint" });
  expect(f.sy.router.plan("direct", "T1", ["text"]).explanations[0]!.reasons).toEqual(expect.arrayContaining([expect.stringContaining("paid models are not allowed for T1")]));
  expect(f.fake.chats()).toHaveLength(0); expect(f.sy.db.prepare("SELECT COUNT(*) n FROM paid_spend").get()).toEqual({ n: 0 });
  expectTaskless(f, beforeProjects);
});
