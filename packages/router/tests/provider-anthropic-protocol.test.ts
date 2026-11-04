import { describe, expect, it } from "vitest";
import { ProvidersSectionSchema } from "../src/config/schema.js";
import { buildAnthropicBody, completeAnthropic } from "../src/providers/anthropic.js";
import { resolveProviders } from "../src/providers/registry.js";
import type { ProviderRequest } from "../src/providers/client.js";
import type { ChatMessage } from "../src/gateway/types.js";
import { buildOpenAiBody } from "../src/providers/openai-compatible.js";
import { baseConfig, makeEnv, open } from "./helpers.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { capturedLease } from "../src/storage/task-leases.js";
import { effectiveBudget } from "../src/admission/admission.js";

const model = "synthetic-always-adaptive";
const provider = resolveProviders(ProvidersSectionSchema.parse({})).get("anthropic")!;
const protocol = {
  api: "anthropic" as const, provider: "anthropic", baseUrl: "https://api.anthropic.com/v1", model,
  thinking: { supported: true, adaptive: true, enabled: false, disabled: false },
  sourceUrl: "https://platform.claude.com/docs/en/api/models/list", checkedAt: new Date().toISOString(),
};
const tool = { type: "function" as const, function: { name: "record", description: "Record an observed decision", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } } };
function request(choice: "auto" | "none" | "required" = "required") {
  return { provider, credential: { apiKey: "fake-test-only-key" }, model, timeoutMs: 1000, anthropicProtocol: protocol,
    chat: { messages: [{ role: "user" as const, content: "Use record to return the decision" }], tools: [tool], tool_choice: choice, max_tokens: 100 } };
}

