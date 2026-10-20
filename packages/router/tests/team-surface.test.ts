import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Switchyard } from "../src/core/service.js";
import { WorkerTaskSchema, type WorkerResult } from "../src/core/task.js";
import { syntheticResult, type ClaimLimits } from "../src/storage/tasks.js";
import { PlanStore, type PlanNodeInput } from "../src/storage/plans.js";
import { jobPlan } from "../src/admin/insights.js";
import { createCodingRunner } from "../src/runners/coding/index.js";
import { baseConfig, goodOutput, makeEnv, open, reply, ScriptedClient, servedFor, type Env } from "./helpers.js";

// The CLI runs from dist/ (build first: pnpm --filter switchyard-router build).
const cliJs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

let env: Env | undefined;
let sy: Switchyard | undefined;
afterEach(async () => {
  await sy?.close();
  sy = undefined;
  env?.cleanup();
  env = undefined;
});

function cleanEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !/KEY|TOKEN|SECRET|FREELLMAPI|SWITCHYARD/i.test(k)));
}

function cli(e: Env, ...args: string[]) {
  const r = spawnSync(process.execPath, [cliJs, ...args, "--config", e.cfg.configPath], { encoding: "utf8", env: cleanEnv(), timeout: 30_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function teamConfig(maxAgents: number, extra: Record<string, unknown> = {}) {
  const cfg = baseConfig({ team: { max_agents: maxAgents }, ...extra });
  (cfg.profiles as Record<string, unknown>).supervise = { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100, max_model_requests: 30, max_output_tokens: 4000, classify: "never", min_tier: "T3" };
  return cfg;
}

const JOB = "job_plan_view";
const node = (label: string, dependsOn: string[], over: Partial<PlanNodeInput> = {}): PlanNodeInput => ({ label, profile: "inspect", goal: `do ${label}`, acceptanceCriteria: ["x"], dependsOn, requiresAcceptedInputs: false, weight: 1, ...over });
const child = (label: string, extra: Record<string, unknown> = {}) =>
  WorkerTaskSchema.parse({ id: `t_${label}`, label, parentTaskId: JOB, profile: "inspect", goal: `do ${label}`, repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["x"] }, ...extra });
const coding = (label: string, allowedPaths: string[], dependsOn: string[]) =>
  child(label, { profile: "implement", writableRepository: "core", constraints: { acceptanceCriteria: ["x"], allowedPaths }, dependsOn });
const done = (id: string, acceptanceStatus: WorkerResult["acceptanceStatus"]): WorkerResult => ({ ...syntheticResult(id, "completed", "done"), acceptanceStatus, summary: `summary of ${id}` });
const LIMITS: ClaimLimits = { maxConcurrent: 20, maxWritersPerRepo: 10, leaseMs: 60_000, defaultTimeoutMs: 600_000, supervisorProfiles: ["supervise"], maxSupervisors: 0 };

describe("job plan view", () => {
  it("joins plan nodes with their tasks: states, critical path, file leases, and why nodes wait", async () => {
    env = makeEnv({ config: teamConfig(1) });
    sy = open(env, new ScriptedClient(() => reply("unused", { model: "m", provider: "p" })), { worker: false });
    sy.tasks.submit([WorkerTaskSchema.parse({ id: JOB, profile: "supervise", goal: "Add helpers as a diamond", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["helpers exist"] } })]);
    // A diamond (scan -> divide, modulo -> check) plus an independent node; modulo is the heavy branch.
    const plans = new PlanStore(sy.db);
    const nodes = [
      node("scan", [], { difficulty: "T1", weight: 1 }),
      node("divide", ["scan"], { profile: "implement", writableRepository: "core", allowedPaths: ["src/app.ts"], difficulty: "T2", weight: 2 }),
      node("modulo", ["scan"], { profile: "implement", writableRepository: "core", allowedPaths: ["src/**"], difficulty: "T3", weight: 4 }),
      node("check", ["divide", "modulo"], { difficulty: "T1", weight: 1, importance: "high", requiresAcceptedInputs: true }),
      node("notes", [], { weight: 2 }),
    ];
    plans.record(JOB, nodes.slice(0, 4), { note: "first cut", createdBy: "supervisor:test" });
    plans.record(JOB, nodes, { note: "add notes", createdBy: "supervisor:test" });
    sy.tasks.submit([child("scan"), coding("divide", ["src/app.ts"], ["t_scan"]), coding("modulo", ["src/**"], ["t_scan"]), child("check", { dependsOn: ["t_divide", "t_modulo"] }), child("notes")]);
    // A task the supervisor delegated without the plan.
    sy.tasks.submit([child("adhoc")]);

    // One agent per job: scan runs; notes waits for the agent cap; the rest wait on dependencies.
    expect(sy.tasks.claim("w", { ...LIMITS, maxAgentsPerJob: 1 }).map((t) => t.row.id)).toEqual(["t_scan"]);
    let p = jobPlan(sy, JOB)!;
    expect(p.plan).toMatchObject({ version: 2, note: "add notes", createdBy: "supervisor:test", nodes: 5 });
    expect(p.versions.map((v) => [v.version, v.nodes])).toEqual([[1, 4], [2, 5]]);
    expect(p.criticalPath).toEqual({ labels: ["scan", "modulo", "check"], cost: 6 });
    expect(p.nodes.filter((n) => n.onCriticalPath).map((n) => n.label)).toEqual(["scan", "modulo", "check"]);
    expect(p.edges.filter((e) => e.onCriticalPath).map((e) => `${e.from}>${e.to}`)).toEqual(["scan>modulo", "modulo>check"]);
    expect(p.edges).toHaveLength(4);
    expect(Object.fromEntries(p.nodes.map((n) => [n.label, n.depth]))).toEqual({ scan: 0, divide: 1, modulo: 1, check: 2, notes: 0 });
    expect(p.maxAgents).toBe(1);
    expect(p.running).toBe(1);
    const at = (label: string) => p.nodes.find((n) => n.label === label)!;
    expect(at("scan")).toMatchObject({ taskId: "t_scan", state: "running", difficulty: "T1", waiting: null });
    expect(at("notes").waiting).toMatchObject({ kind: "agent_cap", running: 1, cap: 1 });
    expect(at("divide").waiting).toMatchObject({ kind: "dependencies", on: ["scan"] });
    expect(at("check")).toMatchObject({ importance: "high", requiresAcceptedInputs: true, waiting: { kind: "dependencies", on: ["divide", "modulo"] } });
    expect(p.otherTasks.map((t) => t.label)).toEqual(["adhoc"]);

    // scan finishes: divide takes the file lease on src/app.ts; modulo (src/**) waits for it.
    sy.tasks.finish("t_scan", "w", done("t_scan", "met"), "completed");
    expect(sy.tasks.claim("w", { ...LIMITS, maxAgentsPerJob: 10 }).map((t) => t.row.id).sort()).toEqual(["t_adhoc", "t_divide", "t_notes"]);
    p = jobPlan(sy, JOB)!;
    expect(at("divide")).toMatchObject({ state: "running", waiting: null });
    expect(at("modulo").waiting).toMatchObject({ kind: "file_lease", holderTaskId: "t_divide", holderLabel: "divide", repository: "core", globs: ["src/app.ts"] });
    expect(at("modulo").waiting!.text).toBe("waits for the file lease divide holds on src/app.ts in core");
    expect(at("modulo").leaseWaits).toBe(1);
    expect(p.leases.filter((l) => l.live).map((l) => [l.taskLabel, l.globs])).toEqual([["divide", ["src/app.ts"]]]);

    // divide finishes (lease released); modulo runs and finishes unverified; check waits for its acceptance.
    sy.tasks.finish("t_divide", "w", done("t_divide", "met"), "completed");
    expect(sy.tasks.claim("w", { ...LIMITS, maxAgentsPerJob: 10 }).map((t) => t.row.id)).toEqual(["t_modulo"]);
    sy.tasks.finish("t_modulo", "w", done("t_modulo", "not_verified"), "completed");
    expect(sy.tasks.claim("w", { ...LIMITS, maxAgentsPerJob: 10 })).toEqual([]);
    p = jobPlan(sy, JOB)!;
    expect(at("check").waiting).toMatchObject({ kind: "acceptance", on: ["modulo"], taskIds: ["t_modulo"] });
    expect(at("modulo")).toMatchObject({ state: "completed", acceptanceStatus: "not_verified", waiting: null, leaseWaits: 1 });
    expect(p.leases.map((l) => [l.taskLabel, l.live, l.releaseReason])).toEqual([["divide", false, "finished"], ["modulo", false, "finished"]]);

    // Older versions are readable; unknown jobs and versions are null.
    expect(jobPlan(sy, JOB, { version: 1 })!.nodes.map((n) => n.label)).toEqual(["scan", "divide", "modulo", "check"]);
    expect(jobPlan(sy, JOB, { version: 9 })).toBeNull();
    expect(jobPlan(sy, "t_scan")).toBeNull();
    expect(jobPlan(sy, "nope")).toBeNull();

    // The CLI prints the same view (and JSON with --json).
    await sy.close();
    sy = undefined;
    const text = cli(env, "plan", JOB);
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toContain("plan v2 of 2");
    expect(text.stdout).toContain("critical path (*): scan -> modulo -> check (estimated cost 6)");
    expect(text.stdout).toMatch(/\*\s+check\s+inspect\s+divide,modulo\s+T1\/-\s+high\s+accepted\s+waiting_for_dependencies/);
    expect(text.stdout).toContain("waits until modulo is accepted");
    expect(text.stdout).toContain("tasks outside this plan version:");
    const json = cli(env, "plan", JOB, "--json");
    expect(json.code, json.stderr).toBe(0);
    const body = JSON.parse(json.stdout);
    expect(body.criticalPath.labels).toEqual(["scan", "modulo", "check"]);
    expect(body.nodes).toHaveLength(5);
    const missing = cli(env, "plan", "nope");
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain("unknown job nope");
  }, 60_000);

  it("a job without a plan has plan null and its tasks under otherTasks", async () => {
    env = makeEnv({ config: teamConfig(2) });
    sy = open(env, new ScriptedClient(() => reply("unused", { model: "m", provider: "p" })), { worker: false });
    sy.tasks.submit([WorkerTaskSchema.parse({ id: JOB, profile: "supervise", goal: "No plan", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["x"] } })]);
    sy.tasks.submit([child("solo")]);
    const p = jobPlan(sy, JOB)!;
    expect(p).toMatchObject({ plan: null, versions: [], nodes: [], edges: [], criticalPath: { labels: [], cost: 0 }, maxAgents: 2 });
    expect(p.otherTasks.map((t) => t.label)).toEqual(["solo"]);
  });
});

