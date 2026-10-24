import { afterEach, describe, expect, it } from "vitest";
import { acknowledgeModelQuarantine } from "../src/admin/quarantine.js";
import { GatewayError } from "../src/core/errors.js";
import { ProviderError } from "../src/providers/errors.js";
import { Admission } from "../src/admission/admission.js";
import { openDatabase } from "../src/storage/db.js";
import { TaskStore } from "../src/storage/tasks.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import type { MeritRouter } from "../src/core/service.js";
import { baseConfig, endpoint, goodOutput, makeEnv, open, reply, ScriptedClient, servedFor, summarizeTask, type Env } from "./helpers.js";

let env: Env | undefined;
let sy: MeritRouter | undefined;
afterEach(async () => {
  await sy?.close();
  sy = undefined;
  env?.cleanup();
});

/** Reply as whichever endpoint the request targeted. */
function asServed(get: () => MeritRouter, content: (n: number, req: Parameters<ScriptedClient["handler"]>[0]) => string) {
  return new ScriptedClient((req, n) => reply(content(n, req), servedFor(get(), req)));
}

describe("completion tasks", () => {
  it("runs end to end with evidence, usage, classification and routing recorded", async () => {
    env = makeEnv();
    const client = asServed(() => sy!, () => JSON.stringify(goodOutput()));
    sy = open(env, client, { worker: true });
    const [sub] = await sy.submitTasks([summarizeTask()]);
    const out = await sy.awaitResults([sub!.taskId], { timeoutSeconds: 10 });
    expect(out.timedOut).toBe(false);
    const r = out.completed[0]!;
    expect(r.executionStatus).toBe("completed");
    expect(r.acceptanceStatus).toBe("not_verified");
    expect(r.usage).toMatchObject({ modelRequests: 1, inputTokens: 100, outputTokens: 50, tokenUsageBasis: "provider_reported", estimatedCostUsd: 0 });
    expect(r.servedEndpoints).toEqual(["openrouter/vendor/big-a:free"]);
    expect(r.classification).toMatchObject({ tier: "T1", basis: "rules" });
    expect(r.routing?.attempts).toEqual([{ endpointId: "openrouter/vendor/big-a:free", outcome: "succeeded" }]);
    // Sent directly to the provider with the provider's model id and the configured key.
    expect(client.requests[0]).toMatchObject({ provider: "openrouter", model: "vendor/big-a:free", key: "test-openrouter-key" });
  });

  it("idempotency keys deduplicate resubmission and reject a different spec", async () => {
    env = makeEnv();
    sy = open(env, new ScriptedClient(() => reply("{}")));
    const a = await sy.submitTasks([summarizeTask({ idempotencyKey: "k1" })]);
    const b = await sy.submitTasks([summarizeTask({ idempotencyKey: "k1" })]);
    expect(b[0]).toMatchObject({ taskId: a[0]!.taskId, deduplicated: true });
    await expect(sy.submitTasks([summarizeTask({ idempotencyKey: "k1", goal: "different" })])).rejects.toThrow(/different task/);
  });

  it("retries invalid output within budget and fails with a typed reason after", async () => {
    env = makeEnv();
    const client = asServed(() => sy!, () => "not json at all");
    sy = open(env, client, { worker: true });
    const [sub] = await sy.submitTasks([summarizeTask()]);
    const r = (await sy.awaitResults([sub!.taskId], { timeoutSeconds: 10 })).completed[0]!;
    expect(r.executionStatus).toBe("failed");
    expect(r.stopReason).toBe("invalid_output");
    // One repair attempt at T1 (max_invalid_output_retries=1), then one escalation to T2.
    expect(client.requests).toHaveLength(4);
    expect(r.routing).toMatchObject({ tier: "T2", escalatedFrom: "T1" });
    expect(r.usage.modelRequests).toBe(4);
  });

  it("does not escalate when no model qualifies for the next tier", async () => {
    env = makeEnv({ endpoints: [endpoint({ totalParametersB: 40 })] });
    const client = asServed(() => sy!, () => "not json at all");
    sy = open(env, client, { worker: true });
    const [sub] = await sy.submitTasks([summarizeTask()]);
    const r = (await sy.awaitResults([sub!.taskId], { timeoutSeconds: 10 })).completed[0]!;
    expect(client.requests).toHaveLength(2);
    expect(r.routing).toMatchObject({ tier: "T1", escalatedFrom: null });
  });
});

