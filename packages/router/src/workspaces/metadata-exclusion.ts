import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { isProjectMetadataPath } from "../projects/metadata-policy.js";
import { git } from "./git.js";
import { EnclosingRepositoryError, exactRepositoryRoot } from "./repository-root.js";

const IGNORE_PATTERN = ".[mM][eE][rR][iI][tT][rR][oO][uU][tT][eE][rR]/";
const MAX_EXCLUDE_BYTES = 1024 * 1024;
const LOCK_WAIT_MS = 2000;

/** Read-only preflight. Existing tracked/indexed private state needs explicit migration. */
export async function assertNoTrackedProjectMetadata(repo: string): Promise<void> {
  const staged = await git(repo, ["ls-files", "--stage", "-z"]);
  for (const entry of staged.split("\0").filter(Boolean)) {
    const match = /^([0-7]{6}) ([a-f0-9]{40,64}) ([0-3])\t([\s\S]+)$/.exec(entry);
    if (!match) throw new Error("Cannot validate repository index entries");
    if (isProjectMetadataPath(match[4]!)) throw new Error("Private MeritRouter metadata is already indexed; explicit migration is required");
    if (match[3] !== "0") throw new Error("Cannot validate an unmerged repository index");
  }
  const head = (await git(repo, ["rev-parse", "--verify", "-q", "HEAD^{commit}"], { allowExit: [1] })).trim();
  if (!head) {
    // Only a valid symbolic HEAD whose target does not exist is an unborn repository.
    const ref = (await git(repo, ["symbolic-ref", "-q", "HEAD"])).trim();
    if (!ref.startsWith("refs/heads/")) throw new Error("Cannot establish an unborn repository HEAD");
    const raw = (await git(repo, ["show-ref", "--heads"], { allowExit: [1] })).trim();
    const branches = raw ? raw.split(/\r?\n/) : [];
    if (branches.some(line => !/^[a-f0-9]{40,64} refs\/heads\/\S+$/.test(line))) throw new Error("Cannot validate unborn repository branch references");
    if (branches.some(line => line.endsWith(` ${ref}`))) throw new Error("Repository HEAD cannot resolve its existing branch");
    return;
  }
  const tracked = await git(repo, ["ls-tree", "-r", "--name-only", "-z", head]);
  if (tracked.split("\0").filter(Boolean).some(isProjectMetadataPath)) {
    throw new Error("Private MeritRouter metadata is already tracked; explicit migration is required");
  }
}

function samePath(left: string, right: string): boolean {
  const normalized = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalized(left) === normalized(right);
}

async function directoryChain(directory: string): Promise<void> {
  const absolute = path.resolve(directory), root = path.parse(absolute).root;
  let current = root;
  for (const component of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Git metadata directory has a linked or non-directory ancestor");
  }
}

async function existingExclude(file: string): Promise<Buffer> {
  try {
    const stat = await lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) throw new Error("Git exclude file must be an unlinked regular file");
    if (stat.size > MAX_EXCLUDE_BYTES) throw new Error("Git exclude file exceeds the supported size limit");
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Buffer.alloc(0);
    throw error;
  }
}

async function excludeLocation(repo: string): Promise<{ common: string; info: string; exclude: string }> {
  // Only the authorized root's own repository: a folder inside an enclosing repository (a home
  // folder can be one) must never gain an exclude rule there.
  const owner = await exactRepositoryRoot(repo);
  if (owner.bare) throw new EnclosingRepositoryError(repo);
  const gitDir = owner.gitDirectory, common = owner.commonDirectory;
  const excludeRaw = (await git(repo, ["rev-parse", "--git-path", "info/exclude"])).trim();
  const exclude = path.resolve(repo, excludeRaw), info = path.join(common, "info");
  if (!samePath(exclude, path.join(info, "exclude"))) throw new Error("Git exclude location is outside its common metadata directory");
  const relative = path.relative(common, gitDir).split(path.sep);
  if (!samePath(gitDir, common) && !(relative.length === 2 && relative[0] === "worktrees" && relative[1] && relative[1] !== "..")) {
    throw new Error("Git worktree metadata does not belong to its common directory");
  }
  await directoryChain(common);
  await directoryChain(gitDir);
  return { common, info, exclude };
}

/**
 * Establish Git-local ignore only; never stages, cleans an index, rewrites history or grants
 * command access. Linked worktrees serialize on their shared info/exclude.lock. Link checks
 * are bounded preflight, not race-free authorization against an actively hostile filesystem.
 */
export async function ensureProjectMetadataExcluded(repo: string): Promise<void> {
  const location = await excludeLocation(repo);
  await assertNoTrackedProjectMetadata(repo);
  try {
    await directoryChain(location.info);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(location.info).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
    await directoryChain(location.info);
  }
  await existingExclude(location.exclude);
  const lock = `${location.exclude}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let handle: Awaited<ReturnType<typeof open>>;
  for (;;) {
    try {
      handle = await open(lock, "wx", 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error("Git exclude lock is busy; foreign locks are preserved");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  const owned = await handle.stat();
  let closed = false;
  try {
    await directoryChain(location.common);
    await directoryChain(location.info);
    await assertNoTrackedProjectMetadata(repo);
    const before = await existingExclude(location.exclude);
    // Later rules can negate an earlier owned pattern. Reassert it at the end rather than
    // mistaking historical presence for effective ordering within info/exclude.
    const lastRule = before.toString("utf8").split(/\r?\n/).filter(line => line && !line.startsWith("#")).at(-1);
    if (lastRule === IGNORE_PATTERN) return;
    const newline = before.includes(Buffer.from("\r\n")) ? "\r\n" : "\n";
    const separator = before.length && before[before.length - 1] !== 10 ? newline : "";
    const after = Buffer.concat([before, Buffer.from(`${separator}# MeritRouter private project metadata${newline}${IGNORE_PATTERN}${newline}`)]);
    if (after.length > MAX_EXCLUDE_BYTES) throw new Error("Updated Git exclude file exceeds the supported size limit; nothing published");
    await handle.writeFile(after);
    await handle.sync();
    await handle.close(); closed = true;
    const current = await lstat(lock);
    if (current.dev !== owned.dev || current.ino !== owned.ino || current.isSymbolicLink()) throw new Error("Git exclude lock ownership changed");
    await rename(lock, location.exclude);
  } finally {
    if (!closed) await handle.close();
    try {
      const current = await lstat(lock);
      if (current.dev === owned.dev && current.ino === owned.ino && !current.isSymbolicLink()) await unlink(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
