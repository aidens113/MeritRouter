import type { ResolvedConfig } from "../config/load.js";
import { ProjectConfigSchema } from "../projects/schema.js";
import { validateRecipe } from "../labs/recipe.js";
import type { WorkerTask } from "./task.js";

/** Human authorization for task-selected check names; this grants no new repository scope. */
export function taskLabSelectionIssues(cfg: ResolvedConfig, spec: WorkerTask): string[] {
  const selected = spec.constraints.labChecks;
  if (!selected?.length) return [];
  const issues: string[] = [];
  for (const alias of spec.repositoryAliases) if (!cfg.repositoryPaths[alias]) issues.push(`unknown Lab repository alias ${alias}`);
  const profile = cfg.profiles[spec.profile];
  if (profile?.mode !== "coding" || profile.workspace !== "isolated_worktree") issues.push("constraints.labChecks requires an isolated coding profile");
  const parsed = ProjectConfigSchema.safeParse(cfg.projects[cfg.brain.project] ?? {});
  if (!parsed.success) return [...issues, "the project's Lab policy is invalid"];
  const project = parsed.data;
  if (!project.labs.ephemeral.enabled) issues.push("the project has not enabled task Lab checks");
  for (const name of selected) if (!project.labs.ephemeral.checks.includes(name)) issues.push(`Lab check ${name} is outside the human project allowlist`);
  if (!project.lab) return [...issues, "task Lab checks require a configured project Lab recipe"];
  try { validateRecipe(project.lab, spec.repositoryAliases); }
  catch { issues.push("the Lab recipe references repositories outside this task's scope"); }
  for (const name of selected) {
    const check = project.lab.checks[name];
    if (!check) issues.push(`unknown declared Lab check ${name}`);
    else if (typeof check !== "string" && "kind" in check) issues.push(`Lab check ${name} requires task browser recovery, which is not enabled`);
  }
  // Default cwd belongs to the human recipe's configured repository order, not task input order.
  const needsDefault = project.lab.setup.some(step => typeof step === "string") || selected.some(name => {
    const check = project.lab!.checks[name];
    return typeof check === "string" || (check && !("kind" in check) && !check.repo);
  });
  const defaultAlias = Object.keys(cfg.repositoryPaths)[0];
  if (needsDefault && (!defaultAlias || !spec.repositoryAliases.includes(defaultAlias))) issues.push("task scope must include the recipe's configured default repository");
  return issues;
}
