import { afterEach, describe, expect, it } from "vitest";
import type { Switchyard } from "../src/core/service.js";
import { baseConfig, directEndpoint, FakeProvider, makeEnv, open, providerChat, providerJson, providerModels, ScriptedClient, summarizeTask, type Env } from "./helpers.js";

let env: Env | undefined;
let sy: Switchyard | undefined;
afterEach(async () => {
  await sy?.close();
  sy = undefined;
  env?.cleanup();
});

/** The FreeLLMAPI double: direct-provider tests must never reach it. */
const noChains = () =>
  new ScriptedClient(() => {
    throw new Error("the FreeLLMAPI gateway must not be used");
  });

const KEY_A = "sk-free-aaaa1111";
const KEY_B = "sk-free-bbbb2222";
const REF_A = "config:acme:literal:0";
const REF_B = "config:acme:literal:1";

/** A custom OpenAI-compatible provider `acme` with two free_tier keys (A then B). */
const acmeCfg = (entry: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  baseConfig({
    providers: {
      acme: {
        base_url: "https://api.acme.test/v1",
        keys: [
          { label: "a", api_key: KEY_A, billing_class: "free_tier" },
          { label: "b", api_key: KEY_B, billing_class: "free_tier" },
        ],
        ...entry,
      },
    },
    ...extra,
  });

const requestRows = (s: Switchyard) => s.db.prepare("SELECT gateway_model, endpoint_id, status, error_kind, route_note FROM model_requests ORDER BY reserved_at").all() as Array<{ gateway_model: string; endpoint_id: string; status: string; error_kind: string | null; route_note: string | null }>;

describe("direct free requests", () => {
  it("serve a free model through a free_tier key, with no paid spend", async () => {
    env = makeEnv({ config: acmeCfg(), endpoints: [directEndpoint("acme", "big-free")] });
    const fake = new FakeProvider();
    sy = open(env, noChains(), { worker: true, providerFetch: fake.fetch });
    const [sub] = await sy.submitTasks([summarizeTask()]);
    const r = (await sy.awaitResults([sub!.taskId], { timeoutSeconds: 10 })).completed[0]!;
    expect(r.executionStatus).toBe("completed");
    expect(r.servedEndpoints).toEqual(["acme/big-free"]);
    expect(r.routing!.attempts.map((a) => a.outcome)).toEqual(["succeeded"]);
    const [chat] = fake.chats();
    expect(chat!.url).toBe("https://api.acme.test/v1/chat/completions");
    expect(chat!.key).toBe(KEY_A);
    expect(chat!.body).toMatchObject({ model: "big-free" });
    const rows = requestRows(sy);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ gateway_model: "direct:acme/big-free", endpoint_id: "acme/big-free", status: "succeeded" });
    expect(rows[0]!.route_note).toMatch(/^free via a \(free_tier\)/);
    expect((sy.db.prepare("SELECT COUNT(*) AS n FROM paid_spend").get() as { n: number }).n).toBe(0);
    expect(sy.providers.keys.get(REF_A)).toMatchObject({ consecutiveFailures: 0, disabledReason: null });
    expect(sy.providers.keys.get(REF_A)!.lastSuccessAt).not.toBeNull();
    // Health comes from key state.
    expect(sy.health.lookup("acme")).toMatchObject({ status: "healthy" });
  });

  it("rotates to the next key on a 429 within one request, cooling the first key without opening the breaker", async () => {
    env = makeEnv({ config: acmeCfg(), endpoints: [directEndpoint("acme", "big-free")] });
    const fake = new FakeProvider((call) => (call.key === KEY_A ? providerJson({ error: { message: "rate limit reached" } }, 429, { "retry-after": "30" }) : providerChat(String(call.body?.model))));
    sy = open(env, noChains(), { worker: true, providerFetch: fake.fetch });
    const before = Date.now();
    const [sub] = await sy.submitTasks([summarizeTask()]);
    const r = (await sy.awaitResults([sub!.taskId], { timeoutSeconds: 10 })).completed[0]!;
    expect(r.executionStatus).toBe("completed");
    expect(r.routing!.attempts).toEqual([
      { endpointId: "acme/big-free", outcome: "rate_limited" },
      { endpointId: "acme/big-free", outcome: "succeeded" },
    ]);
    expect(fake.chats().map((c) => c.key)).toEqual([KEY_A, KEY_B]);
    const a = sy.providers.keys.get(REF_A)!;
    expect(a.cooldownUntil).toBeGreaterThanOrEqual(before + 29_000);
    expect(a.lastError).toMatch(/rate_limited/);
    expect(sy.health.breakers.get("acme")).toMatchObject({ state: "closed", failures: 0 });
    // One key still serves: the provider is healthy, not cooling.
    expect(sy.health.lookup("acme")).toMatchObject({ status: "healthy" });
    expect(requestRows(sy).map((x) => x.status)).toEqual(["failed", "succeeded"]);
  });

  it("disables an invalid key and skips it on later requests", async () => {
    env = makeEnv({ config: acmeCfg(), endpoints: [directEndpoint("acme", "big-free")] });
    const fake = new FakeProvider((call) => (call.key === KEY_A ? providerJson({ error: { message: "invalid api key" } }, 401) : providerChat(String(call.body?.model))));
    sy = open(env, noChains(), { worker: true, providerFetch: fake.fetch });
    const [first] = await sy.submitTasks([summarizeTask()]);
    const r1 = (await sy.awaitResults([first!.taskId], { timeoutSeconds: 10 })).completed[0]!;
    expect(r1.routing!.attempts.map((a) => a.outcome)).toEqual(["auth", "succeeded"]);
    expect(sy.providers.keys.get(REF_A)).toMatchObject({ disabledReason: "auth_invalid" });
    expect(sy.health.breakers.get("acme").failures).toBe(0);

    const [second] = await sy.submitTasks([summarizeTask({ goal: "Summarise the log again" })]);
    const r2 = (await sy.awaitResults([second!.taskId], { timeoutSeconds: 10 })).completed[0]!;
    expect(r2.routing!.attempts.map((a) => a.outcome)).toEqual(["succeeded"]);
    expect(fake.chats().map((c) => c.key)).toEqual([KEY_A, KEY_B, KEY_B]);
  });

  it("a configured limit blocks the provider until its window passes, then the deferred task resumes", async () => {
    let offset = 0;
    const now = () => Date.now() + offset;
    env = makeEnv({
      config: acmeCfg({ rpm: 1, keys: [{ label: "a", api_key: KEY_A, billing_class: "free_tier" }] }),
      endpoints: [directEndpoint("acme", "big-free")],
    });
    const fake = new FakeProvider();
    sy = open(env, noChains(), { worker: true, providerFetch: fake.fetch, now });
    const [first] = await sy.submitTasks([summarizeTask()]);
    expect((await sy.awaitResults([first!.taskId], { timeoutSeconds: 10 })).completed[0]!.executionStatus).toBe("completed");

    // The minute's one request is used: the next task waits for capacity instead of failing.
    const [second] = await sy.submitTasks([summarizeTask({ goal: "Summarise the log again" })]);
    const waited = await sy.awaitResults([second!.taskId], { timeoutSeconds: 2 });
    expect(waited.timedOut).toBe(true);
    expect(fake.chats()).toHaveLength(1);
    const deferred = sy.tasks.events(second!.taskId, 50).map((e) => JSON.stringify(e.data));
    expect(deferred.some((d) => /no usable key/.test(d))).toBe(true);
    expect(sy.health.lookup("acme")).toMatchObject({ status: "rate_limited" });

    offset += 61_000;
    const r2 = (await sy.awaitResults([second!.taskId], { timeoutSeconds: 20 })).completed[0]!;
    expect(r2.executionStatus).toBe("completed");
    expect(fake.chats()).toHaveLength(2);
  });
});

