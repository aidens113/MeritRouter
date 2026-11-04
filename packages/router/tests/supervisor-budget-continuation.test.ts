import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { BudgetRequests } from "../src/admission/budget-requests.js";
import { extraRequests } from "../src/admission/job-pool.js";
import { AdmissionDenied } from "../src/core/errors.js";
import type { Executor } from "../src/core/executor.js";
import type { MeritRouter } from "../src/core/service.js";
import type { ChatMessage, ChatRequest, ChatToolCall } from "../src/gateway/types.js";
import { Gate } from "../src/gateway/gate.js";
import { requestBudgetTool } from "../src/harness/budget-tools.js";
import { runAgentLoop } from "../src/harness/loop.js";
import type { HarnessEnv, HarnessTool } from "../src/harness/tools.js";
import type { ProjectRuntimeBundle } from "../src/projects/runtime-registry.js";
import { TaskRouter } from "../src/routing/router.js";
import { ask, baseResult, type RunContext, type RunOutcome } from "../src/runners/types.js";
import { assertSupervisorBudgetResumeDirective, resumeFor, ResumeDirectiveSchema } from "../src/sessions/run-sessions.js";
import { SessionStore } from "../src/sessions/store.js";
import { capturedLease } from "../src/storage/task-leases.js";
import { readStoreIdentity } from "../src/projects/store-identity.js";
import { syntheticResult } from "../src/storage/tasks.js";
import { SUPERVISOR_BUDGET_CONTINUED } from "../src/storage/supervisor-budget-continuation.js";
import { projectRuntimeActivationRoots } from "../src/workspaces/worktree.js";
import * as gitCommands from "../src/workspaces/git.js";
import * as repositoryMutation from "../src/workspaces/repository-mutation.js";
import * as mutationRecovery from "../src/workspaces/repository-mutation-recovery.js";
import { exactRepositoryRoot } from "../src/workspaces/repository-root.js";
import { ensureContract } from "../src/core/acceptance.js";
import { baseConfig, goodOutput, makeEnv, open, reply, ScriptedClient, servedFor } from "./helpers.js";

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
const limits = { maxConcurrent: 4, maxWritersPerRepo: 4, leaseMs: 300000, defaultTimeoutMs: 3600000, supervisorProfiles: ["supervise"], maxSupervisors: 4, supervisorTimeoutMs: 3600000 };
const call = (name: string, args: unknown = {}, id = name): ChatToolCall => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const tool: HarnessTool = { def: { type: "function", function: { name: "observe", description: "Read one distinct fixture observation", parameters: { type: "object", properties: { index: { type: "integer" } } } } }, sideEffect: "read", run: async args => `observation ${String(args.index)}` };
const finished = (): RunOutcome => ({ state: "completed", result: baseResult({ executionStatus: "completed", acceptanceStatus: "met", stopReason: "fixture_completed", summary: "Fixture completed" }) });
function profiles(cap = 6) {
  return { ...baseConfig().profiles, supervise: { mode: "supervisor", tools: "supervisor", max_model_requests: cap, max_output_tokens: 2000, classify: "never", min_tier: "T3" } };
}
function harness(ctx: RunContext): HarnessEnv {
  return { ctx, role: "supervisor", readers: new Map(), edits: new Set(), universe: { refs: new Map() }, allowArtifacts: false } as unknown as HarnessEnv;
}
const executor = (sy: MeritRouter) => (sy as unknown as { executor: Executor }).executor;
type TestStores = Pick<ProjectRuntimeBundle, "db" | "tasks" | "admission" | "gate" | "router" | "executor"> & { sessions: SessionStore };
function fixtureClaim(stores: Pick<TestStores, "db" | "tasks">, owner: string) {
  const identity = readStoreIdentity(stores.db);
  // Manual source-proof fixtures do not claim a global execution/provider grant. Split local
  // claims still use the explicit project FIFO control required by the actual TaskStore.
  return stores.tasks.claim(owner, limits, identity?.role === "project" ? { project: identity, order: "project_fifo" } : undefined);
}

it.each(["external", "model_poll"] as const)("refreshes an active execution from an absolute approved cap without double-counting a %s grant", async source => {
  const env = makeEnv({ config: baseConfig({ storage: { layout: "legacy", directory: "store" }, profiles: profiles(3), team: { supervisor_reserve_requests: 0 } }) });
  cleanup.push(() => env.cleanup());
  let sy!: MeritRouter, context!: RunContext, id = "";
  const seenCaps: number[] = [], requests: ChatRequest[] = [];
  const client = new ScriptedClient((request, n) => {
    requests.push(structuredClone(request)); seenCaps.push(context.budget.maxModelRequests);
    if (source === "external" && n === 1) {
      const external = new BudgetRequests(sy.db), grant = external.file({ taskId: id, jobId: null, role: "supervisor", requests: 4, reason: "External approved continuation", used: 1, cap: 3, approver: "external" });
      external.decide(grant.id, { approve: true, by: "FINAL", reason: "Existing authorization", cfg: sy.projectContext("demo") });
    }
    const name = source === "model_poll" && n === 1 ? "request_more_budget" : n === (source === "external" ? 4 : 5) ? "finish_fixture" : "observe";
    const args = name === "request_more_budget" ? { requests: 2, reason: "Model-requested authorized extension" } : { index: n };
    return reply(null, { ...servedFor(sy, request), toolCalls: [call(name, args, `call-${n}`)] });
  });
  if (source === "model_poll") {
    const original = BudgetRequests.prototype.file;
    vi.spyOn(BudgetRequests.prototype, "file").mockImplementation(function (this: BudgetRequests, input) {
      const filed = original.call(this, input);
      this.decide(filed.id, { approve: true, by: "FINAL", reason: "Existing authorization", cfg: sy.projectContext("demo") });
      return filed;
    });
  }
  sy = open(env, client, { worker: false, supervisor: { run: async ctx => {
    context = ctx;
    const executionId = ctx.gate.admission.createExecution("task", ctx.spec.profile, [{ taskId: ctx.taskId, itemId: ctx.taskId }]);
    const result = await runAgentLoop({ env: harness(ctx), executionId, messages: [{ role: "user", content: "Continue the bounded fixture" }], tools: [tool, requestBudgetTool()],
      terminal: { def: { type: "function", function: { name: "finish_fixture", description: "Finish", parameters: { type: "object" } } }, accept: async () => ({ ok: true as const, value: "done" }) },
      inputBudget: 10000, maxTokens: 1000, maxInvalidTerminal: 1 });
    expect(result.kind).toBe("terminal"); return finished();
  } } });
  cleanup.push(() => sy.close());
  const [created] = await sy.submitTasks([{ profile: "supervise", goal: "Bounded fake supervisor", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["finish"] }, budget: { maxModelRequests: 3 } }]); id = created!.taskId;
  const [claimed] = sy.tasks.claim(sy.owner, limits);
  await executor(sy).runSingle(claimed!);
  expect(sy.tasks.get(id)!.row.state).toBe("completed");
  expect(client.calls).toHaveLength(source === "external" ? 4 : 5);
  expect(seenCaps).toEqual(source === "external" ? [3, 7, 7, 7] : [3, 5, 5, 5, 5]);
  expect(context.budget.maxModelRequests).toBe(3 + extraRequests(sy.db, id));
  expect(requests[2]!.tools!.some(def => def.function.name === "observe")).toBe(true);
  expect(sy.admission.taskTotals(id).requests).toBe(client.calls.length);
});

