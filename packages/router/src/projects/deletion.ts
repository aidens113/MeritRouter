import { chmodSync, existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { MeritRouterError } from "../core/errors.js";
import { immediate, type Db } from "../storage/db.js";
import { git } from "../workspaces/git.js";
import { assertNoNativeWorktreeOperation } from "../workspaces/worktree-removal.js";
import { RequestCaptures } from "../storage/request-captures.js";
import { RequestReceipts } from "../admission/request-receipts.js";
import { z } from "zod";
import { SessionWorkspaceSchema } from "../sessions/events.js";
import { LabRepositorySchema } from "../labs/store.js";
import { RepositoryMutationError, withRepositoryMutation, type RepositoryMutationCapability } from "../workspaces/repository-mutation.js";
import { ProjectRuntimeManifestSchema, projectRuntimePaths, type ProjectRuntimePaths } from "./runtime-paths.js";
import { ProjectStoreRegistrationSchema, type ProjectStoreRegistration } from "./store-identity.js";

// Deleting a project (the mechanics; `admin/projects.ts` checks, confirms, and edits the config):
// what a project leaves in the store and on disk, and removing it. Its per-project rows, session
// logs, artifacts, and MeritRouter's worktrees go; model requests, their charges, and paid spend
// stay for accounting (requests are unlinked from the project); branches and the repository
// folders are never touched.

/** A git worktree MeritRouter made for one of the project's tasks or jobs. */
export interface WorktreeRef {
  /** The repository it is registered in; null for a leftover folder git no longer knows. */
  repo: string | null;
  path: string;
}

/** What a project holds in the store and on disk. */
export interface ProjectFootprint {
  slug: string;
  taskIds: string[];
  /** Top-level jobs (supervise tasks without a parent job). */
  jobs: number;
  sessions: number;
  /** Session logs (JSONL) under `<storage>/sessions`. */
  sessionLogs: string[];
  artifacts: number;
  /** Artifact files and the per-task artifact folders under `<storage>/artifacts`. */
  artifactPaths: string[];
  worktrees: WorktreeRef[];
  /** Kept: model requests recorded for the project, and those with paid spend. */
  requests: number;
  paidRequests: number;
  /** Private payloads are removed, including mixed-project payloads containing this project. */
  requestCaptures: { captures: number; bytes: number };
}

const ids = (taskIds: string[]) => JSON.stringify(taskIds);
const IN_TASKS = "(SELECT value FROM json_each(@ids))";
const SESSIONS = `(project_id = @slug OR task_id IN ${IN_TASKS} OR job_id IN ${IN_TASKS})`;
const physicalKey = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);

async function physicalOwner(root: string): Promise<string> {
  if (!existsSync(root)) throw new RepositoryMutationError("ownership_changed", `Project cleanup retained a missing repository ${root}; restore it for explicit recovery`);
  try {
    const actualRoot = (await git(root, ["rev-parse", "--show-toplevel"])).trim();
    if (physicalKey(realpathSync(actualRoot)) !== physicalKey(realpathSync(root))) throw new Error("recorded path is not the Git worktree root");
    return physicalKey(realpathSync(path.resolve(root, (await git(root, ["rev-parse", "--git-common-dir"])).trim())));
  }
  catch (error) {
    if (error instanceof RepositoryMutationError) throw error;
    throw new RepositoryMutationError("ownership_changed", `Project cleanup cannot verify physical Git ownership of ${root}: ${(error as Error).message}`);
  }
}

