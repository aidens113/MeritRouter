import { PaidModelSchema } from "../src/config/schema.js";
import { Worktrees } from "../src/workspaces/worktree.js";
import { TaskStore } from "../src/storage/tasks.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { openDatabase, type Db } from "../src/storage/db.js";
import { ProjectRegistry } from "../src/projects/registry.js";
import { LabManager } from "../src/labs/lab.js";
import { LabRecipeSchema, LabsConfigSchema, validateRecipe } from "../src/labs/recipe.js";
import { processAlive, processOwnership, stopOwnedProcess } from "../src/labs/process-ownership.js";
import { portAvailable } from "../src/labs/ports.js";
import { baseConfig, commitAll, makeEnv, type Env } from "./helpers.js";
const exec = promisify(execFile);
let env: Env | undefined;
let db: Db | undefined;
const managers: LabManager[] = [];
afterEach(async () => {
  if (db) {
    for (const m of managers) {
      for (const lab of m.store.list()) {
        for (const service of m.store.services(lab.id)) {
          if (service.pid && service.token)
            await stopOwnedProcess(service.pid, service.token).catch(() => undefined);
        }
      }
    }
  }
  for (const m of managers.reverse()) {
    try {
      await m.close();
    }
    catch { }
  }
  managers.length = 0;
  db?.close();
  db = undefined;
  env?.cleanup();
  env = undefined;
});
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
    db!.prepare('UPDATE labs SET last_activity=0 WHERE id=?').run(lab.lab.id);
    await manager.tick();
    expect(manager.status('alpha', 'idle').lab.state).toBe('stopped');
    expect(await portAvailable(lab.lab.ports.web!)).toBe(true);
    db!.prepare("UPDATE lab_services SET pid=?,token=?,state='running',owner_until=0 WHERE lab_id=?").run(process.pid, 'a'.repeat(48), lab.lab.id);
    expect(await processOwnership(process.pid, 'a'.repeat(48))).toBe('foreign');
    await expect(manager.stop('alpha', 'idle')).rejects.toThrow(/ownership/);
    expect(processAlive(process.pid)).toBe(true);
    db!.prepare("UPDATE lab_services SET pid=NULL,token=NULL,state='stopped' WHERE lab_id=?").run(lab.lab.id);
    await manager.destroy('alpha', 'idle');
  }, 30000);
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