it.each(["grant", "cancel"] as const)("refreshes every batch member before retry admission while retaining individual %s authority", async second => {
  const config = baseConfig({ storage: { layout: "legacy", directory: "store" } });
  config.profiles.summarize = { ...config.profiles.summarize, max_model_requests: 1 };
  const env = makeEnv({ config }); cleanup.push(() => env.cleanup());
  let sy!: MeritRouter, ids: string[] = [];
  const client = new ScriptedClient(async (request, round) => {
    const itemIds = [...String(request.messages[1]?.content).matchAll(/<item id="(i\d+)">/g)].map(match => match[1]!);
    if (round === 1) {
      const grants = new BudgetRequests(sy.db);
      for (const [index, id] of ids.entries()) {
        if (index === 1 && second === "cancel") { await sy.cancelTasks([id], "demo"); continue; }
        const request = grants.file({ taskId: id, jobId: null, role: "summarizer", requests: index + 1, reason: "Bounded external batch extension", used: 1, cap: 1, approver: "external" });
        grants.decide(request.id, { approve: true, by: "FINAL", reason: "Existing authorization", cfg: sy.projectContext("demo") });
      }
      return reply(JSON.stringify({ items: [] }), servedFor(sy, request));
    }
    return reply(JSON.stringify({ items: itemIds.map(id => ({ id, result: goodOutput() })) }), servedFor(sy, request));
  });
  sy = open(env, client, { worker: false }); cleanup.push(() => sy.close());
  const created = await sy.submitTasks(["one", "two"].map(goal => ({ profile: "summarize", goal, context: { inlineText: goal }, constraints: { acceptanceCriteria: ["summarize"] }, budget: { maxModelRequests: 20 } })));
  ids = created.map(task => task.taskId); const tasks = sy.tasks.claim(sy.owner, limits);
  const gate = vi.spyOn(Gate.prototype, "request");
  await executor(sy).runBatch(tasks);
  expect(client.requests).toHaveLength(2);
  const retry = gate.mock.calls.find(([request]) => request.purpose === "batch_retry")![0];
  expect(retry.participants.map(participant => [participant.taskId, participant.budget.maxModelRequests])).toEqual(second === "grant" ? [[ids[0], 2], [ids[1], 3]] : [[ids[0], 2]]);
  expect(sy.tasks.get(ids[0]!)!.row.state).toBe("completed");
  expect(sy.tasks.get(ids[1]!)!.row.state).toBe(second === "grant" ? "completed" : "cancelled");
  expect(sy.admission.taskTotals(ids[0]!).requests).toBe(2); expect(sy.admission.taskTotals(ids[1]!).requests).toBe(second === "grant" ? 2 : 1);
});

type ExecutorInternals = {
  context: (...args: unknown[]) => RunContext;
  reviewRun: (...args: unknown[]) => { reviewerContext: (...args: unknown[]) => RunContext };
  runTwins: (...args: unknown[]) => Promise<unknown>;
};
it("keeps reviewer, twin and repair allocations bounded after an execution grant", async () => {
  const env = makeEnv({ config: baseConfig({ storage: { layout: "legacy", directory: "store" } }) }); cleanup.push(() => env.cleanup());
  const sy = open(env, new ScriptedClient(() => reply("unused")), { worker: false }); cleanup.push(() => sy.close());
  const [created] = await sy.submitTasks([{ profile: "inspect", goal: "Inspect bounded fixture", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["inspect"] }, budget: { maxModelRequests: 40 } }]);
  const [task] = sy.tasks.claim(sy.owner, limits), id = created!.taskId, plan = sy.router.plan("inspect", "T1", ["text"]);
  const ensured = ensureContract({ cfg: env.cfg, tasks: sy.tasks, contracts: sy.contracts, requestsUsed: () => 0, now: Date.now }, task!, "T1", null);
  if (!ensured.ok) throw new Error(ensured.message);
  const contract = ensured.stored, routing = { classification: null, tier: null, escalatedFrom: null, attempts: [] }, signal = new AbortController().signal;
  const internal = executor(sy) as unknown as ExecutorInternals;
  const author = internal.context(task!, signal, plan, routing, null, { contract, retry: null });
  const before = author.budget.maxModelRequests, requests = new BudgetRequests(sy.db), grant = requests.file({ taskId: id, jobId: null, role: "inspector", requests: 9, reason: "Extend execution only", used: 0, cap: before, approver: "external" });
  requests.decide(grant.id, { approve: true, by: "FINAL", reason: "Existing authorization", cfg: env.cfg });
  expect(author.executionRequestCap!()).toBe(before + 9);
  const repair = internal.context(task!, signal, plan, routing, null, { contract, retry: null, repairCap: 7 });
  expect(repair.purpose).toBe("repair"); expect(repair.executionRequestCap).toBeUndefined(); expect(repair.budget.maxModelRequests).toBe(7);
  const review = internal.reviewRun(task!, signal, routing, null, contract, "T1", false).reviewerContext(plan, null, 3, [], "review");
  expect(review.purpose).toBe("verification"); expect(review.executionRequestCap).toBeUndefined(); expect(review.budget.maxModelRequests).toBe(3);
  const seen: RunContext[] = [], sentinel = new Error("bounded twin capture");
  vi.spyOn(executor(sy) as unknown as { runMode: (ctx: RunContext) => Promise<RunOutcome> }, "runMode").mockImplementation(async ctx => { seen.push(ctx); throw sentinel; });
  await internal.runTwins(task!, new AbortController(), routing, contract, "read_only", {}, { kind: "twin", plans: [plan, plan], cap: 8, perRun: 4 }, null, () => undefined);
  expect(seen).toHaveLength(2); for (const twin of seen) { expect(twin.budget.maxModelRequests).toBe(8); expect(twin.executionRequestCap).toBeUndefined(); if (!twin.session?.ended) twin.session?.end("failed", "fixture_capture"); }
});

