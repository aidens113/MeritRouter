import path from "node:path";
import { existsSync, lstatSync } from "node:fs";
/** Reject traversal and existing symlink/reparse-point ancestors before destructive operations. */
export function labOwnedPath(storageDir: string, target: string): string {
  const root = path.resolve(storageDir, "labs");
  const resolved = path.resolve(target);
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel))
    throw new Error("lab path is outside the managed labs directory");
  let current = root;
  if (existsSync(root) && lstatSync(root).isSymbolicLink())
    throw new Error("labs directory cannot be a symbolic link");
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink())
      throw new Error("lab paths cannot contain symbolic links");
  }
  return resolved;
}
