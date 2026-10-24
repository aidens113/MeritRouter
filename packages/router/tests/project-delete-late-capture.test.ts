import { afterEach, expect, it } from "vitest";
import { WorkerTaskSchema } from "../src/core/task.js";
import type { MeritRouter } from "../src/core/service.js";
import { capturedLease } from "../src/storage/task-leases.js";
import { RequestCaptures } from "../src/storage/request-captures.js";
import { projectCaptureInput } from "../src/gateway/request-capture.js";
import { purgeProjectRows } from "../src/projects/deletion.js";
import { baseConfig, endpoint, makeEnv, open, reply, ScriptedClient, summarizeTask, type Env } from "./helpers.js";

let env: Env | undefined, sy: MeritRouter | undefined;
afterEach(async () => { await sy?.close(); sy = undefined; env?.cleanup(); env = undefined; });
const projection = () => projectCaptureInput("fixture", { messages: [{ role: "user", content: "late private prompt" }], max_tokens: 10 });

it("actual project purge prevents normal and empty-participant late capture resurrection while genuine global requests work", async () => {
  env = makeEnv({ endpoints: [endpoint()], config: baseConfig({ repositories: {}, brain: { project: "alpha", path: "brain" }, projects: { alpha: {}, beta: {} } }) });
  sy = open(env, new ScriptedClient(req => reply("private response", { model: req.model, provider: req.provider })), { worker: false });
  sy.tasks.submit([WorkerTaskSchema.parse(summarizeTask({ id: "purged-capture" }))], { project: "beta" });
  sy.tasks.claim("owner", { maxConcurrent: 1, maxWritersPerRepo: 1, leaseMs: 60000, defaultTimeoutMs: 60000 });
  const lease = capturedLease(sy.tasks.get("purged-capture")!);
  const result = await sy.gate.request({
    plan: sy.router.plan("summarize", "T1", ["text"]),
    executionId: sy.admission.createExecution("task", "summarize", [{ taskId: lease.taskId, itemId: "1" }]), purpose: "fixture",
    participants: [{ taskId: lease.taskId, leaseOwner: lease.owner, lease, budget: { maxModelRequests: 8, maxInputTokens: null, maxOutputTokens: null, maxPaidUsd: null } }],
    chat: { messages: [{ role: "user", content: "private original" }], max_tokens: 10 },
  });
  sy.db.prepare("UPDATE tasks SET state='completed' WHERE id=?").run(lease.taskId);
  expect(purgeProjectRows(sy.db, "beta", ["running"])).toMatchObject({ tasks: 1 });
  const captures = new RequestCaptures(sy.db);
  await expect(captures.begin(result.requestId, projection(), [lease.taskId])).rejects.toThrow(/purged/);
  await expect(captures.begin(result.requestId, projection(), [])).rejects.toThrow(/purged/);
  expect(sy.db.prepare("SELECT COUNT(*) FROM request_captures WHERE request_id=?").pluck().get(result.requestId)).toBe(0);

  const global = sy.admission.reserve({ executionId: sy.admission.createExecution("task", "summarize", []), profile: "summarize", purpose: "fixture", gatewayModel: "fixture", endpointId: "fixture", tier: "T1", estInputTokens: 10, reservedOutputTokens: 10, participants: [] });
  await captures.begin(global.requestId, projection(), []);
  expect(captures.read(global.requestId, { project: null })?.input?.messages[0]?.content).toBe("late private prompt");
});