it.each(["expired", "cancelled", "foreign_project", "foreign_owner", "foreign_run", "foreign_incarnation", "aborted"] as const)("does not refresh execution authority after %s", async kind => {
  const env = makeEnv({ config: baseConfig({ storage: { layout: "legacy", directory: "store" }, profiles: profiles(6) }) }); cleanup.push(() => env.cleanup());
  const client = new ScriptedClient(() => reply("unused")), sy = open(env, client, { worker: false }); cleanup.push(() => sy.close());
  await sy.submitTasks([{ profile: "supervise", goal: "Bounded authority", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["done"] } }]);
  const [task] = sy.tasks.claim(sy.owner, limits), controller = new AbortController();
  const ctx = (executor(sy) as unknown as ExecutorInternals).context(task!, controller.signal, sy.router.plan("supervise", "T3", ["text"]), { attempts: [] }, null);
  if (kind === "expired") sy.db.prepare("UPDATE tasks SET deadline_at=? WHERE id=?").run(Date.now() - 1, task!.row.id);
  if (kind === "cancelled") sy.db.prepare("UPDATE tasks SET state='cancel_requested',cancel_requested=1 WHERE id=?").run(task!.row.id);
  if (kind === "foreign_project") sy.db.prepare("UPDATE tasks SET project_id='foreign' WHERE id=?").run(task!.row.id);
  if (kind === "foreign_owner") sy.db.prepare("UPDATE tasks SET lease_owner='foreign' WHERE id=?").run(task!.row.id);
  if (kind === "foreign_run") sy.db.prepare("UPDATE tasks SET run_count=run_count+1 WHERE id=?").run(task!.row.id);
  if (kind === "foreign_incarnation") sy.db.prepare("UPDATE tasks SET lease_incarnation='foreign' WHERE id=?").run(task!.row.id);
  if (kind === "aborted") controller.abort("fixture stop");
  expect(() => ctx.executionRequestCap!()).toThrow(); expect(client.calls).toHaveLength(0);
});

async function recoveryFixture(layout: "legacy" | "split" = "legacy") {
  const projectDirectory = layout === "split" ? mkdtempSync(path.join(tmpdir(), "mr-budget-project-")) : undefined;
  if (projectDirectory) cleanup.push(() => rmSync(projectDirectory, { recursive: true, force: true }));
  const env = makeEnv({ config: baseConfig({ storage: { layout, directory: "store" }, profiles: profiles(6), team: { supervisor_reserve_requests: 1, provider_concurrency_enabled: false },
    ...(projectDirectory ? { repositories: {}, projects: { demo: { directory: projectDirectory, repositories: { core: { path: projectDirectory } } } } } : {}) }) });
  cleanup.push(() => env.cleanup()); if (projectDirectory) cpSync(env.repo, projectDirectory, { recursive: true });
  let now = Date.now();
  const client = new ScriptedClient(() => reply("unexpected provider request")), sy = open(env, client, { worker: false, now: () => now }); cleanup.push(() => sy.close());
  if (projectDirectory) await sy.createSplitProject({ slug: "demo", directory: projectDirectory });
  const stores = (layout === "split" ? sy.projectStores("demo") : sy) as unknown as TestStores;
  const cfg = sy.projectContext("demo"), [created] = await sy.submitTasks([{ profile: "supervise", goal: "Preserve the original bounded goal", repositoryAliases: ["core"], budget: { maxModelRequests: 6, maxPaidUsd: 0.5, timeoutSeconds: 3600 }, constraints: { acceptanceCriteria: ["actual delivery"] } }]);
  const id = created!.taskId, [task] = fixtureClaim(stores, sy.owner), root = projectRuntimeActivationRoots(cfg).worktrees;
  mkdirSync(root, { recursive: true }); const worktree = path.join(root, "retained-budget");
  const branch = `${cfg.supervisor.branch_prefix}${id}`;
  execFileSync("git", ["worktree", "add", "-b", branch, worktree, "HEAD"], { cwd: projectDirectory ?? env.repo, stdio: "pipe" });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" }).trim();
  const session = stores.sessions.create({ taskId: id, jobId: id, role: "supervisor", agentLabel: "retained budget supervisor", profile: "supervise", tier: "T3" });
  const messages: ChatMessage[] = [{ role: "system", content: "Original bounded charter" }, { role: "user", content: "Original bounded goal" }, { role: "assistant", content: "Retained verified progress" }];
  session.syncMessages(messages); session.setWorkspace({ repos: [{ alias: "core", worktree, head, baseCommit: head, branch }] });
  const executionId = stores.admission.createExecution("task", "supervise", [{ taskId: id, itemId: id }]);
  for (let n = 0; n < 6; n++) {
    stores.db.prepare("INSERT INTO model_requests(id,execution_id,purpose,gateway_model,status,reserved_at,est_input_tokens,reserved_output_tokens) VALUES(?,?,'supervisor','fixture','succeeded',?,1,1)").run(`spent-${n}`, executionId, now);
    stores.db.prepare("INSERT INTO request_charges(request_id,task_id,input_tokens,output_tokens) VALUES(?,?,1,1)").run(`spent-${n}`, id);
  }
  now += 100;
  const requests = new BudgetRequests(stores.db, () => now), grant = requests.file({ taskId: id, jobId: null, role: "supervisor", requests: 4, reason: "User approved four existing same-root requests", used: 6, cap: 6, approver: "external" });
  requests.decide(grant.id, { approve: true, by: "FINAL", reason: "Existing exact user authorization", cfg }); now += 100;
  const request = { executionId, purpose: "supervisor", chat: { messages, max_tokens: 1000 } };
  if (layout === "legacy") {
    const ctx = { cfg, tasks: stores.tasks, gate: stores.gate, taskId: id, leaseOwner: sy.owner, taskLease: capturedLease(task!), budget: { maxModelRequests: 6, maxInputTokens: null, maxOutputTokens: null, maxPaidUsd: 0 },
      session, signal: new AbortController().signal, plan: stores.router.plan("supervise", "T3", ["text"]), attempts: [] } as unknown as RunContext;
    await expect(ask(ctx, request)).rejects.toMatchObject({ reason: "task_request_budget_exhausted" });
  } else {
    // Exact local persisted evidence fixture; no global execution grant or provider dispatch.
    session.modelRequest(request); session.modelError({ executionId, error: new AdmissionDenied("task_request_budget_exhausted", "Project request budget or delegated pool exhausted"), attempts: [] });
  }
  session.end("failed", "budget_exhausted"); stores.tasks.finish(id, sy.owner, syntheticResult(id, "budget_exhausted", "supervisor request budget exhausted"), "budget_exhausted");
  const original = stores.tasks.get(id)!;
  const input = { operationId: "continue-budget-1", project: "demo", taskId: id, sessionId: session.id, approvedBudgetRequestId: grant.id, expectedDeadlineAt: original.row.deadline_at!, expectedRunCount: original.row.run_count,
    expectedIncarnation: original.row.lease_incarnation, reason: "Continue the same root with already approved headroom after stale-cap admission refusal" };
  return { sy, stores, cfg, id, session, worktree, head, messages, input, client, advance: (ms: number) => { now += ms; }, now: () => now };
}
function claim(f: Awaited<ReturnType<typeof recoveryFixture>>) {
  const [task] = fixtureClaim(f.stores, f.sy.owner); expect(task).toBeDefined(); return task!;
}
const accounting = (f: Awaited<ReturnType<typeof recoveryFixture>>) => JSON.stringify(["model_requests", "request_charges", "paid_spend", "task_request_grants", "job_budget_carves", "budget_requests", "project_request_holds", "project_request_protocol"].map(table => f.stores.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));

