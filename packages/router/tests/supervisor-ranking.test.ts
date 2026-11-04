import { afterEach, describe, expect, it, vi } from "vitest";
import { SupervisorQualityRoutingSchema, assessSupervisorQuality } from "../src/routing/supervisor-quality.js";
import { planRoute } from "../src/routing/select.js";
import { ModelEndpointSchema, type ModelEndpoint } from "../src/models/catalog.js";
import type { MeritRouter } from "../src/core/service.js";
import { baseConfig, endpoint, makeEnv, open, reply, ScriptedClient, type Env } from "./helpers.js";

let env: Env | undefined, sy: MeritRouter | undefined;
const environments: Env[] = [];
afterEach(async () => { vi.restoreAllMocks(); await sy?.close(); sy = undefined; for (const fixture of environments.splice(0)) fixture.cleanup(); env = undefined; });
const now = new Date();
const policy = { source: "synthetic test benchmark", suite_version: "fixture-v1", metric_scale: "fixture-native", rank_metric: "agentic", capability_floors: { agentic: 60, coding: 50 } };
function evidence(id: string, agentic = 80, extra: Record<string, unknown> = {}) {
  return { endpoint_id: id, provider: "openrouter", model: "vendor/big-a:free", source_model_id: `fixture-${id}`, mapping_source: "Explicit synthetic fixture identity mapping", source: policy.source, source_url: "https://example.invalid/fixture-benchmark", suite_version: policy.suite_version, metric_scale: policy.metric_scale, checked_at: new Date(now.getTime() - 1000).toISOString(), expires_at: new Date(now.getTime() + 3600_000).toISOString(), metrics: { agentic, coding: 70 }, ...extra };
}
function model(id: string, parameters = 120, extra: Record<string, unknown> = {}): ModelEndpoint {
  return { ...ModelEndpointSchema.parse(endpoint({ id, totalParametersB: parameters, ...extra })), available: true, deniedProfiles: [], status: "active", statusReason: null } as ModelEndpoint;
}
function routing(records: unknown[]) { return { minimum_quality: "ranked_capable", ranking_policy: policy, ranking_evidence: records }; }
function plan(models: ModelEndpoint[], records: unknown[], opts: { paid?: boolean; profile?: "supervise" | "inspect"; mode?: "supervisor" | "read_only"; paidPolicy?: "never" | "preferred" | "on_free_exhaustion"; forced?: string } = {}) {
  const cfg = baseConfig({ supervisor: { routing: routing(records) }, paid: { enabled: opts.paid ?? false } });
  (cfg.profiles as Record<string, unknown>).supervise = { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100 };
  if (opts.profile === "inspect") (cfg.profiles as Record<string, unknown>).inspect = opts.mode === "read_only"
    ? { mode: "read_only", tools: "repository_read", min_total_parameters_b: 30 }
    : { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100 };
  env = makeEnv({ config: cfg });
  environments.push(env);
  return planRoute(env.cfg, models, [], { profile: opts.profile ?? "supervise", tier: "T3", inputModalities: ["text"], needsStructuredOutput: false, paidPolicy: opts.paidPolicy ?? "never", ...(opts.forced ? { forcedEndpointId: opts.forced } : {}) }, { now, qualification: () => null });
}

