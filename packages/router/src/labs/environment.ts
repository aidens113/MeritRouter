import path from "node:path";
import type { LabRecord } from "./store.js";
import { substitute } from "./recipe.js";
import { minimalEnv } from "../runners/coding/process.js";
export function labValues(lab: LabRecord): Record<string, string> {
  const values: Record<string, string> = { "lab.name": lab.name, "lab.project": lab.project, "lab.root": lab.root };
  for (const [name, port] of Object.entries(lab.ports))
    values[`port.${name}`] = String(port);
  for (const name of lab.recipe.data)
    values[`lab.data.${name}`] = path.join(lab.root, "data", name);
  for (const repo of lab.repositories)
    values[`repo.${repo.alias}`] = repo.worktree;
  return values;
}
export function labEnvironment(lab: LabRecord): Record<string, string> {
  const values = labValues(lab);
  const extra: Record<string, string> = { HOST: "127.0.0.1", LAB_HOST: "127.0.0.1", LAB_NAME: lab.name, LAB_PROJECT: lab.project, LAB_ROOT: lab.root, HOME: path.join(lab.root, "data", "home"), USERPROFILE: path.join(lab.root, "data", "home"), XDG_CACHE_HOME: path.join(lab.root, "data", "cache") };
  for (const [key, value] of Object.entries(lab.recipe.env))
    extra[key] = substitute(value, values);
  return minimalEnv(extra);
}
