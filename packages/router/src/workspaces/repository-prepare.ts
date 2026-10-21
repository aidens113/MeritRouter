import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, open, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { git, GitError } from "./git.js";

// Repository preparation: a project's repository folder is made usable without the user touching
// git. A missing folder is created and initialised with an empty first commit; a plain folder is
// initialised (with a default .gitignore when it has none) and its files committed as a first
// snapshot; a repository without commits gets that snapshot; a repository with history is never
// touched. What is left as an error is what SwitchYard cannot fix itself: git not installed, a
// path that is a file, and permissions. Two folders are refused rather than prepared: one holding
// files another git repository tracks (a monorepo package: a nested repository would split them
// off), and a drive root or the home folder (a first snapshot would commit everything in it).

const execFileAsync = promisify(execFile);

/** What preparation did: created the folder, initialised git in an existing folder, committed a first snapshot in a repository without commits, or nothing. */
export type PrepareAction = "created" | "initialized" | "snapshot" | "unchanged";

/** The problems preparation cannot fix itself. */
export type PrepareErrorKind = "git_missing" | "not_a_folder" | "inside_repository" | "too_broad" | "permission" | "busy" | "git_failed";

export type PrepareResult =
  | { ok: true; path: string; action: PrepareAction; /** A .gitignore was written (initialised folders without one). */ gitignore: boolean; message: string }
  | { ok: false; path: string; error: PrepareErrorKind; message: string };

/** The .gitignore written into a folder that is initialised and has none. */
export const DEFAULT_GITIGNORE = ["node_modules/", ".env", ".env.*", "*.log", "dist/", "build/", ".venv/", "__pycache__/", ".DS_Store", ""].join("\n");

/** The commit identity preparation uses, so it works when the user has no git identity configured. */
const IDENTITY = ["-c", "user.name=SwitchYard", "-c", "user.email=switchyard@localhost", "-c", "commit.gpgsign=false"];
const CREATED_MESSAGE = "SwitchYard: initial commit";
const SNAPSHOT_MESSAGE = "SwitchYard: initial snapshot";

/**
 * What is at a repository folder, from the file system alone (no git process): `missing`,
 * `file`, `folder` (no `.git`), `unborn` (a repository whose HEAD has no commit yet), or
 * `repository` (has history, or a `.git` file such as a linked worktree, which is left alone).
 * `unknown` means the file system could not tell whether HEAD has a commit (git decides).
 */
export type FolderState = "missing" | "file" | "folder" | "unborn" | "repository" | "unknown";

export function folderState(dir: string): FolderState {
  let st;
  try {
    st = statSync(dir);
  } catch {
    return "missing";
  }
  if (!st.isDirectory()) return "file";
  const dotGit = path.join(dir, ".git");
  let g;
  try {
    g = statSync(dotGit);
  } catch {
    return "folder";
  }
  if (!g.isDirectory()) return "repository";
  try {
    const head = readFileSync(path.join(dotGit, "HEAD"), "utf8").trim();
    const m = /^ref:\s*(\S+)$/.exec(head);
    if (!m) return /^[0-9a-f]{40,64}$/i.test(head) ? "repository" : "unknown";
    const ref = m[1]!;
    if (existsSync(path.join(dotGit, ...ref.split("/")))) return "repository";
    let packed = "";
    try {
      packed = readFileSync(path.join(dotGit, "packed-refs"), "utf8");
    } catch {
      packed = "";
    }
    if (packed.split(/\r?\n/).some((l) => l.endsWith(` ${ref}`))) return "repository";
    // The reftable backend keeps refs elsewhere: let git decide.
    if (existsSync(path.join(dotGit, "reftable"))) return "unknown";
    return "unborn";
  } catch {
    return "unknown";
  }
}

const isPermission = (code: unknown, text = "") => code === "EACCES" || code === "EPERM" || /permission denied|access is denied/i.test(text);

