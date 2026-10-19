import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { SwitchyardError } from "../core/errors.js";

/**
 * `switchyard service install | uninstall | status`: registers `switchyard daemon` with the
 * platform's per-user service manager, so the worker starts at logon and restarts on failure.
 * - Linux: a systemd user unit (`~/.config/systemd/user/<name>.service`).
 * - macOS: a launchd agent (`~/Library/LaunchAgents/dev.switchyard.<name>.plist`).
 * - Windows: a Task Scheduler task registered with `schtasks /XML` (logon trigger for the current
 *   user, least privilege, restart on failure), so no administrator rights are needed.
 * A plan is pure data; `--dry-run` prints it, and only `runServiceSteps` touches the system.
 */

export const ServicePlatformSchema = z.enum(["linux", "darwin", "win32"]);
export type ServicePlatform = z.infer<typeof ServicePlatformSchema>;
export const ServiceActionSchema = z.enum(["install", "uninstall", "status"]);
export type ServiceAction = z.infer<typeof ServiceActionSchema>;

export const ServiceSpecSchema = z
  .object({
    platform: ServicePlatformSchema,
    /** Service, unit, or task name. */
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "letters, digits, '.', '_', '-' (max 64)").default("switchyard"),
    nodePath: z.string().min(1),
    cliPath: z.string().min(1),
    configPath: z.string().min(1),
    /** Working directory of the daemon (the config file's directory). */
    workingDir: z.string().min(1),
    /** `<storage>`: Windows keeps the task XML under `<storage>/service/`. */
    storageDir: z.string().min(1),
    logsDir: z.string().min(1),
    homeDir: z.string().min(1),
    /** macOS: the user id for `gui/<uid>`. */
    uid: z.number().int().nonnegative().optional(),
    /** Windows: `DOMAIN\user` the logon trigger and principal run as. */
    windowsUser: z.string().min(1).optional(),
  })
  .strict();
export type ServiceSpec = z.input<typeof ServiceSpecSchema>;

export type ServiceStep =
  | { kind: "write_file"; path: string; content: string; encoding: "utf8" | "utf16le" }
  | { kind: "remove_file"; path: string }
  | { kind: "run"; command: string; args: string[]; allowFailure: boolean };

export interface ServicePlan {
  platform: ServicePlatform;
  name: string;
  /** The unit file, plist, or task XML. */
  definitionPath: string;
  definition: string;
  install: ServiceStep[];
  uninstall: ServiceStep[];
  status: ServiceStep[];
  notes: string[];
}

const run = (command: string, args: string[], allowFailure = false): ServiceStep => ({ kind: "run", command, args, allowFailure });

const daemonArgs = (s: z.infer<typeof ServiceSpecSchema>) => [s.cliPath, "daemon", "--config", s.configPath];

/** systemd `ExecStart` word: always quoted; `\`, `"`, and `%` escaped. */
function systemdWord(word: string): string {
  return `"${word.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
}

function xml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** One Windows command-line argument, quoted per the MSVC runtime rules. */
function windowsArg(arg: string): string {
  if (arg && !/[\s"]/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

function systemdPlan(s: z.infer<typeof ServiceSpecSchema>): ServicePlan {
  const unit = `${s.name}.service`;
  const definitionPath = path.posix.join(s.homeDir.split(path.sep).join("/"), ".config", "systemd", "user", unit);
  const definition = [
    "[Unit]",
    "Description=SwitchYard daemon (worker under a restart policy)",
    "After=network-online.target",
    "StartLimitIntervalSec=600",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${systemdWord(s.workingDir)}`,
    `ExecStart=${[s.nodePath, ...daemonArgs(s)].map(systemdWord).join(" ")}`,
    "Restart=on-failure",
    "RestartSec=30",
    "KillSignal=SIGTERM",
    "TimeoutStopSec=60",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
  return {
    platform: "linux",
    name: s.name,
    definitionPath,
    definition,
    install: [
      { kind: "write_file", path: definitionPath, content: definition, encoding: "utf8" },
      run("systemctl", ["--user", "daemon-reload"]),
      run("systemctl", ["--user", "enable", "--now", unit]),
    ],
    uninstall: [run("systemctl", ["--user", "disable", "--now", unit], true), { kind: "remove_file", path: definitionPath }, run("systemctl", ["--user", "daemon-reload"])],
    status: [run("systemctl", ["--user", "status", unit, "--no-pager"], true)],
    notes: ["To keep the worker running while you are logged out: loginctl enable-linger $USER"],
  };
}

