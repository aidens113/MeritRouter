import { afterEach, expect, it } from "vitest";
import { deliveryReserves } from "../src/admission/delivery-reserves.js";
import { BudgetRequests, jobPool, protectedValidationRequests } from "../src/admission/budget-requests.js";
import { recordGrant } from "../src/admission/job-pool.js";
import { ConfigSchema } from "../src/config/schema.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { capturedLease } from "../src/storage/task-leases.js";
import type { MeritRouter } from "../src/core/service.js";
import { baseConfig, makeEnv, open, reply, ScriptedClient, type Env } from "./helpers.js";

const policy = { reserve_mode: "proportional" as const, total_requests: 400,
  supervisor_reserve_requests: 60, validation_reserve_requests: 60 };

it.each([
  [252, 38], [100, 15], [1, 1], [400, 60], [401, 60], [null, 60],
] as const)("allocates both reserves for cap %s without changing their nominal settings", (cap, expected) => {
  expect(deliveryReserves(policy, cap)).toEqual({ supervisor: expected, validation: expected });
  expect(policy.supervisor_reserve_requests).toBe(60);
});
it("retains explicit fixed counts and zero/unequal reserves", () => {
  expect(deliveryReserves({ ...policy, reserve_mode: "fixed" }, 1)).toEqual({ supervisor: 60, validation: 60 });
  expect(deliveryReserves({ ...policy, supervisor_reserve_requests: 0, validation_reserve_requests: 1 }, 1))
    .toEqual({ supervisor: 0, validation: 1 });
});
it("rounds safe integer products exactly even when a Number product would lose a request", () => {
  expect(deliveryReserves({ ...policy, total_requests: 9007199254740991,
    supervisor_reserve_requests: 9007199254740989, validation_reserve_requests: 0 }, 4503599627370495))
    .toEqual({ supervisor: 4503599627370495, validation: 0 });
});
it("validates the allocation mode and defaults new configurations to proportional", () => {
  expect(ConfigSchema.parse(baseConfig()).supervisor.delivery_budget.reserve_mode).toBe("proportional");
  expect(ConfigSchema.safeParse(baseConfig({ supervisor: { delivery_budget: { reserve_mode: "ignore" } } })).success).toBe(false);
  expect(() => deliveryReserves(policy, Number.MAX_SAFE_INTEGER + 1)).toThrow();
});

let env: Env | undefined, sy: MeritRouter | undefined;
afterEach(async () => { await sy?.close(); sy = undefined; env?.cleanup(); env = undefined; });
function setup() {
  const config = baseConfig({ paid: { enabled: false }, verification: { max_total_requests_per_task: null },
    supervisor: { delivery_budget: policy }, team: { supervisor_reserve_requests: 4 } });
  (config.profiles as Record<string, unknown>).supervise = { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100, max_model_requests: null };
  env = makeEnv({ config }); const client = new ScriptedClient(() => reply("unused"));
  sy = open(env, client, { worker: false });
  const submit = (id: string, cap?: number, version: 1 | 2 = 2, parentTaskId?: string) => sy!.tasks.submit([
    WorkerTaskSchema.parse({ id, profile: parentTaskId ? "inspect" : "supervise", ...(version === 2 ? { deliveryVersion: 2 } : {}),
      ...(parentTaskId ? { parentTaskId } : {}), goal: "deliver", constraints: { acceptanceCriteria: ["usable"] },
      budget: { ...(cap === undefined ? {} : { maxModelRequests: cap }), maxPaidUsd: 0 } }),
  ])[0]!.taskId;
  let next = 0;
  const charge = (taskId: string, count: number) => {
    const execution = sy!.admission.createExecution("task", "supervise", [{ taskId, itemId: taskId }]);
    for (let i = 0; i < count; i++) {
      const id = `charged-${next++}`;
      sy!.db.prepare("INSERT INTO model_requests(id,execution_id,purpose,gateway_model,status,reserved_at,est_input_tokens,reserved_output_tokens) VALUES(?,?,'fixture','fake','succeeded',?,1,1)").run(id, execution, Date.now());
      sy!.db.prepare("INSERT INTO request_charges(request_id,task_id,input_tokens,output_tokens) VALUES(?,?,1,1)").run(id, taskId);
    }
  };
  return { client, submit, charge };
}

it("makes the smaller job's unused capacity delegatable while retaining charges, holds, paid caps and atomic grant limits", () => {
  const { submit, charge } = setup(), job = submit("job", 252), child = submit("child", 80, 1, job);
  charge(job, 51); recordGrant(sy!.db, { taskId: child, jobId: job, requests: 80, source: "supervisor" }, Date.now());
  const charged = JSON.stringify(sy!.db.prepare("SELECT * FROM request_charges ORDER BY request_id").all());
  expect(jobPool(sy!.db, sy!.cfg, job)).toMatchObject({ cap: 252, used: 51, held: 80, reserve: 76, available: 45 });
  expect(protectedValidationRequests(sy!.db, sy!.cfg, job)).toBe(38);
  const store = new BudgetRequests(sy!.db);
  const ask = (requests: number) => store.file({ taskId: child, jobId: job, role: "inspector", requests,
    reason: "bounded remaining work", used: 0, cap: 80, approver: "external" });
  const tooLarge = ask(46);
  expect(() => store.decide(tooLarge.id, { approve: true, by: "external:final", reason: "reviewed", cfg: sy!.cfg })).toThrow(/does not fit/);
  const exact = ask(45);
  store.decide(exact.id, { approve: true, by: "external:final", reason: "reviewed", cfg: sy!.cfg });
  expect(jobPool(sy!.db, sy!.cfg, job)).toMatchObject({ cap: 252, used: 51, held: 125, reserve: 76, available: 0 });
  expect(() => store.decide(exact.id, { approve: true, by: "external:final", reason: "duplicate", cfg: sy!.cfg })).toThrow(/already approved/);
  expect(JSON.stringify(sy!.db.prepare("SELECT * FROM request_charges ORDER BY request_id").all())).toBe(charged);
  expect(sy!.tasks.get(job)!.spec.budget).toMatchObject({ maxModelRequests: 252, maxPaidUsd: 0 });
  expect(sy!.tasks.get(child)!.spec.budget?.maxPaidUsd).toBe(0);
});

