import { execFile } from "node:child_process";
import { prepareGitProcess } from "./git-process-policy.js";
import { promisify } from "node:util";
import { runGitIndexCommand, type GitIndexCapability } from "./git-index-transaction.js";

const execFileAsync = promisify(execFile);

export class GitError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message);
  }
}

/** Run git without a shell. Output is capped; callers truncate further as needed. */
export function git(cwd: string, args: string[], opts: { maxBuffer?: number; allowExit?: number[]; env?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number; index?: GitIndexCapability; input?: string } = {}): Promise<string> {
  const run = async () => {
    try {
      const processPolicy = prepareGitProcess(cwd, args, opts.env, opts.index);
      if (opts.input !== undefined) {
        const apply = !!opts.index && args.join("\0") === ["apply", "--cached", "--binary", "--whitespace=nowarn", "-"].join("\0");
        const object = (value: string | undefined) => !!value && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
        const message = !opts.index && args[0] === "commit-tree" && object(args[1]) && (args.length === 2 || args.length === 4 && args[2] === "-p" && object(args[3]));
        if ((!apply && !message) || Buffer.byteLength(opts.input) > (apply ? 32 * 1024 * 1024 : 65536)) throw new Error("Git stdin requires exact bounded cached-apply or commit-message plumbing");
      }
      const running = execFileAsync("git", processPolicy.args, {
        cwd,
        maxBuffer: opts.index ? Math.min(opts.maxBuffer ?? 32 * 1024 * 1024, 32 * 1024 * 1024) : opts.maxBuffer ?? 32 * 1024 * 1024,
        windowsHide: true,
        env: processPolicy.env,
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.index ? { timeout: Math.min(opts.timeoutMs ?? 10000, 10000) } : opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
      });
      if (opts.input !== undefined) { running.child.stdin?.on("error", () => {}); running.child.stdin?.end(opts.input); }
      const { stdout } = await running;
      return stdout;
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { code?: number | string; stdout?: string; stderr?: string };
      const code = typeof e.code === "number" ? e.code : null;
      if (code !== null && opts.allowExit?.includes(code)) return e.stdout ?? "";
      throw new GitError(`git ${args[0]} failed in ${cwd}: ${(e.stderr ?? e.message).trim()}`, code, e.stderr ?? "");
    }
  };
  return opts.index === undefined ? run() : runGitIndexCommand(opts.index, run);
}

export async function headSha(repo: string): Promise<string> {
  return (await git(repo, ["rev-parse", "HEAD"])).trim();
}

export async function resolveCommit(repo: string, rev: string): Promise<string> {
  return (await git(repo, ["rev-parse", "--verify", `${rev}^{commit}`])).trim();
}

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    return (await git(dir, ["rev-parse", "--is-inside-work-tree"])).trim() === "true";
  } catch {
    return false;
  }
}

/** Paths with uncommitted changes (tracked or untracked), relative to the repo root. */
export async function dirtyPaths(repo: string, opts: {signal?:AbortSignal;timeoutMs?:number} = {}): Promise<string[]> {
  const out = await git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"],opts);
  const entries = out.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const status = e.slice(0, 2);
    paths.push(e.slice(3));
    if (status[0] === "R" || status[0] === "C") i++; // rename source follows
  }
  return paths;
}
