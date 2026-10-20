import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Switchyard } from "../src/core/service.js";
import { SwitchyardError } from "../src/core/errors.js";
import { ProviderError } from "../src/providers/errors.js";
import { addKey, keyRows, keysCommand, testKeys, NEW_KEY_ENV } from "../src/cli/keys.js";
import { doctorChecks, doctorText } from "../src/cli/doctor.js";
import { baseConfig, FakeProvider, makeEnv, open, providerJson, providerModels, testProviders, type Env } from "./helpers.js";

// The `keys` and `doctor` commands, run in-process against a fake provider (no network), plus one
// run of the built CLI to check the secret travels only through the environment.

let env: Env | undefined;
let sy: Switchyard | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env[NEW_KEY_ENV];
  await sy?.close();
  sy = undefined;
  env?.cleanup();
  env = undefined;
});

const GROQ_MODELS = "https://api.groq.com/openai/v1/models";
const CEREBRAS_MODELS = "https://api.cerebras.ai/v1/models";
const MISTRAL_MODELS = "https://api.mistral.ai/v1/models";
const GOOD = "gsk-good-secret-1234";

/**
 * Groq lists two models for the good vault key and rejects anything else, echoing the key as some
 * providers do; cerebras rejects every key.
 */
function fakeProviders() {
  return new FakeProvider((call) => {
    if (call.url === GROQ_MODELS) return call.key === GOOD || call.key === "test-groq-key" ? providerModels([{ id: "llama-3.3-70b-versatile", context_window: 131072 }, "qwen3-32b"]) : providerJson({ error: { message: `Invalid API Key: ${call.key}` } }, 401);
    if (call.url === CEREBRAS_MODELS) return providerJson({ error: { message: "Wrong API Key" } }, 401);
    if (call.url === MISTRAL_MODELS) return providerModels(["mistral-small-latest"]);
    return providerJson({ error: { message: "not found" } }, 404);
  });
}

/** Run a `keys` subcommand, returning its exit code and everything it printed. */
async function keys(args: string[], flags: Record<string, unknown> = {}, json = true): Promise<{ code: number; printed: string }> {
  let printed = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    printed += String(chunk);
    return true;
  });
  try {
    const code = await keysCommand(sy!, args, flags, json);
    return { code, printed };
  } finally {
    vi.mocked(process.stdout.write).mockRestore();
  }
}

