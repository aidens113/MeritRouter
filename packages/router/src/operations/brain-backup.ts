import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ResolvedConfig } from "../config/load.js";
import { expandHome } from "../brain/brain.js";
import { MeritRouterError } from "../core/errors.js";

/**
 * The brain half of a backup: the brain repository (every project's folder and `global/`) as a
 * git bundle of all its refs, and its restore. Only committed history travels; brain mounts are
 * folders in other repositories and are listed in the manifest as not included. A restore never
 * overwrites a brain with uncommitted changes, `--force` or not.
 */

export const BRAIN_BUNDLE = "brain.bundle";
/** The brain's cross-process write lock (src/brain/brain.ts); never counted as a change. */
const BRAIN_LOCK = ".switchyard-brain.lock";

export const BrainMountNoteSchema = z
  .object({
    prefix: z.string(),
    path: z.string(),
    /** The project that adds the mount; null for a global (`brain.mounts`) mount. */
    project: z.string().nullable(),
  })
  .strict();
export type BrainMountNote = z.infer<typeof BrainMountNoteSchema>;

export const BrainManifestSchema = z
  .object({
    included: z.boolean(),
    /** Absolute brain repository the backup was taken from. */
    sourcePath: z.string(),
    /** Why the brain is not in the backup (no repository, no commits). */
    reason: z.string().nullable(),
    /** Bundle file inside the backup directory. */
    bundle: z.string().nullable(),
    /** Branch HEAD pointed at (null when detached or not included). */
    head: z.string().nullable(),
    commit: z.string().nullable(),
    commits: z.number().int().nonnegative(),
    /** Paths with uncommitted changes at backup time: not in the bundle. */
    uncommitted: z.array(z.string()),
    /** Brain mounts: folders outside the brain repository, never included. */
    mountsNotIncluded: z.array(BrainMountNoteSchema),
  })
  .strict();
export type BrainManifest = z.infer<typeof BrainManifestSchema>;

/** The brain repository directory of a config (as `Brain` resolves it). */
export function brainPathOf(cfg: Pick<ResolvedConfig, "configPath" | "brain">): string {
  return path.resolve(path.dirname(cfg.configPath), expandHome(cfg.brain.path));
}

/** Every brain mount of a config: the global ones, then each project's own. */
export function brainMountsOf(cfg: Pick<ResolvedConfig, "configPath" | "brain" | "projectResolution">): BrainMountNote[] {
  const base = path.dirname(cfg.configPath);
  const abs = (p: string) => path.resolve(base, expandHome(p));
  const global = cfg.brain.mounts.map((m) => ({ prefix: m.prefix, path: abs(m.path), project: null }));
  const own = cfg.projectResolution.projects.flatMap((p) =>
    // A project's brain overlay lists the global mounts first, then its own (projects/resolve.ts).
    (p.overrides.brain?.mounts ?? []).slice(cfg.brain.mounts.length).map((m) => ({ prefix: m.prefix, path: abs(m.path), project: p.slug })),
  );
  return [...global, ...own];
}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } });
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new MeritRouterError("internal", `git ${args[0]} failed in ${cwd}: ${(e.stderr || e.message).trim()}`);
  }
}

function tryGit(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args).trim();
  } catch {
    return null;
  }
}

/** True when `dir` is the top of a git work tree (not merely inside another repository). */
function isRepoRoot(dir: string): boolean {
  return existsSync(path.join(dir, ".git"));
}

/** Paths with uncommitted changes (tracked or untracked), ignoring the brain's lock file. */
export function uncommittedBrainPaths(dir: string): string[] {
  const out = git(dir, ["status", "--porcelain=v1", "--untracked-files=all", "-z"]);
  const paths: string[] = [];
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (!entry) continue;
    const status = entry.slice(0, 2);
    const p = entry.slice(3);
    // A rename or copy is followed by its source path.
    if (status[0] === "R" || status[0] === "C") i++;
    if (p !== BRAIN_LOCK) paths.push(p);
  }
  return paths;
}

