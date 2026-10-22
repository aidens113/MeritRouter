import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import * as insights from "../src/admin/insights.js";
import type { Switchyard } from "../src/core/service.js";
import { ProviderError } from "../src/providers/errors.js";
import { baseConfig, FakeProvider, makeEnv, open, providerJson, providerModels, type Env } from "./helpers.js";

let env: Env | undefined;
let sy: Switchyard | undefined;
afterEach(async () => {
  await sy?.close();
  sy = undefined;
  env?.cleanup();
  env = undefined;
});

const GROQ_MODELS = "https://api.groq.com/openai/v1/models";
const PASTED = "gsk_pasted-secret-0123456789-WXYZ";

/** A fake provider that lists two groq models for the pasted key and refuses every other key. */
function groqFake(): FakeProvider {
  return new FakeProvider((call) => {
    if (call.url === GROQ_MODELS) {
      if (call.key !== PASTED && call.key !== "gsk_vault-secret-ABCD") return providerJson({ error: { message: `Invalid API Key ${call.key}`, type: "invalid_request_error", code: "invalid_api_key" } }, 401);
      return providerModels([{ id: "llama-3.3-70b-versatile", context_window: 131072 }, { id: "whisper-large-v3" }]);
    }
    if (call.url.startsWith("http://127.0.0.1:9/")) return providerModels(["local-model"]);
    return providerJson({ error: { message: "not found" } }, 404);
  });
}

function setup(config: Record<string, unknown> = {}, fake = groqFake()): { sy: Switchyard; fake: FakeProvider } {
  env = makeEnv({
    config: baseConfig({
      providers: {
        openrouter: { keys: [{ label: "env key", api_key_env: "SY_TEST_OPENROUTER_KEY", billing_class: "free_tier" }] },
        mistral: { keys: [{ api_key: "mistral-literal-secret-9999", billing_class: "paid_postpaid" }] },
        ...((config.providers as Record<string, unknown>) ?? {}),
      },
      paid: { providers: { acmepaid: { kind: "openai_compatible", base_url: "https://api.acmepaid.example/v1/openai" } } },
      ...Object.fromEntries(Object.entries(config).filter(([k]) => k !== "providers")),
    }),
    endpoints: [],
  });
  sy = open(env, fake);
  return { sy, fake };
}

describe("provider keys view", () => {
  it("lists every registry, custom, and paid provider with config keys read-only and no secret", () => {
    const { sy } = setup({ providers: { localai: { base_url: "http://127.0.0.1:9/v1", no_key: true } } });
    const v = insights.providerKeysView(sy);
    const ids = v.providers.map((p) => p.id);
    for (const id of ["groq", "google", "cloudflare", "anthropic", "openai", "localai", "acmepaid"]) expect(ids).toContain(id);
    expect(v.providers.find((p) => p.id === "localai")).toMatchObject({ kind: "custom", noKey: true, inConfig: true });
    expect(v.providers.find((p) => p.id === "acmepaid")).toMatchObject({ kind: "paid", inPaid: true, discoverable: false });
    expect(v.providers.find((p) => p.id === "cloudflare")).toMatchObject({ kind: "builtin", needsAccountId: true, keys: [], health: null });
    expect(v.providers.find((p) => p.id === "ollama")).toMatchObject({ local: true, keyPolicy: "none", defaultBaseUrl: "http://127.0.0.1:11434/v1", baseUrlEnv: "OLLAMA_HOST" });
    expect(v.providers.find((p) => p.id === "llamacpp")).toMatchObject({ local: true, keyPolicy: "optional", defaultBaseUrl: null });
    expect(v.providers.find((p) => p.id === "groq")).toMatchObject({ local: false, keyPolicy: "required" });

    const or = v.providers.find((p) => p.id === "openrouter")!.keys[0]!;
    expect(or).toMatchObject({ source: "config", editable: false, origin: "providers.openrouter.keys[0]", secretSource: "environment variable SY_TEST_OPENROUTER_KEY", status: "unusable" });
    expect(or.statusDetail).toMatch(/SY_TEST_OPENROUTER_KEY is not set/);
    const mi = v.providers.find((p) => p.id === "mistral")!.keys[0]!;
    expect(mi).toMatchObject({ origin: "providers.mistral.keys[0]", secretSource: "api_key written in the config file", last4: "9999", status: "healthy", billingClass: "paid_postpaid" });
    expect(JSON.stringify(v)).not.toContain("mistral-literal-secret");
    // Providers with keys come first.
    const withKeys = v.providers.map((p) => p.keys.length > 0);
    // openrouter and mistral (config keys) and localai (its keyless credential).
    expect(withKeys.filter(Boolean)).toHaveLength(3);
    expect(withKeys.indexOf(false)).toBe(withKeys.lastIndexOf(true) + 1);
  });

  it("reports a cooling key as cooling, and a resolved old error is not current", () => {
    const { sy } = setup();
    const ref = "config:mistral:literal:0";
    const cred = sy.providers.credentials().get(ref)!;
    sy.providers.keys.recordFailure(cred, new ProviderError("rate_limited", "429 slow down", { provider: "mistral", retryAfterMs: 60_000 }));
    let entry = insights.providerKeysView(sy).providers.find((p) => p.id === "mistral")!;
    expect(entry.keys[0]).toMatchObject({ status: "cooling", errorCurrent: true });
    expect(entry.keys[0]!.until).toBeGreaterThan(Date.now());
    expect(entry.health).toMatchObject({ status: "rate_limited" });
    expect(entry.health!.summary).toMatch(/1 cooling down/);
    expect(sy.providers.statuses().find((s) => s.platform === "mistral")!.lastError).toMatch(/429/);

    // The cooldown ends and the key serves again: healthy, and the old 429 is history only.
    sy.providers.keys.clear(ref);
    sy.providers.keys.recordSuccess(cred);
    entry = insights.providerKeysView(sy).providers.find((p) => p.id === "mistral")!;
    expect(entry.keys[0]).toMatchObject({ status: "healthy", errorCurrent: false, statusDetail: null });
    expect(entry.keys[0]!.lastError).toMatch(/429/);
    expect(entry.health).toMatchObject({ status: "healthy", summary: "The key is ready" });
    // Provider health agrees: a resolved error is not reported beside a healthy status.
    expect(sy.providers.statuses().find((s) => s.platform === "mistral")).toMatchObject({ status: "healthy", lastError: null });
  });
});