describe("keys add", () => {
  it("reads the secret from SWITCHYARD_NEW_KEY, stores it encrypted, and prints only the last four", async () => {
    env = makeEnv({ config: baseConfig({ providers: {} }), endpoints: [] });
    sy = open(env, fakeProviders());
    process.env[NEW_KEY_ENV] = GOOD;
    const r = await keys(["add", "groq"], { billing: "free_tier", label: "main", rpm: "30", "quota-group": "team-a" });
    expect(r.code).toBe(0);
    expect(r.printed).not.toContain(GOOD);
    const added = JSON.parse(r.printed) as { added: { ref: string; last4: string } };
    expect(added.added).toMatchObject({ ref: "vault:1", last4: "1234" });
    const stored = sy.vault.get(1)!;
    expect(stored).toMatchObject({ provider: "groq", label: "main", billingClass: "free_tier", quotaGroup: "team-a", limits: { rpm: 30, rpd: null } });
    expect(sy.vault.secret(1)).toBe(GOOD);
    // The database holds ciphertext only.
    const row = sy.db.prepare("SELECT enc FROM paid_keys WHERE id = 1").get() as { enc: string };
    expect(row.enc).not.toContain(GOOD);
  });

  it("refuses without a billing class, for an unknown provider, and for Cloudflare without an account id", async () => {
    env = makeEnv({ config: baseConfig({ providers: {} }), endpoints: [] });
    sy = open(env, fakeProviders());
    expect(() => addKey(sy!, "groq", GOOD, {})).toThrow(/--billing is required/);
    expect(() => addKey(sy!, "nosuch", GOOD, { billing: "free_tier" })).toThrow(/unknown provider nosuch/);
    expect(() => addKey(sy!, "cloudflare", GOOD, { billing: "free_tier" })).toThrow(/cloudflare keys need --account-id/);
    expect(() => addKey(sy!, "groq", GOOD, { billing: "free_tier", rpm: "0" })).toThrow(/--rpm must be an integer >= 1/);
    expect(() => addKey(sy!, "groq", GOOD, { billing: "free_tier", "quota-group": "Bad Group" })).toThrow(/--quota-group/);
    expect(addKey(sy!, "cloudflare", GOOD, { billing: "free_tier", "account-id": "acct123" })).toMatchObject({ provider: "cloudflare", accountId: "acct123" });
    expect(sy.vault.list().map((k) => k.provider)).toEqual(["cloudflare"]);
  });

  it("with no SWITCHYARD_NEW_KEY and no terminal, says how to give the secret", async () => {
    env = makeEnv({ config: baseConfig({ providers: {} }), endpoints: [] });
    sy = open(env, fakeProviders());
    const tty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    try {
      await expect(keysCommand(sy, ["add", "groq"], { billing: "free_tier" }, true)).rejects.toThrow(/set SWITCHYARD_NEW_KEY/);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: tty, configurable: true });
    }
  });

  it("--test lists the models first and stores the key only when the provider accepts it", async () => {
    env = makeEnv({ config: baseConfig({ providers: {} }), endpoints: [] });
    sy = open(env, fakeProviders());
    process.env[NEW_KEY_ENV] = "gsk-wrong-secret-9999";
    const bad = await keys(["add", "groq"], { billing: "free_tier", test: true });
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.printed)).toMatchObject({ added: null, test: { ok: false, error: { kind: "auth_invalid", message: expect.stringContaining("...9999") } } });
    // The provider echoed the key; the CLI never prints it.
    expect(bad.printed).not.toContain("gsk-wrong-secret-9999");
    expect(sy.vault.list()).toEqual([]);

    process.env[NEW_KEY_ENV] = GOOD;
    const good = await keys(["add", "groq"], { billing: "free_tier", test: true });
    expect(good.code).toBe(0);
    expect(JSON.parse(good.printed)).toMatchObject({ added: { ref: "vault:1" }, test: { ok: true, models: ["llama-3.3-70b-versatile", "qwen3-32b"] } });
  });
});

