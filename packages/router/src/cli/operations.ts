import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import type { ResolvedConfig } from "../config/load.js";
import { SwitchyardError } from "../core/errors.js";
import { backupStorage, restoreStorage } from "../operations/backup.js";
import { brainMountsOf, brainPathOf } from "../operations/brain-backup.js";
import { Daemon, DAEMON_OUT, acquireDaemonLock, logsDirFor, processAlive, readDaemonLock, requestDaemonStop } from "../operations/daemon.js";
import { daemonStatus } from "../operations/daemon-status.js";
import { ServiceActionSchema, ServicePlatformSchema, describeServiceSteps, runServiceSteps, servicePlan } from "../operations/service.js";
import { PROJECT_ENV } from "./project-select.js";
import { countFlag } from "./args.js";
import { out, table } from "./terminal.js";

// Operations commands (backup, restore, daemon, service). They work on the storage directory
// directly and never open a Switchyard: restore replaces the database, and the daemon's worker
// runs in a child process. They are install-wide: one store, one brain, and one daemon whose one
// worker serves every project, so `--project` is refused rather than silently ignored.

export interface OperationsFlags {
  project?: string;
  force?: boolean;
  "include-master-key"?: boolean;
  "dry-run"?: boolean;
  "max-restarts"?: string;
  window?: string;
  "max-delay"?: string;
  timeout?: string;
  name?: string;
}

const PROJECT_REFUSAL: Record<string, string> = {
  daemon: "the daemon is install-wide: its one worker serves every project with fair claiming, so there is no per-project daemon. Drop --project; to limit a project, set projects.<slug>.max_concurrent_tasks or priority",
  service: "the service runs the install's one daemon, which serves every project; there is no per-project service. Drop --project",
  backup: "a backup covers the whole install (every project's tasks, sessions, and artifacts, and the brain with every project's folder); there is no per-project backup. Drop --project",
  restore: "a restore replaces the whole install (every project's tasks and the brain); there is no per-project restore. Drop --project",
};

/** The worker's environment: every project, so a shell's SWITCHYARD_PROJECT is not passed on. */
function workerEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env[PROJECT_ENV];
  return env;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tail(file: string, lines = 15): string {
  if (!existsSync(file)) return "";
  return readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).slice(-lines).join("\n");
}

