import { assertLabEffect } from "./control-authority.js";
import path from "node:path";
import { realpathSync } from "node:fs";
import { z } from "zod";
import type { LabManager, LabStatus } from "./lab.js";
import { ProjectConfigSchema } from "../projects/schema.js";
import { immediate, newId } from "../storage/db.js";
import { TaskStore } from "../storage/tasks.js";
import { isTerminal } from "../core/task.js";
import { dirtyPaths, git as unguardedGit } from "../workspaces/git.js";
import { quoteShellArg } from "../runners/coding/process.js";
import { LabCheckResultSchema, type LabCheckResult } from "./checks.js";
import { SwitchyardError } from "../core/errors.js";
export const LabPromotionInputSchema = z.object({ by: z.enum(["human", "supervisor", "auto"]), reason: z.string().max(2000).optional() }).strict();
export type LabPromotionInput = z.infer<typeof LabPromotionInputSchema>;
export const LabPromotionResultSchema = z.object({ id: z.string(), state: z.enum(["prepared", "promoted", "conflict", "failed", "partial"]), policy: z.enum(["manual", "supervisor", "auto"]), heads: z.record(z.string(), z.string()), targets: z.record(z.string(), z.string()), checks: z.array(LabCheckResultSchema), commands: z.array(z.string()), conflicts: z.record(z.string(), z.array(z.string())), error: z.string().nullable() });
export type LabPromotionResult = z.infer<typeof LabPromotionResultSchema>;
export interface PromotionActions {
  refresh: () => Promise<LabStatus>;
  start: () => Promise<LabStatus>;
  check: (name: string) => Promise<LabCheckResult>;
}
const LEASE = 120000;
async function ownHeads(manager: LabManager, project: string, name: string): Promise<Record<string, string>> {
  const s = manager.status(project, name);
  const heads: Record<string, string> = {};
  for (const repo of s.lab.repositories) {
    const branch = (await git(repo.worktree, ["symbolic-ref", "--quiet", "HEAD"])).trim();
    if (branch !== `refs/heads/${repo.branch}`)
      throw new SwitchyardError("lab_scope_denied", "lab worktree no longer owns its recorded branch");
    if ((await dirtyPaths(repo.worktree)).length)
      throw new SwitchyardError("lab_dirty", "lab promotion requires clean committed worktrees");
    const head = (await git(repo.worktree, ["rev-parse", "HEAD"])).trim();
    const ref = (await git(repo.source, ["rev-parse", "--verify", `refs/heads/${repo.branch}`])).trim();
    if (head !== ref)
      throw new SwitchyardError("lab_scope_denied", "lab branch and checkout revision differ");
    heads[repo.alias] = head;
  }
  return heads;
}
function assertTeamSettled(manager: LabManager, labId: string): void {
  const row = z.object({ root_job_id: z.string() }).optional().parse(manager.options.db.prepare("SELECT root_job_id FROM lab_teams WHERE lab_id=?").get(labId));
  if (!row)
    return;
  const tasks = new TaskStore(manager.options.db), pending = tasks.childrenOf(row.root_job_id), seen = new Set<string>();
  while (pending.length) {
    const t = pending.pop()!;
    if (seen.has(t.row.id) || seen.size >= 5000)
      throw new SwitchyardError("lab_team_busy", "invalid or oversized lab team ancestry");
    seen.add(t.row.id);
    if (!isTerminal(t.row.state))
      throw new SwitchyardError("lab_team_busy", `finish lab task ${t.row.id} before promotion`);
    pending.push(...tasks.childrenOf(t.row.id));
  }
}
async function targetWorktree(source: string, target: string): Promise<string | null> {
  const raw = (await git(source, ["worktree", "list", "--porcelain", "-z"])).split("\0");
  let current: string | null = null;
  for (const part of raw) {
    if (part.startsWith("worktree "))
      current = part.slice(9);
    else if (part === `branch refs/heads/${target}`)
      return current;
  }
  return null;
}
function writable(manager: LabManager, project: string, alias: string): boolean {
  return manager.options.project(project).repositoryPaths[alias]?.writable === true;
}
async function assertReadOnlyHeads(manager: LabManager, project: string, status: LabStatus): Promise<void> {
  for (const repo of status.lab.repositories) {
    if (writable(manager, project, repo.alias))
      continue;
    const head = status.heads[repo.alias];
    if (!head)
      throw new SwitchyardError("lab_scope_denied", "read-only lab repository has no verified head");
    try {
      await git(repo.source, ["merge-base", "--is-ancestor", head, `refs/heads/${repo.target}`]);
    }
    catch {
      throw new SwitchyardError("lab_scope_denied", `read-only repository ${repo.alias} contains lab changes and cannot be promoted`);
    }
  }
}
export async function promoteLab(manager: LabManager, project: string, name: string, raw: LabPromotionInput, actions: PromotionActions): Promise<LabPromotionResult> {
  const input = LabPromotionInputSchema.parse(raw);
  const status = manager.status(project, name);
  if(status.lab.kind!=="retained")throw new SwitchyardError("lab_scope_denied","task-owned Labs cannot be promoted");
  const policy = ProjectConfigSchema.parse(manager.options.cfg.projects[project] ?? {}).labs.promotion;
  if (policy === "supervisor" && input.by === "auto")
    throw new SwitchyardError("lab_promotion_policy", "this project requires a supervisor or person to promote");
  assertTeamSettled(manager, status.lab.id);
  await assertReadOnlyHeads(manager, project, status);
  if (!Object.keys(status.lab.recipe.checks).length)
    throw new SwitchyardError("lab_checks_required", "configure declared lab checks before preparing a promotion");
  const id = newId("lprom"), locks: Array<{
    repository: string;
    target: string;
  }> = [], locksByAlias = new Map<string, {
    repository: string;
    target: string;
  }>();
  const result: LabPromotionResult = { id, state: "failed", policy, heads: {}, targets: {}, checks: [], commands: [], conflicts: {}, error: null };
  for (const repo of status.lab.repositories) {
    if (!writable(manager, project, repo.alias))
      continue;
    const common = (await git(repo.source, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
    const lock = { repository: realpathSync(common), target: repo.target };
    if (locks.some(x => x.repository === lock.repository && x.target === lock.target))
      throw new SwitchyardError("lab_promotion_conflict", "multiple aliases share the same physical promotion target");
    locks.push(lock);
    locksByAlias.set(repo.alias, lock);
  }
  locks.sort((a, b) => (a.repository + a.target).localeCompare(b.repository + b.target));
  immediate(manager.options.db, () => {
    for (const lock of locks) {
      const old = z.object({ holder_id: z.string(), lease_until: z.number() }).optional().parse(manager.options.db.prepare("SELECT holder_id,lease_until FROM lab_target_locks WHERE repository=? AND target=?").get(lock.repository, lock.target));
      if (old && old.lease_until > Date.now())
        throw new SwitchyardError("lab_promotion_busy", "another lab is promoting to this target");
      manager.options.db.prepare("INSERT INTO lab_target_locks(repository,target,holder_id,lease_until) VALUES(?,?,?,?) ON CONFLICT(repository,target) DO UPDATE SET holder_id=excluded.holder_id,lease_until=excluded.lease_until").run(lock.repository, lock.target, id, Date.now() + LEASE);
    }
    manager.options.db.prepare("INSERT INTO lab_promotions(id,lab_id,state,policy,created_at,updated_at) VALUES(?,?,'checking',?,?,?)").run(id, status.lab.id, policy, Date.now(), Date.now());
  });
  const timer = setInterval(() => manager.options.db.prepare("UPDATE lab_target_locks SET lease_until=? WHERE holder_id=?").run(Date.now() + LEASE, id), 10000);
  timer.unref();
  let applied = 0;
  try {
    await ownHeads(manager, project, name);
    try {
      await actions.refresh();
    }
    catch (err) {
      for (const repo of manager.status(project, name).lab.repositories) {
        const paths = (await git(repo.worktree, ["diff", "--name-only", "--diff-filter=U", "-z"])).split("\0").filter(Boolean);
        if (paths.length)
          result.conflicts[repo.alias] = paths;
      }
      if (Object.keys(result.conflicts).length) {
        result.state = "conflict";
        result.error = (err as Error).message;
        return result;
      }
      throw err;
    }
    result.heads = await ownHeads(manager, project, name);
    const current = manager.status(project, name);
    for (const repo of current.lab.repositories)
      result.targets[repo.alias] = (await git(repo.source, ["rev-parse", "--verify", `refs/heads/${repo.target}`])).trim();
    if (current.lab.state !== "running")
      await actions.start();
    for (const check of Object.keys(current.lab.recipe.checks)) {
      const checked = await actions.check(check);
      result.checks.push(checked);
      if (checked.exitCode !== 0 || checked.killed)
        throw new SwitchyardError("lab_checks_failed", `lab check ${check} did not pass on the candidate revision`);
    }
    await assertReadOnlyHeads(manager, project, manager.status(project, name));
    const actual = await ownHeads(manager, project, name);
    if (JSON.stringify(actual) !== JSON.stringify(result.heads))
      throw new SwitchyardError("lab_revision_changed", "lab revision changed after its checks");
    for (const repo of manager.status(project, name).lab.repositories) {
      const expected = result.targets[repo.alias]!;
      if ((await git(repo.source, ["rev-parse", "--verify", `refs/heads/${repo.target}`])).trim() !== expected)
        throw new SwitchyardError("lab_target_changed", "target advanced during promotion; refresh and check again");
      await git(repo.source, ["merge-base", "--is-ancestor", expected, result.heads[repo.alias]!]);
      if (!writable(manager, project, repo.alias))
        continue;
      const checkout = await targetWorktree(repo.source, repo.target) ?? repo.source;
      result.commands.push(`git -C ${quoteShellArg(checkout)} switch ${quoteShellArg(repo.target)}`);
      result.commands.push(`git -C ${quoteShellArg(checkout)} merge --ff-only ${quoteShellArg(result.heads[repo.alias]!)}`);
    }
    if (policy === "manual") {
      result.state = "prepared";
      return result;
    }
    for (const repo of manager.status(project, name).lab.repositories) {
      if (!writable(manager, project, repo.alias))
        continue;
      await assertReadOnlyHeads(manager, project, manager.status(project, name));
      const lock = locksByAlias.get(repo.alias);
      if (!lock || !(manager.options.db.prepare("SELECT holder_id FROM lab_target_locks WHERE repository=? AND target=? AND holder_id=? AND lease_until>?").get(lock.repository, lock.target, id, Date.now())))
        throw new SwitchyardError("lab_promotion_lease_lost", "promotion target lock expired");
      const latest = await ownHeads(manager, project, name);
      if (latest[repo.alias] !== result.heads[repo.alias])
        throw new SwitchyardError("lab_revision_changed", "lab head changed before target mutation");
      const expected = result.targets[repo.alias]!, candidate = result.heads[repo.alias]!;
      const checkout = await targetWorktree(repo.source, repo.target);
      if (checkout) {
        if ((await dirtyPaths(checkout)).length)
          throw new SwitchyardError("lab_target_dirty", "target checkout has uncommitted user changes; they were preserved");
        if ((await git(checkout, ["symbolic-ref", "--quiet", "HEAD"])).trim() !== `refs/heads/${repo.target}` || (await git(checkout, ["rev-parse", "HEAD"])).trim() !== expected)
          throw new SwitchyardError("lab_target_changed", "target checkout changed before promotion");
        await git(checkout, ["merge", "--ff-only", "--no-edit", candidate]);
      }
      else
        await git(repo.source, ["update-ref", `refs/heads/${repo.target}`, candidate, expected]);
      applied++;
      manager.store.event(current.lab.id, "target_promoted", { promotion: id, repository: repo.alias, target: repo.target, from: expected, to: candidate });
    }
    result.state = "promoted";
    return result;
  }
  catch (err) {
    result.state = applied ? "partial" : "failed";
    result.error = (err as Error).message;
    return result;
  }
  finally {
    clearInterval(timer);
    manager.options.db.prepare("UPDATE lab_promotions SET state=?,revisions_json=?,targets_json=?,details_json=?,updated_at=? WHERE id=?").run(result.state, JSON.stringify(result.heads), JSON.stringify(result.targets), JSON.stringify(result), Date.now(), id);
    manager.options.db.prepare("DELETE FROM lab_target_locks WHERE holder_id=?").run(id);
    manager.store.event(status.lab.id, "promotion_finished", { id, state: result.state });
  }
}

async function git(...args: Parameters<typeof unguardedGit>): Promise<string> {
  assertLabEffect();
  const result = await unguardedGit(...args);
  assertLabEffect();
  return result;
}