import { homedir, userInfo } from "node:os";
import path from "node:path";
import type { ResolvedConfig } from "../config/load.js";
import { SwitchyardError } from "../core/errors.js";
import { backupStorage, restoreStorage } from "../operations/backup.js";
import { Daemon, acquireDaemonLock, logsDirFor, readDaemonLock } from "../operations/daemon.js";
import { ServiceActionSchema, ServicePlatformSchema, describeServiceSteps, runServiceSteps, servicePlan } from "../operations/service.js";
import { countFlag } from "./args.js";
import { out } from "./terminal.js";

// Operations commands (backup, restore, daemon, service). They work on the storage directory
// directly and never open a Switchyard: restore replaces the database, and the daemon's worker
// runs in a child process.

export interface OperationsFlags {
  force?: boolean;
  "include-master-key"?: boolean;
  "dry-run"?: boolean;
  "max-restarts"?: string;
  window?: string;
  "max-delay"?: string;
  name?: string;
}

/** `cliPath` is the CLI entry point (dist/cli.js) the daemon and the service run. */
export async function operationsCommand(cmd: string, args: string[], values: OperationsFlags, cfg: ResolvedConfig, json: boolean, cliPath: string): Promise<number> {
  switch (cmd) {
    case "backup": {
      if (!args[0]) throw new SwitchyardError("usage", "usage: switchyard backup <dir> [--include-master-key]");
      const m = await backupStorage({ storageDir: cfg.storageDir, targetDir: args[0], includeMasterKey: values["include-master-key"] ?? false });
      out(json ? m : [
        `backed up ${cfg.storageDir} to ${path.resolve(args[0])}`,
        `schema ${m.schemaVersion}; ${m.tasks} task(s), ${m.sessions} session(s) with ${m.sessionLogs} log(s), ${m.artifacts} artifact(s)`,
        m.includesMasterKey ? "includes the vault master key: keep this backup private" : "the vault master key is not included; provider keys in the vault need SWITCHYARD_MASTER_KEY or the original .master-key to decrypt",
        ...m.missing.map((f) => `MISSING ${f}`),
      ].join("\n"), json);
      return m.missing.length ? 1 : 0;
    }
    case "restore": {
      if (!args[0]) throw new SwitchyardError("usage", "usage: switchyard restore <dir> [--force]");
      const r = restoreStorage({ backupDir: args[0], storageDir: cfg.storageDir, force: values.force ?? false });
      out(json ? r : [
        `restored ${path.resolve(args[0])} (taken ${r.manifest.createdAt}) into ${r.storageDir}; schema ${r.schemaVersion}`,
        ...(r.previousMovedTo ? [`previous state moved to ${r.previousMovedTo}`] : []),
        ...(r.leasesReleased ? [`${r.leasesReleased} task(s) were running at backup time; the next worker recovers them`] : []),
      ].join("\n"), json);
      return 0;
    }
    case "daemon": {
      const seconds = (name: string, v: string | undefined) => (v === undefined ? undefined : countFlag(name, v, 1)! * 1000);
      const maxRestarts = countFlag("max-restarts", values["max-restarts"], 1);
      const windowMs = seconds("window", values.window);
      const maxDelayMs = seconds("max-delay", values["max-delay"]);
      const logsDir = logsDirFor(cfg.storageDir);
      const release = acquireDaemonLock(logsDir, cfg.configPath);
      const daemon = new Daemon({
        command: process.execPath,
        args: [...process.execArgv, cliPath, "worker", "--config", cfg.configPath],
        cwd: path.dirname(cfg.configPath),
        logsDir,
        policy: { ...(maxRestarts ? { maxRestarts } : {}), ...(windowMs ? { windowMs } : {}), ...(maxDelayMs ? { maxDelayMs } : {}) },
      });
      const stop = () => void daemon.stop();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      out(`daemon ${process.pid} supervising the worker; logs in ${logsDir}; Ctrl+C to stop`, false);
      try {
        const r = await daemon.run();
        out(json ? r : `daemon ${r.reason}: ${r.detail}`, json);
        return r.reason === "gave_up" ? 1 : 0;
      } finally {
        release();
      }
    }
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
        ...(action.data === "install" && r.ok ? plan.notes : []),
      ].join("\n"), json);
      return r.ok ? 0 : 1;
    }
    default:
      throw new SwitchyardError("usage", `unknown operations command ${cmd}`);
  }
}
