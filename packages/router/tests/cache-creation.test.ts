import { afterEach, describe, expect, it, vi } from "vitest";
import type { MeritRouter } from "../src/core/service.js";
import { actualUsd, endpointPrice, worstCaseUsd } from "../src/paid/spend.js";
import { ModelResponseDataSchema } from "../src/sessions/events.js";
import { quarantineReason } from "../src/gateway/quarantine.js";
import { planRoute } from "../src/routing/select.js";
import { baseConfig, makeEnv, open, type Env } from "./helpers.js";

let env: Env | undefined;
let sy: MeritRouter | undefined;
afterEach(async () => { await sy?.close(); sy = undefined; env?.cleanup(); env = undefined; });

const chat = {
  messages: [{ role: "system" as const, content: "system" }, { role: "user" as const, content: "x".repeat(3000) }],
  max_tokens: 100,
  tools: [{ type: "function" as const, function: { name: "read", description: "read", parameters: { type: "object", properties: {} } } }],
};

async function ask(writePrice: number | undefined, usage: Record<string, number>, search = false) {
  env = makeEnv({ config: baseConfig({ web: { native: { enabled: true } }, paid: {
    enabled: true, budgets: { per_week_usd: 5 }, tiers: { T1: "preferred" },
    providers: { anthropic: { kind: "anthropic", base_url: "https://api.anthropic.test/v1" } },
    models: [{ provider: "anthropic", model: "claude-test", input_usd_per_million: 2, output_usd_per_million: 8,
      cached_input_usd_per_million: 0.2, ...(writePrice === undefined ? {} : { cache_write_input_usd_per_million: writePrice }),
      context_limit_tokens: 100000, output_limit_tokens: 8000, supports_tools: true, ignore_size_floor: true }],
  } }), endpoints: [] });
  const bodies: Record<string, unknown>[] = [];
  sy = open(env, { fetch: async (_url, init) => {
    bodies.push(JSON.parse(init.body!));
    return new Response(JSON.stringify({ model: "claude-test", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage }), { status: 200, headers: { "content-type": "application/json" } });
  } });
  sy.vault.add({ provider: "anthropic", secret: "fake-test-key" });
  if (search) sy.catalog.setOverride("paid:anthropic/claude-test", { nativeWebSearch: { via: "anthropic_server_tool", usdPerSearch: 0.001 } });
  const plan = planRoute(sy.cfg, sy.catalog.endpoints(), [], { profile: "summarize", tier: "T1", inputModalities: ["text"], needsStructuredOutput: false, web: search }, { now: new Date(), qualification: () => null });
  const reservations = vi.spyOn(sy.gate.admission, "reserve");
  const result = await sy.gate.request({ plan, executionId: sy.gate.admission.createExecution("task", "summarize", []), purpose: "completion", participants: [], chat });
  return { result, bodies, reservation: reservations.mock.results[0]!.value! };
}

