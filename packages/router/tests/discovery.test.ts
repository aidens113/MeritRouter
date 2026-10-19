import { afterEach, describe, expect, it } from "vitest";
import { parseParamsFromDescription, parseParamsFromName, resolveParams } from "../src/models/params.js";
import { FreeLlmApiClient } from "../src/gateway/freellmapi.js";
import type { FreeLlmApiAdmin, FreeLlmApiModel, FreeLlmApiProfile, FreeLlmApiProfileModel } from "../src/gateway/freellmapi-admin.js";
import type { Switchyard } from "../src/core/service.js";
import { baseConfig, makeEnv, open, reply, ScriptedClient, type Env } from "./helpers.js";

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

/** In-memory FreeLLMAPI admin double that records chain writes. */
class FakeAdmin {
  profiles: FreeLlmApiProfile[] = [];
  members = new Map<number, Array<{ modelDbId: number; priority: number; enabled: boolean }>>();
  constructor(public models: FreeLlmApiModel[]) {}
  async listModels() {
    return this.models;
  }
  async listProfiles() {
    return this.profiles;
  }
  async createEmptyProfile(name: string) {
    const p = { id: this.profiles.length + 1, name, type: "custom", auto_include_new_models: 0 };
    this.profiles.push(p);
    return p;
  }
  async setProfileMembers(id: number, m: Array<{ modelDbId: number; priority: number; enabled: boolean }>) {
    this.members.set(id, m);
  }
  async profileModels(id: number): Promise<FreeLlmApiProfileModel[]> {
    return (this.members.get(id) ?? []).map((m) => {
      const model = this.models.find((x) => x.id === m.modelDbId)!;
      return { model_db_id: m.modelDbId, priority: m.priority, enabled: m.enabled, platform: model.platform, model_id: model.modelId, display_name: null, size_label: null, rpm_limit: null, rpd_limit: null, tpm_limit: null, tpd_limit: null };
    });
  }
}

const flModel = (id: number, platform: string, modelId: string, o: Partial<FreeLlmApiModel> = {}): FreeLlmApiModel => ({
  id,
  platform,
  modelId,
  displayName: null,
  sizeLabel: "Large",
  rpmLimit: 20,
  rpdLimit: 50,
  tpmLimit: null,
  tpdLimit: null,
  contextWindow: 131072,
  enabled: true,
  supportsVision: false,
  supportsTools: true,
  source: "catalog",
  hasProvider: true,
  keyCount: 2,
  ...o,
});

