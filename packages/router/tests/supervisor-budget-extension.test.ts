import { afterEach, describe, expect, it } from "vitest";
import { BudgetRequests, jobPool } from "../src/admission/budget-requests.js";
import { recordCarve, heldRequests } from "../src/admission/admission.js";
import { requestBudgetTool } from "../src/harness/budget-tools.js";
import type { HarnessEnv } from "../src/harness/tools.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { baseConfig, makeEnv, open, reply, ScriptedClient, type Env } from "./helpers.js";
import type { MeritRouter } from "../src/core/service.js";
import { capturedLease } from "../src/storage/task-leases.js";
let env: Env | undefined, sy: MeritRouter | undefined;
afterEach(async () => { await sy?.close(); sy = undefined; env?.cleanup(); env = undefined; });
function setup() {
  const config = baseConfig({ paid: { enabled: false }, verification: { max_total_requests_per_task: null }, team: { supervisor_reserve_requests: 4 } });
  (config.profiles as Record<string, unknown>).supervise = { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100, max_model_requests: null };
  env = makeEnv({ config }); sy = open(env, new ScriptedClient(() => reply("unused")), { worker: false });
  const submit = (cap: number, parentTaskId?: string) => sy!.tasks.submit([WorkerTaskSchema.parse({ profile: "supervise", goal: "deliver", constraints: { acceptanceCriteria: ["works"] }, budget: { maxModelRequests: cap, maxPaidUsd: 0 }, ...(parentTaskId ? { parentTaskId } : {}) })])[0]!.taskId;
  const parent = submit(100), child = submit(30, parent);
  recordCarve(sy.db, { childTaskId: child, parentTaskId: parent, requests: 30, parentRemaining: 100, share: 0.3, depth: 1 }, Date.now());
  return { parent, child, submit, store: new BudgetRequests(sy.db) };
}
function file(store: BudgetRequests, child: string, parent: string | null, requests: number) { return store.file({ taskId: child, jobId: parent, role: "supervisor", requests, reason: "integration remaining", used: 0, cap: 30, approver: parent ? "supervisor" : "external" }); }
describe("nested supervisor upward grants", () => {
  it("updates child allowance and parent hold atomically, reconstructible from persisted records", () => {
    const { parent, child, store } = setup();
    store.decide(file(store, child, parent, 10).id, { approve: true, by: parent, reason: "repair", cfg: sy!.cfg });
    expect(jobPool(sy!.db, sy!.cfg, child)).toMatchObject({ cap: 40, available: 36 });
    expect(heldRequests(sy!.db, parent)).toBe(40);
    expect(jobPool(sy!.db, sy!.cfg, parent)).toMatchObject({ cap: 100, available: 56 });
    expect(new BudgetRequests(sy!.db).list({ taskId: child })[0]).toMatchObject({ status: "approved", granted: 10 });
    expect(sy!.tasks.get(child)!.spec.budget?.maxPaidUsd).toBe(0);
  });
  it("prevents sibling grants from oversubscribing the parent and duplicate decisions from double holding", () => {
    const { parent, child, store, submit } = setup();
    const sibling = submit(30, parent);
    recordCarve(sy!.db, { childTaskId: sibling, parentTaskId: parent, requests: 30, parentRemaining: 70, share: 0.3, depth: 1 }, Date.now());
    const req = file(store, child, parent, 25);
    store.decide(req.id, { approve: true, by: parent, reason: "remaining", cfg: sy!.cfg });
    expect(() => store.decide(file(store, sibling, parent, 25).id, { approve: true, by: parent, reason: "remaining", cfg: sy!.cfg })).toThrow(/does not fit/);
    expect(() => store.decide(req.id, { approve: true, by: parent, reason: "again", cfg: sy!.cfg })).toThrow(/already approved/);
    expect(heldRequests(sy!.db, parent)).toBe(85);
  });
  it("rolls back approval when nested carve is missing", () => {
    const { parent, store, submit } = setup(); const orphan = submit(10, parent);
    const req = file(store, orphan, parent, 5);
    expect(() => store.decide(req.id, { approve: true, by: parent, reason: "more", cfg: sy!.cfg })).toThrow(/no parent budget carve/);
    expect(store.get(req.id)?.status).toBe("pending");
  });
  it("extends root supervisor pool only through a separately decided request", () => {
    const { parent, store } = setup();
    store.decide(file(store, parent, null, 20).id, { approve: true, by: "external:final", reason: "approved", cfg: sy!.cfg });
    expect(jobPool(sy!.db, sy!.cfg, parent)?.cap).toBe(120);
    expect(sy!.cfg.paid.enabled).toBe(false);
  });
  it("restores extended caps and conserved holds after closing and reopening the router", async () => {
    const { parent, child, store } = setup();
    store.decide(file(store, child, parent, 10).id, { approve: true, by: parent, reason: "repair", cfg: sy!.cfg });
    await sy!.close();
    sy = open(env!, new ScriptedClient(() => reply("unused")), { worker: false });
    expect(jobPool(sy.db, sy.cfg, child)?.cap).toBe(40);
    expect(heldRequests(sy.db, parent)).toBe(40);
  });
  it("conserves the grandparent hold when a parent allocates within its own allowance", () => {
    const { parent, child, store, submit } = setup();
    const grandchild = submit(10, child);
    recordCarve(sy!.db, { childTaskId: grandchild, parentTaskId: child, requests: 10, parentRemaining: 30, share: 0.3, depth: 2 }, Date.now());
    store.decide(file(store, grandchild, child, 5).id, { approve: true, by: child, reason: "repair", cfg: sy!.cfg });
    expect(jobPool(sy!.db, sy!.cfg, grandchild)?.cap).toBe(15);
    expect(heldRequests(sy!.db, child)).toBe(15);
    expect(heldRequests(sy!.db, parent)).toBe(30);
  });
  it("exposes upward request tool to supervisors but excludes verification purpose", () => {
    const { child } = setup();
    const env = { role: "supervisor", ctx: { taskId: child, purpose: "execution", cfg: sy!.cfg } } as unknown as HarnessEnv;
    expect(requestBudgetTool().available?.(env)).toBe(true);
    expect(requestBudgetTool().available?.({ ...env, ctx: { ...env.ctx, purpose: "verification" } })).toBe(false);
  });
  it.each([20,undefined])("supervisor tool requests external FINAL approval even when worker auto grants are enabled (amount %s)", async amount => {
    const { parent, store } = setup();
    sy!.cfg.team.budget_approver = "auto";
    const ctx = { cfg: sy!.cfg, taskId: parent, tasks: sy!.tasks, gate: sy!.gate, now: Date.now, budget: { maxModelRequests: 100 }, signal: new AbortController().signal };
    const harness = { role: "supervisor", ctx } as unknown as HarnessEnv;
    const expected=amount??sy!.cfg.supervisor.delivery_budget.extension_requests;
    const pending = requestBudgetTool().run({ ...(amount!==undefined?{requests:amount}:{}), reason: "runtime repair" }, harness);
    const request = store.list({ taskId: parent })[0]!;
    expect(request).toMatchObject({ approver: "external", status: "pending",requests:expected });
    store.decide(request.id, { approve: true, by: "external:final", reason: "go", cfg: sy!.cfg });
    expect(await pending).toContain("approved by external:final");
    expect(ctx.budget.maxModelRequests).toBe(100+expected);
  });
  it("protects both delivery supervisor and validation reserves without expanding an explicit lower cap", () => {
    setup();
    sy!.cfg.supervisor.delivery_budget.supervisor_reserve_requests = 80;
    sy!.cfg.supervisor.delivery_budget.validation_reserve_requests = 80;
    const create = (cap: number) => sy!.tasks.submit([WorkerTaskSchema.parse({ profile: "supervise", deliveryVersion: 2, goal: "deliver", constraints: { acceptanceCriteria: ["usable"] }, budget: { maxModelRequests: cap } })])[0]!.taskId;
    const delivery = create(600);
    expect(jobPool(sy!.db, sy!.cfg, delivery)).toMatchObject({ cap: 600, reserve: 160, available: 440 });
    expect(jobPool(sy!.db, sy!.cfg, create(100))).toMatchObject({ cap: 100, reserve: 160, available: 0 });
    sy!.db.prepare("INSERT INTO product_deliveries(task_id,project_id,stage,spec_json,updated_at) VALUES(?,'demo','integrate','{}',?)").run(delivery, Date.now());
    expect(jobPool(sy!.db, sy!.cfg, delivery)).toMatchObject({ cap: 600, reserve: 80, available: 520 });
    sy!.db.prepare("UPDATE product_deliveries SET stage='implement' WHERE task_id=?").run(delivery);
    expect(jobPool(sy!.db, sy!.cfg, delivery)?.reserve).toBe(160);
  });
  it("prevents planning from consuming validation reserve, then permits physical dispatch at validation", async () => {
    setup();
    sy!.cfg.supervisor.delivery_budget.supervisor_reserve_requests = 0;
    sy!.cfg.supervisor.delivery_budget.validation_reserve_requests = 1;
    const taskId = sy!.tasks.submit([WorkerTaskSchema.parse({ profile: "supervise", deliveryVersion: 2, goal: "deliver", constraints: { acceptanceCriteria: ["usable"] }, budget: { maxModelRequests: 1 } })])[0]!.taskId;
    sy!.tasks.claim("owner", { maxConcurrent: 4, maxWritersPerRepo: 4, leaseMs: 60_000, defaultTimeoutMs: 60_000, supervisorProfiles: ["supervise"], maxSupervisors: 4 });
    const lease = capturedLease(sy!.tasks.get(taskId)!);
    const request = { plan: sy!.router.plan("supervise", "T3", ["text"]), executionId: sy!.admission.createExecution("task", "supervise", [{ taskId, itemId: taskId }]), purpose: "supervision", participants: [{ taskId, leaseOwner: lease.owner, lease, budget: { maxModelRequests: 1, maxInputTokens: null, maxOutputTokens: null, maxPaidUsd: 0 } }], chat: { messages: [{ role: "user" as const, content: "plan" }], max_tokens: 10 } };
    await expect(sy!.gate.request(request)).rejects.toThrow(/supervisor_validation_reserve_protected/);
    expect(sy!.db.prepare("SELECT COUNT(*) FROM model_requests").pluck().get()).toBe(0);
    sy!.db.prepare("INSERT INTO product_deliveries(task_id,project_id,stage,spec_json,updated_at) VALUES(?,'demo','validate','{}',?)").run(taskId, Date.now());
    expect((await sy!.gate.request(request)).requestId).toBeTruthy();
  });
});
