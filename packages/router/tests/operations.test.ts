import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import type { Switchyard } from "../src/core/service.js";
import { parseConfig } from "../src/config/load.js";
import { DB_FILE, openDatabase } from "../src/storage/db.js";
import { backupStorage, liveLeases, MANIFEST_FILE, readBackupManifest, restoreStorage } from "../src/operations/backup.js";
import { acquireDaemonLock, Daemon, DAEMON_LOCK, DAEMON_LOG, readDaemonLock, RestartPolicy, type DaemonChild, type DaemonSpawn } from "../src/operations/daemon.js";
import { describeServiceSteps, runServiceSteps, servicePlan, type ServiceIo, type ServiceSpec } from "../src/operations/service.js";
import { sessionDetail } from "../src/admin/insights.js";
import { baseConfig, goodOutput, makeEnv, open, reply, ScriptedClient, servedFor, summarizeTask, type Env } from "./helpers.js";

let env: Env | undefined;
let sy: Switchyard | undefined;
const temps: string[] = [];
afterEach(async () => {
  await sy?.close();
  sy = undefined;
  env?.cleanup();
  env = undefined;
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "switchyard-ops-"));
  temps.push(d);
  return d;
}

function servedClient() {
  return new ScriptedClient((req) => reply(JSON.stringify(goodOutput()), servedFor(sy!, req)));
}

async function runOneTask(): Promise<string> {
  env = makeEnv();
  sy = open(env, servedClient(), { worker: true });
  const [sub] = await sy.submitTasks([summarizeTask()]);
  const r = await sy.awaitResults([sub!.taskId], { timeoutSeconds: 10 });
  expect(r.completed[0]?.executionStatus).toBe("completed");
  return sub!.taskId;
}

describe("storage durability", () => {
  it("defaults to normal and accepts full; rejects anything else", () => {
    const at = path.join(tmpdir(), "switchyard.config.yaml");
    expect(parseConfig(baseConfig(), at).storage.durability).toBe("normal");
    expect(parseConfig(baseConfig({ storage: { directory: ".s", durability: "full" } }), at).storage.durability).toBe("full");
    expect(() => parseConfig(baseConfig({ storage: { directory: ".s", durability: "extra" } }), at)).toThrow(/durability/);
  });

  it("sets SQLite synchronous per level", () => {
    const dir = tempDir();
    const normal = openDatabase(dir);
    expect(normal.pragma("synchronous", { simple: true })).toBe(1);
    normal.close();
    const full = openDatabase(dir, { durability: "full" });
    expect(full.pragma("synchronous", { simple: true })).toBe(2);
    expect(full.pragma("journal_mode", { simple: true })).toBe("wal");
    full.close();
  });
});