describe("routing fallback and policy", () => {
  it("falls back to the next ranked model on capacity errors, each attempt counted", async () => {
    // A 429 cools that provider key, so the next model is on another provider.
    env = makeEnv({ endpoints: [endpoint({ gatewayModelId: "first", totalParametersB: 40 }), endpoint({ providerId: "groq", gatewayModelId: "second", totalParametersB: 70 })] });
    const client = new ScriptedClient((req) => {
      const s = servedFor(sy!, req);
      if (s.model === "first") throw new GatewayError("rate_limited", "429", 429, 1000, false);
      return reply(JSON.stringify(goodOutput()), s);
    });
    sy = open(env, client, { worker: true });
    const [sub] = await sy.submitTasks([summarizeTask()]);
    const r = (await sy.awaitResults([sub!.taskId], { timeoutSeconds: 10 })).completed[0]!;
    expect(r.executionStatus).toBe("completed");
    expect(r.routing?.attempts.map((a) => `${a.endpointId.split("/").pop()}:${a.outcome}`)).toEqual(["first:rate_limited", "second:succeeded"]);
    expect(r.usage.modelRequests).toBe(2);
    expect(r.servedEndpoints).toEqual(["groq/second"]);
  });

  it("skips a model whose context cannot hold the request and uses one that can", async () => {
    env = makeEnv({ endpoints: [endpoint({ gatewayModelId: "tiny-ctx", totalParametersB: 40, contextLimitTokens: 1500 }), endpoint({ gatewayModelId: "wide", totalParametersB: 70, contextLimitTokens: 64000 })] });
    const client = asServed(() => sy!, () => JSON.stringify(goodOutput()));
    sy = open(env, client, { worker: true });
    const [sub] = await sy.submitTasks([summarizeTask({ context: { inlineText: "x".repeat(6000) } })]);
    const r = (await sy.awaitResults([sub!.taskId], { timeoutSeconds: 10 })).completed[0]!;
    expect(r.servedEndpoints).toEqual(["openrouter/wide"]);
    expect(r.routing!.attempts[0]!.outcome).toMatch(/skipped \(too large\)/);
    expect(r.usage.modelRequests).toBe(1);
  });

  it("exhausting every approved model queues the task and never routes elsewhere", async () => {
    env = makeEnv({ endpoints: [endpoint({ gatewayModelId: "only" }), endpoint({ gatewayModelId: "small", totalParametersB: 7 })] });
    const client = new ScriptedClient(() => {
      throw new GatewayError("pool_exhausted", "all keys cooling down", 429, 60_000, false);
    });
    sy = open(env, client, { worker: true });
    const [sub] = await sy.submitTasks([summarizeTask()]);
    await expect.poll(() => sy!.getStatus([sub!.taskId])[0]?.state, { timeout: 5000, interval: 25 }).toBe("waiting_for_capacity");
    const targeted = new Set(client.requests.map((r) => `${r.provider}/${r.model}`));
    expect([...targeted]).toEqual(["openrouter/only"]);
  });

  it("fails an exhausted model-plan refusal instead of waiting for temporary capacity", async () => {
    env = makeEnv();
    const refusal = "this model is not included in your free usage, add usage credits to pay as you go. Try gemma4:31b-cloud, which is in the Free plan.";
    const client = new ScriptedClient(() => {
      throw new ProviderError("not_in_plan", `ollama-cloud HTTP 402: ${refusal} (model not in this key's plan)`, {
        provider: "ollama-cloud",
        status: 402,
        possiblyConsumed: false,
      });
    });
    sy = open(env, client, { worker: true });

    const [sub] = await sy.submitTasks([summarizeTask()]);
    const result = (await sy.awaitResults([sub!.taskId], { timeoutSeconds: 10 })).completed[0]!;

    expect(result.executionStatus).toBe("failed");
    expect(result.stopReason).toMatch(/^gateway_not_in_plan: /);
    expect(result.stopReason).toContain("model not in this key's plan");
  });

  it("a served-model mismatch discards the response, fails the task, and quarantines the model", async () => {
    env = makeEnv();
    const client = new ScriptedClient(() => reply(JSON.stringify(goodOutput()), { model: "other/model", provider: "kilo" }));
    sy = open(env, client, { worker: true });
    const [sub] = await sy.submitTasks([summarizeTask()]);
    const r = (await sy.awaitResults([sub!.taskId], { timeoutSeconds: 10 })).completed[0]!;
    expect(r.stopReason).toMatch(/gateway_policy_violation/);
    expect(sy.gate.quarantined(sy.catalog.get("openrouter/vendor/big-a:free")!)).toMatch(/quarantined/);
    const [sub2] = await sy.submitTasks([summarizeTask({ goal: "again" })]);
    const r2 = (await sy.awaitResults([sub2!.taskId], { timeoutSeconds: 10 })).completed[0]!;
    expect(r2.stopReason).toMatch(/no_eligible_endpoint/);
    expect(client.requests).toHaveLength(1);
    const endpointId = "openrouter/vendor/big-a:free";
    expect(() => acknowledgeModelQuarantine(sy!, endpointId, { actor: "human:test", reason: " " })).toThrow();
    expect(sy.gate.quarantined(sy.catalog.get(endpointId)!)).toMatch(/quarantined/);
    const ack = acknowledgeModelQuarantine(sy, endpointId, { actor: "human:test", reason: "Provider configuration corrected; permit one retry" });
    expect(sy.gate.quarantined(sy.catalog.get(endpointId)!)).toBeNull();
    expect(sy.db.prepare("SELECT policy_violation FROM model_requests WHERE id = ?").get(ack.requestId)).toMatchObject({ policy_violation: expect.any(String) });
    expect(() => acknowledgeModelQuarantine(sy!, endpointId, { actor: "human:test", reason: "stale" })).toThrow(/no pending quarantine/);
    const [retry] = await sy.submitTasks([summarizeTask({ goal: "retry after acknowledgement" })]);
    await sy.awaitResults([retry!.taskId], { timeoutSeconds: 10 });
    expect(client.requests).toHaveLength(2);
    expect(sy.gate.quarantined(sy.catalog.get(endpointId)!)).toMatch(/quarantined/);
  });
});

