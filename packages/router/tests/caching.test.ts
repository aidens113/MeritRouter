import { afterEach, describe, expect, it } from "vitest";
import type { MeritRouter } from "../src/core/service.js";
import { GatewayError } from "../src/core/errors.js";
import type { ChatMessage, ChatRequest, ChatResponse } from "../src/gateway/types.js";
import { ProvidersSectionSchema } from "../src/config/schema.js";
import { buildAnthropicBody, buildOpenAiBody, createProviderClient, listedFromOpenRouter, OpenRouterModelSchema, resolveProviders, type FetchLike, type ResolvedProvider } from "../src/providers/index.js";
import { planRoute, stickyOrder } from "../src/routing/select.js";
import { actualUsd, cacheSavingUsd, endpointPrice } from "../src/paid/spend.js";
import { compact, COMPACTED_PREFIX } from "../src/harness/compaction.js";
import { CONTINUE_TEXT } from "../src/harness/loop.js";
import { estimateTokens } from "../src/gateway/types.js";
import type { ModelEndpoint } from "../src/models/catalog.js";
import { baseConfig, endpoint, goodOutput, makeEnv, open, reply, ScriptedClient, servedFor, type Env, type ScriptedRequest } from "./helpers.js";

/**
 * Caching and continuity (C1-C2): provider cache hints, endpoint stickiness, cached-input
 * pricing, truncation recovery, and prefix-stable compaction.
 */

let env: Env | undefined;
let sy: MeritRouter | undefined;
afterEach(async () => {
  await sy?.close();
  sy = undefined;
  env?.cleanup();
});

const provider = (id: string, section: Record<string, unknown> = {}): ResolvedProvider => resolveProviders(ProvidersSectionSchema.parse(section)).get(id)!;
const tool = (name: string) => ({ type: "function" as const, function: { name, description: `${name} tool`, parameters: { type: "object", properties: {} } } });
const call = (name: string, args: unknown, id = "c1") => [{ id, type: "function" as const, function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } }];

describe("provider cache hints (C1)", () => {
  const chat = {
    messages: [
      { role: "system", content: "charter" },
      { role: "user", content: "task" },
      { role: "assistant", content: null, tool_calls: call("read", { path: "a" }) },
      { role: "tool", tool_call_id: "c1", content: "file a" },
    ] as ChatMessage[],
    max_tokens: 100,
    tools: [tool("read"), tool("submit")],
  };

  it("Anthropic bodies carry breakpoints on the last tool, the system prompt, and the newest message (at most four)", () => {
    const body = buildAnthropicBody({ model: "claude-x", chat, provider: provider("anthropic") }) as {
      system: Array<Record<string, unknown>>;
      tools: Array<Record<string, unknown>>;
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
    };
    expect(body.system).toEqual([{ type: "text", text: "charter", cache_control: { type: "ephemeral" } }]);
    expect(body.tools[0]).not.toHaveProperty("cache_control");
    expect(body.tools[1]).toMatchObject({ name: "submit", cache_control: { type: "ephemeral" } });
    const last = body.messages.at(-1)!;
    expect(last.content.at(-1)).toMatchObject({ type: "tool_result", tool_use_id: "c1", cache_control: { type: "ephemeral" } });
    const marks = JSON.stringify(body).match(/cache_control/g) ?? [];
    expect(marks).toHaveLength(3);
    // Earlier blocks stay unmarked: only the newest message moves the breakpoint.
    expect(JSON.stringify(body.messages.slice(0, -1))).not.toContain("cache_control");
  });

  it("a custom Anthropic-compatible provider gets no breakpoints unless configured", () => {
    const custom = provider("proxy", { proxy: { base_url: "https://proxy.test/v1", api: "anthropic" } });
    expect(custom.promptCache).toBe("none");
    const plain = buildAnthropicBody({ model: "m", chat, provider: custom });
    expect(JSON.stringify(plain)).not.toContain("cache_control");
    expect(plain.system).toBe("charter");
    const opted = provider("proxy", { proxy: { base_url: "https://proxy.test/v1", api: "anthropic", prompt_cache: "cache_control" } });
    expect(JSON.stringify(buildAnthropicBody({ model: "m", chat, provider: opted }))).toContain("cache_control");
  });

  it("prompt_cache_key goes only to providers the registry marks", () => {
    expect(buildOpenAiBody(provider("openai"), { model: "m", chat, cacheKey: "t_1" })).toMatchObject({ prompt_cache_key: "t_1" });
    expect(buildOpenAiBody(provider("openrouter"), { model: "m", chat, cacheKey: "t_1" })).toMatchObject({ prompt_cache_key: "t_1" });
    expect(buildOpenAiBody(provider("groq"), { model: "m", chat, cacheKey: "t_1" })).not.toHaveProperty("prompt_cache_key");
    expect(buildOpenAiBody(provider("groq", { groq: { prompt_cache: "prompt_cache_key" } }), { model: "m", chat, cacheKey: "t_1" })).toMatchObject({ prompt_cache_key: "t_1" });
    expect(buildOpenAiBody(provider("openai"), { model: "m", chat })).not.toHaveProperty("prompt_cache_key");
  });

  it("cacheHit follows the reported cached tokens (unknown when none are reported)", async () => {
    const answer = (usage: Record<string, unknown>): FetchLike => async () =>
      new Response(JSON.stringify({ model: "m", choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }], usage }), { status: 200, headers: { "content-type": "application/json" } });
    const run = (usage: Record<string, unknown>) =>
      createProviderClient({ fetch: answer(usage) }).complete({ provider: provider("groq"), credential: { apiKey: "k" }, model: "m", chat: { messages: [{ role: "user", content: "x" }], max_tokens: 10 }, timeoutMs: 1000 });
    expect((await run({ prompt_tokens: 100, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 90 } })).telemetry.cacheHit).toBe(true);
    expect((await run({ prompt_tokens: 100, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0 } })).telemetry.cacheHit).toBe(false);
    expect((await run({ prompt_tokens: 100, completion_tokens: 2 })).telemetry.cacheHit).toBeNull();
  });
});