describe("provenance-bound supervisor ranking", () => {
  it("defaults to ranked_capable and fails closed without configured comparable evidence", () => {
    const parsed = SupervisorQualityRoutingSchema.parse({});
    expect(parsed.minimum_quality).toBe("ranked_capable");
    expect(assessSupervisorQuality("huge-unverified", parsed, now)).toMatchObject({ eligible: false, score: null });
  });
  it("ranks stronger measured smaller models above larger capacity without inventing six-dimensional scores", () => {
    const result = plan([model("small", 40), model("large", 900), model("unverified", 9999)], [evidence("small", 90), evidence("large", 70)]);
    expect(result.candidates.map(e => e.id)).toEqual(["small", "large"]);
    expect(result.explanations[0]!.supervisorQuality).toMatchObject({ score: 90, classification: "benchmark_qualified_supervisor" });
    result.candidates[1]!.totalParametersB = 100000;
    const reroute = planRoute(env!.cfg, result.candidates, [], { profile: "supervise", tier: "T3", inputModalities: ["text"], needsStructuredOutput: false }, { now, qualification: () => null });
    expect(reroute.candidates.map(e => e.id)).toEqual(["small", "large"]);
  });
  it("does not treat size as superior supervisor quality when measured scores tie", () => {
    const result = plan([model("z-large", 900), model("a-small", 40)], [evidence("z-large", 90), evidence("a-small", 90)]);
    expect(result.candidates.map(e => e.id)).toEqual(["a-small", "z-large"]);
    expect(result.explanations[0]!.supervisorQuality!.reason).toContain("not proven quality superiority");
  });
  it.each([
    ["weak", { metrics: { agentic: 59, coding: 99 } }],
    ["missing metric", { metrics: { agentic: 99 } }],
    ["foreign provider", { provider: "groq" }],
    ["remapped route", { model: "other-version" }],
    ["foreign source", { source: "other benchmark" }],
    ["foreign suite", { suite_version: "fixture-v2" }],
    ["foreign metric scale", { metric_scale: "incomparable" }],
    ["future", { checked_at: new Date(now.getTime() + 1000).toISOString() }],
    ["expired", { checked_at: new Date(now.getTime() - 10000).toISOString(), expires_at: new Date(now.getTime() - 1000).toISOString() }],
    ["unmapped", { endpoint_id: "another-endpoint" }],
  ])("rejects %s evidence even when endpoint is forced", (_name, patch) => {
    expect(plan([model("candidate", 9999)], [evidence("candidate", 90, patch)], { forced: "candidate" }).candidates).toEqual([]);
  });
  it("requires explicit floors for the ranking metric and valid provenance", () => {
    expect(() => SupervisorQualityRoutingSchema.parse({ ...routing([]), ranking_policy: { ...policy, capability_floors: { coding: 50 } } })).toThrow();
    expect(() => SupervisorQualityRoutingSchema.parse(routing([evidence("candidate", 90, { mapping_source: "" })]))).toThrow();
    expect(() => SupervisorQualityRoutingSchema.parse(routing([evidence("candidate", NaN)]))).toThrow();
  });
  it("does not use legacy qualified-small evidence as ranked fallback", () => {
    const parsed = SupervisorQualityRoutingSchema.parse({ ...routing([]), quality_evidence: [{ schemaVersion: 1, endpointId: "small", source: "synthetic legacy fixture", checkedAt: evidence("small").checked_at, expiresAt: evidence("small").expires_at, classification: "qualified_supervisor", confidence: 1, trials: 20, scores: { planning: 1, architecture: 1, supervision: 1, integration: 1, review: 1, product: 1 } }] });
    expect(assessSupervisorQuality("small", parsed, now, false, model("small").route)).toMatchObject({ eligible: false, score: null });
  });
  it("refreshes observed rankings without resurrecting superseded strong or expired scores", () => {
    const old = evidence("candidate", 99, { checked_at: new Date(now.getTime() - 20000).toISOString() });
    const newerWeak = evidence("candidate", 30);
    expect(plan([model("candidate")], [old, newerWeak]).candidates).toEqual([]);
    const expiredNewer = evidence("candidate", 90, { checked_at: new Date(now.getTime() - 10000).toISOString(), expires_at: new Date(now.getTime() - 1000).toISOString() });
    expect(plan([model("candidate")], [old, expiredNewer]).candidates).toEqual([]);
    const ambiguous = evidence("candidate", 99);
    expect(plan([model("candidate")], [newerWeak, ambiguous]).candidates).toEqual([]);
    expect(plan([model("candidate")], [evidence("candidate", 80)]).explanations[0]!.supervisorQuality!.score).toBe(80);
  });
  it("does not invent visual qualification from a text-agentic benchmark", () => {
    const parsed = SupervisorQualityRoutingSchema.parse(routing([evidence("candidate")]));
    expect(assessSupervisorQuality("candidate", parsed, now, true, model("candidate").route)).toMatchObject({ eligible: false, score: null });
  });
  it("keeps capable free first, only capable authorized paid fallback, and zero weak fallback", () => {
    const free = model("good-free", 40), weak = model("weak-free", 9999), paid = model("paid", 40, { providerId: "groq", pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2, freeVerified: false } });
    const records = [evidence("good-free", 75), evidence("weak-free", 10), evidence("paid", 95, { provider: "groq" })];
    expect(plan([free, weak, paid], records, { paid: true, paidPolicy: "on_free_exhaustion" }).candidates.map(e => e.id)).toEqual(["good-free", "paid"]);
    free.available = false;
    expect(plan([free, weak, paid], records, { paid: true, paidPolicy: "on_free_exhaustion" }).candidates.map(e => e.id)).toEqual(["paid"]);
    expect(plan([free, weak, paid], records, { paid: false }).candidates).toEqual([]);
    expect(plan([free, weak, paid], records, { paid: true, paidPolicy: "never" }).candidates).toEqual([]);
  });
  it("gates nonstandard supervisor-mode profiles while leaving workers independent", () => {
    expect(plan([model("unverified")], [], { profile: "inspect" }).candidates).toEqual([]);
    expect(plan([model("worker")], [], { profile: "inspect", mode: "read_only" }).candidates.map(e => e.id)).toEqual(["worker"]);
  });
  it("keeps tool/access/status checks even with excellent ranking", () => {
    const models = [{ ...model("no-key"), available: false }, { ...model("disabled"), status: "disabled" as const }, model("no-tools", 200, { supportsTools: false })];
    expect(plan(models, models.map(m => evidence(m.id, 99))).candidates).toEqual([]);
  });
  it("rechecks expiry, revocation and current route identity at physical Gate dispatch despite sticky preference", async () => {
    const route = plan([model("stronger", 40), model("weaker", 500)], [evidence("stronger", 90), evidence("weaker", 70)]);
    const client = new ScriptedClient(() => reply("observed"));
    sy = open(env!, client, { worker: false });
    const request = { plan: route, executionId: sy.admission.createExecution("task", "supervise", []), purpose: "supervision", participants: [], preferEndpointId: "weaker", chat: { messages: [{ role: "user" as const, content: "supervise" }], max_tokens: 10 } };
    expect((await sy.gate.request(request)).endpoint.id).toBe("stronger");
    expect(client.requests).toHaveLength(1);
    sy.cfg.supervisor.routing.ranking_evidence[0]!.expires_at = new Date(now.getTime() - 1).toISOString();
    expect((await sy.gate.request(request)).endpoint.id).toBe("weaker");
    expect(client.requests).toHaveLength(2);
    route.candidates[1]!.route.model = "changed-since-planning";
    await expect(sy.gate.request(request)).rejects.toMatchObject({ code: "supervisor_quality_unavailable" });
    expect(client.requests).toHaveLength(2);
    route.candidates[1]!.route.model = "vendor/big-a:free";
    sy.cfg.supervisor.routing.ranking_evidence = [];
    await expect(sy.gate.request(request)).rejects.toMatchObject({ code: "supervisor_quality_unavailable" });
    expect(client.requests).toHaveLength(2);
  });
  it("unwinds definitely-unsent accounting when evidence is revoked during asynchronous dispatch preparation", async () => {
    const route = plan([model("candidate", 40)], [evidence("candidate", 90)]);
    const client = new ScriptedClient(() => reply("must not be called"));
    sy = open(env!, client, { worker: false });
    const begin = sy.gate.ledger.beginDispatch.bind(sy.gate.ledger);
    vi.spyOn(sy.gate.ledger, "beginDispatch").mockImplementationOnce(async (...args) => {
      const result = await begin(...args);
      sy!.cfg.supervisor.routing.ranking_evidence = [];
      return result;
    });
    const request = { plan: route, executionId: sy.admission.createExecution("task", "supervise", []), purpose: "supervision", participants: [], chat: { messages: [{ role: "user" as const, content: "supervise" }], max_tokens: 10 } };
    await expect(sy.gate.request(request)).rejects.toMatchObject({ reason: "no_eligible_endpoint" });
    expect(client.requests).toHaveLength(0);
    expect(sy.db.prepare("SELECT status FROM model_requests WHERE execution_id=?").all(request.executionId)).toEqual([{ status: "failed" }]);
    expect(sy.db.prepare("SELECT COUNT(*) n FROM provider_slots WHERE kind='request'").get()).toEqual({ n: 0 });
    expect(sy.db.prepare("SELECT COUNT(*) n FROM paid_spend").get()).toEqual({ n: 0 });
  });
});