describe("paid policy on direct providers", () => {
  const paidCfg = (paid: Record<string, unknown>, billing = "paid_credits") =>
    baseConfig({
      providers: { acme: { base_url: "https://api.acme.test/v1", keys: [{ label: "credits", api_key: "sk-paid-cccc3333", billing_class: billing }] } },
      paid: { budgets: { per_week_usd: 5 }, ...paid },
    });
  const priced = directEndpoint("acme", "big-priced", { pricing: { inputUsdPerMillion: 2, outputUsdPerMillion: 8, freeVerified: false } });

  it("excludes priced models while paid routing is off or the tier forbids it", async () => {
    env = makeEnv({ config: paidCfg({ enabled: false }), endpoints: [priced] });
    sy = open(env, noChains());
    const reasons = () => sy!.router.plan("summarize", "T1", ["text"]).explanations.find((e) => e.endpointId === "acme/big-priced")!.reasons.join("; ");
    expect(reasons()).toMatch(/paid routing is disabled/);
    await sy.close();
    env.cleanup();
    env = makeEnv({ config: paidCfg({ enabled: true, tiers: { T1: "never" } }), endpoints: [priced] });
    sy = open(env, noChains());
    expect(reasons()).toMatch(/paid models are not allowed for T1/);
  });

  it("charges a paid request to the config key: worst case reserved, settled to the billed cost", async () => {
    env = makeEnv({ config: paidCfg({ enabled: true, tiers: { T1: "preferred" } }), endpoints: [priced] });
    const fake = new FakeProvider((call) => providerChat(String(call.body?.model), { promptTokens: 1000, completionTokens: 500 }));
    sy = open(env, noChains(), { worker: true, providerFetch: fake.fetch });
    const [sub] = await sy.submitTasks([summarizeTask()]);
    const r = (await sy.awaitResults([sub!.taskId], { timeoutSeconds: 10 })).completed[0]!;
    expect(r.servedEndpoints).toEqual(["acme/big-priced"]);
    expect(fake.chats()[0]!.key).toBe("sk-paid-cccc3333");
    // 1000 in x $2/M + 500 out x $8/M = $0.006
    expect(r.usage.estimatedCostUsd).toBeCloseTo(0.006, 6);
    const row = sy.db.prepare("SELECT key_id, key_ref, provider, actual_usd FROM paid_spend").get() as { key_id: number; key_ref: string; provider: string; actual_usd: number };
    expect(row).toMatchObject({ key_ref: "config:acme:literal:0", provider: "acme" });
    expect(row.key_id).toBeLessThan(0);
    expect(row.actual_usd).toBeCloseTo(0.006, 6);
    expect(sy.spend.summary().week).toBeCloseTo(0.006, 6);
  });

  it("the weekly budget stops a paid request before dispatch", async () => {
    env = makeEnv({ config: paidCfg({ enabled: true, tiers: { T1: "preferred" }, budgets: { per_week_usd: 0.001 } }), endpoints: [priced] });
    const fake = new FakeProvider();
    sy = open(env, noChains(), { worker: true, providerFetch: fake.fetch });
    const [sub] = await sy.submitTasks([summarizeTask()]);
    const r = (await sy.awaitResults([sub!.taskId], { timeoutSeconds: 10 })).completed[0]!;
    expect(fake.chats()).toHaveLength(0);
    expect(r.stopReason).toMatch(/paid_budget_exhausted/);
  });

  it("a model free only on free_tier keys is never sent through a paid key", async () => {
    env = makeEnv({ config: paidCfg({ enabled: true, tiers: { T1: "preferred" } }, "paid_postpaid"), endpoints: [directEndpoint("acme", "big-free")] });
    const fake = new FakeProvider();
    sy = open(env, noChains(), { worker: true, providerFetch: fake.fetch });
    const [sub] = await sy.submitTasks([summarizeTask()]);
    const r = (await sy.awaitResults([sub!.taskId], { timeoutSeconds: 10 })).completed[0]!;
    expect(fake.chats()).toHaveLength(0);
    expect(r.executionStatus).not.toBe("completed");
    expect(r.stopReason).toMatch(/would bill a model that is free only on free_tier keys/);
  });
});

