import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MeritRouter } from "../src/core/service.js";
import type { Db } from "../src/storage/db.js";
import { modelsView, routingPreview } from "../src/admin/insights.js";
import { TIER_NAMES, type ProfileName } from "../src/config/schema.js";
import { qualificationStat, type QualificationStatReader } from "../src/qualification/stats.js";
import { QUALIFICATION_PROJECT } from "../src/qualification/registry.js";
import { baseConfig, endpoint, makeEnv, open, reply, ScriptedClient, type Env } from "./helpers.js";

let sy: MeritRouter | undefined, env: Env | undefined;
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await sy?.close(); sy = undefined;
  env?.cleanup(); env = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function fixture(count = 128) {
  const directory = () => { const dir = mkdtempSync(path.join(tmpdir(), "meritrouter-model-view-")); dirs.push(dir); return dir; };
  const alpha = directory(), beta = directory();
  const base = baseConfig();
  env = makeEnv({ config: { ...base, storage: { directory: ".meritrouter", layout: "split" }, repositories: {},
    brain: { ...(base.brain as object), project: "alpha" },
    qualification: { required: true, min_trials: 2, pass_threshold: 0.75 },
    projects: { alpha: { directory: alpha, repositories: { app: { path: "." } } }, beta: { directory: beta, repositories: { app: { path: "." } } } },
  }, endpoints: Array.from({ length: count }, (_, i) => endpoint({ gatewayModelId: `vendor/model-${i}:free`, totalParametersB: i % 3 ? 550 : 10 })) });
  const client = new ScriptedClient(() => reply("must not dispatch"));
  sy = open(env, client, { worker: false, panelLifecycle: "passive" });
  await sy.createSplitProject({ slug: "alpha", directory: alpha });
  await sy.createSplitProject({ slug: "beta", directory: beta });
  const q = sy.projectStores(QUALIFICATION_PROJECT);
  const id = sy.catalog.endpoints()[1]!.id;
  q.db.prepare("INSERT INTO qualification_runs(id,endpoint_id,suite_version,status,started_at) VALUES('fixture',?,'fixture','finished',1)").run(id);
  for (let i = 0; i < 2; i++) q.db.prepare("INSERT INTO qualification_results(run_id,endpoint_id,eval_id,family,tier,trial,outcome,created_at) VALUES('fixture',?,'fixture','coding','T3',?,'pass',1)").run(id, i);
  return { client, id, q, alpha: sy.projectStores("alpha"), beta: sy.projectStores("beta") };
}

function request(db: Db, project: string, id: string, endpointId: string, served: string, age: number, duration: number | null, status = "succeeded", violation: string | null = null) {
  db.prepare("INSERT INTO executions(id,kind,profile,status,created_at) VALUES(?,'task','summarize','completed',1)").run(id);
  const at = Date.now() - age;
  db.prepare(`INSERT INTO model_requests(id,execution_id,purpose,gateway_model,status,reserved_at,finished_at,
    est_input_tokens,reserved_output_tokens,endpoint_id,served_endpoint_id,input_tokens,output_tokens,project_id,policy_violation)
    VALUES(?,?,'execution','fixture',?,?,?,10,10,?,?,5,7,?,?)`).run(id, id, status, at, duration === null ? null : at + duration, endpointId, served, project, violation);
}

function task(db: Db, project: string, id: string, state: string, finishedAt: number, requests: string[]) {
  db.prepare(`INSERT INTO tasks(id,spec_hash,profile,spec_json,state,created_at,updated_at,finished_at,project_id)
    VALUES(?,'fixture','summarize','{}',?,1,1,?,?)`).run(id, state, finishedAt, project);
  for (const req of requests) db.prepare("INSERT INTO request_charges(request_id,task_id,input_tokens,output_tokens) VALUES(?,?,1,1)").run(req, id);
}

function countAggregates(db: Db) {
  const original = db.prepare.bind(db);
  return vi.spyOn(db, "prepare").mockImplementation(sql => original(sql));
}