/** Bundle the brain at `brainPath` into `targetDir/brain.bundle`; the manifest says what was kept. */
export function backupBrain(brainPath: string, targetDir: string, mounts: BrainMountNote[]): BrainManifest {
  const sourcePath = path.resolve(brainPath);
  const skipped = (reason: string): BrainManifest => ({ included: false, sourcePath, reason, bundle: null, head: null, commit: null, commits: 0, uncommitted: [], mountsNotIncluded: mounts });
  if (!existsSync(sourcePath)) return skipped(`no brain repository at ${sourcePath} (the brain has not been used yet)`);
  if (!isRepoRoot(sourcePath)) return skipped(`${sourcePath} is not a git repository (brain.commit off?); copy it yourself`);
  const commit = tryGit(sourcePath, ["rev-parse", "--verify", "-q", "HEAD"]);
  if (!commit) return skipped(`the brain repository at ${sourcePath} has no commits yet`);
  const head = tryGit(sourcePath, ["symbolic-ref", "-q", "--short", "HEAD"]) || null;
  const commits = Number(git(sourcePath, ["rev-list", "--count", "--all"]).trim()) || 0;
  const uncommitted = uncommittedBrainPaths(sourcePath);
  const bundle = path.join(targetDir, BRAIN_BUNDLE);
  git(sourcePath, ["bundle", "create", "-q", bundle, "--all"]);
  git(sourcePath, ["bundle", "verify", "-q", bundle]);
  return { included: true, sourcePath, reason: null, bundle: BRAIN_BUNDLE, head, commit, commits, uncommitted, mountsNotIncluded: mounts };
}

export type BrainRestorePlan =
  | { action: "skip"; brainPath: string; detail: string }
  | { action: "same"; brainPath: string; detail: string }
  | { action: "create"; brainPath: string }
  | { action: "replace"; brainPath: string };

export interface BrainRestoreResult {
  action: BrainRestorePlan["action"];
  brainPath: string;
  detail: string;
  /** Where the replaced brain was moved (`<brain>.pre-restore-<time>`), when one was replaced. */
  previousMovedTo: string | null;
  commit: string | null;
}

const isNonEmptyDir = (dir: string) => existsSync(dir) && statSync(dir).isDirectory() && readdirSync(dir).length > 0;

/**
 * Decide what a restore does to the brain at `brainPath`, refusing before anything changes:
 * a brain with uncommitted changes is never replaced, and a brain with other content needs
 * `force` (it is then moved aside, not deleted).
 */
export function planBrainRestore(manifest: BrainManifest | null | undefined, backupDir: string, brainPath: string | undefined, force: boolean): BrainRestorePlan {
  if (!brainPath) return { action: "skip", brainPath: "", detail: "no brain path was given; the brain was not restored" };
  const target = path.resolve(brainPath);
  if (!manifest) return { action: "skip", brainPath: target, detail: "this backup has no brain (taken before brain backups); the brain was left as it is" };
  if (!manifest.included || !manifest.bundle) return { action: "skip", brainPath: target, detail: `the backup does not include the brain (${manifest.reason ?? "not included"}); the brain was left as it is` };
  const bundle = path.join(backupDir, manifest.bundle);
  if (!existsSync(bundle)) throw new MeritRouterError("not_found", `backup ${backupDir} lists the brain but has no ${manifest.bundle}`);
  if (!isNonEmptyDir(target)) return { action: "create", brainPath: target };
  if (isRepoRoot(target)) {
    const dirty = uncommittedBrainPaths(target);
    if (dirty.length) {
      throw new MeritRouterError(
        "conflict",
        `refusing to restore: the brain at ${target} has ${dirty.length} uncommitted change(s) (${dirty.slice(0, 5).join(", ")}${dirty.length > 5 ? ", ..." : ""}); commit or discard them first (a restore never overwrites uncommitted brain work)`,
      );
    }
    const commit = tryGit(target, ["rev-parse", "--verify", "-q", "HEAD"]);
    const head = tryGit(target, ["symbolic-ref", "-q", "--short", "HEAD"]) || null;
    if (commit && commit === manifest.commit && head === manifest.head) return { action: "same", brainPath: target, detail: `the brain at ${target} is already at the backup's commit ${commit.slice(0, 12)}` };
  }
  if (!force) throw new MeritRouterError("conflict", `refusing to restore over the existing brain at ${target}; pass --force to move it aside first`);
  return { action: "replace", brainPath: target };
}

