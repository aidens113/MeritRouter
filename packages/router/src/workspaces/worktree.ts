import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import type { Db } from "../storage/db.js";
import { dirtyPaths, git, headSha } from "./git.js";

export interface Workspace {
  taskId: string;
  repoAlias: string;
  sourcePath: string;
  worktreePath: string;
  baseSha: string;
  sourceDirty: boolean;
  dirtyPaths: string[];
}

export interface ChangeSet {
  patch: string;
  changed: Array<{ status: string; path: string }>;
  outOfScope: string[];
  protectedChanged: string[];
}

/**
 * Isolated git worktrees for coding tasks. The worktree is created from a recorded commit,
 * so uncommitted changes in the source checkout are never included (they are reported).
 */
export class Worktrees {
  constructor(
    private readonly db: Db,
    private readonly root: string,
    private readonly now: () => number = Date.now,
  ) {}

  previous(taskId: string): Workspace | null {
    const r = this.db.prepare("SELECT * FROM workspaces WHERE task_id = ?").get(taskId) as
      | { task_id: string; repo_alias: string; source_path: string; worktree_path: string; base_sha: string; source_dirty: number; dirty_paths_json: string }
      | undefined;
    if (!r) return null;
    return {
      taskId: r.task_id,
      repoAlias: r.repo_alias,
      sourcePath: r.source_path,
      worktreePath: r.worktree_path,
      baseSha: r.base_sha,
      sourceDirty: r.source_dirty === 1,
      dirtyPaths: JSON.parse(r.dirty_paths_json) as string[],
    };
  }

  /** Resolve and persist the base commit first, then create the worktree from it. */
  /** `startCommit` (a repair): check out that commit instead of the base; diffs stay against the base. */
  async prepare(opts: { taskId: string; run: number; alias: string; sourcePath: string; baseCommit?: string; startCommit?: string }): Promise<Workspace> {
    const baseSha = opts.baseCommit ?? (await headSha(opts.sourcePath));
    const dirty = await dirtyPaths(opts.sourcePath);
    mkdirSync(this.root, { recursive: true });
    // Unique per attempt: escalations and resumes get fresh worktrees; earlier ones stay as evidence.
    const worktreePath = path.join(this.root, `${opts.taskId}-r${opts.run}-${this.now().toString(36)}`);
    const ws: Workspace = { taskId: opts.taskId, repoAlias: opts.alias, sourcePath: opts.sourcePath, worktreePath, baseSha, sourceDirty: dirty.length > 0, dirtyPaths: dirty };
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO workspaces (task_id, repo_alias, source_path, worktree_path, base_sha, source_dirty, dirty_paths_json, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'preparing', ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET worktree_path = excluded.worktree_path, base_sha = excluded.base_sha, source_dirty = excluded.source_dirty,
           dirty_paths_json = excluded.dirty_paths_json, status = 'preparing', updated_at = excluded.updated_at`,
      )
      .run(ws.taskId, ws.repoAlias, ws.sourcePath, ws.worktreePath, ws.baseSha, ws.sourceDirty ? 1 : 0, JSON.stringify(dirty), now, now);
    if (existsSync(worktreePath)) throw new Error(`worktree path already exists: ${worktreePath}`);
    await git(opts.sourcePath, ["worktree", "add", "--detach", worktreePath, opts.startCommit ?? baseSha]);
    this.setStatus(opts.taskId, "ready");
    return ws;
  }

  setStatus(taskId: string, status: string): void {
    this.db.prepare("UPDATE workspaces SET status = ?, updated_at = ? WHERE task_id = ?").run(status, this.now(), taskId);
  }

  /** Stage everything in the worktree and diff it against the base commit. */
  async collect(ws: Workspace, allowedPaths: string[], protectedPaths: string[]): Promise<ChangeSet> {
    await git(ws.worktreePath, ["add", "-A"]);
    const patch = await git(ws.worktreePath, ["diff", "--cached", "--binary", ws.baseSha]);
    // A rename changes both paths: retain the deleted evaluator and added destination
    // for scope/protected-file enforcement rather than losing the source to rename folding.
    const nameStatus = await git(ws.worktreePath, ["diff", "--cached", "--no-renames", "--name-status", "-z", ws.baseSha]);
    const parts = nameStatus.split("\0").filter(Boolean);
    const changed: ChangeSet["changed"] = [];
    for (let i = 0; i < parts.length; ) {
      const status = parts[i++]!;
      if (status.startsWith("R") || status.startsWith("C")) {
        i++; // source path
        changed.push({ status: status[0]!, path: parts[i++]! });
      } else changed.push({ status, path: parts[i++]! });
    }
    const allowed = picomatch(allowedPaths.length ? allowedPaths : ["**"], { dot: true });
    const prot = protectedPaths.length ? picomatch(protectedPaths, { dot: true, nocase: process.platform === "win32" }) : () => false;
    return {
      patch,
      changed,
      outOfScope: changed.filter((c) => !allowed(c.path)).map((c) => c.path),
      protectedChanged: changed.filter((c) => prot(c.path)).map((c) => c.path),
    };
  }

  /** Remove a worktree (operator cleanup). Evidence (patches, logs) stays in artifacts. */
  async remove(ws: Workspace): Promise<void> {
    await git(ws.sourcePath, ["worktree", "remove", "--force", ws.worktreePath]).catch(() => undefined);
    this.setStatus(ws.taskId, "removed");
  }
}

export function hasRepoAgentConfig(worktree: string): string[] {
  return ["opencode.json", "opencode.jsonc", ".opencode"].filter((f) => existsSync(path.join(worktree, f)));
}
