import { realpath } from "node:fs/promises";
import path from "node:path";
import { git } from "./git.js";

/**
 * One `rev-parse` that both locates a repository's Git metadata and proves the directory asked
 * about is that repository's own root. Git discovery walks up from any directory, so a folder
 * that is not a repository silently resolves to an enclosing one (a user's home folder can be a
 * repository). Every MeritRouter effect on Git metadata (locks, receipts, info/exclude) must be
 * bound to an authorized root, never to whatever repository happens to enclose it.
 */
export const EXACT_ROOT_REV_PARSE = ["rev-parse", "--absolute-git-dir", "--git-common-dir", "--is-bare-repository", "--is-inside-git-dir", "--is-inside-work-tree", "--show-prefix"] as const;

export interface ExactRepositoryRoot { gitDirectory: string; commonDirectory: string; bare: boolean }

export class EnclosingRepositoryError extends Error {
  constructor(readonly root: string) {
    super(`${root} is not a Git repository root; MeritRouter never acts on an enclosing repository`);
    this.name = "EnclosingRepositoryError";
  }
}

const key = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);

/** Parse {@link EXACT_ROOT_REV_PARSE} output for `root` (already physical); throws unless exact. */
export async function parseExactRepositoryRoot(root: string, output: string): Promise<ExactRepositoryRoot> {
  const lines = output.split(/\r?\n/);
  if (lines.length < 6 || !lines[0]!.trim() || !lines[1]!.trim()) throw new EnclosingRepositoryError(root);
  const gitDirectory = path.resolve(root, lines[0]!.trim()), commonDirectory = path.resolve(root, lines[1]!.trim());
  const bare = lines[2]!.trim() === "true", insideGitDirectory = lines[3]!.trim() === "true", insideWorkTree = lines[4]!.trim() === "true", prefix = lines[5]!.trim();
  if (bare) {
    // A bare repository's root is its Git directory itself, never a directory inside it.
    if (key(await realpath(gitDirectory)) !== key(await realpath(root))) throw new EnclosingRepositoryError(root);
  } else if (insideGitDirectory || !insideWorkTree || prefix !== "") throw new EnclosingRepositoryError(root);
  return { gitDirectory, commonDirectory, bare };
}

/** Resolve `root`'s Git metadata, refusing a directory that is not exactly a repository root. */
export async function exactRepositoryRoot(root: string): Promise<ExactRepositoryRoot> {
  let output: string;
  try { output = await git(root, [...EXACT_ROOT_REV_PARSE]); }
  catch { throw new EnclosingRepositoryError(root); }
  return parseExactRepositoryRoot(root, output);
}

/** True when `root` is itself a repository root (never an enclosing repository's subfolder). */
export async function isExactRepositoryRoot(root: string): Promise<boolean> {
  try { await exactRepositoryRoot(root); return true; } catch { return false; }
}
