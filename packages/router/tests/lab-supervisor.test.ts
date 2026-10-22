import { afterEach, expect, it } from "vitest";
import { LabSupervisorLease } from "../src/operations/lab-supervisor.js";
import { openDatabase, type Db } from "../src/storage/db.js";
import { makeEnv, type Env } from "./helpers.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { TaskStore } from "../src/storage/tasks.js";

let env: Env | undefined;
const databases: Db[] = [];
afterEach(() => { databases.reverse().forEach(db => db.close()); databases.length = 0; env?.cleanup(); env = undefined; });

it("serializes independent supervisors and rejects a stale owner's renewal/release", () => {
  env = makeEnv();
  const first = openDatabase(env.cfg.storageDir), second = openDatabase(env.cfg.storageDir);
  databases.push(first, second);
  let now = Date.now();
  const a = new LabSupervisorLease(first, env.cfg.configPath, () => now);
  const b = new LabSupervisorLease(second, env.cfg.configPath, () => now);
  a.claim();
  expect(() => b.claim()).toThrow(/already holds/);
  expect(a.heartbeat().ready).toBe(true);
  expect(b.requestStop()).toBe(true);
  expect(a.heartbeat().stopRequested).toBe(true);
  now += 16_000;
  b.claim();
  expect(() => a.heartbeat()).toThrow(/expired|changed/);
  a.release();
  expect(b.read()?.owner).toBe(b.owner);
  b.release();
  expect(a.read()).toBeNull();
});

it("starts and stops a real Labs supervisor without executing queued model work", async () => {
  env = makeEnv();
  const db = openDatabase(env.cfg.storageDir);
  databases.push(db);
  const tasks = new TaskStore(db);
  const [submitted] = tasks.submit([{ profile: "summarize", goal: "Remain queued while only Labs supervision runs", repositoryAliases: [] }]);
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const execute = promisify(execFile);
  const command = (action: string) => execute(process.execPath, [cli, "labs", action, "--config", env!.cfg.configPath, "--json"], { windowsHide: true, timeout: 45_000 });
  try {
    await command("supervisor-start");
    const first = new LabSupervisorLease(db, env.cfg.configPath).read();
    expect(first).toMatchObject({ ready: true, stopRequested: false });
    await command("supervisor-start");
    expect(new LabSupervisorLease(db, env.cfg.configPath).read()?.owner).toBe(first!.owner);
    expect(tasks.get(submitted!.taskId)?.row.state).toBe("queued");
    expect((db.prepare("SELECT count(*) AS n FROM model_requests").get() as { n: number }).n).toBe(0);
  } finally { await command("supervisor-stop"); }
  expect(new LabSupervisorLease(db, env.cfg.configPath).read()).toBeNull();
}, 90_000);
