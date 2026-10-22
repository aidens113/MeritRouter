import picomatch from "picomatch";
import { z } from "zod";
import type { WorkerTask } from "../core/task.js";
import type { TaskStore } from "../storage/tasks.js";

const scopeSchema = z.array(z.string().min(1)).max(1000);

/** Conservative proof: never treat overlapping globs as containment. */
function covered(child: string, parent: string): boolean {
  if (/\\|(^|\/)\.\.?($|\/)|^\/|^[A-Za-z]:/.test(child) || child.startsWith("!")) return false;
  if (child === parent || parent === "**" || parent === "**/*") return true;
  if (!picomatch.scan(child).isGlob) return picomatch(parent, { dot: true })(child);
  if (parent.endsWith("/**")) {
    const directory = parent.slice(0, -3);
    if (directory && !picomatch.scan(directory).isGlob && child.startsWith(`${directory}/`)) return true;
  }
  return false;
}

/** Child write permissions must be provably inside every enclosing job's write permission. */
export function narrowedScope(parent: string[] | undefined, requested: unknown): string[] | undefined {
  if (requested === undefined) return parent ? [...parent] : undefined;
  const child = scopeSchema.parse(requested);
  if (parent && child.some(pattern => !parent.some(allowed => covered(pattern, allowed)))) {
    throw new Error(`allowed_paths exceeds parent scope (${parent.join(", ") || "no writable paths"}); use literal files or narrower directory/** patterns`);
  }
  return child;
}

/** Recover ancestor limits too, including jobs persisted before sub-job scope was propagated. */
export function taskWriteScope(spec: WorkerTask, tasks: Pick<TaskStore, "get">): string[] | undefined {
  const lineage: WorkerTask[] = [spec];
  const seen = new Set<string>();
  let parentId = spec.parentTaskId;
  while (parentId) {
    if (seen.has(parentId)) throw new Error("cyclic task ancestry cannot establish write scope");
    seen.add(parentId);
    const parent = tasks.get(parentId);
    if (!parent) break;
    lineage.unshift(parent.spec);
    parentId = parent.spec.parentTaskId;
  }
  let scope: string[] | undefined;
  for (const task of lineage) scope = narrowedScope(scope, task.constraints.allowedPaths);
  return scope;
}
