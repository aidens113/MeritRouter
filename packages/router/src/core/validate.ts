import { Ajv } from "ajv";
import picomatch from "picomatch";
import type { ResolvedConfig } from "../config/load.js";
import { TaskValidationError } from "./errors.js";
import { WorkerTaskSchema, type WorkerTask } from "./task.js";
import type { ArtifactStore } from "../storage/artifacts.js";
import { isGitRepo, resolveCommit } from "../workspaces/git.js";
import { loadSources } from "../context/sources.js";
import { estimateTokens } from "../gateway/types.js";
import { taskLabSelectionIssues } from "./task-lab-validation.js";

const ajv = new Ajv({ strict: true, allErrors: true });

export function compileOutputSchema(schema: Record<string, unknown>) {
  try {
    return ajv.compile(schema);
  } catch (err) {
    throw new TaskValidationError(`unsupported outputSchema: ${(err as Error).message}`);
  }
}

/** Parse a raw task and run every check that does not need a model. */
export async function validateTask(
  cfg: ResolvedConfig,
  raw: unknown,
  artifacts: ArtifactStore,
  opts: { largestContext?: number; knownEndpoint?: (id: string) => boolean } = {},
): Promise<WorkerTask> {
  const parsed = WorkerTaskSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "<task>"}: ${i.message}`);
    throw new TaskValidationError(`invalid task: ${issues.join("; ")}`, issues);
  }
  const spec = parsed.data;
  const issues: string[] = [];
  const profile = cfg.profiles[spec.profile];
  if (!profile) throw new TaskValidationError(`profile ${spec.profile} is not configured`);
  issues.push(...taskLabSelectionIssues(cfg, spec));

  for (const alias of spec.repositoryAliases) {
    const repo = cfg.repositoryPaths[alias];
    if (!repo) issues.push(`unknown repository alias ${alias}`);
    else if (!(await isGitRepo(repo.path))) issues.push(`repository ${alias} (${repo.path}) is not a git work tree`);
  }
  if (profile.mode !== "completion" && spec.repositoryAliases.length === 0) {
    issues.push(`profile ${spec.profile} needs at least one repository alias`);
  }

  if (profile.mode === "coding") {
    if (!spec.writableRepository) issues.push("coding tasks must name writableRepository");
    else if (!spec.repositoryAliases.includes(spec.writableRepository)) issues.push("writableRepository must be one of repositoryAliases");
    else if (!cfg.repositoryPaths[spec.writableRepository]?.writable) issues.push(`repository ${spec.writableRepository} is configured read-only`);
    if (!spec.constraints.allowedPaths?.length) issues.push("coding tasks must list constraints.allowedPaths");
  } else {
    if (spec.writableRepository) issues.push(`profile ${spec.profile} is read-only; writableRepository is not allowed`);
    if (spec.constraints.checks?.length && profile.mode !== "supervisor" && profile.mode !== "read_only") issues.push(`profile ${spec.profile} cannot run checks; use a read-only or coding profile`);
    if (spec.constraints.checks?.length && profile.mode === "read_only" && spec.repositoryAliases.length !== 1) {
      issues.push(`read-only checks require exactly one repository alias so the command has an unambiguous working directory`);
    }
  }
  for (const glob of spec.constraints.allowedPaths ?? []) {
    try {
      picomatch(glob);
    } catch {
      issues.push(`invalid allowedPaths glob ${glob}`);
    }
  }

  if ((spec.budget?.maxPaidUsd ?? 0) > 0 && !cfg.paid.enabled) {
    issues.push("budget.maxPaidUsd > 0 requested but paid routing is disabled by configuration");
  }

  if (spec.constraints.labChecks?.length && !issues.length) {
    const configuredOrder = Object.keys(cfg.repositoryPaths);
    spec.repositoryAliases.sort((a, b) => configuredOrder.indexOf(a) - configuredOrder.indexOf(b));
    spec.context.baseCommits = { ...spec.context.baseCommits };
    // Persist all source heads before dispatch, including read-only context repositories.
    for (const alias of spec.repositoryAliases) if (!spec.context.baseCommits[alias]) {
      try { spec.context.baseCommits[alias] = await resolveCommit(cfg.repositoryPaths[alias]!.path, "HEAD"); }
      catch { issues.push(`cannot pin the source commit for Lab repository ${alias}`); }
    }
  }
  for (const [alias, sha] of Object.entries(spec.context.baseCommits ?? {})) {
    const repo = cfg.repositoryPaths[alias];
    if (!repo || !spec.repositoryAliases.includes(alias)) {
      issues.push(`baseCommits names ${alias}, which is not in repositoryAliases`);
      continue;
    }
    try {
      spec.context.baseCommits![alias] = await resolveCommit(repo.path, sha);
    } catch {
      issues.push(`baseCommits.${alias}: ${sha} is not a commit in ${alias}`);
    }
  }

  if (spec.routing?.endpointId && opts.knownEndpoint && !opts.knownEndpoint(spec.routing.endpointId)) {
    issues.push(`routing.endpointId ${spec.routing.endpointId} is not in the model catalog`);
  }
  if (spec.constraints.outputSchema) {
    try {
      compileOutputSchema(spec.constraints.outputSchema);
    } catch (err) {
      issues.push((err as Error).message);
    }
  }

  if (issues.length) throw new TaskValidationError(`invalid task: ${issues.join("; ")}`, issues);

  // Load context now so missing files/artifacts are rejected before dispatch.
  let sources;
  try {
    sources = await loadSources(cfg, spec, artifacts);
  } catch (err) {
    throw new TaskValidationError(`invalid task context: ${(err as Error).message}`);
  }

  if (opts.largestContext !== undefined) {
    const est = estimateTokens([{ role: "user", content: sources.map((x) => x.text).join("\n") + spec.goal }]);
    const out = Math.min(profile.max_output_tokens, spec.budget?.maxOutputTokens ?? Infinity);
    if (est + out > opts.largestContext) {
      throw new TaskValidationError(
        `context (~${est} tokens) plus output (${out}) does not fit any available model (largest context ${opts.largestContext} tokens); split the task or pass narrower file ranges`,
      );
    }
  }
  return spec;
}
