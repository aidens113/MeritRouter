import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { Switchyard } from "../src/core/service.js";
import { brainRead, brainWrite } from "../src/admin/insights.js";
import { backupStorage, restoreStorage } from "../src/operations/backup.js";
import { BRAIN_BUNDLE, brainMountsOf, brainPathOf } from "../src/operations/brain-backup.js";
import { DAEMON_LOG, logsDirFor, processAlive, readDaemonLock, WORKER_LOG } from "../src/operations/daemon.js";
import { DB_FILE } from "../src/storage/db.js";
import { baseConfig, endpoint, goodOutput, makeEnv, open, reply, ScriptedClient, summarizeTask, type Env } from "./helpers.js";

// J3 operations for many projects: one daemon (one worker) serves every project, and a backup
// carries the brain repository (every project's folder and global/) as a git bundle.

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

const envs: Env[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
let sy: Switchyard | undefined;
afterEach(async () => {
  await sy?.close();
  sy = undefined;
  for (const c of cleanups.splice(0).reverse()) await c();
  for (const e of envs.splice(0)) e.cleanup();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(what: string, ok: () => boolean, timeoutMs: number, everyMs = 200): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Two projects without repositories (summarize tasks need none), a global brain mount, and one of beta's own. */
function twoProjects(extra: Record<string, unknown> = {}) {
  const base = baseConfig();
  return {
    ...base,
    repositories: {},
    routing: { escalate_on_failure: false },
    team: { provider_concurrency_enabled: false },
    brain: { path: "brain", project: "alpha", mounts: [{ prefix: "global/shared", path: "shared-notes" }] },
    projects: { alpha: { name: "Alpha" }, beta: { name: "Beta", brain: { mounts: [{ prefix: "projects/beta/docs", path: "beta-docs" }] } } },
    ...extra,
  };
}

function projectsEnv(extra: Record<string, unknown> = {}, endpoints?: unknown[]): Env {
  const e = makeEnv({ config: twoProjects(extra), ...(endpoints ? { endpoints } : {}) });
  for (const d of ["shared-notes", "beta-docs"]) mkdirSync(path.join(e.dir, d), { recursive: true });
  envs.push(e);
  return e;
}

/** An OpenAI-compatible provider over HTTP that answers every chat with a good summarize result. */
async function httpProvider(): Promise<{ baseUrl: string; chats: () => number; close: () => Promise<void> }> {
  let chats = 0;
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
    req.on("end", () => {
      if (req.method === "GET" && req.url?.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ object: "list", data: [] }));
        return;
      }
      if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
        res.writeHead(404).end();
        return;
      }
      chats++;
      const body = JSON.parse(raw) as { model: string };
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          id: `c${chats}`,
          object: "chat.completion",
          model: body.model,
          choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(goodOutput()) }, finish_reason: "stop" }],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    chats: () => chats,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** Run the built CLI; resolves on exit (a detached daemon it starts never holds the pipes open). */
function cli(args: string[], cwd: string, timeoutMs = 60_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env = { ...process.env };
  delete env.SWITCHYARD_PROJECT;
  delete env.SWITCHYARD_CONFIG;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`switchyard ${args.join(" ")} did not exit within ${timeoutMs}ms: ${stdout}${stderr}`));
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      // Give the pipes a moment to drain, without waiting on handles a grandchild might hold.
      setTimeout(() => resolve({ code, stdout, stderr }), 300);
    });
  });
}

/** End a daemon left running by a failed test, with its worker. */
function killDaemonOf(storageDir: string): void {
  const lock = readDaemonLock(logsDirFor(storageDir));
  if (!lock?.alive) return;
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(lock.pid), "/T", "/F"], { stdio: "pipe" });
    else process.kill(lock.pid, "SIGKILL");
  } catch {
    // already gone
  }
}

