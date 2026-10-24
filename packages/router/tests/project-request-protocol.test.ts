import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import type { MeritRouter } from "../src/core/service.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { capturedLease } from "../src/storage/task-leases.js";
import { RequestPersistenceError } from "../src/admission/request-ledger.js";
import { RequestReceipts } from "../src/admission/request-receipts.js";
import { deleteProject, previewProjectDeletion } from "../src/admin/insights.js";
import { baseConfig, endpoint, makeEnv, open, reply, ScriptedClient, summarizeTask, type Env } from "./helpers.js";

let env: Env | undefined, sy: MeritRouter | undefined;
afterEach(async () => { await sy?.close(); vi.restoreAllMocks(); env?.cleanup(); sy = undefined; env = undefined; });
function setup() {
  env = makeEnv({ endpoints: [endpoint()], config: baseConfig({ repositories: {},
    brain: { project: "alpha", path: "brain" }, projects: {
      alpha: { repositories: { app: { path: "repo" } } }, beta: { repositories: { app: { path: "repo" } } },
    }, team: { provider_concurrency_start: 1, provider_concurrency_max: 1 },
  }) });
  const client = new ScriptedClient(req => reply("fixture", { model: req.model, provider: req.provider }));
  sy = open(env, client, { worker: false });
  sy.tasks.submit([WorkerTaskSchema.parse(summarizeTask({ id: "delete-request" }))], { project: "beta" });
  sy.tasks.claim("fixture", { maxConcurrent: 1, maxWritersPerRepo: 1, leaseMs: 60000, defaultTimeoutMs: 60000 });
  const lease = capturedLease(sy.tasks.get("delete-request")!);
  return { client, lease, request: {
    plan: sy.router.plan("summarize", "T1", ["text"]),
    executionId: sy.admission.createExecution("task", "summarize", [{ taskId: lease.taskId, itemId: "1" }]),
    purpose: "fixture", participants: [{ taskId: lease.taskId, leaseOwner: lease.owner, lease,
      budget: { maxModelRequests: 8, maxInputTokens: null, maxOutputTokens: null, maxPaidUsd: null } }],
    chat: { messages: [{ role: "user" as const, content: "private deletion fixture" }], max_tokens: 100 },
  } };
}
function terminal() { sy!.db.prepare("UPDATE tasks SET state='failed' WHERE id='delete-request'").run(); }
async function deleted() {
  terminal();
  expect((await previewProjectDeletion(sy!, "beta")).blockers).toEqual([]);
  expect((await deleteProject(sy!, "beta", { confirm: "beta" })).problems).toEqual([]);
  expect(sy!.tasks.get("delete-request")).toBeUndefined();
  expect(readFileSync(env!.cfg.configPath, "utf8")).not.toContain("beta:");
  expect(sy!.db.prepare("SELECT uncertain,task_id,lease_json FROM provider_slots WHERE kind='request'").get()).toEqual({ uncertain: 1, task_id: "", lease_json: "[]" });
  expect(sy!.db.pragma("foreign_key_check")).toEqual([]);
}
it.each(["reserve", "beginDispatch"] as const)("deletes private scope and retains transport quarantine after lost %s acknowledgement", async stage => {
  const { request, client } = setup(), ledger = sy!.gate.ledger;
  if (stage === "reserve") {
    const original = ledger.reserve.bind(ledger);
    vi.spyOn(ledger, "reserve").mockImplementation(async input => { await original(input); throw Error("lost ACK"); });
  } else {
    const original = ledger.beginDispatch.bind(ledger);
    vi.spyOn(ledger, "beginDispatch").mockImplementation(async (...args) => { await original(...args); throw Error("lost ACK"); });
  }
  await expect(sy!.gate.request(request)).rejects.toBeInstanceOf(RequestPersistenceError);
  expect(client.requests).toHaveLength(0);
  expect(new RequestReceipts(sy!.db).blockers("beta")).toEqual({ requests: 1, slots: 1 });
  await deleted();
});
it("retains independent uncertain transport authority even when accounting settled", async () => {
  const { request, lease } = setup();
  await sy!.gate.request(request);
  sy!.db.prepare("INSERT INTO provider_slots(id,platform,kind,holder,task_id,lease_owner,priority,since,seen_at,lease_json,nonce,uncertain) VALUES('uncertain','fixture','request','holder',?,?,0,1,1,?,'nonce',1)")
    .run(lease.taskId, lease.owner, JSON.stringify([lease]));
  expect(new RequestReceipts(sy!.db).blockers("beta")).toEqual({ requests: 0, slots: 1 });
  await deleted();
});
it("purges settled private bindings while preserving accounting and consumed request IDs", async () => {
  const { request } = setup();
  const response = await sy!.gate.request(request);
  terminal();
  expect((await previewProjectDeletion(sy!, "beta")).blockers).toEqual([]);
  expect((await deleteProject(sy!, "beta", { confirm: "beta" })).problems).toEqual([]);
  expect(sy!.db.prepare("SELECT 1 FROM request_protocol WHERE request_id=?").get(response.requestId)).toBeUndefined();
  expect(sy!.db.prepare("SELECT 1 FROM request_protocol_keys WHERE id=?").get(response.requestId)).toBeDefined();
  expect(sy!.db.prepare("SELECT project_id FROM model_requests WHERE id=?").get(response.requestId)).toEqual({ project_id: "" });
  expect(sy!.projects.get("alpha")).toBeDefined();
  expect(sy!.db.pragma("foreign_key_check")).toEqual([]);
});