describe("keys list, test, remove", () => {
  it("lists vault and config keys with their status and last four only", async () => {
    env = makeEnv({ config: baseConfig({ providers: { ...testProviders(["groq", "cerebras"]), mistral: { keys: [{ api_key_env: "SY_TEST_UNSET_MISTRAL_KEY", billing_class: "free_tier" }] } } }), endpoints: [] });
    sy = open(env, fakeProviders());
    const vault = addKey(sy, "groq", GOOD, { billing: "paid_credits", label: "vault groq" });
    const cerebras = sy.providers.credentials().get("config:cerebras:literal:0")!;
    sy.providers.keys.recordFailure(cerebras, new ProviderError("auth_invalid", "Wrong API Key", { provider: "cerebras", status: 401 }));
    const groqConfig = sy.providers.credentials().get("config:groq:literal:0")!;
    sy.providers.keys.recordFailure(groqConfig, new ProviderError("rate_limited", "slow down", { provider: "groq", status: 429, retryAfterMs: 60_000 }));

    const rows = keyRows(sy);
    expect(rows.map((r) => [r.ref, r.source, r.status])).toEqual([
      ["config:groq:literal:0", "config", "cooling"],
      ["config:cerebras:literal:0", "config", "invalid"],
      ["config:mistral:env:SY_TEST_UNSET_MISTRAL_KEY", "config", "unusable"],
      [`vault:${vault.id}`, "vault", "available"],
    ]);
    expect(rows.find((r) => r.ref === "config:groq:literal:0")!.until).not.toBeNull();
    expect(rows.find((r) => r.source === "vault")).toMatchObject({ billingClass: "paid_credits", last4: "1234", label: "vault groq" });
    expect(rows.find((r) => r.ref.includes("mistral"))!.detail).toMatch(/SY_TEST_UNSET_MISTRAL_KEY is not set/);

    const text = await keys(["list"], {}, false);
    expect(text.printed).toContain("...1234");
    expect(text.printed).toContain("cooling down until");
    expect(text.printed).toContain("INVALID");
    for (const secret of [GOOD, "test-groq-key", "test-cerebras-key"]) expect(text.printed).not.toContain(secret);
  });

  it("test lists the models each key can use, marks a rejected key invalid, and clears it once it works", async () => {
    env = makeEnv({ config: baseConfig({ providers: testProviders(["cerebras"]) }), endpoints: [] });
    const fake = fakeProviders();
    sy = open(env, fake);
    const good = addKey(sy, "groq", GOOD, { billing: "free_tier" });
    const bad = addKey(sy, "groq", "gsk-revoked-secret-0000", { billing: "free_tier" });

    const groq = await testKeys(sy, "groq");
    expect(groq.map((t) => [t.ref, t.ok, t.models, t.error?.kind ?? null])).toEqual([
      [`vault:${good.id}`, true, ["llama-3.3-70b-versatile", "qwen3-32b"], null],
      [`vault:${bad.id}`, false, [], "auth_invalid"],
    ]);
    expect(sy.providers.keys.get(`vault:${bad.id}`)!.disabledReason).toBe("auth_invalid");
    // The echoed secret is redacted from the result and from the stored key state.
    expect(JSON.stringify(groq)).not.toContain("gsk-revoked-secret-0000");
    expect(sy.providers.keys.get(`vault:${bad.id}`)!.lastError).toContain("Invalid API Key: ...0000");
    // The listing used each key's own secret, and nothing reached the catalog.
    expect(fake.calls.filter((c) => c.url === GROQ_MODELS).map((c) => c.key)).toEqual([GOOD, "gsk-revoked-secret-0000"]);
    expect(sy.catalog.endpoints()).toEqual([]);

    // The user fixes the key; a test that works clears the invalid mark.
    sy.vault.update(bad.id, { secret: GOOD });
    const again = await testKeys(sy, String(bad.id));
    expect(again).toEqual([expect.objectContaining({ ref: `vault:${bad.id}`, ok: true, cleared: true })]);
    expect(sy.providers.keys.get(`vault:${bad.id}`)!.disabledReason).toBeNull();

    // With no target every key is tested; exit code 1 when any failed.
    const all = await keys(["test"]);
    expect(all.code).toBe(1);
    const results = JSON.parse(all.printed) as Array<{ provider: string; ok: boolean }>;
    expect(results.map((t) => [t.provider, t.ok])).toEqual([["cerebras", false], ["groq", true], ["groq", true]]);
    await expect(testKeys(sy, "vault:99")).rejects.toThrow(SwitchyardError);
  });

  it("remove deletes a vault key and its state; config keys are refused", async () => {
    env = makeEnv({ config: baseConfig({ providers: testProviders(["groq"]) }), endpoints: [] });
    sy = open(env, fakeProviders());
    const k = addKey(sy, "groq", GOOD, { billing: "free_tier" });
    sy.providers.keys.recordFailure(`vault:${k.id}`, new ProviderError("auth_invalid", "no", { provider: "groq", status: 401 }));
    const r = await keys(["remove", `vault:${k.id}`]);
    expect(r.code).toBe(0);
    expect(sy.vault.get(k.id)).toBeNull();
    expect(sy.providers.keys.get(`vault:${k.id}`)).toBeNull();
    await expect(keysCommand(sy, ["remove", "config:groq:literal:0"], {}, true)).rejects.toThrow(/declared in .*switchyard\.config\.yaml/);
    await expect(keysCommand(sy, ["remove", "42"], {}, true)).rejects.toThrow(/unknown key vault:42/);
  });
});

