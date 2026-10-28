import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MeritRouter } from "../src/core/service.js";
import { prepareWorkspace } from "../src/runners/coding/finish.js";
import { baseResult, type RunContext } from "../src/runners/types.js";
import { openDatabase, type Db } from "../src/storage/db.js";
import { readStoreIdentity } from "../src/projects/store-identity.js";
import { openInstallationLayout } from "../src/core/project-runtime-host.js";
import { baseConfig, FakeProvider, goodOutput, makeEnv, open, reply, ScriptedClient, summarizeTask, type Env } from "./helpers.js";

const services: MeritRouter[] = [], envs: Env[] = [], dirs: string[] = [], dbs: Db[] = [];
afterEach(async () => {
  await Promise.allSettled(services.splice(0).map(s => s.close()));
  for (const db of dbs.splice(0)) if (db.open) db.close();
  for (const env of envs.splice(0)) env.cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 60_000);

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, stdio: "pipe" }).toString();

/** A project repository outside the installation's config and storage directories. */
function projectRepo(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "meritrouter-test-project-")));
  dirs.push(dir);
  mkdirSync(path.join(dir, "src"));
  writeFileSync(path.join(dir, "src", "app.ts"), "export const add = (a: number, b: number) => a + b;\n");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

const CANARY = "private-canary-7f3a1c";

function fixture(opts: { layout?: "split" | "legacy"; slugs?: string[] } = {}) {
  const slugs = opts.slugs ?? ["alpha"];
  const repos = Object.fromEntries(slugs.map(slug => [slug, projectRepo()]));
  const projects = Object.fromEntries(slugs.map(slug => [slug, { directory: repos[slug], repositories: { app: { path: repos[slug] } } }]));
  const env = makeEnv({ config: baseConfig({ storage: { directory: ".meritrouter", layout: opts.layout ?? "split" }, repositories: {}, brain: { path: "brain", project: slugs[0] }, projects }) });
  envs.push(env);
  return { env, repos };
}

function track(sy: MeritRouter): MeritRouter { services.push(sy); return sy; }
async function close(sy: MeritRouter): Promise<void> { services.splice(services.indexOf(sy), 1); await sy.close(); }

/** Every file under a directory, recursively. */
function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
}

const inside = (child: string, parent: string) => { const rel = path.relative(parent, child); return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel); };

it("binds a fresh installation as split and keeps a task's DB, sessions and requests in the project", async () => {
  const { env, repos } = fixture();
  const sy = track(open(env, new FakeProvider(), { worker: true }));
  expect(sy.layout).toBe("split");
  expect(readStoreIdentity(sy.db)?.role).toBe("coordination");
  expect(sy.db.pragma("synchronous", { simple: true })).toBe(2);

  const created = await sy.createSplitProject({ slug: "alpha", directory: repos.alpha! });
  expect(created.paths.root).toBe(path.join(repos.alpha!, ".MeritRouter"));
  expect(sy.projects.get("alpha")!.storageDir).toBe(created.paths.state);
  // Idempotent for the same directory.
  expect((await sy.createSplitProject({ slug: "alpha", directory: repos.alpha! })).identity).toEqual(created.identity);

  const [out] = await sy.submitTasks([summarizeTask({ goal: `Summarise ${CANARY}` })], { project: "alpha" });
  const done = await sy.awaitResults([out!.taskId], { timeoutSeconds: 30 });
  expect(done.completed, JSON.stringify(sy.getStatus([out!.taskId]))).toHaveLength(1);
  expect(sy.getStatus([out!.taskId], "alpha")[0]).toMatchObject({ project: "alpha", state: "completed" });
  expect(sy.listTasks(undefined, 10).map(t => t.taskId)).toEqual([out!.taskId]);

  const stores = sy.projectStores("alpha");
  expect(inside(stores.db.name, created.paths.state)).toBe(true);
  expect(stores.tasks.get(out!.taskId)).toBeDefined();
  expect((stores.db.prepare("SELECT COUNT(*) n FROM model_requests").get() as { n: number }).n).toBeGreaterThan(0);
  const sessions = stores.sessions!.forTask(out!.taskId);
  expect(sessions.length).toBeGreaterThan(0);
  for (const session of sessions) expect(inside(path.resolve(session.logPath), path.join(created.paths.root, "sessions"))).toBe(true);

  // The coordination store holds no project rows, and no installation file carries private text.
  for (const table of ["tasks", "sessions", "model_requests", "artifacts", "request_captures", "session_events"])
    expect(sy.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get(), table).toEqual({ n: 0 });
  sy.db.pragma("wal_checkpoint(TRUNCATE)");
  for (const file of files(env.cfg.storageDir)) expect(readFileSync(file).includes(CANARY), file).toBe(false);
  expect(files(created.paths.root).some(file => readFileSync(file).includes(CANARY))).toBe(true);
  // The project's private store is excluded from Git.
  expect(git(repos.alpha!, "status", "--porcelain")).toBe("");
}, 60_000);

