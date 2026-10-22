import { afterEach, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { baseConfig, commitAll, makeEnv, open, reply, ScriptedClient, type Env } from "./helpers.js";
import type { Switchyard } from "../src/core/service.js";

let env: Env | undefined;
let sy: Switchyard | undefined;
afterEach(async () => { await sy?.close(); sy = undefined; env?.cleanup(); env = undefined; });

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