function failure(dir: string, error: PrepareErrorKind, detail = ""): PrepareResult {
  const message =
    error === "git_missing"
      ? "git is not installed or not on PATH. Install git (https://git-scm.com/downloads) and restart SwitchYard; the folder is set up automatically after that."
      : error === "not_a_folder"
        ? `${dir} is a file, not a folder. Choose a folder for this repository (a folder that does not exist yet is created).`
        : error === "inside_repository"
          ? `${dir} holds files tracked by the git repository ${detail}. Use ${detail} as the repository, or choose a folder outside it.`
          : error === "too_broad"
            ? `${dir} is ${detail}; SwitchYard will not commit everything in it. Choose the project's own folder.`
            : error === "permission"
          ? `SwitchYard cannot write to ${dir} (permission denied). Give your user account write access to it, or choose a folder you own.`
          : error === "busy"
            ? `Another SwitchYard process is still setting up ${dir}. Try again in a minute.`
            : `git could not set up ${dir}: ${detail || "unknown error"}`;
  return { ok: false, path: dir, error, message };
}

function done(dir: string, action: PrepareAction, gitignore: boolean): PrepareResult {
  const message =
    action === "created"
      ? `SwitchYard created ${dir} and set up git`
      : action === "initialized"
        ? `SwitchYard set up git in ${dir}${gitignore ? ", added a default .gitignore," : ""} and committed a first snapshot`
        : action === "snapshot"
          ? `SwitchYard committed a first snapshot of ${dir} (the repository had no commits)`
          : `${dir} is a git repository`;
  return { ok: true, path: dir, action, gitignore, message };
}

/** Classify a failed git call: permissions, or git failing for another reason (first stderr line). */
function gitFailure(dir: string, err: unknown): PrepareResult {
  const stderr = err instanceof GitError ? err.stderr : "";
  const text = stderr || (err as Error).message;
  if (isPermission((err as NodeJS.ErrnoException).code, text)) return failure(dir, "permission");
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => /^(fatal|error):/i.test(l)) ?? text.split(/\r?\n/)[0]!.trim();
  return failure(dir, "git_failed", line);
}

async function gitAvailable(): Promise<boolean> {
  try {
    await execFileAsync("git", ["--version"], { cwd: tmpdir(), windowsHide: true });
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/** Why a folder is too broad to snapshot (a drive root or the home folder), or null. */
function tooBroad(dir: string): string | null {
  if (path.parse(dir).root === dir) return "the root of a drive";
  const norm = (p: string) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
  return norm(dir) === norm(homedir()) ? "your home folder" : null;
}

/**
 * The working tree of an enclosing git repository that tracks files in `dir` (a monorepo package,
 * say), or null. An enclosing repository that tracks nothing there (a home folder someone ran
 * `git init` in) is no reason to refuse: the new repository simply sits inside it.
 */
async function trackingRepository(dir: string): Promise<string | null> {
  const tracked = await git(dir, ["ls-files", "-z", "--", "."], { allowExit: [128] }).catch(() => "");
  if (!tracked) return null;
  const top = (await git(dir, ["rev-parse", "--show-toplevel"], { allowExit: [128] }).catch(() => "")).trim();
  return top ? path.resolve(top) : null;
}

/** True when HEAD resolves to a commit (git decides, under the lock). */
async function hasCommit(dir: string): Promise<boolean> {
  return (await git(dir, ["rev-parse", "--verify", "-q", "HEAD^{commit}"], { allowExit: [1, 128] })).trim().length > 0;
}

const LOCK_STALE_MS = 120_000;
const LOCK_WAIT_MS = 60_000;

/**
 * Hold a lock on one folder across processes (the panel and a worker may prepare the same
 * folder at once). The lock file lives in the temp folder, never in the repository, so the
 * snapshot cannot include it; it is refreshed while held and taken over once stale.
 */
async function withFolderLock<T>(dir: string, fn: () => Promise<T>): Promise<T | null> {
  const key = process.platform === "win32" ? dir.toLowerCase() : dir;
  const lock = path.join(tmpdir(), `switchyard-prepare-${createHash("sha1").update(key).digest("hex").slice(0, 16)}.lock`);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fh = await open(lock, "wx");
      await fh.writeFile(`${process.pid}\n`);
      await fh.close();
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - (await stat(lock)).mtimeMs > LOCK_STALE_MS) await unlink(lock);
      } catch {
        // Released (or taken over) meanwhile: try again.
      }
      if (Date.now() > deadline) return null;
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 50));
    }
  }
  const touch = setInterval(() => void utimes(lock, new Date(), new Date()).catch(() => undefined), 10_000);
  touch.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(touch);
    await unlink(lock).catch(() => undefined);
  }
}

