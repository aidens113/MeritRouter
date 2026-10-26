import path from "node:path";
import type { ComposeAuthority } from "./compose-recipe.js";

const privateComponent = /(?:^|[\\/])\.meritrouter(?:[\\/]|$)/i;
const alwaysDenied = /docker\.sock|(?:^|[\\/])\.git(?:[\\/]|$)/i;
const component = /^[a-z0-9][a-z0-9._-]*$/;
const labName = /^[a-z0-9][a-z0-9-]{0,40}$/;
function within(root: string, value: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(value));
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}
function parts(value: string): string[] {
  const resolved = path.resolve(value);
  return resolved.slice(path.parse(resolved).root.length).split(path.sep).filter(Boolean);
}

/**
 * Lexical part of a host-sealed Compose authority. Filesystem validation still refuses
 * symlinks/junctions before Compose reads sources. Private project metadata is never a
 * general bind source: only this exact Lab's declared repos/data subtree is eligible.
 */
export function composeMountPathAllowed(authority: Pick<ComposeAuthority, "labRoot" | "worktree" | "dataRoots">, source: string, target: string): boolean {
  if (alwaysDenied.test(source) || alwaysDenied.test(target) || privateComponent.test(target)) return false;
  if (!privateComponent.test(source)) return true; // Existing nonmetadata authority checks remain in each caller.
  const rootParts = parts(authority.labRoot), indices = rootParts.flatMap((part, index) => part.toLowerCase() === ".meritrouter" ? [index] : []);
  if (indices.length !== 1) return false;
  const index = indices[0]!;
  if (index < 1 || rootParts[index] !== ".MeritRouter" || rootParts.length !== index + 4
    || rootParts[index + 1] !== "labs" || !component.test(rootParts[index + 2]!) || !labName.test(rootParts[index + 3]!)) return false;
  const sourceParts = parts(source);
  if (sourceParts.filter(part => part.toLowerCase() === ".meritrouter").length !== 1) return false;
  const repositories = path.join(authority.labRoot, "repos"), data = path.join(authority.labRoot, "data");
  const worktreeRel = path.relative(repositories, path.resolve(authority.worktree));
  if (!within(repositories, authority.worktree) || !worktreeRel || worktreeRel.includes(path.sep) || !/^[A-Za-z0-9._-]+$/.test(worktreeRel)) return false;
  if (authority.dataRoots.some(root => !within(data, root) || path.resolve(root) === path.resolve(data)
    || privateComponent.test(path.relative(data, root)) || alwaysDenied.test(root))) return false;
  return [authority.worktree, ...authority.dataRoots].some(root => within(root, source))
    && (within(repositories, source) || within(data, source));
}
