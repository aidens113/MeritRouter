import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import { z } from "zod";
import type { Db } from "../storage/db.js";
import { dirtyPaths, git, headSha } from "./git.js";
import { ensureProjectMetadataExcluded } from "./metadata-exclusion.js";
import { stageWithoutProjectMetadata } from "./metadata-staging.js";
import { withRepositoryMutation, type RepositoryMutationCapability } from "./repository-mutation.js";
import { assertRuntimeCwdSupported } from "../projects/runtime-paths.js";
import { assertNoNativeWorktreeOperation } from "./worktree-removal.js";

const absolute = z.string().min(1).max(4096).refine(value => path.isAbsolute(value) && !value.includes("\0"), "Expected an absolute repository path");
const commit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const fileNames = z.array(z.string().max(4096).refine(value => !value.includes("\0"))).max(20000);
const WorkspaceSchema = z.object({ taskId: z.string().min(1).max(128), repoAlias: z.string().min(1).max(200), sourcePath: absolute, worktreePath: absolute,
  baseSha: commit, sourceDirty: z.boolean(), dirtyPaths: fileNames }).strict();
const StoredWorkspaceSchema = z.object({ task_id: z.string().min(1).max(128), repo_alias: z.string().min(1).max(200), source_path: absolute,
  worktree_path: absolute, base_sha: commit, source_dirty: z.union([z.literal(0), z.literal(1)]), dirty_paths_json: z.string(), status: z.string() }).strict();
const PrepareSchema = z.object({ taskId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/), run: z.number().int().min(0).max(999999),
  alias: z.string().min(1).max(200), sourcePath: absolute, baseCommit: commit.optional(), startCommit: commit.optional() }).strict();
const physicalKey = (value: string) => process.platform === "win32" ? realpathSync(value).toLowerCase() : realpathSync(value);

