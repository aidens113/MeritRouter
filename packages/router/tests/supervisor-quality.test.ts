import { afterEach, describe, expect, it } from "vitest";
import { planRoute } from "../src/routing/select.js";
import { SupervisorQualityRoutingSchema, assessSupervisorQuality } from "../src/routing/supervisor-quality.js";
import { ModelEndpointSchema, type ModelEndpoint } from "../src/models/catalog.js";
import { baseConfig, endpoint, makeEnv, open, reply, ScriptedClient, type Env } from "./helpers.js";
import type { MeritRouter } from "../src/core/service.js";
let env: Env | undefined, sy: MeritRouter | undefined;
afterEach(async () => { await sy?.close(); sy = undefined; env?.cleanup(); env = undefined; });
const now = new Date();
function quality(endpointId: string, value = 0.95) {
  return { schemaVersion: 1, endpointId, source: "fixture supervisor benchmark", checkedAt: new Date(now.getTime() - 1000).toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString(), classification: "qualified_supervisor", confidence: 0.95, trials: 20, scores: { planning: value, architecture: value, supervision: value, integration: value, review: value, product: value, visual: value } };
}
function model(id: string, providerId = "openrouter", paid = false): ModelEndpoint {
  return { ...ModelEndpointSchema.parse(endpoint({ id, providerId, totalParametersB: null, ...(paid ? { pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2, freeVerified: false } } : {}) })), available: true, deniedProfiles: [], status: "active", statusReason: null } as ModelEndpoint;
}
function plan(models: ModelEndpoint[], evidence: unknown[], options: { paid?: boolean; policy?: "never" | "preferred" | "on_free_exhaustion"; forced?: string; strict?: boolean; profile?: "supervise" | "implement" | "review" | "inspect" } = {}) {
  const cfg = baseConfig({ supervisor: { routing: { quality_evidence: evidence, ...(options.strict ? { minimum_quality: "frontier_or_qualified_supervisor" } : {}) } }, paid: { enabled: options.paid ?? false } });
  (cfg.profiles as Record<string, unknown>).supervise = { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100 };
  env = makeEnv({ config: cfg });
  return planRoute(env.cfg, models, [], { profile: options.profile ?? "supervise", tier: "T3", inputModalities: ["text"], needsStructuredOutput: false, paidPolicy: options.policy ?? "never", ...(options.forced ? { forcedEndpointId: options.forced } : {}) }, { now, qualification: () => null });
}
describe("actual supervisor route quality policy", () => {
  it("defaults to best_available and ranks strongest eligible unverified capacity", () => {
    expect(SupervisorQualityRoutingSchema.parse({}).minimum_quality).toBe("best_available");
    const result = plan([
      { ...model("smaller"), totalParametersB: 120 },
      { ...model("strongest"), totalParametersB: 400 },
      { ...model("below-floor"), totalParametersB: 50 },
      model("unknown"),
      { ...model("paid", "groq", true), totalParametersB: 999 },
    ], []);
    expect(result.candidates.map(e => e.id)).toEqual(["strongest", "smaller"]);
    expect(result.explanations[0]!.supervisorQuality).toMatchObject({ eligible: true, score: null, classification: null });
    expect(result.explanations[0]!.supervisorQuality!.reason).toContain("unverified");
    env!.cfg.tiers.T3.prefer = "smallest_sufficient";
    const reroute = planRoute(env!.cfg, result.candidates, [], { profile: "supervise", tier: "T3", inputModalities: ["text"], needsStructuredOutput: false }, { now, qualification: () => null });
    expect(reroute.candidates.map(e => e.id)).toEqual(["strongest", "smaller"]);
  });
  it("ranks proven ability ahead of unverified size without fabricating scores", () => {
    const result = plan([{ ...model("unverified"), totalParametersB: 999 }, model("proven")], [quality("proven")]);
    expect(result.candidates.map(e => e.id)).toEqual(["proven", "unverified"]);
    expect(result.explanations[1]!.supervisorQuality!.score).toBeNull();
  });
  it("dispatches default unverified capacity and rechecks changed floors", async () => {
    const route = plan([{ ...model("stronger"), totalParametersB: 400 }, { ...model("weaker"), totalParametersB: 120 }], []);
    const client = new ScriptedClient(() => reply("observed"));
    sy = open(env!, client, { worker: false });
    const request = { plan: route, executionId: sy.admission.createExecution("task", "supervise", []), purpose: "supervision", participants: [], preferEndpointId: "weaker", chat: { messages: [{ role: "user" as const, content: "supervise" }], max_tokens: 10 } };
    expect((await sy.gate.request(request)).endpoint.id).toBe("stronger");
    sy.cfg.profiles.supervise!.min_total_parameters_b = 500;
    await expect(sy.gate.request(request)).rejects.toMatchObject({ code: "supervisor_quality_unavailable" });
    expect(client.requests).toHaveLength(1);
  });
  it("reorders expired proven candidates behind remaining proof under best_available", async () => {
    const route = plan([{ ...model("formerly-proven"), totalParametersB: 400 }, model("still-proven")], [quality("formerly-proven"), quality("still-proven", 0.8)]);
    const client = new ScriptedClient(() => reply("observed"));
    sy = open(env!, client, { worker: false });
    sy.cfg.supervisor.routing.quality_evidence[0]!.expiresAt = new Date(now.getTime() - 1).toISOString();
    const request = { plan: route, executionId: sy.admission.createExecution("task", "supervise", []), purpose: "supervision", participants: [], chat: { messages: [{ role: "user" as const, content: "supervise" }], max_tokens: 10 } };
    expect((await sy.gate.request(request)).endpoint.id).toBe("still-proven");
    expect(client.requests).toHaveLength(1);
  });
  it("keeps ordinary tool, modality, and independent-endpoint exclusions for default supervisors", () => {
    const result = plan([{ ...model("no-tools"), totalParametersB: 400, supportsTools: false }, { ...model("no-text"), totalParametersB: 500, inputModalities: ["image"] }, { ...model("usable"), totalParametersB: 120 }], []);
    expect(result.candidates.map(e => e.id)).toEqual(["usable"]);
    const avoided = planRoute(env!.cfg, result.candidates, [], { profile: "supervise", tier: "T3", inputModalities: ["text"], needsStructuredOutput: false, avoidEndpoints: ["usable"] }, { now, qualification: () => null });
    expect(avoided.candidates).toHaveLength(0);
  });
  it("ranks verified supervisor ability across providers with unknown parameter sizes", () => {
    const result = plan([model("weaker"), model("stronger", "groq")], [quality("weaker", 0.8), quality("stronger")]);
    expect(result.candidates.map(e => e.id)).toEqual(["stronger", "weaker"]);
  });
  it("blocks missing quality provenance even for a forced endpoint", () => {
    expect(plan([model("forced")], [], { forced: "forced", strict: true })).toMatchObject({ candidates: [], blocker: { code: "supervisor_quality_unavailable" } });
  });
  it("never interprets a frontier vendor name or enormous parameter count as quality", () => {
    expect(plan([{ ...model("claude-gpt"), totalParametersB: 9999 }], [], { strict: true }).candidates).toHaveLength(0);
  });
  it("preserves disabled-paid policy even when paid quality is highest", () => {
    expect(plan([model("free"), model("paid", "groq", true)], [quality("free", 0.8), quality("paid")]).candidates.map(e => e.id)).toEqual(["free"]);
  });
  it("ranks quality before price preference when paid preference is authorized", () => {
    expect(plan([model("free"), model("paid", "groq", true)], [quality("free"), quality("paid", 0.8)], { paid: true, policy: "preferred" }).candidates.map(e => e.id)).toEqual(["free", "paid"]);
  });
  it("preserves explicit free-exhaustion semantics", () => {
    expect(plan([model("free"), model("paid", "groq", true)], [quality("free", 0.8), quality("paid")], { paid: true, policy: "on_free_exhaustion" }).candidates.map(e => e.id)).toEqual(["free", "paid"]);
  });
  it("does not impose supervisor quality on workers", () => {
    expect(plan([model("worker")], [], { profile: "inspect" }).candidates).toHaveLength(1);
  });
  it("physical dispatch ignores weaker sticky preference and blocks expired session evidence", async () => {
    const route = plan([model("stronger"), model("weaker")], [quality("stronger"), quality("weaker", 0.8)], { strict: true });
    const client = new ScriptedClient(() => reply("observed"));
    sy = open(env!, client, { worker: false });
    const request = { plan: route, executionId: sy.admission.createExecution("task", "supervise", []), purpose: "supervision", participants: [], preferEndpointId: "weaker", chat: { messages: [{ role: "user" as const, content: "supervise" }], max_tokens: 10 } };
    expect((await sy.gate.request(request)).endpoint.id).toBe("stronger");
    expect(client.requests).toHaveLength(1);
    for (const e of sy.cfg.supervisor.routing.quality_evidence) e.expiresAt = new Date(now.getTime() - 1).toISOString();
    await expect(sy.gate.request(request)).rejects.toMatchObject({ code: "supervisor_quality_unavailable" });
    expect(client.requests).toHaveLength(1);
  });
  it.each(["expired", "future", "low-confidence", "weak-capability", "missing-visual"])("rejects %s provenance", mode => {
    const q = quality("ep");
    if (mode === "expired") { q.checkedAt = new Date(now.getTime() - 10_000).toISOString(); q.expiresAt = new Date(now.getTime() - 1000).toISOString(); }
    if (mode === "future") { q.checkedAt = new Date(now.getTime() + 1000).toISOString(); }
    if (mode === "low-confidence") q.confidence = 0.5;
    if (mode === "weak-capability") q.scores.integration = 0.1;
    const parsed = SupervisorQualityRoutingSchema.parse({ minimum_quality: "frontier_or_qualified_supervisor", quality_evidence: [q] });
    if (mode === "missing-visual") delete parsed.quality_evidence[0]!.scores.visual;
    expect(assessSupervisorQuality("ep", parsed, now, mode === "missing-visual").eligible).toBe(false);
  });
});
