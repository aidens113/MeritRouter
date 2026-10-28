import { afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import YAML from "yaml";
import { MeritRouter } from "../src/core/service.js";
import { loadConfig, resolveConfigPath } from "../src/config/load.js";
import { initializeConfig } from "../src/cli/setup.js";
import { projectsCommand } from "../src/cli/projects.js";
import { createProject } from "../src/admin/projects.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { Worktrees } from "../src/workspaces/worktree.js";
import { git as gitAsync } from "../src/workspaces/git.js";
import { openDatabase, type Db } from "../src/storage/db.js";
import { readStoreIdentity } from "../src/projects/store-identity.js";
import { projectStoreRegistrations } from "../src/projects/deletion.js";
import { backupProjectStore, restoreProjectStore } from "../src/operations/project-backup.js";
import { migrateLegacyProject, rollbackProjectMigration } from "../src/projects/store-migration.js";
import type { ChatRequest } from "../src/gateway/types.js";
import { baseConfig, commitAll, endpoint, goodOutput, reply, ScriptedClient, servedFor, summarizeTask } from "./helpers.js";

// Gate 1 exit check (C1): a fresh installation set up the way `meritrouter setup` does it, with
// two split projects driven through the real entry points (admin API, CLI, MeritRouter) on fake
// providers only. Afterwards no project-owned byte may sit under the installation: no canary text
// in any installation file, and no task/session/request/artifact row in the coordination store.

const services: MeritRouter[] = [], dbs: Db[] = [], dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.allSettled(services.splice(0).map((s) => s.close()));
  for (const db of dbs.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 120_000);

const gitSync = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, stdio: "pipe" }).toString();

function gitRepo(dir: string, files: Record<string, string>): string {
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
  gitSync(dir, "init", "-q", "-b", "main");
  commitAll(dir, "init");
  return dir;
}

/** Every file under a directory, recursively (links are not followed). */
function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : e.isFile() ? [path.join(dir, e.name)] : []));
}
const inside = (child: string, parent: string) => {
  const rel = path.relative(parent.toLowerCase(), child.toLowerCase());
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};
const count = (db: Db, sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { n: number }).n;
const call = (name: string, args: unknown, id = "c1") => [{ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }];
const toolCount = (req: ChatRequest) => req.messages.filter((m) => m.role === "tool").length;

// Canary text: each appears only in task prompts, model output, written source and artifacts.
const GOAL = "canary-goal-5d1e";
const OUTPUT = "canary-output-8b2f";
const CODE = "canary-code-3c9a";
const BETA = "canary-beta-71aa";
const LEGACY = "canary-legacy-0e44";
const CANARIES = [GOAL, OUTPUT, CODE, BETA, LEGACY];
const NOTE = "previous attempt's unfinished work";

/** Test routing evidence and budgets the helpers' `makeEnv` adds; fake providers only. */
function testConfig(written: { storage: unknown; brain: Record<string, unknown>; projects: unknown }, labs: Record<string, unknown> = {}) {
  const raw = baseConfig({
    storage: written.storage, brain: written.brain, projects: written.projects, repositories: {},
    coding: { runner: "native" }, labs: { port_range: [58600, 58800], max_active: 2, check_timeout_seconds: 10, keep_task_worktrees_days: 0, ...labs },
  }) as Record<string, unknown>;
  raw.client_supervision = { workflow: "direct_tasks" };
  raw.supervisor = {
    delivery_budget: { supervisor_reserve_requests: 0, validation_reserve_requests: 0 },
    routing: { quality_evidence: [{ schemaVersion: 1, endpointId: "openrouter/vendor/big-a:free", source: "test-fixture:fake-supervisor-evaluation", checkedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), classification: "qualified_supervisor", confidence: 1, trials: 10, scores: { planning: 1, architecture: 1, supervision: 1, integration: 1, review: 1, product: 1, visual: 1 } }] },
  };
  return raw;
}

