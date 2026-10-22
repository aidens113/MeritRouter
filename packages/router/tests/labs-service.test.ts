import { afterEach, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { baseConfig, commitAll, makeEnv, open, reply, ScriptedClient, type Env } from "./helpers.js";
import type { Switchyard } from "../src/core/service.js";
import { LabRecipeSchema } from "../src/labs/recipe.js";

let env: Env | undefined;
let sy: Switchyard | undefined;
afterEach(async () => { await sy?.close(); sy = undefined; env?.cleanup(); env = undefined; });

it("reads creating and failed partial labs before their endpoint ports are allocated", async () => {
  env = makeEnv({ config: baseConfig({ repositories: {}, brain: { path: "brain", project: "alpha" }, projects: { alpha: { repositories: { app: { path: "repo" } }, lab: {} } } }) });
  sy = open(env, new ScriptedClient(() => reply("{}")));
  const now = Date.now();
  const lab = { id: "partial-lab", project: "alpha", name: "partial", state: "creating" as const,
    root: path.join(env.cfg.storageDir, "labs", "alpha", "partial"), repositories: [], ports: {}, env: {}, goal: "Pending creation",
    recipe: LabRecipeSchema.parse({ ports: ["web"], services: { web: { repo: "app", command: "unused", ready: { http: "http://127.0.0.1:{port.web}/" } } } }),
    createdAt: now, updatedAt: now, lastActivity: now };
  sy.labs.store.insert(lab);
  expect(sy.labs.publicStatus("alpha", "partial")).toMatchObject({ lab: { state: "creating" }, urls: {}, services: [] });
  sy.labs.store.save({ ...lab, state: "failed" });
  expect(sy.labs.publicStatus("alpha", "partial")).toMatchObject({ lab: { state: "failed" }, urls: {} });
  sy.labs.store.save({ ...lab, state: "stopped", ports: { web: 55001 } });
  expect(sy.labs.publicStatus("alpha", "partial").urls).toEqual({ web: "http://127.0.0.1:55001/" });
});

it("atomically claims one lab root team and validates child context in its lab checkout", async () => {
  const config = baseConfig({ repositories: {}, brain: { path: "brain", project: "alpha" }, projects: { alpha: { repositories: { app: { path: "repo" } }, lab: {} } } });
  (config.profiles as Record<string, unknown>).supervise = { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100, max_model_requests: 30, max_output_tokens: 4000, classify: "never", min_tier: "T3" };
  env = makeEnv({ config });
  const client = new ScriptedClient(() => reply("{}"));
  sy = open(env, client);
  const { lab } = await sy.labs.create("alpha", "feature");
  const worktree = lab.repositories[0]!.worktree;
  writeFileSync(path.join(worktree, "lab-only.txt"), "Context available only in this lab\n");
  commitAll(worktree);
  const first = await sy.startJob({ project: "alpha", lab: "feature", goal: "Inspect lab context", repositories: ["app"], idempotencyKey: "first-team" });
  const before = sy.tasks.list({ limit: 100 }).length;
  await expect(sy.startJob({ project: "alpha", lab: "feature", goal: "Competing team", repositories: ["app"] })).rejects.toThrow(/already has root team/);
  expect(sy.tasks.list({ limit: 100 })).toHaveLength(before);
  const duplicate = await sy.startJob({ project: "alpha", lab: "feature", goal: "Inspect lab context", repositories: ["app"], idempotencyKey: "first-team" });
  expect(duplicate.taskId).toBe(first.taskId);
  const [child] = await sy.submitTasks([{ profile: "inspect", lab: "feature", parentTaskId: first.taskId, repositoryAliases: ["app"], goal: "Read lab-only context", context: { fileRefs: ["app:lab-only.txt"] }, constraints: { acceptanceCriteria: ["Read the context"] } }], { project: "alpha" });
  expect(sy.tasks.get(child!.taskId)?.spec.lab).toBe("feature");
  const count = sy.tasks.list({ limit: 100 }).length;
  await expect(sy.submitTasks([{ profile: "inspect", parentTaskId: first.taskId, repositoryAliases: ["app"], goal: "Escape lab", constraints: { acceptanceCriteria: ["Must be refused"] } }], { project: "alpha" })).rejects.toThrow(/escape.*lab/);
  expect(sy.tasks.list({ limit: 100 })).toHaveLength(count);
  expect(client.requests).toHaveLength(0);
});