it.each(["legacy", "split"] as const)("queues and links exact %s same-root continuation once without changing time, accounting, original memory or source", async layout => {
  const f = await recoveryFixture(layout), before = accounting(f), task = f.stores.tasks.get(f.id)!, log = readFileSync(f.stores.sessions.get(f.session.id)!.logPath);
  const receipt = await f.sy.continueSupervisorBudget(f.input);
  expect(receipt).toMatchObject({ disposition: "fresh", deadlineAt: f.input.expectedDeadlineAt, previousResult: task.result, pool: { cap: 10, used: 6, held: 0, reserve: 1, available: 3 } });
  expect(await f.sy.continueSupervisorBudget(f.input)).toEqual({ ...receipt, disposition: "replayed" });
  await expect(f.sy.continueSupervisorBudget({ ...f.input, reason: "changed replay" })).rejects.toThrow(/replay changed/);
  await expect(f.sy.continueSupervisorBudget({ ...f.input, operationId: "stacked" })).rejects.toThrow();
  const claimed = claim(f); expect(await assertSupervisorBudgetResumeDirective({ ...f.stores, cfg: f.cfg }, claimed)).toBe(true);
  const resumed = resumeFor({ ...f.stores, cfg: f.cfg }, claimed)!;
  expect(resumed.plan.messages).toEqual(f.messages); expect(resumed.plan.actions).toEqual([]);
  expect(f.stores.sessions.get(resumed.session.id)).toMatchObject({ previousSessionId: f.session.id, status: "running", role: "supervisor" });
  expect(await assertSupervisorBudgetResumeDirective({ ...f.stores, cfg: f.cfg }, claimed, resumed.session.id)).toBe(true);
  expect(f.stores.sessions.get(f.session.id)).toMatchObject({ status: "failed", stopReason: "budget_exhausted" });
  expect(readFileSync(f.stores.sessions.get(f.session.id)!.logPath)).toEqual(log);
  expect(accounting(f)).toBe(before); expect(f.stores.tasks.get(f.id)!.spec).toEqual(task.spec);
  expect(f.stores.tasks.get(f.id)!.row.deadline_at).toBe(task.row.deadline_at); expect(f.client.calls).toHaveLength(0);
  expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: f.worktree, encoding: "utf8" }).trim()).toBe(f.head);
  resumed.session.end("interrupted", "fixture cleanup");
});

it("runs the real supervisor harness from retained budget-failure memory with one financed fake-provider request", async () => {
  const f = await recoveryFixture(), originalTask = f.stores.tasks.get(f.id)!, originalLog = readFileSync(f.stores.sessions.get(f.session.id)!.logPath);
  const grantRows = f.stores.db.prepare("SELECT * FROM budget_requests ORDER BY id").all(), oldCharges = f.stores.db.prepare("SELECT * FROM request_charges ORDER BY request_id").all();
  f.client.handler = request => {
    expect(request.messages.some(message => message.role === "assistant" && message.content === "Retained verified progress")).toBe(true);
    const active = f.stores.sessions.forTask(f.id).find(session => session.status === "running")!;
    expect(active).toMatchObject({ previousSessionId: f.session.id, role: "supervisor" });
    expect(active.workspace!.repos[0]).toMatchObject({ worktree: f.worktree, head: f.head, baseCommit: f.head });
    return reply(null, { ...servedFor(f.sy, request), toolCalls: [call("finish_job", { status: "blocked", summary: "Retained progress verified; original delivery is still unaccepted", verified: [], not_verified: ["actual delivery"], follow_up: "Await the remaining authorized product work" })] });
  };
  await f.sy.continueSupervisorBudget(f.input);
  const gate = vi.spyOn(Gate.prototype, "request"); await f.stores.executor.runSingle(claim(f));
  expect(f.client.requests).toHaveLength(1);
  const request = gate.mock.calls[0]![0], current = f.stores.tasks.get(f.id)!;
  expect(request.participants).toHaveLength(1); expect(request.participants[0]!.budget.maxModelRequests).toBe(10);
  expect(request.participants[0]!.lease).toMatchObject({ taskId: f.id, project: "demo", runCount: 2, incarnation: f.input.expectedIncarnation });
  expect(current.row.state).toBe("completed"); expect(current.result!.stopReason).toBe("supervisor_blocked");
  expect(current.result!.acceptanceStatus).not.toBe("met"); expect(current.spec).toEqual(originalTask.spec); expect(current.row.deadline_at).toBe(originalTask.row.deadline_at);
  expect(f.stores.db.prepare("SELECT * FROM budget_requests ORDER BY id").all()).toEqual(grantRows);
  expect(f.stores.db.prepare("SELECT * FROM request_charges WHERE request_id LIKE 'spent-%' ORDER BY request_id").all()).toEqual(oldCharges);
  expect(f.stores.admission.taskTotals(f.id).requests).toBe(7); expect(f.stores.sessions.get(f.session.id)).toMatchObject({ status: "failed", stopReason: "budget_exhausted" });
  expect(readFileSync(f.stores.sessions.get(f.session.id)!.logPath)).toEqual(originalLog);
  expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: f.worktree, encoding: "utf8" }).trim()).toBe(f.head);
}, 30000);