describe("doctor", () => {
  it("checks each provider: keys, cooldowns, invalid keys, the last listing, and literal secrets in the config", async () => {
    env = makeEnv({
      config: baseConfig({ providers: { ...testProviders(["groq", "cerebras"]), mistral: { keys: [{ api_key_env: "SY_TEST_UNSET_MISTRAL_KEY", billing_class: "free_tier" }] } } }),
      endpoints: [],
    });
    sy = open(env, fakeProviders());
    const before = doctorChecks(sy);
    expect(before.find((c) => c.check === "provider groq")).toMatchObject({ level: "warn", detail: expect.stringMatching(/never listed: run switchyard models scan/) });

    await sy.scan();
    const groqKey = sy.providers.credentials().get("config:groq:literal:0")!;
    sy.providers.keys.recordFailure(groqKey, new ProviderError("rate_limited", "slow down", { provider: "groq", status: 429, retryAfterMs: 60_000 }));
    addKey(sy, "groq", GOOD, { billing: "free_tier" });

    const checks = doctorChecks(sy);
    const byName = Object.fromEntries(checks.map((c) => [c.check, c]));
    // groq: one key cooling, the vault key available, listed with two models.
    expect(byName["provider groq"]).toMatchObject({ ok: true, level: "ok" });
    expect(byName["provider groq"]!.detail).toMatch(/2 keys, 1 available, 1 cooling down until .*Z/);
    expect(byName["provider groq"]!.detail).toMatch(/last listing .*: 2 models; 0 of 2 stored models active/);
    // cerebras: its only key was rejected while listing, so the listing failed with the provider's message.
    expect(byName["provider cerebras"]).toMatchObject({ level: "warn", ok: true });
    expect(byName["provider cerebras"]!.detail).toMatch(/FAILED: cerebras \(config:cerebras:literal:0\): .*Wrong API Key/);
    // mistral: the env var is unset, so it has no usable key.
    expect(byName["provider mistral"]).toMatchObject({ level: "fail", ok: false });
    expect(byName["provider mistral"]!.detail).toMatch(/SY_TEST_UNSET_MISTRAL_KEY is not set/);
    // The test config holds literal keys.
    expect(byName["secrets in config"]).toMatchObject({ level: "warn", ok: true });
    expect(byName["secrets in config"]!.detail).toMatch(/providers\.groq\.keys\[0\].*providers\.cerebras\.keys\[0\].*use api_key_env/);
    expect(byName["secrets in config"]!.detail).not.toContain("test-groq-key");

    // An invalid key marks the provider failed once no key is left.
    sy.providers.keys.recordFailure("config:cerebras:literal:0", new ProviderError("auth_invalid", "Wrong API Key", { provider: "cerebras", status: 401 }));
    const after = doctorChecks(sy).find((c) => c.check === "provider cerebras")!;
    expect(after).toMatchObject({ level: "fail", ok: false });
    expect(after.detail).toMatch(/1 invalid \(config:cerebras:literal:0 \.\.\.-key\)/);

    const text = doctorText(doctorChecks(sy));
    expect(text).toMatch(/^ok\s+config/m);
    expect(text).toMatch(/^FAIL\s+provider mistral/m);
    expect(text).toMatch(/^WARN\s+secrets in config/m);
  });

  it("with no key anywhere, says how to add one", () => {
    env = makeEnv({ config: baseConfig({ providers: {} }), endpoints: [] });
    sy = open(env, fakeProviders());
    const keysCheck = doctorChecks(sy).find((c) => c.check === "provider keys")!;
    expect(keysCheck).toMatchObject({ ok: false, level: "fail", detail: expect.stringMatching(/switchyard keys add <provider> --billing <class>/) });
    expect(doctorChecks(sy).some((c) => c.check === "secrets in config")).toBe(false);
  });
});

// The built CLI (pnpm --filter switchyard-router build): the secret goes in through the environment only.
const cliJs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

describe("keys through the built CLI", () => {
  it.skipIf(!existsSync(cliJs))("keys add reads SWITCHYARD_NEW_KEY and keys list never prints the secret", () => {
    env = makeEnv({ config: baseConfig({ providers: {} }), endpoints: [] });
    const run = (args: string[], extra: Record<string, string> = {}) => {
      const e: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== NEW_KEY_ENV && k !== "SWITCHYARD_MASTER_KEY") e[k] = v;
      return spawnSync(process.execPath, [cliJs, ...args, "--config", env!.cfg.configPath], { encoding: "utf8", env: { ...e, ...extra }, timeout: 30_000 });
    };
    const add = run(["keys", "add", "groq", "--billing", "free_tier", "--label", "cli"], { [NEW_KEY_ENV]: GOOD });
    expect(add.status, add.stderr).toBe(0);
    expect(add.stdout).toMatch(/added key vault:1 for groq \(\.\.\.1234\), free_tier/);
    const list = run(["keys", "list", "--json"]);
    expect(list.status, list.stderr).toBe(0);
    expect(JSON.parse(list.stdout)).toEqual([expect.objectContaining({ ref: "vault:1", provider: "groq", last4: "1234", status: "available" })]);
    expect(list.stdout + add.stdout + add.stderr).not.toContain(GOOD);
    const noSecret = run(["keys", "add", "groq", "--billing", "free_tier"]);
    expect(noSecret.status).toBe(1);
    expect(noSecret.stderr).toMatch(/set SWITCHYARD_NEW_KEY/);
  });
});
