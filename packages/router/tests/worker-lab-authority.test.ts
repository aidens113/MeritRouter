import { afterEach, expect, it, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import YAML from "yaml";
import path from "node:path";
import { openDatabase, type Db } from "../src/storage/db.js";
import { TaskStore } from "../src/storage/tasks.js";
import { capturedLease, type LeaseRef } from "../src/storage/task-leases.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { LabManager } from "../src/labs/lab.js";
import { ProjectRegistry } from "../src/projects/registry.js";
import { LabRecipeSchema } from "../src/labs/recipe.js";
import { git } from "../src/workspaces/git.js";
import { assertLabEffect, withLabAuthority } from "../src/labs/control-authority.js";
import { baseConfig, makeEnv, type Env } from "./helpers.js";

let env: Env, db: Db, manager: LabManager;
afterEach(async () => { await manager?.close(); db?.close(); env?.cleanup(); vi.restoreAllMocks(); });
async function setup() {
  const raw = baseConfig({ security: { outside_repository: "supervisor" }, repositories: {}, projects: { demo: { repositories: { core: { path: "repo" } }, lab: { checks: { smoke: "fixture-command" } } } } });
  (raw.profiles as Record<string, unknown>).supervise = { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100, max_model_requests: 30 };
  env = makeEnv({ config: raw }); db = openDatabase(env.cfg.storageDir);
  const tasks = new TaskStore(db);
  tasks.submit([WorkerTaskSchema.parse({ id: "supervisor", profile: "supervise", goal: "lab", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["lab"] } })], { project: "demo" });
  const task = tasks.claim("owner", { maxConcurrent: 1, maxWritersPerRepo: 1, leaseMs: 60000, defaultTimeoutMs: 60000 })[0]!;
  const registry = new ProjectRegistry(env.cfg);
  manager = new LabManager({ db, storageDir: env.cfg.storageDir, cfg: env.cfg, project: slug => registry.context(slug)!, monitor: false });
  const created = await manager.create("demo", "fixture");
  manager.store.save({ ...created.lab, recipe: LabRecipeSchema.parse({ checks: { smoke: "fixture-command" } }) });
  db.prepare("UPDATE labs SET recipe_json=? WHERE id=?").run(JSON.stringify(LabRecipeSchema.parse({ checks: { smoke: "fixture-command" } })),created.lab.id);
  // The effect boundary for a Lab command check. Since 5cb43f9 checks execute through the Lab's
  // Job-bound repository commands, not `runProcess`; spying on the old primitive made every
  // "never executed" assertion below vacuous and the positive count impossible.
  const run = vi.spyOn(manager.commands, "run").mockResolvedValue({ exitCode: 0, stdout: "fake", stderr: "", killed: null, durationMs: 1 });
  return { tasks, lease: capturedLease(task), run };
}
function disable() {
  const raw = YAML.parse(readFileSync(env.cfg.configPath, "utf8")); raw.security.outside_repository = "disabled"; writeFileSync(env.cfg.configPath, YAML.stringify(raw));
}
function queue(lease: LeaseRef) { return manager.requestControl("demo", "fixture", { kind: "check", name: "smoke" }, `task:${lease.taskId}`, { taskLease: lease }); }