describe("Models request-local reads", () => {
  it("groups true split stats once per scope while preserving requested/served endpoints and every routing cell", async () => {
    const f = await fixture(), router = sy!;
    const other = router.catalog.endpoints()[2]!.id, now = Date.now(), old = 8 * 86400000;
    request(f.alpha.db, "alpha", "a", f.id, other, 10000, 5);
    request(f.alpha.db, "alpha", "b", f.id, other, 10000, 15, "failed", "fixture violation");
    request(f.beta.db, "beta", "c", f.id, f.id, 10000, 30, "uncertain");
    request(router.db, "", "unattributed", f.id, f.id, 10000, null, "reserved");
    request(router.db, "alpha", "decoy", f.id, f.id, 10000, 900);
    request(f.alpha.db, "alpha", "old-request", f.id, other, old, 1);
    task(f.alpha.db, "alpha", "once", "completed", now - 1000, ["a", "b"]);
    task(f.alpha.db, "alpha", "new-task-old-request", "budget_exhausted", now - 1000, ["old-request"]);
    task(f.alpha.db, "alpha", "old-task", "failed", now - old, ["b"]);
    task(f.beta.db, "beta", "beta-task", "failed", now - 1000, ["c"]);
    const baselineStarted = performance.now();
    const expected = new Map<string, unknown[]>();
    for (const profile of Object.keys(router.cfg.profiles) as ProfileName[]) for (const tier of TIER_NAMES) {
      for (const ex of routingPreview(router, profile, tier).explanations) {
        const cells = expected.get(ex.endpointId) ?? [];
        cells.push({ profile, tier, eligible: ex.eligible, rank: ex.rank, reasons: ex.reasons }); expected.set(ex.endpointId, cells);
      }
    }
    const baselineMatrixMs = performance.now() - baselineStarted;
    const scopes = vi.spyOn(router, "projectStores");
    const qualify = vi.spyOn(router, "qualificationStat"), quarantine = vi.spyOn(router.gate, "quarantined"), refused = vi.spyOn(router.gate, "planRefused"), health = vi.spyOn(router.health, "lookup");
    const queries = [router.db, f.alpha.db, f.beta.db, f.q.db].map(countAggregates);
    const viewStarted = performance.now();
    const views = modelsView(router), model = views.find(v => v.endpoint.id === f.id)!;
    console.info(JSON.stringify({ models: views.length, uncachedRoutingMatrixMs: Math.round(baselineMatrixMs), optimizedFullModelsViewMs: Math.round(performance.now() - viewStarted) }));
    expect(model.stats7d).toEqual({ requests: 4, succeeded: 1, failed: 1, uncertain: 1, policyViolations: 1,
      inputTokens: 20, outputTokens: 28, avgLatencyMs: 17, lastUsedAt: expect.any(Number), tasksCompleted: 0, tasksFailed: 1 });
    expect(views.find(v => v.endpoint.id === other)!.stats7d).toMatchObject({ requests: 0, tasksCompleted: 1, tasksFailed: 1 });
    for (const v of views) expect(v.eligibility).toEqual(expected.get(v.endpoint.id));
    expect(scopes.mock.calls.map(c => c[0])).toEqual(["alpha", "beta", QUALIFICATION_PROJECT]);
    expect(qualify).not.toHaveBeenCalled();
    expect(queries[3]!.mock.calls.filter(([sql]) => sql.includes("GROUP BY endpoint_id, family, tier"))).toHaveLength(1);
    expect(quarantine).toHaveBeenCalledTimes(views.length); expect(refused).toHaveBeenCalledTimes(views.length);
    expect(health).toHaveBeenCalledTimes(new Set(views.map(v => v.endpoint.providerId)).size);
    for (const spy of queries) expect(spy.mock.calls.filter(([sql]) => sql.trim().endsWith("GROUP BY endpoint_id") || sql.trim().endsWith("GROUP BY served.endpoint_id"))).toHaveLength(2);
    expect(f.client.requests).toHaveLength(0);
  }, 30000);

  it("rechecks changed evidence, gate state and runtime identity on the next view", async () => {
    const f = await fixture(4), router = sy!;
    expect(modelsView(router).find(v => v.endpoint.id === f.id)!.eligibility.find(c => c.profile === "implement" && c.tier === "T3")!.eligible).toBe(true);
    f.q.db.prepare("UPDATE qualification_results SET outcome='fail'").run();
    const quarantine = vi.spyOn(router.gate, "quarantined").mockImplementation(ep => ep.id === f.id ? "new quarantine" : null);
    const next = modelsView(router).find(v => v.endpoint.id === f.id)!;
    expect(next.quarantined).toBe("new quarantine");
    expect(next.qualification.find(c => c.family === "coding" && c.tier === "T3")!.stat).toMatchObject({ passRate: 0, qualified: false });
    expect(next.eligibility.find(c => c.profile === "implement" && c.tier === "T3")!.eligible).toBe(false);
    quarantine.mockRestore();
    router.db.prepare("UPDATE project_store_registrations SET state='retired',retired_at=1 WHERE slug=?").run(QUALIFICATION_PROJECT);
    try { expect(() => modelsView(router)).toThrow(/unavailable or ambiguous/); }
    finally { router.db.prepare("UPDATE project_store_registrations SET state='registered',retired_at=NULL WHERE slug=?").run(QUALIFICATION_PROJECT); }
    expect(f.client.requests).toHaveLength(0);
  }, 30000);
  it("matches cumulative statistics and revokes snapshots on return, error, async callback and changed identity", async () => {
    const f = await fixture(4), router = sy!;
    for (const [tier, outcome, trial] of [["T1", "fail", 3], ["T2", "pass", 4], ["T3", "infra_error", 5]] as const)
      f.q.db.prepare("INSERT INTO qualification_results(run_id,endpoint_id,eval_id,family,tier,trial,outcome,created_at) VALUES('fixture',?,'fixture','coding',?,?,?,1)").run(f.id, tier, trial, outcome);
    let leaked: QualificationStatReader | undefined;
    router.withQualificationStats(reader => {
      leaked = reader;
      for (const tier of TIER_NAMES) for (const threshold of [0, 0.75, 1])
        expect(reader(router.cfg, f.id, "coding", tier, threshold)).toEqual(qualificationStat(f.q.db, router.cfg, f.id, "coding", tier, threshold));
      expect(reader(router.cfg, "missing", "coding", "T3")).toBeNull();
    });
    expect(() => leaked!(router.cfg, f.id, "coding", "T3")).toThrow(/no longer active/);
    expect(() => router.withQualificationStats(reader => { leaked = reader; throw new Error("callback failure"); })).toThrow("callback failure");
    expect(() => leaked!(router.cfg, f.id, "coding", "T3")).toThrow(/no longer active/);
    expect(() => router.withQualificationStats(reader => { leaked = reader; return Promise.resolve(null); })).toThrow(/must be synchronous/);
    expect(() => leaked!(router.cfg, f.id, "coding", "T3")).toThrow(/no longer active/);
    const original = router.db.prepare("SELECT generation FROM project_store_registrations WHERE slug=?").get(QUALIFICATION_PROJECT) as { generation: number };
    try {
      expect(() => router.withQualificationStats(reader => {
        leaked = reader;
        router.db.prepare("UPDATE project_store_registrations SET generation=generation+1 WHERE slug=?").run(QUALIFICATION_PROJECT);
        return reader(router.cfg, f.id, "coding", "T3");
      })).toThrow(/generation changed/);
      expect(() => leaked!(router.cfg, f.id, "coding", "T3")).toThrow(/no longer active/);
    } finally { router.db.prepare("UPDATE project_store_registrations SET generation=? WHERE slug=?").run(original.generation, QUALIFICATION_PROJECT); }
    expect(f.client.requests).toHaveLength(0);
  }, 30000);

  it.each([false, true])("refuses lifecycle changes before a snapshot result escapes (split=%s)", async split => {
    let client: ScriptedClient;
    if (split) ({ client } = await fixture(4));
    else {
      env = makeEnv({ config: baseConfig() });
      client = new ScriptedClient(() => reply("must not dispatch"));
      sy = open(env, client, { worker: false, panelLifecycle: "passive" });
    }
    const router = sy!;
    let closing: Promise<void> | undefined, leaked: QualificationStatReader | undefined;
    expect(() => router.withQualificationStats(reader => {
      leaked = reader;
      closing = router.close();
      return reader(router.cfg, "missing", "coding", "T3");
    })).toThrow(/service closed during qualification inspection/);
    expect(() => leaked!(router.cfg, "missing", "coding", "T3")).toThrow(/no longer active/);
    await closing;
    expect(client.requests).toHaveLength(0);
  }, 30000);

});
