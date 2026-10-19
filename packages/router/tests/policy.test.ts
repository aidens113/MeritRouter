import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.js";
import { evidenceUniverse, validateWorkerOutput } from "../src/core/worker-output.js";
import { normalizeOpenAiUsage } from "../src/gateway/types.js";
import { planRoute } from "../src/routing/select.js";
import { Catalog } from "../src/models/catalog.js";
import { openDatabase } from "../src/storage/db.js";
import { baseConfig, endpoint, makeEnv, open, ScriptedClient, reply, summarizeTask, type Env } from "./helpers.js";

let env: Env | undefined;
afterEach(() => env?.cleanup());

const noQual = () => null;

function catalogFor(e: Env) {
  const db = openDatabase(e.cfg.storageDir);
  return { db, catalog: new Catalog(db, e.cfg.modelsPath, { requireConfirmationForHeuristicParams: true }) };
}

describe("size floors and eligibility", () => {
  it("a 100B task type rejects 30B and unknown-size models", () => {
    env = makeEnv({
      endpoints: [
        endpoint({ gatewayModelId: "small", totalParametersB: 30 }),
        endpoint({ gatewayModelId: "unknown", totalParametersB: null }),
        endpoint({ gatewayModelId: "big", totalParametersB: 120 }),
      ],
    });
    const { db, catalog } = catalogFor(env);
    const plan = planRoute(env.cfg, catalog.endpoints(), [], { profile: "analyze", tier: "T2", inputModalities: ["text"], needsStructuredOutput: false }, { now: new Date(), qualification: noQual });
    expect(plan.candidates.map((c) => c.gatewayModelId)).toEqual(["big"]);
    const why = Object.fromEntries(plan.explanations.map((e) => [e.endpointId.split("/")[1], e.reasons.join("; ")]));
    expect(why.small).toMatch(/30B is below the 100B floor/);
    expect(why.unknown).toMatch(/parameter count unknown/);
    db.close();
  });

  it("stale metadata, unverified pricing, disabled models and missing modalities are excluded with reasons", () => {
    env = makeEnv({
      endpoints: [
        endpoint({ gatewayModelId: "stale", checkedAt: "2020-01-01T00:00:00Z" }),
        endpoint({ gatewayModelId: "paid", pricing: { inputUsdPerMillion: 0.2, outputUsdPerMillion: 0.8, freeVerified: false } }),
        endpoint({ gatewayModelId: "off", enabled: false }),
        endpoint({ gatewayModelId: "textonly" }),
        endpoint({ gatewayModelId: "vision", inputModalities: ["text", "image"] }),
      ],
    });
    const { db, catalog } = catalogFor(env);
    const plan = planRoute(env.cfg, catalog.endpoints(), [], { profile: "summarize", tier: "T1", inputModalities: ["text", "image"], needsStructuredOutput: false }, { now: new Date(), qualification: noQual });
    expect(plan.candidates.map((c) => c.gatewayModelId)).toEqual(["vision"]);
    const reasons = plan.explanations.flatMap((e) => e.reasons).join("\n");
    expect(reasons).toMatch(/metadata is \d+ days old/);
    expect(reasons).toMatch(/not verified free/);
    expect(reasons).toMatch(/disabled/);
    expect(reasons).toMatch(/cannot read image input/);
    db.close();
  });

  it("prefers the smallest sufficient model for T1/T2 and the most capable for T3", () => {
    env = makeEnv({ endpoints: [endpoint({ gatewayModelId: "huge", totalParametersB: 550 }), endpoint({ gatewayModelId: "mid", totalParametersB: 120 })] });
    const { db, catalog } = catalogFor(env);
    const t2 = planRoute(env.cfg, catalog.endpoints(), [], { profile: "analyze", tier: "T2", inputModalities: ["text"], needsStructuredOutput: false }, { now: new Date(), qualification: noQual });
    expect(t2.candidates.map((c) => c.gatewayModelId)).toEqual(["mid", "huge"]);
    const t3 = planRoute(env.cfg, catalog.endpoints(), [], { profile: "analyze", tier: "T3", inputModalities: ["text"], needsStructuredOutput: false }, { now: new Date(), qualification: noQual });
    expect(t3.candidates.map((c) => c.gatewayModelId)).toEqual(["huge", "mid"]);
    db.close();
  });

  it("platforms FreeLLMAPI reports as cooling down move to the end of the order", () => {
    env = makeEnv({ endpoints: [endpoint({ providerId: "groq", gatewayModelId: "small", totalParametersB: 120 }), endpoint({ providerId: "kilo", gatewayModelId: "big", totalParametersB: 550 })] });
    const { db, catalog } = catalogFor(env);
    const health = (p: string) => (p === "groq" ? { status: "rate_limited", resumeAt: Date.now() + 60_000 } : undefined);
    const plan = planRoute(env.cfg, catalog.endpoints(), [], { profile: "analyze", tier: "T2", inputModalities: ["text"], needsStructuredOutput: false }, { now: new Date(), qualification: noQual, health });
    expect(plan.candidates.map((c) => c.id)).toEqual(["kilo/big", "groq/small"]);
    expect(plan.explanations.find((e) => e.endpointId === "groq/small")!.coolingDownUntil).not.toBeNull();
    db.close();
  });

  it("manual overrides: force, prefer, block, and below-floor forcing", () => {
    env = makeEnv({ endpoints: [endpoint({ gatewayModelId: "a", totalParametersB: 120 }), endpoint({ gatewayModelId: "b", totalParametersB: 200 }), endpoint({ gatewayModelId: "tiny", totalParametersB: 30 })] });
    const { db, catalog } = catalogFor(env);
    const req = { profile: "analyze" as const, tier: "T2" as const, inputModalities: ["text" as const], needsStructuredOutput: false };
    const deps = { now: new Date(), qualification: noQual };
    catalog.addRoutingOverride({ profile: "analyze", tier: null, kind: "prefer", endpointId: "openrouter/b", allowBelowFloor: false, enabled: true });
    expect(planRoute(env.cfg, catalog.endpoints(), catalog.routingOverrides(), req, deps).candidates.map((c) => c.gatewayModelId)).toEqual(["b", "a"]);
    catalog.addRoutingOverride({ profile: null, tier: "T2", kind: "block", endpointId: "openrouter/a", allowBelowFloor: false, enabled: true });
    expect(planRoute(env.cfg, catalog.endpoints(), catalog.routingOverrides(), req, deps).candidates.map((c) => c.gatewayModelId)).toEqual(["b"]);
    catalog.addRoutingOverride({ profile: "analyze", tier: "T2", kind: "force", endpointId: "openrouter/tiny", allowBelowFloor: true, enabled: true });
    const forced = planRoute(env.cfg, catalog.endpoints(), catalog.routingOverrides(), req, deps);
    expect(forced.candidates.map((c) => c.gatewayModelId)).toEqual(["tiny"]);
    expect(forced.belowFloorEndpoints.has("openrouter/tiny")).toBe(true);
    // A per-task forced endpoint cannot bypass the floor.
    const perTask = planRoute(env.cfg, catalog.endpoints(), [], { ...req, forcedEndpointId: "openrouter/tiny" }, deps);
    expect(perTask.candidates).toHaveLength(0);
    db.close();
  });

  it("heuristic parameter counts wait for confirmation; a panel override activates them", () => {
    env = makeEnv({ endpoints: [endpoint({ gatewayModelId: "guess", params: { source: "name", confidence: "heuristic", confirmed: false, evidence: [] } })] });
    const { db, catalog } = catalogFor(env);
    expect(catalog.get("openrouter/guess")!.status).toBe("pending_confirmation");
    catalog.setOverride("openrouter/guess", { confirmParams: true });
    expect(catalog.get("openrouter/guess")!.status).toBe("active");
    catalog.setOverride("openrouter/guess", { forceStatus: "disabled" });
    expect(catalog.get("openrouter/guess")!.status).toBe("disabled");
    db.close();
  });
});

