import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { openDatabase, type Db } from "../src/storage/db.js";
import { ProjectRegistry } from "../src/projects/registry.js";
import { LabManager } from "../src/labs/lab.js";
import { stopOwnedProcess } from "../src/labs/process-ownership.js";
import { TaskStore } from "../src/storage/tasks.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { withRepositoryMutation } from "../src/workspaces/repository-mutation.js";
import { baseConfig, makeEnv, type Env } from "./helpers.js";

let env: Env | undefined, db: Db | undefined, manager: LabManager | undefined;
afterEach(async () => {
  for (const lab of manager?.store.list() ?? []) for (const service of manager!.store.services(lab.id))
    if (service.pid && service.token) await stopOwnedProcess(service.pid, service.token).catch(() => undefined);
  await manager?.close().catch(() => undefined);
  manager = undefined; db?.close(); db = undefined; env?.cleanup(); env = undefined;
}, 60_000);

const NODE = JSON.stringify(process.execPath);
const SERVER = "require('node:http').createServer((_q,r)=>r.end('ok')).listen(Number(process.env.PORT),'127.0.0.1');";
function setup(): LabManager {
  const cfg: Record<string, unknown> = baseConfig();
  cfg.repositories = {};
  cfg.brain = { path: ".brain", project: "alpha" };
  cfg.labs = { port_range: [57100, 57300], max_active: 2, max_services: 3, service_ready_timeout_seconds: 20 };
  cfg.projects = { alpha: { repositories: { app: { path: "repo" } }, lab: { ports: ["web"], env: { PORT: "{port.web}" },
    services: { web: { repo: "app", command: `${NODE} server.cjs`, ready: { http: "http://127.0.0.1:{port.web}/" } } },
    checks: { slow: { repo: "app", command: `${NODE} -e "setTimeout(()=>{},4000)"` } } } } };
  env = makeEnv({ config: cfg, files: { "server.cjs": SERVER } });
  env.cfg.profiles.supervise = { ...env.cfg.profiles.implement!, mode: "supervisor", tools: "supervisor" };
  db = openDatabase(env.cfg.storageDir);
  const registry = new ProjectRegistry(env.cfg);
  manager = new LabManager({ db, storageDir: env.cfg.storageDir, cfg: env.cfg, project: slug => {
    const ctx = registry.context(slug);
    if (!ctx) throw new Error("unknown project");
    return ctx;
  }, monitor: false });
  return manager;
}
const activeCommands = (worktree: string) => {
  const dir = path.join(execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: worktree, encoding: "utf8" }).trim(), "meritrouter-commands", "active");
  return existsSync(dir) ? readdirSync(dir).length : 0;
};

it("admits the Lab root job past exactly its Lab's own live services and nothing else", async () => {
  const labs = setup();
  const created = await labs.create("alpha", "team");
  await labs.start("alpha", "team");
  const worktree = created.lab.repositories[0]!.worktree;
  // The running service's command fences every ordinary mutation of the Lab worktree.
  await expect(withRepositoryMutation([worktree], async () => "admitted")).rejects.toMatchObject({ detail: { kind: "active_command" } });

  const tasks = new TaskStore(db!);
  const root = WorkerTaskSchema.parse({ id: "lab-root", profile: "supervise", lab: "team", goal: "integrate", repositoryAliases: ["app"], constraints: { acceptanceCriteria: ["done"] } });
  const child = WorkerTaskSchema.parse({ ...root, id: "lab-child", profile: "implement", parentTaskId: "lab-root" });
  tasks.submit([root], { project: "alpha" });
  tasks.submit([child], { project: "alpha" });
  const rootBinding = labs.bindTask("alpha", "lab-root", root, tasks)!, childBinding = labs.bindTask("alpha", "lab-child", child, tasks)!;

  const permits = await rootBinding.integrationPermits("lab-root", ["app"]);
  expect(permits).toHaveLength(1);
  await expect(withRepositoryMutation([worktree], async () => "admitted", { command: permits })).resolves.toBe("admitted");
  // Only the root job, and only for the Lab's own repositories.
  await expect(childBinding.integrationPermits("lab-child", ["app"])).rejects.toThrow(/root job/);
  await expect(rootBinding.integrationPermits("lab-child", ["app"])).rejects.toThrow(/root job/);
  expect(await rootBinding.integrationPermits("lab-root", ["other"])).toEqual([]);

  // Any other active command in the worktree (here the Lab's own transient check) still refuses it.
  const check = labs.check("alpha", "team", "slow");
  const until = Date.now() + 20_000;
  while (activeCommands(worktree) < 2 && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 25));
  expect(activeCommands(worktree)).toBe(2);
  const during = await rootBinding.integrationPermits("lab-root", ["app"]);
  await expect(withRepositoryMutation([worktree], async () => "admitted", { command: during })).rejects.toMatchObject({ detail: { kind: "active_command" } });
  expect((await check).exitCode).toBe(0);

  // Once the Lab stops, it issues no permit and the worktree is ordinary again.
  await labs.stop("alpha", "team");
  expect(await rootBinding.integrationPermits("lab-root", ["app"])).toEqual([]);
  await expect(withRepositoryMutation([worktree], async () => "admitted")).resolves.toBe("admitted");
}, 120_000);

it("restarts a stopped Lab service with a new process identity", async () => {
  const labs = setup();
  await labs.create("alpha", "svc");
  const first = (await labs.start("alpha", "svc")).services[0]!;
  const restarted = (await labs.restart("alpha", "svc", "web")).services[0]!;
  expect(restarted.state).toBe("running");
  expect(restarted.pid).not.toBe(first.pid);
  expect(restarted.token).not.toBe(first.token);
  const proof = path.join(labs.status("alpha", "svc").lab.root, "logs", "web.process-tree.json");
  // On Windows the process-tree proof now belongs to the new identity (the retired one was settled).
  if (process.platform === "win32") expect(JSON.parse(readFileSync(proof, "utf8"))).toMatchObject({ pid: restarted.pid, token: restarted.token });
  await labs.stop("alpha", "svc");
  if (process.platform === "win32") expect(existsSync(proof)).toBe(false);
}, 120_000);
