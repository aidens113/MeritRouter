import { afterEach, describe, expect, it } from "vitest";
import { Executor, type ExecutorDeps, type ProjectDeps } from "../src/core/executor.js";
import type { MeritRouter } from "../src/core/service.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { createProjectRuntimeStore, projectStoresForTask } from "../src/projects/runtime-store.js";
import { QUALIFICATION_PROJECT } from "../src/qualification/registry.js";
import { baseConfig, goodOutput, makeEnv, open, reply, ScriptedClient, summarizeTask, type Env } from "./helpers.js";

let env: Env | undefined;
let sy: MeritRouter | undefined;
let executor: Executor | undefined;
afterEach(async () => {
  await executor?.flush();
  await sy?.close();
  executor = undefined;
  sy = undefined;
  env?.cleanup();
  env = undefined;
});

function setup() {
  env = makeEnv({ config: baseConfig({ repositories: {}, projects: { alpha: {}, beta: {} } }) });
  const client = new ScriptedClient(() => reply(JSON.stringify(goodOutput())));
  sy = open(env, client);
  return client;
}

function task(project = "alpha") {
  sy!.tasks.submit([WorkerTaskSchema.parse(summarizeTask({ id: "fixture", hints: { difficulty: "T1" } }))], { project });
  return sy!.tasks.get("fixture")!;
}

function deps(project?: ExecutorDeps["project"]): ExecutorDeps {
  return {
    cfg: env!.cfg, db: sy!.db, gate: sy!.gate, catalog: sy!.catalog, router: sy!.router,
    tasks: sy!.tasks, artifacts: sy!.artifacts, owner: "runtime-store-test", now: Date.now,
    coding: null, supervisor: null, brain: null, access: null, services: null, sessions: null,
    contracts: sy!.contracts, onSettled: () => {}, ...(project ? { project } : {}),
  };
}

function claim() {
  return sy!.tasks.claim("runtime-store-test", { maxConcurrent: 2, maxWritersPerRepo: 1, leaseMs: 30000, defaultTimeoutMs: 60000 })[0]!;
}

describe("transitional project runtime store handle", () => {
  it("retains the exact same existing store references for each project and rejects unknown projects", () => {
    setup();
    for (const project of ["alpha", "beta"]) {
      const stores = sy!.projectStores(project);
      expect(stores.project).toBe(project);
      expect(stores.db).toBe(sy!.db);
      expect(stores.tasks).toBe(sy!.tasks);
      expect(stores.sessions).toBe(sy!.sessions);
      expect(stores.artifacts).toBe(sy!.artifacts);
      expect(stores.contracts).toBe(sy!.contracts);
      expect(Object.isFrozen(stores)).toBe(true);
      expect(sy!.projectContext(project).brain.project).toBe(project);
    }
    expect(() => sy!.projectStores("missing")).toThrow(/not configured/);
  });

  it("validates handles against task owner and configuration while keeping qualification explicit", () => {
    setup();
    const stored = task();
    const alpha = sy!.projectStores("alpha");
    expect(projectStoresForTask(alpha, stored, sy!.projectContext("alpha"))).toBe(alpha);
    expect(() => projectStoresForTask(sy!.projectStores("beta"), stored, sy!.projectContext("alpha"))).toThrow(/identity disagrees/);
    expect(() => projectStoresForTask(alpha, stored, sy!.projectContext("beta"))).toThrow(/identity disagrees/);
    const qualification = sy!.projectStores(QUALIFICATION_PROJECT);
    expect(qualification.project).toBe(QUALIFICATION_PROJECT);
    expect(qualification.tasks).toBe(sy!.tasks);
    expect(() => createProjectRuntimeStore("../bad", alpha)).toThrow();
  });

  it("rejects stale task owner snapshots and missing persisted tasks", () => {
    setup();
    const stored = task();
    const alpha = sy!.projectStores("alpha");
    expect(() => projectStoresForTask(alpha, { ...stored, row: { ...stored.row, id: "missing" } }, sy!.projectContext("alpha"))).toThrow(/current stored task/);
    expect(() => projectStoresForTask(alpha, { ...stored, row: { ...stored.row, project_id: "" } }, sy!.projectContext("alpha"))).toThrow(/current stored task/);
  });

  it("preserves raw legacy tasks with empty project when the configured primary matches", () => {
    setup();
    const stored = task("");
    expect(stored.row.project_id).toBe("");
    expect(projectStoresForTask(sy!.projectStores(""), stored, sy!.projectContext(""))).toBeDefined();
  });

  it("refuses a mismatched store handle before provider or runner execution", async () => {
    const client = setup();
    task();
    executor = new Executor(deps(() => ({ cfg: sy!.projectContext("alpha"), brain: null, access: null, stores: sy!.projectStores("beta") })));
    await executor.runSingle(claim());
    expect(client.requests).toHaveLength(0);
    expect(sy!.tasks.get("fixture")!.row.state).toBe("failed");
    expect(sy!.tasks.get("fixture")!.result?.stopReason).toMatch(/identity disagrees/);
  });

  it("fails unknown project selection before provider use", async () => {
    const client = setup();
    task("missing");
    executor = new Executor(deps(stored => ({ cfg: sy!.projectContext(stored.row.project_id), brain: null, access: null })));
    await executor.runSingle(claim());
    expect(client.requests).toHaveLength(0);
    expect(sy!.tasks.get("fixture")!.result?.stopReason).toMatch(/not configured/);
  });

  it("accepts qualification ownership and rejects corrupted handle/context identities", () => {
    setup();
    const stored = task(QUALIFICATION_PROJECT);
    const stores = sy!.projectStores(QUALIFICATION_PROJECT);
    expect(projectStoresForTask(stores, stored, sy!.projectContext(QUALIFICATION_PROJECT))).toBe(stores);
    expect(() => projectStoresForTask({ ...stores, project: "../bad" }, stored, sy!.projectContext(QUALIFICATION_PROJECT))).toThrow();
    const cfg = sy!.projectContext(QUALIFICATION_PROJECT);
    const corrupted = { ...cfg, project: { ...cfg.project, slug: "alpha" } };
    expect(() => projectStoresForTask(stores, stored, corrupted)).toThrow(/brain scope/);
  });

  it.each(["absent", "legacy", "handle"])("keeps completion working with %s project dependency support", async mode => {
    const client = setup();
    // No project callback is the historical single-project executor contract.
    task(mode === "absent" ? "demo" : "alpha");
    const project: ExecutorDeps["project"] = mode === "absent" ? undefined : () => {
      const value: ProjectDeps = { cfg: sy!.projectContext("alpha"), brain: null, access: null };
      return mode === "handle" ? { ...value, stores: sy!.projectStores("alpha") } : value;
    };
    executor = new Executor(deps(project));
    await executor.runSingle(claim());
    expect(client.requests).toHaveLength(1);
    expect(sy!.tasks.get("fixture")!.row.state).toBe("completed");
  });
});
