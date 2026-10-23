import { afterEach, expect, it, vi } from "vitest";
import { readFileSync, writeFileSync, statSync, utimesSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import YAML from "yaml";
import { WorkerTaskSchema } from "../src/core/task.js";
import { parseConfig } from "../src/config/load.js";
import * as validation from "../src/core/validate.js";
import { saveLabRecipe } from "../src/admin/labs.js";
import { baseConfig, makeEnv, open, ScriptedClient, reply, commitAll, type Env } from "./helpers.js";
import type { MeritRouter } from "../src/core/service.js";

let env: Env | undefined, sy: MeritRouter | undefined;
afterEach(async () => { vi.restoreAllMocks(); await sy?.close(); sy = undefined; env?.cleanup(); env = undefined; });
const task = () => ({ profile: "implement", goal: "Change the scoped application", repositoryAliases: ["core"], writableRepository: "core", constraints: { acceptanceCriteria: ["Works"], allowedPaths: ["src/**"], labChecks: ["health"] } });
function setup(enabled = true) {
  env = makeEnv({ config: baseConfig({ repositories: {}, brain: { project: "alpha", path: "brain" }, projects: {
    alpha: { repositories: { core: { path: "repo" }, context: { path: "repo-context", writable: false } },
      labs: { ephemeral: { enabled, checks: ["health"] } }, lab: { checks: { health: { repo: "core", command: "node --version" } } } },
  } }) });
  execFileSync("git", ["clone", "-q", env.repo, path.join(env.dir, "repo-context")]);
  const client = new ScriptedClient(() => reply("unused"));
  sy = open(env, client, { worker: false });
  return { client, s: sy };
}

it("validates names and enabled project cross-references without broadening command criteria", () => {
  for (const names of [[], ["health", "health"], ["../health"], Array(11).fill("health")]) expect(WorkerTaskSchema.safeParse({ ...task(), constraints: { ...task().constraints, labChecks: names } }).success).toBe(false);
  const raw = { ...baseConfig(), repositories: {}, projects: { alpha: { repositories: {}, labs: { ephemeral: { enabled: true, checks: ["health"] } } } } };
  expect(() => parseConfig(raw, path.join(process.cwd(), "fixture.yaml"))).toThrow(/require.*recipe|unknown declared/);
  expect(() => parseConfig({ ...raw, projects: { alpha: { ...raw.projects.alpha, lab: { checks: { other: "node --version" } } } } }, path.join(process.cwd(), "fixture.yaml"))).toThrow(/unknown declared Lab check health/);
  expect(WorkerTaskSchema.parse(task()).constraints.checks).toBeUndefined();
});

it("rejects disabled, unapproved and noncoding selections before any task or provider request", async () => {
  const { s, client } = setup(false);
  await expect(s.submitTasks([task()], { project: "alpha" })).rejects.toThrow(/not enabled/);
  expect(s.tasks.list()).toHaveLength(0); expect(client.requests).toHaveLength(0);
  const cfg = s.projectContext("alpha");
  await expect(validation.validateTask(cfg, { ...task(), profile: "inspect", writableRepository: undefined }, s.artifacts)).rejects.toThrow(/isolated coding/);
  await expect(validation.validateTask(cfg, { ...task(), constraints: { ...task().constraints, labChecks: ["unknown"] } }, s.artifacts)).rejects.toThrow(/allowlist|unknown declared/);
});

it("pins every opted-in source and uses configured repository order; ordinary tasks retain their behavior", async () => {
  const { s, client } = setup();
  const [submitted] = await s.submitTasks([{ ...task(), repositoryAliases: ["context", "core"] }], { project: "alpha" });
  const spec = s.tasks.get(submitted!.taskId)!.spec;
  expect(spec.repositoryAliases).toEqual(["core", "context"]);
  expect(Object.keys(spec.context.baseCommits!)).toEqual(["core", "context"]);
  const pinned = spec.context.baseCommits!.context;
  writeFileSync(path.join(env!.dir, "repo-context", "README.md"), "Advanced context target\n"); commitAll(path.join(env!.dir, "repo-context"));
  expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: path.join(env!.dir, "repo-context"), encoding: "utf8" }).trim()).not.toBe(pinned);
  expect(s.tasks.get(submitted!.taskId)!.spec.context.baseCommits!.context).toBe(pinned);
  const ordinary = task(); const { labChecks: _ignored, ...constraints } = ordinary.constraints;
  const [plain] = await s.submitTasks([{ ...ordinary, constraints }], { project: "alpha" });
  expect(s.tasks.get(plain!.taskId)!.spec.context.baseCommits).toBeUndefined(); expect(client.requests).toHaveLength(0);
});

it("refuses browser selections and default command cwd outside the task scope", async () => {
  const { s } = setup(); const cfg = s.projectContext("alpha");
  const raw = YAML.parse(readFileSync(env!.cfg.configPath, "utf8"));
  raw.projects.alpha.lab.checks.health = "node --version";
  const current = parseConfig(raw, env!.cfg.configPath);
  const scoped = { ...cfg, projects: current.projects };
  await expect(validation.validateTask(scoped, { ...task(), repositoryAliases: ["context"], writableRepository: "context" }, s.artifacts)).rejects.toThrow(/default repository/);
  raw.projects.alpha.lab = { ports: ["web"], services: { app: { repo: "core", command: "node server.js", ready: { http: "http://127.0.0.1:{port.web}/" } } }, checks: { health: { kind: "browser", mode: "static", executable: process.execPath, service: "app", path: "/", assertions: [{ kind: "exists", selector: "body" }] } } };
  const browser = parseConfig(raw, env!.cfg.configPath);
  await expect(validation.validateTask({ ...cfg, projects: browser.projects }, task(), s.artifacts)).rejects.toThrow(/browser recovery/);
});

it("rechecks human permission by content under the insertion lock after asynchronous validation", async () => {
  const { s, client } = setup(); const original = validation.validateTask;
  let release!: () => void, entered!: () => void;
  const hold = new Promise<void>(r => { release = r; }), ready = new Promise<void>(r => { entered = r; });
  vi.spyOn(validation, "validateTask").mockImplementationOnce(async (...args) => { const spec = await original(...args); entered(); await hold; return spec; });
  const pending = s.submitTasks([task()], { project: "alpha" });
  await ready;
  try {
    const timestamp = statSync(env!.cfg.configPath), raw = YAML.parse(readFileSync(env!.cfg.configPath, "utf8"));
    raw.projects.alpha.labs.ephemeral.enabled = false;
    writeFileSync(env!.cfg.configPath, YAML.stringify(raw)); utimesSync(env!.cfg.configPath, timestamp.atime, timestamp.mtime);
    const rejection = expect(pending).rejects.toThrow(/not enabled/); release(); await rejection;
    expect(s.tasks.list()).toHaveLength(0); expect(client.requests).toHaveLength(0);
  } finally { release(); }
});

it("preserves the human task-check policy when the recipe editor changes promotion and capacity", async () => {
  const { s } = setup();
  await saveLabRecipe(s, "alpha", { recipe: { checks: { health: { repo: "core", command: "node --version" } } }, promotion: "manual", maxActive: null });
  const raw = YAML.parse(readFileSync(env!.cfg.configPath, "utf8"));
  expect(raw.projects.alpha.labs.ephemeral).toEqual({ enabled: true, checks: ["health"] });
  expect(raw.projects.alpha.labs.max_active).toBeUndefined();
});
