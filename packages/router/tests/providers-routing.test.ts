import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import type { Switchyard } from "../src/core/service.js";
import { MIGRATIONS } from "../src/storage/migrations.js";
import { DB_FILE, openDatabase } from "../src/storage/db.js";
import { Catalog } from "../src/models/catalog.js";
import { ProviderError } from "../src/providers/errors.js";
import { baseConfig, directEndpoint, endpoint, FakeProvider, makeEnv, open, providerChat, providerJson, providerModels, summarizeTask, type Env } from "./helpers.js";

let env: Env | undefined;
let sy: Switchyard | undefined;
afterEach(async () => {
  await sy?.close();
  sy = undefined;
  env?.cleanup();
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
    sy = open(env, fake, { worker: true });
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
    sy = open(env, fake, { worker: true });
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
    sy = open(env, fake, { worker: true });
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

  it("a model the key's plan refuses (402, Ollama Cloud's words) is skipped for that key; the key keeps serving other models", async () => {
    const oneKey = acmeCfg({ keys: [{ label: "a", api_key: KEY_A, billing_class: "free_tier" }] });
    env = makeEnv({ config: oneKey, endpoints: [directEndpoint("acme", "plan-only", { totalParametersB: 120 }), directEndpoint("acme", "in-plan", { totalParametersB: 400 })] });
    const refusal = "this model is not included in your free usage, add usage credits to pay as you go: https://ollama.com/settings or upgrade for included usage. Try gemma4:31b-cloud, which is in the Free plan.";
    const fake = new FakeProvider((call) => (call.body?.model === "plan-only" ? providerJson({ error: refusal }, 402) : providerChat(String(call.body?.model))));
    sy = open(env, fake, { worker: true });
    const [first] = await sy.submitTasks([summarizeTask()]);
    const r1 = (await sy.awaitResults([first!.taskId], { timeoutSeconds: 10 })).completed[0]!;
    expect(r1.executionStatus).toBe("completed");
    expect(r1.routing!.attempts.map((a) => [a.endpointId, a.outcome])).toEqual([
      ["acme/plan-only", "pool_exhausted"],
      ["acme/in-plan", "succeeded"],
    ]);
    // The key is not disabled or cooling; only the refused model is remembered on it.
    const a = sy.providers.keys.get(REF_A)!;
    expect(a).toMatchObject({ disabledReason: null, cooldownUntil: null });
    expect(a.planRefusals["plan-only"]!.message).toMatch(/not in this key's plan/);
    expect(sy.health.breakers.get("acme").failures).toBe(0);

    // Every usable key refused it: routing leaves it out (with the reason), and no request is spent.
    const preview = sy.router.plan("summarize", "T1", ["text"]);
    expect(preview.candidates.map((e) => e.id)).toEqual(["acme/in-plan"]);
    expect(preview.explanations.find((x) => x.endpointId === "acme/plan-only")!.reasons).toEqual([expect.stringMatching(/^not in the plan of any acme key/)]);
    const [second] = await sy.submitTasks([summarizeTask({ goal: "Summarise the log again" })]);
    const r2 = (await sy.awaitResults([second!.taskId], { timeoutSeconds: 10 })).completed[0]!;
    expect(r2.routing!.attempts).toEqual([{ endpointId: "acme/in-plan", outcome: "succeeded" }]);
    expect(r2.servedEndpoints).toEqual(["acme/in-plan"]);
    expect(fake.chats().map((c) => c.body?.model)).toEqual(["plan-only", "in-plan", "in-plan"]);

    // Re-keying or re-enabling the key forgets its refusals.
    sy.providers.keys.clear(REF_A);
    expect(sy.providers.keys.get(REF_A)!.planRefusals).toEqual({});
  });

  it("a configured limit blocks the provider until its window passes, then the deferred task resumes", async () => {
    let offset = 0;
    const now = () => Date.now() + offset;
    env = makeEnv({
      config: acmeCfg({ rpm: 1, keys: [{ label: "a", api_key: KEY_A, billing_class: "free_tier" }] }),
      endpoints: [directEndpoint("acme", "big-free")],
    });
    const fake = new FakeProvider();
    sy = open(env, fake, { worker: true, now });
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
    sy = open(env, new FakeProvider());
    const reasons = () => sy!.router.plan("summarize", "T1", ["text"]).explanations.find((e) => e.endpointId === "acme/big-priced")!.reasons.join("; ");
    expect(reasons()).toMatch(/paid routing is disabled/);
    await sy.close();
    env.cleanup();
    env = makeEnv({ config: paidCfg({ enabled: true, tiers: { T1: "never" } }), endpoints: [priced] });
    sy = open(env, new FakeProvider());
    expect(reasons()).toMatch(/paid models are not allowed for T1/);
  });

  it("charges a paid request to the config key: worst case reserved, settled to the billed cost", async () => {
    env = makeEnv({ config: paidCfg({ enabled: true, tiers: { T1: "preferred" } }), endpoints: [priced] });
    const fake = new FakeProvider((call) => providerChat(String(call.body?.model), { promptTokens: 1000, completionTokens: 500 }));
    sy = open(env, fake, { worker: true });
    const [sub] = await sy.submitTasks([summarizeTask()]);
    const r = (await sy.awaitResults([sub!.taskId], { timeoutSeconds: 10 })).completed[0]!;
    expect(r.servedEndpoints).toEqual(["acme/big-priced"]);
    expect(fake.chats()[0]!.key).toBe("sk-paid-cccc3333");
    // 1000 in x $2/M + 500 out x $8/M = $0.006
    expect(r.usage.estimatedCostUsd).toBeCloseTo(0.006, 6);
    // Recorded by the credential ref, so a config key keeps its spend across restarts.
    const row = sy.db.prepare("SELECT * FROM paid_spend").get() as Record<string, unknown>;
    expect(row).toMatchObject({ key_ref: "config:acme:literal:0", provider: "acme" });
    expect(row).not.toHaveProperty("key_id");
    expect(row.actual_usd).toBeCloseTo(0.006, 6);
    expect(sy.spend.summary().week).toBeCloseTo(0.006, 6);
  });

  it("the weekly budget stops a paid request before dispatch", async () => {
    env = makeEnv({ config: paidCfg({ enabled: true, tiers: { T1: "preferred" }, budgets: { per_week_usd: 0.001 } }), endpoints: [priced] });
    const fake = new FakeProvider();
    sy = open(env, fake, { worker: true });
    const [sub] = await sy.submitTasks([summarizeTask()]);
    const r = (await sy.awaitResults([sub!.taskId], { timeoutSeconds: 10 })).completed[0]!;
    expect(fake.chats()).toHaveLength(0);
    expect(r.stopReason).toMatch(/paid_budget_exhausted/);
  });

  it("a model free only on free_tier keys is never sent through a paid key", async () => {
    env = makeEnv({ config: paidCfg({ enabled: true, tiers: { T1: "preferred" } }, "paid_postpaid"), endpoints: [directEndpoint("acme", "big-free")] });
    const fake = new FakeProvider();
    sy = open(env, fake, { worker: true });
    const [sub] = await sy.submitTasks([summarizeTask()]);
    const r = (await sy.awaitResults([sub!.taskId], { timeoutSeconds: 10 })).completed[0]!;
    expect(fake.chats()).toHaveLength(0);
    expect(r.executionStatus).not.toBe("completed");
    expect(r.stopReason).toMatch(/would bill a model that is free only on free_tier keys/);
  });
});

describe("health of a paid.providers provider", () => {
  const ACME = "paid:acme/acme-large";
  const BETA = "paid:beta/beta-large";
  const model = (provider: string) => ({ provider, model: `${provider}-large`, input_usd_per_million: 2, output_usd_per_million: 8, context_limit_tokens: 100000, output_limit_tokens: 8000, ignore_size_floor: true });
  const cfg = () =>
    baseConfig({
      paid: {
        enabled: true,
        budgets: { per_week_usd: 5 },
        tiers: { T1: "on_free_exhaustion" },
        providers: { acme: { kind: "openai_compatible", base_url: "https://api.acme.test/v1" }, beta: { kind: "openai_compatible", base_url: "https://api.beta.test/v1" } },
        models: [model("acme"), model("beta")],
      },
    });

  it("is reported once, under the provider id, and a cooling or invalid key still reaches its paid endpoints", async () => {
    env = makeEnv({ config: cfg() });
    sy = open(env, new FakeProvider());
    const key = sy.vault.add({ provider: "acme", secret: "sk-acme-0000-1111", billingClass: "paid_credits" });
    sy.vault.add({ provider: "beta", secret: "sk-beta-0000-2222", billingClass: "paid_credits" });
    const plan = () => sy!.router.plan("summarize", "T1", ["text"], undefined, false, "preferred");
    const paidIds = () => plan().candidates.map((c) => c.id).filter((id) => id.startsWith("paid:"));
    const acme = () => sy!.health.snapshot().filter((s) => s.platform.includes("acme"));
    await sy.health.refresh();
    expect(acme()).toEqual([expect.objectContaining({ platform: "acme", status: "healthy" })]);
    expect(sy.providers.statuses().map((s) => s.platform).filter((p) => p.startsWith("paid:"))).toEqual([]);
    expect(paidIds()).toEqual([ACME, BETA]);

    // Every acme key cooling: its paid endpoint (platform paid:acme) reads acme's status and goes behind beta's.
    sy.providers.keys.recordFailure(`vault:${key.id}`, new ProviderError("rate_limited", "slow down", { provider: "acme", status: 429, retryAfterMs: 60_000 }));
    await sy.health.refresh();
    expect(acme()).toEqual([expect.objectContaining({ platform: "acme", status: "rate_limited" })]);
    expect(sy.health.lookup("paid:acme")).toMatchObject({ status: "rate_limited" });
    expect(paidIds()).toEqual([BETA, ACME]);
    expect(plan().explanations.find((e) => e.endpointId === ACME)!.coolingDownUntil).not.toBeNull();
    // The cooldown halved the paid platform's slots too; breakers and slots keep their own name.
    expect(sy.health.capacity.record("paid:acme").cooldownResumeAt).not.toBeNull();

    // The key turns out invalid: the paid endpoint reads that as well.
    sy.providers.keys.clear(`vault:${key.id}`);
    sy.providers.keys.recordFailure(`vault:${key.id}`, new ProviderError("auth_invalid", "bad key", { provider: "acme", status: 401 }));
    await sy.health.refresh();
    expect(sy.health.lookup("paid:acme")).toMatchObject({ status: "invalid" });
    expect(acme()).toEqual([expect.objectContaining({ platform: "acme", status: "invalid" })]);
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
    sy = open(env, fake);
    // A discovered row of a provider outside this run: never touched by it.
    sy.catalog.saveProviderDiscovery([{ ...directEndpoint("groq", "other-model"), origin: "discovered" } as never], ["groq"]);

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
    expect(s.get("groq/other-model")).toMatchObject({ available: true, enabled: true });

    // `only` lists one provider.
    twoFails = false;
    await sy.discover({ only: ["two"] });
    expect(fake.calls.filter((c) => c.url === "https://one.test/v1/models")).toHaveLength(2);
    expect(stored().get("one/alpha-70b")).toMatchObject({ available: true, enabled: true });
    expect(stored().get("groq/other-model")).toMatchObject({ available: true, enabled: true });
  });

  it("a scan that finds a key revoked (401) or out of credits (402) records it on the key; a server error does not", async () => {
    let answer: "revoked" | "broke" | "down" = "revoked";
    const fake = new FakeProvider((call) => {
      if (call.url === "https://one.test/v1/models") return providerJson({ error: { message: `Invalid API Key ${call.key}` } }, 401);
      if (call.url === "https://two.test/v1/models") return answer === "broke" ? providerJson({ error: { message: "insufficient credits" } }, 402) : answer === "down" ? providerJson({ error: { message: "upstream down" } }, 500) : providerModels(["gamma-32b"]);
      return providerJson({ error: { message: "not found" } }, 404);
    });
    env = makeEnv({ config: twoProviders(), endpoints: [] });
    sy = open(env, fake);
    const scan = await sy.scan();
    expect(scan.providers).toEqual(["two"]);
    expect(scan.errors.join(" ")).toMatch(/one/);
    const one = sy.providers.keys.get("config:one:literal:0")!;
    expect(one.disabledReason).toBe("auth_invalid");
    // The provider echoed the key; the stored error has it masked.
    expect(one.lastError).not.toContain("sk-one-1111");
    expect(one.lastError).toContain("...1111");
    expect(sy.providers.statuses().find((s) => s.platform === "one")!.status).toBe("invalid");

    answer = "down";
    await sy.discover({ only: ["two"] });
    expect(sy.providers.keys.get("config:two:literal:0")?.disabledReason ?? null).toBeNull();
    answer = "broke";
    await sy.discover({ only: ["two"] });
    expect(sy.providers.keys.get("config:two:literal:0")!.disabledReason).toBe("out_of_credits");
  });

  it("stores unknown tool support as null and excludes it from tool work; a gate-backed probe fills it in", async () => {
    const fake = new FakeProvider((call) => {
      if (call.url === "https://one.test/v1/models") return providerModels(["alpha-70b"]);
      if (call.url.endsWith("/chat/completions")) return providerChat(String(call.body?.model), { content: null, toolCalls: [{ id: "c1", type: "function", function: { name: "ping", arguments: "{}" } }] });
      return providerJson({ error: { message: "not found" } }, 404);
    });
    env = makeEnv({ config: baseConfig({ providers: { one: { base_url: "https://one.test/v1", keys: [{ label: "k1", api_key: "sk-one-1111", billing_class: "free_tier" }] } } }), endpoints: [] });
    sy = open(env, fake);
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
    sy = open(env, fake);
    const run = (await sy.discover())!;
    expect(fake.chats()).toHaveLength(1);
    expect(fake.chats()[0]!.key).toBe("sk-one-1111");
    expect(run.endpoints[0]!.enriched.provenance.supportsTools.source).toBe("probe");
    expect(sy.catalog.storedEndpoints().find((e) => e.id === "one/alpha-70b")).toMatchObject({ supportsTools: true });
    expect(sy.providers.keys.get("config:one:literal:0")!.lastSuccessAt).not.toBeNull();
  });
});

describe("store upgrade", () => {
  it("drops the old gateway's tables and chain-routed rows, and records paid spend by credential ref", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "switchyard-upgrade-"));
    try {
      // A store at the schema version before this migration, with rows the old gateway wrote.
      const at = MIGRATIONS.findIndex((m) => m.includes("DROP TABLE IF EXISTS fl_key_billing"));
      const old = new Database(path.join(dir, DB_FILE));
      for (const m of MIGRATIONS.slice(0, at)) old.exec(m);
      old.pragma(`user_version = ${at}`);
      old.prepare("INSERT INTO fl_key_billing (fl_key_id, platform, billing_class, updated_at) VALUES (7, 'openrouter', 'paid_postpaid', 1)").run();
      old.prepare("INSERT INTO pool_verifications (gateway_model, verified_at, ok, detail_json) VALUES ('sy-0123456789', 1, 1, '{}')").run();
      const row = old.prepare("INSERT INTO endpoints (id, data_json, first_seen_at, last_scanned_at) VALUES (?, ?, 1, 1)");
      const chainRow = { ...endpoint({ providerId: "groq", gatewayModelId: "chained" }), origin: "discovered", route: { kind: "chain" }, flModelDbId: 3 };
      const legacyRow = { ...endpoint({ providerId: "groq", gatewayModelId: "legacy" }), origin: "discovered", flModelDbId: 4 };
      const directRow = { ...directEndpoint("groq", "direct"), origin: "discovered", flModelDbId: null };
      row.run("groq/chained", JSON.stringify(chainRow));
      row.run("groq/legacy", JSON.stringify(legacyRow));
      row.run("groq/direct", JSON.stringify(directRow));
      old.prepare("INSERT INTO executions (id, kind, profile, status, created_at) VALUES ('e1', 'task', 'summarize', 'done', 1)").run();
      const req = old.prepare("INSERT INTO model_requests (id, execution_id, purpose, gateway_model, status, reserved_at, est_input_tokens, reserved_output_tokens) VALUES (?, 'e1', 'completion', 'direct:acme/m', 'succeeded', 1, 1, 1)");
      req.run("r1");
      req.run("r2");
      const spend = old.prepare("INSERT INTO paid_spend (request_id, key_id, key_ref, provider, endpoint_id, reserved_usd, actual_usd, created_at) VALUES (?, ?, ?, 'acme', 'acme/m', 0.5, 0.25, 1)");
      spend.run("r1", 4, null);
      spend.run("r2", -123, "config:acme:literal:0");
      old.close();

      const db = openDatabase(dir);
      try {
        const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
        expect(tables).not.toContain("fl_key_billing");
        expect(tables).not.toContain("pool_verifications");
        expect(tables).toContain("paid_spend");
        // Only the direct row survives, without the old gateway's model id, and it still parses.
        expect((db.prepare("SELECT id, data_json FROM endpoints").all() as { id: string; data_json: string }[]).map((r) => [r.id, JSON.parse(r.data_json).flModelDbId])).toEqual([["groq/direct", undefined]]);
        expect(new Catalog(db, null, { requireConfirmationForHeuristicParams: true }).endpoints().map((e) => e.id)).toEqual(["groq/direct"]);
        // Spend keeps its amounts; a vault key's numeric id became its credential ref.
        expect(db.prepare("SELECT request_id, key_ref, reserved_usd, actual_usd FROM paid_spend ORDER BY request_id").all()).toEqual([
          { request_id: "r1", key_ref: "vault:4", reserved_usd: 0.5, actual_usd: 0.25 },
          { request_id: "r2", key_ref: "config:acme:literal:0", reserved_usd: 0.5, actual_usd: 0.25 },
        ]);
        expect((db.prepare("PRAGMA table_info(paid_spend)").all() as { name: string }[]).map((c) => c.name)).not.toContain("key_id");
        expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