describe("catalog scanning", () => {
  it("scans every model, assigns params with provenance, and syncs single-model chains", async () => {
    env = makeEnv({ config: baseConfig({ gateway: { adapter: "freellmapi", base_url: "http://127.0.0.1:9/v1", require_verified_chains: true }, discovery: { free_platforms: ["groq"] }, models: {} }) });
    const admin = new FakeAdmin([
      flModel(1, "openrouter", "vendor/moe-120b-a12b:free", { supportsVision: true }),
      flModel(2, "groq", "openai/gpt-oss-120b"),
      flModel(3, "groq", "mystery-model"),
      flModel(4, "openrouter", "vendor/paid-70b"),
    ]);
    const fetchImpl = (async (url: string) => {
      if (url.includes("openrouter")) {
        return new Response(
          JSON.stringify({
            data: [
              { id: "vendor/moe-120b-a12b:free", description: "MoE with 12B active parameters out of 120B total", architecture: { input_modalities: ["text", "image", "video"] }, pricing: { prompt: "0", completion: "0" }, top_provider: { max_completion_tokens: 16000 }, supported_parameters: ["tools", "response_format"] },
              { id: "openai/gpt-oss-120b", hugging_face_id: "openai/gpt-oss-120b", pricing: { prompt: "0.0000001", completion: "0.0000005" } },
              { id: "vendor/paid-70b", pricing: { prompt: "0.000001", completion: "0.000002" } },
            ],
          }),
        );
      }
      if (url.endsWith("/openai/gpt-oss-120b")) return new Response(JSON.stringify({ safetensors: { total: 116829156672 } }));
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    sy = open(env, new ScriptedClient(() => reply("{}")), { admin: admin as unknown as FreeLlmApiAdmin, fetchImpl });
    const summary = await sy.scan();
    expect(summary.errors).toEqual([]);
    expect(summary.scanned).toBe(4);

    const moe = sy.catalog.get("openrouter/vendor/moe-120b-a12b:free")!;
    expect(moe).toMatchObject({ totalParametersB: 120, activeParametersB: 12, status: "active", outputLimitTokens: 16000, supportsStructuredOutput: true });
    expect(moe.params.confidence).toBe("agreed");
    expect(moe.inputModalities.sort()).toEqual(["image", "text", "video"]);
    expect(moe.pricing.freeVerified).toBe(true);

    const oss = sy.catalog.get("groq/openai/gpt-oss-120b")!;
    expect(oss).toMatchObject({ totalParametersB: 116.8, status: "active" });
    expect(oss.params.confidence).toBe("exact");
    expect(oss.pricing.source).toMatch(/declared a free platform/);
    expect(oss.outputLimitSource).toBe("default");

    expect(sy.catalog.get("groq/mystery-model")!.status).toBe("pending_confirmation");
    const paid = sy.catalog.get("openrouter/vendor/paid-70b")!;
    expect(paid.pricing.freeVerified).toBe(false);
    expect(paid.status).toBe("pending_confirmation"); // name-only evidence

    // Chains: one per active endpoint, each containing exactly that model, verified.
    expect(summary.chainsSynced).toBe(2);
    for (const id of ["openrouter/vendor/moe-120b-a12b:free", "groq/openai/gpt-oss-120b"]) {
      const ep = sy.catalog.get(id)!;
      expect(await sy.chains.ensureVerified(ep)).toBeNull();
    }
    // A chain that gains an extra member fails verification.
    const chain = admin.profiles.find((p) => p.name === oss.chainName)!;
    admin.members.set(chain.id, [{ modelDbId: 2, priority: 1, enabled: true }, { modelDbId: 4, priority: 2, enabled: true }]);
    const v = await sy.chains.verify(oss);
    expect(v.ok).toBe(false);
    expect(v.problems[0]).toMatch(/must contain exactly/);

    // A model that disappears from FreeLLMAPI is marked removed.
    admin.models = admin.models.filter((m) => m.id !== 2);
    await sy.scan();
    expect(sy.catalog.get("groq/openai/gpt-oss-120b")!.status).toBe("removed");
  });
});

describe("FreeLLMAPI adapter", () => {
  const fetchReturning = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })) as unknown as typeof fetch;

  it("reads served model, fallback hops and usage; sends cache bypass", async () => {
    let sent: RequestInit | undefined;
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      sent = init;
      return new Response(JSON.stringify({ model: "vendor/x", _routed_via: { platform: "kilo", model: "vendor/x" }, choices: [{ message: { content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } }), {
        status: 200,
        headers: { "x-routed-via": "kilo/vendor/x", "x-fallback-attempts": "2" },
      });
    }) as unknown as typeof fetch;
    const c = new FreeLlmApiClient({ baseUrl: "http://gw/v1", apiKey: "k", timeoutMs: 5000, bypassCache: true, fetchImpl });
    const r = await c.complete({ model: "auto:sy-abc", messages: [{ role: "user", content: "x" }], max_tokens: 10 });
    expect(r.telemetry).toMatchObject({ servedModel: "vendor/x", servedProvider: "kilo", providerAttempts: 3, providerAttemptsExact: false });
    expect((sent!.headers as Record<string, string>)["x-freellm-cache"]).toBe("bypass");
  });

  it("refuses raw model ids and whole-catalog aliases", async () => {
    const c = new FreeLlmApiClient({ baseUrl: "http://gw/v1", apiKey: "k", timeoutMs: 5000, bypassCache: true, fetchImpl: fetchReturning(200, {}) });
    await expect(c.complete({ model: "vendor/raw", messages: [], max_tokens: 1 })).rejects.toThrow(/bypass curated chains/);
    await expect(c.complete({ model: "auto:fastest", messages: [], max_tokens: 1 })).rejects.toThrow(/whole-catalog sort/);
  });

  it("classifies exhaustion and pre-attempt errors", async () => {
    const mk = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      new FreeLlmApiClient({ baseUrl: "http://gw/v1", apiKey: "k", timeoutMs: 5000, bypassCache: true, fetchImpl: fetchReturning(status, body, headers) });
    await expect(mk(429, { error: { message: "x", code: "routing_exhausted" } }).complete({ model: "auto:sy-a", messages: [], max_tokens: 1 })).rejects.toMatchObject({ kind: "pool_exhausted", possiblyConsumed: false });
    await expect(mk(429, { error: { message: "slow down", type: "rate_limit_error" } }, { "retry-after": "7" }).complete({ model: "auto:sy-a", messages: [], max_tokens: 1 })).rejects.toMatchObject({ kind: "rate_limited", retryAfterMs: 7000, possiblyConsumed: false });
    await expect(mk(400, { error: { message: "Profile not found" } }).complete({ model: "auto:sy-a", messages: [], max_tokens: 1 })).rejects.toMatchObject({ kind: "unknown_model" });
  });
});