describe("endpoint stickiness (C1)", () => {
  const small = endpoint({ providerId: "groq", gatewayModelId: "small:free", totalParametersB: 70 });
  const big = endpoint();
  const plan = (s: MeritRouter) => planRoute(s.cfg, s.catalog.endpoints(), [], { profile: "summarize", tier: "T1", inputModalities: ["text"], needsStructuredOutput: false }, { now: new Date(), qualification: () => null });
  const ask = (s: MeritRouter, preferEndpointId: string | null) =>
    s.gate.request({ plan: plan(s), executionId: s.gate.admission.createExecution("task", "summarize", []), purpose: "completion", participants: [], chat: { messages: [{ role: "user", content: "hi" }], max_tokens: 10 }, preferEndpointId });

  it("a healthy previous endpoint is tried first; an unhealthy one is not", async () => {
    env = makeEnv({ endpoints: [small, big] });
    const client = new ScriptedClient((req) => reply("ok", servedFor(sy!, req)));
    sy = open(env, client);
    expect(plan(sy).candidates.map((c) => c.id)).toEqual([small.id, big.id]);
    expect((await ask(sy, null)).attempts).toEqual([{ endpointId: small.id, outcome: "succeeded" }]);
    expect((await ask(sy, big.id)).attempts).toEqual([{ endpointId: big.id, outcome: "succeeded" }]);
    // Open the previous endpoint's breaker: the normal order applies again.
    for (let i = 0; i < 5; i++) sy.health.breakers.failure("openrouter", "server: down");
    expect(sy.health.breakers.blockedUntil("openrouter")).not.toBeNull();
    expect((await ask(sy, big.id)).attempts).toEqual([{ endpointId: small.id, outcome: "succeeded" }]);
  });

  it("stickiness can be turned off", async () => {
    env = makeEnv({ endpoints: [small, big], config: baseConfig({ routing: { sticky_endpoints: false } }) });
    sy = open(env, new ScriptedClient((req) => reply("ok", servedFor(sy!, req))));
    expect((await ask(sy, big.id)).attempts).toEqual([{ endpointId: small.id, outcome: "succeeded" }]);
  });

  it("never moves a paid endpoint ahead of a free one, and ignores endpoints that are not candidates", () => {
    const free = { id: "f", pricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0, freeVerified: true } } as ModelEndpoint;
    const paid = { id: "p", pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2, freeVerified: false } } as ModelEndpoint;
    const free2 = { ...free, id: "f2" } as ModelEndpoint;
    const ok = () => true;
    expect(stickyOrder([free, paid], "p", ok).map((e) => e.id)).toEqual(["f", "p"]);
    expect(stickyOrder([paid, free, free2], "f2", ok).map((e) => e.id)).toEqual(["f2", "p", "f"]);
    expect(stickyOrder([free, free2], "gone", ok).map((e) => e.id)).toEqual(["f", "f2"]);
    expect(stickyOrder([free, free2], "f2", () => false).map((e) => e.id)).toEqual(["f", "f2"]);
  });

  it("an agent loop stays on the endpoint that served its last turn, sends a cache key, and a resume prefers it", async () => {
    env = makeEnv({ endpoints: [small, big] });
    let groqCalls = 0;
    const client = new ScriptedClient((req) => {
      const s = servedFor(sy!, req);
      if (s.provider === "groq" && ++groqCalls === 1) throw new GatewayError("server", "upstream down", 502, undefined, true);
      const tools = req.messages.filter((m) => m.role === "tool").length;
      if (tools === 0) return reply(null, { ...s, toolCalls: call("read_file", { alias: "core", path: "src/app.ts" }) });
      return reply(null, { ...s, toolCalls: call("submit_result", goodOutput(1, "core:src/app.ts#L1-L3"), "s1") });
    });
    sy = open(env, client, { worker: true });
    const [sub] = await sy.submitTasks([{ profile: "inspect", goal: "Find add()", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["names the file"] } }]);
    const r = (await sy.awaitResults([sub!.taskId], { timeoutSeconds: 20 })).completed[0]!;
    expect(r.executionStatus).toBe("completed");
    // groq failed once; afterwards the loop stayed on openrouter although groq ranks first.
    expect(client.requests.map((q) => q.provider)).toEqual(["groq", "openrouter", "openrouter"]);
    const bodies = client.calls.filter((c) => c.url.endsWith("/chat/completions")).map((c) => c.body!);
    expect(bodies[0]).not.toHaveProperty("prompt_cache_key");
    expect(bodies.slice(1).map((b) => b.prompt_cache_key)).toEqual([sub!.taskId, sub!.taskId]);
    const session = sy.sessions.forTask(sub!.taskId)[0]!;
    expect(sy.sessions.planResume(session.id)!.lastEndpointId).toBe(big.id);
  }, 30_000);
});

