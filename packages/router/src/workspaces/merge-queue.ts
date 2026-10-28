import { existsSync, realpathSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { Db } from "../storage/db.js";
import { immediate, newId } from "../storage/db.js";
import { faultPoint, isSimulatedCrash } from "../core/faults.js";
import { git } from "./git.js";
import { repoKey } from "../projects/context.js";
import { RepositoryMutationError, withRepositoryMutation, type RepositoryMutationCapability } from "./repository-mutation.js";
import { SelectedCommitError } from "../attribution/selected-commit.js";
import type { RepositoryCommandPermit } from "./repository-command.js";

/**
 * The merge queue: how finished work reaches a job branch. Every integration (a coding task's
 * commits, or a sub-job's branch) is an item; one item per job branch is integrated at a time,
 * in order. Commits are cherry-picked one by one with `-x`, never squashed, so each keeps its
 * author and Agent/Model/Task trailers and per-line blame still names the original worker.
 *
 * Crash safety: an item's state, its commits, and the branch head before it are durable before
 * the first pick. An item left `integrating` by a dead run is recovered: a commit whose
 * `(cherry picked from commit <sha>)` line is already on the branch is never picked again, so the
 * item either completed (every commit present) or is retried once from where it stopped.
 *
 * Conflicts: when a pick fails, the branch is restored, the item is rebased onto the branch head
 * in its own worktree (commits the branch already has are dropped), and picked again; if the
 * rebase conflicts too, the item's task is re-delegated once with the conflict as context.
 */

export const MERGE_STATES = ["queued", "integrating", "picked", "integrated", "conflict", "redelegated", "refused", "failed"] as const;
export type MergeState = (typeof MERGE_STATES)[number];
/** States of an item still on its way to the branch. */
export const ACTIVE_MERGE_STATES: ReadonlySet<MergeState> = new Set(["queued", "integrating", "picked"]);

/** Attempts an item gets: the first, and one retry after a crash mid-integration. */
export const MAX_MERGE_ATTEMPTS = 2;

/** Fault-hook name (`MERITROUTER_FAULT_AT=after_tool_run:<n>:merge_queue_pick`): after the n-th pick. */
export const MERGE_PICK_FAULT = "merge_queue_pick";

/** Who decided to integrate a result that needed acceptance, and why (recorded once the picks succeed). */
export const MergeAcceptanceSchema = z.object({ reason: z.string().min(1) }).strict();
export type MergeAcceptance = z.infer<typeof MergeAcceptanceSchema>;

const ShaListSchema = z.array(z.string().regex(/^[0-9a-f]{7,64}$/));
const DetailSchema = z.record(z.string(), z.unknown());

export interface MergeItem {
  id: string;
  jobId: string;
  taskId: string;
  /** `task`: a coding task's worktree commits; `job`: a sub-job's branch. */
  kind: "task" | "job";
  repo: string;
  branch: string;
  lockKey: string;
  integrationWorktree: string;
  /** Where the item's commits live (a task's worktree, a sub-job's integration worktree). */
  sourceWorktree: string | null;
  sourceBase: string;
  sourceHead: string;
  commits: string[];
  state: MergeState;
  owner: string | null;
  attempts: number;
  beforeHead: string | null;
  afterHead: string | null;
  rebased: boolean;
  acceptance: MergeAcceptance | null;
  redelegatedTo: string | null;
  detail: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

interface Row {
  id: string;
  job_id: string;
  task_id: string;
  kind: string;
  repo_alias: string;
  branch: string;
  lock_key: string;
  integration_worktree: string;
  source_worktree: string | null;
  source_base: string;
  source_head: string;
  commits_json: string;
  state: string;
  owner: string | null;
  attempts: number;
  before_head: string | null;
  after_head: string | null;
  rebased: number;
  acceptance_json: string | null;
  redelegated_to: string | null;
  detail_json: string | null;
  created_at: number;
  updated_at: number;
}

/** A stored row, validated: rows are runtime input like any other. */
function toItem(r: Row): MergeItem {
  return {
    id: r.id,
    jobId: r.job_id,
    taskId: r.task_id,
    kind: z.enum(["task", "job"]).parse(r.kind),
    repo: r.repo_alias,
    branch: r.branch,
    lockKey: r.lock_key,
    integrationWorktree: r.integration_worktree,
    sourceWorktree: r.source_worktree,
    sourceBase: r.source_base,
    sourceHead: r.source_head,
    commits: ShaListSchema.parse(JSON.parse(r.commits_json)),
    state: z.enum(MERGE_STATES).parse(r.state),
    owner: r.owner,
    attempts: r.attempts,
    beforeHead: r.before_head,
    afterHead: r.after_head,
    rebased: r.rebased === 1,
    acceptance: r.acceptance_json ? MergeAcceptanceSchema.parse(JSON.parse(r.acceptance_json)) : null,
    redelegatedTo: r.redelegated_to,
    detail: r.detail_json ? DetailSchema.parse(JSON.parse(r.detail_json)) : {},
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface MergeConflict {
  files: string[];
  message: string;
  /** The commit whose pick (or replay) failed. */
  commit: string | null;
  stage: "pick" | "rebase";
}

/** What the queue calls back into: the job's acceptance, events, checks, and re-delegation. */
export interface MergeHooks {
  validateSource?: (item: MergeItem) => Promise<void>;
  allowRebase?: (item: MergeItem) => boolean;
  /** Committer identity for picks and rebases (authors are kept). */
  committer: { name: string; email: string };
  /** Record the acceptance an item was enqueued with; throw to refuse (the picks are rolled back). Must be idempotent. */
  accept?: (item: MergeItem) => void;
  /** The item's commits are on the branch (task events, calibration signal). */
  integrated: (item: MergeItem, head: string) => void;
  /** Job checks run on the branch after each integration. */
  checks?: (item: MergeItem) => Promise<Array<{ command: string; exitCode: number | null; logRef?: string }>>;
  /** Re-delegate the item's task with the conflict as context; returns the new task id, or null. */
  redelegate?: (item: MergeItem, conflict: MergeConflict) => Promise<string | null>;
  /**
   * Repository command permits for this item's admissions, fetched afresh for every admission
   * (a restart replaces a service's command). Only a Lab's root job supplies any: its
   * integration worktree is the Lab worktree, and the permits cover exactly that Lab's own live
   * services. The fence still refuses every other active command.
   */
  admission?: (item: MergeItem) => Promise<readonly RepositoryCommandPermit[]>;
}

export interface EnqueueInput {
  jobId: string;
  taskId: string;
  kind: "task" | "job";
  repo: string;
  branch: string;
  integrationWorktree: string;
  sourceWorktree: string | null;
  sourceBase: string;
  sourceHead: string;
  commits: string[];
  acceptance: MergeAcceptance | null;
}

/** Local ordering complements the durable physical-branch mutex below. */
const chains = new Map<string, Promise<unknown>>();
const processInstance = randomUUID();
const BranchOwnerSchema = z.object({
  nonce: z.string().uuid(), host: z.string().min(1), pid: z.number().int().positive(), instance: z.string().uuid(),
  owner: z.string().min(1), heartbeat: z.number().finite(), jobId: z.string(),
  leaseOwner: z.string().nullable(), runCount: z.number().int().nonnegative().nullable(),
}).strict();
type BranchOwner = z.infer<typeof BranchOwnerSchema>;
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  chains.set(key, settled);
  void settled.then(() => {
    if (chains.get(key) === settled) chains.delete(key);
  });
  return next;
}

const PICKED_RE = /\(cherry picked from commit ([0-9a-f]{40})\)/g;

/** Source commits already on the branch since `since` (by the `-x` line each pick leaves). */
export async function pickedSources(worktree: string, since: string): Promise<Set<string>> {
  const log = await git(worktree, ["log", "--format=%B%x00", `${since}..HEAD`]);
  return new Set([...log.matchAll(PICKED_RE)].map((m) => m[1]!));
}

async function headOf(worktree: string): Promise<string> {
  return (await git(worktree, ["rev-parse", "HEAD"])).trim();
}

async function gitPathExists(worktree: string, p: string): Promise<boolean> {
  const rel = (await git(worktree, ["rev-parse", "--git-path", p])).trim();
  if (!rel) return false;
  return existsSync(path.isAbsolute(rel) ? rel : path.join(worktree, rel));
}

/**
 * Abort a cherry-pick or rebase a dead run left in progress in this worktree. `command` permits
 * are passed only for the integration worktree they were issued for (a permit outside the
 * admitted worktree is refused by the fence), never for an item's source worktree.
 */
export async function abortInProgress(worktree: string, control: { mutation?: RepositoryMutationCapability; command?: readonly RepositoryCommandPermit[] } = {}): Promise<string[]> {
  if (!existsSync(worktree)) return [];
  return withRepositoryMutation([worktree], async () => {
    try { return await abortInProgressUnderMutation(worktree); }
    catch (error) {
      if (error instanceof RepositoryMutationError || error instanceof SelectedCommitError) throw error;
      throw new RepositoryMutationError("ownership_changed", `Merge sequencer abort failed: ${(error as Error).message}`);
    }
  }, { capability: control.mutation, ...(control.command?.length ? { command: control.command } : {}) });
}

async function abortInProgressUnderMutation(worktree: string): Promise<string[]> {
  const aborted: string[] = [];
  if (!existsSync(worktree)) return aborted;
  if ((await gitPathExists(worktree, "CHERRY_PICK_HEAD")) || (await gitPathExists(worktree, "sequencer"))) {
    await git(worktree, ["cherry-pick", "--abort"]);
    aborted.push("cherry-pick");
  }
  if ((await gitPathExists(worktree, "rebase-merge")) || (await gitPathExists(worktree, "rebase-apply"))) {
    await git(worktree, ["rebase", "--abort"]);
    aborted.push("rebase");
  }
  return aborted;
}

async function unmergedFiles(worktree: string): Promise<string[]> {
  return (await git(worktree, ["diff", "--name-only", "--diff-filter=U"]).catch(() => "")).split("\n").map((l) => l.trim()).filter(Boolean);
}

async function isClean(worktree: string): Promise<boolean> {
  return (await git(worktree, ["status", "--porcelain=v1", "--untracked-files=no"]).catch(() => "x")).trim() === "";
}

export class MergeQueue {
  constructor(
    private readonly db: Db,
    private readonly events: { event(taskId: string | null, type: string, data?: unknown): void },
    /** This run's identity: items another owner left active belong to a dead run of the job. */
    readonly owner: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Branch mutex is acquired first; physical owners are compared before writing a lease. */
  private async withMutation<T>(item: MergeItem, hooks: MergeHooks, action: (mutation: RepositoryMutationCapability, command: readonly RepositoryCommandPermit[]) => Promise<T>): Promise<T> {
    const roots = [item.integrationWorktree];
    if (item.sourceWorktree && existsSync(item.sourceWorktree)) {
      const owner = async (root: string) => {
        const value = realpathSync(path.resolve(root, (await git(root, ["rev-parse", "--git-common-dir"])).trim()));
        return process.platform === "win32" ? value.toLowerCase() : value;
      };
      if (await owner(item.integrationWorktree) !== await owner(item.sourceWorktree))
        throw new RepositoryMutationError("ownership_changed", "Merge source belongs to a different physical Git owner");
      roots.push(item.sourceWorktree);
    }
    const command = (await hooks.admission?.(item)) ?? [];
    return withRepositoryMutation(roots, mutation => action(mutation, command), command.length ? { command } : {});
  }

  /** Physical Git identity, so different aliases/projects cannot bypass a branch lock. */
  private async branchKey(item: MergeItem): Promise<string> {
    const common = (await git(item.integrationWorktree, ["rev-parse", "--git-common-dir"])).trim();
    const physical = realpathSync(path.resolve(item.integrationWorktree, common));
    const canonical = process.platform === "win32" ? physical.toLowerCase() : physical;
    return `merge-branch:${createHash("sha256").update(JSON.stringify([canonical, item.branch])).digest("hex")}`;
  }

  /**
   * SQLite mutex covers Git operations AND checks in every process. A differing queue owner
   * is not evidence of death. Only an absent local OS process permits takeover; remote,
   * malformed and PID-reuse ambiguity remain busy, regardless of heartbeat/lease age.
   */
  private async withBranch<T>(item: MergeItem, fn: (key: string) => Promise<T>): Promise<T> {
    const key = await this.branchKey(item);
    const task = this.db.prepare("SELECT lease_owner, run_count FROM tasks WHERE id = ?").get(item.jobId) as { lease_owner: string | null; run_count: number } | undefined;
    const mine: BranchOwner = { nonce: randomUUID(), host: hostname(), pid: process.pid, instance: processInstance, owner: this.owner,
      heartbeat: Date.now(), jobId: item.jobId, leaseOwner: task?.lease_owner ?? null, runCount: task?.run_count ?? null };
    const deadline = Date.now() + 30_000;
    for (;;) {
      const acquired = immediate(this.db, () => {
        const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
        if (row) {
          let parsed: ReturnType<typeof BranchOwnerSchema.safeParse>;
          try { parsed = BranchOwnerSchema.safeParse(JSON.parse(row.value)); } catch { return false; }
          if (!parsed.success || parsed.data.host !== mine.host) return false;
          try { process.kill(parsed.data.pid, 0); return false; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false; }
        }
        this.db.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(mine));
        return true;
      });
      if (acquired) break;
      if (Date.now() >= deadline) throw new Error(`integration branch busy: ownership is live or cannot be proven abandoned (${item.branch})`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const updateOwned = (release: boolean) => immediate(this.db, () => {
      const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
      if (!row) return;
      let current: BranchOwner;
      try { current = BranchOwnerSchema.parse(JSON.parse(row.value)); } catch { return; }
      if (current.nonce !== mine.nonce) return;
      if (release) this.db.prepare("DELETE FROM meta WHERE key = ? AND value = ?").run(key, row.value);
      else this.db.prepare("UPDATE meta SET value = ? WHERE key = ? AND value = ?").run(JSON.stringify({ ...current, heartbeat: Date.now() }), key, row.value);
    });
    const heartbeat = setInterval(() => { try { updateOwned(false); } catch { /* never expire a mutex on heartbeat failure */ } }, 1000);
    heartbeat.unref?.();
    try { return await fn(key); }
    finally { clearInterval(heartbeat); updateOwned(true); }
  }

  get(id: string): MergeItem | null {
    const r = this.db.prepare("SELECT * FROM merge_queue WHERE id = ?").get(id) as Row | undefined;
    return r ? toItem(r) : null;
  }

  forJob(jobId: string): MergeItem[] {
    return (this.db.prepare("SELECT * FROM merge_queue WHERE job_id = ? ORDER BY created_at, rowid").all(jobId) as Row[]).map(toItem);
  }

  /** The latest item of a task on one repository of the job. */
  latest(jobId: string, taskId: string, repo: string): MergeItem | null {
    const r = this.db.prepare("SELECT * FROM merge_queue WHERE job_id = ? AND task_id = ? AND repo_alias = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(jobId, taskId, repo) as Row | undefined;
    return r ? toItem(r) : null;
  }

  /**
   * A task is re-delegated at most once: never when it was itself created by a re-delegation,
   * nor when an earlier integration of it was already re-delegated.
   */
  mayRedelegate(taskId: string): boolean {
    return this.db.prepare("SELECT 1 FROM merge_queue WHERE redelegated_to = ? OR (task_id = ? AND state = 'redelegated') LIMIT 1").get(taskId, taskId) === undefined;
  }

  private update(id: string, patch: Partial<Pick<MergeItem, "state" | "owner" | "attempts" | "beforeHead" | "afterHead" | "rebased" | "commits" | "sourceBase" | "sourceHead" | "redelegatedTo" | "detail" | "acceptance">>): MergeItem {
    const cols: string[] = [];
    const vals: unknown[] = [];
    const set = (c: string, v: unknown) => {
      cols.push(`${c} = ?`);
      vals.push(v);
    };
    if (patch.state !== undefined) set("state", patch.state);
    if (patch.owner !== undefined) set("owner", patch.owner);
    if (patch.attempts !== undefined) set("attempts", patch.attempts);
    if (patch.beforeHead !== undefined) set("before_head", patch.beforeHead);
    if (patch.afterHead !== undefined) set("after_head", patch.afterHead);
    if (patch.rebased !== undefined) set("rebased", patch.rebased ? 1 : 0);
    if (patch.commits !== undefined) set("commits_json", JSON.stringify(patch.commits));
    if (patch.sourceBase !== undefined) set("source_base", patch.sourceBase);
    if (patch.sourceHead !== undefined) set("source_head", patch.sourceHead);
    if (patch.redelegatedTo !== undefined) set("redelegated_to", patch.redelegatedTo);
    if (patch.detail !== undefined) set("detail_json", JSON.stringify(patch.detail));
    if (patch.acceptance !== undefined) set("acceptance_json", patch.acceptance ? JSON.stringify(patch.acceptance) : null);
    set("updated_at", this.now());
    this.db.prepare(`UPDATE merge_queue SET ${cols.join(", ")} WHERE id = ?`).run(...vals, id);
    return this.get(id)!;
  }

  private event(item: MergeItem, type: string, data: Record<string, unknown> = {}): void {
    this.events.event(item.taskId, type, { itemId: item.id, jobId: item.jobId, repository: item.repo, branch: item.branch, ...data });
  }

  /**
   * Queue an integration. A task already queued, in progress, or integrated on this repository
   * keeps its item (an acceptance given now is added to it); after a conflict, re-delegation,
   * refusal, or failure an explicit new call creates a new item.
   */
  enqueue(i: EnqueueInput): MergeItem {
    return immediate(this.db, () => {
      const prior = this.latest(i.jobId, i.taskId, i.repo);
      if (prior && (ACTIVE_MERGE_STATES.has(prior.state) || prior.state === "integrated")) {
        return i.acceptance && !prior.acceptance && ACTIVE_MERGE_STATES.has(prior.state) ? this.update(prior.id, { acceptance: i.acceptance }) : prior;
      }
      const id = newId("mq");
      const now = this.now();
      // One integration per branch of a project's repository (decision D6: <project>/<alias>).
      const project = (this.db.prepare("SELECT project_id FROM tasks WHERE id = ?").get(i.jobId) as { project_id: string } | undefined)?.project_id ?? "";
      const lockKey = `${repoKey(project, i.repo)}:${i.branch}`;
      this.db
        .prepare(
          `INSERT INTO merge_queue (id, job_id, task_id, kind, repo_alias, branch, lock_key, integration_worktree, source_worktree, source_base, source_head, commits_json, state, acceptance_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
        )
        .run(id, i.jobId, i.taskId, i.kind, i.repo, i.branch, lockKey, i.integrationWorktree, i.sourceWorktree, i.sourceBase, i.sourceHead, JSON.stringify(i.commits), i.acceptance ? JSON.stringify(i.acceptance) : null, now, now);
      const item = this.get(id)!;
      const ahead = (this.db.prepare("SELECT COUNT(*) AS n FROM merge_queue WHERE lock_key = ? AND state IN ('queued','integrating','picked') AND id != ?").get(lockKey, id) as { n: number }).n;
      this.event(item, "merge_queued", { kind: i.kind, commits: i.commits.length, ahead });
      return item;
    });
  }

  /**
   * Integrate one item, after every item queued before it in this process on the same branch.
   * Items a dead run left in progress on the branch are recovered first. Returns the item in
   * its final state; a crash (simulated in tests) propagates and leaves the item recoverable.
   */
  run(id: string, hooks: MergeHooks): Promise<MergeItem> {
    const first = this.get(id);
    if (!first) return Promise.reject(new Error(`unknown merge queue item ${id}`));
    if (!existsSync(first.integrationWorktree)) return Promise.reject(new RepositoryMutationError("ownership_changed", "Integration worktree is missing; its publication receipts and physical owner cannot be verified. Restore the retained worktree for explicit recovery; queue state is preserved"));
    return serial(first.lockKey, () => this.withBranch(first, async key => {
      const stale = (this.db.prepare("SELECT * FROM merge_queue WHERE branch = ? AND state IN ('integrating','picked') AND id != ? ORDER BY created_at").all(first.branch, id) as Row[]).map(toItem);
      for (const s of stale) {
        if (!existsSync(s.integrationWorktree)) {
          if (s.lockKey === first.lockKey) await this.recoverItem(s, hooks);
        } else if (await this.branchKey(s) === key) await this.recoverItem(s, hooks);
      }
      const item = this.get(id)!;
      if (!ACTIVE_MERGE_STATES.has(item.state)) return item;
      if (item.state !== "queued" && item.owner !== this.owner) return this.recoverItem(item, hooks);
      return this.process(item, hooks);
    }));
  }

  /**
   * Finish what a dead run of this job left in the queue: items in progress are completed (their
   * commits are all on the branch) or retried once; items it queued but never started run now.
   */
  async recover(jobId: string, hooks: MergeHooks): Promise<MergeItem[]> {
    const items = this.forJob(jobId).filter((i) => ACTIVE_MERGE_STATES.has(i.state) && i.owner !== this.owner);
    const out: MergeItem[] = [];
    for (const i of items) out.push(await serial(i.lockKey, () => existsSync(i.integrationWorktree)
      ? this.withBranch(i, () => this.recoverItem(this.get(i.id)!, hooks))
      : this.recoverItem(this.get(i.id)!, hooks)));
    return out;
  }

  private async recoverItem(item: MergeItem, hooks: MergeHooks): Promise<MergeItem> {
    if (!ACTIVE_MERGE_STATES.has(item.state)) return item;
    if (!existsSync(item.integrationWorktree)) {
      throw new RepositoryMutationError("ownership_changed", "Integration worktree is missing; its publication receipts and physical owner cannot be verified. Restore the retained worktree for explicit recovery; queue state is preserved");
    }
    const next = await this.withMutation(item, hooks, async (mutation, command) => {
      if (item.state === "queued") {
        this.event(item, "merge_recovered", { outcome: "started", previousOwner: item.owner });
        return { kind: "process" as const, item };
      }
      await this.assertOwnedHead(item);
      if (item.sourceWorktree && existsSync(item.sourceWorktree) && await headOf(item.sourceWorktree) !== item.sourceHead)
        throw new RepositoryMutationError("ownership_changed", "Merge source HEAD changed before recovery; sequencer state is preserved");
      const aborted = [...(await abortInProgress(item.integrationWorktree, { mutation, command })), ...(item.sourceWorktree ? (await abortInProgress(item.sourceWorktree, { mutation })).map((a) => `source ${a}`) : [])];
      if (item.state === "picked") {
        const owned = this.update(item.id, { owner: this.owner });
        this.event(owned, "merge_recovered", { outcome: "completed", from: "picked", aborted });
        return { kind: "finish" as const, item: owned };
      }
      // integrating: which of its commits reached the branch before the run died?
      const present = await pickedSources(item.integrationWorktree, item.beforeHead!);
      const missing = item.commits.filter((c) => !present.has(c));
      if (!missing.length) {
        const picked = this.update(item.id, { state: "picked", owner: this.owner, afterHead: await headOf(item.integrationWorktree) });
        this.event(picked, "merge_recovered", { outcome: "completed", from: "integrating", present: item.commits.length, aborted });
        return { kind: "finish" as const, item: picked };
      }
      if (item.attempts >= MAX_MERGE_ATTEMPTS) {
        await this.restore(item);
        const failed = this.update(item.id, { state: "failed", owner: this.owner, detail: { ...item.detail, error: `interrupted ${item.attempts} times while integrating; the branch was restored to ${item.beforeHead!.slice(0, 12)}` } });
        this.event(failed, "merge_recovered", { outcome: "failed", present: item.commits.length - missing.length, missing: missing.length, aborted });
        return { kind: "done" as const, item: failed };
      }
      const retry = this.update(item.id, { owner: this.owner, attempts: item.attempts + 1 });
      this.event(retry, "merge_recovered", { outcome: "retried", attempt: retry.attempts, present: item.commits.length - missing.length, missing: missing.length, aborted });
      return { kind: "pick" as const, item: retry };
    });
    if (next.kind === "process") return this.process(next.item, hooks);
    if (next.kind === "finish") return this.finish(next.item, hooks);
    if (next.kind === "pick") return this.pickAndFinish(next.item, hooks);
    return next.item;
  }

  private async process(item: MergeItem, hooks: MergeHooks): Promise<MergeItem> {
    const started = await this.withMutation(item, hooks, async () => {
      for (const root of [item.integrationWorktree, ...(item.sourceWorktree ? [item.sourceWorktree] : [])])
        for (const marker of ["CHERRY_PICK_HEAD", "REVERT_HEAD", "sequencer", "rebase-merge", "rebase-apply"])
          if (await gitPathExists(root, marker)) throw new RepositoryMutationError("ownership_changed", "Merge admission found an existing sequencer; explicit recovery is required");
      const branch = (await git(item.integrationWorktree, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => "")).trim();
      if (branch !== item.branch) {
        const failed = this.update(item.id, { state: "failed", owner: this.owner, detail: { ...item.detail, error: `the integration worktree is on ${branch || "a detached HEAD"}, not ${item.branch}` } });
        this.event(failed, "merge_failed", { error: failed.detail.error });
        return failed;
      }
      const head = await headOf(item.integrationWorktree);
      const started = this.update(item.id, { state: "integrating", owner: this.owner, attempts: item.attempts + 1, beforeHead: item.beforeHead ?? head });
      this.event(started, "merge_integrating", { attempt: started.attempts, beforeHead: started.beforeHead, commits: started.commits.length });
      return started;
    });
    return started.state === "integrating" ? this.pickAndFinish(started, hooks) : started;
  }

  private async pickAndFinish(item: MergeItem, hooks: MergeHooks): Promise<MergeItem> {
    try {
      const picked = await this.withMutation(item, hooks, async (mutation, command) => {
        await hooks.validateSource?.(item);
        let r = await this.pick(item, hooks, mutation, command);
        if (!r.ok && (hooks.allowRebase?.(item) ?? true) && !item.rebased && item.sourceWorktree && existsSync(item.sourceWorktree) && (await isClean(item.sourceWorktree))) {
          const rb = await this.rebase(item, hooks, mutation);
          if (rb.ok) {
            const dropped = item.commits.length - rb.commits.length;
            item = this.update(item.id, { commits: rb.commits, rebased: true, sourceBase: item.beforeHead!, sourceHead: rb.head, detail: { ...this.get(item.id)!.detail, rebasedFrom: { base: item.sourceBase, head: item.sourceHead, commits: item.commits } } });
            this.event(item, "merge_rebased", { onto: item.beforeHead, commits: rb.commits.length, dropped, conflict: r.conflict });
            r = await this.pick(item, hooks, mutation, command);
          } else r = { ok: false, conflict: rb.conflict };
        }
        if (!r.ok) return { kind: "conflict" as const, conflict: r.conflict };
        return { kind: "picked" as const, item: this.update(item.id, { state: "picked", afterHead: r.head }) };
      });
      return await (picked.kind === "conflict" ? this.conflicted(item, picked.conflict, hooks) : this.finish(picked.item, hooks));
    } catch (err) {
      if (isSimulatedCrash(err) || err instanceof RepositoryMutationError || err instanceof SelectedCommitError) throw err;
      return this.withMutation(item, hooks, async (mutation, command) => {
        await abortInProgress(item.integrationWorktree, { mutation, command });
        await this.restore(item);
        const failed = this.update(item.id, { state: "failed", detail: { ...item.detail, error: (err as Error).message.slice(0, 500) } });
        this.event(failed, "merge_failed", { error: failed.detail.error });
        return failed;
      });
    }
  }

  /** Put the branch back where it was before this item (never the supervisor's uncommitted edits). */
  private async restore(item: MergeItem): Promise<void> {
    if (!item.beforeHead) return;
    const head = await this.assertOwnedHead(item);
    if (head === item.beforeHead) return;
    // The common-owner lease excludes cooperating framework writers. This immediate exact
    // owned-chain check protects known foreign advances; reset itself has no native HEAD CAS,
    // so arbitrary unmanaged writers racing this check remain outside this rollback guarantee.
    await git(item.integrationWorktree, ["reset", "--keep", item.beforeHead]);
  }

  private async assertOwnedHead(item: MergeItem): Promise<string> {
    const head = await headOf(item.integrationWorktree);
    if (head === item.beforeHead) return head;
    if (!item.beforeHead) throw new RepositoryMutationError("ownership_changed", "Merge recovery has no recorded baseline");
    const current = this.get(item.id)!;
    const owned = z.array(z.object({ source: z.string(), head: z.string(), parent: z.string() }).strict()).parse(current.detail.ownedPicks ?? []);
    const chain = (await git(item.integrationWorktree, ["rev-list", "--reverse", "--parents", `${item.beforeHead}..${head}`])).trim().split(/\r?\n/).filter(Boolean);
    let parent = item.beforeHead;
    for (const line of chain) {
      const [commit, previous, ...extra] = line.split(/\s+/);
      if (extra.length || previous !== parent || !owned.some(pick => pick.head === commit && pick.parent === previous && item.commits.includes(pick.source)))
        throw new RepositoryMutationError("ownership_changed", "Merge restore refused: current HEAD contains an unowned or uncertain commit");
      parent = commit!;
    }
    if (!chain.length || parent !== head)
      throw new RepositoryMutationError("ownership_changed", "Merge restore refused: recorded base is not the owned current chain");
    return head;
  }

  private env(hooks: MergeHooks): Record<string, string> {
    return { GIT_COMMITTER_NAME: hooks.committer.name, GIT_COMMITTER_EMAIL: hooks.committer.email };
  }

  /** Pick the item's commits that are not on the branch yet, one at a time. On failure the branch is restored. */
  private async pick(item: MergeItem, hooks: MergeHooks, mutation: RepositoryMutationCapability, command: readonly RepositoryCommandPermit[]): Promise<{ ok: true; head: string } | { ok: false; conflict: MergeConflict }> {
    const wt = item.integrationWorktree;
    const present = await pickedSources(wt, item.beforeHead!);
    for (const c of item.commits) {
      if (present.has(c)) continue;
      const expectedParent = await headOf(wt);
      try {
        await git(wt, ["cherry-pick", "-x", "--allow-empty", c], { env: this.env(hooks) });
      } catch (err) {
        const files = await unmergedFiles(wt);
        if (err instanceof RepositoryMutationError || err instanceof SelectedCommitError) throw err;
        await abortInProgress(wt, { mutation, command });
        await this.restore(item);
        return { ok: false, conflict: { files, message: (err as Error).message.replace(/\s+/g, " ").slice(0, 300), commit: c, stage: "pick" } };
      }
      const current = this.get(item.id)!;
      const head = await headOf(wt);
      const parents = (await git(wt, ["rev-list", "--parents", "-n", "1", head])).trim().split(/\s+/);
      const body = await git(wt, ["log", "-1", "--format=%B", head]);
      if (parents.length !== 2 || parents[1] !== expectedParent || ![...body.matchAll(PICKED_RE)].some(match => match[1] === c))
        throw new RepositoryMutationError("ownership_changed", "Native pick result no longer matches its captured parent and source");
      const ownedPicks = z.array(z.object({ source: z.string(), head: z.string(), parent: z.string() }).strict()).parse(current.detail.ownedPicks ?? []);
      this.update(item.id, { detail: { ...current.detail, ownedPicks: [...ownedPicks, { source: c, head, parent: parents[1] }] } });
      faultPoint("after_tool_run", MERGE_PICK_FAULT);
    }
    return { ok: true, head: await headOf(wt) };
  }

  /**
   * Replay the item's commits onto the branch head in its own worktree (from its recorded
   * source head, so a repeat after a crash replays the same commits). Commits that become empty
   * there (the branch already has their change) are dropped.
   */
  private async rebase(item: MergeItem, hooks: MergeHooks, mutation: RepositoryMutationCapability): Promise<{ ok: true; commits: string[]; head: string } | { ok: false; conflict: MergeConflict }> {
    const src = item.sourceWorktree!;
    const onto = item.beforeHead!;
    try {
      await git(src, ["rebase", "--empty=drop", "--onto", onto, item.sourceBase, item.sourceHead], { env: this.env(hooks) });
    } catch (err) {
      if (err instanceof RepositoryMutationError || err instanceof SelectedCommitError) throw err;
      const files = await unmergedFiles(src);
      await abortInProgress(src, { mutation });
      return { ok: false, conflict: { files, message: (err as Error).message.replace(/\s+/g, " ").slice(0, 300), commit: null, stage: "rebase" } };
    }
    const head = await headOf(src);
    const commits = (await git(src, ["rev-list", "--reverse", `${onto}..${head}`])).split("\n").map((l) => l.trim()).filter(Boolean);
    return { ok: true, commits, head };
  }

  private async conflicted(item: MergeItem, conflict: MergeConflict, hooks: MergeHooks): Promise<MergeItem> {
    const detail: Record<string, unknown> = { ...item.detail, conflict };
    if (hooks.redelegate && this.mayRedelegate(item.taskId)) {
      let to: string | null = null;
      try {
        to = await hooks.redelegate(item, conflict);
      } catch (err) {
        if (isSimulatedCrash(err) || err instanceof RepositoryMutationError || err instanceof SelectedCommitError) throw err;
        detail.redelegateError = (err as Error).message.slice(0, 300);
      }
      if (to) {
        return this.withMutation(item, hooks, async () => {
          const r = this.update(item.id, { state: "redelegated", redelegatedTo: to, detail });
          this.event(r, "merge_redelegated", { to, conflict });
          return r;
        });
      }
    }
    return this.withMutation(item, hooks, async () => {
      const r = this.update(item.id, { state: "conflict", detail });
      this.event(r, "merge_conflict", { conflict, redelegated: false });
      return r;
    });
  }

  /** The commits are on the branch: record the acceptance, the integration, and the job checks. */
  private async finish(item: MergeItem, hooks: MergeHooks): Promise<MergeItem> {
    let done = await this.withMutation(item, hooks, async () => {
      const actualHead = await this.assertOwnedHead(item);
      if (item.afterHead && actualHead !== item.afterHead) throw new RepositoryMutationError("ownership_changed", "Merge integration HEAD no longer matches the captured picked chain");
      try {
        await hooks.validateSource?.(item);
      } catch (error) {
        if (error instanceof RepositoryMutationError || error instanceof SelectedCommitError) throw error;
        await this.restore(item);
        const refused = this.update(item.id, { state: "refused", detail: { ...item.detail, error: (error as Error).message.slice(0, 500) } });
        this.event(refused, "merge_refused", { error: refused.detail.error });
        return refused;
      }
      if (item.acceptance && hooks.accept) {
        try {
          hooks.accept(item);
        } catch (err) {
          if (err instanceof RepositoryMutationError || err instanceof SelectedCommitError) throw err;
          await this.restore(item);
          const refused = this.update(item.id, { state: "refused", detail: { ...item.detail, error: (err as Error).message.slice(0, 500) } });
          this.event(refused, "merge_refused", { error: refused.detail.error });
          return refused;
        }
      }
      const head = item.afterHead ?? (await headOf(item.integrationWorktree));
      hooks.integrated(item, head);
      const done = this.update(item.id, { state: "integrated", afterHead: head });
      this.event(done, "merge_integrated", { commits: done.commits.length, head, rebased: done.rebased, attempts: done.attempts });
      return done;
    });
    if (done.state !== "integrated") return done;
    if (hooks.checks) {
      const checks = await hooks.checks(done);
      if (checks.length) {
        done = await this.withMutation(done, hooks, async () => {
          if (await headOf(done.integrationWorktree) !== done.afterHead) throw new RepositoryMutationError("ownership_changed", "Merge checks completed against a superseded HEAD");
          const checked = this.update(done.id, { detail: { ...done.detail, checks } });
          this.event(checked, "merge_checks", { head: done.afterHead, checks, passed: checks.every((c) => c.exitCode === 0) });
          return checked;
        });
      }
    }
    return done;
  }
}