/**
 * Make `dir` (an absolute path) a git repository with at least one commit. Idempotent: a
 * repository with history is never touched, and two callers preparing the same folder at once
 * (in one process or two) produce one first commit. Commits use SwitchYard's own identity.
 */
export async function prepareRepository(dir: string): Promise<PrepareResult> {
  const abs = path.resolve(dir);
  // Fast path, no git process and no lock: the common case of a repository with history.
  const before = folderState(abs);
  if (before === "repository") return done(abs, "unchanged", false);
  if (before === "file") return failure(abs, "not_a_folder");
  if (!(await gitAvailable())) return failure(abs, "git_missing");
  let locked: PrepareResult | null;
  try {
    locked = await withFolderLock(abs, () => prepareLocked(abs));
  } catch (err) {
    return isPermission((err as NodeJS.ErrnoException).code) ? failure(abs, "permission") : failure(abs, "git_failed", (err as Error).message);
  }
  return locked ?? failure(abs, "busy");
}

/** The preparation itself, under the folder's lock: the state is read again, since another process may have finished first. */
async function prepareLocked(dir: string): Promise<PrepareResult> {
  let state = folderState(dir);
  if (state === "repository") return done(dir, "unchanged", false);
  if (state === "file") return failure(dir, "not_a_folder");
  const broad = state === "missing" ? null : tooBroad(dir);
  if (broad) return failure(dir, "too_broad", broad);
  if (state === "folder") {
    const top = await trackingRepository(dir);
    if (top) return failure(dir, "inside_repository", top);
  }
  let created = false;
  if (state === "missing") {
    try {
      await mkdir(dir, { recursive: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOTDIR" || code === "EEXIST") return failure(dir, "not_a_folder");
      return isPermission(code) ? failure(dir, "permission") : failure(dir, "git_failed", (err as Error).message);
    }
    created = true;
    state = "folder";
  }
  const hadGit = state !== "folder";
  let gitignore = false;
  try {
    if (!hadGit) {
      await git(dir, ["init", "-q"]);
      if (!created && !existsSync(path.join(dir, ".gitignore"))) {
        await writeFile(path.join(dir, ".gitignore"), DEFAULT_GITIGNORE);
        gitignore = true;
      }
    } else if (await hasCommit(dir)) return done(dir, "unchanged", false);
    if (!created) await git(dir, ["add", "-A"]);
    // Re-check under the commit: a commit made meanwhile (outside SwitchYard) wins.
    if (await hasCommit(dir)) return done(dir, "unchanged", false);
    await git(dir, [...IDENTITY, "commit", "-q", "--allow-empty", "-m", created ? CREATED_MESSAGE : SNAPSHOT_MESSAGE]);
  } catch (err) {
    return gitFailure(dir, err);
  }
  return done(dir, created ? "created" : hadGit ? "snapshot" : "initialized", gitignore);
}

/** What preparation would do at a folder, for forms: a neutral hint, or null when it is ready or a problem. */
export function preparationHint(state: FolderState): string | null {
  if (state === "missing") return "will be created and set up with git";
  if (state === "folder") return "git will be set up and the current files committed";
  if (state === "unborn") return "the repository has no commits yet: the current files will be committed";
  return null;
}