/** Native worktree ownership is checked independently of a caller-provided Workspace object. */
async function assertSameRepository(source: string, worktree: string): Promise<void> {
  const common = async (repo: string) => physicalKey(path.resolve(repo, (await git(repo, ["rev-parse", "--git-common-dir"])).trim()));
  if (await common(source) !== await common(worktree)) throw new Error("Workspace does not share its configured source Git owner");
}
function managedWorkspacePath(root: string, target: string): string {
  const base = path.resolve(root), resolved = path.resolve(target), rel = path.relative(base, resolved);
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error("Workspace path is outside its managed directory");
  let current = path.parse(resolved).root;
  for (const part of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Managed workspace paths cannot contain links or non-directory ancestors");
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") break; throw error; }
  }
  return resolved;
}
interface WorkspaceControl { mutation?: RepositoryMutationCapability; timeoutMs?: number }
const mutationOptions = (control: WorkspaceControl) => ({ ...(control.mutation === undefined ? {} : { capability: control.mutation }), ...(control.timeoutMs === undefined ? {} : { timeoutMs: control.timeoutMs }) });

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
  ) { absolute.parse(root); }

  previous(taskId: string): Workspace | null {
    const raw = this.db.prepare("SELECT task_id,repo_alias,source_path,worktree_path,base_sha,source_dirty,dirty_paths_json,status FROM workspaces WHERE task_id = ?").get(taskId);
    const r = raw === undefined ? undefined : StoredWorkspaceSchema.parse(raw);
    if (!r) return null;
    return WorkspaceSchema.parse({
      taskId: r.task_id,
      repoAlias: r.repo_alias,
      sourcePath: r.source_path,
      worktreePath: r.worktree_path,
      baseSha: r.base_sha,
      sourceDirty: r.source_dirty === 1,
      dirtyPaths: fileNames.parse(JSON.parse(r.dirty_paths_json)),
    });
  }

  /** Resolve and persist the base commit first, then create the worktree from it. */
  /** `startCommit` (a repair): check out that commit instead of the base; diffs stay against the base. */
  async prepare(input: { taskId: string; run: number; alias: string; sourcePath: string; baseCommit?: string; startCommit?: string }, control: WorkspaceControl = {}): Promise<Workspace> {
    const opts = PrepareSchema.parse(input), source = realpathSync(opts.sourcePath);
    return withRepositoryMutation([source], async mutation => {
      if (physicalKey(opts.sourcePath) !== physicalKey(source)) throw new Error("Configured source repository changed during workspace admission");
      // A caller can wait while another attempt replaces the task's pointer. Check the
      // latest worktree journal under this lease, rather than trusting admission-time state.
      const latest = this.previous(opts.taskId);
      if (latest) {
        if (latest.repoAlias !== opts.alias || physicalKey(latest.sourcePath) !== physicalKey(source)) throw new Error("Retained workspace source identity changed; explicit recovery is required");
        if (existsSync(latest.worktreePath)) {
          managedWorkspacePath(this.root, latest.worktreePath);
          await assertSameRepository(source, realpathSync(latest.worktreePath));
          await withRepositoryMutation([latest.worktreePath], async () => undefined, { capability: mutation });
        } else if ((this.db.prepare("SELECT status FROM workspaces WHERE task_id=?").get(opts.taskId) as { status: string }).status !== "removed") throw new Error("Retained workspace is missing; explicit recovery is required before replacing its ownership record");
      }
      const baseSha = opts.baseCommit ?? (await headSha(source));
      await git(source, ["rev-parse", "--verify", "--end-of-options", `${opts.startCommit ?? baseSha}^{commit}`]);
      await ensureProjectMetadataExcluded(source);
      const dirty = await dirtyPaths(source);
      // Unique per attempt: escalations and resumes get fresh worktrees; earlier ones stay as evidence.
      const worktreePath = managedWorkspacePath(this.root, path.join(this.root, `${opts.taskId}-r${opts.run}-${this.now().toString(36)}`));
      assertRuntimeCwdSupported(worktreePath);
      if (existsSync(worktreePath)) throw new Error(`worktree path already exists: ${worktreePath}`);
      mkdirSync(this.root, { recursive: true });
      const ws: Workspace = { taskId: opts.taskId, repoAlias: opts.alias, sourcePath: opts.sourcePath, worktreePath, baseSha, sourceDirty: dirty.length > 0, dirtyPaths: dirty };
      const now = this.now();
      const saved = this.db
        .prepare(
          `INSERT INTO workspaces (task_id, repo_alias, source_path, worktree_path, base_sha, source_dirty, dirty_paths_json, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'preparing', ?, ?)
           ON CONFLICT(task_id) DO UPDATE SET worktree_path = excluded.worktree_path, base_sha = excluded.base_sha, source_dirty = excluded.source_dirty,
             dirty_paths_json = excluded.dirty_paths_json, status = 'preparing', updated_at = excluded.updated_at
           WHERE workspaces.source_path=excluded.source_path AND workspaces.repo_alias=excluded.repo_alias`,
        )
        .run(ws.taskId, ws.repoAlias, ws.sourcePath, ws.worktreePath, ws.baseSha, ws.sourceDirty ? 1 : 0, JSON.stringify(dirty), now, now);
      if (saved.changes !== 1) throw new Error("Workspace ownership changed before persistence; prior record retained");
      await git(source, ["worktree", "add", "--detach", worktreePath, opts.startCommit ?? baseSha]);
      this.setStatus(opts.taskId, "ready");
      return ws;
    }, mutationOptions(control));
  }

  setStatus(taskId: string, status: string): void {
    this.db.prepare("UPDATE workspaces SET status = ?, updated_at = ? WHERE task_id = ?").run(status, this.now(), taskId);
  }

  /** Stage everything in the worktree and diff it against the base commit. */
  async collect(input: Workspace, allowedPaths: string[], protectedPaths: string[], control: WorkspaceControl = {}): Promise<ChangeSet> {
    const ws = WorkspaceSchema.parse(input), source = realpathSync(ws.sourcePath), worktree = realpathSync(ws.worktreePath);
    const allowedInput = fileNames.parse(allowedPaths), protectedInput = fileNames.parse(protectedPaths);
    if (physicalKey(source) !== physicalKey(worktree)) managedWorkspacePath(this.root, ws.worktreePath);
    return withRepositoryMutation([source], async mutation => {
      await assertSameRepository(source, worktree);
      return withRepositoryMutation([worktree], async () => {
        await git(worktree, ["rev-parse", "--verify", "--end-of-options", `${ws.baseSha}^{commit}`]);
        await stageWithoutProjectMetadata(worktree, {}, { mutation });
        const patch = await git(worktree, ["diff", "--cached", "--binary", ws.baseSha]);
        // A rename changes both paths: retain the deleted evaluator and added destination
        // for scope/protected-file enforcement rather than losing the source to rename folding.
        const nameStatus = await git(worktree, ["diff", "--cached", "--no-renames", "--name-status", "-z", ws.baseSha]);
        const parts = nameStatus.split("\0").filter(Boolean);
        const changed: ChangeSet["changed"] = [];
        for (let i = 0; i < parts.length; ) {
          const status = parts[i++]!;
          if (status.startsWith("R") || status.startsWith("C")) {
            i++; // source path
            changed.push({ status: status[0]!, path: parts[i++]! });
          } else changed.push({ status, path: parts[i++]! });
        }
        const allowed = picomatch(allowedInput.length ? allowedInput : ["**"], { dot: true });
        const prot = protectedInput.length ? picomatch(protectedInput, { dot: true, nocase: process.platform === "win32" }) : () => false;
        return {
          patch,
          changed,
          outOfScope: changed.filter((c) => !allowed(c.path)).map((c) => c.path),
          protectedChanged: changed.filter((c) => prot(c.path)).map((c) => c.path),
        };
      }, { capability: mutation });
    }, mutationOptions(control));
  }

  /** Remove a worktree (operator cleanup). Evidence (patches, logs) stays in artifacts. */
  async remove(input: Workspace, control: WorkspaceControl = {}): Promise<void> {
    const ws = WorkspaceSchema.parse(input);
    managedWorkspacePath(this.root, ws.worktreePath);
    const previous = this.previous(ws.taskId);
    if (!previous || previous.repoAlias !== ws.repoAlias || path.resolve(previous.worktreePath) !== path.resolve(ws.worktreePath)
      || physicalKey(previous.sourcePath) !== physicalKey(ws.sourcePath)) throw new Error("Workspace removal does not match its persisted ownership record");
    const source = realpathSync(ws.sourcePath), worktree = realpathSync(ws.worktreePath);
    await withRepositoryMutation([source], async mutation => {
      const current = this.previous(ws.taskId);
      if (!current || current.repoAlias !== ws.repoAlias || path.resolve(current.worktreePath) !== path.resolve(ws.worktreePath)
        || physicalKey(current.sourcePath) !== physicalKey(source)) throw new Error("Workspace ownership changed before removal; prior record retained");
      managedWorkspacePath(this.root, ws.worktreePath);
      await assertSameRepository(source, worktree);
      await withRepositoryMutation([worktree], async () => {
        await assertNoNativeWorktreeOperation(worktree);
        await git(source, ["worktree", "remove", ws.worktreePath]);
        if (existsSync(ws.worktreePath)) throw new Error("Git did not remove the managed workspace; ownership record retained");
        this.db.prepare("UPDATE workspaces SET status='removed',updated_at=? WHERE task_id=? AND worktree_path=?").run(this.now(), ws.taskId, ws.worktreePath);
      }, { capability: mutation });
    }, mutationOptions(control));
  }
}

export function hasRepoAgentConfig(worktree: string): string[] {
  return ["opencode.json", "opencode.jsonc", ".opencode"].filter((f) => existsSync(path.join(worktree, f)));
}
