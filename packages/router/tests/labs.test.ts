import { redactLabText } from "../src/labs/public-status.js";
import { ProjectConfigSchema } from "../src/projects/schema.js";
import { PaidModelSchema } from "../src/config/schema.js";
import { Worktrees } from "../src/workspaces/worktree.js";
import { TaskStore } from "../src/storage/tasks.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { spawn, execFile } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { openDatabase, type Db } from "../src/storage/db.js";
import { ProjectRegistry } from "../src/projects/registry.js";
import { LabManager } from "../src/labs/lab.js";
import { LabRecipeSchema, LabsConfigSchema, validateRecipe } from "../src/labs/recipe.js";
import { captureOwnedProcessTree, HOST_MARKER, ownedWindowsProcessTree, processAlive, processOwnership, stopOwnedProcess } from "../src/labs/process-ownership.js";
import { portAvailable } from "../src/labs/ports.js";
import { baseConfig, commitAll, makeEnv, type Env } from "./helpers.js";
const exec = promisify(execFile);
let env: Env | undefined;
let db: Db | undefined;
const managers: LabManager[] = [];
// Teardown order matters for Windows Labs. Each manager stops its own services first, which
// retires their native Jobs (the detached job.exe helper exits only on that release). Only what
// a manager could not stop is then killed directly as a safety net. The hook takes this test's
// state into locals, so a slow teardown never touches the next test's, and it is given far more
// than vitest's 10 s default: a verified stop is several PowerShell round trips per service.
afterEach(async () => {
  const owned = managers.splice(0).reverse(), store = db, fixture = env;
  db = undefined;
  env = undefined;
  for (const m of owned) {
    try {
      await m.close();
    }
    catch {
    }
  }
  if (store) {
    for (const m of owned) {
      for (const lab of m.store.list()) {
        for (const service of m.store.services(lab.id)) {
          if (service.pid && service.token)
            await stopOwnedProcess(service.pid, service.token).catch(() => undefined);
        }
      }
    }
  }
  store?.close();
  fixture?.cleanup();
}, 120_000);
const NODE = JSON.stringify(process.execPath);
const SERVER = `const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const data=process.env.DATA_DIR;fs.mkdirSync(data,{recursive:true});fs.writeFileSync(path.join(data,'identity'),process.env.LAB_NAME);let child=null;
http.createServer((req,res)=>{if(req.url==='/crash'){res.end('bye');setTimeout(()=>process.exit(7),30);return;}if(req.url==='/child'){child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});res.end(String(child.pid));return;}res.setHeader('content-type','application/json');res.end(JSON.stringify({lab:process.env.LAB_NAME,data,pid:process.pid}));}).listen(Number(process.env.PORT),process.env.HOST||'127.0.0.1',()=>console.log('fixture-ready '+process.env.LAB_NAME));`;
function setup(over: Record<string, unknown> = {}) {
  const cfg: Record<string, unknown> = baseConfig();
  cfg.repositories = {};
  cfg.brain = { path: '.brain', project: 'alpha' };
  cfg.labs = { port_range: [55000, 55500], max_active: 2, max_services: 3, idle_stop_minutes: 30, service_ready_timeout_seconds: 10, restart_backoff_ms: 20, ...over };
  cfg.projects = { alpha: { repositories: { app: { path: 'repo' } }, lab: { ports: ['web'], data: ['db'], env: { PORT: '{port.web}', DATA_DIR: '{lab.data.db}' }, setup: [`${NODE} -e "require('node:fs').writeFileSync(process.env.DATA_DIR+'/setup','ok')"`], services: { web: { repo: 'app', command: `${NODE} server.cjs`, ready: { http: 'http://127.0.0.1:{port.web}/' } } }, checks: { health: { repo: 'app', command: `${NODE} check.cjs` } } } }, beta: { repositories: { app: { path: 'repo' } } } };
  env = makeEnv({ config: cfg, files: { 'server.cjs': SERVER, 'check.cjs': "fetch('http://127.0.0.1:'+process.env.PORT).then(r=>{if(!r.ok)process.exit(1);console.log('healthy')}).catch(()=>process.exit(1));" } });
  db = openDatabase(env.cfg.storageDir);
  const registry = new ProjectRegistry(env.cfg);
  const manager = new LabManager({ db, storageDir: env.cfg.storageDir, cfg: env.cfg, project: (s) => {
      const c = registry.context(s);
      if (!c)
        throw new Error('unknown project');
      return c;
    }, monitor: false });
  managers.push(manager);
  return manager;
}
async function waitFor(fn: () => boolean | Promise<boolean>, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn())
      return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('fixture condition timed out');
}
describe('lab recipes', () => {
  it("keeps cache-write pricing optional and rejects negative prices", () => {
    const paid = { provider: "fake", model: "fixture", context_limit_tokens: 100, output_limit_tokens: 50 };
    expect(PaidModelSchema.parse(paid).cache_write_input_usd_per_million).toBeUndefined();
    expect(PaidModelSchema.parse({ ...paid, cache_write_input_usd_per_million: 0 }).cache_write_input_usd_per_million).toBe(0);
    expect(() => PaidModelSchema.parse({ ...paid, cache_write_input_usd_per_million: -1 })).toThrow();
  });
  it('validates references, cycles, placeholders and allocated loopback readiness', () => {
    expect(() => LabRecipeSchema.parse({ ports: ['a', 'a'] })).toThrow(/unique/);
    expect(() => LabRecipeSchema.parse({ services: { a: { repo: 'app', command: 'node x', after: ['b'] }, b: { repo: 'app', command: 'node x', after: ['a'] } } })).toThrow(/cycle/);
    expect(() => LabRecipeSchema.parse({ services: { a: { repo: 'app', command: 'node x', ready: { http: 'http://169.254.169.254/' } } } })).toThrow(/127/);
    expect(() => LabRecipeSchema.parse({ env: { P: '{port.undeclared}' } })).toThrow(/unknown placeholder/);
    expect(() => validateRecipe({ services: { a: { repo: 'outside', command: 'node x' } } }, ['app'])).toThrow(/unknown repository/);
    expect(() => LabsConfigSchema.parse({ port_range: [5999, 5100] })).toThrow(/ascend/);
  });
});
describe('lab lifecycle with real isolated fixture processes', () => {
  it("refreshes from the target without writing it and refuses dirty revision checks", async () => {
    const manager = setup();
    const created = await manager.create("alpha", "refresh");
    const original = manager.status("alpha", "refresh").heads.app;
    writeFileSync(path.join(env!.repo, "target.txt"), "target changes");
    commitAll(env!.repo);
    const target = execFileSync("git", ["rev-parse", "HEAD"], { cwd: env!.repo, encoding: "utf8" }).trim();
    expect(target).not.toBe(original);
    const updated = await manager.refresh("alpha", "refresh");
    expect(updated.heads.app).toBe(target);
    expect(updated.lab.repositories[0]!.base).toBe(target);
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: env!.repo, encoding: "utf8" }).trim()).toBe(target);
    writeFileSync(path.join(created.lab.repositories[0]!.worktree, "dirty.txt"), "not committed");
    await expect(manager.check("alpha", "refresh", "health")).rejects.toThrow(/commit lab changes/);
    commitAll(created.lab.repositories[0]!.worktree);
    await manager.destroy("alpha", "refresh");
  });
  it("serializes starts and cancels an in-flight service when the owner closes", async () => {
    const manager = setup();
    const lab = await manager.create("alpha", "cancelled-start");
    const starting = manager.start("alpha", "cancelled-start");
    const rejected = expect(starting).rejects.toThrow();
    await expect(manager.start("alpha", "cancelled-start")).rejects.toThrow(/in progress/);
    await manager.close();
    await rejected;
    expect(manager.status("alpha", "cancelled-start").services.every(s => s.pid === null)).toBe(true);
    expect(await portAvailable(lab.lab.ports.web!)).toBe(true);
  }, 30000);
  it("retains dirty or active worktrees and prunes only old registered terminal attempts", async () => {
    const manager = setup();
    env!.cfg.labs.keep_task_worktrees_days = 0;
    manager.services.config.keep_task_worktrees_days = 0;
    const tasks = new TaskStore(db!);
    tasks.submit([WorkerTaskSchema.parse({ id: "retained", profile: "inspect", goal: "old task", repositoryAliases: ["app"], constraints: { acceptanceCriteria: ["done"] } })], { project: "alpha" });
    const tree = new Worktrees(db!, path.join(env!.cfg.storageDir, "worktrees"));
    const workspace = await tree.prepare({ taskId: "retained", run: 1, alias: "app", sourcePath: env!.repo });
    expect((await manager.pruneTaskWorktrees()).removed).toEqual([]);
    db!.prepare("UPDATE tasks SET state='completed',finished_at=0 WHERE id='retained'").run();
    writeFileSync(path.join(workspace.worktreePath, "keep.txt"), "uncommitted");
    expect((await manager.pruneTaskWorktrees()).skipped).toHaveLength(1);
    expect(existsSync(workspace.worktreePath)).toBe(true);
    commitAll(workspace.worktreePath);
    expect((await manager.pruneTaskWorktrees()).removed).toEqual([workspace.worktreePath]);
    expect(existsSync(workspace.worktreePath)).toBe(false);
  });
  it('runs two isolated labs, persists checks, adopts across an owner process, restarts crashes and preserves branches on destroy', async () => {
    const first = setup({ max_restarts: 1 });
    const one = await first.create('alpha', 'one');
    const two = await first.create('alpha', 'two');
    expect(one.lab.ports.web).not.toBe(two.lab.ports.web);
    expect(one.lab.repositories[0]!.worktree).not.toBe(two.lab.repositories[0]!.worktree);
    await expect(first.create('alpha', 'three')).rejects.toThrow(/limit/);
    await expect(first.start('beta', 'one')).rejects.toThrow(/unknown lab/);
    await first.start('alpha', 'one');
    await first.start('alpha', 'two');
    const a = await (await fetch(first.status('alpha', 'one').urls.web!)).json() as {
      lab: string;
      data: string;
    };
    const b = await (await fetch(first.status('alpha', 'two').urls.web!)).json() as {
      lab: string;
      data: string;
    };
    expect(a.lab).toBe('one');
    expect(b.lab).toBe('two');
    expect(a.data).not.toBe(b.data);
    expect(readFileSync(path.join(a.data, 'identity'), 'utf8')).toBe('one');
    expect(readFileSync(path.join(b.data, 'setup'), 'utf8')).toBe('ok');
    const check = await first.check('alpha', 'one', 'health');
    expect(check.exitCode).toBe(0);
    expect(check.stdout).toContain('healthy');
    expect(first.status('alpha', 'one').checks[0]!.revision).toBe(check.revision);
    await expect(first.check('alpha', 'one', 'undeclared')).rejects.toThrow(/unknown declared/);
    const pid = first.status('alpha', 'one').services[0]!.pid!;
    await first.close({ stopServices: false });
    // This second OS process opens the same SQLite store and verifies the wrapper token before adoption.
    const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
    const moduleURL = (file: string) => pathToFileURL(path.join(dist, file)).href;
    const script = `import{loadConfig}from ${JSON.stringify(moduleURL('config/load.js'))};import{openDatabase}from ${JSON.stringify(moduleURL('storage/db.js'))};import{ProjectRegistry}from ${JSON.stringify(moduleURL('projects/registry.js'))};import{LabManager}from ${JSON.stringify(moduleURL('labs/lab.js'))};const cfg=loadConfig(process.argv[1]);const db=openDatabase(cfg.storageDir);const registry=new ProjectRegistry(cfg);const m=new LabManager({db,storageDir:cfg.storageDir,cfg,project:s=>registry.context(s),monitor:false});await m.recover();console.log(JSON.stringify(m.status('alpha','one').services.map(s=>({pid:s.pid,owner:s.owner_id}))));await m.close({stopServices:false});db.close();`;
    const adoption = await exec(process.execPath, ['--input-type=module', '-e', script, env!.cfg.configPath], { timeout: 30000, windowsHide: true });
    const adopted = JSON.parse(adoption.stdout.trim()) as Array<{
      pid: number;
      owner: string;
    }>;
    expect(adopted[0]!.pid).toBe(pid);
    expect(adopted[0]!.owner).not.toBe(first.owner);
    const second = new LabManager({ ...first.options, monitor: false });
    managers.push(second);
    await second.recover();
    expect(second.status('alpha', 'one').services[0]!.pid).toBe(pid);
    await fetch(second.status('alpha', 'one').urls.web!.replace(/\/$/, '') + '/crash');
    await waitFor(() => !processAlive(pid));
    await second.tick();
    await new Promise(r => setTimeout(r, 40));
    await second.tick();
    const restarted = second.status('alpha', 'one').services[0]!;
    expect(restarted.state).toBe('running');
    expect(restarted.pid).not.toBe(pid);
    expect(restarted.restart_count).toBe(1);
    expect(second.logs('alpha', 'one', 'web')).toContain('fixture-ready one');
    const restartedPid = restarted.pid!;
    await fetch(second.status("alpha", "one").urls.web!.replace(/\/$/, "") + "/crash");
    await waitFor(() => !processAlive(restartedPid));
    await second.tick();
    expect(second.status("alpha", "one").services[0]!.state).toBe("failed");
    await second.restart("alpha", "one", "web");
    const child = Number(await (await fetch(second.status('alpha', 'one').urls.web!.replace(/\/$/, '') + '/child')).text());
    expect(processAlive(child)).toBe(true);
    const branch = one.lab.repositories[0]!.branch;
    await second.destroy('alpha', 'one');
    await waitFor(() => !processAlive(child));
    expect(existsSync(one.lab.root)).toBe(false);
    expect(await portAvailable(one.lab.ports.web!)).toBe(true);
    expect(execFileSync('git', ['show-ref', '--verify', `refs/heads/${branch}`], { cwd: env!.repo, encoding: 'utf8' })).toContain(branch);
    expect(second.list('alpha')).toHaveLength(1);
    await second.stop('alpha', 'two');
    expect(await portAvailable(two.lab.ports.web!)).toBe(true);
  }, 90000);
  it('stops idle services and never adopts or kills a foreign recorded PID', async () => {
    const manager = setup({ idle_stop_minutes: 0.001 });
    const lab = await manager.create('alpha', 'idle');
    await manager.start('alpha', 'idle');
    // A natively bound service whose recorded PID is replaced by a live foreign PID: the kernel Job
    // identity, not the DB row, decides what may be stopped. The foreign process and the real
    // service both survive, and the row keeps its evidence.
    const bound = manager.store.service(lab.lab.id, 'web')!;
    expect(bound.pid && bound.token && await processOwnership(bound.pid, bound.token)).toBe('owned');
    db!.prepare("UPDATE lab_services SET pid=? WHERE lab_id=? AND name='web'").run(process.pid, lab.lab.id);
    await expect(manager.stop('alpha', 'idle')).rejects.toMatchObject({ detail: { kind: 'ownership_changed' }, message: expect.stringMatching(/kernel Job identity/) });
    expect(processAlive(process.pid)).toBe(true);
    expect(await processOwnership(bound.pid!, bound.token!)).toBe('owned');
    expect(manager.store.service(lab.lab.id, 'web')).toMatchObject({ pid: process.pid, token: bound.token });
    db!.prepare("UPDATE lab_services SET pid=? WHERE lab_id=? AND name='web'").run(bound.pid, lab.lab.id);
    db!.prepare('UPDATE labs SET last_activity=0 WHERE id=?').run(lab.lab.id);
    await manager.tick();
    expect(manager.status('alpha', 'idle').lab.state).toBe('stopped');
    expect(await portAvailable(lab.lab.ports.web!)).toBe(true);
    expect(await processOwnership(bound.pid!, bound.token!)).toBe('missing');
    // A recorded identity with no durable native command owner (a legacy or forged row) is never
    // adopted, killed or cleared by inference: it fails closed until migration/recovery. This is
    // the contract since 5cb43f9 replaced command-line ownership with native Job proof.
    db!.prepare("UPDATE lab_services SET pid=?,token=?,state='running',owner_until=0 WHERE lab_id=?").run(process.pid, 'a'.repeat(48), lab.lab.id);
    expect(await processOwnership(process.pid, 'a'.repeat(48))).toBe('foreign');
    await expect(manager.stop('alpha', 'idle')).rejects.toMatchObject({ detail: { kind: 'command_uncertain' }, message: expect.stringMatching(/no durable repository command owner/) });
    expect(processAlive(process.pid)).toBe(true);
    expect(manager.store.service(lab.lab.id, 'web')).toMatchObject({ pid: process.pid, token: 'a'.repeat(48), state: 'running' });
    db!.prepare("UPDATE lab_services SET pid=NULL,token=NULL,state='stopped' WHERE lab_id=?").run(lab.lab.id);
    await manager.destroy('alpha', 'idle');
  }, 90000);
  it('refuses public listeners and preserves uncommitted work during destroy', async () => {
    const manager = setup();
    const raw = env!.cfg.projects.alpha as {
      lab: {
        env: Record<string, string>;
      };
    };
    raw.lab.env.HOST = '0.0.0.0';
    const bad = await manager.create('alpha', 'public');
    await expect(manager.start('alpha', 'public')).rejects.toThrow(/forbidden listener/);
    expect(await portAvailable(bad.lab.ports.web!)).toBe(true);
    const clean = await manager.create('alpha', 'dirty');
    writeFileSync(path.join(clean.lab.repositories[0]!.worktree, 'new.txt'), 'uncommitted');
    await expect(manager.destroy('alpha', 'dirty')).rejects.toThrow(/uncommitted/);
    expect(existsSync(path.join(clean.lab.repositories[0]!.worktree, 'new.txt'))).toBe(true);
    commitAll(clean.lab.repositories[0]!.worktree);
    await manager.destroy('alpha', 'dirty');
    await manager.destroy('alpha', 'public');
  }, 30000);
});
describe("lab integration and promotion", () => {
  it("queues creation without an API instance taking service ownership, then runs declared check on exact head", async () => {
    const manager = setup();
    const op = manager.requestControl("alpha", "queued", { kind: "create" }, "fixture");
    expect(manager.operation("beta", "queued", op.id)).toBeNull();
    expect(manager.store.get("alpha", "queued")).toBeNull();
    await manager.processControls();
    expect(manager.operation("alpha", "queued", op.id)?.state).toBe("completed");
    const start = manager.requestControl("alpha", "queued", { kind: "start" }, "fixture");
    await manager.processControls();
    expect(manager.operation("alpha", "queued", start.id)?.state).toBe("completed");
    const response = await manager.http("alpha", "queued", { service: "web" });
    expect(response.status).toBe(200);
    expect(response.body).toContain('queued');
    await expect(manager.http("alpha", "queued", { service: "web", path: "//127.0.0.1:1/" })).rejects.toThrow();
    await expect(manager.http("alpha", "queued", { service: "web", headers: { host: "example.com" } })).rejects.toThrow();
    const checked = await manager.check("alpha", "queued", "health");
    expect(checked.revision).toBe(manager.status("alpha", "queued").heads.app);
    expect(checked.exitCode).toBe(0);
    const serialized = JSON.stringify(manager.publicStatus("alpha", "queued"));
    expect(serialized).not.toContain('owner_id');
    expect(serialized).not.toContain('token');
    expect(manager.publicOperations("alpha", "queued")).toHaveLength(2);
    expect(JSON.stringify(manager.publicOperations("alpha", "queued"))).not.toContain('token');
    await manager.stop("alpha", "queued");
    await expect(manager.http("alpha", "queued", { service: "web" })).rejects.toThrow(/running/);
  }, 30000);
  it("requires a persisted supervisor root team, inherits scope and previews lab-only context", async () => {
    const manager = setup();
    env!.cfg.profiles.supervise = { ...env!.cfg.profiles.implement!, mode: "supervisor", tools: "supervisor" };
    const created = await manager.create("alpha", "team");
    const tasks = new TaskStore(db!);
    const root = WorkerTaskSchema.parse({ id: "lab-root", profile: "supervise", lab: "team", goal: "test", repositoryAliases: ["app"], constraints: { acceptanceCriteria: ["done"] } });
    tasks.submit([root], { project: "alpha" });
    const bound = manager.bindTask("alpha", "lab-root", root, tasks);
    expect(bound?.rootJobId).toBe("lab-root");
    expect(manager.configuration("alpha", "team").repositoryPaths.app?.path).toBe(created.lab.repositories[0]!.worktree);
    const child = WorkerTaskSchema.parse({ ...root, id: "lab-child", profile: "inspect", parentTaskId: "lab-root" });
    tasks.submit([child], { project: "alpha" });
    expect(manager.bindTask("alpha", "lab-child", child, tasks)?.rootJobId).toBe("lab-root");
    const escape = WorkerTaskSchema.parse({ ...child, id: "lab-escape", lab: undefined });
    tasks.submit([escape], { project: "alpha" });
    expect(() => manager.bindTask("alpha", "lab-escape", escape, tasks)).toThrow(/escape/);
    const competitor = WorkerTaskSchema.parse({ ...root, id: "lab-other" });
    tasks.submit([competitor], { project: "alpha" });
    expect(() => manager.bindTask("alpha", "lab-other", competitor, tasks)).toThrow(/already/);
  });
  it("manual promotion checks an exact candidate without changing target", async () => {
    const manager = setup();
    const lab = await manager.create("alpha", "candidate");
    const repo = lab.lab.repositories[0]!;
    const target = execFileSync("git", ["rev-parse", "HEAD"], { cwd: env!.repo, encoding: "utf8" }).trim();
    writeFileSync(path.join(repo.worktree, "candidate.txt"), "candidate");
    commitAll(repo.worktree);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo.worktree, encoding: "utf8" }).trim();
    const result = await manager.promote("alpha", "candidate", { by: "human" });
    expect(result.state).toBe("prepared");
    expect(result.heads.app).toBe(head);
    expect(result.checks[0]?.revision).toBe(head);
    expect(result.commands.length).toBeGreaterThan(0);
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: env!.repo, encoding: "utf8" }).trim()).toBe(target);
  }, 30000);
});
describe("lab coordination boundaries", () => {
  it("routes another controller's restart to the existing owner and refuses foreign rebound HTTP", async () => {
    const manager = setup();
    await manager.create("alpha", "owned");
    await manager.start("alpha", "owned");
    const other = new LabManager({ ...manager.options, monitor: false });
    managers.push(other);
    const original = manager.status("alpha", "owned").services[0]!;
    const op = other.requestControl("alpha", "owned", { kind: "restart", service: "web" }, "fixture-other");
    await other.processControls();
    expect(other.operation("alpha", "owned", op.id)?.state).toBe("pending");
    await manager.processControls();
    expect(other.operation("alpha", "owned", op.id)?.state).toBe("completed");
    const restarted = manager.status("alpha", "owned").services[0]!;
    expect(restarted.pid).not.toBe(original.pid);
    expect(restarted.owner_id).toBe(manager.owner);
    expect(other.publicStatus("alpha", "owned").ownership).toBe("other");
    await manager.stop("alpha", "owned");
    const { createServer } = await import("node:http");
    let hits = 0;
    const server = createServer((_req, res) => {
      hits++;
      res.end("foreign");
    });
    await new Promise<void>(resolve => server.listen(manager.status("alpha", "owned").lab.ports.web!, "127.0.0.1", resolve));
    try {
      await expect(other.http("alpha", "owned", { service: "web" })).rejects.toThrow(/running/);
      expect(hits).toBe(0);
    }
    finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }, 30000);
  it("serializes targets, detects overlap and leaves the second conflicting lab intact", async () => {
    const manager = setup();
    writeFileSync(path.join(env!.repo, "shared.txt"), "base\n");
    commitAll(env!.repo);
    env!.cfg.projects.alpha = { ...ProjectConfigSchema.parse(env!.cfg.projects.alpha), labs: { promotion: "supervisor" } };
    const first = await manager.create("alpha", "first"), second = await manager.create("alpha", "second");
    for (const [lab, text] of [[first, "one\n"], [second, "two\n"]] as const) {
      writeFileSync(path.join(lab.lab.repositories[0]!.worktree, "shared.txt"), text);
      commitAll(lab.lab.repositories[0]!.worktree);
    }
    expect((await manager.coordination("alpha", "first")).overlaps.length).toBeGreaterThan(0);
    const firstResult = await manager.promote("alpha", "first", { by: "supervisor" });
    expect(firstResult.state).toBe("promoted");
    const secondResult = await manager.promote("alpha", "second", { by: "supervisor" });
    expect(secondResult.state).toBe("conflict");
    expect(secondResult.conflicts.app).toContain("shared.txt");
    expect(readFileSync(path.join(env!.repo, "shared.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("one\n");
    expect(readFileSync(path.join(second.lab.repositories[0]!.worktree, "shared.txt"), "utf8")).toContain("<<<<<<<");
  }, 30000);
});
it("redacts short configured environment values and expired ownership nonces", async () => {
  const manager = setup();
  await manager.create("alpha", "redaction");
  const status = manager.status("alpha", "redaction");
  status.lab.env = { SECRET: "abc" };
  status.lab.recipe.env = { SECRET: "abc" };
  expect(redactLabText(status, "abc " + "f".repeat(48))).toBe("[redacted] [redacted]");
});
it("excludes older unrelated processes whose parent PID was reused and rejects changed root identity", () => {
  const token = "a".repeat(48);
  const rows = [{ ProcessId: 100, ParentProcessId: 1, CreatedTicks: "1000", CommandLine: `node ${HOST_MARKER} --sy-lab-token=${token}` }, { ProcessId: 200, ParentProcessId: 100, CreatedTicks: "900", CommandLine: "unrelated older panel" }, { ProcessId: 300, ParentProcessId: 200, CreatedTicks: "950", CommandLine: "unrelated child" }, { ProcessId: 400, ParentProcessId: 100, CreatedTicks: "1001", CommandLine: "owned service" }, { ProcessId: 500, ParentProcessId: 400, CreatedTicks: "1002", CommandLine: "owned child" }];
  expect(ownedWindowsProcessTree(rows, 100, token).map(row => row.ProcessId)).toEqual([100, 400, 500]);
  expect(() => ownedWindowsProcessTree(rows, 100, "b".repeat(48))).toThrow(/ownership changed/);
});
// Since 5cb43f9 a retained service is stopped only through its durable native command owner and
// kernel Job proof; the CIM process-tree proof is no longer consulted to stop it. A recorded
// identity without that owner (a legacy row, or one forged around an orphan) fails closed before
// any destructive step, keeps every piece of evidence, and is never cleared by inference, even
// after its known processes are gone: only migration/recovery may settle it.
it.skipIf(process.platform !== "win32")("retains orphan ownership evidence and refuses destroy of a service identity without a native command owner", async () => {
  const manager = setup();
  const created = await manager.create("alpha", "orphan-proof");
  const token = "c".repeat(48);
  const child = spawn(process.execPath, ["-e", `// ${HOST_MARKER}\nsetInterval(()=>{},1000)`, "--", `--sy-lab-token=${token}`], { stdio: "ignore", windowsHide: true });
  child.unref();
  const pid = child.pid!;
  const proof = path.join(created.lab.root, "logs", "web.process-tree.json");
  const fakePid = 2000000000;
  try {
    await waitFor(async () => await processOwnership(pid, token) === "owned");
    await captureOwnedProcessTree(pid, token, proof);
    const captured = JSON.parse(readFileSync(proof, "utf8")) as {
      rows: Array<{
        ProcessId: number;
        ParentProcessId: number;
        CreatedTicks: string;
        CommandLine: string;
      }>;
    };
    writeFileSync(proof, JSON.stringify({ pid: fakePid, token, rows: [{ ProcessId: fakePid, ParentProcessId: 1, CreatedTicks: "1", CommandLine: `${HOST_MARKER} --sy-lab-token=${token}` }, ...captured.rows.map(row => ({ ...row, ParentProcessId: fakePid }))] }));
    manager.store.saveService({ lab_id: created.lab.id, name: "web", state: "failed", pid: fakePid, token, log_path: path.join(created.lab.root, "logs", "web.log"), restart_count: 0, next_restart: null, started_at: Date.now(), owner_id: manager.owner, owner_until: 0 });
    await expect(manager.destroy("alpha", "orphan-proof")).rejects.toMatchObject({ detail: { kind: "command_uncertain" }, message: expect.stringMatching(/no durable repository command owner/) });
    expect(existsSync(proof)).toBe(true);
    expect(existsSync(created.lab.repositories[0]!.worktree)).toBe(true);
    expect(manager.status("alpha", "orphan-proof").services[0]!.pid).toBe(fakePid);
    expect(processAlive(pid)).toBe(true);
  }
  finally {
    await stopOwnedProcess(pid, token);
  }
  expect(processAlive(pid)).toBe(false);
  await expect(manager.destroy("alpha", "orphan-proof")).rejects.toMatchObject({ detail: { kind: "command_uncertain" } });
  expect(existsSync(proof)).toBe(true);
  expect(existsSync(created.lab.repositories[0]!.worktree)).toBe(true);
  expect(manager.store.service(created.lab.id, "web")).toMatchObject({ pid: fakePid, token });
  // Stand-in for the recovery that settles the unbound row; destroy then proceeds normally.
  db!.prepare("UPDATE lab_services SET pid=NULL,token=NULL,state='stopped' WHERE lab_id=?").run(created.lab.id);
  await manager.destroy("alpha", "orphan-proof");
  expect(existsSync(created.lab.root)).toBe(false);
}, 30000);
it("keeps raw lifecycle failure commands out of waiting clients and public operations", async () => {
  const manager = setup();
  await manager.create("alpha", "failure");
  const op = manager.requestControl("alpha", "failure", { kind: "check", name: "health" });
  db!.prepare("UPDATE lab_operations SET state='failed',error_code='fixture_failure',error_message=? WHERE id=?").run("private command secret-value", op.id);
  await expect(manager.waitOperation("alpha", "failure", op.id)).rejects.toThrow(/inspect its status/);
  expect(JSON.stringify(manager.publicOperation("alpha", "failure", op.id))).not.toContain("secret-value");
});
it("refuses to promote committed changes in a configured read-only repository", async () => {
  const manager = setup();
  const context = manager.options.project("alpha");
  context.repositoryPaths.app!.writable = false;
  const created = await manager.create("alpha", "read-only");
  const repo = created.lab.repositories[0]!;
  const target = execFileSync("git", ["rev-parse", "HEAD"], { cwd: env!.repo, encoding: "utf8" }).trim();
  writeFileSync(path.join(repo.worktree, "readonly-change.txt"), "unauthorized lab change");
  commitAll(repo.worktree);
  await expect(manager.promote("alpha", "read-only", { by: "human" })).rejects.toThrow(/read-only repository/);
  expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: env!.repo, encoding: "utf8" }).trim()).toBe(target);
});
