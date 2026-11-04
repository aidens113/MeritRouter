import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MeritRouter } from "../src/core/service.js";
import type { Db } from "../src/storage/db.js";
import type { ProjectRuntimeBundle } from "../src/projects/runtime-registry.js";
import { QUALIFICATION_PROJECT } from "../src/qualification/registry.js";
import { qualificationStat, qualificationLookupFrom } from "../src/qualification/stats.js";
import { TaskRouter } from "../src/routing/router.js";
import { modelsView, routingPreview } from "../src/admin/insights.js";
import { baseConfig, endpoint, makeEnv, open, reply, ScriptedClient, type Env } from "./helpers.js";

const good = "openrouter/vendor/big-a:free", other = "openrouter/vendor/other:free";
let env: Env | undefined, sy: MeritRouter | undefined, projectDir: string | undefined;
afterEach(async () => { await sy?.close(); sy = undefined; env?.cleanup(); env = undefined;
  if (projectDir) rmSync(projectDir, { recursive: true, force: true }); projectDir = undefined; });

function fixture(split = true) {
  const base = baseConfig();
  projectDir = mkdtempSync(path.join(tmpdir(), "meritrouter-qroute-project-"));
  env = makeEnv({ endpoints: [endpoint(), endpoint({ gatewayModelId: "vendor/other:free" })], config: {
    ...base, storage: { directory: ".meritrouter", layout: split ? "split" : "legacy" },
    ...(split ? { repositories: {}, brain: { ...(base.brain as Record<string, unknown>), project: "alpha" },
      projects: { alpha: { directory: projectDir, repositories: { app: { path: "." } } } } } : {}),
    qualification: { required: true, min_trials: 2, pass_threshold: 0.75 },
  } });
  const client = new ScriptedClient(() => reply("must not be called"));
  sy = open(env, client, { worker: false });
  return client;
}

let serial = 0;
function seed(db: Db, id: string, family: string, outcomes: Array<"pass" | "fail" | "infra_error">) {
  const run = `q_fixture_${++serial}`;
  db.prepare("INSERT INTO qualification_runs(id,endpoint_id,suite_version,status,started_at) VALUES(?,?,?,'finished',?)").run(run, id, "fixture", Date.now());
  outcomes.forEach((outcome, index) => db.prepare("INSERT INTO qualification_results(run_id,endpoint_id,eval_id,family,tier,trial,outcome,created_at) VALUES(?,?,?,?,'T3',?,?,?)")
    .run(run, id, "fixture", family, index + 1, outcome, Date.now()));
}

