import { afterEach, describe, expect, it } from "vitest";
import type { MeritRouter } from "../src/core/service.js";
import { baseConfig, directEndpoint, FakeProvider, makeEnv, open, providerChat, providerJson, summarizeTask, type Env } from "./helpers.js";
let env: Env | undefined, sy: MeritRouter | undefined;
afterEach(async () => { await sy?.close(); sy = undefined; env?.cleanup(); env = undefined; });
function setup(respond: ConstructorParameters<typeof FakeProvider>[0], options: { budget?: number; paid?: boolean; secondKey?: boolean } = {}) {
  const config = baseConfig({ providers: { acme: { base_url: "https://api.acme.test/v1", keys: [{ label: "fixture", api_key: "test-acme", billing_class: "free_tier" }, ...(options.secondKey ? [{ label: "second", api_key: "test-second", billing_class: "free_tier" }] : [])] } }, routing: { max_endpoint_fallbacks: 3 }, paid: { enabled: false } });
  if (options.budget) config.profiles.summarize.max_model_requests = options.budget;
  const endpoints = ["a-rollout", "b-plan", "c-missing", "d-rollout", "e-healthy"].map((id, i) => directEndpoint("acme", id, { totalParametersB: 120 + i }));
  if (options.paid) endpoints.push(directEndpoint("acme", "f-paid", { totalParametersB: 200, pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2, freeVerified: false } }));
  env = makeEnv({ config, endpoints });
  const fake = new FakeProvider(respond);
  sy = open(env, fake, { worker: options.budget !== undefined });
  return fake;
}
function request() {
  const plan = sy!.router.plan("summarize", "T1", ["text"]);
  return sy!.gate.request({ plan, executionId: sy!.admission.createExecution("task", "summarize", []), purpose: "fixture", participants: [], chat: { messages: [{ role: "user", content: "summarize" }], max_tokens: 100 } });
}
const refusal = (model: string) => model === "b-plan" ? providerJson({ error: "this model is not included in your free usage" }, 402)
  : model === "c-missing" ? providerJson({ error: { message: "model not found" } }, 404)
  : providerJson({ error: "This model is currently being rolled out and is not yet available to you" }, 403);
describe("unavailable endpoint recovery", () => {
  it("crosses four unavailable routes to a healthy route with default three-retry cap", async () => {
    const fake = setup(call => call.body?.model === "e-healthy" ? providerChat("e-healthy") : refusal(String(call.body?.model)));
    const result = await request();
    expect(result.endpoint.id).toBe("acme/e-healthy");
    expect(fake.chats().map(call => call.body?.model)).toEqual(["a-rollout", "b-plan", "c-missing", "d-rollout", "e-healthy"]);
    expect(result.attempts.map(a => a.outcome)).toEqual(["pool_exhausted", "pool_exhausted", "unknown_model", "pool_exhausted", "succeeded"]);
    expect((sy!.db.prepare("SELECT count(*) n FROM model_requests").get() as { n: number }).n).toBe(5);
    expect(sy!.providers.keys.get("config:acme:literal:0")!.disabledReason).toBeNull();
    expect(sy!.health.breakers.get("acme").failures).toBe(0);
    await request();
    expect(fake.chats().map(call => call.body?.model).slice(5)).toEqual(["e-healthy"]);
    expect(sy!.providers.keys.get("config:acme:literal:0")!.planRefusals["c-missing"]!.message).toContain("HTTP 404");
    sy!.providers.keys.clear("config:acme:literal:0");
    await request();
    expect(fake.chats().map(call => call.body?.model).slice(6)).toEqual(["a-rollout", "b-plan", "c-missing", "d-rollout", "e-healthy"]);
  });
  it("keeps unknown-model refusals scoped to one key and tries another key", async () => {
    const fake = setup(call => call.key === "test-acme" ? providerJson({ error: "model not found" }, 404) : providerChat(String(call.body?.model)), { secondKey: true });
    const result = await request();
    expect(result.endpoint.id).toBe("acme/a-rollout");
    expect(fake.chats().map(call => call.key)).toEqual(["test-acme", "test-second"]);
    expect(sy!.providers.keys.get("config:acme:literal:0")!.disabledReason).toBeNull();
    expect(sy!.gate.planRefused(result.endpoint)).toBeNull();
    await request();
    expect(fake.chats().map(call => call.key)).toEqual(["test-acme", "test-second", "test-second"]);
  });
  it("exhausts the finite free pool once and never escalates to paid", async () => {
    const fake = setup(call => refusal(String(call.body?.model)), { paid: true });
    await expect(request()).rejects.toMatchObject({ kind: "pool_exhausted", attempts: expect.arrayContaining([{ endpointId: "acme/e-healthy", outcome: "pool_exhausted" }]) });
    expect(fake.chats()).toHaveLength(5);
    expect(fake.chats().some(call => call.body?.model === "f-paid")).toBe(false);
    expect((sy!.db.prepare("SELECT count(*) n FROM paid_spend").get() as { n: number }).n).toBe(0);
  });
  it("preserves the transient failure cap", async () => {
    const fake = setup(() => providerJson({ error: "server unavailable" }, 503));
    await expect(request()).rejects.toMatchObject({ kind: "server" });
    expect(fake.chats()).toHaveLength(3);
  });
  it("still enforces physical task request budgets while bypassing unavailable routes", async () => {
    const fake = setup(call => refusal(String(call.body?.model)), { budget: 3 });
    const [sub] = await sy!.submitTasks([summarizeTask()]);
    const result = (await sy!.awaitResults([sub!.taskId], { timeoutSeconds: 10 })).completed[0]!;
    expect(result.executionStatus).toBe("budget_exhausted");
    expect(fake.chats()).toHaveLength(3);
    expect((sy!.db.prepare("SELECT count(*) n FROM model_requests").get() as { n: number }).n).toBe(3);
  });
});
