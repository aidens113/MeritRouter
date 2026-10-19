import { spawn, execFile, type ChildProcess } from "node:child_process";

/** Environment variables a coding agent may inherit. Provider credentials are never passed. */
const PASS_THROUGH = ["PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "COMSPEC", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "TERM", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"];

export function minimalEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of PASS_THROUGH) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return { ...env, ...extra };
}

/** Terminate a process and everything it spawned. */
export function killTree(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.pid === undefined) return resolve();
    if (process.platform === "win32") {
      execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => resolve());
    } else {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      const t = setTimeout(() => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          // already gone
        }
        resolve();
      }, 3000);
      child.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    }
  });
}

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  killed: string | null;
  durationMs: number;
}

const CAP = 4 * 1024 * 1024;

/** Quote one argument for the platform shell (cmd.exe on Windows, sh elsewhere). */
export function quoteShellArg(arg: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return `"${arg.replace(/"/g, '""')}"`;
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

/** Quote an executable path when it contains spaces (e.g. C:\Program Files\...). */
function quoteCommand(command: string): string {
  return /\s/.test(command) && !/^["']/.test(command) ? quoteShellArg(command) : command;
}

/** Run a command with a timeout and abort signal; output is captured (capped). */
export function runProcess(
  command: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; timeoutMs: number; signal?: AbortSignal; shell?: boolean; stdin?: string },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    // With a shell, Node joins arguments unquoted; quote them so paths with spaces survive.
    const shellLine = opts.shell && args.length ? [quoteCommand(command), ...args.map((a) => quoteShellArg(a))].join(" ") : null;
    const child = spawn(shellLine ?? command, shellLine ? [] : args, {
      cwd: opts.cwd,
      env: opts.env,
      shell: opts.shell ?? false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let killed: string | null = null;
    child.stdout?.on("data", (d: Buffer) => {
      if (stdout.length < CAP) stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < CAP) stderr += d.toString("utf8");
    });
    if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
    else child.stdin?.end();
    const stop = (why: string) => {
      if (killed) return;
      killed = why;
      void killTree(child);
    };
    const timer = setTimeout(() => stop("timeout"), opts.timeoutMs);
    const onAbort = () => stop(String(opts.signal?.reason ?? "aborted"));
    opts.signal?.addEventListener("abort", onAbort);
    if (opts.signal?.aborted) onAbort();
    child.on("error", (err) => {
      stderr += `\n${err.message}`;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ exitCode: code, stdout, stderr, killed, durationMs: Date.now() - started });
    });
  });
}
