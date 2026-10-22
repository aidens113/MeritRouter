import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { Switchyard } from "../src/core/service.js";
import { labsListView, labPromotionView, labDetailView, labLogs, labRecipeView, saveLabRecipe, requestLabControl } from "../src/admin/labs.js";
import { archiveProject } from "../src/admin/projects.js";
import { ensureLabSupervisor } from "../src/operations/lab-supervisor.js";
import { baseConfig, makeEnv, open, ScriptedClient, reply, type Env } from "./helpers.js";
vi.mock("../src/operations/lab-supervisor.js", () => ({ ensureLabSupervisor: vi.fn(async () => ({ started: false })) }));
let env: Env | undefined; let sy: Switchyard | undefined;
afterEach(async () => { await sy?.close(); sy = undefined; env?.cleanup(); env = undefined; vi.clearAllMocks(); });
function setup() {
  env = makeEnv({ config: baseConfig({ repositories: {}, brain: { project: "alpha", path: ".brain" }, projects: {
    alpha: { repositories: { core: { path: "repo" } }, lab: { env: { TEST_SECRET: "private-fixture-value" }, services: { app: { repo: "core", command: "node server.cjs" } }, checks: { health: { repo: "core", command: `node -e "console.log(process.env.TEST_SECRET)"` } } } },
    beta: { repositories: { core: { path: "repo" } } },
  } }) });
  sy = open(env, new ScriptedClient(() => reply("{}")));
  return sy;
}