it("runs the gate 1 journey with every project-owned byte under <project>/.MeritRouter", async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "meritrouter-c1-")));
  dirs.push(root);
  const installDir = path.join(root, "application");
  vi.stubEnv("MERITROUTER_CONFIG", undefined);
  vi.stubEnv("MERITROUTER_HOME", installDir);

  // ---- 1. setup: a fresh application-directory install, as `meritrouter setup` writes it.
  const configPath = resolveConfigPath(undefined, root);
  expect(path.dirname(configPath)).toBe(installDir);
  initializeConfig({ configPath, project: "my-project", setup: true });
  const written = YAML.parse(readFileSync(configPath, "utf8")) as { storage: { directory: string; layout: string; durability: string }; brain: Record<string, unknown>; projects: unknown };
  expect(written.storage).toMatchObject({ directory: ".MeritRouter", layout: "split", durability: "full" });
  // Fake providers and the test model catalog (what an operator adds after setup: keys and models).
  writeFileSync(path.join(installDir, "models.yaml"), YAML.stringify({ version: 1, endpoints: [endpoint()], overrides: {} }));
  writeFileSync(configPath, YAML.stringify(testConfig(written)));
  const storageDir = loadConfig(configPath).storageDir;
  expect(storageDir).toBe(path.join(installDir, ".MeritRouter"));
  const installationRoots = [installDir, storageDir];

  let current: MeritRouter | null = null;
  let hold = false;
  const client = new ScriptedClient(async (req, _n, signal) => {
    if (hold) {
      await new Promise<void>((resolve) => { if (signal?.aborted) resolve(); else signal?.addEventListener("abort", () => resolve()); });
      throw new Error("aborted by shutdown");
    }
    const served = servedFor(current!, req);
    if (req.tools?.length) {
      // The native coding worker: the first attempt writes the change, then spends its budget
      // looking around (it fails); the escalated retry reads its carried work back and submits.
      const n = toolCount(req);
      const continuing = req.messages.some((m) => m.role === "user" && typeof m.content === "string" && m.content.includes(NOTE));
      if (!continuing) {
        if (n === 0) return reply(null, { ...served, toolCalls: call("write_file", { path: "src/sub.ts", content: `export const subtract = (a: number, b: number) => a - b; // ${CODE}\n` }) });
        return reply(null, { ...served, toolCalls: call("list_files", { alias: "app", dir: "src", glob: `*.nothing${n}` }) });
      }
      if (n === 0) return reply(null, { ...served, toolCalls: call("read_file", { alias: "app", path: "src/sub.ts" }) });
      return reply(null, { ...served, toolCalls: call("submit_result", goodOutput(1, "app:src/sub.ts#L1-L1", { summary: `added subtract ${OUTPUT}` }), "s1") });
    }
    const ids = [...JSON.stringify(req.messages).matchAll(/<item id=\\?"(i\d+)\\?">/g)].map((m) => m[1]!);
    const result = goodOutput(1, "inline", { summary: `summary ${OUTPUT}` });
    return reply(JSON.stringify(ids.length ? { items: ids.map((id) => ({ id, result })) } : result), served);
  });
  const open = (worker: boolean) => {
    const sy = new MeritRouter(loadConfig(configPath), { providerFetch: client.fetch, pollIntervalMs: 50, worker });
    services.push(sy);
    current = sy;
    return sy;
  };
  const close = async (sy: MeritRouter) => { services.splice(services.indexOf(sy), 1); await sy.close(); };

  let sy = open(true);
  expect(sy.layout).toBe("split");
  expect(readStoreIdentity(sy.db)?.role).toBe("coordination");

  // ---- 2. two projects: alpha through the admin API, beta through the CLI.
  const alphaDir = gitRepo(path.join(root, "projects", "alpha"), { "src/app.ts": "export const add = (a: number, b: number) => a + b;\n", "value.txt": "before" });
  const betaDir = gitRepo(path.join(root, "projects", "beta"), { "README.md": "# Beta\n", "notes.txt": "beta user data\n" });
  const alpha = await createProject(sy, { slug: "alpha", directory: alphaDir, repositories: { app: { path: alphaDir } } });
  expect(alpha, JSON.stringify(alpha)).toMatchObject({ ok: true, runtimeRoot: path.join(alphaDir, ".MeritRouter") });
  let printed = "";
  const stdout = process.stdout.write.bind(process.stdout);
  const cli = async (args: string[], values: Record<string, unknown> = {}) => {
    printed = "";
    process.stdout.write = ((chunk: string | Uint8Array) => { printed += String(chunk); return true; }) as typeof process.stdout.write;
    try { return await projectsCommand(sy, args, values, true, { cwd: root, env: undefined }); } finally { process.stdout.write = stdout; }
  };
  expect(await cli(["create", "beta", betaDir])).toBe(0);
  expect(JSON.parse(printed)).toMatchObject({ ok: true, runtimeRoot: path.join(betaDir, ".MeritRouter") });
  const [betaTask] = await sy.submitTasks([summarizeTask({ goal: `Summarise ${BETA}` })], { project: "beta" });
  expect((await sy.awaitResults([betaTask!.taskId], { timeoutSeconds: 30 })).completed, JSON.stringify(sy.getStatus([betaTask!.taskId], "beta"))).toHaveLength(1);

  // ---- 3. a coding task that fails once (spent budget) and succeeds on its retry (escalation).
  const [coding] = await sy.submitTasks([{
    profile: "implement", label: "add-subtract", goal: `Add subtract() ${GOAL}`, repositoryAliases: ["app"], writableRepository: "app",
    hints: { difficulty: "T2" }, constraints: { acceptanceCriteria: ["subtract exists"], allowedPaths: ["src/**"] },
  }], { project: "alpha" });
  const codingResult = (await sy.awaitResults([coding!.taskId], { timeoutSeconds: 90 })).completed[0];
  expect(codingResult, JSON.stringify(sy.getStatus([coding!.taskId], "alpha"))).toBeDefined();
  expect(codingResult!.executionStatus, JSON.stringify(codingResult)).toBe("completed");
  expect(codingResult!.routing).toMatchObject({ tier: "T3", escalatedFrom: "T2" });
  const alphaStores = sy.projectStores("alpha");
  const worktree = (alphaStores.db.prepare("SELECT worktree_path FROM workspaces WHERE task_id=?").get(coding!.taskId) as { worktree_path: string }).worktree_path;
  expect(inside(worktree, path.join(alphaDir, ".MeritRouter", "worktrees"))).toBe(true);
  expect(readFileSync(path.join(worktree, "src", "sub.ts"), "utf8")).toContain(CODE);
  const codingSessions = alphaStores.sessions!.forTask(coding!.taskId);
  expect(codingSessions.length).toBeGreaterThanOrEqual(2);

  // ---- 4. restart: a task interrupted by shutdown is resumed explicitly after reopening.
  hold = true;
  const [held] = await sy.submitTasks([summarizeTask({ goal: `Summarise held ${GOAL}` })], { project: "alpha" });
  const deadline = Date.now() + 30_000;
  while (sy.getStatus([held!.taskId], "alpha")[0]!.state !== "running" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  expect(sy.getStatus([held!.taskId], "alpha")[0]!.state).toBe("running");
  await close(sy);
  // While closed, the operator enables ephemeral task Labs for alpha (used in stage 5).
  const node = JSON.stringify(process.execPath);
  const edited = YAML.parse(readFileSync(configPath, "utf8")) as { projects: Record<string, Record<string, unknown>> };
  edited.projects.alpha!.labs = { ephemeral: { enabled: true, checks: ["health"] } };
  edited.projects.alpha!.lab = { checks: { health: `${node} -e "process.exit(require('fs').readFileSync('value.txt','utf8')==='after'?0:1)"` } };
  writeFileSync(configPath, YAML.stringify(edited));
  hold = false;
  sy = open(false);
  expect(sy.getStatus([held!.taskId], "alpha")[0]!.state).toBe("interrupted");
  expect(sy.resumeTask(held!.taskId, "alpha")).toBe("queued");
  await close(sy);
  sy = open(true);
  const resumed = await sy.awaitResults([held!.taskId], { timeoutSeconds: 30 });
  expect(resumed.completed.map((r) => r.executionStatus), JSON.stringify(sy.getStatus([held!.taskId], "alpha"))).toEqual(["completed"]);
  await close(sy);

  // ---- 5. a task Lab: a coding attempt's committed change verified in an ephemeral project Lab.
  sy = open(false);
  const labs = sy.labsFor("alpha");
  const stores = sy.projectStores("alpha");
  const labTask = "c1_lab_task";
  stores.tasks.submit([WorkerTaskSchema.parse({ id: labTask, profile: "implement", goal: `change fixture ${GOAL}`, repositoryAliases: ["app"], writableRepository: "app", constraints: { allowedPaths: ["value.txt"], acceptanceCriteria: ["changed"] } })], { project: "alpha" });
  stores.db.prepare("UPDATE tasks SET state='running',lease_owner='fixture',lease_expires_at=?,deadline_at=?,run_count=1 WHERE id=?").run(Date.now() + 120_000, Date.now() + 120_000, labTask);
  const base = (await gitAsync(alphaDir, ["rev-parse", "HEAD"])).trim();
  const ws = await new Worktrees(stores.db, path.join(alphaDir, ".MeritRouter", "worktrees")).prepare({ taskId: labTask, run: 1, alias: "app", sourcePath: alphaDir, baseCommit: base });
  writeFileSync(path.join(ws.worktreePath, "value.txt"), "after");
  commitAll(ws.worktreePath, `fixture change\n\nAgent: fixture\nModel: fake/model\nTask: ${labTask}`);
  const commit = (await gitAsync(ws.worktreePath, ["rev-parse", "HEAD"])).trim(), tree = (await gitAsync(ws.worktreePath, ["rev-parse", "HEAD^{tree}"])).trim();
  stores.db.prepare("INSERT INTO executions(id,kind,profile,status,created_at) VALUES ('c1-exec','task','implement','running',?)").run(Date.now());
  stores.db.prepare("INSERT INTO execution_members(execution_id,task_id,item_id) VALUES ('c1-exec',?,?)").run(labTask, labTask);
  stores.db.prepare("INSERT INTO sessions(id,task_id,role,agent_label,profile,status,log_path,workspace_json,created_at,updated_at,project_id) VALUES ('c1-session',?,'implementer','fixture','implement','running','sessions/c1-session.jsonl',?,?,?,'alpha')")
    .run(labTask, JSON.stringify({ repos: [{ alias: "app", worktree: ws.worktreePath, branch: null, baseCommit: base, head: commit }] }), Date.now(), Date.now());
  const handle = await labs.taskAttempts.register({ taskId: labTask, project: "alpha", runCount: 1, leaseOwner: "fixture", executionId: "c1-exec", sessionId: "c1-session", sourceWorktree: ws.worktreePath, writableAlias: "app", repositories: [{ alias: "app", sourcePath: alphaDir, baseCommit: base, head: commit }] });
  const patchDigest = createHash("sha256").update(await gitAsync(ws.worktreePath, ["diff", "--binary", base, commit])).digest("hex");
  await labs.taskAttempts.submit(handle, { commit, tree, patchDigest });
  const op = labs.taskAttempts.requestCheck(handle, { checks: ["health"] });
  await labs.processControls();
  const labResult = await labs.taskAttempts.wait(handle, op.id);
  expect(labResult.status, JSON.stringify(labResult)).toBe("passed");
  const lab = labs.store.byId(labResult.labId)!;
  expect(inside(lab.root, path.join(alphaDir, ".MeritRouter"))).toBe(true);
  stores.db.prepare("UPDATE tasks SET state='completed',lease_owner=NULL,lease_expires_at=NULL WHERE id=?").run(labTask);
  stores.db.prepare("UPDATE sessions SET status='completed' WHERE id='c1-session'").run();
  stores.db.prepare("UPDATE executions SET status='completed',finished_at=? WHERE id='c1-exec'").run(Date.now());
  expect(count(sy.db, "SELECT COUNT(*) n FROM labs")).toBe(0);

  // ---- 6. project backup, a later change, then restore of the backup.
  const backupDir = path.join(root, "backups", "alpha");
  const manifest = await backupProjectStore(sy.db, { slug: "alpha", targetDir: backupDir });
  expect(manifest.identity.slug).toBe("alpha");
  const tasksAtBackup = count(stores.db, "SELECT COUNT(*) n FROM tasks");
  const [later] = await sy.submitTasks([summarizeTask({ goal: `after backup ${GOAL}` })], { project: "alpha" });
  expect(count(stores.db, "SELECT COUNT(*) n FROM tasks")).toBe(tasksAtBackup + 1);
  await close(sy);
  const coordination = openDatabase(storageDir, { durability: "full", fileMustExist: true });
  dbs.push(coordination);
  const restored = restoreProjectStore(coordination, { backupDir, force: true });
  coordination.close();
  expect(restored.projectDirectory).toBe(alphaDir);
  if (restored.previousMovedTo) expect(inside(restored.previousMovedTo, alphaDir)).toBe(true);
  sy = open(false);
  expect(count(sy.projectStores("alpha").db, "SELECT COUNT(*) n FROM tasks")).toBe(tasksAtBackup);
  expect(sy.getStatus([later!.taskId], "alpha")[0]!.state).toBe("unknown");
  expect(sy.getStatus([coding!.taskId], "alpha")[0]!.state).toBe("completed");

  // ---- 7. delete beta through the CLI: its store goes, its repository files stay.
  expect(await cli(["delete", "beta"], { confirm: "beta" })).toBe(0);
  expect(JSON.parse(printed)).toMatchObject({ slug: "beta", runtimeRoot: path.join(betaDir, ".MeritRouter") });
  expect(existsSync(path.join(betaDir, ".MeritRouter"))).toBe(false);
  expect(readFileSync(path.join(betaDir, "notes.txt"), "utf8")).toBe("beta user data\n");
  expect(gitSync(betaDir, "log", "--oneline")).toMatch(/init/);
  expect(projectStoreRegistrations(sy.db, "beta").map((r) => r.state)).toEqual(["retired"]);
  expect(count(sy.db, "SELECT COUNT(*) n FROM projects WHERE id='beta'")).toBe(0);
  // The CLI's project list and installation usage read every project's own store. `setup` wrote
  // no placeholder project (decision: a split installation starts with zero projects), so only
  // the project this journey created remains.
  expect(await cli(["list"])).toBe(0);
  expect((JSON.parse(printed) as Array<{ slug: string }>).map((p) => p.slug).sort()).toEqual(["alpha"]);
  expect(sy.usage(0).modelRequests).toBeGreaterThan(0);
  await close(sy);

  // ---- 8. migrate an idle project of a separate legacy installation, then roll it back before
  // its first dispatch.
  const legacyInstall = path.join(root, "legacy-install");
  const gammaDir = gitRepo(path.join(root, "projects", "gamma"), { "README.md": "# Gamma\n" });
  mkdirSync(legacyInstall, { recursive: true });
  const legacyConfig = path.join(legacyInstall, "meritrouter.config.yaml");
  writeFileSync(path.join(legacyInstall, "models.yaml"), YAML.stringify({ version: 1, endpoints: [endpoint()], overrides: {} }));
  writeFileSync(legacyConfig, YAML.stringify(testConfig({ storage: { directory: ".meritrouter", layout: "legacy" }, brain: { path: "brain", project: "gamma" }, projects: { gamma: { directory: gammaDir, repositories: { app: { path: gammaDir } } } } })));
  const legacyCfg = loadConfig(legacyConfig);
  const legacy = new MeritRouter(legacyCfg, { providerFetch: client.fetch, pollIntervalMs: 50, worker: true });
  services.push(legacy);
  current = legacy;
  expect(legacy.layout).toBe("legacy");
  const [legacyTask] = await legacy.submitTasks([summarizeTask({ goal: `Summarise ${LEGACY}` })], { project: "gamma" });
  expect((await legacy.awaitResults([legacyTask!.taskId], { timeoutSeconds: 30 })).completed).toHaveLength(1);
  await close(legacy);
  const legacyDb = openDatabase(legacyCfg.storageDir, { fileMustExist: true });
  dbs.push(legacyDb);
  const legacyTasks = count(legacyDb, "SELECT COUNT(*) n FROM tasks WHERE project_id='gamma'");
  const coord = openDatabase(storageDir, { durability: "full", fileMustExist: true });
  dbs.push(coord);
  const migrated = await migrateLegacyProject(coord, legacyDb, {
    slug: "gamma", projectDirectory: gammaDir, installationRoots: [...installationRoots, legacyInstall, legacyCfg.storageDir],
    legacyStorageDir: legacyCfg.storageDir, backupDir: path.join(legacyInstall, "migration-backups"),
  });
  expect(migrated.registration.state).toBe("registered");
  expect(existsSync(path.join(gammaDir, ".MeritRouter", "state"))).toBe(true);
  coord.close();
  // Configured in the split installation, the migrated history reads from gamma's own store.
  const withGamma = YAML.parse(readFileSync(configPath, "utf8")) as { projects: Record<string, unknown> };
  const configBeforeGamma = YAML.stringify(withGamma);
  withGamma.projects.gamma = { directory: gammaDir, repositories: { app: { path: gammaDir } } };
  writeFileSync(configPath, YAML.stringify(withGamma));
  sy = open(false);
  expect(sy.getStatus([legacyTask!.taskId], "gamma")[0]).toMatchObject({ project: "gamma", state: "completed" });
  expect(count(sy.db, "SELECT COUNT(*) n FROM tasks")).toBe(0);
  await close(sy);
  writeFileSync(configPath, configBeforeGamma);
  // Rolled back before its first dispatch: the registration retires and the store goes.
  const coordAgain = openDatabase(storageDir, { durability: "full", fileMustExist: true });
  dbs.push(coordAgain);
  const rolledBack = await rollbackProjectMigration(coordAgain, legacyDb, { migrationId: migrated.migrationId, legacyStorageDir: legacyCfg.storageDir });
  expect(rolledBack).toMatchObject({ slug: "gamma", previousState: "committed", targetRemoved: true, legacyIntact: true });
  expect(projectStoreRegistrations(coordAgain, "gamma").map((r) => r.state)).toEqual(["retired"]);
  expect(existsSync(path.join(gammaDir, ".MeritRouter"))).toBe(false);
  expect(readFileSync(path.join(gammaDir, "README.md"), "utf8")).toBe("# Gamma\n");
  expect(count(legacyDb, "SELECT COUNT(*) n FROM tasks WHERE project_id='gamma'")).toBe(legacyTasks);
  coordAgain.close();
  legacyDb.close();

  // ---- 9. the installation reopens cleanly with a deleted and a rolled-back project.
  sy = open(false);
  expect(sy.projectStores("alpha").project).toBe("alpha");
  expect(projectStoreRegistrations(sy.db, "alpha").map((r) => r.state)).toEqual(["registered"]);
  // The coordination store holds no project rows.
  for (const table of ["tasks", "sessions", "model_requests", "artifacts", "session_events", "workspaces", "labs", "executions"])
    expect(count(sy.db, `SELECT COUNT(*) n FROM ${table}`), table).toBe(0);
  expect(count(sy.db, "SELECT COUNT(*) n FROM events WHERE task_id IS NOT NULL")).toBe(0);
  await close(sy);
  current = null;

  // ---- 10. walk the installation: no canary in any installation file.
  const installationFiles = files(installDir);
  expect(installationFiles.length).toBeGreaterThan(0);
  for (const file of installationFiles) {
    const text = readFileSync(file);
    for (const canary of CANARIES) expect(text.includes(canary), `${canary} in ${file}`).toBe(false);
  }
  // Every runtime folder is spelled `.MeritRouter`.
  expect(readdirSync(installDir)).toContain(".MeritRouter");
  expect(readdirSync(installDir)).not.toContain(".meritrouter");
  expect(readdirSync(alphaDir)).toContain(".MeritRouter");
  // Alpha's content (tasks, sessions, worktrees, Lab, brain) is under its own .MeritRouter.
  const alphaRoot = path.join(alphaDir, ".MeritRouter");
  const alphaFiles = files(alphaRoot);
  for (const canary of [GOAL, OUTPUT, CODE]) expect(alphaFiles.some((file) => readFileSync(file).includes(canary)), canary).toBe(true);
  for (const sub of ["state", "sessions", "worktrees", "labs"]) expect(existsSync(path.join(alphaRoot, sub)), sub).toBe(true);
  // No other project's canary leaked into alpha, and alpha's repository stays clean in Git.
  for (const file of alphaFiles) expect(readFileSync(file).includes(BETA), file).toBe(false);
  expect(gitSync(alphaDir, "status", "--porcelain")).toBe("");
}, 300_000);

