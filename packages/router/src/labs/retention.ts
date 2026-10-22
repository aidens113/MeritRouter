import path from "node:path";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { z } from "zod";
import type { Db } from "../storage/db.js";
import { TaskStore } from "../storage/tasks.js";
import { splitRepoKey } from "../projects/context.js";
import type { ProjectContext } from "../projects/context.js";
import { dirtyPaths, git } from "../workspaces/git.js";
export interface LabRetentionResult {
  removed: string[];
  skipped: Array<{
    path: string;
    reason: string;
  }>;
}
const Row = z.object({ task_id: z.string().min(1), source_path: z.string().min(1), repo_alias: z.string().min(1) });
const TERMINAL = new Set(["completed", "failed", "cancelled", "budget_exhausted"]);
/** Remove only registered clean attempt worktrees of old tasks whose entire job ancestry ended. */
export async function pruneTaskWorktrees(db: Db, storageDir: string, days: number, project: (slug: string) => ProjectContext, now = Date.now()): Promise<LabRetentionResult> {
  const out: LabRetentionResult = { removed: [], skipped: [] };
  const root = path.resolve(storageDir, "worktrees");
  if (!existsSync(root))
    return out;
  if (lstatSync(root).isSymbolicLink())
    throw new Error("task worktree root cannot be a symbolic link");
  const tasks = new TaskStore(db);
  const cutoff = now - days * 86400000;
  for (const raw of db.prepare("SELECT task_id,source_path,repo_alias FROM workspaces ").all()) {
    const row = Row.parse(raw);
    const task = tasks.get(row.task_id);
    if (!task || !TERMINAL.has(task.row.state) || task.row.finished_at === null || task.row.finished_at > cutoff)
      continue;
    let parent = task.spec.parentTaskId;
    let ended = true;
    const seen = new Set<string>();
    while (parent) {
      if (seen.has(parent)) {
        ended = false;
        break;
      }
      seen.add(parent);
      const t = tasks.get(parent);
      if (!t || !TERMINAL.has(t.row.state)) {
        ended = false;
        break;
      }
      parent = t.spec.parentTaskId;
    }
    if (!ended)
      continue;
    const key = splitRepoKey(row.repo_alias);
    if (key.project && key.project !== task.row.project_id)
      continue;
    const configured = project(task.row.project_id).repositoryPaths[key.alias];
    if (!configured || path.resolve(configured.path) !== path.resolve(row.source_path))
      continue;
    const registered = (await git(row.source_path, ["worktree", "list", "--porcelain", "-z"])).split("\0").filter(x => x.startsWith("worktree ")).map(x => path.resolve(x.slice(9)));
    for (const name of readdirSync(root)) {
      if (!name.startsWith(`${row.task_id}-r`) || !/^r\d+-[a-z0-9]+$/.test(name.slice(row.task_id.length + 1)))
        continue;
      const candidate = path.resolve(root, name);
      const rel = path.relative(root, candidate);
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || lstatSync(candidate).isSymbolicLink() || !registered.includes(candidate))
        continue;
      if ((await dirtyPaths(candidate)).length) {
        out.skipped.push({ path: candidate, reason: "uncommitted changes retained" });
        continue;
      }
      await git(row.source_path, ["worktree", "remove", candidate]);
      out.removed.push(candidate);
      db.prepare("UPDATE workspaces SET status='removed',updated_at=? WHERE task_id=? AND worktree_path=?").run(now, row.task_id, candidate);
    }
  }
  return out;
}