describe("cached-input pricing (C1)", () => {
  it("prices cached tokens at the cached rate and reports the saving", () => {
    const price = endpointPrice({ inputUsdPerMillion: 2, outputUsdPerMillion: 8, cachedInputUsdPerMillion: 0.2 });
    // 200 new x $2 + 800 cached x $0.2 + 500 out x $8 = $0.00456
    expect(actualUsd(1000, 500, price, 800)).toBeCloseTo(0.00456, 9);
    expect(actualUsd(1000, 500, price)).toBeCloseTo(0.006, 9);
    expect(cacheSavingUsd(800, price)).toBeCloseTo(0.00144, 9);
    // Without a cached price, cached input costs the input price and no saving is claimed.
    const plain = endpointPrice({ inputUsdPerMillion: 2, outputUsdPerMillion: 8 });
    expect(actualUsd(1000, 500, plain, 800)).toBeCloseTo(0.006, 9);
    expect(cacheSavingUsd(800, plain)).toBeNull();
  });

  it("discovery reads OpenRouter's input_cache_read price", () => {
    const m = listedFromOpenRouter(OpenRouterModelSchema.parse({ id: "a/b", pricing: { prompt: "0.000002", completion: "0.000008", input_cache_read: "0.0000002" } }));
    expect(m.priceUsdPerMillion).toEqual({ input: 2, output: 8, cachedInput: expect.closeTo(0.2, 9) });
  });

  it("paid spend and task cost use the cached rate; cacheHit is recorded", async () => {
    env = makeEnv({
      config: baseConfig({
        paid: {
          enabled: true,
          budgets: { per_week_usd: 5 },
          tiers: { T1: "preferred" },
          providers: { acme: { kind: "openai_compatible", base_url: "https://api.acme.test/v1" } },
          models: [{ provider: "acme", model: "acme-large", input_usd_per_million: 2, output_usd_per_million: 8, cached_input_usd_per_million: 0.2, context_limit_tokens: 100000, output_limit_tokens: 8000, ignore_size_floor: true }],
        },
      }),
      endpoints: [],
    });
    const answer = (req: ScriptedRequest): ChatResponse => ({ ...reply(JSON.stringify(goodOutput()), { model: req.model, provider: "acme" }), usage: { inputTokens: 1000, outputTokens: 500, cachedInputTokens: 800, reasoningTokens: null, reportedCostUsd: null, basis: "provider_reported" } });
    sy = open(env, new ScriptedClient(answer), { worker: true });
    sy.vault.add({ provider: "acme", secret: "sk-acme-0000-1111" });
    expect(sy.catalog.get("paid:acme/acme-large")!.pricing).toMatchObject({ cachedInputUsdPerMillion: 0.2, cachedInputSource: "configured in paid.models" });
    const [sub] = await sy.submitTasks([{ profile: "summarize", goal: "Summarise", context: { inlineText: "x" }, constraints: { acceptanceCriteria: ["ok"] } }]);
    const r = (await sy.awaitResults([sub!.taskId], { timeoutSeconds: 10 })).completed[0]!;
    expect(r.executionStatus).toBe("completed");
    expect(r.usage.estimatedCostUsd).toBeCloseTo(0.00456, 6);
    expect(sy.spend.summary().week).toBeCloseTo(0.00456, 6);
    expect(sy.db.prepare("SELECT cache_hit FROM model_requests").get()).toEqual({ cache_hit: 1 });
  });
});