it.each(["disabled", "cancelled", "incarnation", "generation"])("refuses queued model Lab effects after %s", async kind => {
  const { lease, run } = await setup(); const op = queue(lease);
  if (kind === "disabled") disable();
  else if (kind === "cancelled") db.prepare("UPDATE tasks SET cancel_requested=1 WHERE id=?").run(lease.taskId);
  else if (kind === "incarnation") db.prepare("UPDATE tasks SET lease_incarnation=? WHERE id=?").run("f".repeat(32), lease.taskId);
  else db.prepare("UPDATE tasks SET run_count=run_count+1 WHERE id=?").run(lease.taskId);
  await manager.controls.process("demo", "fixture");
  expect(manager.operation("demo", "fixture", op.id)?.state).toBe("failed"); expect(run).not.toHaveBeenCalled();
});
it("executes a proved active supervisor operation and distinguishes explicit operator controls", async () => {
  const { lease, run } = await setup();
  const model = queue(lease); await manager.controls.process("demo", "fixture");
  expect(manager.operation("demo", "fixture", model.id)).toMatchObject({ state: "completed", errorMessage: null }); expect(run).toHaveBeenCalledTimes(1);
  disable();
  const operator = manager.requestControl("demo", "fixture", { kind: "check", name: "smoke" }, "human:panel");
  await manager.controls.process("demo", "fixture");
  expect(manager.operation("demo", "fixture", operator.id)?.state).toBe("completed"); expect(run).toHaveBeenCalledTimes(2);
});
it("refuses forged actor scope and legacy queued model operations without lease proof", async () => {
  const { lease, run } = await setup();
  expect(() => manager.requestControl("demo", "fixture", { kind: "check", name: "smoke" }, "task:other", { taskLease: lease })).toThrow(/captured|authority/);
  expect(() => manager.requestControl("demo", "fixture", { kind: "check", name: "smoke" }, "task:supervisor")).toThrow(/captured/);
  db.prepare("INSERT INTO lab_operations(id,lab_id,project_id,lab_name,kind,input_json,state,requested_by,created_at,updated_at) VALUES('legacy',?,'demo','fixture','check',?,'pending','task:supervisor',1,1)").run(manager.store.get("demo", "fixture")!.id,JSON.stringify({ kind: "check", name: "smoke" }));
  await manager.controls.process("demo", "fixture");
  expect(manager.operation("demo", "fixture", "legacy")?.state).toBe("failed"); expect(run).not.toHaveBeenCalled();
});
it("revocation during an awaited effect aborts its signal and refuses subsequent effects", async () => {
  const { lease } = await setup(); let effects = 0;
  await expect(withLabAuthority(db, env.cfg, "demo", lease, undefined, async () => {
    assertLabEffect(); effects++;
    await new Promise<void>(resolve => setTimeout(() => { disable(); resolve(); }, 60));
    await new Promise(resolve => setTimeout(resolve, 60));
    assertLabEffect(); effects++;
  })).rejects.toThrow(/cancelled|revoked/);
  expect(effects).toBe(1);
});
it("rechecks after service awaits and preserves a preexisting human service during rollback", async () => {
  const { lease } = await setup();
  const lab = manager.store.get("demo", "fixture")!;
  const recipe = LabRecipeSchema.parse({ services: { first: { repo: "core", command: "never" }, second: { repo: "core", command: "never", after: ["first"] } } });
  db.prepare("UPDATE labs SET recipe_json=? WHERE id=?").run(JSON.stringify(recipe), lab.id);
  const existing = { lab_id: lab.id, name: "first", state: "running" as const, pid: null, token: "h".repeat(24), log_path: "unused", restart_count: 0, next_restart: null, started_at: Date.now(), owner_id: manager.owner, owner_until: Date.now() + 60000 };
  manager.store.saveService(existing);
  const start = vi.spyOn(manager.services, "start").mockImplementation(async () => { await Promise.resolve(); disable(); return existing; });
  const stop = vi.spyOn(manager.services, "stop").mockResolvedValue();
  const op = manager.requestControl("demo", "fixture", { kind: "start" }, "task:supervisor", { taskLease: lease });
  await manager.controls.process("demo", "fixture");
  expect(manager.operation("demo", "fixture", op.id)?.state).toBe("failed");
  expect(start).toHaveBeenCalledTimes(1); expect(stop).not.toHaveBeenCalled();
});
it("daemon restart revocation stops only the model-origin service and never restarts it", async () => {
  const { lease } = await setup();
  const lab = manager.store.get("demo", "fixture")!;
  const recipe = LabRecipeSchema.parse({ services: { model: { repo: "core", command: "never" }, human: { repo: "core", command: "never" } } });
  db.prepare("UPDATE labs SET recipe_json=? WHERE id=?").run(JSON.stringify(recipe), lab.id);
  for (const name of ["model", "human"]) manager.store.saveService({ lab_id: lab.id, name, state: name === "model" ? "backoff" : "stopped", pid: null, token: null, log_path: "unused", restart_count: 0, next_restart: name === "model" ? 0 : null, started_at: null, owner_id: manager.owner, owner_until: Date.now() + 60000 });
  db.prepare("UPDATE lab_services SET authority_json=? WHERE lab_id=? AND name='model'").run(JSON.stringify(lease), lab.id);
  disable();
  const stop = vi.spyOn(manager.services, "stop").mockResolvedValue();
  const start = vi.spyOn(manager.services, "start");
  await manager.services.monitor(manager.store.get("demo", "fixture")!);
  expect(stop.mock.calls.map(call => call[1])).toEqual(["model"]); expect(start).not.toHaveBeenCalled();
});