describe("project Labs admin facade", () => {
  it("queues explicit human control without executing it; reads never launch a supervisor", async () => {
    const s = setup();
    expect(labsListView(s, "alpha").labs).toHaveLength(0);
    expect(labRecipeView(s, "alpha").envKeys).toEqual(["TEST_SECRET"]);
    expect(ensureLabSupervisor).not.toHaveBeenCalled();
    const queued = await requestLabControl(s, "alpha", "feature", { action: "create", goal: "test" });
    expect(ensureLabSupervisor).toHaveBeenCalledTimes(1);
    expect(s.labs.list("alpha")).toHaveLength(0);
    expect(queued.operation).toMatchObject({ kind: "create", state: "pending", requestedBy: "human:panel" });
    expect(queued.operation).not.toHaveProperty("input"); expect(queued.operation).not.toHaveProperty("result");
    expect(labsListView(s, "alpha").labs[0]).toMatchObject({ name: "feature", status: null });
    expect(() => labDetailView(s, "beta", "feature")).toThrow(/unknown lab/);
    expect(labsListView(s, "beta").labs).toHaveLength(0);
  });
  it("operation history excludes unsafe stored results and raw errors", async () => {
    const s = setup(); const queued = await requestLabControl(s, "alpha", "feature", { action: "create" });
    s.db.prepare("UPDATE lab_operations SET state='failed',result_json=?,error_code='fixture_error',error_message=? WHERE id=?").run(JSON.stringify({ env: "private-fixture-value", command: "node server.cjs" }), "private-fixture-value node server.cjs", queued.operation.id);
    const failed = labDetailView(s, "alpha", "feature");
    expect(failed.operations[0]).toMatchObject({ errorCode: "fixture_error", errorMessage: "Lab operation failed; inspect local supervisor logs for details." });
    expect(JSON.stringify(failed)).not.toContain("private-fixture-value"); expect(JSON.stringify(failed)).not.toContain("node server.cjs");
    expect(failed.operations[0]).not.toHaveProperty("result"); expect(failed.operations[0]).not.toHaveProperty("input");
    s.db.prepare("UPDATE lab_operations SET state='completed',error_code=NULL WHERE id=?").run(queued.operation.id);
    expect(labDetailView(s, "alpha", "feature").operations[0]!.state).toBe("completed");
    s.db.prepare("UPDATE lab_operations SET kind='promote',input_json=?,result_json=? WHERE id=?").run(JSON.stringify({ kind: "promote", by: "human", reason: "reviewed" }), JSON.stringify({ state: "conflict", error: "private-fixture-value", commands: ["node server.cjs"] }), queued.operation.id);
    const promotion = labDetailView(s, "alpha", "feature").operations[0]!;
    expect(promotion).toMatchObject({ state: "completed", promotionState: "conflict", promotionReason: "reviewed", outcomeMessage: expect.stringContaining("did not complete") });
    expect(JSON.stringify(promotion)).not.toContain("private-fixture-value"); expect(JSON.stringify(promotion)).not.toContain("node server.cjs");
  });
  it("loads only chosen scoped promotion evidence and excludes arbitrary stored fields", async () => {
    const s = setup(); await s.labs.create("alpha", "feature", {});
    const op = s.labs.requestControl("alpha", "feature", { kind: "promote", by: "human", reason: "reviewed" }, "human:panel");
    const sha = "b".repeat(40);
    s.db.prepare("UPDATE lab_operations SET state='completed',result_json=? WHERE id=?").run(JSON.stringify({ id: "promotion", state: "prepared", policy: "manual", heads: { core: sha }, targets: { core: "main" }, checks: [], commands: ["git merge " + sha], conflicts: {}, error: "private-fixture-value", env: { SECRET: "private-fixture-value" }, unsafe: "node server.cjs" }), op.id);
    const view = labPromotionView(s, "alpha", "feature", op.id);
    expect(view).toMatchObject({ state: "prepared", heads: { core: sha }, manualCommands: ["git merge " + sha] });
    expect(JSON.stringify(view)).not.toContain("private-fixture-value"); expect(JSON.stringify(view)).not.toContain("node server.cjs");
    expect(view).not.toHaveProperty("env");
    expect(() => labPromotionView(s, "beta", "feature", op.id)).toThrow(/not found/);
    expect(() => labPromotionView(s, "alpha", "other", op.id)).toThrow(/not found/);
  });
  it("status/checks/logs omit raw env, recipe commands and service tokens", async () => {
    const s = setup(); await s.labs.create("alpha", "feature", {});
    const raw = s.labs.status("alpha", "feature");
    const token = "service-private-token-123456";
    s.labs.store.saveService({ lab_id: raw.lab.id, name: "app", state: "stopped", pid: null, token, log_path: path.join(raw.lab.root, "logs", "app.log"), restart_count: 0, next_restart: null, started_at: null, owner_id: null, owner_until: 0 });
    mkdirSync(path.join(raw.lab.root, "logs"), { recursive: true });
    writeFileSync(path.join(raw.lab.root, "logs", "app.log"), `private-fixture-value ${token} ${"a".repeat(48)} visible-line`);
    await s.labs.check("alpha", "feature", "health");
    const serialized = JSON.stringify(labDetailView(s, "alpha", "feature"));
    expect(serialized).not.toContain("private-fixture-value"); expect(serialized).not.toContain(token); expect(serialized).not.toContain("node server.cjs");
    expect(labLogs(s, "alpha", "feature", "app").log).toBe("[redacted] [redacted] [redacted] visible-line");
    expect(() => labLogs(s, "beta", "feature", "app")).toThrow();
    expect(() => labLogs(s, "alpha", "feature", "other")).toThrow(/unknown service/);
    expect(ensureLabSupervisor).not.toHaveBeenCalled();
  });
  it("returns pending metadata while creation has unresolved port placeholders", async () => {
    const s = setup(); await s.labs.create("alpha", "feature", {});
    const lab = s.labs.store.get("alpha", "feature")!;
    s.db.prepare("UPDATE labs SET state='creating',recipe_json=?,ports_json='{}' WHERE id=?").run(JSON.stringify({ ...lab.recipe, ports: ["web"], env: { PORT: "{port.web}" } }), lab.id);
    expect(labDetailView(s, "alpha", "feature")).toMatchObject({ status: null });
    expect(labsListView(s, "alpha").labs[0]).toMatchObject({ name: "feature", status: null });
  });
  it("human recipe edits preserve private env values and validate repository scope", async () => {
    const s = setup(); const before = labRecipeView(s, "alpha");
    expect(before.recipe).not.toHaveProperty("env");
    expect(JSON.stringify(before)).not.toContain("private-fixture-value");
    await expect(saveLabRecipe(s, "alpha", { recipe: { env: {} }, promotion: "manual", maxActive: null })).rejects.toThrow(/omit env/);
    await expect(saveLabRecipe(s, "alpha", { recipe: { services: { app: { repo: "foreign", command: "node ok" } } }, promotion: "manual", maxActive: null })).rejects.toThrow(/unknown repository/);
    await saveLabRecipe(s, "alpha", { recipe: before.recipe, promotion: "manual", maxActive: 2 });
    const config = YAML.parse(readFileSync(env!.cfg.configPath, "utf8"));
    expect(config.projects.alpha.lab.env.TEST_SECRET).toBe("private-fixture-value"); expect(config.projects.alpha.labs.max_active).toBe(2);
    expect(ensureLabSupervisor).not.toHaveBeenCalled();
  });
  it("an explicit human recipe save migrates a legacy project without changing global settings or identity", async () => {
    env = makeEnv({ config: baseConfig({ paid: { enabled: false, budgets: { per_week_usd: 7 } } }) });
    sy = open(env, new ScriptedClient(() => reply("{}")));
    const original = YAML.parse(readFileSync(env.cfg.configPath, "utf8"));
    const project = sy.projects.primary.project.slug;
    const repositories = { ...sy.projects.primary.repositoryPaths };
    const row = sy.projects.rows().find(p => p.id === project);
    expect(labRecipeView(sy, project)).toMatchObject({ legacy: true, readOnly: false, configured: false });
    const input = { recipe: { services: {}, checks: { smoke: { repo: "core", command: "node --version" } } }, promotion: "manual", maxActive: 2 };
    await saveLabRecipe(sy, project, input);
    const changed = YAML.parse(readFileSync(env.cfg.configPath, "utf8"));
    expect(changed).not.toHaveProperty("repositories");
    expect(changed.projects[project].repositories).toEqual(original.repositories);
    const { repositories: removed, ...globalOriginal } = original;
    const { projects: added, ...globalChanged } = changed;
    expect(globalChanged).toEqual(globalOriginal);
    expect(Object.keys(changed.projects)).toEqual([project]);
    expect(sy.projects.primary.project.slug).toBe(project);
    expect(sy.projects.primary.repositoryPaths).toEqual(repositories);
    expect(sy.projects.rows().find(p => p.id === project)).toEqual(row);
    expect(labRecipeView(sy, project)).toMatchObject({ legacy: false, readOnly: false, configured: true, maxActive: 2 });
    expect(ensureLabSupervisor).not.toHaveBeenCalled();
  });
  it("archived writes and unsupported model/supervisor controls are refused", async () => {
    const s = setup(); archiveProject(s, "beta");
    expect(labRecipeView(s, "beta").readOnly).toBe(true);
    await expect(requestLabControl(s, "beta", "feature", { action: "create" })).rejects.toThrow(/archived/);
    await expect(requestLabControl(s, "alpha", "feature", { action: "promote", reason: "" })).rejects.toThrow();
    await expect(requestLabControl(s, "alpha", "feature", { action: "create", by: "supervisor" })).rejects.toThrow();
    expect(ensureLabSupervisor).not.toHaveBeenCalled();
  });
});