describe("qualification statistics routing store", () => {
  it("direct legacy router reads local evidence even though its actual Gate has a coordinationDb", () => {
    const client = fixture(false);
    seed(sy!.db, good, "coding", ["pass", "pass"]);
    expect(sy!.gate.coordinationDb).toBe(sy!.db);
    expect(sy!.gate.projectIdentity).toBeNull();
    const direct = new TaskRouter(sy!.cfg, sy!.db, sy!.catalog, sy!.gate, sy!.artifacts);
    expect(direct.plan("implement", "T3", ["text"]).candidates.map(ep => ep.id)).toEqual([good]);
    expect(client.requests).toHaveLength(0);
  });

  it("direct split router refuses a missing capability instead of reading conflicting coordination evidence", async () => {
    const client = fixture();
    await sy!.createSplitProject({ slug: "alpha", directory: projectDir! });
    const alpha = sy!.projectStores("alpha") as ProjectRuntimeBundle;
    seed(sy!.db, good, "coding", ["pass", "pass"]);
    expect(alpha.gate.projectIdentity?.slug).toBe("alpha");
    expect(alpha.gate.coordinationDb).toBe(sy!.db);
    const direct = new TaskRouter(alpha.cfg, alpha.db, sy!.catalog, alpha.gate, alpha.artifacts);
    expect(() => direct.plan("implement", "T3", ["text"])).toThrow(/explicit qualification statistics capability/);
    expect(existsSync(path.join(env!.cfg.storageDir, "qualification"))).toBe(false);
    expect(client.requests).toHaveLength(0);
  });

  it("absent split qualification stays absent during global routing, previews and model inspection", () => {
    const client = fixture();
    const root = path.join(env!.cfg.storageDir, "qualification");
    const before = sy!.db.prepare("SELECT COUNT(*) n FROM project_store_registrations").get();
    expect(sy!.router.plan("implement", "T3", ["text"]).candidates).toHaveLength(0);
    expect(routingPreview(sy!, "implement", "T3").explanations.every(e => e.qualification === null)).toBe(true);
    expect(modelsView(sy!).every(model => model.qualification.every(cell => cell.stat === null))).toBe(true);
    expect(sy!.db.prepare("SELECT COUNT(*) n FROM project_store_registrations").get()).toEqual(before);
    expect(existsSync(root)).toBe(false);
    expect(client.requests).toHaveLength(0);
  });

  it("fresh service uses persisted registered evidence before any board visit, consistently across global/project/preview/model reads", async () => {
    const client = fixture();
    await sy!.createSplitProject({ slug: "alpha", directory: projectDir! });
    const q = sy!.projectStores(QUALIFICATION_PROJECT);
    seed(q.db, good, "coding", ["pass", "pass", "infra_error"]);
    seed(q.db, other, "coding", ["fail", "fail"]);
    // A conflicting coordination row is intentionally wrong-store fixture evidence, not copied production state.
    seed(sy!.db, other, "coding", ["pass", "pass"]);
    await sy!.close();
    sy = open(env!, client, { worker: false });
    // First qualification read after reopen is actual routing, not the board or projectStores(_qualification).
    const global = sy.router.plan("implement", "T3", ["text"]);
    expect(global.candidates.map(ep => ep.id)).toEqual([good]);
    expect(global.explanations.find(ep => ep.endpointId === good)?.qualification).toMatchObject({ trials: 2, passRate: 1, qualified: true });
    expect(global.explanations.find(ep => ep.endpointId === other)?.qualification).toMatchObject({ trials: 2, passRate: 0, qualified: false });
    const alpha = sy.projectStores("alpha") as ProjectRuntimeBundle;
    expect(alpha.router.plan("implement", "T3", ["text"]).candidates.map(ep => ep.id)).toEqual([good]);
    const preview = routingPreview(sy, "implement", "T3");
    expect(preview.explanations.find(ep => ep.endpointId === good)?.qualification).toEqual(global.explanations.find(ep => ep.endpointId === good)?.qualification);
    const model = modelsView(sy).find(model => model.endpoint.id === good)!;
    expect(model.qualification.find(cell => cell.family === "coding" && cell.tier === "T3")?.stat).toMatchObject({ trials: 2, passRate: 1, qualified: true });
    expect(alpha.db.prepare("SELECT COUNT(*) n FROM qualification_results").get()).toEqual({ n: 0 });
    expect(sy.db.prepare("SELECT COUNT(*) n FROM qualification_results").get()).toEqual({ n: 2 });
    expect(client.requests).toHaveLength(0);
  });

  it("keeps reviewer family, threshold and independent-endpoint eligibility separate from coding evidence", async () => {
    const client = fixture();
    await sy!.createSplitProject({ slug: "alpha", directory: projectDir! });
    const q = sy!.projectStores(QUALIFICATION_PROJECT);
    seed(q.db, good, "coding", ["pass", "pass"]);
    seed(q.db, good, "review", ["fail", "fail"]);
    seed(q.db, other, "review", ["pass", "pass"]);
    const router = (sy!.projectStores("alpha") as ProjectRuntimeBundle).router;
    const request = { profile: "review" as const, tier: "T3" as const, inputModalities: ["text" as const], avoidEndpoints: [], avoidFamilies: [], avoidProviders: [], minTotalParametersB: null,
      reviewer: { family: "review", tier: "T3" as const, threshold: 0.75, mode: "required" as const, name: "review" } };
    const required = router.planReviewer(request);
    expect(required.candidates.map(ep => ep.id)).toEqual([other]);
    expect(required.explanations.find(ep => ep.endpointId === good)?.qualification).toMatchObject({ passRate: 0, qualified: false });
    expect(router.planReviewer({ ...request, avoidEndpoints: [other] }).candidates).toHaveLength(0);
    const preferred = router.planReviewer({ ...request, reviewer: { ...request.reviewer, mode: "preferred" } });
    expect(preferred.candidates.map(ep => ep.id)).toEqual([other, good]);
    expect(client.requests).toHaveLength(0);
  });

  it.each(["retired", "migrating", "generation"])("refuses unavailable or changed qualification registration (%s)", change => {
    fixture();
    const q = sy!.projectStores(QUALIFICATION_PROJECT);
    seed(q.db, good, "coding", ["pass", "pass"]);
    expect(sy!.router.plan("implement", "T3", ["text"]).candidates).toHaveLength(1);
    const original = sy!.db.prepare("SELECT generation FROM project_store_registrations WHERE slug=?").get(QUALIFICATION_PROJECT) as { generation: number };
    try {
      if (change === "generation") sy!.db.prepare("UPDATE project_store_registrations SET generation=generation+1 WHERE slug=?").run(QUALIFICATION_PROJECT);
      else sy!.db.prepare("UPDATE project_store_registrations SET state=?,retired_at=? WHERE slug=?").run(change, change === "retired" ? Date.now() : null, QUALIFICATION_PROJECT);
      expect(() => sy!.router.plan("implement", "T3", ["text"])).toThrow(/registration|generation/);
    } finally {
      // Restore this intentional fixture fault so real owned runtime drain can verify its original generation.
      sy!.db.prepare("UPDATE project_store_registrations SET state='registered',retired_at=NULL,generation=? WHERE slug=?").run(original.generation, QUALIFICATION_PROJECT);
    }
  });

  it("legacy qualification stays in the existing single store and aggregate queries validate inputs", async () => {
    const client = fixture(false);
    seed(sy!.db, good, "coding", ["pass", "pass", "infra_error"]);
    expect(sy!.router.plan("implement", "T3", ["text"]).candidates.map(ep => ep.id)).toEqual([good]);
    expect(qualificationLookupFrom(sy!.qualificationStat, sy!.cfg)(good, "implement", "T3")).toEqual(qualificationStat(sy!.db, sy!.cfg, good, "coding", "T3"));
    expect(() => sy!.qualificationStat(sy!.cfg, good, "coding", "T3", 2)).toThrow();
    const read = sy!.router.qualification();
    await sy!.close();
    expect(() => read(good, "implement", "T3")).toThrow(/closing/);
    expect(client.requests).toHaveLength(0);
  });
});