describe("backup and restore", () => {
  it("round-trips tasks, session logs, and artifacts while the worker is running", async () => {
    const taskId = await runOneTask();
    const sessionsBefore = sy!.sessions.forTask(taskId);
    expect(sessionsBefore.length).toBeGreaterThan(0);
    const artifact = sy!.artifacts.write({ taskId, kind: "note", label: "evidence", content: "artifact body\n" });
    const target = path.join(tempDir(), "backup");

    // Backup with the worker still open: the online snapshot must be consistent.
    const m = await backupStorage({ storageDir: env!.cfg.storageDir, targetDir: target });
    expect(m).toMatchObject({ format: 1, includesMasterKey: false, missing: [] });
    expect(m.tasks).toBeGreaterThan(0);
    expect(m.sessions).toBe(m.sessionLogs);
    expect(m.artifacts).toBeGreaterThan(0);
    expect(m.artifactFiles).toBe(m.artifacts);
    expect(readBackupManifest(target)).toEqual(m);
    expect(existsSync(path.join(target, `${DB_FILE}-wal`))).toBe(false);
    expect(readdirSync(target).sort()).toEqual(expect.arrayContaining([DB_FILE, MANIFEST_FILE, "sessions"]));
    expect(readdirSync(target)).not.toContain("worktrees");
    await sy!.close();
    sy = undefined;

    // Restore into a fresh storage directory and open SwitchYard on it.
    const restoredDir = path.join(env!.dir, "restored");
    const r = restoreStorage({ backupDir: target, storageDir: restoredDir });
    expect(r).toMatchObject({ previousMovedTo: null, leasesReleased: 0 });
    const cfg = parseConfig(baseConfig({ storage: { directory: "restored" } }), env!.cfg.configPath);
    expect(cfg.storageDir).toBe(restoredDir);
    const { Switchyard } = await import("../src/core/service.js");
    sy = new Switchyard(cfg, { client: new ScriptedClient(() => reply("unused")), admin: null });
    expect(sy.getStatus([taskId])[0]).toMatchObject({ taskId, state: "completed" });
    expect(sy.collectResults([taskId]).completed[0]).toMatchObject({ taskId, executionStatus: "completed" });
    expect(sy.artifacts.read(artifact)?.content.toString("utf8")).toBe("artifact body\n");
    const restoredSessions = sy.sessions.forTask(taskId);
    expect(restoredSessions.map((s) => s.id)).toEqual(sessionsBefore.map((s) => s.id));
    for (const s of restoredSessions) {
      expect(s.logPath.startsWith(restoredDir)).toBe(true);
      const d = sessionDetail(sy, s.id);
      expect(d?.corrupt).toEqual([]);
      expect(d?.events.length).toBe(s.lastSeq);
      expect(d?.events.at(-1)?.type).toBe("ended");
    }
  });

  it("refuses a non-empty target and a target inside storage; trims a torn session line", async () => {
    await runOneTask();
    const storage = env!.cfg.storageDir;
    const busy = tempDir();
    writeFileSync(path.join(busy, "x"), "x");
    await expect(backupStorage({ storageDir: storage, targetDir: busy })).rejects.toThrow(/not empty/);
    await expect(backupStorage({ storageDir: storage, targetDir: path.join(storage, "bk") })).rejects.toThrow(/outside the storage/);

    const log = readdirSync(path.join(storage, "sessions"))[0]!;
    appendFileSync(path.join(storage, "sessions", log), '{"seq":999,"at":1,"ty');
    const target = path.join(tempDir(), "b");
    await backupStorage({ storageDir: storage, targetDir: target });
    const copied = readFileSync(path.join(target, "sessions", log), "utf8");
    expect(copied.endsWith("\n")).toBe(true);
    expect(copied).not.toContain('"seq":999');
  });

  it("includes the master key only on request", async () => {
    await runOneTask();
    sy!.vault.add({ provider: "openai", secret: "sk-test-secret" });
    const storage = env!.cfg.storageDir;
    const a = path.join(tempDir(), "a");
    const b = path.join(tempDir(), "b");
    expect((await backupStorage({ storageDir: storage, targetDir: a })).includesMasterKey).toBe(false);
    expect(existsSync(path.join(a, ".master-key"))).toBe(false);
    expect((await backupStorage({ storageDir: storage, targetDir: b, includeMasterKey: true })).includesMasterKey).toBe(true);
    expect(existsSync(path.join(b, ".master-key"))).toBe(true);
  });

  it("refuses live leases and existing state without --force; --force moves state aside", async () => {
    const taskId = await runOneTask();
    const storage = env!.cfg.storageDir;
    const target = path.join(tempDir(), "backup");
    await backupStorage({ storageDir: storage, targetDir: target });

    // A live lease: a worker still owns a running task.
    sy!.db.prepare("UPDATE tasks SET state = 'running', lease_owner = 'host:1:abc', lease_expires_at = ? WHERE id = ?").run(Date.now() + 60_000, taskId);
    expect(liveLeases(storage).map((l) => l.id)).toEqual([taskId]);
    await sy!.close();
    sy = undefined;
    expect(() => restoreStorage({ backupDir: target, storageDir: storage, force: true })).toThrow(/live leases/);

    // Expired lease: no longer live, but the directory holds state.
    const db = openDatabase(storage);
    db.prepare("UPDATE tasks SET lease_expires_at = 1 WHERE id = ?").run(taskId);
    db.close();
    expect(liveLeases(storage)).toEqual([]);
    expect(() => restoreStorage({ backupDir: target, storageDir: storage })).toThrow(/--force/);

    const r = restoreStorage({ backupDir: target, storageDir: storage, force: true });
    expect(r.previousMovedTo).not.toBeNull();
    expect(existsSync(path.join(r.previousMovedTo!, DB_FILE))).toBe(true);
    expect(existsSync(path.join(r.previousMovedTo!, "sessions"))).toBe(true);
    const restored = new Database(path.join(storage, DB_FILE), { readonly: true });
    expect((restored.prepare("SELECT state FROM tasks WHERE id = ?").get(taskId) as { state: string }).state).toBe("completed");
    restored.close();
  });

  it("expires leases of tasks that were running at backup time, and refuses an incomplete backup", async () => {
    const taskId = await runOneTask();
    sy!.db.prepare("UPDATE tasks SET state = 'running', lease_owner = 'host:1:abc', lease_expires_at = ? WHERE id = ?").run(Date.now() + 60_000, taskId);
    const target = path.join(tempDir(), "backup");
    await backupStorage({ storageDir: env!.cfg.storageDir, targetDir: target });
    await sy!.close();
    sy = undefined;
    const fresh = path.join(tempDir(), "fresh");
    const r = restoreStorage({ backupDir: target, storageDir: fresh });
    expect(r.leasesReleased).toBe(1);
    expect(liveLeases(fresh)).toEqual([]);

    rmSync(path.join(target, MANIFEST_FILE));
    expect(() => restoreStorage({ backupDir: target, storageDir: path.join(tempDir(), "x") })).toThrow(/not a complete SwitchYard backup/);
  });

  it("refuses a backup from a newer schema", async () => {
    await runOneTask();
    const target = path.join(tempDir(), "backup");
    await backupStorage({ storageDir: env!.cfg.storageDir, targetDir: target });
    const m = readBackupManifest(target);
    writeFileSync(path.join(target, MANIFEST_FILE), JSON.stringify({ ...m, schemaVersion: m.schemaVersion + 50 }));
    expect(() => restoreStorage({ backupDir: target, storageDir: path.join(tempDir(), "x") })).toThrow(/newer than this build/);
  });
});