describe("batching", () => {
  it("batches compatible tasks, counts the physical request once, and retries only missing items", async () => {
    env = makeEnv({ config: baseConfig({ execution: { max_concurrent_tasks: 1, lease_seconds: 30 } }) });
    let call = 0;
    const client = new ScriptedClient((req) => {
      call++;
      const ids = [...String((req.messages[1] as { content: string }).content).matchAll(/<item id="(i\d+)">/g)].map((m) => m[1]!);
      // First round: answer only the first item and invent one; second round answers the rest.
      const items = call === 1 ? [{ id: ids[0], result: goodOutput() }, { id: "i99", result: goodOutput() }] : ids.map((id) => ({ id, result: goodOutput() }));
      return reply(JSON.stringify({ items }), servedFor(sy!, req));
    });
    sy = open(env, client);
    const subs = await sy.submitTasks([summarizeTask({ goal: "a" }), summarizeTask({ goal: "b" }), summarizeTask({ goal: "c" })]);
    sy.recover();
    const ids = subs.map((s) => s.taskId);
    // Start the worker only after all three are queued so they share one batch.
    (sy as unknown as { startWorker: (n: number) => void }).startWorker(50);
    const out = await sy.awaitResults(ids, { timeoutSeconds: 10 });
    expect(out.completed.map((r) => r.executionStatus)).toEqual(["completed", "completed", "completed"]);
    expect(client.requests).toHaveLength(2);
    const second = String((client.requests[1]!.messages[1] as { content: string }).content);
    expect(second).not.toContain('<item id="i1">');
    const usage = sy.usage(0);
    expect(usage.modelRequests).toBe(2);
    const first = out.completed.find((r) => r.usage.modelRequests === 1)!;
    expect(first.usage.tokenUsageBasis).toBe("estimated");
    expect(first.usage.batchId).toMatch(/^b_/);
    const retried = out.completed.filter((r) => r.usage.modelRequests === 2);
    expect(retried).toHaveLength(2);
  });
});