it("closes the installation database when the constructor fails after opening it", async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "meritrouter-c1-ctor-")));
  dirs.push(root);
  const configPath = path.join(root, "meritrouter.config.yaml");
  writeFileSync(path.join(root, "models.yaml"), YAML.stringify({ version: 1, endpoints: [endpoint()], overrides: {} }));
  const write = (layout: "split" | "legacy") => writeFileSync(configPath, YAML.stringify(testConfig({ storage: { directory: ".MeritRouter", layout }, brain: { path: "brain", project: "alpha" }, projects: { alpha: { repositories: {} } } })));
  // A legacy installation that already holds rows ...
  write("legacy");
  const legacy = new MeritRouter(loadConfig(configPath), { providerFetch: new ScriptedClient(() => reply("{}")).fetch });
  services.push(legacy);
  await legacy.submitTasks([summarizeTask()], { project: "alpha" });
  services.pop();
  await legacy.close();
  // ... refuses to be reopened as split, from inside the constructor after the database is open.
  write("split");
  const storageDir = loadConfig(configPath).storageDir;
  expect(() => new MeritRouter(loadConfig(configPath), { providerFetch: new ScriptedClient(() => reply("{}")).fetch })).toThrow(/split_layout_unavailable|already holds data/);
  // The failed constructor left no handle open: the store can be removed (Windows refuses with
  // EBUSY while a handle is open) and reopened.
  rmSync(storageDir, { recursive: true });
  expect(existsSync(storageDir)).toBe(false);
}, 60_000);