describe("truncation recovery (C2)", () => {
  const inspect = { profile: "inspect", goal: "Find add()", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["names the file"] } };
  const length = (r: ChatResponse): ChatResponse => ({ ...r, finishReason: "length" });
  const read = () => call("read_file", { alias: "core", path: "src/app.ts" }, "r1");
  const submit = () => call("submit_result", goodOutput(1, "core:src/app.ts#L1-L3"), "s1");
  /** After the scripted opening: read the file, then submit (evidence must come from a read). */
  const finish = (req: ChatRequest) => (req.messages.some((m) => m.role === "tool") ? submit() : read());

  it("a plain reply cut off at the limit gets one continuation on the same endpoint, joined to it", async () => {
    env = makeEnv();
    const client = new ScriptedClient((req, n) => {
      const s = servedFor(sy!, req);
      if (n === 1) return length(reply("I will read the file and ", s));
      if (n === 2) return reply("then submit.", { ...s, toolCalls: read() });
      return reply(null, { ...s, toolCalls: submit() });
    });
    sy = open(env, client, { worker: true });
    const [sub] = await sy.submitTasks([inspect]);
    const r = (await sy.awaitResults([sub!.taskId], { timeoutSeconds: 20 })).completed[0]!;
    expect(r.executionStatus).toBe("completed");
    const second = client.requests[1]!;
    expect(second.messages.at(-2)).toEqual({ role: "assistant", content: "I will read the file and " });
    expect(second.messages.at(-1)).toEqual({ role: "user", content: CONTINUE_TEXT });
    const transcript = sy.sessions.transcript(sy.sessions.forTask(sub!.taskId)[0]!.id)!;
    expect(transcript.some((m) => m.role === "user" && m.content === CONTINUE_TEXT)).toBe(false);
    expect(transcript.find((m) => m.role === "assistant")).toMatchObject({ content: "I will read the file and then submit.", tool_calls: [{ id: "r1" }] });
    expect(client.requests).toHaveLength(3);
  }, 30_000);

  it("a truncated tool call retries the turn once with a larger max_tokens, without keeping the broken reply", async () => {
    env = makeEnv();
    const client = new ScriptedClient((req, n) => {
      const s = servedFor(sy!, req);
      if (n === 1) return length(reply(null, { ...s, toolCalls: call("read_file", '{"alias": "core", "pa') }));
      return reply(null, { ...s, toolCalls: finish(req) });
    });
    sy = open(env, client, { worker: true });
    const [sub] = await sy.submitTasks([inspect]);
    const r = (await sy.awaitResults([sub!.taskId], { timeoutSeconds: 20 })).completed[0]!;
    expect(r.executionStatus).toBe("completed");
    const first = client.requests[0]!;
    const second = client.requests[1]!;
    expect(first.max_tokens).toBe(4000);
    expect(second.max_tokens).toBe(8000);
    expect(second.messages).toHaveLength(first.messages.length);
    expect(JSON.stringify(second.messages)).not.toContain('"pa');
  }, 30_000);

  it("when the endpoint allows no larger output, the retry goes to the next endpoint", async () => {
    const capped = endpoint({ providerId: "groq", gatewayModelId: "capped:free", totalParametersB: 70, outputLimitTokens: 4000 });
    env = makeEnv({ endpoints: [capped, endpoint()] });
    const client = new ScriptedClient((req, n) => {
      const s = servedFor(sy!, req);
      if (n === 1) return length(reply(null, { ...s, toolCalls: call("read_file", '{"alias": "co') }));
      return reply(null, { ...s, toolCalls: finish(req) });
    });
    sy = open(env, client, { worker: true });
    const [sub] = await sy.submitTasks([inspect]);
    const r = (await sy.awaitResults([sub!.taskId], { timeoutSeconds: 20 })).completed[0]!;
    expect(r.executionStatus).toBe("completed");
    // The retry avoided groq; the turns after it stay on openrouter (stickiness).
    expect(client.requests.map((q) => [q.provider, q.max_tokens])).toEqual([
      ["groq", 4000],
      ["openrouter", 4000],
      ["openrouter", 4000],
    ]);
  }, 30_000);
});