describe("one daemon for every project", () => {
  it.skipIf(!existsSync(CLI))(
    "daemon start runs one worker that claims tasks of two projects; status counts per project; stop ends it (needs dist/cli.js)",
    async () => {
      const gw = await httpProvider();
      cleanups.push(() => gw.close());
      const base = baseConfig();
      const profiles = base.profiles as Record<string, Record<string, unknown>>;
      const e = projectsEnv(
        {
          providers: { local: { base_url: gw.baseUrl, keys: [{ api_key: "test-key", billing_class: "free_tier" }] } },
          profiles: { ...profiles, summarize: { ...profiles.summarize, batching: { enabled: false } } },
        },
        [endpoint({ providerId: "local" })],
      );
      const configPath = e.cfg.configPath;
      cleanups.push(() => killDaemonOf(e.cfg.storageDir));

      // Queue two tasks in each project from a process that runs none.
      sy = open(e, new ScriptedClient(() => reply("unused")), { worker: false });
      const alpha = await sy.submitTasks([summarizeTask({ goal: "alpha one" }), summarizeTask({ goal: "alpha two" })], { project: "alpha" });
      const beta = await sy.submitTasks([summarizeTask({ goal: "beta one" }), summarizeTask({ goal: "beta two" })], { project: "beta" });
      await sy.close();
      sy = undefined;
      const ids = [...alpha, ...beta].map((s) => s.taskId);

      // --project is refused: there is one daemon per install.
      const refused = await cli(["daemon", "start", "--project", "alpha", "--config", configPath], e.dir);
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toMatch(/does not take --project: the daemon is install-wide/);
      expect(readDaemonLock(logsDirFor(e.cfg.storageDir))).toBeNull();

      // Status works without a daemon and counts each project's queue.
      const before = await cli(["daemon", "status", "--json", "--config", configPath], e.dir);
      expect(before.code).toBe(0);
      const s0 = JSON.parse(before.stdout) as { daemon: unknown; projects: Array<{ project: string; queued: number; running: number }> };
      expect(s0.daemon).toBeNull();
      expect(s0.projects.map((p) => [p.project, p.queued, p.running])).toEqual([
        ["alpha", 2, 0],
        ["beta", 2, 0],
      ]);

      const started = await cli(["daemon", "start", "--config", configPath], e.dir);
      expect(started.code, started.stdout + started.stderr).toBe(0);
      expect(started.stdout).toMatch(/one worker for every project \(alpha, beta\)/);
      const lock = readDaemonLock(logsDirFor(e.cfg.storageDir));
      expect(lock?.alive).toBe(true);

      // A second start is refused while the first runs.
      const again = await cli(["daemon", "start", "--config", configPath], e.dir);
      expect(again.code).not.toBe(0);
      expect(again.stderr).toMatch(/already running/);

      const db = new Database(path.join(e.cfg.storageDir, DB_FILE), { readonly: true, fileMustExist: true });
      cleanups.push(() => {
        db.close();
      });
      const states = () => db.prepare(`SELECT id, project_id, state FROM tasks WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as Array<{ id: string; project_id: string; state: string }>;
      const logs = logsDirFor(e.cfg.storageDir);
      await until(`all four tasks to complete (${JSON.stringify(states())}; ${existsSync(path.join(logs, WORKER_LOG)) ? readFileSync(path.join(logs, WORKER_LOG), "utf8").slice(-2000) : "no worker log"})`, () => states().every((t) => t.state === "completed"), 60_000);
      expect(states().map((t) => t.project_id).sort()).toEqual(["alpha", "alpha", "beta", "beta"]);
      expect(gw.chats()).toBeGreaterThanOrEqual(4);

      const during = await cli(["daemon", "status", "--json", "--config", configPath], e.dir);
      const s1 = JSON.parse(during.stdout) as { daemon: { pid: number; alive: boolean }; totals: { queued: number; running: number } };
      expect(s1.daemon).toMatchObject({ pid: lock!.pid, alive: true });
      expect(s1.totals).toEqual({ queued: 0, running: 0 });
      const text = await cli(["daemon", "status", "--config", configPath], e.dir);
      expect(text.stdout).toMatch(/one worker serves every project/);
      expect(text.stdout).toMatch(/alpha\s+Alpha/);

      const stopped = await cli(["daemon", "stop", "--config", configPath], e.dir, 90_000);
      expect(stopped.code).toBe(0);
      expect(stopped.stdout).toMatch(new RegExp(`daemon ${lock!.pid} stopped`));
      expect(processAlive(lock!.pid)).toBe(false);
      expect(readDaemonLock(logs)).toBeNull();

      // One daemon started exactly one worker, which served both projects.
      const daemonLog = readFileSync(path.join(logs, DAEMON_LOG), "utf8");
      expect(daemonLog.match(/worker started/g)).toHaveLength(1);
      expect(daemonLog).toMatch(/stop requested/);
      expect(readFileSync(path.join(logs, WORKER_LOG), "utf8").match(/worker \S+ running/g)).toHaveLength(1);
    },
    150_000,
  );
});

/** A two-project install whose brain has commits from both projects, and a backup of it. */
async function backedUpInstall(): Promise<{ source: Env; backupDir: string; manifest: Awaited<ReturnType<typeof backupStorage>> }> {
  const source = projectsEnv();
  sy = open(source, new ScriptedClient(() => reply("unused")), { worker: false });
  await sy.submitTasks([summarizeTask({ goal: "alpha work" })], { project: "alpha" });
  await sy.submitTasks([summarizeTask({ goal: "beta work" })], { project: "beta" });
  await brainWrite(sy, "projects/alpha/facts/alpha-fact.md", "# Alpha fact\n\nAlpha ships on Mondays.\n", "alpha");
  await brainWrite(sy, "projects/beta/facts/beta-fact.md", "# Beta fact\n\nBeta ships on Fridays.\n", "beta");
  const backupDir = path.join(mkdtempSync(path.join(tmpdir(), "switchyard-pops-")), "backup");
  cleanups.push(() => rmSync(path.dirname(backupDir), { recursive: true, force: true }));
  // Online: the store is open while the backup runs.
  const manifest = await backupStorage({ storageDir: source.cfg.storageDir, targetDir: backupDir, brainPath: brainPathOf(source.cfg), brainMounts: brainMountsOf(source.cfg) });
  await sy.close();
  sy = undefined;
  return { source, backupDir, manifest };
}

describe("backup and restore of the brain", () => {
  it("round-trips a brain with commits from two projects, and lists brain mounts as not included", async () => {
    const { source, backupDir, manifest } = await backedUpInstall();
    const brain = brainPathOf(source.cfg);
    expect(manifest.format).toBe(2);
    expect(manifest.tasks).toBe(2);
    expect(manifest.brain).toMatchObject({ included: true, bundle: BRAIN_BUNDLE, head: "main", commit: git(brain, "rev-parse", "HEAD"), uncommitted: [] });
    expect(manifest.brain!.commits).toBe(Number(git(brain, "rev-list", "--count", "--all")));
    expect(manifest.brain!.mountsNotIncluded).toEqual([
      { prefix: "global/shared", path: path.join(source.dir, "shared-notes"), project: null },
      { prefix: "projects/beta/docs", path: path.join(source.dir, "beta-docs"), project: "beta" },
    ]);
    expect(existsSync(path.join(backupDir, BRAIN_BUNDLE))).toBe(true);

    // Restore into a second install whose brain does not exist yet.
    const target = projectsEnv();
    const targetBrain = brainPathOf(target.cfg);
    expect(existsSync(targetBrain)).toBe(false);
    const r = restoreStorage({ backupDir, storageDir: target.cfg.storageDir, brainPath: targetBrain });
    expect(r.brain).toMatchObject({ action: "create", brainPath: targetBrain, previousMovedTo: null, commit: manifest.brain!.commit });
    expect(git(targetBrain, "rev-parse", "HEAD")).toBe(manifest.brain!.commit);
    expect(git(targetBrain, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(git(targetBrain, "status", "--porcelain")).toBe("");
    expect(git(targetBrain, "log", "--format=%s")).toBe(git(brain, "log", "--format=%s"));
    expect(readFileSync(path.join(targetBrain, "projects/alpha/facts/alpha-fact.md"), "utf8")).toBe("# Alpha fact\n\nAlpha ships on Mondays.\n");
    expect(readFileSync(path.join(targetBrain, "projects/beta/facts/beta-fact.md"), "utf8")).toBe("# Beta fact\n\nBeta ships on Fridays.\n");

    // The restored install serves both projects' tasks and brains.
    sy = open(target, new ScriptedClient(() => reply("unused")), { worker: false });
    expect(sy.listTasks(undefined, 50, "alpha")).toHaveLength(1);
    expect(sy.listTasks(undefined, 50, "beta")).toHaveLength(1);
    expect((await brainRead(sy, "projects/beta/facts/beta-fact.md", "beta"))?.content ?? "").toMatch(/Fridays/);
    await sy.close();
    sy = undefined;

    // Restoring the same backup again over the restored brain needs --force for the store, and the brain is already current.
    const again = restoreStorage({ backupDir, storageDir: target.cfg.storageDir, brainPath: targetBrain, force: true });
    expect(again.brain.action).toBe("same");
  });

  it("refuses a restore over a brain with uncommitted changes, before touching anything; --force moves a clean brain aside", async () => {
    const { backupDir, manifest } = await backedUpInstall();
    const target = projectsEnv();
    const targetBrain = brainPathOf(target.cfg);
    mkdirSync(targetBrain, { recursive: true });
    git(targetBrain, "init", "-q", "-b", "main");
    writeFileSync(path.join(targetBrain, "notes.md"), "committed\n");
    git(targetBrain, "add", "-A");
    git(targetBrain, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "local brain");
    writeFileSync(path.join(targetBrain, "notes.md"), "edited, not committed\n");
    writeFileSync(path.join(targetBrain, ".switchyard-brain.lock"), "");

    for (const force of [false, true]) {
      expect(() => restoreStorage({ backupDir, storageDir: target.cfg.storageDir, brainPath: targetBrain, force })).toThrow(/brain at .* has 1 uncommitted change\(s\) \(notes\.md\).*never overwrites uncommitted brain work/);
    }
    // Nothing changed: no store was written and the edit is still there.
    expect(existsSync(path.join(target.cfg.storageDir, DB_FILE))).toBe(false);
    expect(readFileSync(path.join(targetBrain, "notes.md"), "utf8")).toBe("edited, not committed\n");

    // Committed, the brain is still someone's history: --force is needed, and it moves the brain aside.
    rmSync(path.join(targetBrain, ".switchyard-brain.lock"));
    git(targetBrain, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-am", "keep the edit");
    expect(() => restoreStorage({ backupDir, storageDir: target.cfg.storageDir, brainPath: targetBrain })).toThrow(/existing brain .* pass --force/);
    expect(existsSync(path.join(target.cfg.storageDir, DB_FILE))).toBe(false);
    const r = restoreStorage({ backupDir, storageDir: target.cfg.storageDir, brainPath: targetBrain, force: true });
    expect(r.brain.action).toBe("replace");
    expect(r.brain.previousMovedTo).toMatch(/\.pre-restore-/);
    expect(readFileSync(path.join(r.brain.previousMovedTo!, "notes.md"), "utf8")).toBe("edited, not committed\n");
    expect(git(targetBrain, "rev-parse", "HEAD")).toBe(manifest.brain!.commit);
    expect(existsSync(path.join(targetBrain, "notes.md"))).toBe(false);
    cleanups.push(() => rmSync(r.brain.previousMovedTo!, { recursive: true, force: true }));
  });
});
