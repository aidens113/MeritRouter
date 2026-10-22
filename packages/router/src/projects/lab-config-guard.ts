import path from "node:path";
import type { ResolvedConfig } from "../config/load.js";
import { LabsStore } from "../labs/store.js";
import { ProjectRegistry } from "../projects/registry.js";
import type { Db } from "../storage/db.js";

/** Retained lab worktrees need their original project/repository mapping for safe cleanup. */
export function retainedLabConfigErrors(db: Db, candidate: ResolvedConfig): string[] {
  const projects = new ProjectRegistry(candidate);
  const errors: string[] = [];
  const samePath = (a: string, b: string) => {
    const left = path.resolve(a), right = path.resolve(b);
    return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
  };
  for (const lab of new LabsStore(db).list().filter(lab => lab.state !== "destroyed")) {
    const project = projects.get(lab.project);
    const prefix = `Lab ${lab.project}/${lab.name}`;
    if (!project) {
      errors.push(`${prefix} is retained; destroy it before removing its project.`);
      continue;
    }
    for (const repository of lab.repositories) {
      const replacement = project.repositoryPaths[repository.alias];
      if (!replacement || !samePath(replacement.path, repository.source)) {
        errors.push(`${prefix} retains repository ${repository.alias}; destroy it before removing or changing that repository's path.`);
      }
    }
  }
  return errors;
}