it("replays concurrent identical continuation calls without duplicating queue authority", async () => {
  const f = await recoveryFixture(), before = accounting(f);
  const results = await Promise.all([f.sy.continueSupervisorBudget(f.input), f.sy.continueSupervisorBudget(f.input)]);
  expect(results.map(result => result.disposition).sort()).toEqual(["fresh", "replayed"]);
  expect(results[0]!.proofDigest).toBe(results[1]!.proofDigest);
  expect(f.stores.db.prepare("SELECT COUNT(*) n FROM events WHERE task_id=? AND type=?").get(f.id, SUPERVISOR_BUDGET_CONTINUED)).toEqual({ n: 1 });
  expect(f.stores.db.prepare("SELECT COUNT(*) n FROM events WHERE task_id=? AND type='resumed'").get(f.id)).toEqual({ n: 1 });
  expect(f.stores.tasks.get(f.id)!.row.state).toBe("queued"); expect(accounting(f)).toBe(before); expect(f.client.calls).toHaveLength(0);
});

it.each(["expired", "cancelled", "owned", "wrong_project", "wrong_run", "wrong_incarnation", "wrong_session", "wrong_deadline", "spent", "pre_run_grant", "model_grant", "foreign_grant", "newer_session", "corrupt_log", "dirty_source", "changed_head", "unresolved_tool"] as const)("refuses unsafe same-root recovery before queueing: %s", async kind => {
  const f = await recoveryFixture(), { db } = f.stores, input = { ...f.input };
  if (kind === "expired") f.advance(3600001);
  if (kind === "cancelled") db.prepare("UPDATE tasks SET cancel_requested=1 WHERE id=?").run(f.id);
  if (kind === "owned") db.prepare("UPDATE tasks SET lease_owner='foreign',lease_expires_at=? WHERE id=?").run(f.now() + 10000, f.id);
  if (kind === "wrong_project") input.project = "foreign";
  if (kind === "wrong_run") input.expectedRunCount++;
  if (kind === "wrong_incarnation") input.expectedIncarnation = "foreign";
  if (kind === "wrong_session") input.sessionId = "foreign";
  if (kind === "wrong_deadline") input.expectedDeadlineAt++;
  if (kind === "spent") db.prepare("UPDATE budget_requests SET granted=1 WHERE id=?").run(input.approvedBudgetRequestId);
  if (kind === "pre_run_grant") db.prepare("UPDATE budget_requests SET decided_at=? WHERE id=?").run(f.now() - 201, input.approvedBudgetRequestId);
  if (kind === "model_grant") db.prepare("UPDATE budget_requests SET approver='auto' WHERE id=?").run(input.approvedBudgetRequestId);
  if (kind === "foreign_grant") db.prepare("UPDATE budget_requests SET project_id='foreign' WHERE id=?").run(input.approvedBudgetRequestId);
  if (kind === "newer_session") { const s = f.stores.sessions.create({ taskId: f.id, jobId: f.id, role: "supervisor", agentLabel: "newer", profile: "supervise" }); s.end("failed", "budget_exhausted"); }
  if (kind === "corrupt_log") appendFileSync(f.stores.sessions.get(f.session.id)!.logPath, "not-json\n");
  if (kind === "dirty_source") writeFileSync(path.join(f.worktree, "unknown.txt"), "not authorized");
  if (kind === "changed_head") execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "changed"], { cwd: f.worktree, stdio: "pipe" });
  if (kind === "unresolved_tool") appendFileSync(f.stores.sessions.get(f.session.id)!.logPath, JSON.stringify({ seq: f.session.lastSeq + 1, at: f.now(), type: "tool_intent", data: { callId: "unknown", name: "run_command", args: {}, sideEffect: "command", idempotent: false } }) + "\n");
  await expect(f.sy.continueSupervisorBudget(input)).rejects.toThrow(); expect(f.stores.tasks.get(f.id)!.row.state).toBe("budget_exhausted"); expect(f.client.calls).toHaveLength(0);
});

async function descendant(f: Awaited<ReturnType<typeof recoveryFixture>>, uncertain = false) {
  const [created] = await f.sy.submitTasks([{ profile: "inspect", parentTaskId: f.id, goal: "Historical descendant", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["inspect"] } }]);
  const child = created!.taskId; f.stores.tasks.claim(f.sy.owner, limits);
  f.stores.tasks.finish(child, f.sy.owner, syntheticResult(child, "failed", "command_timeout"), "failed");
  const action = { id: "historical-command", project: "demo", taskId: child, status: uncertain ? "uncertain" : "completed", quiescedAt: f.now(), output: "Outcome remains UNKNOWN", exitCode: null };
  const save = () => f.stores.db.prepare("INSERT OR REPLACE INTO worker_action_requests(id,project_id,task_id,request_key,value_json,created_at) VALUES(?,?,?,?,?,?)").run(action.id, "demo", child, "historical-command", JSON.stringify(action), f.now());
  save(); return { child, action, save };
}
it("retains only exact terminal ownerless host-quiesced descendant uncertainty as UNKNOWN without replay or financial mutation", async () => {
  const f = await recoveryFixture(), h = await descendant(f, true), before = accounting(f), row = f.stores.db.prepare("SELECT * FROM worker_action_requests").get();
  await f.sy.continueSupervisorBudget(f.input);
  expect(accounting(f)).toBe(before); expect(f.stores.db.prepare("SELECT * FROM worker_action_requests").get()).toEqual(row);
  expect(h.action.status).toBe("uncertain"); expect(f.stores.tasks.get(h.child)!.row.state).toBe("failed"); expect(f.client.calls).toHaveLength(0);
});
it.each(["unquiesced", "own_root", "nonterminal", "owned_terminal", "active_reviewer", "foreign_action_project", "foreign_action_task", "active_request", "split_hold"] as const)("refuses active or unproved descendant effects: %s", async kind => {
  const f = await recoveryFixture(), h = await descendant(f, true), db = f.stores.db;
  if (kind === "unquiesced") delete (h.action as { quiescedAt?: number }).quiescedAt;
  if (kind === "own_root") h.action.taskId = f.id;
  if (kind === "nonterminal") db.prepare("UPDATE tasks SET state='queued' WHERE id=?").run(h.child);
  if (kind === "owned_terminal") db.prepare("UPDATE tasks SET lease_owner='foreign',lease_expires_at=? WHERE id=?").run(f.now() + 10000, h.child);
  if (kind === "active_reviewer") f.stores.sessions.create({ taskId: h.child, role: "reviewer", agentLabel: "active reviewer", profile: "review" });
  if (kind === "foreign_action_project") h.action.project = "foreign";
  if (kind === "foreign_action_task") h.action.taskId = "foreign";
  h.save();
  if (kind === "active_request") db.prepare("UPDATE model_requests SET status='reserved' WHERE id='spent-0'").run();
  if (kind === "split_hold") {
    db.prepare("INSERT INTO project_request_protocol(request_id,project_id,owner_json,fingerprint,binding_json,global_json,reservation_json,phase,created_at,updated_at) VALUES('held','demo','{}','fixture','{}','{}','{}','prepared',?,?)").run(f.now(), f.now());
    db.prepare("INSERT INTO project_request_holds(request_id,task_id,project_id,lease_incarnation,run_count,input_tokens,output_tokens,paid_usd,active) VALUES('held',?,'demo',?,1,0,0,0,1)").run(h.child, f.stores.tasks.get(h.child)!.row.lease_incarnation);
  }
  await expect(f.sy.continueSupervisorBudget(f.input)).rejects.toThrow(); expect(f.stores.tasks.get(f.id)!.row.state).toBe("budget_exhausted");
});

