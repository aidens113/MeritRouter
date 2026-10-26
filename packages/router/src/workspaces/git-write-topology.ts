import { lstat, opendir } from "node:fs/promises";
import path from "node:path";
import { git } from "./git.js";

const normalized = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);

async function directoryChain(directory: string): Promise<void> {
  const absolute = path.resolve(directory), root = path.parse(absolute).root;
  let current = root;
  for (const component of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component); const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Git write metadata has a linked/non-directory ancestor");
  }
}

async function optionalNode(file: string, kind: "file" | "directory"): Promise<boolean> {
  try {
    const stat = await lstat(file);
    if (stat.isSymbolicLink() || (kind === "file" ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())) throw new Error("Git write metadata contains a linked or unsafe node");
    return true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/** Scan ref/log topology only, never object contents; bounded by metadata entry count/depth. */
async function namespaceTopology(root: string): Promise<void> {
  if (!await optionalNode(root, "directory")) return;
  const pending = [{ directory: root, depth: 0 }]; let entries = 0;
  while (pending.length) {
    const { directory, depth } = pending.pop()!;
    if (depth > 64) throw new Error("Git ref/log topology exceeds supported depth");
    const handle = await opendir(directory);
    for await (const entry of handle) {
      if (++entries > 20000) throw new Error("Git ref/log topology exceeds supported entry bound");
      const file = path.join(directory, entry.name), stat = await lstat(file);
      if (stat.isSymbolicLink()) throw new Error("Git ref/log write path has a linked ancestor or file");
      if (stat.isDirectory()) pending.push({ directory: file, depth: depth + 1 });
      else if (!stat.isFile() || stat.nlink !== 1) throw new Error("Git ref/log write file has an unsafe type or hardlink");
    }
  }
}

/**
 * Guard the fixed metadata destinations used by owned staging/selected publication. Does not
 * change generic Git authorization or claim race-free protection against hostile path swaps.
 */
export async function assertGitWriteTopology(repo: string): Promise<{ gitDirectory: string; commonDirectory: string }> {
  const gitDirectory = path.resolve((await git(repo, ["rev-parse", "--absolute-git-dir"])).trim());
  const commonDirectory = path.resolve(repo, (await git(repo, ["rev-parse", "--git-common-dir"])).trim());
  await directoryChain(gitDirectory); await directoryChain(commonDirectory);
  const relative = path.relative(commonDirectory, gitDirectory).split(path.sep);
  if (normalized(gitDirectory) !== normalized(commonDirectory) && !(relative.length === 2 && relative[0] === "worktrees" && relative[1] && relative[1] !== "..")) throw new Error("Git worktree metadata has an unexpected common owner");
  const objects = path.resolve(repo, (await git(repo, ["rev-parse", "--git-path", "objects"])).trim());
  if (normalized(objects) !== normalized(path.join(commonDirectory, "objects"))) throw new Error("Git object destination has an unexpected owner");
  await directoryChain(objects);
  for (let bucket = 0; bucket < 256; bucket++) await optionalNode(path.join(objects, bucket.toString(16).padStart(2, "0")), "directory");
  for (const name of ["info", "pack"]) await optionalNode(path.join(objects, name), "directory");
  await optionalNode(path.join(objects, "info", "alternates"), "file");
  for (const file of ["packed-refs", "packed-refs.lock"]) await optionalNode(path.join(commonDirectory, file), "file");
  await namespaceTopology(path.join(commonDirectory, "refs"));
  await namespaceTopology(path.join(commonDirectory, "logs"));
  if (normalized(gitDirectory) !== normalized(commonDirectory)) await namespaceTopology(path.join(gitDirectory, "logs"));
  for (const file of ["HEAD", "HEAD.lock"]) await optionalNode(path.join(gitDirectory, file), "file");
  return { gitDirectory, commonDirectory };
}