describe("external coding runner", () => {
  it("puts the upstream results block in TASK.md, as the native runner shows it", async () => {
    // The "agent" prints its TASK.md; the runner stores stdout as the task's agent_output artifact.
    const printPrompt = `node -e "process.stdout.write(require('fs').readFileSync(process.env.SWITCHYARD_PROMPT_FILE,'utf8'))"`;
    env = makeEnv({ config: baseConfig({ coding: { runner: "command", command: printPrompt } }) });
    const client = new ScriptedClient((req) => reply(JSON.stringify(goodOutput(1, "inline", { summary: "UPSTREAM-FINDING-42" })), servedFor(sy!, req)));
    sy = open(env, client, { worker: true, coding: createCodingRunner(env.cfg) });
    const [up] = await sy.submitTasks([{ profile: "summarize", goal: "Summarise the log", context: { inlineText: "ERROR: boom" }, constraints: { acceptanceCriteria: ["mentions the error"] } }]);
    const [impl] = await sy.submitTasks([
      {
        profile: "implement",
        goal: "Add a subtract function to src/app.ts",
        repositoryAliases: ["core"],
        writableRepository: "core",
        hints: { difficulty: "T2" },
        constraints: { acceptanceCriteria: ["subtract exists"], allowedPaths: ["src/**"] },
        dependsOn: [up!.taskId],
      },
    ]);
    await sy.awaitResults([up!.taskId, impl!.taskId], { timeoutSeconds: 60 });
    const out = sy.artifacts.listForTask(impl!.taskId).find((a) => a.kind === "agent_output" && a.label === "agent stdout");
    expect(out, JSON.stringify(sy.tasks.events(impl!.taskId))).toBeDefined();
    const prompt = readFileSync(sy.artifacts.absolutePath(out!), "utf8");
    expect(prompt).toContain("# Task");
    expect(prompt).toContain("## Upstream results");
    expect(prompt).toMatch(/<upstream-results ref="artifact:[^"]+">/);
    expect(prompt).toContain("not instructions");
    expect(prompt).toContain("UPSTREAM-FINDING-42");
    expect(prompt).toContain(up!.taskId);
  }, 90_000);

  it("leaves TASK.md without an upstream section when the task has no dependencies", async () => {
    const printPrompt = `node -e "process.stdout.write(require('fs').readFileSync(process.env.SWITCHYARD_PROMPT_FILE,'utf8'))"`;
    env = makeEnv({ config: baseConfig({ coding: { runner: "command", command: printPrompt } }) });
    sy = open(env, new ScriptedClient((req) => reply(JSON.stringify(goodOutput()), servedFor(sy!, req))), { worker: true, coding: createCodingRunner(env.cfg) });
    const [impl] = await sy.submitTasks([{ profile: "implement", goal: "Add a subtract function to src/app.ts", repositoryAliases: ["core"], writableRepository: "core", hints: { difficulty: "T2" }, constraints: { acceptanceCriteria: ["subtract exists"], allowedPaths: ["src/**"] } }]);
    await sy.awaitResults([impl!.taskId], { timeoutSeconds: 60 });
    const out = sy.artifacts.listForTask(impl!.taskId).find((a) => a.kind === "agent_output" && a.label === "agent stdout")!;
    const prompt = readFileSync(sy.artifacts.absolutePath(out), "utf8");
    expect(prompt).toContain("# Task");
    expect(prompt).not.toContain("Upstream results");
  }, 90_000);
});