describe("direct discovery", () => {
  const twoProviders = (discovery: Record<string, unknown> = {}) =>
    baseConfig({
      providers: {
        one: { base_url: "https://one.test/v1", keys: [{ label: "k1", api_key: "sk-one-1111", billing_class: "free_tier" }] },
        two: { base_url: "https://two.test/v1", keys: [{ label: "k2", api_key: "sk-two-2222", billing_class: "free_tier" }] },
      },
      discovery,
    });

  it("saves per provider: unlisted models become unavailable, a failed listing and other providers are untouched", async () => {
    let oneModels = ["alpha-70b", "beta-8b"];
    let twoFails = false;
    const fake = new FakeProvider((call) => {
      if (call.url === "https://one.test/v1/models") return providerModels(oneModels);
      if (call.url === "https://two.test/v1/models") return twoFails ? providerJson({ error: { message: "upstream down" } }, 500) : providerModels(["gamma-32b"]);
      return providerJson({ error: { message: "not found" } }, 404);
    });
    env = makeEnv({ config: twoProviders(), endpoints: [] });
    sy = open(env, noChains(), { providerFetch: fake.fetch });
    // A FreeLLMAPI chain row: direct discovery never touches it.
    sy.catalog.saveDiscovered([{ ...directEndpoint("groq", "chain-model"), route: { kind: "chain" }, origin: "discovered" } as never]);

    const run1 = (await sy.discover())!;
    expect(run1.providers.map((p) => [p.provider, p.status])).toEqual([
      ["one", "listed"],
      ["two", "listed"],
    ]);
    expect(run1.added.sort()).toEqual(["one/alpha-70b", "one/beta-8b", "two/gamma-32b"]);
    const stored = () => new Map(sy!.catalog.storedEndpoints().map((e) => [e.id, e]));
    expect(stored().get("one/beta-8b")).toMatchObject({ available: true, enabled: true, route: { kind: "direct", provider: "one", model: "beta-8b" }, pricing: { freeVerified: true, freeBasis: "key" } });

    oneModels = ["alpha-70b"];
    twoFails = true;
    const run2 = (await sy.discover())!;
    expect(run2.providers.map((p) => [p.provider, p.status])).toEqual([
      ["one", "listed"],
      ["two", "failed"],
    ]);
    const s = stored();
    expect(s.get("one/alpha-70b")).toMatchObject({ available: true, enabled: true });
    expect(s.get("one/beta-8b")).toMatchObject({ available: false, enabled: false });
    expect(sy.catalog.get("one/beta-8b")!.statusReason).toBe("no longer listed by one");
    expect(s.get("two/gamma-32b")).toMatchObject({ available: true, enabled: true });
    expect(s.get("groq/chain-model")).toMatchObject({ available: true, enabled: true });

    // `only` lists one provider; a FreeLLMAPI scan save leaves direct rows alone.
    twoFails = false;
    await sy.discover({ only: ["two"] });
    expect(fake.calls.filter((c) => c.url === "https://one.test/v1/models")).toHaveLength(2);
    sy.catalog.saveDiscovered([]);
    expect(stored().get("one/alpha-70b")).toMatchObject({ available: true, enabled: true });
    expect(stored().get("groq/chain-model")).toMatchObject({ available: false, enabled: false });
  });

  it("stores unknown tool support as null and excludes it from tool work; a gate-backed probe fills it in", async () => {
    const fake = new FakeProvider((call) => {
      if (call.url === "https://one.test/v1/models") return providerModels(["alpha-70b"]);
      if (call.url.endsWith("/chat/completions")) return providerChat(String(call.body?.model), { content: null, toolCalls: [{ id: "c1", type: "function", function: { name: "ping", arguments: "{}" } }] });
      return providerJson({ error: { message: "not found" } }, 404);
    });
    env = makeEnv({ config: baseConfig({ providers: { one: { base_url: "https://one.test/v1", keys: [{ label: "k1", api_key: "sk-one-1111", billing_class: "free_tier" }] } } }), endpoints: [] });
    sy = open(env, noChains(), { providerFetch: fake.fetch });
    await sy.discover();
    expect(sy.catalog.storedEndpoints().find((e) => e.id === "one/alpha-70b")).toMatchObject({ supportsTools: null, supportsStructuredOutput: null });
    // Make the model otherwise usable: confirm its size, set its limits.
    sy.catalog.setOverride("one/alpha-70b", { confirmParams: true, contextLimitTokens: 64000, outputLimitTokens: 8000 });
    const explain = (profile: "inspect" | "summarize") => sy!.router.plan(profile, "T1", ["text"]).explanations.find((e) => e.endpointId === "one/alpha-70b")!;
    expect(explain("inspect").reasons).toContain("tool calling unknown (required for repository work; set it in an override)");
    expect(explain("summarize").reasons).toEqual([]);
    expect(fake.chats()).toHaveLength(0);

    // With probing on, the probe goes through the gate's machinery on the provider's free key.
    await sy.close();
    env.cleanup();
    env = makeEnv({ config: baseConfig({ providers: { one: { base_url: "https://one.test/v1", keys: [{ label: "k1", api_key: "sk-one-1111", billing_class: "free_tier" }] } }, discovery: { probe_tools: true } }), endpoints: [] });
    sy = open(env, noChains(), { providerFetch: fake.fetch });
    const run = (await sy.discover())!;
    expect(fake.chats()).toHaveLength(1);
    expect(fake.chats()[0]!.key).toBe("sk-one-1111");
    expect(run.endpoints[0]!.enriched.provenance.supportsTools.source).toBe("probe");
    expect(sy.catalog.storedEndpoints().find((e) => e.id === "one/alpha-70b")).toMatchObject({ supportsTools: true });
    expect(sy.providers.keys.get("config:one:literal:0")!.lastSuccessAt).not.toBeNull();
  });
});
