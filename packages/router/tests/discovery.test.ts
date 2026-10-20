import { afterEach, describe, expect, it } from "vitest";
import { parseParamsFromDescription, parseParamsFromName, resolveParams } from "../src/models/params.js";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { parseConfig } from "../src/config/load.js";
import type { Switchyard } from "../src/core/service.js";
import { baseConfig, FakeProvider, makeEnv, open, providerJson, providerModels, testProviders, type Env } from "./helpers.js";

let env: Env | undefined;
let sy: Switchyard | undefined;
afterEach(async () => {
  await sy?.close();
  sy = undefined;
  env?.cleanup();
});

describe("parameter evidence", () => {
  it("parses MoE and dense names", () => {
    expect(parseParamsFromName("qwen3-235b-a22b")).toMatchObject({ totalB: 235, activeB: 22 });
    expect(parseParamsFromName("nvidia/nemotron-3-ultra-550b-a55b:free")).toMatchObject({ totalB: 550, activeB: 55 });
    expect(parseParamsFromName("llama-3.1-8b-instruct")).toMatchObject({ totalB: 8, activeB: null });
    expect(parseParamsFromName("deepseek-v3")).toBeNull();
    expect(parseParamsFromName("gpt-oss-120b")).toMatchObject({ totalB: 120 });
  });

  it("parses prose descriptions", () => {
    expect(parseParamsFromDescription("open MoE model with 12B active parameters out of 120B total")).toMatchObject({ totalB: 120, activeB: 12 });
    expect(parseParamsFromDescription("A 70 billion parameter model")).toMatchObject({ totalB: 70 });
  });

  it("ranks evidence: Hugging Face exact > agreeing heuristics > single heuristic > unknown", () => {
    expect(resolveParams([{ source: "huggingface", totalB: 116.8, activeB: null, detail: "" }, { source: "name", totalB: 120, activeB: 5.1, detail: "" }])).toMatchObject({ totalParametersB: 116.8, activeParametersB: 5.1, confidence: "exact" });
    expect(resolveParams([{ source: "name", totalB: 120, activeB: null, detail: "" }, { source: "description", totalB: 124, activeB: null, detail: "" }])).toMatchObject({ totalParametersB: 120, confidence: "agreed" });
    expect(resolveParams([{ source: "name", totalB: 8, activeB: null, detail: "" }])).toMatchObject({ confidence: "heuristic" });
    expect(resolveParams([{ source: "name", totalB: 30, activeB: null, detail: "" }, { source: "description", totalB: 300, activeB: null, detail: "" }])).toMatchObject({ totalParametersB: 30, confidence: "heuristic" });
    expect(resolveParams([])).toMatchObject({ totalParametersB: null, confidence: "unknown" });
  });
});

describe("models scan", () => {
  const OPENROUTER_MODELS = [
    { id: "vendor/moe-120b-a12b:free", description: "MoE with 12B active parameters out of 120B total", context_length: 131072, architecture: { input_modalities: ["text", "image"] }, pricing: { prompt: "0", completion: "0" }, top_provider: { context_length: 131072, max_completion_tokens: 16000 }, supported_parameters: ["tools", "response_format"] },
  ];

  it("lists every provider with a usable key, records the scan, and refreshes free daily quotas", async () => {
    const fake = new FakeProvider((call) => {
      if (call.url === "https://openrouter.ai/api/v1/models") return providerModels(OPENROUTER_MODELS);
      if (call.url === "https://api.groq.com/openai/v1/models") return providerModels(["llama-3.3-70b-versatile"]);
      if (call.url === "https://openrouter.ai/api/v1/key") return providerJson({ data: { label: "test", free_model_daily_requests: { used: 10, limit: 50, remaining: 40 } } });
      return providerJson({ error: { message: "not found" } }, 404);
    });
    env = makeEnv({ config: baseConfig({ providers: testProviders(["openrouter", "groq"]) }), endpoints: [] });
    sy = open(env, fake);
    expect(sy.scanner.lastScan()).toBeNull();
    const summary = await sy.scan();
    expect(summary.providers.sort()).toEqual(["groq", "openrouter"]);
    expect(summary.added.sort()).toEqual(["groq/llama-3.3-70b-versatile", "openrouter/vendor/moe-120b-a12b:free"]);
    expect(summary.scanned).toBe(2);

    const moe = sy.catalog.get("openrouter/vendor/moe-120b-a12b:free")!;
    expect(moe).toMatchObject({ totalParametersB: 120, activeParametersB: 12, status: "active", route: { kind: "direct", provider: "openrouter", model: "vendor/moe-120b-a12b:free" } });
    expect(moe.pricing.freeVerified).toBe(true);

    // OpenRouter's key-info endpoint was asked for the key's free daily quota, and it was stored.
    expect(fake.calls.filter((c) => c.url === "https://openrouter.ai/api/v1/key").map((c) => c.key)).toEqual(["test-openrouter-key"]);
    expect(sy.providers.keys.get("config:openrouter:literal:0")!.quota).toMatchObject({ used: 10, limit: 50, remaining: 40 });

    const last = sy.scanner.lastScan()!;
    expect(last).toMatchObject({ ok: summary.errors.length === 0 });
    expect(last.summary).toMatchObject({ scanned: 2, providers: summary.providers });
    expect(sy.db.prepare("SELECT COUNT(*) AS n FROM events WHERE task_id IS NULL AND type = 'provider_discovery'").get()).toEqual({ n: 1 });
  });

  it("with no provider key, says what to add", async () => {
    env = makeEnv({ config: baseConfig({ providers: {} }), endpoints: [] });
    sy = open(env, new FakeProvider());
    const summary = await sy.scan();
    expect(summary.scanned).toBe(0);
    expect(summary.errors).toEqual([expect.stringMatching(/no provider has a usable key: add one under providers/)]);
    expect(sy.scanner.lastScan()).toMatchObject({ ok: false });
  });
});

describe("removed configuration", () => {
  it("a config with a gateway section fails and says to add provider keys instead", () => {
    const withGateway = baseConfig({ gateway: { adapter: "freellmapi", base_url: "http://127.0.0.1:9/v1", request_timeout_seconds: 60 } });
    expect(() => parseConfig(withGateway, "/tmp/sy.yaml")).toThrow(/gateway: the gateway section is no longer supported: SwitchYard calls providers directly\. Delete it and add your provider keys under providers/);
    expect(() => parseConfig(baseConfig({ discovery: { free_platforms: ["groq"] } }), "/tmp/sy.yaml")).toThrow(/discovery\.free_platforms: .*billing_class: free_tier/);
    expect(() => parseConfig(baseConfig({ discovery: { default_output_limit_tokens: 4096 } }), "/tmp/sy.yaml")).toThrow(/discovery\.default_output_limit_tokens: .*outputLimitTokens/);
  });
});

describe("shipped configuration", () => {
  it("the example config and every preset `init` writes parse without a gateway", () => {
    const examples = path.resolve(import.meta.dirname, "../examples");
    const files = [path.join(examples, "switchyard.config.example.yaml"), ...readdirSync(path.join(examples, "presets")).map((f) => path.join(examples, "presets", f))];
    expect(files.length).toBeGreaterThan(1);
    for (const file of files) {
      const raw = YAML.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      expect(raw.gateway, file).toBeUndefined();
      expect(() => parseConfig(raw, file), file).not.toThrow();
    }
  });
});