describe("adding, editing, and removing vault keys", () => {
  it("accepts any registry, custom, or paid provider and refuses unknown ones", () => {
    const { sy } = setup({ providers: { lab: { base_url: "http://127.0.0.1:9/v1" } } });
    const groq = insights.addProviderKey(sy, { provider: "groq", secret: "gsk_vault-secret-ABCD", billingClass: "free_tier", label: "mine", rpm: 30, quotaGroup: "team" });
    expect(groq).toMatchObject({ provider: "groq", source: "vault", editable: true, last4: "ABCD", status: "healthy", limits: { rpm: 30, rpd: null }, quotaGroup: "team" });
    expect(JSON.stringify(groq)).not.toContain("vault-secret");
    expect(insights.addProviderKey(sy, { provider: "lab", secret: "lab-secret-1234", billingClass: "free_tier" }).provider).toBe("lab");
    expect(insights.addProviderKey(sy, { provider: "acmepaid", secret: "di-secret-5678", billingClass: "paid_credits", prepaidBalanceUsd: 5 })).toMatchObject({ prepaidBalanceUsd: 5, remainingBalanceUsd: 5 });
    expect(() => insights.addProviderKey(sy, { provider: "nope", secret: "whatever-1234", billingClass: "free_tier" })).toThrow(/unknown provider nope/);
    expect(() => insights.addProviderKey(sy, { provider: "cloudflare", secret: "cf-secret-1234", billingClass: "free_tier" })).toThrow(/account id/);
    expect(insights.addProviderKey(sy, { provider: "cloudflare", secret: "cf-secret-1234", billingClass: "free_tier", accountId: "acct123" }).accountId).toBe("acct123");
    // Keys added here route like config keys.
    expect(sy.providers.credentials().usable("groq").map((c) => c.ref)).toContain(groq.ref);
  });

  it("re-enabling or replacing a secret clears a recorded disable; removing forgets the key", () => {
    const { sy } = setup();
    const k = insights.addProviderKey(sy, { provider: "groq", secret: "gsk_vault-secret-ABCD", billingClass: "free_tier" });
    const id = k.vaultKeyId!;
    sy.providers.keys.recordFailure(sy.providers.credentials().get(k.ref)!, new ProviderError("auth_invalid", "401 bad key", { provider: "groq" }));
    expect(insights.providerKeyView(sy, k.ref)!.status).toBe("invalid");
    expect(insights.updateProviderKey(sy, id, { enabled: false }).status).toBe("disabled");
    expect(insights.updateProviderKey(sy, id, { enabled: true }).status).toBe("healthy");
    expect(insights.updateProviderKey(sy, id, { billingClass: "trial", tpd: 100000 })).toMatchObject({ billingClass: "trial", limits: { tpd: 100000 } });
    expect(insights.updateProviderKey(sy, id, { secret: "gsk_rotated-secret-QRST" }).last4).toBe("QRST");
    expect(() => insights.updateProviderKey(sy, 999, { enabled: true })).toThrow(/unknown key 999/);

    expect(insights.removeProviderKey(sy, id)).toEqual({ removed: id, keptForHistory: false });
    expect(sy.providers.keys.get(k.ref)).toBeNull();
    expect(insights.providerKeyView(sy, k.ref)).toBeNull();
  });
});

