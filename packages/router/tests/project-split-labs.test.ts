import { afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MeritRouter } from "../src/core/service.js";
import type { RunContext } from "../src/runners/types.js";
import { createCodingRunner } from "../src/runners/coding/index.js";
import { taskLabAuthority, taskLabEvidenceProblem } from "../src/runners/coding/task-lab.js";
import { WorkerActionRequests } from "../src/harness/worker-actions.js";
import { LabSupervisorLease } from "../src/operations/lab-supervisor.js";
import { baseConfig, goodOutput, makeEnv, open, reply, ScriptedClient, servedFor, type Env } from "./helpers.js";

// Task Lab execution is gated on the run's own live supervisor authority (task-lab.ts). No
// executor-run worker profile holds it today, so the positive case grants it to exactly one task
// to exercise the split wiring end to end; every other caller keeps the real check.
const granted = vi.hoisted(() => new Set<string>());
vi.mock("../src/core/supervisor-authority.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/core/supervisor-authority.js")>();
  return { ...actual, currentSupervisorAuthority: (...args: Parameters<typeof actual.currentSupervisorAuthority>) => granted.has(args[2].taskId) || actual.currentSupervisorAuthority(...args) };
});

let env: Env | undefined, sy: MeritRouter | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await sy?.close();
  sy = undefined; env?.cleanup(); env = undefined; granted.clear();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 60_000);

const NODE = JSON.stringify(process.execPath);
const source = "export function add(a: number, b: number) { return a + b; }\n";
const subtract = source + "export function subtract(a: number, b: number) { return a - b; }\n";
const HEALTH = `${NODE} -e "process.exit(require('fs').readFileSync('src/app.ts','utf8').includes('subtract')?0:1)"`;
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, stdio: "pipe" }).toString();
const call = (name: string, args: unknown) => [{ id: name, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }];
const inside = (child: string, parent: string) => { const rel = path.relative(parent, child); return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel); };

/** A split installation with project `alpha` in its own directory, its task Lab check allowed. */
async function fixture() {
  const repo = realpathSync(mkdtempSync(path.join(tmpdir(), "meritrouter-test-project-")));
  dirs.push(repo);
  mkdirSync(path.join(repo, "src"));
  writeFileSync(path.join(repo, "src", "app.ts"), source);
  git(repo, "init", "-q", "-b", "main"); git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "init");
  env = makeEnv({ config: baseConfig({
    storage: { directory: ".meritrouter", layout: "split" }, repositories: {}, brain: { path: "brain", project: "alpha" },
    security: { outside_repository: "supervisor" }, coding: { runner: "native" }, execution: { max_concurrent_tasks: 1, lease_seconds: 30 },
    labs: { port_range: [58900, 59100], max_active: 2, check_timeout_seconds: 20, keep_task_worktrees_days: 0 },
    projects: { alpha: { directory: repo, repositories: { app: { path: repo } }, labs: { ephemeral: { enabled: true, checks: ["health"] } }, lab: { checks: { health: HEALTH } } } },
  }) });
  const client = new ScriptedClient(req => reply(null, {
    ...servedFor(sy!, req), toolCalls: req.messages.some(message => message.role === "tool")
      ? call("submit_result", goodOutput(1, "app:src/app.ts#L1-L2"))
      : call("write_file", { path: "src/app.ts", content: subtract }),
  }));
  const native = createCodingRunner(env.cfg), contexts: RunContext[] = [];
  sy = open(env, client, { worker: true, coding: { run: ctx => { contexts.push(ctx); return native.run(ctx); } } });
  expect(sy.layout).toBe("split");
  const created = await sy.createSplitProject({ slug: "alpha", directory: repo });
  return { repo, created, contexts };
}
async function submit(): Promise<string> {
  const [task] = await sy!.submitTasks([{
    profile: "implement", goal: "Add subtract to src/app.ts", repositoryAliases: ["app"], writableRepository: "app", hints: { difficulty: "T2" },
    constraints: { acceptanceCriteria: ["subtract exists"], allowedPaths: ["src/**"], labChecks: ["health"] },
  }], { project: "alpha" });
  return task!.taskId;
}
const count = (db: { prepare(sql: string): { get(): unknown } }, sql: string) => (db.prepare(sql).get() as { n: number }).n;