/** Discover retained publication/command admission roots without writing locks or cleanup state. */
export async function projectMutationRepositories(db: Db, fp: ProjectFootprint, repositories: string[], brainRoot: string): Promise<string[]> {
  const p = { slug: fp.slug, ids: ids(fp.taskIds) };
  const permittedOwners = new Set(await Promise.all(repositories.map(physicalOwner)));
  const roots = new Map(repositories.map(root => [physicalKey(root), root]));
  const workspaceRows = z.array(z.object({ worktree_path: z.string(), status: z.string() })).parse(db.prepare(`SELECT worktree_path,status FROM workspaces WHERE task_id IN ${IN_TASKS}`).all(p));
  const removed = new Set(workspaceRows.filter(row => row.status === "removed").map(row => physicalKey(row.worktree_path)));
  const labRows = z.array(z.object({ state: z.string(), repositories_json: z.string() })).parse(db.prepare("SELECT state,repositories_json FROM labs WHERE project_id=@slug").all(p));
  for (const lab of labRows.filter(row => row.state === "destroyed")) for (const repo of z.array(LabRepositorySchema).parse(JSON.parse(lab.repositories_json))) removed.add(physicalKey(repo.worktree));
  const attemptRows = z.array(z.object({ source_worktree: z.string(), phase: z.string().nullable() })).parse(db.prepare(`SELECT a.source_worktree,l.phase FROM task_workspace_attempts a LEFT JOIN lab_task_attempts l ON l.attempt_id=a.id WHERE a.task_id IN ${IN_TASKS}`).all(p));
  for (const row of attemptRows.filter(row => row.phase === "pruned")) removed.add(physicalKey(row.source_worktree));
  const retired = (root: string) => removed.has(physicalKey(root)) && !existsSync(root);
  const retained: string[] = [...fp.worktrees.map(wt => wt.path), ...workspaceRows.filter(row => !retired(row.worktree_path)).map(row => row.worktree_path)];
  const sessions = z.array(z.object({ workspace_json: z.string().nullable() })).parse(db.prepare(`SELECT workspace_json FROM sessions WHERE ${SESSIONS}`).all(p));
  for (const session of sessions) if (session.workspace_json) {
    for (const repo of SessionWorkspaceSchema.parse(JSON.parse(session.workspace_json)).repos)
      if (!retired(repo.worktree)) retained.push(repo.worktree);
  }
  const merges = z.array(z.object({ integration_worktree: z.string(), source_worktree: z.string().nullable() })).parse(db.prepare(`SELECT integration_worktree,source_worktree FROM merge_queue WHERE job_id IN ${IN_TASKS} OR task_id IN ${IN_TASKS}`).all(p));
  for (const row of merges) for (const root of [row.integration_worktree, row.source_worktree]) if (root && !retired(root)) retained.push(root);
  for (const lab of labRows) for (const repo of z.array(LabRepositorySchema).parse(JSON.parse(lab.repositories_json))) {
    if (lab.state !== "destroyed" || !retired(repo.worktree)) retained.push(repo.source, repo.worktree);
  }
  retained.push(...attemptRows.filter(row => !retired(row.source_worktree)).map(row => row.source_worktree));
  for (const root of retained) {
    const owner = await physicalOwner(root);
    if (!permittedOwners.has(owner)) throw new RepositoryMutationError("ownership_changed", `Project cleanup found a foreign retained Git owner at ${root}; no cleanup or foreign lock was written`);
    roots.set(physicalKey(root), root);
  }
  if (existsSync(brainRoot)) {
    await physicalOwner(brainRoot);
    roots.set(physicalKey(brainRoot), brainRoot);
  }
  return [...roots.values()];
}