describe("configuration policy", () => {
  it("refuses paid routing", () => {
    env = makeEnv();
    expect(() => parseConfig(baseConfig({ spend: { paid_fallback_enabled: true, max_paid_usd_per_week: 5 } }), env!.cfg.configPath)).toThrow(/paid routing is not available/);
  });

  it("requires increasing tier thresholds", () => {
    env = makeEnv();
    const bad = baseConfig({
      tiers: {
        T1: { max_score: 5, min_total_parameters_b: 30, max_model_requests: 4 },
        T2: { max_score: 4, min_total_parameters_b: 100, max_model_requests: 8 },
        T3: { max_score: 11, min_total_parameters_b: 100, max_model_requests: 12 },
      },
    });
    expect(() => parseConfig(bad, env!.cfg.configPath)).toThrow(/must increase/);
  });

  it("a task cannot opt into paid routing", async () => {
    env = makeEnv();
    const sy = open(env, new ScriptedClient(() => reply("{}")));
    await expect(sy.submitTasks([summarizeTask({ budget: { maxPaidUsd: 1 } })])).rejects.toThrow(/paid routing is disabled/);
    await sy.close();
  });

  it("rejects unresolved aliases, unknown artifacts, unknown forced endpoints and dependency cycles", async () => {
    env = makeEnv();
    const sy = open(env, new ScriptedClient(() => reply("{}")));
    await expect(sy.submitTasks([summarizeTask({ repositoryAliases: ["nope"] })])).rejects.toThrow(/unknown repository alias/);
    await expect(sy.submitTasks([summarizeTask({ context: { artifactRefs: ["artifact:missing"] } })])).rejects.toThrow(/unknown artifact/);
    await expect(sy.submitTasks([summarizeTask({ routing: { endpointId: "x/y" } })])).rejects.toThrow(/not in the model catalog/);
    await expect(sy.submitTasks([summarizeTask({ id: "a", dependsOn: ["b"] }), summarizeTask({ id: "b", dependsOn: ["a"] })])).rejects.toThrow(/dependency cycle/);
    await sy.close();
  });

  it("rejects a task that cannot fit any model before dispatch", async () => {
    env = makeEnv({ endpoints: [endpoint({ contextLimitTokens: 4000 })] });
    const client = new ScriptedClient(() => reply("{}"));
    const sy = open(env, client);
    await expect(sy.submitTasks([summarizeTask({ context: { inlineText: "x".repeat(30000) } })])).rejects.toThrow(/does not fit any available model/);
    expect(client.requests).toHaveLength(0);
    await sy.close();
  });
});