it("uses profile/verification narrowing and explicit approved extensions once in both protections", () => {
  const { submit } = setup(), job = submit("job", 400);
  sy!.cfg.profiles.supervise!.max_model_requests = 252;
  expect(jobPool(sy!.db, sy!.cfg, job)).toMatchObject({ cap: 252, reserve: 76 });
  expect(protectedValidationRequests(sy!.db, sy!.cfg, job)).toBe(38);
  sy!.cfg.profiles.supervise!.max_model_requests = null;
  sy!.cfg.verification.max_total_requests_per_task = 252;
  expect(jobPool(sy!.db, sy!.cfg, job)).toMatchObject({ cap: 252, reserve: 76 });
  const store = new BudgetRequests(sy!.db);
  const request = store.file({ taskId: job, jobId: null, role: "supervisor", requests: 20, reason: "explicit extra work", used: 0, cap: 252, approver: "external" });
  store.decide(request.id, { approve: true, by: "external:final", reason: "authorized", cfg: sy!.cfg });
  expect(jobPool(sy!.db, sy!.cfg, job)).toMatchObject({ cap: 272, reserve: 82, available: 190 });
  expect(protectedValidationRequests(sy!.db, sy!.cfg, job)).toBe(41);
});

it("keeps legacy team-only reserves, uncapped nominal reserves and the team minimum", () => {
  const { submit } = setup();
  expect(jobPool(sy!.db, sy!.cfg, submit("legacy", 252, 1))).toMatchObject({ reserve: 4, available: 248 });
  expect(jobPool(sy!.db, sy!.cfg, submit("uncapped"))).toMatchObject({ cap: null, reserve: 120, available: null });
  sy!.cfg.supervisor.delivery_budget.supervisor_reserve_requests = 0;
  sy!.cfg.supervisor.delivery_budget.validation_reserve_requests = 0;
  expect(jobPool(sy!.db, sy!.cfg, submit("small", 1))).toMatchObject({ cap: 1, reserve: 4, available: 0 });
});

it("physically protects the same scaled validation headroom, releases it at validation and still enforces the exact aggregate cap", async () => {
  const { submit, charge, client } = setup(), taskId = submit("job", 252);
  charge(taskId, 214);
  sy!.tasks.claim("owner", { maxConcurrent: 4, maxWritersPerRepo: 4, leaseMs: 60000, defaultTimeoutMs: 60000,
    supervisorProfiles: ["supervise"], maxSupervisors: 4 });
  const lease = capturedLease(sy!.tasks.get(taskId)!);
  const request = { plan: sy!.router.plan("supervise", "T3", ["text"]),
    executionId: sy!.admission.createExecution("task", "supervise", [{ taskId, itemId: taskId }]), purpose: "supervision",
    participants: [{ taskId, leaseOwner: lease.owner, lease, budget: { maxModelRequests: 252, maxInputTokens: null, maxOutputTokens: null, maxPaidUsd: 0 } }],
    chat: { messages: [{ role: "user" as const, content: "validate" }], max_tokens: 10 } };
  await expect(sy!.gate.request(request)).rejects.toThrow(/supervisor_validation_reserve_protected/);
  expect(client.requests).toHaveLength(0);
  expect(sy!.db.prepare("SELECT COUNT(*) FROM model_requests").pluck().get()).toBe(214);
  sy!.db.prepare("INSERT INTO product_deliveries(task_id,project_id,stage,spec_json,updated_at) VALUES(?,'demo','validate','{}',?)").run(taskId, Date.now());
  expect(protectedValidationRequests(sy!.db, sy!.cfg, taskId)).toBe(0);
  expect((await sy!.gate.request(request)).requestId).toBeTruthy();
  expect(client.requests).toHaveLength(1);
  sy!.db.prepare("UPDATE product_deliveries SET stage='implement' WHERE task_id=?").run(taskId);
  expect(protectedValidationRequests(sy!.db, sy!.cfg, taskId)).toBe(38);
  await expect(sy!.gate.request(request)).rejects.toThrow(/supervisor_validation_reserve_protected/);
  sy!.db.prepare("UPDATE product_deliveries SET stage='validate' WHERE task_id=?").run(taskId);
  charge(taskId, 37);
  await expect(sy!.gate.request(request)).rejects.toMatchObject({ reason: "task_request_budget_exhausted" });
  expect(sy!.db.prepare("SELECT COUNT(*) FROM request_charges WHERE task_id=?").pluck().get(taskId)).toBe(252);
  expect(client.requests).toHaveLength(1);
});
