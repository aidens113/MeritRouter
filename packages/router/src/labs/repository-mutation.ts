import path from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { z } from "zod";
import type { ProjectContext } from "../projects/context.js";
import { git } from "../workspaces/git.js";
import { RepositoryMutationError, withRepositoryMutation, type RepositoryMutationCapability } from "../workspaces/repository-mutation.js";
import type { RepositoryCommandPermit, RepositoryCommandPermits } from "../workspaces/repository-command.js";

export interface LabMutationControl { mutation?: RepositoryMutationCapability; allowMissingWorktrees?: boolean }
const Repository = z.object({ alias: z.string().min(1).max(128), source: z.string().min(1).max(4096), worktree: z.string().min(1).max(4096).optional() }).strict();
export type LabMutationRepository = z.infer<typeof Repository>;
const key = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);

async function owner(root: string): Promise<string> {
  try {
    if (!existsSync(root)) throw new Error("repository is missing");
    const fields = (await git(root, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"])).split(/\r?\n/);
    if (fields.at(-1) === "") fields.pop();
    if (fields.length !== 2) throw new Error("Git owner paths are not representable by the bounded probe");
    const [top, common] = fields as [string, string];
    if (key(realpathSync(top)) !== key(realpathSync(root))) throw new Error("path is not the Git worktree root");
    return key(realpathSync(common));
  } catch (error) { throw new RepositoryMutationError("ownership_changed", `Lab Git owner cannot be verified at ${root}: ${(error as Error).message}`); }
}

/** Configured physical owners are proved read-only before any lock in recorded paths. */
function repositoryValidation(project: ProjectContext, input: LabMutationRepository[], control: LabMutationControl = {}) {
  const repositories = z.array(Repository).min(1).max(128).parse(input.map(repo => ({ alias: repo.alias, source: repo.source, ...(repo.worktree === undefined ? {} : { worktree: repo.worktree }) })));
  const validate = async () => {
    const expected = new Map<string, string>();
    const observed = new Map<string, Promise<string>>();
    const physicalOwner = (root: string) => {
      const physical = observed.get(key(root)) ?? owner(root); observed.set(key(root), physical); return physical;
    };
    for (const repo of repositories) {
      const configured = project.repositoryPaths[repo.alias];
      if (!configured) throw new RepositoryMutationError("ownership_changed", `Lab repository alias ${repo.alias} is outside its configured project`);
      const physical = expected.get(repo.alias) ?? await physicalOwner(configured.path);
      expected.set(repo.alias, physical);
      if (await physicalOwner(repo.source) !== physical) throw new RepositoryMutationError("ownership_changed", "Lab recorded source belongs to a foreign physical Git owner");
      if (repo.worktree) {
        if (!existsSync(repo.worktree)) {
          if (!control.allowMissingWorktrees) throw new RepositoryMutationError("ownership_changed", "Lab worktree is missing without verified removal authority");
          const registered = await git(repo.source, ["worktree", "list", "--porcelain", "-z"]);
          if (registered.split("\0").some(field => field.startsWith("worktree ") && key(field.slice(9)) === key(repo.worktree!)))
            throw new RepositoryMutationError("ownership_changed", "Missing Lab worktree still has a native Git registration");
        } else if (await physicalOwner(repo.worktree) !== physical) throw new RepositoryMutationError("ownership_changed", "Lab worktree belongs to a foreign physical Git owner");
      }
    }
  };
  return { repositories, validate };
}
/** Read-only physical binding proof shared by command-marker admission and Git effects. */
export async function assertLabRepositoryOwners(project: ProjectContext, input: LabMutationRepository[], control: LabMutationControl = {}): Promise<void> {
  await repositoryValidation(project, input, control).validate();
}
async function admitLabRepository<T>(project: ProjectContext, input: LabMutationRepository[], action: (mutation: RepositoryMutationCapability) => Promise<T>, control: LabMutationControl = {}, commands?: RepositoryCommandPermits): Promise<T> {
  const { repositories, validate } = repositoryValidation(project, input, control);
  await validate();
  const sources = [...new Map(repositories.map(repo => [key(repo.source), repo.source])).values()];
  const worktrees = [...new Set(repositories.flatMap(repo => repo.worktree && existsSync(repo.worktree) ? [repo.worktree] : []))];
  const roots = [...new Map([...sources, ...worktrees].map(root => [key(root), root])).values()];
  if (roots.length > 128) throw new RepositoryMutationError("ownership_changed", "Lab Git root set exceeds bounded admission; split its configured repository scope");
  return withRepositoryMutation(roots, async mutation => {
    await validate();
    for (const repo of repositories) if (repo.worktree && existsSync(repo.worktree) && !worktrees.includes(repo.worktree))
      throw new RepositoryMutationError("ownership_changed", "Lab worktree appeared during admission; retained identity requires revalidation");
    return action(mutation);
  }, { capability: control.mutation, ...(commands === undefined ? {} : { command: commands }) });
}
export function withLabRepositoryMutation<T>(project: ProjectContext, input: LabMutationRepository[], action: (mutation: RepositoryMutationCapability) => Promise<T>, control: LabMutationControl = {}): Promise<T> {
  return admitLabRepository(project, input, action, control);
}
/** Trusted own-DB/command metadata only; deliberately exposes no repository mutation cap. */
export function withLabRepositoryStatus<T>(project: ProjectContext, input: LabMutationRepository[], commands: readonly RepositoryCommandPermit[], action: () => Promise<T>): Promise<T> {
  return admitLabRepository(project, input, () => action(), {}, commands);
}