it.each(["prepared", "bound", "dispatch_intent", "uncertain", "quarantined"] as const)("refuses a captured %s protocol before any participant hold or model projection exists", async phase => {
  const f = await recoveryFixture("split"), db = f.stores.db;
  const binding = JSON.stringify({ participants: [{ taskId: f.id, lease: { taskId: f.id, project: "demo", owner: f.sy.owner, runCount: f.input.expectedRunCount, incarnation: f.input.expectedIncarnation } }] });
  db.prepare("INSERT INTO project_request_protocol(request_id,project_id,owner_json,fingerprint,binding_json,global_json,reservation_json,phase,created_at,updated_at) VALUES('no-hold','demo',?,'fixture',?,'{}','{}',?,?,?)")
    .run(JSON.stringify((f.sy.projectStores("demo") as ProjectRuntimeBundle).identity), binding, phase, f.now(), f.now());
  expect(db.prepare("SELECT COUNT(*) n FROM project_request_holds WHERE request_id='no-hold'").get()).toEqual({ n: 0 });
  expect(db.prepare("SELECT COUNT(*) n FROM model_requests WHERE id='no-hold'").get()).toEqual({ n: 0 });
  await expect(f.sy.continueSupervisorBudget(f.input)).rejects.toThrow(/unresolved before participant projection/);
  expect(f.stores.tasks.get(f.id)!.row.state).toBe("budget_exhausted"); expect(f.client.calls).toHaveLength(0);
});

it("preserves unrelated project/root protocol rows while continuing only its captured subtree", async () => {
  const f = await recoveryFixture(), db = f.stores.db;
  for (const [id, project] of [["other-root", "demo"], ["other-project", "other"]]) {
    db.prepare("INSERT INTO project_request_protocol(request_id,project_id,owner_json,fingerprint,binding_json,global_json,reservation_json,phase,created_at,updated_at) VALUES(?,?,'{}','fixture',?,'{}','{}','prepared',?,?)")
      .run(id, project, JSON.stringify({ participants: [{ taskId: id }] }), f.now(), f.now());
  }
  const before = db.prepare("SELECT * FROM project_request_protocol ORDER BY request_id").all();
  await f.sy.continueSupervisorBudget(f.input);
  expect(db.prepare("SELECT * FROM project_request_protocol ORDER BY request_id").all()).toEqual(before); expect(f.client.calls).toHaveLength(0);
});

it.each(["missing_receipt", "missing_directive", "plain_directive", "mixed_directive", "changed_receipt", "changed_memory", "changed_grant", "changed_source", "cancelled", "changed_deadline"] as const)("fails before routing or linked-session creation when queued proof changes: %s", async kind => {
  const f = await recoveryFixture(), db = f.stores.db; await f.sy.continueSupervisorBudget(f.input);
  if (kind === "missing_receipt") db.prepare("DELETE FROM events WHERE type=?").run(SUPERVISOR_BUDGET_CONTINUED);
  if (kind === "missing_directive") db.prepare("DELETE FROM events WHERE type='resumed'").run();
  if (kind === "plain_directive") db.prepare("UPDATE events SET data_json=? WHERE type='resumed'").run(JSON.stringify({ sessionId: f.session.id }));
  if (kind === "mixed_directive") db.prepare("UPDATE events SET data_json=json_set(data_json,'$.maintenanceContinuation',1,'$.maintenanceOperationId','foreign') WHERE type='resumed'").run();
  if (kind === "changed_receipt") db.prepare("UPDATE events SET data_json=json_set(data_json,'$.proof.taskSpecDigest',?) WHERE type=?").run("a".repeat(64), SUPERVISOR_BUDGET_CONTINUED);
  if (kind === "changed_memory") db.prepare("UPDATE sessions SET agent_label='changed' WHERE id=?").run(f.session.id);
  if (kind === "changed_grant") db.prepare("UPDATE budget_requests SET granted=5 WHERE id=?").run(f.input.approvedBudgetRequestId);
  if (kind === "changed_source") writeFileSync(path.join(f.worktree, "changed.txt"), "changed source");
  const task = claim(f); if (kind === "cancelled") db.prepare("UPDATE tasks SET cancel_requested=1 WHERE id=?").run(f.id);
  if (kind === "changed_deadline") db.prepare("UPDATE tasks SET deadline_at=deadline_at+1000 WHERE id=?").run(f.id);
  const route = vi.spyOn(TaskRouter.prototype, "prepare"), count = f.stores.sessions.forTask(f.id).length;
  await f.stores.executor.runSingle(task);
  expect(route).not.toHaveBeenCalled(); expect(f.stores.sessions.forTask(f.id)).toHaveLength(count); expect(f.client.calls).toHaveLength(0);
  expect(f.stores.tasks.get(f.id)!.row.state).not.toBe("running");
});

