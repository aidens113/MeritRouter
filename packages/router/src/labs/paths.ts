import path from "node:path";
import { lstatSync } from "node:fs";
/** Reject traversal and existing symlink/reparse-point ancestors before destructive operations. */
export function labOwnedPath(storageDir: string, target: string): string {
  const root = path.resolve(storageDir, "labs");
  const resolved = path.resolve(target);
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel))
    throw new Error("lab path is outside the managed labs directory");
  let current = path.parse(resolved).root;
  for (const part of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error("lab paths cannot contain symbolic links");
      if (current !== resolved && !stat.isDirectory()) throw new Error("lab path ancestor is not a directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
  return resolved;
}