function launchdPlan(s: z.infer<typeof ServiceSpecSchema>): ServicePlan {
  const label = `dev.switchyard.${s.name}`;
  const definitionPath = path.posix.join(s.homeDir.split(path.sep).join("/"), "Library", "LaunchAgents", `${label}.plist`);
  const logFile = path.join(s.logsDir, "launchd.log");
  const definition = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <key>Label</key><string>${xml(label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...[s.nodePath, ...daemonArgs(s)].map((a) => `    <string>${xml(a)}</string>`),
    "  </array>",
    `  <key>WorkingDirectory</key><string>${xml(s.workingDir)}</string>`,
    "  <key>RunAtLoad</key><true/>",
    "  <key>KeepAlive</key>",
    "  <dict><key>SuccessfulExit</key><false/></dict>",
    "  <key>ThrottleInterval</key><integer>30</integer>",
    `  <key>StandardOutPath</key><string>${xml(logFile)}</string>`,
    `  <key>StandardErrorPath</key><string>${xml(logFile)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
  if (s.uid === undefined) throw new SwitchyardError("usage", "a launchd agent needs the user id (uid) for its gui/<uid> domain");
  const domain = `gui/${s.uid}`;
  return {
    platform: "darwin",
    name: s.name,
    definitionPath,
    definition,
    install: [{ kind: "write_file", path: definitionPath, content: definition, encoding: "utf8" }, run("launchctl", ["bootstrap", domain, definitionPath])],
    uninstall: [run("launchctl", ["bootout", `${domain}/${label}`], true), { kind: "remove_file", path: definitionPath }],
    status: [run("launchctl", ["print", `${domain}/${label}`], true)],
    notes: [],
  };
}

function windowsPlan(s: z.infer<typeof ServiceSpecSchema>): ServicePlan {
  const user = s.windowsUser ?? "";
  const definitionPath = path.win32.join(s.storageDir, "service", `${s.name}.xml`);
  const userId = user ? `<UserId>${xml(user)}</UserId>` : "";
  const definition = [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <RegistrationInfo>",
    "    <Description>SwitchYard daemon (worker under a restart policy)</Description>",
    "  </RegistrationInfo>",
    "  <Triggers>",
    `    <LogonTrigger><Enabled>true</Enabled>${userId}</LogonTrigger>`,
    "  </Triggers>",
    "  <Principals>",
    `    <Principal id="Author">${userId}<LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>`,
    "  </Principals>",
    "  <Settings>",
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "    <AllowHardTerminate>true</AllowHardTerminate>",
    "    <StartWhenAvailable>true</StartWhenAvailable>",
    "    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>",
    "    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>",
    "    <AllowStartOnDemand>true</AllowStartOnDemand>",
    "    <Enabled>true</Enabled>",
    "    <Hidden>false</Hidden>",
    "    <RunOnlyIfIdle>false</RunOnlyIfIdle>",
    "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
    "    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>",
    "  </Settings>",
    '  <Actions Context="Author">',
    "    <Exec>",
    `      <Command>${xml(s.nodePath)}</Command>`,
    `      <Arguments>${xml(daemonArgs(s).map(windowsArg).join(" "))}</Arguments>`,
    `      <WorkingDirectory>${xml(s.workingDir)}</WorkingDirectory>`,
    "    </Exec>",
    "  </Actions>",
    "</Task>",
    "",
  ].join("\r\n");
  return {
    platform: "win32",
    name: s.name,
    definitionPath,
    definition,
    install: [
      { kind: "write_file", path: definitionPath, content: definition, encoding: "utf16le" },
      run("schtasks", ["/Create", "/TN", s.name, "/XML", definitionPath, "/F"]),
      run("schtasks", ["/Run", "/TN", s.name]),
    ],
    uninstall: [run("schtasks", ["/End", "/TN", s.name], true), run("schtasks", ["/Delete", "/TN", s.name, "/F"]), { kind: "remove_file", path: definitionPath }],
    status: [run("schtasks", ["/Query", "/TN", s.name, "/V", "/FO", "LIST"], true)],
    notes: ["The task runs at your logon with your rights (no administrator needed) and restarts every minute on failure."],
  };
}

/** Build the service definition and the steps for each action. Pure: touches nothing. */
export function servicePlan(input: ServiceSpec): ServicePlan {
  const s = ServiceSpecSchema.parse(input);
  if (s.platform === "linux") return systemdPlan(s);
  if (s.platform === "darwin") return launchdPlan(s);
  return windowsPlan(s);
}

/** Human-readable dry run: the definition and every step, without running anything. */
export function describeServiceSteps(plan: ServicePlan, action: ServiceAction): string {
  const lines = [`# ${action} ${plan.name} (${plan.platform})`];
  for (const step of plan[action]) {
    if (step.kind === "write_file") lines.push(`write ${step.path} (${step.encoding}):`, step.content.replace(/\r\n/g, "\n").trimEnd(), "");
    else if (step.kind === "remove_file") lines.push(`remove ${step.path}`);
    else lines.push(`run ${[step.command, ...step.args].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}${step.allowFailure ? "   (failure tolerated)" : ""}`);
  }
  for (const n of plan.notes) lines.push(`# note: ${n}`);
  return lines.join("\n");
}

export interface ServiceIo {
  run(command: string, args: string[]): { code: number; output: string };
  writeFile(file: string, content: string, encoding: "utf8" | "utf16le"): void;
  removeFile(file: string): void;
}

export const systemServiceIo: ServiceIo = {
  run(command, args) {
    try {
      return { code: 0, output: execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }) };
    } catch (err) {
      const e = err as { status?: number | null; stdout?: string; stderr?: string; message: string };
      return { code: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` || e.message };
    }
  },
  writeFile(file, content, encoding) {
    mkdirSync(path.dirname(file), { recursive: true });
    // Task Scheduler reads UTF-16 XML reliably only with a byte-order mark.
    writeFileSync(file, encoding === "utf16le" ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, "utf16le")]) : content);
  },
  removeFile(file) {
    rmSync(file, { force: true });
  },
};

export interface ServiceStepResult {
  step: ServiceStep;
  code: number;
  output: string;
}

/** Execute an action's steps in order; a failing step that is not tolerated stops the run. */
export function runServiceSteps(plan: ServicePlan, action: ServiceAction, io: ServiceIo = systemServiceIo): { ok: boolean; results: ServiceStepResult[] } {
  const results: ServiceStepResult[] = [];
  for (const step of plan[action]) {
    if (step.kind === "write_file") {
      io.writeFile(step.path, step.content, step.encoding);
      results.push({ step, code: 0, output: `wrote ${step.path}` });
    } else if (step.kind === "remove_file") {
      io.removeFile(step.path);
      results.push({ step, code: 0, output: `removed ${step.path}` });
    } else {
      const r = io.run(step.command, step.args);
      results.push({ step, ...r });
      if (r.code !== 0 && !step.allowFailure) return { ok: false, results };
    }
  }
  return { ok: true, results };
}
