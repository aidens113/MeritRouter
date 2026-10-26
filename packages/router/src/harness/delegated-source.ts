import { realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { RunContext } from "../runners/types.js";
import { git } from "../workspaces/git.js";

const commit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const source = z.object({ alias: z.string().min(1), worktree: z.string().min(1), branch: z.string().min(1) });

/** Freeze the parent's committed read subject without broadening the child's repository scope. */
export async function delegatedSourceSnapshot(ctx: RunContext, repositories: ReadonlyMap<string, unknown>, aliases: readonly string[]): Promise<Record<string,string>> {
  const project = ctx.tasks.projectOf(ctx.taskId), parent = ctx.tasks.get(ctx.taskId);
  if (!parent || !project || parent.row.project_id !== project || project !== (ctx.taskProject ?? ctx.cfg.brain.project)) throw new Error("delegated_source_refused: parent project identity changed");
  const result: Record<string,string> = {};
  const opts = { signal: ctx.signal, timeoutMs: 10_000, maxBuffer: 65536 };
  const common = async (root: string) => realpath(path.resolve(root, (await git(root, ["rev-parse", "--git-common-dir"], opts)).trim()));
  const resolve = async (root: string, ref: string) => commit.parse((await git(root, ["rev-parse", "--verify", `${ref}^{commit}`], opts)).trim());
  for (const alias of [...new Set(aliases)]) {
    if (!ctx.spec.repositoryAliases.includes(alias) || !parent.spec.repositoryAliases.includes(alias)) throw new Error(`delegated_source_refused: ${alias} exceeds parent repository scope`);
    const configured = ctx.cfg.repositoryPaths[alias];
    if (!configured) throw new Error(`delegated_source_refused: missing repository ${alias}`);
    const canonical = await realpath(configured.path);
    const raw = repositories.get(alias);
    if (raw === undefined) {
      if (configured.writable) throw new Error(`delegated_source_refused: missing parent integration source for ${alias}`);
      // A read-only parent has no integration worktree: retain its declared committed source,
      // or freeze its configured HEAD. Never substitute canonical HEAD for a writable source.
      const declared = ctx.spec.context.baseCommits?.[alias];
      if (!declared && (await git(canonical, ["status", "--porcelain=v1", "--untracked-files=all"], opts)).trim()) throw new Error(`delegated_source_dirty: commit parent read source ${alias} before dispatch`);
      result[alias] = await resolve(canonical, declared ?? "HEAD");
      continue;
    }
    const repo = source.parse(raw);
    if (repo.alias !== alias) throw new Error(`delegated_source_refused: parent source alias mismatch for ${alias}`);
    const root = await realpath(repo.worktree);
    const canonicalCommon = await common(canonical);
    const assertSource = async () => {
      if (await common(root) !== canonicalCommon) throw new Error(`delegated_source_refused: parent source for ${alias} belongs to another repository`);
      if ((await git(root, ["symbolic-ref", "--quiet", "HEAD"], opts)).trim() !== `refs/heads/${repo.branch}`) throw new Error(`delegated_source_refused: parent branch changed for ${alias}`);
      if ((await git(root, ["status", "--porcelain=v1", "--untracked-files=all"], opts)).trim()) throw new Error(`delegated_source_dirty: commit parent integration source ${alias} before dispatch`);
    };
    await assertSource();
    const head = await resolve(root, "HEAD");
    if (await resolve(canonical, head) !== head) throw new Error(`delegated_source_refused: source commit unavailable in ${alias}`);
    await assertSource();
    if (await resolve(root, "HEAD") !== head) throw new Error(`delegated_source_refused: parent HEAD changed while pinning ${alias}`);
    result[alias] = head;
  }
  if (ctx.tasks.projectOf(ctx.taskId) !== project) throw new Error("delegated_source_refused: parent project identity changed");
  return result;
}
