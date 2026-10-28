import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openDatabase, type Db } from "../src/storage/db.js";
import { ProjectRegistry } from "../src/projects/registry.js";
import { LabManager } from "../src/labs/lab.js";
import { stopOwnedProcess } from "../src/labs/process-ownership.js";
import { TaskStore } from "../src/storage/tasks.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { withRepositoryMutation } from "../src/workspaces/repository-mutation.js";
import { MergeQueue, type MergeHooks } from "../src/workspaces/merge-queue.js";
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

it("bases a team child on the configured checkout and lets only the root's merge queue admit past the Lab's service", async () => {
  const labs = setup();
  const created = await labs.create("alpha", "team");
  await labs.start("alpha", "team");
  const lab = created.lab.repositories[0]!, worktree = lab.worktree;
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd, encoding: "utf8", windowsHide: true }).trim();
  const tasks = new TaskStore(db!);
  const root = WorkerTaskSchema.parse({ id: "lab-root", profile: "supervise", lab: "team", goal: "integrate", repositoryAliases: ["app"], constraints: { acceptanceCriteria: ["done"] } });
  const child = WorkerTaskSchema.parse({ ...root, id: "lab-child", profile: "implement", parentTaskId: "lab-root" });
  tasks.submit([root], { project: "alpha" });
  tasks.submit([child], { project: "alpha" });
  const rootBinding = labs.bindTask("alpha", "lab-root", root, tasks)!, childBinding = labs.bindTask("alpha", "lab-child", child, tasks)!;

  // A team child's source is the configured checkout pinned to the Lab branch head, so its own
  // workspace admissions never meet the Lab worktree's live service. The root has no team source.
  const team = await childBinding.teamSource("lab-child", "app");
  expect(realpathSync(team.sourcePath)).toBe(realpathSync(env!.repo));
  expect(team.head).toBe(git(worktree, "rev-parse", "HEAD"));
  await expect(rootBinding.teamSource("lab-root", "app")).rejects.toThrow(/root job/);
  await expect(childBinding.teamSource("lab-child", "other")).rejects.toThrow(/outside this lab/);
  await expect(withRepositoryMutation([team.sourcePath], async () => "admitted")).resolves.toBe("admitted");

  // The child's work: a clean commit and a conflicting one, in a worktree of the configured checkout.
  const source = path.join(env!.dir, "child-source");
  git(team.sourcePath, "worktree", "add", "--detach", source, team.head);
  writeFileSync(path.join(source, "feature.txt"), "feature\n"); git(source, "add", "."); git(source, "commit", "-qm", "feature");
  const clean = git(source, "rev-parse", "HEAD");
  writeFileSync(path.join(source, "server.cjs"), "// child edit\n"); git(source, "add", "."); git(source, "commit", "-qm", "conflicting");
  const conflicting = git(source, "rev-parse", "HEAD");
  const queue = new MergeQueue(db!, tasks, "fixture-owner");
  const base: Omit<MergeHooks, "admission"> = { committer: { name: "Fixture", email: "fixture@example.invalid" }, integrated: () => undefined, allowRebase: () => false };
  const rootAdmission: MergeHooks["admission"] = item => rootBinding.integrationPermits(item.jobId, [item.repo]);
  const enqueue = (taskId: string, sourceBase: string, head: string) => queue.enqueue({ jobId: "lab-root", taskId, kind: "task", repo: "app", branch: lab.branch, integrationWorktree: worktree, sourceWorktree: source, sourceBase, sourceHead: head, commits: [head], acceptance: null });

  // Without the root's permits the fence refuses the integration into the Lab worktree.
  const refused = enqueue("lab-child", team.head, clean);
  await expect(queue.run(refused.id, base)).rejects.toMatchObject({ detail: { kind: "active_command" } });
  expect(queue.get(refused.id)!.state).toBe("queued");
  // With them, the clean commit integrates onto the Lab branch.
  const integrated = await queue.run(refused.id, { ...base, admission: rootAdmission });
  expect(integrated.state).toBe("integrated");
  expect(git(worktree, "rev-parse", "HEAD")).toBe(integrated.afterHead);
  expect(readFileSync(path.join(worktree, "feature.txt"), "utf8")).toMatch(/^feature\r?\n$/);

  // A conflicting pick is aborted and restored under the same permits (its nested sequencer abort
  // admits only the Lab worktree), and the item ends in conflict with the Lab branch unchanged.
  writeFileSync(path.join(worktree, "server.cjs"), readFileSync(path.join(worktree, "server.cjs"), "utf8") + "// lab edit\n");
  await withRepositoryMutation([worktree], async () => { git(worktree, "add", "."); git(worktree, "commit", "-qm", "lab edit"); }, { command: await rootBinding.integrationPermits("lab-root", ["app"]) });
  const labHead = git(worktree, "rev-parse", "HEAD");
  tasks.submit([WorkerTaskSchema.parse({ ...child, id: "lab-child-2" })], { project: "alpha" });
  const second = enqueue("lab-child-2", clean, conflicting);
  const conflicted = await queue.run(second.id, { ...base, admission: rootAdmission });
  expect(conflicted.state).toBe("conflict");
  expect(git(worktree, "rev-parse", "HEAD")).toBe(labHead);
  expect(git(worktree, "status", "--porcelain")).toBe("");

  await labs.stop("alpha", "team");
}, 180_000);