it.each([["foreign_owner", "preview"], ["foreign_owner", "locked"], ["changed_deadline", "preview"], ["changed_deadline", "locked"], ["changed_directive", "preview"], ["changed_directive", "locked"]] as const)("rechecks exact %s after awaited %s source proof and releases repository ownership on refusal", async (kind, phase) => {
  const f = await recoveryFixture(); await f.sy.continueSupervisorBudget(f.input); const task = claim(f), original = gitCommands.git;
  let replaced = false, trees = 0;
  vi.spyOn(gitCommands, "git").mockImplementation(async (cwd, args, options) => {
    const result = await original(cwd, args, options);
    if (args.join(" ") === "rev-parse HEAD^{tree}") trees++;
    if (!replaced && args.join(" ") === "rev-parse HEAD^{tree}" && trees === (phase === "preview" ? 1 : 2)) {
      replaced = true;
      if (kind === "foreign_owner") f.stores.db.prepare("UPDATE tasks SET lease_owner='replacement' WHERE id=?").run(f.id);
      else if (kind === "changed_deadline") f.stores.db.prepare("UPDATE tasks SET deadline_at=deadline_at+1000 WHERE id=?").run(f.id);
      else f.stores.db.prepare("UPDATE events SET data_json=? WHERE task_id=? AND type='resumed'").run(JSON.stringify({ sessionId: f.session.id }), f.id);
    }
    return result;
  });
  await expect(assertSupervisorBudgetResumeDirective({ ...f.stores, cfg: f.cfg }, task)).rejects.toThrow(/exact live claimed/);
  expect(replaced).toBe(true); expect(f.client.calls).toHaveLength(0);
  const common = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: f.worktree, encoding: "utf8" }).trim();
  expect(existsSync(path.resolve(f.worktree, common, "meritrouter-mutation.lock"))).toBe(false);
});

it("refuses a changed configured Git owner before acquiring any retained-source mutation lock", async () => {
  const f = await recoveryFixture(); await f.sy.continueSupervisorBudget(f.input); const task = claim(f);
  const other = makeEnv(); cleanup.push(() => other.cleanup());
  f.cfg.repositoryPaths.core!.path = other.repo;
  const mutate = vi.spyOn(repositoryMutation, "withRepositoryMutation");
  await expect(assertSupervisorBudgetResumeDirective({ ...f.stores, cfg: f.cfg }, task)).rejects.toThrow(/foreign Git owner/);
  expect(mutate).not.toHaveBeenCalled(); expect(f.client.calls).toHaveLength(0);
});

it.each(["initial_control", "claimed_resume"] as const)("refuses a swapped Git common owner before creating any foreign lock: %s", async phase => {
  const f = await recoveryFixture(), other = makeEnv(); cleanup.push(() => other.cleanup());
  if (phase === "claimed_resume") await f.sy.continueSupervisorBudget(f.input);
  const task = phase === "claimed_resume" ? claim(f) : null;
  const common = realpathSync((await exactRepositoryRoot(f.worktree)).commonDirectory), foreign = realpathSync(path.join(other.repo, ".git"));
  const gitFile = path.join(f.worktree, ".git"), preservedGitFile = path.join(f.worktree, ".git-budget-owner-proof"), originalGitFile = readFileSync(gitFile), before = accounting(f), sessions = f.stores.sessions.forTask(f.id).length;
  const original = repositoryMutation.withRepositoryMutation, owners = vi.spyOn(mutationRecovery, "newRepositoryMutationOwner"), route = vi.spyOn(TaskRouter.prototype, "prepare");
  let swapped = false, movedGitFile = false;
  vi.spyOn(repositoryMutation, "withRepositoryMutation").mockImplementation(async (requested, action, options) => {
    if (!swapped && requested.includes(f.worktree)) {
      expect(options?.expectedCommonDirectories).toEqual([common]);
      // Git can give this Windows file attributes that reject truncating opens. Preserve
      // its exact file/attributes by renaming it inside this owned temp worktree instead.
      renameSync(gitFile, preservedGitFile); movedGitFile = true;
      writeFileSync(gitFile, `gitdir: ${foreign.replaceAll("\\", "/")}\n`);
      swapped = true;
      // Prove this fixture really rebinds the requested root to a resolvable foreign owner.
      expect(realpathSync((await exactRepositoryRoot(f.worktree)).commonDirectory)).toBe(foreign);
    }
    return original(requested, action, options);
  });
  try {
    if (task) await f.stores.executor.runSingle(task);
    else await expect(f.sy.continueSupervisorBudget(f.input)).rejects.toMatchObject({ detail: { kind: "ownership_changed" } });
    expect(swapped).toBe(true);
    // newRepositoryMutationOwner is called immediately after a lock is successfully opened;
    // this catches transient foreign acquisition even if a later callback would release it.
    expect(owners.mock.calls.some(([directory]) => process.platform === "win32" ? directory.toLowerCase() === foreign.toLowerCase() : directory === foreign)).toBe(false);
    expect(existsSync(path.join(foreign, "meritrouter-mutation.lock"))).toBe(false);
    expect(route).not.toHaveBeenCalled(); expect(f.stores.sessions.forTask(f.id)).toHaveLength(sessions);
    expect(accounting(f)).toBe(before); expect(f.client.calls).toHaveLength(0);
    if (!task) expect(f.stores.tasks.get(f.id)!.row.state).toBe("budget_exhausted");
    else expect(f.stores.tasks.get(f.id)!.row.state).not.toBe("running");
  } finally {
    if (movedGitFile) { rmSync(gitFile, { force: true }); renameSync(preservedGitFile, gitFile); }
  }
  expect(readFileSync(gitFile)).toEqual(originalGitFile);
});

it("normalizes duplicate pinned common owners for ordinary and reentrant mutation admission", async () => {
  const env = makeEnv(); cleanup.push(() => env.cleanup());
  const common = realpathSync(path.join(env.repo, ".git")), duplicate = process.platform === "win32" ? common.toUpperCase() : common;
  const expectedCommonDirectories = [common, duplicate, common];
  const action = vi.fn(async () => "pinned");
  await repositoryMutation.withRepositoryMutation([env.repo, env.repo], async capability => {
    expect(await repositoryMutation.withRepositoryMutation([env.repo], action, { capability, expectedCommonDirectories })).toBe("pinned");
  }, { expectedCommonDirectories });
  expect(action).toHaveBeenCalledOnce(); expect(existsSync(path.join(common, "meritrouter-mutation.lock"))).toBe(false);
});

