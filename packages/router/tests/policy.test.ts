import { afterEach, describe, expect, it } from "vitest";
import { assessPool, requestFit } from "../src/models/eligibility.js";
import { parseConfig } from "../src/config/load.js";
import { evidenceUniverse, validateWorkerOutput } from "../src/core/worker-output.js";
import { normalizeOpenAiUsage } from "../src/gateway/types.js";
import { baseConfig, endpoint, makeEnv, open, ScriptedClient, reply, summarizeTask, type Env } from "./helpers.js";

let env: Env | undefined;
afterEach(() => env?.cleanup());

const policy = { now: new Date(), maxMetadataAgeDays: 30, paidRoutingAllowed: false };

describe("profile floor", () => {
  it("a 100B profile rejects 30B and unknown-size candidates", () => {
    env = makeEnv({
      endpoints: [
        endpoint({ id: "small", gatewayModelId: "vendor/small:free", totalParametersB: 30 }),
        endpoint({ id: "unknown", gatewayModelId: "vendor/unknown:free", totalParametersB: null }),
      ],
    });
    const analyze = assessPool(env.cfg.catalog, "analyze", env.cfg.profiles.analyze!, policy);
    expect(analyze.routable).toBe(false);
    const reasons = analyze.violations.flatMap((v) => v.reasons).join("\n");
    expect(reasons).toMatch(/30B below floor 100B/);
    expect(reasons).toMatch(/total parameter count unknown/);
    // The 30B endpoint is acceptable for the 30B floor; the unknown one is not.
    const summarize = assessPool(env.cfg.catalog, "summarize", env.cfg.profiles.summarize!, policy);
    expect(summarize.violations.map((v) => v.endpointId)).toEqual(["unknown"]);
  });

  it("stale metadata, unverified pricing and disabled endpoints make a pool unroutable", () => {
    env = makeEnv({
      endpoints: [
        endpoint({ id: "stale", gatewayModelId: "a", checkedAt: "2020-01-01T00:00:00Z" }),
        endpoint({ id: "paid", gatewayModelId: "b", pricing: { inputUsdPerMillion: 0.2, outputUsdPerMillion: 0.8, freeVerified: false } }),
        endpoint({ id: "off", gatewayModelId: "c", enabled: false }),
      ],
    });
    const pool = assessPool(env.cfg.catalog, "analyze", env.cfg.profiles.analyze!, policy);
    expect(pool.routable).toBe(false);
    expect(pool.violations.map((v) => v.endpointId).sort()).toEqual(["off", "paid", "stale"]);
  });
});

describe("context fit", () => {
  it("sizes requests for the smallest pool member", () => {
    env = makeEnv({
      endpoints: [endpoint({ id: "wide", gatewayModelId: "w", contextLimitTokens: 128000 }), endpoint({ id: "narrow", gatewayModelId: "n", contextLimitTokens: 8000 })],
    });
    const pool = assessPool(env.cfg.catalog, "summarize", env.cfg.profiles.summarize!, policy);
    expect(pool.contextLimitTokens).toBe(8000);
    expect(requestFit(pool, { inputTokens: 7000, outputTokens: 2000, needsTools: false, needsImages: false, needsStructuredOutput: false })).toHaveLength(1);
  });

  it("rejects an oversized task before dispatch", async () => {
    env = makeEnv({ endpoints: [endpoint({ contextLimitTokens: 4000 })] });
    const client = new ScriptedClient(() => reply("{}"));
    const sy = open(env, client);
    await expect(sy.submitTasks([summarizeTask({ context: { inlineText: "x".repeat(30000) } })])).rejects.toThrow(/does not fit/);
    expect(client.requests).toHaveLength(0);
    await sy.close();
  });
});