describe("daemon restart policy", () => {
  it("backs off exponentially up to the ceiling and gives up after max restarts in the window", () => {
    const p = new RestartPolicy({ initialDelayMs: 1000, maxDelayMs: 5000, maxRestarts: 4, windowMs: 60_000, stableAfterMs: 30_000 });
    const delays = [0, 1, 2, 3].map((i) => p.onExit(i * 100, 50));
    expect(delays.map((d) => (d.action === "restart" ? d.delayMs : -1))).toEqual([1000, 2000, 4000, 5000]);
    expect(p.onExit(500, 50)).toMatchObject({ action: "give_up" });
    // Once the window slides past the old restarts, restarts are allowed again.
    expect(p.onExit(70_000, 50)).toMatchObject({ action: "restart" });
  });

  it("resets the backoff after a stable run", () => {
    const p = new RestartPolicy({ initialDelayMs: 100, stableAfterMs: 10_000, maxRestarts: 10 });
    expect(p.onExit(0, 10)).toMatchObject({ delayMs: 100 });
    expect(p.onExit(1, 10)).toMatchObject({ delayMs: 200 });
    expect(p.onExit(20_000, 15_000)).toMatchObject({ delayMs: 100, attempt: 1 });
  });

  it("rejects an invalid policy", () => {
    expect(() => new RestartPolicy({ maxRestarts: 0 })).toThrow();
  });
});