describe("cache creation accounting", () => {
  it("reserves the highest configured input rate and prices ordinary/read/write separately", () => {
    const price = endpointPrice({ inputUsdPerMillion: 2, outputUsdPerMillion: 8, cachedInputUsdPerMillion: 0.2, cacheWriteInputUsdPerMillion: 3 });
    expect(actualUsd(1000, 100, price, 600, 0, 300)).toBeCloseTo(0.00202, 9);
    expect(worstCaseUsd(1000, 100, price)).toBeCloseTo(0.0053, 9);
    expect(actualUsd(1000, 100, { in: 2, out: 8 }, 0, 0, 1)).toBe(Infinity);
    expect(actualUsd(1000, 100, { in: 2, out: 8 })).toBeCloseTo(0.0028, 9);
  });
  it("normalizes and persists cache creation separately, and settles the configured price", async () => {
    const { result, bodies } = await ask(3, { input_tokens: 100, output_tokens: 100, cache_read_input_tokens: 600, cache_creation_input_tokens: 300 });
    expect(JSON.stringify(bodies[0])).toContain("cache_control");
    expect(result.response.usage).toMatchObject({ inputTokens: 1000, cachedInputTokens: 600, cacheCreationInputTokens: 300 });
    const logged = ModelResponseDataSchema.parse({ requestId: result.requestId, endpointId: result.endpoint.id, content: "ok", toolCalls: [], finishReason: "stop", usage: result.response.usage, servedModel: "claude-test", servedProvider: "anthropic", attempts: [], estimatedInputTokens: 1000 });
    expect(logged.usage.cacheCreationInputTokens).toBe(300);
    expect(sy!.db.prepare("SELECT input_tokens, cached_input_tokens, cache_creation_input_tokens FROM model_requests").get()).toEqual({ input_tokens: 1000, cached_input_tokens: 600, cache_creation_input_tokens: 300 });
    expect(sy!.spend.summary().week).toBeCloseTo(0.00202, 6);
    const spend = sy!.db.prepare("SELECT reserved_usd, actual_usd FROM paid_spend").get() as { reserved_usd: number; actual_usd: number };
    expect(spend.reserved_usd).toBeGreaterThan(spend.actual_usd);
    expect(spend.reserved_usd).toBeCloseTo(worstCaseUsd(result.estimatedInputTokens, chat.max_tokens, { in: 2, out: 8, cachedIn: 0.2, cacheWriteIn: 3 }), 6);
  });
  it("authoritative reported cost overrides configured token arithmetic", async () => {
    const { result, reservation } = await ask(3, { input_tokens: 100, output_tokens: 100, cache_read_input_tokens: 600, cache_creation_input_tokens: 300 });
    sy!.gate.admission.reconcile(reservation, { kind: "succeeded", servedEndpointId: result.endpoint.id, response: { ...result.response, usage: { ...result.response.usage, reportedCostUsd: 0.0007 } } });
    expect(sy!.spend.summary().week).toBeCloseTo(0.0007, 6);
    expect(sy!.db.prepare("SELECT cost_basis FROM paid_spend").get()).toEqual({ cost_basis: "provider_reported" });
  });
  it("unknown write price removes every actual wire marker while ordinary paid calls work", async () => {
    const { result, bodies } = await ask(undefined, { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toHaveProperty("system");
    expect(bodies[0]).toHaveProperty("messages");
    expect(bodies[0]).toHaveProperty("tools");
    expect(JSON.stringify(bodies[0])).not.toContain("cache_control");
    expect(result.response.usage.cacheCreationInputTokens).toBe(0);
    expect(sy!.spend.summary().week).toBeCloseTo(0.00028, 6);
  });
  it("known write price still disables caching for internal server-search loops", async () => {
    const { bodies } = await ask(3, { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0 }, true);
    expect(JSON.stringify(bodies[0])).toContain("web_search");
    expect(JSON.stringify(bodies[0])).not.toContain("cache_control");
  });
  it("unexpected unknown-price writes retain a finite uncertain charge and quarantine the endpoint", async () => {
    await expect(ask(undefined, { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 300 })).rejects.toThrow(/cache creation.*quarantined/);
    const row = sy!.db.prepare("SELECT actual_usd, reserved_usd, cost_basis FROM paid_spend").get() as { actual_usd: number; reserved_usd: number; cost_basis: string };
    expect(row.cost_basis).toBe("uncertain");
    expect(row.actual_usd).toBe(row.reserved_usd);
    expect(Number.isFinite(row.actual_usd)).toBe(true);
    expect(JSON.stringify(row)).not.toContain("null");
    expect(quarantineReason(sy!.db, "paid:anthropic/claude-test")).toMatch(/cache creation.*disabled prompt caching/);
    expect(sy!.db.prepare("SELECT cache_creation_input_tokens, served_endpoint_id FROM model_requests").get()).toEqual({ cache_creation_input_tokens: 300, served_endpoint_id: null });
  });
  it("older usage without creation remains unknown in persisted rows", async () => {
    const { result } = await ask(undefined, { input_tokens: 100, output_tokens: 10 });
    expect(result.response.usage.cacheCreationInputTokens).toBeNull();
    const oldUsage = { ...result.response.usage };
    delete oldUsage.cacheCreationInputTokens;
    expect(ModelResponseDataSchema.parse({ requestId: result.requestId, endpointId: result.endpoint.id, content: "ok", toolCalls: [], finishReason: "stop", usage: oldUsage, servedModel: null, servedProvider: null, attempts: [], estimatedInputTokens: 1 }).usage).not.toHaveProperty("cacheCreationInputTokens");
    expect(sy!.db.prepare("SELECT cache_creation_input_tokens FROM model_requests").get()).toEqual({ cache_creation_input_tokens: null });
  });
});