describe("evidence validation", () => {
  const universe = () => evidenceUniverse([{ baseRef: "core:src/app.ts", totalLines: 4 }, { baseRef: "inline", totalLines: 3 }]);

  it("rejects invented refs, out-of-range lines, and met-without-evidence", () => {
    const r = validateWorkerOutput(
      { summary: "s", findings: [{ description: "d", evidenceRefs: ["core:src/other.ts#L1-L2", "core:src/app.ts#L3-L99"] }], criteria: [{ index: 0, status: "met", evidenceRefs: [] }] },
      { acceptanceCriteria: ["c"], universe: universe() },
    );
    expect(r.ok).toBe(false);
    const errors = r.ok ? "" : r.errors.join("\n");
    expect(errors).toMatch(/not provided or read/);
    expect(errors).toMatch(/past the end/);
    expect(errors).toMatch(/met without evidenceRefs/);
  });

  it("requires every criterion exactly once and never reports self-assessed success as met", () => {
    expect(validateWorkerOutput({ summary: "s", criteria: [] }, { acceptanceCriteria: ["c"], universe: universe() }).ok).toBe(false);
    const ok = validateWorkerOutput({ summary: "s", criteria: [{ index: 0, status: "met", evidenceRefs: ["core:src/app.ts#L1-L2"] }] }, { acceptanceCriteria: ["c"], universe: universe() });
    expect(ok.ok && ok.value.acceptanceStatus).toBe("not_verified");
    const unmet = validateWorkerOutput({ summary: "s", criteria: [{ index: 0, status: "unmet", evidenceRefs: [] }] }, { acceptanceCriteria: ["c"], universe: universe() });
    expect(unmet.ok && unmet.value.acceptanceStatus).toBe("unmet");
    expect(unmet.ok && unmet.value.unresolvedCriteria).toEqual(["c"]);
  });
});

describe("token reporting", () => {
  it("does not add cached or reasoning tokens on top of totals", () => {
    const u = normalizeOpenAiUsage({ prompt_tokens: 1000, completion_tokens: 300, total_tokens: 1300, prompt_tokens_details: { cached_tokens: 600 }, completion_tokens_details: { reasoning_tokens: 200 } });
    expect(u).toMatchObject({ inputTokens: 1000, outputTokens: 300, cachedInputTokens: 600, reasoningTokens: 200, basis: "provider_reported" });
  });
});
