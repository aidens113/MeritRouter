import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Switchyard } from "../src/core/service.js";
import type { DirectClient, DirectRequest } from "../src/paid/direct.js";
import { toAnthropic } from "../src/paid/direct.js";
import { GatewayError } from "../src/core/errors.js";
import { baseConfig, goodOutput, makeEnv, open, reply, ScriptedClient, servedFor, summarizeTask, type Env } from "./helpers.js";

let env: Env | undefined;
let sy: Switchyard | undefined;
afterEach(async () => {
  await sy?.close();
  sy = undefined;
  env?.cleanup();
});

const paidCfg = (paid: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  baseConfig({
    paid: {
      enabled: true,
      budgets: { per_week_usd: 5 },
      tiers: { T1: "on_free_exhaustion", T2: "on_free_exhaustion", T3: "on_free_exhaustion" },
      providers: { acme: { kind: "openai_compatible", base_url: "https://api.acme.test/v1" } },
      models: [{ provider: "acme", model: "acme-large", input_usd_per_million: 2, output_usd_per_million: 8, context_limit_tokens: 100000, output_limit_tokens: 8000, ignore_size_floor: true }],
      ...paid,
    },
    ...extra,
  });

class FakeDirect implements DirectClient {
  calls: DirectRequest[] = [];
  constructor(public handler: (r: DirectRequest) => ReturnType<DirectClient["complete"]> = async (r) => ({ ...reply(JSON.stringify(goodOutput()), { model: r.model, provider: `paid:${r.providerName}` }), usage: { inputTokens: 1000, outputTokens: 500, cachedInputTokens: null, reasoningTokens: null, reportedCostUsd: null, basis: "provider_reported" } })) {}
  complete(r: DirectRequest) {
    this.calls.push(r);
    return this.handler(r);
  }
}

const PAID_ID = "paid:acme/acme-large";

describe("vault", () => {
  it("encrypts secrets at rest and never lists them", async () => {
    env = makeEnv({ config: paidCfg() });
    sy = open(env, new ScriptedClient(() => reply("{}")));
    const k = sy.vault.add({ provider: "acme", label: "main", secret: "sk-acme-very-secret-123", billingClass: "paid_credits", prepaidBalanceUsd: 10 });
    expect(k).toMatchObject({ last4: "-123", billingClass: "paid_credits", prepaidBalanceUsd: 10 });
    expect(JSON.stringify(sy.vault.list())).not.toContain("very-secret");
    expect(sy.vault.secret(k.id)).toBe("sk-acme-very-secret-123");
    const dbBytes = readFileSync(path.join(env.cfg.storageDir, "switchyard.db"));
    expect(dbBytes.includes(Buffer.from("very-secret"))).toBe(false);
  });
});

describe("paid routing policy", () => {
  it("paid models wait behind free ones on_free_exhaustion, lead when preferred, and are excluded when never", async () => {
    env = makeEnv({ config: paidCfg() });
    sy = open(env, new ScriptedClient(() => reply("{}")));
    sy.vault.add({ provider: "acme", secret: "sk-acme-0000-1111" });
    const ids = (tier: "T1" | "T2", policy?: "preferred" | "never") => sy!.router.plan("summarize", tier, ["text"], undefined, false, policy).candidates.map((c) => c.id);
    expect(ids("T1")).toEqual(["openrouter/vendor/big-a:free", PAID_ID]);
    expect(ids("T1", "preferred")).toEqual([PAID_ID, "openrouter/vendor/big-a:free"]);
    expect(ids("T1", "never")).toEqual(["openrouter/vendor/big-a:free"]);
  });

  it("without a key, an unknown price, or with paid disabled, paid models are excluded with reasons", async () => {
    env = makeEnv({ config: paidCfg({ models: [{ provider: "acme", model: "acme-large", context_limit_tokens: 100000, output_limit_tokens: 8000, ignore_size_floor: true }] }) });
    sy = open(env, new ScriptedClient(() => reply("{}")));
    const ex = () => sy!.router.plan("summarize", "T1", ["text"]).explanations.find((e) => e.endpointId === PAID_ID)!;
    expect(ex().reasons.join(";")).toMatch(/no enabled key/);
    sy.vault.add({ provider: "acme", secret: "sk-acme-0000-1111" });
    expect(ex().reasons.join(";")).toMatch(/price unknown/);
  });

  it("a FreeLLMAPI key marked paid blocks its platform from free routing", async () => {
    env = makeEnv({ config: paidCfg() });
    sy = open(env, new ScriptedClient(() => reply("{}")));
    sy.spend.setFreeLlmApiKeyBilling(7, "openrouter", "paid_postpaid");
    const ex = sy.router.plan("summarize", "T1", ["text"]).explanations.find((e) => e.endpointId === "openrouter/vendor/big-a:free")!;
    expect(ex.reasons.join(";")).toMatch(/marked paid/);
  });
});

describe("paid execution", () => {
  it("uses paid only after free capacity fails, reserves the worst case, and settles to the billed cost", async () => {
    env = makeEnv({ config: paidCfg() });
    const free = new ScriptedClient(() => {
      throw new GatewayError("pool_exhausted", "all free keys cooling down", 429, 60_000, false);
    });
    const direct = new FakeDirect();
    sy = open(env, free, { worker: true, directClient: direct });
    sy.vault.add({ provider: "acme", secret: "sk-acme-0000-1111", prepaidBalanceUsd: 3 });
    const [sub] = await sy.submitTasks([summarizeTask()]);
    const r = (await sy.awaitResults([sub!.taskId], { timeoutSeconds: 10 })).completed[0]!;
    expect(r.executionStatus).toBe("completed");
    expect(r.routing!.attempts.map((a) => a.outcome)).toEqual(["pool_exhausted", "succeeded"]);
    expect(direct.calls[0]!.apiKey).toBe("sk-acme-0000-1111");
    // 1000 in x $2/M + 500 out x $8/M = $0.006
    expect(r.usage.estimatedCostUsd).toBeCloseTo(0.006, 6);
    const s = sy.spend.summary();
    expect(s.week).toBeCloseTo(0.006, 6);
    expect(s.keys[0]!.remainingBalanceUsd).toBeCloseTo(3 - 0.006, 6);
  });

  it("budgets stop paid requests before dispatch: weekly window, key balance, and task cap", async () => {
    env = makeEnv({ config: paidCfg({ budgets: { per_week_usd: 0.01 }, tiers: { T1: "preferred" } }) });
    const direct = new FakeDirect();
    sy = open(env, new ScriptedClient((req) => reply(JSON.stringify(goodOutput()), servedFor(sy!, req))), { worker: true, directClient: direct });
    sy.vault.add({ provider: "acme", secret: "sk-acme-0000-1111" });
    // max_output_tokens 2000 x $8/M = $0.016 worst case > $0.01 weekly budget: paid is skipped, free serves.
    const [a] = await sy.submitTasks([summarizeTask()]);
    const ra = (await sy.awaitResults([a!.taskId], { timeoutSeconds: 10 })).completed[0]!;
    expect(direct.calls).toHaveLength(0);
    expect(ra.servedEndpoints).toEqual(["openrouter/vendor/big-a:free"]);
    expect(ra.routing!.attempts[0]!.outcome).toMatch(/skipped \(paid budget\).*weekly paid budget/);
  });

  it("a task-level maxPaidUsd cap is enforced", async () => {
    env = makeEnv({ config: paidCfg({ tiers: { T1: "preferred" } }), endpoints: [] });
    const direct = new FakeDirect();
    sy = open(env, new ScriptedClient(() => reply("{}")), { worker: true, directClient: direct });
    sy.vault.add({ provider: "acme", secret: "sk-acme-0000-1111" });
    const [a] = await sy.submitTasks([summarizeTask({ budget: { maxPaidUsd: 0.001 } })]);
    const r = (await sy.awaitResults([a!.taskId], { timeoutSeconds: 10 })).completed[0]!;
    expect(direct.calls).toHaveLength(0);
    expect(r.stopReason).toMatch(/paid_budget_exhausted/);
  });

  it("T4 work goes to paid models when the T4 policy is premium", async () => {
    env = makeEnv({ config: paidCfg({ tiers: { T4: "premium" } }) });
    const direct = new FakeDirect();
    sy = open(env, new ScriptedClient((req) => reply(JSON.stringify(goodOutput()), servedFor(sy!, req))), { worker: true, directClient: direct });
    sy.vault.add({ provider: "acme", secret: "sk-acme-0000-1111" });
    const [a] = await sy.submitTasks([summarizeTask({ hints: { difficulty: "T4" } })]);
    const r = (await sy.awaitResults([a!.taskId], { timeoutSeconds: 10 })).completed[0]!;
    expect(r.classification!.tier).toBe("T4");
    // Execution went to the paid model (premium T4 runs at T3, which is deep: a reviewer serves too).
    expect(sy.gate.admission.servedEndpointsByPurpose(a!.taskId).execution).toEqual([PAID_ID]);
  });

  it("an uncertain paid failure keeps the worst case charged", async () => {
    env = makeEnv({ config: paidCfg({ tiers: { T1: "preferred" } }), endpoints: [] });
    const direct = new FakeDirect(async () => {
      throw new GatewayError("transport", "connection reset", undefined, undefined, true);
    });
    sy = open(env, new ScriptedClient(() => reply("{}")), { worker: true, directClient: direct });
    sy.vault.add({ provider: "acme", secret: "sk-acme-0000-1111" });
    const [a] = await sy.submitTasks([summarizeTask({ budget: { timeoutSeconds: 2 } })]);
    await sy.awaitResults([a!.taskId], { timeoutSeconds: 5 });
    const s = sy.spend.summary();
    expect(s.week).toBeGreaterThan(0);
  });
});

describe("anthropic conversion", () => {
  it("maps system, images, tool calls and tool results", () => {
    const c = toAnthropic([
      { role: "system", content: "rules" },
      { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
      { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } }] },
      { role: "tool", tool_call_id: "t1", content: "file body" },
      { role: "user", content: "continue" },
    ]);
    expect(c.system).toBe("rules");
    expect(c.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(c.messages[0]!.content[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } });
    expect(c.messages[1]!.content[0]).toEqual({ type: "tool_use", id: "t1", name: "read_file", input: { path: "a" } });
    expect(c.messages[2]!.content).toEqual([{ type: "tool_result", tool_use_id: "t1", content: "file body" }, { type: "text", text: "continue" }]);
  });
});