describe("configuration policy", () => {
  it("refuses to enable paid fallback the adapter cannot bound", () => {
    env = makeEnv();
    expect(() => parseConfig(baseConfig({ spend: { paid_fallback_enabled: true, max_paid_usd_per_week: 5 } }), env!.cfg.configPath)).toThrow(
      /cannot establish a cost bound/,
    );
  });

  it("rejects pool names FreeLLMAPI resolves to whole-catalog sorts", () => {
    env = makeEnv();
    const cfg = baseConfig();
    (cfg.profiles as Record<string, { gateway_model: string }>).summarize!.gateway_model = "auto:reliable";
    expect(() => parseConfig(cfg, env!.cfg.configPath)).toThrow(/whole-catalog sort/);
  });

  it("a task cannot opt into paid routing", async () => {
    env = makeEnv();
    const sy = open(env, new ScriptedClient(() => reply("{}")));
    await expect(sy.submitTasks([summarizeTask({ budget: { maxPaidUsd: 1 } })])).rejects.toThrow(/paid routing is disabled/);
    await sy.close();
  });

  it("rejects unresolved aliases, unknown artifacts and dependency cycles", async () => {
    env = makeEnv();
    const sy = open(env, new ScriptedClient(() => reply("{}")));
    await expect(sy.submitTasks([summarizeTask({ repositoryAliases: ["nope"] })])).rejects.toThrow(/unknown repository alias/);
    await expect(sy.submitTasks([summarizeTask({ context: { artifactRefs: ["artifact:missing"] } })])).rejects.toThrow(/unknown artifact/);
    await expect(
      sy.submitTasks([summarizeTask({ id: "a", dependsOn: ["b"] }), summarizeTask({ id: "b", dependsOn: ["a"] })]),
    ).rejects.toThrow(/dependency cycle/);
    await sy.close();
  });
});

describe("evidence validation", () => {
  const universe = () => evidenceUniverse([{ baseRef: "core:src/app.ts", totalLines: 4 }, { baseRef: "inline", totalLines: 3 }]);

  it("rejects invented refs, out-of-range lines, and met-without-evidence", () => {
    const r = validateWorkerOutput(
      {
        summary: "s",
        findings: [{ description: "d", evidenceRefs: ["core:src/other.ts#L1-L2", "core:src/app.ts#L3-L99"] }],
        criteria: [{ index: 0, status: "met", evidenceRefs: [] }],
      },
      { acceptanceCriteria: ["c"], universe: universe() },
    );
    expect(r.ok).toBe(false);
    const errors = r.ok ? [] : r.errors.join("\n");
    expect(errors).toMatch(/not provided or read/);
    expect(errors).toMatch(/past the end/);
    expect(errors).toMatch(/met without evidenceRefs/);
  });

  it("requires every criterion exactly once and never reports self-assessed success as met", () => {
    const missing = validateWorkerOutput({ summary: "s", criteria: [] }, { acceptanceCriteria: ["c"], universe: universe() });
    expect(missing.ok).toBe(false);
    const ok = validateWorkerOutput(
      { summary: "s", criteria: [{ index: 0, status: "met", evidenceRefs: ["core:src/app.ts#L1-L2"] }] },
      { acceptanceCriteria: ["c"], universe: universe() },
    );
    expect(ok.ok && ok.value.acceptanceStatus).toBe("not_verified");
    const unmet = validateWorkerOutput(
      { summary: "s", criteria: [{ index: 0, status: "unmet", evidenceRefs: [] }] },
      { acceptanceCriteria: ["c"], universe: universe() },
    );
    expect(unmet.ok && unmet.value.acceptanceStatus).toBe("unmet");
    expect(unmet.ok && unmet.value.unresolvedCriteria).toEqual(["c"]);
  });
});

describe("token reporting", () => {
  it("does not add cached or reasoning tokens on top of totals", () => {
    const u = normalizeOpenAiUsage({
      prompt_tokens: 1000,
      completion_tokens: 300,
      total_tokens: 1300,
      prompt_tokens_details: { cached_tokens: 600 },
      completion_tokens_details: { reasoning_tokens: 200 },
    });
    expect(u).toMatchObject({ inputTokens: 1000, outputTokens: 300, cachedInputTokens: 600, reasoningTokens: 200, basis: "provider_reported" });
  });
});