describe("native Anthropic model protocol", () => {
  it("uses auto for required calls only with the current route's observed always-adaptive protocol", () => {
    const req = request();
    expect(buildAnthropicBody(req).tool_choice).toEqual({ type: "auto" });
    expect(req.chat.tool_choice).toBe("required");
  });
  it("retains forced choice for older disable-capable models and normal auto/none choices", () => {
    expect(buildAnthropicBody({ ...request(), anthropicProtocol: { ...protocol, thinking: { supported: true, adaptive: true, enabled: true, disabled: true } } }).tool_choice).toEqual({ type: "any" });
    expect(buildAnthropicBody(request("auto")).tool_choice).toEqual({ type: "auto" });
    expect(buildAnthropicBody(request("none")).tool_choice).toEqual({ type: "none" });
  });
  it("does not apply another route's native metadata after host or model changes", () => {
    expect(buildAnthropicBody({ ...request(), model: "different-model" }).tool_choice).toEqual({ type: "any" });
    expect(buildAnthropicBody({ ...request(), provider: { ...provider, baseUrl: "https://proxy.example.test/v1" } }).tool_choice).toEqual({ type: "any" });
    expect(buildAnthropicBody({ ...request(), anthropicProtocol: { ...protocol, thinking: { ...protocol.thinking, supported: false } } }).tool_choice).toEqual({ type: "any" });
  });
  it("omits unsupported sampling only for the observed always-adaptive contract", () => {
    const req = request();
    expect(buildAnthropicBody({ ...req, chat: { ...req.chat, temperature: 0 } })).not.toHaveProperty("temperature");
    expect(buildAnthropicBody({ ...req, anthropicProtocol: { ...protocol, thinking: { supported: true, adaptive: true, enabled: true, disabled: true } }, chat: { ...req.chat, temperature: 0 } })).toHaveProperty("temperature", 0);
  });
  it("performs one native transport attempt without fabricating a tool call or retrying a text response", async () => {
    const bodies: Record<string, unknown>[] = [];
    const res = await completeAnthropic(async (_url, init) => {
      const body = JSON.parse(init.body!); bodies.push(body);
      if (body.tool_choice?.type !== "auto") return new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "tool_choice: type tool and any are not supported for this model" } }), { status: 400 });
      return Response.json({ model, content: [{ type: "text", text: "A plain answer is not a recorded decision" }], usage: { input_tokens: 10, output_tokens: 8 }, stop_reason: "end_turn" });
    }, request() as ProviderRequest, Date.now);
    expect(bodies).toHaveLength(1);
    expect(res.message.content).toContain("plain answer");
    expect(res.message.tool_calls).toBeUndefined();
  });
  it("echoes the entire original signed assistant content and order through a tool-result round trip", async () => {
    const blocks = [
      { type: "thinking", thinking: "", signature: "opaque-signature", vendor_field: { preserved: true } },
      { type: "redacted_thinking", data: "opaque-redacted-bytes", signature: "redacted-signature" },
      { type: "text", text: "I will record this" },
      { type: "tool_use", id: "c1", name: "record", input: { value: "observed" } },
    ];
    const req = request();
    const response = await completeAnthropic(async () => Response.json({ model, content: blocks, usage: { input_tokens: 10, output_tokens: 20 }, stop_reason: "tool_use" }), req, Date.now);
    const messages: ChatMessage[] = [...req.chat.messages, { role: "assistant", ...response.message }, { role: "tool", tool_call_id: "c1", content: "recorded" }];
    const body = buildAnthropicBody({ ...req, chat: { ...req.chat, messages } }) as { messages: Array<{ role: string; content: unknown[] }> };
    expect(body.messages[1]!.content).toEqual(blocks);
    expect(response.message.nativeContinuation!.content).toEqual(blocks);
    expect(JSON.stringify(body)).not.toContain("prefix_mismatch_behavior");
    const foreign = buildOpenAiBody(resolveProviders(ProvidersSectionSchema.parse({})).get("openrouter")!, { model: "foreign", chat: { ...req.chat, messages } });
    expect(JSON.stringify(foreign)).not.toContain("nativeContinuation");
    expect(JSON.stringify(foreign)).not.toContain("opaque-signature");
  });
  it("retains signed native history across Anthropic model switches without borrowing the source model's protocol", async () => {
    const req = request();
    const blocks = [{ type: "thinking", thinking: "source model reasoning", signature: "native-model-bound-signature" }, { type: "tool_use", id: "c1", name: "record", input: { value: "observed" } }];
    const response = await completeAnthropic(async () => Response.json({ model, content: blocks, usage: { input_tokens: 10, output_tokens: 20 }, stop_reason: "tool_use" }), req, Date.now);
    const messages: ChatMessage[] = [...req.chat.messages, { role: "assistant", ...response.message }, { role: "tool", tool_call_id: "c1", content: "recorded" }];
    const switched = buildAnthropicBody({ ...req, model: "different-native-model", chat: { ...req.chat, messages } }) as { model: string; messages: Array<{ content: unknown[] }>; tool_choice: unknown };
    expect(switched.model).toBe("different-native-model");
    expect(switched.messages[1]!.content).toEqual(blocks);
    expect(response.message.nativeContinuation!.model).toBe(model);
    // The signed history is not a capability source for the new target; normal target
    // protocol selection remains exact model-bound, independently of API replay rules.
    expect(switched.tool_choice).toEqual({ type: "any" });
    const returned = buildAnthropicBody({ ...req, chat: { ...req.chat, messages } }) as { messages: Array<{ content: unknown[] }> };
    expect(returned.messages[1]!.content).toEqual(blocks);
    const moved = buildAnthropicBody({ ...req, provider: { ...provider, baseUrl: "https://different-native-host.example/v1" }, chat: { ...req.chat, messages } });
    expect(JSON.stringify(moved)).not.toContain("native-model-bound-signature");
  });
  it("invalidates rewritten-prefix thinking but preserves newly generated thinking on the following turn", async () => {
    const firstBlocks = [{ type: "thinking", thinking: "old", signature: "old-signature" }, { type: "tool_use", id: "c1", name: "record", input: { value: "first" } }];
    const req = request();
    const first = await completeAnthropic(async () => Response.json({ model, content: firstBlocks, usage: { input_tokens: 10, output_tokens: 20 }, stop_reason: "tool_use" }), req, Date.now);
    const rewritten: ChatMessage[] = [{ role: "user", content: "Legitimately compacted earlier context. Use record." }, { role: "assistant", ...first.message }, { role: "tool", tool_call_id: "c1", content: "first result" }];
    const secondBlocks = [{ type: "thinking", thinking: "new context", signature: "fresh-signature" }, { type: "tool_use", id: "c2", name: "record", input: { value: "second" } }];
    let secondBody: Record<string, unknown> = {};
    const second = await completeAnthropic(async (_url, init) => { secondBody = JSON.parse(init.body!); return Response.json({ model, content: secondBlocks, usage: { input_tokens: 20, output_tokens: 25 }, stop_reason: "tool_use" }); }, { ...req, chat: { ...req.chat, messages: rewritten } }, Date.now);
    expect(JSON.stringify(secondBody)).not.toContain("old-signature");
    const next = buildAnthropicBody({ ...req, chat: { ...req.chat, messages: [...rewritten, { role: "assistant", ...second.message }, { role: "tool", tool_call_id: "c2", content: "second result" }] } });
    expect(JSON.stringify(next)).not.toContain("old-signature");
    expect(JSON.stringify(next)).toContain("fresh-signature");
  });
  it("treats semantic cache_control keys inside tool inputs as prefix content, not cache annotations", async () => {
    const req = request();
    const messages: ChatMessage[] = [...req.chat.messages, { role: "assistant", content: null, tool_calls: [{ id: "prior", type: "function", function: { name: "record", arguments: JSON.stringify({ cache_control: "original user value" }) } }] }, { role: "tool", tool_call_id: "prior", content: "prior result" }];
    const blocks = [{ type: "thinking", thinking: "reasoning", signature: "must-expire" }, { type: "tool_use", id: "c2", name: "record", input: { value: "new" } }];
    const result = await completeAnthropic(async () => Response.json({ model, content: blocks, usage: { input_tokens: 20, output_tokens: 20 }, stop_reason: "tool_use" }), { ...req, chat: { ...req.chat, messages } }, Date.now);
    const changed = structuredClone(messages);
    if (changed[1]?.role === "assistant") changed[1].tool_calls![0]!.function.arguments = JSON.stringify({ cache_control: "changed semantic value" });
    expect(JSON.stringify(buildAnthropicBody({ ...req, chat: { ...req.chat, messages: [...changed, { role: "assistant", ...result.message }, { role: "tool", tool_call_id: "c2", content: "result" }] } }))).not.toContain("must-expire");
  });
  it.each(["malformed", "oversized"])("retains paid uncertainty for a consumed HTTP200 %s native response", async invalid => {
    const env = makeEnv({ config: baseConfig({ storage: { directory: ".meritrouter", layout: "legacy" }, paid: {
      enabled: true, tiers: { T1: "preferred" }, budgets: { per_week_usd: 1 },
      providers: { anthropic: { kind: "anthropic", base_url: "https://api.anthropic.com" } },
      models: [{ provider: "anthropic", model, input_usd_per_million: 2, output_usd_per_million: 8, context_limit_tokens: 64000, output_limit_tokens: 8000, ignore_size_floor: true, supports_tools: true }],
    } }), endpoints: [] });
    let calls = 0;
    const sy = open(env, { fetch: async () => {
      calls++;
      return Response.json({ model, content: invalid === "malformed" ? [{ type: 7 }] : [{ type: "thinking", thinking: "x".repeat(2 * 1024 * 1024), signature: "opaque" }], usage: { input_tokens: 10, output_tokens: 20 }, stop_reason: "end_turn" });
    } }, { worker: false });
    try {
      sy.vault.add({ provider: "anthropic", secret: "fake-test-only-key", billingClass: "paid_credits", prepaidBalanceUsd: 1 });
      sy.tasks.submit([WorkerTaskSchema.parse({ id: "native-fixture", profile: "summarize", goal: "Synthetic native protocol fixture", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["native data checked"] }, budget: { maxModelRequests: 1, maxPaidUsd: 1 } })], { project: sy.cfg.brain.project });
      const stored = sy.tasks.claim("fixture-owner", { maxConcurrent: 1, maxWritersPerRepo: 1, leaseMs: 60000, defaultTimeoutMs: 60000 })[0]!;
      const plan = sy.router.plan("summarize", "T1", ["text"]);
      await expect(sy.gate.request({ plan, executionId: sy.admission.createExecution("task", "summarize", [{ taskId: stored.row.id, itemId: stored.row.id }]), purpose: "native protocol fixture", participants: [{ taskId: stored.row.id, leaseOwner: "fixture-owner", lease: capturedLease(stored), budget: effectiveBudget(sy.cfg, stored.spec) }], chat: request("auto").chat })).rejects.toMatchObject({ possiblyConsumed: true });
      expect(calls).toBe(1);
      const row = sy.db.prepare("SELECT reserved_usd,actual_usd,cost_basis FROM paid_spend").get() as { reserved_usd: number; actual_usd: number | null; cost_basis: string };
      expect(row.reserved_usd).toBeGreaterThan(0);
      expect(row.actual_usd).toBe(row.reserved_usd);
      expect(row.cost_basis).toBe("uncertain");
    } finally { await sy.close(); env.cleanup(); }
  });
});