it("enforces an exact pinned owner set even on a valid reentrant capability", async () => {
  const env = makeEnv(), other = makeEnv(); cleanup.push(() => env.cleanup(), () => other.cleanup());
  const common = realpathSync(path.join(env.repo, ".git")), foreign = realpathSync(path.join(other.repo, ".git")), action = vi.fn(async () => undefined);
  await expect(repositoryMutation.withRepositoryMutation([env.repo], action, { expectedCommonDirectories: [common, foreign] })).rejects.toMatchObject({ detail: { kind: "ownership_changed" } });
  expect(existsSync(path.join(common, "meritrouter-mutation.lock"))).toBe(false);
  await repositoryMutation.withRepositoryMutation([env.repo], async capability => {
    await expect(repositoryMutation.withRepositoryMutation([env.repo], action, { capability, expectedCommonDirectories: [foreign] })).rejects.toMatchObject({ detail: { kind: "ownership_changed" } });
  });
  expect(action).not.toHaveBeenCalled(); expect(existsSync(path.join(foreign, "meritrouter-mutation.lock"))).toBe(false);
});

it("never realpaths expected common-owner strings into replacement authority", async () => {
  const env = makeEnv(); cleanup.push(() => env.cleanup());
  const common = realpathSync(path.join(env.repo, ".git")), alias = path.join(env.dir, "owner-alias"), action = vi.fn(async () => undefined);
  symlinkSync(common, alias, process.platform === "win32" ? "junction" : "dir");
  expect(realpathSync(alias)).toBe(common);
  await expect(repositoryMutation.withRepositoryMutation([env.repo], action, { expectedCommonDirectories: [alias] })).rejects.toMatchObject({ detail: { kind: "ownership_changed" } });
  expect(action).not.toHaveBeenCalled(); expect(existsSync(path.join(common, "meritrouter-mutation.lock"))).toBe(false);
});

it("validates pinned common-owner paths before any lock or action", async () => {
  const env = makeEnv(); cleanup.push(() => env.cleanup());
  const common = realpathSync(path.join(env.repo, ".git")), action = vi.fn(async () => undefined), owners = vi.spyOn(mutationRecovery, "newRepositoryMutationOwner");
  for (const expectedCommonDirectories of [[], ["relative"], [`${common}${path.sep}..${path.sep}.git`]]) {
    await expect(repositoryMutation.withRepositoryMutation([env.repo], action, { expectedCommonDirectories })).rejects.toThrow();
  }
  expect(owners).not.toHaveBeenCalled(); expect(action).not.toHaveBeenCalled(); expect(existsSync(path.join(common, "meritrouter-mutation.lock"))).toBe(false);
});

it.each(["syncMessages", "setWorkspace", "note", "task_event"] as const)("settles a cloned budget-session %s failure without starting fresh or leaving another author live", async fault => {
  const f = await recoveryFixture(), history = readFileSync(f.stores.sessions.get(f.session.id)!.logPath), before = accounting(f);
  const originalTask = f.stores.tasks.get(f.id)!, source = readFileSync(path.join(f.worktree, "src/app.ts"));
  await f.sy.continueSupervisorBudget(f.input); const task = claim(f), original = SessionStore.prototype.create;
  let injected = false;
  vi.spyOn(SessionStore.prototype, "create").mockImplementation(function (this: SessionStore, input) {
    const session = original.call(this, input);
    if (input.previousSessionId === f.session.id && fault !== "task_event") vi.spyOn(session, fault).mockImplementationOnce(() => { injected = true; throw new Error("fixture log write failed"); });
    return session;
  });
  if (fault === "task_event") {
    const event = f.stores.tasks.event.bind(f.stores.tasks);
    vi.spyOn(f.stores.tasks, "event").mockImplementation((id, type, data) => {
      if (!injected && id === f.id && type === "session_resumed") { injected = true; throw new Error("fixture task event write failed"); }
      return event(id, type, data);
    });
  }
  const route = vi.spyOn(TaskRouter.prototype, "prepare"), gate = vi.spyOn(Gate.prototype, "request");
  const runner = vi.spyOn(f.stores.executor as unknown as { runMode: (ctx: RunContext) => Promise<RunOutcome> }, "runMode").mockRejectedValue(new Error("Broken linked budget recovery reached a runner"));
  await expect(f.stores.executor.runSingle(task)).resolves.toBeUndefined();
  expect(injected).toBe(true); expect(route).toHaveBeenCalledOnce(); expect(runner).not.toHaveBeenCalled(); expect(gate).not.toHaveBeenCalled(); expect(f.client.calls).toHaveLength(0);
  const authors = f.stores.sessions.forTask(f.id), linked = authors.find(session => session.previousSessionId === f.session.id)!;
  expect(authors).toHaveLength(2); expect(authors.some(session => session.status === "running")).toBe(false);
  expect(linked).toMatchObject({ status: "failed", stopReason: "supervisor_budget_continuation_recording_failed" });
  expect(f.stores.sessions.events(linked.id, { limit: 10000 })!.events.at(-1)).toMatchObject({ type: "ended", data: { status: "failed", stopReason: "supervisor_budget_continuation_recording_failed" } });
  expect(f.stores.tasks.get(f.id)!.row).toMatchObject({ state: "failed", lease_owner: null, lease_expires_at: null, deadline_at: originalTask.row.deadline_at });
  expect(f.stores.tasks.get(f.id)!.spec).toEqual(originalTask.spec); expect(accounting(f)).toBe(before);
  expect(readFileSync(f.stores.sessions.get(f.session.id)!.logPath)).toEqual(history); expect(readFileSync(path.join(f.worktree, "src/app.ts"))).toEqual(source);
});

it("requires exclusive budget-continuation directive authority", () => {
  expect(ResumeDirectiveSchema.safeParse({ sessionId: "old", supervisorBudgetContinuation: true, supervisorBudgetOperationId: "one" }).success).toBe(true);
  expect(ResumeDirectiveSchema.safeParse({ sessionId: "old", supervisorBudgetContinuation: true, supervisorBudgetOperationId: "one", failedInfrastructureRecovery: true, infrastructureRecoveryOperationId: "two" }).success).toBe(false);
  expect(ResumeDirectiveSchema.safeParse({ sessionId: "old", supervisorBudgetOperationId: "one" }).success).toBe(false);
});