describe("testing keys", () => {
  it("lists the models a pasted key can use without storing it, through the provider's model list", async () => {
    const { sy, fake } = setup();
    const r = await insights.testProviderKey(sy, { provider: "groq", secret: PASTED, billingClass: "free_tier" });
    expect(r).toMatchObject({ ok: true, provider: "groq", ref: null, error: null, pages: 1 });
    expect(r.models.map((m) => m.id)).toEqual(["llama-3.3-70b-versatile"]);
    expect(r.excluded.map((e) => e.model)).toEqual(["whisper-large-v3"]);
    expect(r.models[0]).toMatchObject({ free: true, contextLimitTokens: 131072 });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({ url: GROQ_MODELS, method: "GET", key: PASTED });
    expect(sy.vault.list()).toHaveLength(0);
  });

  it("redacts the secret from a refusal, records a stored key as invalid, and clears it when it lists again", async () => {
    const { sy, fake } = setup();
    const wrong = "gsk_wrong-secret-0000-LMNO";
    const bad = await insights.testProviderKey(sy, { provider: "groq", secret: wrong });
    expect(bad).toMatchObject({ ok: false, error: { kind: "auth_invalid" } });
    expect(bad.error!.message).not.toContain(wrong);

    const k = insights.addProviderKey(sy, { provider: "groq", secret: wrong, billingClass: "free_tier" });
    expect((await insights.testProviderKey(sy, { ref: k.ref })).ok).toBe(false);
    expect(insights.providerKeyView(sy, k.ref)!.status).toBe("invalid");

    // The key itself was fine all along (the provider's outage is over): the same ref lists again.
    fake.handler = (call) => (call.url === GROQ_MODELS ? providerModels(["llama-3.3-70b-versatile"]) : providerJson({}, 404));
    expect((await insights.testProviderKey(sy, { ref: k.ref })).ok).toBe(true);
    expect(insights.providerKeyView(sy, k.ref)!.status).toBe("healthy");
  });

  it("does not call the provider for a key that cannot be used", async () => {
    const { sy, fake } = setup();
    const r = await insights.testProviderKey(sy, { ref: "config:openrouter:env:SY_TEST_OPENROUTER_KEY" });
    expect(r).toMatchObject({ ok: false, error: { kind: "error" } });
    expect(r.error!.message).toMatch(/not set/);
    expect(fake.calls).toHaveLength(0);
    await expect(insights.testProviderKey(sy, { ref: "vault:42" })).rejects.toThrow(/unknown key/);
  });
});

describe("custom providers and per-provider scans", () => {
  it("adds a custom provider to the config file, finds its models, and removes it once it has no keys", async () => {
    const { sy } = setup();
    expect(insights.addCustomProvider(sy, { id: "lab", displayName: "Lab server", baseUrl: "http://127.0.0.1:9/v1/" })).toEqual({ id: "lab" });
    const written = YAML.parse(readFileSync(sy.cfg.configPath, "utf8")) as { providers: Record<string, unknown> };
    expect(written.providers.lab).toEqual({ base_url: "http://127.0.0.1:9/v1", display_name: "Lab server" });
    expect(insights.providerKeysView(sy).providers.find((p) => p.id === "lab")).toMatchObject({ kind: "custom", displayName: "Lab server", baseUrl: "http://127.0.0.1:9/v1" });
    expect(() => insights.addCustomProvider(sy, { id: "groq", baseUrl: "http://127.0.0.1:9/v1" })).toThrow(/built-in/);
    expect(() => insights.addCustomProvider(sy, { id: "acmepaid", baseUrl: "http://127.0.0.1:9/v1" })).toThrow(/paid provider/);
    expect(() => insights.addCustomProvider(sy, { id: "x", baseUrl: "file:///etc/passwd" })).toThrow(/http/);

    await expect(insights.scanProviderModels(sy, "lab")).rejects.toThrow(/no usable key/);
    const k = insights.addProviderKey(sy, { provider: "lab", secret: "lab-secret-1234", billingClass: "free_tier" });
    const scan = await insights.scanProviderModels(sy, "lab");
    expect(scan).toMatchObject({ provider: "lab", status: "listed", kept: 1, added: ["lab/local-model"], errors: [] });
    expect(insights.providerKeysView(sy).providers.find((p) => p.id === "lab")!.models).toMatchObject({ total: 1, free: 1 });
    await expect(insights.scanProviderModels(sy, "acmepaid")).rejects.toThrow(/only a paid provider/);

    expect(() => insights.removeCustomProvider(sy, "lab")).toThrow(/keys first/);
    insights.removeProviderKey(sy, k.vaultKeyId!);
    expect(insights.removeCustomProvider(sy, "lab")).toEqual({ removed: "lab" });
    expect(sy.providers.provider("lab")).toBeNull();
    expect(() => insights.removeCustomProvider(sy, "groq")).toThrow(/not a custom provider/);
  });

  it("the overview counts usable keys and flags invalid ones", async () => {
    const { sy } = setup();
    let ov = await insights.overview(sy);
    expect(ov.usableKeys).toBe(1);
    expect(ov).not.toHaveProperty("gatewayConfigured");
    expect(ov).not.toHaveProperty("adminConfigured");
    sy.providers.keys.recordFailure(sy.providers.credentials().get("config:mistral:literal:0")!, new ProviderError("out_of_credits", "402 no credits", { provider: "mistral" }));
    ov = await insights.overview(sy);
    expect(ov.attention.join("\n")).toMatch(/1 provider key\(s\) are invalid or out of credits/);
  });
});