function inside(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * The project's footprint. `repositories` are the folders whose git worktree lists are searched
 * (the project's configured repositories; the source folders its workspaces recorded are added).
 * Only worktrees under `<storage>/worktrees` named for one of its tasks count
 * (`<task>-r<n>-<stamp>` for coding tasks, `job-<task>-<alias>` for a job's integration worktree).
 */
export async function projectFootprint(db: Db, storageDir: string, slug: string, repositories: string[]): Promise<ProjectFootprint> {
  const taskIds = (db.prepare("SELECT id FROM tasks WHERE project_id = ? ORDER BY created_at").pluck().all(slug) as string[]) ?? [];
  const p = { slug, ids: ids(taskIds) };
  const jobs = (db.prepare("SELECT COUNT(*) FROM tasks WHERE project_id = ? AND profile = 'supervise' AND json_extract(spec_json, '$.parentTaskId') IS NULL").pluck().get(slug) as number) ?? 0;
  const sessionsDir = path.join(storageDir, "sessions");
  const sessionRows = db.prepare(`SELECT log_path FROM sessions WHERE ${SESSIONS}`).pluck().all(p) as string[];
  const artifactsRoot = path.join(storageDir, "artifacts");
  const artifactRows = db.prepare(`SELECT rel_path FROM artifacts WHERE task_id IN ${IN_TASKS}`).pluck().all(p) as string[];
  const artifactPaths = [
    ...artifactRows.map((r) => path.join(artifactsRoot, ...r.split("/"))),
    ...taskIds.map((id) => path.join(artifactsRoot, id)).filter((d) => existsSync(d)),
  ].filter((f) => inside(artifactsRoot, f));
  const requests = (db.prepare("SELECT COUNT(*) FROM model_requests WHERE project_id = ?").pluck().get(slug) as number) ?? 0;
  const paidRequests = (db.prepare("SELECT COUNT(*) FROM paid_spend WHERE request_id IN (SELECT id FROM model_requests WHERE project_id = ?)").pluck().get(slug) as number) ?? 0;
  const sources = db.prepare(`SELECT DISTINCT source_path FROM workspaces WHERE task_id IN ${IN_TASKS}`).pluck().all(p) as string[];
  return {
    slug,
    taskIds,
    jobs,
    sessions: sessionRows.length,
    // log_path is relative to the storage folder (`sessions/<id>.jsonl`).
    sessionLogs: sessionRows.map((f) => path.resolve(storageDir, f)).filter((f) => inside(sessionsDir, f)),
    artifacts: artifactRows.length,
    artifactPaths: [...new Set(artifactPaths)],
    worktrees: await projectWorktrees(storageDir, taskIds, [...repositories, ...sources]),
    requests,
    paidRequests,
    requestCaptures: z.object({ captures: z.number().int().nonnegative(), bytes: z.number().int().nonnegative() }).parse(db.prepare("SELECT COUNT(*) AS captures,COALESCE(SUM(bytes),0) AS bytes FROM request_captures WHERE project_id=@slug OR EXISTS(SELECT 1 FROM json_each(scope_json) WHERE value=@slug)").get({ slug })),
  };
}

/** MeritRouter's worktrees for these tasks: registered in one of `repositories`, or leftover folders. */
async function projectWorktrees(storageDir: string, taskIds: string[], repositories: string[]): Promise<WorktreeRef[]> {
  const root = path.join(storageDir, "worktrees");
  const owned = new Set(taskIds);
  // <task>-r<n>-<stamp> or job-<task>-<alias>; task ids contain no '-'.
  const ownedName = (name: string) => owned.has(name.replace(/^job-/, "").split("-")[0]!);
  const ownedPath = (p: string) => inside(root, p) && path.dirname(path.resolve(p)).toLowerCase() === path.resolve(root).toLowerCase() && ownedName(path.basename(p));
  const out = new Map<string, WorktreeRef>();
  const key = (p: string) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
  if (!owned.size) return [];
  const seenRepos = new Set<string>();
  for (const repo of repositories) {
    if (seenRepos.has(key(repo)) || !existsSync(path.join(repo, ".git"))) continue;
    seenRepos.add(key(repo));
    const list = await git(repo, ["worktree", "list", "--porcelain"]);
    for (const line of list.split(/\r?\n/)) {
      if (!line.startsWith("worktree ")) continue;
      const wt = path.resolve(line.slice("worktree ".length).trim());
      if (ownedPath(wt) && !out.has(key(wt))) out.set(key(wt), { repo, path: wt });
    }
  }
  if (existsSync(root)) {
    for (const name of readdirSync(root)) {
      const wt = path.join(root, name);
      if (ownedName(name) && !out.has(key(wt)) && statSync(wt).isDirectory()) out.set(key(wt), { repo: null, path: wt });
    }
  }
  return [...out.values()];
}

/**
 * Delete the project's rows in one transaction: its tasks and everything hanging off them
 * (dependencies, executions' memberships, artifacts' rows, events, workspaces, contracts,
 * verdicts and audits, plans, leases, carves, the merge queue, the team channel, claim/wait slots),
 * its sessions and their events, supervisor transcripts and questions, brain access requests and
 * grants, and the project's row. Model requests and paid spend are kept for accounting, unlinked
 * from the project (`project_id` ''); their per-task charges go with the tasks they name, so
 * foreign keys hold throughout. Refused when the project has a task in one of `activeStates`
 * (checked inside the transaction).
 */
export function purgeProjectRows(db: Db, slug: string, activeStates: readonly string[]): { tasks: number; sessions: number; pendingRequests: number; retainedTransportHolds: number } {
  return immediate(db, () => {
    // Retire pending dispatch authority atomically with the purge. Conservative accounting,
    // opaque anti-replay bindings and detached physical transport quarantine remain.
    const receipts = new RequestReceipts(db);
    const retained = receipts.retention(slug);
    receipts.purgeProject(slug);
    const active = db.prepare("SELECT COUNT(*) FROM tasks WHERE project_id = ? AND state IN (SELECT value FROM json_each(?))").pluck().get(slug, JSON.stringify(activeStates)) as number;
    if (active) throw new MeritRouterError("usage", `project ${slug} has ${active} running or queued task(s); cancel them or let them finish before deleting it`);
    const p = { slug, ids: ids(db.prepare("SELECT id FROM tasks WHERE project_id = ?").pluck().all(slug) as string[]) };
    const run = (sql: string) => db.prepare(sql).run(p).changes;
    if(db.prepare("SELECT 1 FROM project_execution_claims WHERE project_id=? AND phase!='terminal' LIMIT 1").get(slug))throw new MeritRouterError("usage","Project execution claims require exact terminal reconciliation before purge");
    if (db.prepare(`SELECT 1 FROM task_workspace_attempts WHERE task_id IN ${IN_TASKS} AND project_id!=@slug LIMIT 1`).get(p)
      || db.prepare(`SELECT 1 FROM lab_teams t JOIN labs l ON l.id=t.lab_id WHERE t.root_job_id IN ${IN_TASKS} AND l.project_id!=@slug LIMIT 1`).get(p)) {
      throw new MeritRouterError("usage", "Project cleanup cannot prove exclusive Lab ownership; recovery evidence was retained");
    }
    // Private runtime ownership records may only go after their resources were proved removed.
    // In particular, removing a task must not orphan a recoverable task-Lab process intent.
    if (db.prepare("SELECT 1 FROM lab_command_owners WHERE project_id=? LIMIT 1").get(slug)
      || db.prepare("SELECT 1 FROM lab_capacity_owners WHERE project_id=? LIMIT 1").get(slug)
      || db.prepare("SELECT 1 FROM labs WHERE project_id=? AND state!='destroyed' LIMIT 1").get(slug)
      || db.prepare(`SELECT 1 FROM lab_task_attempts l JOIN task_workspace_attempts a ON a.id=l.attempt_id WHERE a.task_id IN ${IN_TASKS} AND l.phase!='pruned' LIMIT 1`).get(p)
      || db.prepare(`SELECT 1 FROM task_lab_operations WHERE attempt_id IN (SELECT id FROM task_workspace_attempts WHERE task_id IN ${IN_TASKS}) AND state IN ('pending','running') LIMIT 1`).get(p)
      || db.prepare(`SELECT 1 FROM lab_attempt_processes WHERE attempt_id IN (SELECT id FROM task_workspace_attempts WHERE task_id IN ${IN_TASKS}) AND state!='stopped' LIMIT 1`).get(p)
      || db.prepare("SELECT 1 FROM lab_operations WHERE project_id=? AND state IN ('pending','running') LIMIT 1").get(slug)) {
      throw new MeritRouterError("usage", `project ${slug} still has Lab resources or pending cleanup; finish owned Lab cleanup before deleting it`);
    }
    // Payloads include private participant scope; purge before charges/tasks are removed or
    // accounting rows are anonymized, including any historical mixed-project capture.
    // Remove private operation receipts before task identity is deleted; retain hash-only
    // retry tombstones so delayed old requests cannot recreate purged scoped payloads.
    db.prepare("DELETE FROM task_lease_operations WHERE id IN (SELECT operation_id FROM task_lease_operation_projects WHERE project_id=?)").run(slug);
    new RequestCaptures(db).purgeProject(slug);
    run("DELETE FROM project_execution_claim_members WHERE grant_id IN (SELECT grant_id FROM project_execution_claims WHERE project_id=@slug AND phase='terminal')");
    run("DELETE FROM project_execution_claims WHERE project_id=@slug AND phase='terminal'");
    const attempts = `(SELECT id FROM task_workspace_attempts WHERE task_id IN ${IN_TASKS})`;
    const labs = "(SELECT id FROM labs WHERE project_id=@slug)";
    run(`DELETE FROM lab_attempt_processes WHERE attempt_id IN ${attempts}`);
    run(`DELETE FROM task_lab_operations WHERE attempt_id IN ${attempts}`);
    run(`DELETE FROM lab_task_attempts WHERE attempt_id IN ${attempts}`);
    run(`DELETE FROM task_workspace_attempts WHERE task_id IN ${IN_TASKS}`);
    run(`DELETE FROM lab_teams WHERE lab_id IN ${labs}`);
    run(`DELETE FROM lab_operations WHERE lab_id IN ${labs} OR project_id=@slug`);
    for (const table of ["lab_ports", "lab_services", "lab_checks", "lab_events", "lab_promotions"]) run(`DELETE FROM ${table} WHERE lab_id IN ${labs}`);
    run("DELETE FROM labs WHERE project_id=@slug");
    run(`DELETE FROM session_events WHERE session_id IN (SELECT id FROM sessions WHERE ${SESSIONS})`);
    const sessions = run(`DELETE FROM sessions WHERE ${SESSIONS}`);
    run(`DELETE FROM task_deps WHERE task_id IN ${IN_TASKS} OR depends_on IN ${IN_TASKS}`);
    run(`DELETE FROM execution_members WHERE task_id IN ${IN_TASKS}`);
    run(`DELETE FROM artifacts WHERE task_id IN ${IN_TASKS}`);
    run(
      `DELETE FROM events WHERE project_id = @slug OR task_id IN ${IN_TASKS}
         OR (type = 'repository_prepare' AND (CASE WHEN json_valid(data_json) THEN json_extract(data_json, '$.project') END) = @slug)`,
    );
    run(`DELETE FROM workspaces WHERE task_id IN ${IN_TASKS}`);
    run(`DELETE FROM qualification_tasks WHERE task_id IN ${IN_TASKS}`);
    run(`DELETE FROM brain_access_requests WHERE project_id = @slug OR task_id IN ${IN_TASKS} OR job_id IN ${IN_TASKS}`);
    run(`DELETE FROM brain_grants WHERE project_id = @slug OR task_id IN ${IN_TASKS}`);
    run(`DELETE FROM job_state WHERE project_id = @slug OR task_id IN ${IN_TASKS}`);
    run(`DELETE FROM job_questions WHERE task_id IN ${IN_TASKS}`);
    run(`DELETE FROM task_contracts WHERE task_id IN ${IN_TASKS}`);
    run(`DELETE FROM verdict_records WHERE task_id IN ${IN_TASKS}`);
    run(`DELETE FROM verification_signals WHERE task_id IN ${IN_TASKS} OR job_id IN ${IN_TASKS}`);
    run(`DELETE FROM verification_audits WHERE task_id IN ${IN_TASKS}`);
    run(`DELETE FROM job_plans WHERE project_id = @slug OR job_id IN ${IN_TASKS}`);
    run(`DELETE FROM file_leases WHERE task_id IN ${IN_TASKS} OR job_id IN ${IN_TASKS}`);
    run(`DELETE FROM job_budget_carves WHERE child_task_id IN ${IN_TASKS} OR parent_task_id IN ${IN_TASKS}`);
    run(`DELETE FROM task_request_grants WHERE task_id IN ${IN_TASKS} OR job_id IN ${IN_TASKS}`);
    run(`DELETE FROM budget_requests WHERE project_id = @slug OR task_id IN ${IN_TASKS}`);
    run(`DELETE FROM merge_queue WHERE task_id IN ${IN_TASKS} OR job_id IN ${IN_TASKS}`);
    // Channel posts are append-only for agents; deleting the whole project removes its jobs' posts.
    const guard = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'job_channel_no_delete'").pluck().get() as string | undefined;
    if (guard) db.exec("DROP TRIGGER job_channel_no_delete");
    run(`DELETE FROM job_channel WHERE job_id IN ${IN_TASKS}`);
    if (guard) db.exec(guard);
    run(`DELETE FROM provider_slots WHERE task_id IN ${IN_TASKS}`);
    run("UPDATE model_requests SET project_id = '',route_note=NULL,error_message=NULL,telemetry_json=NULL,web_citations_json=NULL WHERE project_id = @slug");
    run(`DELETE FROM request_charges WHERE task_id IN ${IN_TASKS}`);
    const tasks = run(`DELETE FROM tasks WHERE id IN ${IN_TASKS}`);
    run("DELETE FROM projects WHERE id = @slug");
    return { tasks, sessions, ...retained };
  });
}

/** Remove session logs and artifact files; returns what could not be removed. */
export function removeProjectFiles(fp: ProjectFootprint): string[] {
  const problems: string[] = [];
  for (const f of [...fp.sessionLogs, ...fp.artifactPaths]) {
    try {
      rmSync(f, { recursive: true, force: true });
    } catch (err) {
      problems.push(`${f}: ${(err as Error).message}`);
    }
  }
  return problems;
}

/** Remove the worktrees (`git worktree remove --force`, then prune); branches are kept. */
export async function removeProjectWorktrees(worktrees: WorktreeRef[], control: { mutation?: RepositoryMutationCapability } = {}): Promise<{ removed: number; problems: string[] }> {
  if (!worktrees.length) return { removed: 0, problems: [] };
  const validate = async () => {
    for (const wt of worktrees) {
      if (!wt.repo || !existsSync(wt.path) || !lstatSync(wt.path).isDirectory() || lstatSync(wt.path).isSymbolicLink())
        throw new RepositoryMutationError("ownership_changed", `Worktree ${wt.path} has missing or unverifiable ownership; recovery evidence is retained`);
      if (!existsSync(path.join(wt.path, ".git")) || !lstatSync(path.join(wt.path, ".git")).isFile() || lstatSync(path.join(wt.path, ".git")).isSymbolicLink() || await physicalOwner(wt.repo) !== await physicalOwner(wt.path))
        throw new RepositoryMutationError("ownership_changed", `Worktree ${wt.path} does not belong to its recorded source; no foreign lock or removal was attempted`);
      const listed = (await git(wt.repo, ["worktree", "list", "--porcelain"])).split(/\r?\n/).some(line => line.startsWith("worktree ") && physicalKey(line.slice(9).trim()) === physicalKey(wt.path));
      if (!listed) throw new RepositoryMutationError("ownership_changed", `Worktree ${wt.path} is not registered in its recorded source`);
    }
  };
  await validate(); // Read-only owner comparison must precede any foreign-owner lease write.
  return withRepositoryMutation([...new Set(worktrees.map(wt => wt.repo!))], async mutation => {
    await validate();
    for (let offset = 0; offset < worktrees.length; offset += 64)
      await withRepositoryMutation(worktrees.slice(offset, offset + 64).map(wt => wt.path), async () => undefined, { capability: mutation });
    let removed = 0;
    for(const wt of worktrees)await assertNoNativeWorktreeOperation(wt.path);
    for (const wt of worktrees) {
      await assertNoNativeWorktreeOperation(wt.path);
      try { await git(wt.repo!, ["worktree", "remove", "--force", "--force", wt.path]); }
      catch (error) { throw new RepositoryMutationError("ownership_changed", `Native worktree removal failed for ${wt.path}; rows and config must be retained: ${(error as Error).message}`); }
      if (existsSync(wt.path)) throw new RepositoryMutationError("ownership_changed", `Native removal left worktree ${wt.path}; it was not counted as removed`);
      removed++;
    }
    return { removed, problems: [] };
  }, { capability: control.mutation });
}

// ---------- split installations: a project's own store under <project>/.MeritRouter ----------

const comparable = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
const samePath = (a: string, b: string) => comparable(a) === comparable(b);
/** True when `child` lies strictly beneath `parent` (host case rules). */
function beneath(child: string, parent: string): boolean {
  const c = comparable(child), p = comparable(parent);
  return c !== p && c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}
/** The resolved and (when it exists) physical spellings of a path. */
function spellings(value: string): string[] {
  const forms = [path.resolve(value)];
  try { forms.push(realpathSync(value)); } catch { /* a missing path compares by its resolved spelling */ }
  return forms;
}

/** Every store registration of a slug in the coordination store, newest first. */
export function projectStoreRegistrations(coordinationDb: Db, slug: string): ProjectStoreRegistration[] {
  return z.array(ProjectStoreRegistrationSchema).parse(coordinationDb.prepare(`SELECT installation_uuid AS installationId,project_uuid AS projectId,slug,store_uuid AS storeId,
    generation,project_directory AS projectDirectory,state,created_at AS createdAt,updated_at AS updatedAt,retired_at AS retiredAt
    FROM project_store_registrations WHERE slug=? ORDER BY updated_at DESC, created_at DESC`).all(slug));
}

/**
 * Prove that a registration's runtime root (`<directory>/.MeritRouter`) is the project's own, before
 * anything under it is removed: the configured directory is the registered one, neither the
 * directory nor the root is a link or junction (both are their own physical paths), the root
 * neither contains nor lies inside an installation root, and its manifest names the registered
 * project. Returns the paths, with `present: false` when the root is already gone.
 */
export function verifyProjectRuntimeRoot(registration: ProjectStoreRegistration, configuredDirectory: string | null, installationRoots: readonly string[]): { paths: ProjectRuntimePaths; present: boolean } {
  const refuse = (message: string): never => { throw new MeritRouterError("usage", `project ${registration.slug}'s store cannot be removed: ${message}; nothing was removed`); };
  const paths = projectRuntimePaths(registration.projectDirectory);
  if (!configuredDirectory || !samePath(configuredDirectory, paths.projectDirectory)) refuse(`it is registered in ${paths.projectDirectory}, but the project is configured with ${configuredDirectory ?? "no directory"}`);
  let root;
  try { root = lstatSync(paths.root); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { paths, present: false };
    throw error;
  }
  const directory = lstatSync(paths.projectDirectory);
  if (directory.isSymbolicLink() || !directory.isDirectory()) refuse(`${paths.projectDirectory} is a link or not a folder`);
  if (!samePath(realpathSync(paths.projectDirectory), paths.projectDirectory)) refuse(`${paths.projectDirectory} is not its own physical path`);
  if (root.isSymbolicLink() || !root.isDirectory()) refuse(`${paths.root} is a link, junction or not a folder`);
  if (!samePath(realpathSync(paths.root), paths.root)) refuse(`${paths.root} resolves elsewhere (${realpathSync(paths.root)})`);
  for (const installation of installationRoots) for (const a of spellings(installation)) for (const b of spellings(paths.root)) {
    if (samePath(a, b) || beneath(a, b) || beneath(b, a)) refuse(`${paths.root} overlaps the installation directory ${installation}`);
  }
  let manifest;
  try { manifest = lstatSync(paths.manifest); } catch { refuse(`${paths.manifest} is missing, so the folder's owner cannot be proved`); }
  if (manifest!.isSymbolicLink() || !manifest!.isFile()) refuse(`${paths.manifest} is a link or not a file`);
  let parsed;
  try { parsed = ProjectRuntimeManifestSchema.safeParse(JSON.parse(readFileSync(paths.manifest, "utf8"))); } catch { parsed = null; }
  if (!parsed?.success) refuse(`${paths.manifest} is not a valid project manifest`);
  if (parsed!.data!.projectId !== registration.projectId) refuse(`${paths.manifest} names project ${parsed!.data!.projectId}, not the registered ${registration.projectId}`);
  return { paths, present: true };
}

/**
 * Git worktrees registered in one of `repositories` that lie inside a project's runtime root and
 * still exist (task, job integration and Lab worktrees MeritRouter made there). They are removed
 * natively before the root, so the repositories keep no registration of a vanished folder.
 */
export async function runtimeRootWorktrees(root: string, repositories: readonly string[]): Promise<WorktreeRef[]> {
  const out = new Map<string, WorktreeRef>();
  const seen = new Set<string>();
  for (const repo of repositories) {
    if (seen.has(comparable(repo)) || !existsSync(path.join(repo, ".git")) || beneath(repo, root)) continue;
    seen.add(comparable(repo));
    const list = await git(repo, ["worktree", "list", "--porcelain"]);
    for (const line of list.split(/\r?\n/)) {
      if (!line.startsWith("worktree ")) continue;
      const wt = path.resolve(line.slice("worktree ".length).trim());
      if (beneath(wt, root) && existsSync(wt) && !out.has(comparable(wt))) out.set(comparable(wt), { repo, path: wt });
    }
  }
  return [...out.values()];
}

/** Unlink one directory entry without following it (a symlink or junction loses only its link). */
function unlinkEntry(entry: string, link: boolean): void {
  try { unlinkSync(entry); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (link && (code === "EPERM" || code === "EISDIR")) { rmdirSync(entry); return; }
    if (!link && code === "EPERM") { chmodSync(entry, 0o666); unlinkSync(entry); return; }
    throw error;
  }
}

/** Remove a folder's contents depth first; links and junctions are unlinked, never followed. */
function removeContents(dir: string, keep: string | null): void {
  for (const name of readdirSync(dir)) {
    const entry = path.join(dir, name);
    if (keep && samePath(entry, keep)) continue;
    const stat = lstatSync(entry);
    if (stat.isSymbolicLink()) unlinkEntry(entry, true);
    else if (stat.isDirectory()) { removeContents(entry, null); rmdirSync(entry); }
    else unlinkEntry(entry, false);
  }
}

/**
 * Remove a runtime root the current operation created itself (a failed project creation's partial
 * `<directory>/.MeritRouter`), never following a link or junction; a root that is itself a link
 * is left alone. Returns whether it was removed.
 */
export function removeCreatedRuntimeRoot(root: string): boolean {
  let stat;
  try { stat = lstatSync(root); } catch { return false; }
  if (stat.isSymbolicLink() || !stat.isDirectory() || !samePath(realpathSync(root), root)) return false;
  removeContents(root, null);
  rmdirSync(root);
  return true;
}

/**
 * Remove a split project's runtime root (`<directory>/.MeritRouter`) and nothing else: verified
 * first (see `verifyProjectRuntimeRoot`), then removed without following any link or junction
 * inside it, its manifest last so an interrupted removal can be verified and finished later.
 * Returns whether a root was removed (false when it was already gone).
 */
export function removeProjectRuntimeRoot(registration: ProjectStoreRegistration, configuredDirectory: string | null, installationRoots: readonly string[]): boolean {
  const { paths, present } = verifyProjectRuntimeRoot(registration, configuredDirectory, installationRoots);
  if (!present) return false;
  removeContents(paths.root, paths.manifest);
  // Re-check immediately before the last entries go: the root must still be the same folder.
  verifyProjectRuntimeRoot(registration, configuredDirectory, installationRoots);
  unlinkEntry(paths.manifest, false);
  rmdirSync(paths.root);
  return true;
}

/** What a split project's store holds, counted from its own database (read by the caller). */
export function projectStoreCounts(db: Db): { taskIds: string[]; jobs: number; sessions: number; artifacts: number; requests: number } {
  const count = (sql: string) => (db.prepare(sql).pluck().get() as number) ?? 0;
  return {
    taskIds: db.prepare("SELECT id FROM tasks ORDER BY created_at").pluck().all() as string[],
    jobs: count("SELECT COUNT(*) FROM tasks WHERE profile = 'supervise' AND json_extract(spec_json, '$.parentTaskId') IS NULL"),
    sessions: count("SELECT COUNT(*) FROM sessions"),
    artifacts: count("SELECT COUNT(*) FROM artifacts"),
    requests: count("SELECT COUNT(*) FROM model_requests"),
  };
}

/** The installation's accounting of a split project's physical requests (kept when it is deleted). */
export function projectAccounting(coordinationDb: Db, projectId: string): { requests: number; paidRequests: number; unsettled: number } {
  return z.object({ requests: z.number().int(), paidRequests: z.number().int().nullable(), unsettled: z.number().int().nullable() }).transform(r => ({ requests: r.requests, paidRequests: r.paidRequests ?? 0, unsettled: r.unsettled ?? 0 }))
    .parse(coordinationDb.prepare("SELECT COUNT(*) AS requests, SUM(paid) AS paidRequests, SUM(status IN ('reserved','dispatch_intent')) AS unsettled FROM physical_requests WHERE project_uuid=?").get(projectId));
}

/** Each task's state and last update, to detect work that changed while a project was being retired. */
export function projectTaskSnapshot(db: Db): string {
  return JSON.stringify(db.prepare("SELECT id, state, updated_at FROM tasks ORDER BY id").all());
}