describe("prefix-stable compaction (C2)", () => {
  const OUTPUT = "x".repeat(3000); // about 1,000 tokens per tool output
  const turn = (i: number): ChatMessage[] => [
    { role: "assistant", content: null, tool_calls: call("read_file", { path: `f${i}` }, `c${i}`) },
    { role: "tool", tool_call_id: `c${i}`, content: `${i}:${OUTPUT}` },
  ];
  const head = (): ChatMessage[] => [
    { role: "system", content: "charter" },
    { role: "user", content: "task" },
  ];

  it("changes the prefix at most once per N turns, keeps the newest turn, and keeps tool calls paired", () => {
    const budget = 10_000;
    const messages = head();
    let previous: ChatMessage[] = [];
    let changes = 0;
    const TURNS = 60;
    for (let i = 0; i < TURNS; i++) {
      messages.push(...turn(i));
      compact(messages, budget);
      expect(estimateTokens(messages)).toBeLessThanOrEqual(budget);
      // The previous request must be a prefix of this one unless compaction rewrote it.
      const sent = structuredClone(messages);
      const prefixKept = previous.every((m, k) => JSON.stringify(m) === JSON.stringify(sent[k]));
      if (!prefixKept) changes++;
      previous = sent;
      // Every tool result follows the assistant message that called it.
      const ids = new Set<string>();
      for (const m of messages) {
        if (m.role === "assistant") for (const c of m.tool_calls ?? []) ids.add(c.id);
        if (m.role === "tool") expect(ids.has(m.tool_call_id)).toBe(true);
      }
      expect(messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: `c${i}` });
    }
    // Each compaction cuts to half the budget, so about five turns of growth pass between them;
    // eliding one output per turn (the old behaviour) changed the prefix on nearly every turn.
    const N = 4;
    expect(changes).toBeGreaterThan(0);
    expect(changes).toBeLessThanOrEqual(Math.ceil(TURNS / N));
    const summary = messages.find((m) => m.role === "user" && typeof m.content === "string" && m.content.startsWith(COMPACTED_PREFIX))!;
    expect(summary.content).toContain("read_file(");
    expect(messages.indexOf(summary)).toBe(2);
    // Every compacted call is listed once, across repeated compactions.
    const listed = (summary.content as string).split("\n").filter((l) => l.startsWith("- read_file("));
    const kept = messages.filter((m) => m.role === "assistant").length;
    expect(listed.length + kept).toBe(TURNS);
  });

  it("does nothing while the conversation fits, and stubs outputs only when the newest turn alone is too large", () => {
    const fits = [...head(), ...turn(0)];
    expect(compact(fits, 100_000)).toBe(false);
    const huge: ChatMessage[] = [...head(), ...turn(0), { role: "assistant", content: null, tool_calls: call("read_file", { path: "big" }, "big") }, { role: "tool", tool_call_id: "big", content: "y".repeat(60_000) }];
    expect(compact(huge, 5_000)).toBe(true);
    expect(huge.at(-1)).toMatchObject({ role: "tool", content: expect.stringMatching(/^\[elided/) });
  });
});