it("runs a coding task with its worktree, agent paths and artifacts under the project's .MeritRouter", async () => {
  const { env, repos } = fixture();
  const seen: Array<{ storageDir: string; worktree: string; artifact: string; projectDirectory: string | null }> = [];
  const coding = { run: async (ctx: RunContext) => {
    const { ws } = await prepareWorkspace(ctx);
    const ref = ctx.artifacts.writeJson({ taskId: ctx.taskId, kind: "report", label: "fixture", value: { note: CANARY } });
    seen.push({ storageDir: ctx.cfg.storageDir, worktree: ws.worktreePath, artifact: ctx.artifacts.absolutePath(ctx.artifacts.get(ref)!), projectDirectory: (ctx.cfg as { projectDirectory?: string | null }).projectDirectory ?? null });
    return { state: "completed" as const, result: baseResult({ stopReason: "fixture", summary: "prepared" }) };
  } };
  const sy = track(open(env, new FakeProvider(), { worker: true, coding }));
  const created = await sy.createSplitProject({ slug: "alpha", directory: repos.alpha! });
  const [out] = await sy.submitTasks([{ profile: "implement", goal: "Add subtract", repositoryAliases: ["app"], writableRepository: "app", constraints: { acceptanceCriteria: ["subtract exists"], allowedPaths: ["src/**"] } }], { project: "alpha" });
  const deadline = Date.now() + 30_000;
  while (!seen.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  expect(seen, JSON.stringify(sy.getStatus([out!.taskId], "alpha"))).toHaveLength(1);
  expect(seen[0]!.storageDir).toBe(created.paths.state);
  expect(seen[0]!.projectDirectory).toBe(repos.alpha);
  expect(inside(seen[0]!.worktree, path.join(created.paths.root, "worktrees"))).toBe(true);
  expect(statSync(seen[0]!.worktree).isDirectory()).toBe(true);
  expect(inside(seen[0]!.artifact, path.join(created.paths.root, "artifacts"))).toBe(true);
  await sy.awaitResults([out!.taskId], { timeoutSeconds: 30 });
  expect(sy.projectStores("alpha").db.prepare("SELECT COUNT(*) n FROM workspaces").get()).toEqual({ n: 1 });
  for (const table of ["tasks", "workspaces", "artifacts", "sessions"]) expect(sy.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get(), table).toEqual({ n: 0 });
  expect(files(env.cfg.storageDir).some(file => file.includes(`${path.sep}worktrees${path.sep}`))).toBe(false);
}, 60_000);

it("reopens a split installation after restart, recovers interrupted work and runs queued work", async () => {
  const { env, repos } = fixture();
  let hold = true;
  // Batch-aware: a restart may claim the two summaries together as one completion batch.
  const client = new ScriptedClient(async (req, _n, signal) => {
    if (hold) { await new Promise<void>(resolve => { if (signal?.aborted) resolve(); else signal?.addEventListener("abort", () => resolve()); }); throw new Error("aborted by shutdown"); }
    const ids = [...JSON.stringify(req.messages).matchAll(/<item id=\\?"(i\d+)\\?">/g)].map(m => m[1]!);
    return reply(JSON.stringify(ids.length ? { items: ids.map(id => ({ id, result: goodOutput(1, "inline") })) } : goodOutput(1, "inline")));
  });
  let sy = track(open(env, client, { worker: true }));
  await sy.createSplitProject({ slug: "alpha", directory: repos.alpha! });
  const [running] = await sy.submitTasks([summarizeTask({ goal: "held" })], { project: "alpha" });
  const deadline = Date.now() + 20_000;
  while (sy.getStatus([running!.taskId], "alpha")[0]!.state !== "running" && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  await close(sy);

  // Queued while no worker runs.
  sy = track(open(env, client, { worker: false }));
  expect(sy.layout).toBe("split");
  expect(sy.getStatus([running!.taskId], "alpha")[0]!.state).toBe("interrupted");
  const [queued] = await sy.submitTasks([summarizeTask({ goal: "queued" })], { project: "alpha" });
  await close(sy);

  // A worker restart recovers the side-effect-free interrupted task and runs the queued one.
  hold = false;
  sy = track(open(env, client, { worker: true }));
  const done = await sy.awaitResults([queued!.taskId, running!.taskId], { timeoutSeconds: 30 });
  expect(done.pending).toEqual([]);
  for (const id of [queued!.taskId, running!.taskId]) expect(sy.getStatus([id], "alpha")[0]!.state, JSON.stringify(sy.getStatus([id], "alpha"))).toBe("completed");
  expect(sy.getStatus([running!.taskId])[0]!.state).toBe("completed");
  // Id-based writes find the task in its project store (not the coordination store).
  expect(() => sy.resumeTask(running!.taskId)).toThrow(/FINAL-rejected delivery/);
  for (const table of ["tasks", "sessions", "model_requests"]) expect(sy.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get(), table).toEqual({ n: 0 });
}, 90_000);

it("keeps a legacy installation legacy and refuses to mix split projects into it", async () => {
  const normal = fixture({ layout: "legacy" });
  const sy = track(open(normal.env, new FakeProvider()));
  expect(sy.layout).toBe("legacy");
  expect(readStoreIdentity(sy.db)).toBeNull();
  await expect(sy.createSplitProject({ slug: "alpha", directory: normal.repos.alpha! })).rejects.toMatchObject({ code: "split_projects_unavailable" });
  expect(existsSync(path.join(normal.repos.alpha!, ".MeritRouter"))).toBe(false);
  await close(sy);

  // An installation store that already holds legacy rows refuses to switch to split storage.
  // Checked directly against `openInstallationLayout` (not through `new MeritRouter`): the
  // service constructor has no failure path that closes its db handle, and a thrown-away handle
  // on a store already holding rows would otherwise leak and lock the fixture's temp directory.
  const used = fixture({ layout: "legacy" });
  const legacy = track(open(used.env, new FakeProvider()));
  await legacy.submitTasks([summarizeTask()], { project: "alpha" });
  await close(legacy);
  const direct = openDatabase(used.env.cfg.storageDir, { durability: "full" });
  dbs.push(direct);
  expect(() => openInstallationLayout(direct, "split")).toThrow(/split_layout_unavailable|already holds data/);
  direct.close();
  dbs.pop();
  const reopened = track(open(used.env, new FakeProvider()));
  expect(reopened.layout).toBe("legacy");
  expect(readStoreIdentity(reopened.db)).toBeNull();
  await expect(reopened.retireProject("alpha")).rejects.toMatchObject({ code: "split_projects_unavailable" });
});

it("refuses an unregistered project and keeps qualification out of the coordination store in a split installation", async () => {
  const { env } = fixture();
  const sy = track(open(env, new FakeProvider()));
  await expect(sy.submitTasks([summarizeTask()], { project: "alpha" })).rejects.toThrow(/no project-local store/);
  // Qualification has its own installation-owned store (qualification-split-store.test.ts).
  await sy.submitTasks([summarizeTask()], { purpose: "qualification" });
  expect(sy.db.prepare("SELECT COUNT(*) n FROM tasks").get()).toEqual({ n: 0 });
});

it("refuses a project directory inside the installation", async () => {
  // makeEnv's own fixture repository lives inside the config directory.
  const env = makeEnv({ config: baseConfig({ storage: { directory: ".meritrouter", layout: "split" }, repositories: {}, brain: { path: "brain", project: "alpha" }, projects: { alpha: { directory: "repo", repositories: { app: { path: "repo" } } } } }) });
  envs.push(env);
  const sy = track(open(env, new FakeProvider()));
  expect(sy.projects.get("alpha")!.projectDirectory).toBe(env.repo);
  await expect(sy.createSplitProject({ slug: "alpha", directory: env.repo })).rejects.toThrow(/installation/i);
  expect(existsSync(path.join(env.repo, ".MeritRouter", "state"))).toBe(false);
  expect(sy.db.prepare("SELECT COUNT(*) n FROM project_store_registrations").get()).toEqual({ n: 0 });
});

it("retires a split project: drains it, closes its store, retires the registration and leaves its files", async () => {
  const { env, repos } = fixture();
  const sy = track(open(env, new FakeProvider(), { worker: true }));
  const created = await sy.createSplitProject({ slug: "alpha", directory: repos.alpha! });
  const [out] = await sy.submitTasks([summarizeTask()], { project: "alpha" });
  await sy.awaitResults([out!.taskId], { timeoutSeconds: 30 });
  const db = sy.projectStores("alpha").db;
  const retired = await sy.retireProject("alpha");
  expect(retired.identity).toEqual(created.identity);
  expect(db.open).toBe(false);
  expect(sy.db.prepare("SELECT state FROM project_store_registrations WHERE project_uuid=?").get(created.identity.projectId)).toEqual({ state: "retired" });
  expect(existsSync(path.join(created.paths.state, "meritrouter.db"))).toBe(true);
  expect(() => sy.projectStores("alpha")).toThrow(/no project-local store/);
  await expect(sy.submitTasks([summarizeTask()], { project: "alpha" })).rejects.toThrow(/no project-local store/);
  expect(sy.projects.get("alpha")!.storageDir).toBe(env.cfg.storageDir);
  // The retired store's files can be removed while the service keeps running.
  rmSync(created.paths.root, { recursive: true, force: true });
  expect(existsSync(created.paths.root)).toBe(false);
}, 60_000);

it("opens the coordination store read-only identical after restart (no second identity)", async () => {
  const { env, repos } = fixture();
  const first = track(open(env, new FakeProvider()));
  const identity = readStoreIdentity(first.db);
  await first.createSplitProject({ slug: "alpha", directory: repos.alpha! });
  await close(first);
  const raw = openDatabase(env.cfg.storageDir, { readonly: true, fileMustExist: true });
  dbs.push(raw);
  expect(readStoreIdentity(raw)).toEqual(identity);
  raw.close();
  const second = track(open(env, new FakeProvider()));
  expect(readStoreIdentity(second.db)).toEqual(identity);
  expect(second.projectStores("alpha").project).toBe("alpha");
});

it("gives a split supervisor lease-bound services that delegate and await within its own project store", async () => {
  const dir = projectRepo();
  const raw = baseConfig({ storage: { directory: ".meritrouter", layout: "split" }, repositories: {}, brain: { path: "brain", project: "alpha" }, projects: { alpha: { directory: dir, repositories: { app: { path: dir } } } } });
  (raw.profiles as Record<string, unknown>).supervise = { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 30, classify: "never" };
  const env = makeEnv({ config: raw });
  envs.push(env);
  const observed: Array<{ child: string; completed: number; foreign: string }> = [];
  const supervisor = { run: async (ctx: RunContext) => {
    const [child] = await ctx.services!.submitTasks([summarizeTask({ goal: "delegated child" })], {});
    const waited = await ctx.services!.awaitResults([child!.taskId], { timeoutSeconds: 20 });
    let foreign = "allowed";
    try { await ctx.services!.submitTasks([{ ...summarizeTask(), project: "beta" }], {}); } catch (error) { foreign = (error as Error).message; }
    observed.push({ child: child!.taskId, completed: waited.completed.length, foreign });
    return { state: "completed" as const, result: baseResult({ stopReason: "fixture", summary: "delegated" }) };
  } };
  const sy = track(open(env, new FakeProvider(), { worker: true, supervisor }));
  await sy.createSplitProject({ slug: "alpha", directory: dir });
  const [job] = await sy.submitTasks([{ profile: "supervise", goal: "coordinate", repositoryAliases: ["app"], constraints: { acceptanceCriteria: ["done"] } }], { project: "alpha" });
  const done = await sy.awaitResults([job!.taskId], { timeoutSeconds: 45 });
  expect(done.completed, JSON.stringify(sy.getStatus([job!.taskId], "alpha"))).toHaveLength(1);
  expect(observed).toHaveLength(1);
  expect(observed[0]!.completed).toBe(1);
  expect(observed[0]!.foreign).toMatch(/another project/);
  const stores = sy.projectStores("alpha");
  expect(stores.tasks.get(observed[0]!.child)!.spec.parentTaskId).toBe(job!.taskId);
  expect(sy.db.prepare("SELECT COUNT(*) n FROM tasks").get()).toEqual({ n: 0 });
}, 90_000);
