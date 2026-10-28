import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MeritRouter } from "../src/core/service.js";
import { serveLabs, stopLabSupervisor } from "../src/cli/lab-supervisor.js";
import { processOwnership } from "../src/labs/process-ownership.js";
import { baseConfig, makeEnv, open, ScriptedClient, reply, type Env } from "./helpers.js";
import { labTokens, observeLabProcesses, survivingLabProcesses, type LabProcess } from "./fixtures/lab-hosts.js";

// `labs serve` is the installation's retained-Lab supervisor. In a split installation each
// project's retained Labs live in that project's own store and Lab manager, so serve must tick
// those managers too: crash restarts and idle stops otherwise never happen for split projects.
let env: Env | undefined, sy: MeritRouter | undefined, serving: Promise<void> | undefined;
const dirs: string[] = [];
const observed: LabProcess[] = [];
afterEach(async () => {
  if (serving && sy) await stopLabSupervisor(sy).catch(() => undefined);
  await serving?.catch(() => undefined);
  serving = undefined;
  await sy?.close().catch(() => undefined);
  sy = undefined; env?.cleanup(); env = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  observed.length = 0;
}, 120_000);

const NODE = JSON.stringify(process.execPath);
const SERVER = "require('node:http').createServer((_q,r)=>r.end('ok')).listen(Number(process.env.PORT),'127.0.0.1');";
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, stdio: "pipe" }).toString();
async function waitFor<T>(what: string, probe: () => T | Promise<T>, ms = 60_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

it.skipIf(process.platform !== "win32")("supervises a split project's retained Lab: restarts a crashed service and stops an idle Lab", async () => {
  const repo = realpathSync(mkdtempSync(path.join(tmpdir(), "meritrouter-test-project-")));
  dirs.push(repo);
  mkdirSync(path.join(repo, "src"));
  writeFileSync(path.join(repo, "src", "app.ts"), "export const x = 1;\n");
  writeFileSync(path.join(repo, "server.cjs"), SERVER);
  git(repo, "init", "-q", "-b", "main"); git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "init");
  env = makeEnv({ config: baseConfig({
    storage: { directory: ".meritrouter", layout: "split" }, repositories: {}, brain: { path: "brain", project: "alpha" },
    labs: { port_range: [59200, 59400], max_active: 2, restart_backoff_ms: 10, service_ready_timeout_seconds: 30 },
    projects: { alpha: { directory: repo, repositories: { app: { path: repo } }, lab: { ports: ["web"], env: { PORT: "{port.web}" },
      services: { web: { repo: "app", command: `${NODE} server.cjs`, ready: { http: "http://127.0.0.1:{port.web}/" } } } } } },
  }) });
  sy = open(env, new ScriptedClient(() => reply("unused")));
  expect(sy.layout).toBe("split");
  await sy.createSplitProject({ slug: "alpha", directory: repo });
  const labs = sy.labsFor("alpha");
  expect(labs).not.toBe(sy.labs);
  const local = sy.projectStores("alpha").db;
  await labs.create("alpha", "keep");
  const first = (await labs.start("alpha", "keep")).services[0]!;
  expect(first.state).toBe("running");
  observed.push(...await observeLabProcesses(labTokens(local)));
  expect(observed.some(item => item.role === "host" && item.pid === first.pid)).toBe(true);
  expect(observed.some(item => item.role === "job-helper")).toBe(true);

  const labId = labs.status("alpha", "keep").lab.id;
  const events = () => (local.prepare("SELECT type FROM lab_events WHERE lab_id=? ORDER BY id").all(labId) as Array<{ type: string }>).map(row => row.type);
  const errors: unknown[] = [];
  serving = serveLabs(sy, { onProjectError: error => errors.push(error) });

  // Crash: the service host dies on its own. Only the project's manager can notice and restart it.
  process.kill(first.pid!);
  const restarted = await waitFor("crash restart", () => {
    const service = labs.status("alpha", "keep").services[0]!;
    return service.state === "running" && service.pid && service.pid !== first.pid ? service : null;
  });
  expect(events()).toContain("service_crashed");
  expect(await processOwnership(first.pid!, first.token!)).toBe("missing");
  observed.push(...await observeLabProcesses(labTokens(local)));

  // Idle: the Lab has had no activity for longer than idle_stop_minutes.
  local.prepare("UPDATE labs SET last_activity=0 WHERE name='keep'").run();
  await waitFor("idle stop", () => events().includes("idle_stopped"));
  expect(labs.status("alpha", "keep").lab.state).toBe("stopped");
  expect(await processOwnership(restarted.pid!, restarted.token!)).toBe("missing");

  expect(await stopLabSupervisor(sy)).toBe(true);
  await serving;
  serving = undefined;
  expect(errors).toEqual([]);
  // The installation store holds no Labs: everything above happened in the project's own store.
  expect((sy.db.prepare("SELECT COUNT(*) n FROM labs").get() as { n: number }).n).toBe(0);

  await sy.close();
  sy = undefined;
  expect(await survivingLabProcesses(observed)).toEqual([]);
}, 180_000);