class FakeChild extends EventEmitter implements DaemonChild {
  static nextPid = 1000;
  readonly pid = FakeChild.nextPid++;
  readonly killed: string[] = [];
  /** When set, the child ignores SIGTERM (only SIGKILL ends it). */
  stubborn = false;
  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killed.push(signal);
    if (!this.stubborn || signal === "SIGKILL") setImmediate(() => this.emit("exit", null, signal));
    return true;
  }
}

function fakeSpawner(plan: (child: FakeChild, n: number) => void) {
  const children: FakeChild[] = [];
  const calls: Array<{ command: string; args: string[] }> = [];
  const spawn: DaemonSpawn = (command, args) => {
    const child = new FakeChild();
    children.push(child);
    calls.push({ command, args });
    plan(child, children.length);
    return child;
  };
  return { spawn, children, calls };
}

describe("daemon", () => {
  it("restarts a crashing worker with backoff, logs, and gives up at the cap", async () => {
    const logs = tempDir();
    let t = 0;
    const sleeps: number[] = [];
    const f = fakeSpawner((child) => setImmediate(() => child.emit("exit", 1, null)));
    const d = new Daemon({
      command: "node",
      args: ["cli.js", "worker"],
      cwd: logs,
      logsDir: logs,
      policy: { initialDelayMs: 10, maxRestarts: 3, windowMs: 60_000 },
      spawn: f.spawn,
      now: () => (t += 5),
      sleep: async (ms) => void sleeps.push(ms),
    });
    const r = await d.run();
    expect(r).toMatchObject({ reason: "gave_up", starts: 4, lastExit: { code: 1, signal: null } });
    expect(sleeps).toEqual([10, 20, 40]);
    expect(f.calls[0]).toEqual({ command: "node", args: ["cli.js", "worker"] });
    const log = readFileSync(path.join(logs, DAEMON_LOG), "utf8");
    expect(log).toMatch(/worker started \(pid \d+, start 1\)/);
    expect(log).toMatch(/giving up: 3 restarts within 60s/);
  });

  it("treats a spawn error as an exit", async () => {
    const logs = tempDir();
    const f = fakeSpawner((child) => setImmediate(() => child.emit("error", new Error("spawn ENOENT"))));
    const d = new Daemon({ command: "nope", args: [], cwd: logs, logsDir: logs, policy: { maxRestarts: 1 }, spawn: f.spawn, sleep: async () => undefined });
    expect(await d.run()).toMatchObject({ reason: "gave_up", starts: 2 });
    expect(readFileSync(path.join(logs, DAEMON_LOG), "utf8")).toContain("worker error: spawn ENOENT");
  });

  it("stop() terminates the worker and does not restart it", async () => {
    const logs = tempDir();
    const f = fakeSpawner(() => undefined);
    const d = new Daemon({ command: "node", args: [], cwd: logs, logsDir: logs, spawn: f.spawn });
    const running = d.run();
    await new Promise((r) => setImmediate(r));
    await d.stop();
    expect(await running).toMatchObject({ reason: "stopped", starts: 1 });
    expect(f.children[0]!.killed).toEqual(["SIGTERM"]);
  });

  it("kills a worker that ignores SIGTERM after the grace period", async () => {
    const logs = tempDir();
    const f = fakeSpawner((child) => (child.stubborn = true));
    const d = new Daemon({ command: "node", args: [], cwd: logs, logsDir: logs, spawn: f.spawn, stopTimeoutMs: 20 });
    const running = d.run();
    await new Promise((r) => setImmediate(r));
    await d.stop();
    expect(await running).toMatchObject({ reason: "stopped" });
    expect(f.children[0]!.killed).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("stop() during a backoff wait ends the daemon without another start", async () => {
    const logs = tempDir();
    const f = fakeSpawner((child) => setImmediate(() => child.emit("exit", 1, null)));
    let entered!: () => void;
    const waiting = new Promise<void>((r) => (entered = r));
    const d = new Daemon({ command: "node", args: [], cwd: logs, logsDir: logs, spawn: f.spawn, sleep: () => (entered(), new Promise(() => undefined)) });
    const running = d.run();
    await waiting;
    await d.stop();
    expect(await running).toMatchObject({ reason: "stopped", starts: 1 });
  });

  it("allows one daemon per storage directory and replaces a stale lock", () => {
    const logs = tempDir();
    writeFileSync(path.join(logs, DAEMON_LOCK), JSON.stringify({ pid: 2147483646, startedAt: "then", configPath: "x" }));
    expect(readDaemonLock(logs)).toMatchObject({ pid: 2147483646, alive: false });
    const release = acquireDaemonLock(logs, "cfg.yaml");
    expect(readDaemonLock(logs)).toMatchObject({ pid: process.pid, alive: true, configPath: "cfg.yaml" });
    // Another live process (our parent) holding the lock blocks a second daemon.
    writeFileSync(path.join(logs, DAEMON_LOCK), JSON.stringify({ pid: process.ppid, startedAt: "now", configPath: "x" }));
    expect(() => acquireDaemonLock(logs, "cfg.yaml")).toThrow(/already running/);
    release(); // not ours any more: left in place
    expect(existsSync(path.join(logs, DAEMON_LOCK))).toBe(true);
  });

  it("restore refuses while a daemon runs for the storage directory", async () => {
    await runOneTask();
    const target = path.join(tempDir(), "backup");
    await backupStorage({ storageDir: env!.cfg.storageDir, targetDir: target });
    await sy!.close();
    sy = undefined;
    const fresh = path.join(tempDir(), "fresh");
    mkdirSync(path.join(fresh, "logs"), { recursive: true });
    writeFileSync(path.join(fresh, "logs", DAEMON_LOCK), JSON.stringify({ pid: process.ppid, startedAt: "now", configPath: "x" }));
    expect(() => restoreStorage({ backupDir: target, storageDir: fresh })).toThrow(/daemon/);
  });
});

describe("service definitions (dry run only; nothing is installed)", () => {
  const spec = (platform: ServiceSpec["platform"], extra: Partial<ServiceSpec> = {}): ServiceSpec => ({
    platform,
    nodePath: platform === "win32" ? "C:\\Program Files\\nodejs\\node.exe" : "/usr/bin/node",
    cliPath: platform === "win32" ? "C:\\sy\\dist\\cli.js" : "/opt/sy/dist/cli.js",
    configPath: platform === "win32" ? "C:\\Users\\me\\sy\\switchyard.config.yaml" : "/home/me/sy 100%/switchyard.config.yaml",
    workingDir: platform === "win32" ? "C:\\Users\\me\\sy" : "/home/me/sy 100%",
    storageDir: platform === "win32" ? "C:\\Users\\me\\sy\\.switchyard" : "/home/me/sy/.switchyard",
    logsDir: platform === "win32" ? "C:\\Users\\me\\sy\\.switchyard\\logs" : "/home/me/sy/.switchyard/logs",
    homeDir: platform === "win32" ? "C:\\Users\\me" : "/home/me",
    ...extra,
  });

  it("writes a systemd user unit that restarts on failure", () => {
    const p = servicePlan(spec("linux"));
    expect(p.definitionPath).toBe("/home/me/.config/systemd/user/switchyard.service");
    expect(p.definition).toContain('ExecStart="/usr/bin/node" "/opt/sy/dist/cli.js" "daemon" "--config" "/home/me/sy 100%%/switchyard.config.yaml"');
    expect(p.definition).toContain("Restart=on-failure");
    expect(p.definition).toContain("WantedBy=default.target");
    expect(p.install.filter((s) => s.kind === "run").map((s) => s.kind === "run" && s.args.join(" "))).toEqual(["--user daemon-reload", "--user enable --now switchyard.service"]);
    const text = describeServiceSteps(p, "install");
    expect(text).toContain("write /home/me/.config/systemd/user/switchyard.service");
    expect(text).toContain("run systemctl --user enable --now switchyard.service");
  });

  it("writes a launchd agent that keeps the daemon alive on failure", () => {
    const p = servicePlan(spec("darwin", { uid: 501, name: "sy-dev" }));
    expect(p.definitionPath).toBe("/home/me/Library/LaunchAgents/dev.switchyard.sy-dev.plist");
    expect(p.definition).toContain("<key>Label</key><string>dev.switchyard.sy-dev</string>");
    expect(p.definition).toContain("<string>daemon</string>");
    expect(p.definition).toContain("<dict><key>SuccessfulExit</key><false/></dict>");
    expect(p.install.at(-1)).toEqual({ kind: "run", command: "launchctl", args: ["bootstrap", "gui/501", p.definitionPath], allowFailure: false });
    expect(p.status[0]).toMatchObject({ args: ["print", "gui/501/dev.switchyard.sy-dev"] });
    expect(() => servicePlan(spec("darwin"))).toThrow(/uid/);
  });

  it("writes a Task Scheduler XML task (logon trigger, least privilege, restart on failure)", () => {
    const p = servicePlan(spec("win32", { windowsUser: "PC\\me" }));
    expect(p.definitionPath).toBe("C:\\Users\\me\\sy\\.switchyard\\service\\switchyard.xml");
    expect(p.definition).toContain('encoding="UTF-16"');
    expect(p.definition).toContain("<LogonTrigger><Enabled>true</Enabled><UserId>PC\\me</UserId></LogonTrigger>");
    expect(p.definition).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(p.definition).toContain("<RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>");
    expect(p.definition).toContain("<Command>C:\\Program Files\\nodejs\\node.exe</Command>");
    expect(p.definition).toContain("<Arguments>C:\\sy\\dist\\cli.js daemon --config C:\\Users\\me\\sy\\switchyard.config.yaml</Arguments>");
    expect(p.install[0]).toMatchObject({ kind: "write_file", encoding: "utf16le" });
    expect(p.install.slice(1)).toEqual([
      { kind: "run", command: "schtasks", args: ["/Create", "/TN", "switchyard", "/XML", p.definitionPath, "/F"], allowFailure: false },
      { kind: "run", command: "schtasks", args: ["/Run", "/TN", "switchyard"], allowFailure: false },
    ]);
    expect(describeServiceSteps(p, "uninstall")).toContain("run schtasks /Delete /TN switchyard /F");
    // Quoting: a path with spaces is quoted and XML-escaped.
    const spaced = servicePlan(spec("win32", { cliPath: "C:\\My Tools\\cli.js" }));
    expect(spaced.definition).toContain("<Arguments>&quot;C:\\My Tools\\cli.js&quot; daemon");
  });

  it("rejects an unsafe service name", () => {
    expect(() => servicePlan(spec("linux", { name: "a b;rm" }))).toThrow();
  });

  it("runs steps in order through the injected io and stops on a failing step", () => {
    const p = servicePlan(spec("win32"));
    const seen: string[] = [];
    const io: ServiceIo = {
      run: (c, a) => (seen.push(`${c} ${a[0]}`), { code: a[0] === "/Run" ? 1 : 0, output: "" }),
      writeFile: (f) => void seen.push(`write ${path.win32.basename(f)}`),
      removeFile: (f) => void seen.push(`remove ${path.win32.basename(f)}`),
    };
    expect(runServiceSteps(p, "install", io).ok).toBe(false);
    expect(seen).toEqual(["write switchyard.xml", "schtasks /Create", "schtasks /Run"]);
    seen.length = 0;
    const un = runServiceSteps(p, "uninstall", { ...io, run: (c, a) => (seen.push(`${c} ${a[0]}`), { code: a[0] === "/End" ? 1 : 0, output: "" }) });
    expect(un.ok).toBe(true);
    expect(seen).toEqual(["schtasks /End", "schtasks /Delete", "remove switchyard.xml"]);
  });
});