/** `cliPath` is the CLI entry point (dist/cli.js) the daemon and the service run. */
export async function operationsCommand(cmd: string, args: string[], values: OperationsFlags, cfg: ResolvedConfig, json: boolean, cliPath: string): Promise<number> {
  if (values.project !== undefined) throw new SwitchyardError("usage", `switchyard ${cmd} does not take --project: ${PROJECT_REFUSAL[cmd] ?? "this command is install-wide"}`);
  switch (cmd) {
    case "backup": {
      if (!args[0]) throw new SwitchyardError("usage", "usage: switchyard backup <dir> [--include-master-key]");
      const m = await backupStorage({
        storageDir: cfg.storageDir,
        targetDir: args[0],
        includeMasterKey: values["include-master-key"] ?? false,
        brainPath: brainPathOf(cfg),
        brainMounts: brainMountsOf(cfg),
      });
      const b = m.brain;
      out(json ? m : [
        `backed up ${cfg.storageDir} to ${path.resolve(args[0])}`,
        `schema ${m.schemaVersion}; ${m.tasks} task(s), ${m.sessions} session(s) with ${m.sessionLogs} log(s), ${m.artifacts} artifact(s)`,
        m.includesMasterKey ? "includes the vault master key: keep this backup private" : "the vault master key is not included; provider keys in the vault need SWITCHYARD_MASTER_KEY or the original .master-key to decrypt",
        ...(b?.included ? [`brain ${b.sourcePath}: ${b.commits} commit(s), ${b.head ?? "detached"} at ${b.commit?.slice(0, 12)} (bundle ${b.bundle})`] : b ? [`brain not included: ${b.reason}`] : []),
        ...(b?.uncommitted.length ? [`WARNING ${b.uncommitted.length} uncommitted brain change(s) are not in the backup (${b.uncommitted.slice(0, 5).join(", ")}${b.uncommitted.length > 5 ? ", ..." : ""}); SwitchYard commits them on its next brain write`] : []),
        ...(b?.mountsNotIncluded ?? []).map((x) => `brain mount ${x.prefix} -> ${x.path}${x.project ? ` (project ${x.project})` : " (global)"} is not included: back up that repository itself`),
        ...m.missing.map((f) => `MISSING ${f}`),
      ].join("\n"), json);
      return m.missing.length ? 1 : 0;
    }
    case "restore": {
      if (!args[0]) throw new SwitchyardError("usage", "usage: switchyard restore <dir> [--force]");
      const r = restoreStorage({ backupDir: args[0], storageDir: cfg.storageDir, force: values.force ?? false, brainPath: brainPathOf(cfg) });
      out(json ? r : [
        `restored ${path.resolve(args[0])} (taken ${r.manifest.createdAt}) into ${r.storageDir}; schema ${r.schemaVersion}`,
        ...(r.previousMovedTo ? [`previous state moved to ${r.previousMovedTo}`] : []),
        ...(r.leasesReleased ? [`${r.leasesReleased} task(s) were running at backup time; the next worker recovers them`] : []),
        `brain: ${r.brain.detail}`,
        ...(r.brain.previousMovedTo ? [`previous brain moved to ${r.brain.previousMovedTo}`] : []),
        ...(r.manifest.brain?.mountsNotIncluded ?? []).map((x) => `brain mount ${x.prefix} was not in the backup: restore ${x.path} from its own repository`),
      ].join("\n"), json);
      return 0;
    }
    case "daemon":
      return daemonCommand(args, values, cfg, json, cliPath);
    case "service": {
      const action = ServiceActionSchema.safeParse(args[0]);
      if (!action.success) throw new SwitchyardError("usage", "usage: switchyard service install|uninstall|status [--name n] [--dry-run]");
      const platform = ServicePlatformSchema.safeParse(process.platform);
      if (!platform.success) throw new SwitchyardError("usage", `service install supports linux, macOS, and Windows, not ${process.platform}`);
      const user = userInfo();
      const plan = servicePlan({
        platform: platform.data,
        ...(values.name ? { name: values.name } : {}),
        nodePath: process.execPath,
        cliPath,
        configPath: cfg.configPath,
        workingDir: path.dirname(cfg.configPath),
        storageDir: cfg.storageDir,
        logsDir: logsDirFor(cfg.storageDir),
        homeDir: homedir(),
        ...(user.uid >= 0 ? { uid: user.uid } : {}),
        ...(platform.data === "win32" ? { windowsUser: process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${user.username}` : user.username } : {}),
      });
      if (values["dry-run"]) {
        out(json ? { action: action.data, plan } : describeServiceSteps(plan, action.data), json);
        return 0;
      }
      const r = runServiceSteps(plan, action.data);
      const lock = action.data === "status" ? readDaemonLock(logsDirFor(cfg.storageDir)) : null;
      out(json ? { ...r, daemon: lock } : [
        ...r.results.map((x) => `${x.step.kind === "run" ? [x.step.command, ...x.step.args].join(" ") : x.output}${x.code ? ` (exit ${x.code})` : ""}${x.step.kind === "run" && x.output.trim() ? `\n${x.output.trimEnd()}` : ""}`),
        ...(action.data === "status" ? [lock ? `daemon pid ${lock.pid} ${lock.alive ? "running" : "not running (stale lock)"} since ${lock.startedAt}` : "no daemon lock for this storage directory"] : []),
        ...(action.data === "install" && r.ok ? [...plan.notes, "The service runs one daemon for the whole install; its worker serves every project."] : []),
      ].join("\n"), json);
      return r.ok ? 0 : 1;
    }
    default:
      throw new SwitchyardError("usage", `unknown operations command ${cmd}`);
  }
}

/** `daemon [run] | start | status | stop`: one daemon per install, one worker for every project. */
async function daemonCommand(args: string[], values: OperationsFlags, cfg: ResolvedConfig, json: boolean, cliPath: string): Promise<number> {
  const sub = args[0] ?? "run";
  const logsDir = logsDirFor(cfg.storageDir);
  const slugs = () => cfg.projectResolution.projects.map((p) => p.slug).join(", ");
  switch (sub) {
    case "run": {
      const seconds = (name: string, v: string | undefined) => (v === undefined ? undefined : countFlag(name, v, 1)! * 1000);
      const maxRestarts = countFlag("max-restarts", values["max-restarts"], 1);
      const windowMs = seconds("window", values.window);
      const maxDelayMs = seconds("max-delay", values["max-delay"]);
      const release = acquireDaemonLock(logsDir, cfg.configPath);
      const daemon = new Daemon({
        command: process.execPath,
        args: [...process.execArgv, cliPath, "worker", "--config", cfg.configPath],
        cwd: path.dirname(cfg.configPath),
        logsDir,
        env: workerEnv(),
        policy: { ...(maxRestarts ? { maxRestarts } : {}), ...(windowMs ? { windowMs } : {}), ...(maxDelayMs ? { maxDelayMs } : {}) },
      });
      const stop = () => void daemon.stop();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      out(`daemon ${process.pid} supervising one worker for every project (${slugs()}); logs in ${logsDir}; Ctrl+C or switchyard daemon stop to stop`, false);
      try {
        const r = await daemon.run();
        out(json ? r : `daemon ${r.reason}: ${r.detail}`, json);
        return r.reason === "gave_up" ? 1 : 0;
      } finally {
        release();
      }
    }
    case "start": {
      const running = readDaemonLock(logsDir);
      if (running?.alive) throw new SwitchyardError("conflict", `a daemon (pid ${running.pid}, started ${running.startedAt}) is already running for ${cfg.storageDir}; see switchyard daemon status`);
      mkdirSync(logsDir, { recursive: true });
      const outFile = path.join(logsDir, DAEMON_OUT);
      const fd = openSync(outFile, "a");
      const passOn = (["max-restarts", "window", "max-delay"] as const).flatMap((k) => (values[k] === undefined ? [] : [`--${k}`, values[k]!]));
      const child = spawn(process.execPath, [...process.execArgv, cliPath, "daemon", "run", "--config", cfg.configPath, ...passOn], {
        cwd: path.dirname(cfg.configPath),
        env: workerEnv(),
        detached: true,
        stdio: ["ignore", fd, fd],
        windowsHide: true,
      });
      closeSync(fd);
      let exited: number | null = null;
      child.once("exit", (code) => (exited = code ?? -1));
      child.unref();
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && exited === null) {
        const lock = readDaemonLock(logsDir);
        if (lock?.alive && lock.pid === child.pid) {
          out(json ? { started: true, pid: lock.pid, logsDir, output: outFile } : `daemon ${lock.pid} started in the background: one worker for every project (${slugs()}); logs in ${logsDir}; stop it with switchyard daemon stop`, json);
          return 0;
        }
        await sleep(200);
      }
      out(json ? { started: false, exitCode: exited, output: tail(outFile) } : `the daemon did not start${exited !== null ? ` (exit ${exited})` : " within 20s"}; its output (${outFile}):\n${tail(outFile)}`, json);
      return 1;
    }
    case "status": {
      const s = daemonStatus(cfg);
      if (json) {
        out(s, true);
        return 0;
      }
      const d = s.daemon;
      out([
        d ? `daemon pid ${d.pid} ${d.alive ? "running" : "not running (stale lock)"} since ${d.startedAt}; config ${d.configPath}` : `no daemon is running for ${s.storageDir}`,
        "one worker serves every project; queued and running tasks by project:",
        table(s.projects.map((p) => ({ project: p.project, name: p.name ?? (p.configured ? "" : "(internal or removed)"), archived: p.archived ? "yes" : "", queued: p.queued, running: p.running }))),
        `total: ${s.totals.queued} queued, ${s.totals.running} running`,
      ].join("\n"), false);
      return 0;
    }
    case "stop": {
      const lock = readDaemonLock(logsDir);
      if (!lock?.alive) {
        out(json ? { stopped: false, reason: "not running" } : `no daemon is running for ${cfg.storageDir}`, json);
        return 0;
      }
      requestDaemonStop(logsDir);
      // The daemon gives its worker up to 30s to stop before killing it.
      const waitMs = (countFlag("timeout", values.timeout, 1) ?? 45) * 1000;
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline && processAlive(lock.pid)) await sleep(250);
      if (!processAlive(lock.pid)) {
        out(json ? { stopped: true, pid: lock.pid, forced: false } : `daemon ${lock.pid} stopped`, json);
        return 0;
      }
      // An unresponsive daemon (or one from an older build that does not poll): end its process tree.
      try {
        if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(lock.pid), "/T", "/F"], { stdio: "pipe", windowsHide: true });
        else process.kill(lock.pid, "SIGTERM");
      } catch {
        // already gone
      }
      out(json ? { stopped: true, pid: lock.pid, forced: true } : `daemon ${lock.pid} did not stop within ${waitMs / 1000}s; its process was ended (the worker's tasks are recovered on the next start)`, json);
      return 0;
    }
    default:
      throw new SwitchyardError("usage", "usage: switchyard daemon [run|start|status|stop] [--max-restarts n] [--window s] [--max-delay s] [--timeout s]");
  }
}
