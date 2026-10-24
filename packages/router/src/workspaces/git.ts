import { execFile } from "node:child_process";
import { prepareGitProcess } from "./git-process-policy.js";
import { promisify } from "node:util";

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
export async function git(cwd: string, args: string[], opts: { maxBuffer?: number; allowExit?: number[]; env?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<string> {
  try {
    const processPolicy = prepareGitProcess(cwd, args, opts.env);
    const { stdout } = await execFileAsync("git", processPolicy.args, {
      cwd,
      maxBuffer: opts.maxBuffer ?? 32 * 1024 * 1024,
      windowsHide: true,
      env: processPolicy.env,
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
    });
    return stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { code?: number | string; stdout?: string; stderr?: string };
    const code = typeof e.code === "number" ? e.code : null;
    if (code !== null && opts.allowExit?.includes(code)) return e.stdout ?? "";
    throw new GitError(`git ${args[0]} failed in ${cwd}: ${(e.stderr ?? e.message).trim()}`, code, e.stderr ?? "");
  }
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