it("runs a worker run's task Lab check in the split project's own Lab manager and accepts its evidence", async () => {
  const { repo, created, contexts } = await fixture();
  const labs = sy!.labsFor("alpha");
  const id = await submit();
  granted.add(id);
  const outcome = await sy!.awaitResults([id], { timeoutSeconds: 90, project: "alpha" });
  expect(outcome.pending, JSON.stringify(sy!.projectStores("alpha").tasks.events(id, 100))).toHaveLength(0);
  const result = outcome.completed[0]!;

  // The run was given the project's own manager and its in-process supervision, not the installation's.
  expect(contexts[0]!.taskLabs).toBe(labs);
  expect(contexts[0]!.taskLabs).not.toBe(sy!.labs);
  expect(new LabSupervisorLease(sy!.db, sy!.cfg.configPath).read()).toBeNull();

  // The check passed on the submitted commit and the ephemeral Lab was durably stopped.
  expect(result.taskLab, JSON.stringify(result.findings)).toMatchObject({ status: "passed", cleanup: "complete" });
  expect(result.taskLab!.checks.map(check => [check.name, check.exitCode])).toEqual([["health", 0]]);
  // The mandatory Lab gate passed in verification (it reads the project's own manager); the claimed
  // criterion alone keeps the result not_verified, as for any task without independent checks.
  expect(result.verificationStatus).toBe("passed");
  expect(result.verification!.checks.find(check => check.name === "ephemeral_lab_checks")).toMatchObject({ required: true, outcome: "passed" });
  expect(result.acceptanceStatus).toBe("not_verified");
  const lab = labs.store.byId(result.taskLab!.labId)!;
  expect(lab).toMatchObject({ kind: "task_attempt", state: "stopped", project: "alpha" });
  expect(inside(lab.root, path.join(created.paths.root, "labs"))).toBe(true);
  expect(inside(lab.root, env!.cfg.storageDir)).toBe(false);
  const local = sy!.projectStores("alpha").db;
  expect(count(local, "SELECT COUNT(*) n FROM lab_services WHERE state!='stopped' OR pid IS NOT NULL")).toBe(0);
  expect(count(local, "SELECT COUNT(*) n FROM lab_attempt_processes WHERE state!='stopped'")).toBe(0);
  expect(count(local, "SELECT COUNT(*) n FROM lab_ports")).toBe(0);
  for (const table of ["labs", "lab_task_attempts", "task_lab_operations", "tasks"]) expect(count(sy!.db, `SELECT COUNT(*) n FROM ${table}`), table).toBe(0);

  // The evidence is accepted against the project's trusted current state, and the source stays untouched.
  const task = sy!.projectStores("alpha").tasks.get(id)!;
  expect(taskLabEvidenceProblem(task.spec, result.taskLab, taskLabAuthority(labs, id, result.taskLab))).toBeNull();
  sy!.acceptTask(id, { by: { kind: "human", id: "fixture" }, reason: "Lab check passed" }, "alpha");
  expect(readFileSync(path.join(repo, "src", "app.ts"), "utf8")).toBe(source);
  expect(git(repo, "status", "--porcelain")).toBe("");
}, 120_000);

it("keeps a plain worker run's Lab request pending in a split project without starting a Lab", async () => {
  const { created } = await fixture();
  const labs = sy!.labsFor("alpha");
  const id = await submit();
  const store = sy!.projectStores("alpha"), actions = new WorkerActionRequests(store.db);
  const until = Date.now() + 30_000;
  let action = actions.list({ project: "alpha", taskId: id, status: "pending" })[0];
  while (!action && Date.now() < until) {
    expect(["queued", "running"]).toContain(store.tasks.get(id)!.row.state);
    await new Promise(resolve => setTimeout(resolve, 50));
    action = actions.list({ project: "alpha", taskId: id, status: "pending" })[0];
  }
  expect(action?.action.operation).toMatchObject({ name: "lab_check", args: { taskId: id, checks: ["health"] } });
  expect(labs.taskAttempts.store.all()).toHaveLength(0);
  expect(labs.store.list()).toHaveLength(0);
  expect(existsSync(path.join(created.paths.root, "labs"))).toBe(false);
  await sy!.cancelTasksAsync([id], "alpha");
  expect((await sy!.awaitResults([id], { timeoutSeconds: 30, project: "alpha" })).completed[0]!.executionStatus).toBe("cancelled");
}, 60_000);