it("falls back to an existing old-spelled brain folder when the new spelling does not exist", async () => {
  const { resolveBrainPath, parseConfig } = await import("../src/config/load.js");
  const base = path.resolve("/install"), home = path.resolve("/home/user");
  const only = (...existing: string[]) => (p: string) => existing.map((e) => path.resolve(e)).includes(path.resolve(p));
  // Case-sensitive filesystem: only the old spelling exists.
  expect(resolveBrainPath(base, "~/.MeritRouter/brain", only(path.join(home, ".meritrouter", "brain")), home)).toBe("~/.meritrouter/brain");
  expect(resolveBrainPath(base, ".MeritRouter/brain", only(path.join(base, ".meritrouter", "brain")), home)).toBe(".meritrouter/brain");
  // The new spelling exists, neither exists, or the path has no runtime folder: unchanged.
  expect(resolveBrainPath(base, "~/.MeritRouter/brain", only(path.join(home, ".MeritRouter", "brain"), path.join(home, ".meritrouter", "brain")), home)).toBe("~/.MeritRouter/brain");
  expect(resolveBrainPath(base, "~/.MeritRouter/brain", only(), home)).toBe("~/.MeritRouter/brain");
  expect(resolveBrainPath(base, "knowledge/brain", only(path.join(base, "knowledge", "brain")), home)).toBe("knowledge/brain");

  // Through parseConfig on this filesystem: the resolved brain is the existing old-spelled folder
  // (directly on a case-insensitive filesystem, through the fallback on a case-sensitive one), and
  // every project's brain settings follow it.
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "meritrouter-c1-brain-")));
  dirs.push(root);
  mkdirSync(path.join(root, ".meritrouter", "brain"), { recursive: true });
  const cfg = parseConfig(baseConfig({ storage: { directory: ".MeritRouter" }, brain: { path: ".MeritRouter/brain", project: "alpha" }, repositories: {}, projects: { alpha: { repositories: {} } } }), path.join(root, "meritrouter.config.yaml"));
  expect(existsSync(path.resolve(root, cfg.brain.path))).toBe(true);
  expect(readdirSync(root)).toEqual([".meritrouter"]);
  expect(cfg.projectResolution.projects.map((p) => p.overrides.brain?.path)).toEqual([cfg.brain.path]);
});