describe("dependencies, cancellation, restart", () => {
  it("a dependent waits for its prerequisite and fails when the prerequisite fails", async () => {
    env = makeEnv();
    sy = open(env, asServed(() => sy!, () => "garbage"), { worker: true });
    const subs = await sy.submitTasks([summarizeTask({ id: "pre" }), summarizeTask({ id: "dep", goal: "after", dependsOn: ["pre"] })]);
    expect(subs[1]!.state).toBe("waiting_for_dependencies");
    const out = await sy.awaitResults(["pre", "dep"], { timeoutSeconds: 10 });
    const dep = out.completed.find((r) => r.taskId === "dep")!;
    expect(dep.stopReason).toBe("dependency_failed:pre:failed");
    expect(dep.usage.modelRequests).toBe(0);
  });

  it("a late successful response cannot turn a cancelled task into a completed one", async () => {
    env = makeEnv();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const client = new ScriptedClient(async (req) => {
      await gate;
      return reply(JSON.stringify(goodOutput()), servedFor(sy!, req));
    });
    sy = open(env, client, { worker: true });
    const [sub] = await sy.submitTasks([summarizeTask()]);
    while (client.requests.length === 0) await new Promise((r) => setTimeout(r, 20));
    sy.cancelTasks([sub!.taskId]);
    release();
    const r = (await sy.awaitResults([sub!.taskId], { timeoutSeconds: 10 })).completed[0]!;
    expect(r.executionStatus).toBe("cancelled");
    expect(sy.getStatus([sub!.taskId])[0]).toMatchObject({ state: "cancelled" });
  });

  it("expired leases become interrupted; read-only and coding work both resume", async () => {
    env = makeEnv();
    let t = Date.now();
    const db = openDatabase(env.cfg.storageDir);
    const store = new TaskStore(db, () => t);
    const parse = (x: unknown) => WorkerTaskSchema.parse(x);
    store.submit([parse({ ...summarizeTask(), id: "ro" }), parse({ profile: "implement", id: "code", goal: "edit", repositoryAliases: ["core"], writableRepository: "core", constraints: { acceptanceCriteria: ["x"], allowedPaths: ["src/**"] } })]);
    store.claim("dead-worker", { maxConcurrent: 5, maxWritersPerRepo: 1, leaseMs: 1000, defaultTimeoutMs: 60_000 });
    t += 5000;
    db.close();
    sy = open(env, new ScriptedClient(() => reply("{}")), { now: () => t });
    sy.recover();
    // Coding work resumes too (S2): its next run continues its session in the same worktree.
    expect(sy.getStatus(["ro", "code"]).map((s) => s.state)).toEqual(["queued", "queued"]);
  });
});

describe("admission", () => {
  it("two processes cannot both take the final request in a task budget", () => {
    env = makeEnv();
    const dbA = openDatabase(env.cfg.storageDir);
    const dbB = openDatabase(env.cfg.storageDir);
    const storeA = new TaskStore(dbA);
    storeA.submit([WorkerTaskSchema.parse({ ...summarizeTask(), id: "t1" })]);
    storeA.claim("w", { maxConcurrent: 1, maxWritersPerRepo: 1, leaseMs: 60_000, defaultTimeoutMs: 60_000 });
    const a = new Admission(dbA, storeA, env.cfg);
    const b = new Admission(dbB, new TaskStore(dbB), env.cfg);
    const exec = a.createExecution("task", "summarize", [{ taskId: "t1", itemId: "t1" }]);
    const req = (adm: Admission) =>
      adm.reserve({
        executionId: exec,
        profile: "summarize",
        purpose: "test",
        gatewayModel: "auto:x",
        endpointId: null,
        tier: "T1",
        estInputTokens: 10,
        reservedOutputTokens: 10,
        participants: [{ taskId: "t1", leaseOwner: "w", budget: { maxModelRequests: 1, maxInputTokens: null, maxOutputTokens: null, maxPaidUsd: 0 }, estInputTokens: 10, reservedOutputTokens: 10 }],
      });
    req(a);
    expect(() => req(b)).toThrow(/used 1\/1 model requests/);
    dbA.close();
    dbB.close();
  });

  it("package allocation caps requests across tasks", async () => {
    env = makeEnv({ config: baseConfig({ allocation: { max_model_requests_per_hour: 1 }, execution: { on_capacity_exhausted: "fail", lease_seconds: 30 } }) });
    sy = open(env, asServed(() => sy!, () => JSON.stringify(goodOutput())), { worker: true });
    const [a] = await sy.submitTasks([summarizeTask({ goal: "one" })]);
    await sy.awaitResults([a!.taskId], { timeoutSeconds: 10 });
    const [b] = await sy.submitTasks([summarizeTask({ goal: "two" })]);
    const r = (await sy.awaitResults([b!.taskId], { timeoutSeconds: 10 })).completed[0]!;
    expect(r.stopReason).toMatch(/capacity_exhausted: package allocation of 1 requests\/hour/);
  });

  it("awaiting a long job does not issue extra model requests", async () => {
    env = makeEnv();
    const client = new ScriptedClient(async (req) => {
      await new Promise((r) => setTimeout(r, 300));
      return reply(JSON.stringify(goodOutput()), servedFor(sy!, req));
    });
    sy = open(env, client, { worker: true });
    const [sub] = await sy.submitTasks([summarizeTask()]);
    await sy.awaitResults([sub!.taskId], { timeoutSeconds: 10 });
    expect(client.requests).toHaveLength(1);
  });
});