/** Verified replacement prepared without moving the live brain. */
export interface StagedBrainRestore { path: string | null; commit: string | null }

/** Remove only this restore's generated staging directory; cleanup cannot undo a committed restore. */
export function discardStagedBrainRestore(staged: StagedBrainRestore): void {
  if (staged.path && existsSync(staged.path)) {
    try { rmSync(staged.path, { recursive: true, force: true }); } catch { /* Retain a locked staging directory for later cleanup. */ }
  }
}

/** Build and verify the complete replacement before either half of the install is moved. */
export function stageBrainRestore(plan: BrainRestorePlan, manifest: BrainManifest | null | undefined, backupDir: string): StagedBrainRestore {
  if (plan.action === "skip" || plan.action === "same") return { path: null, commit: plan.action === "same" ? (manifest?.commit ?? null) : null };
  const m = manifest!;
  mkdirSync(path.dirname(plan.brainPath), { recursive: true });
  const staging = mkdtempSync(`${plan.brainPath}.restore-`);
  const staged: StagedBrainRestore = { path: staging, commit: null };
  try {
    git(staging, ["init", "-q", "-b", m.head ?? "main"]);
    git(staging, ["config", "core.autocrlf", "false"]);
    git(staging, ["fetch", "-q", "--update-head-ok", path.join(path.resolve(backupDir), m.bundle!), "+refs/*:refs/*"]);
    if (m.head) {
      git(staging, ["symbolic-ref", "HEAD", `refs/heads/${m.head}`]);
      git(staging, ["reset", "-q", "--hard", m.commit!]);
    } else git(staging, ["checkout", "-q", "-f", "--detach", m.commit!]);
    staged.commit = tryGit(staging, ["rev-parse", "--verify", "-q", "HEAD"]);
    if (!staged.commit || staged.commit !== m.commit) throw new MeritRouterError("internal", `restored brain HEAD ${staged.commit ?? "(none)"} does not match the backup's ${m.commit}`);
    return staged;
  } catch (error) {
    discardStagedBrainRestore(staged);
    throw error;
  }
}

/** Swap a verified brain into place; any failed swap restores the previous repository. */
export function restoreBrain(plan: BrainRestorePlan, manifest: BrainManifest | null | undefined, backupDir: string, now = Date.now(), prepared?: StagedBrainRestore): BrainRestoreResult {
  if (plan.action === "skip" || plan.action === "same") return { action: plan.action, brainPath: plan.brainPath, detail: plan.detail, previousMovedTo: null, commit: plan.action === "same" ? (manifest?.commit ?? null) : null };
  const staged = prepared ?? stageBrainRestore(plan, manifest, backupDir);
  const target = plan.brainPath;
  let previousMovedTo: string | null = null;
  let removedEmpty = false;
  try {
    if (plan.action === "replace") {
      const base = `${target}.pre-restore-${new Date(now).toISOString().replace(/[:.]/g, "-")}`;
      let previous = base;
      for (let suffix = 1; existsSync(previous); suffix++) previous = `${base}-${suffix}`;
      renameSync(target, previous);
      previousMovedTo = previous;
    } else if (existsSync(target)) {
      // Atomic rmdir refuses if another writer has added files since planning.
      rmdirSync(target);
      removedEmpty = true;
    }
    renameSync(staged.path!, target);
  } catch (error) {
    try {
      if (previousMovedTo) {
        if (existsSync(target)) throw new Error(`the target ${target} was occupied meanwhile`);
        renameSync(previousMovedTo, target);
      } else if (removedEmpty) mkdirSync(target);
    } catch (rollback) {
      throw new MeritRouterError("conflict", `brain restore failed (${(error as Error).message}); rollback failed (${(rollback as Error).message}). Previous brain remains at ${previousMovedTo ?? target}; recover it before restarting`);
    }
    throw new MeritRouterError("conflict", `brain restore failed (${(error as Error).message}); previous brain was preserved`);
  } finally {
    discardStagedBrainRestore(staged);
  }
  const m = manifest!;
  const detail = `restored the brain (${m.commits} commit(s), ${m.head ?? "detached"} at ${staged.commit!.slice(0, 12)}) into ${target}`;
  return { action: plan.action, brainPath: target, detail, previousMovedTo, commit: staged.commit };
}
