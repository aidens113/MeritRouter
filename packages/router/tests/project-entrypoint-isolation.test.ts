import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import YAML from "yaml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { MeritRouter } from "../src/core/service.js";
import { createProject, deleteProject, previewProjectDeletion, projectActivity, projectAttention } from "../src/admin/projects.js";
import { projectsCommand } from "../src/cli/projects.js";
import { buildMcpServer } from "../src/mcp/tools.js";
import { prepareWorkspace } from "../src/runners/coding/finish.js";
import { baseResult, type RunContext } from "../src/runners/types.js";
import { projectStoreRegistrations, removeProjectRuntimeRoot, verifyProjectRuntimeRoot } from "../src/projects/deletion.js";
import type { ProjectStoreRegistration } from "../src/projects/store-identity.js";
import { baseConfig, FakeProvider, makeEnv, open, summarizeTask, type Env } from "./helpers.js";

// Project creation and deletion through every entry point (admin, CLI, MCP) in a split
// installation: the project's store goes in <directory>/.MeritRouter, and deleting the project
// removes that folder and nothing else. A legacy installation keeps its old behaviour.
//
// Split installations are selected with `storage.layout: split` (wave B2a's config key; B1 used
// an empty store opened with `durability: full`).

const services: MeritRouter[] = [], envs: Env[] = [], dirs: string[] = [], clients: Client[] = [];
afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((c) => c.close()));
  await Promise.allSettled(services.splice(0).map((s) => s.close()));
  for (const env of envs.splice(0)) env.cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 60_000);

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, stdio: "pipe" }).toString();

/** A temporary folder outside the installation (never inside the config or storage directory). */
function tempDir(prefix = "meritrouter-test-entry-"): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

function gitRepo(dir: string): string {
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "src", "app.ts"), "export const add = (a: number, b: number) => a + b;\n");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

/** A split installation whose first project `alpha` already has its store. */
async function splitInstall(opts: { worker?: boolean; coding?: { run: (ctx: RunContext) => Promise<unknown> } } = {}) {
  const alpha = gitRepo(tempDir());
  const env = makeEnv({ config: baseConfig({ storage: { directory: ".meritrouter", layout: "split" }, repositories: {}, brain: { path: "brain", project: "alpha" }, projects: { alpha: { directory: alpha, repositories: { app: { path: alpha } } } } }) });
  envs.push(env);
  const sy = open(env, new FakeProvider(), { ...(opts.worker ? { worker: true } : {}), ...(opts.coding ? { coding: opts.coding as never } : {}) });
  services.push(sy);
  expect(sy.layout).toBe("split");
  await sy.createSplitProject({ slug: "alpha", directory: alpha });
  return { env, sy, alpha };
}

const configOf = (env: Env) => YAML.parse(readFileSync(env.cfg.configPath, "utf8")) as { projects?: Record<string, { directory?: string }>; brain?: { project?: string } };
const registrationsOf = (sy: MeritRouter, slug: string) => projectStoreRegistrations(sy.db, slug).map((r) => r.state);
const physicalRequests = (sy: MeritRouter) => (sy.db.prepare("SELECT COUNT(*) n FROM physical_requests").get() as { n: number }).n;

describe("split installation: creating a project", () => {
  it("creates the store under <directory>/.MeritRouter through the admin API, persisting the directory", async () => {
    const { env, sy } = await splitInstall({ worker: true });
    const parent = tempDir();
    const dir = path.join(parent, "beta-project"); // does not exist yet: creation makes it
    const created = await createProject(sy, { slug: "beta", name: "Beta", directory: dir, repositories: { app: { path: path.join(dir, "app") } } });
    expect(created, JSON.stringify(created)).toMatchObject({ ok: true, runtimeRoot: path.join(dir, ".MeritRouter") });
    expect(configOf(env).projects?.beta?.directory).toBe(dir);
    expect(registrationsOf(sy, "beta")).toEqual(["registered"]);
    expect(existsSync(path.join(dir, ".MeritRouter", "project.json"))).toBe(true);
    expect(existsSync(path.join(dir, ".MeritRouter", "state", "meritrouter.db"))).toBe(true);
    // The project's tasks run in its own store; admin activity reads that store.
    const [out] = await sy.submitTasks([summarizeTask()], { project: "beta" });
    await sy.awaitResults([out!.taskId], { timeoutSeconds: 30 });
    expect(sy.projectStores("beta").tasks.get(out!.taskId)).toBeDefined();
    expect(sy.db.prepare("SELECT COUNT(*) n FROM tasks").get()).toEqual({ n: 0 });
    expect(projectActivity(sy, "beta").lastActivityAt).not.toBeNull();
    expect(projectAttention(sy, "beta").some((line) => /store/.test(line))).toBe(false);
  }, 60_000);

  it("requires a directory and writes nothing without one", async () => {
    const { env, sy } = await splitInstall();
    const before = readFileSync(env.cfg.configPath, "utf8");
    const out = await createProject(sy, { slug: "beta", repositories: {} });
    expect(out.ok).toBe(false);
    expect(out.ok ? [] : out.errors).toEqual([expect.stringMatching(/^directory: /)]);
    expect(readFileSync(env.cfg.configPath, "utf8")).toBe(before);
  });

  it("rolls the config back when the store cannot be provisioned, leaving no store behind", async () => {
    const { env, sy } = await splitInstall();
    const before = readFileSync(env.cfg.configPath, "utf8");
    // A folder inside the installation's config directory is refused by provisioning.
    const inside = path.join(env.dir, "inside-project");
    const out = await createProject(sy, { slug: "beta", directory: inside });
    expect(out.ok).toBe(false);
    expect(out.ok ? "" : out.errors.join("\n")).toMatch(/^directory: .*installation/m);
    expect(readFileSync(env.cfg.configPath, "utf8")).toBe(before);
    expect(sy.projects.get("beta")).toBeUndefined();
    expect(registrationsOf(sy, "beta").filter((s) => s === "registered")).toEqual([]);
    expect(existsSync(path.join(inside, ".MeritRouter"))).toBe(false);
    expect(existsSync(inside)).toBe(false); // created for the attempt, removed again while empty
  });

  it("creates and deletes through the CLI", async () => {
    const { env, sy } = await splitInstall();
    const dir = tempDir();
    const select = { cwd: dir, env: undefined };
    let printed = "";
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => { printed += String(chunk); return true; }) as typeof process.stdout.write;
    try {
      expect(await projectsCommand(sy, ["create", "gamma", dir], {}, true, select)).toBe(0);
      expect(JSON.parse(printed)).toMatchObject({ ok: true, runtimeRoot: path.join(dir, ".MeritRouter") });
      expect(configOf(env).projects?.gamma?.directory).toBe(dir);
      printed = "";
      expect(await projectsCommand(sy, ["delete", "gamma"], {}, true, select)).toBe(0); // preview only
      expect(JSON.parse(printed)).toMatchObject({ layout: "split", runtimeRoot: path.join(dir, ".MeritRouter"), blockers: [] });
      expect(existsSync(path.join(dir, ".MeritRouter"))).toBe(true);
      printed = "";
      expect(await projectsCommand(sy, ["delete", "gamma"], { confirm: "gamma" }, true, select)).toBe(0);
      expect(JSON.parse(printed)).toMatchObject({ slug: "gamma", runtimeRoot: path.join(dir, ".MeritRouter") });
    } finally {
      process.stdout.write = write;
    }
    expect(existsSync(path.join(dir, ".MeritRouter"))).toBe(false);
    expect(existsSync(dir)).toBe(true);
    expect(configOf(env).projects?.gamma).toBeUndefined();
    await expect(projectsCommand(sy, ["create", "delta", dir, "extra"], {}, true, select)).rejects.toThrow(/usage/);
  });

  it("creates through the MCP create_project tool", async () => {
    const { env, sy } = await splitInstall();
    const server = buildMcpServer({ sy, cfg: env.cfg, project: "alpha" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "entrypoint-test", version: "1" });
    clients.push(client);
    await client.connect(ct);
    const tool = (await client.listTools()).tools.find((t) => t.name === "create_project");
    expect(tool?.inputSchema.properties).toHaveProperty("directory");
    const missing = await client.callTool({ name: "create_project", arguments: { slug: "beta" } });
    expect(missing.isError).toBe(true);
    expect((missing.content as Array<{ text: string }>)[0]!.text).toMatch(/directory: /);
    const dir = tempDir();
    const made = await client.callTool({ name: "create_project", arguments: { slug: "beta", directory: dir, repositories: [{ alias: "app", path: path.join(dir, "app") }] } });
    expect(made.isError, JSON.stringify(made)).toBeFalsy();
    expect(JSON.parse((made.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ ok: true, runtimeRoot: path.join(dir, ".MeritRouter") });
    expect(existsSync(path.join(dir, ".MeritRouter", "project.json"))).toBe(true);
    expect(registrationsOf(sy, "beta")).toEqual(["registered"]);
  });
});

describe("split installation: deleting a project", () => {
  it("removes only <directory>/.MeritRouter, keeps accounting and the tombstone, and leaves the folder and repository", async () => {
    const { env, sy } = await splitInstall({ worker: true });
    const dir = gitRepo(tempDir());
    writeFileSync(path.join(dir, "notes.txt"), "user data\n");
    const outside = tempDir();
    writeFileSync(path.join(outside, "sentinel.txt"), "outside\n");
    const created = await createProject(sy, { slug: "beta", directory: dir, repositories: { app: { path: dir } } });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    const [out] = await sy.submitTasks([summarizeTask({ goal: "Summarise beta" })], { project: "beta" });
    await sy.awaitResults([out!.taskId], { timeoutSeconds: 30 });
    const root = path.join(dir, ".MeritRouter");
    // A link inside the store pointing outside it is unlinked, never followed.
    symlinkSync(outside, path.join(root, "escape"), "junction");
    const requests = physicalRequests(sy);

    const preview = await previewProjectDeletion(sy, "beta");
    expect(preview).toMatchObject({ layout: "split", runtimeRoot: root, blockers: [], counts: { tasks: 1 } });
    const result = await deleteProject(sy, "beta", { confirm: "beta" });
    expect(result).toMatchObject({ slug: "beta", runtimeRoot: root, removed: { tasks: 1 }, problems: [] });

    expect(existsSync(root)).toBe(false);
    expect(readFileSync(path.join(dir, "notes.txt"), "utf8")).toBe("user data\n");
    expect(readFileSync(path.join(outside, "sentinel.txt"), "utf8")).toBe("outside\n");
    expect(git(dir, "log", "--oneline")).toMatch(/init/);
    expect(configOf(env).projects?.beta).toBeUndefined();
    expect(sy.projects.get("beta")).toBeUndefined();
    // Global accounting and the retired registration (the tombstone) stay.
    expect(physicalRequests(sy)).toBe(requests);
    expect(registrationsOf(sy, "beta")).toEqual(["retired"]);
    expect(sy.db.prepare("SELECT COUNT(*) n FROM projects WHERE id='beta'").get()).toEqual({ n: 0 });
    // The other project is untouched.
    expect(existsSync(path.join(sy.projects.get("alpha")!.projectDirectory!, ".MeritRouter", "project.json"))).toBe(true);
  }, 60_000);

  it("removes task worktrees in the store natively, keeping their branches", async () => {
    let worktree = "";
    const coding = { run: async (ctx: RunContext) => {
      const { ws } = await prepareWorkspace(ctx);
      worktree = ws.worktreePath;
      return { state: "completed" as const, result: baseResult({ stopReason: "fixture", summary: "prepared" }) };
    } };
    const { sy } = await splitInstall({ worker: true, coding });
    const dir = gitRepo(tempDir());
    expect((await createProject(sy, { slug: "beta", directory: dir, repositories: { app: { path: dir } } })).ok).toBe(true);
    const [out] = await sy.submitTasks([{ profile: "implement", goal: "Add subtract", repositoryAliases: ["app"], writableRepository: "app", constraints: { acceptanceCriteria: ["subtract exists"], allowedPaths: ["src/**"] } }], { project: "beta" });
    await sy.awaitResults([out!.taskId], { timeoutSeconds: 30 });
    expect(worktree.toLowerCase().startsWith(path.join(dir, ".MeritRouter").toLowerCase())).toBe(true);
    const branches = git(dir, "branch", "--list");
    const result = await deleteProject(sy, "beta", { confirm: "beta" });
    expect(result.removed.worktrees).toBe(1);
    expect(existsSync(path.join(dir, ".MeritRouter"))).toBe(false);
    expect(git(dir, "worktree", "list", "--porcelain").split(/\r?\n/).filter((l) => l.startsWith("worktree "))).toHaveLength(1);
    expect(git(dir, "branch", "--list")).toBe(branches);
  }, 60_000);

  it("refuses a project with queued tasks and leaves its store live", async () => {
    const { sy } = await splitInstall(); // no worker: submissions stay queued
    const dir = tempDir();
    expect((await createProject(sy, { slug: "beta", directory: dir })).ok).toBe(true);
    await sy.submitTasks([summarizeTask()], { project: "beta" });
    const preview = await previewProjectDeletion(sy, "beta");
    expect(preview.blockers.join("; ")).toMatch(/1 queued task/);
    await expect(deleteProject(sy, "beta", { confirm: "beta" })).rejects.toThrow(/queued task/);
    expect(registrationsOf(sy, "beta")).toEqual(["registered"]);
    expect(existsSync(path.join(dir, ".MeritRouter", "project.json"))).toBe(true);
    expect(sy.projects.get("beta")).toBeDefined();
  });

  it("finishes a deletion that stopped after the store was retired", async () => {
    const { env, sy } = await splitInstall();
    const dir = tempDir();
    expect((await createProject(sy, { slug: "beta", directory: dir })).ok).toBe(true);
    await sy.retireProject("beta"); // as an interrupted deletion leaves it
    expect((await previewProjectDeletion(sy, "beta")).runtimeRoot).toBe(path.join(dir, ".MeritRouter"));
    const result = await deleteProject(sy, "beta", { confirm: "beta" });
    expect(result.runtimeRoot).toBe(path.join(dir, ".MeritRouter"));
    expect(existsSync(path.join(dir, ".MeritRouter"))).toBe(false);
    expect(configOf(env).projects?.beta).toBeUndefined();
  });

  it("refuses to remove a store folder that is a junction, or whose manifest names another project", async () => {
    const parent = tempDir();
    const target = tempDir();
    const projectId = "11111111-1111-4111-8111-111111111111";
    const manifest = JSON.stringify({ layoutVersion: 2, projectId, jobs: [], repositories: [] });
    writeFileSync(path.join(target, "project.json"), manifest);
    writeFileSync(path.join(target, "keep.txt"), "keep\n");
    const registration = (directory: string, id = projectId): ProjectStoreRegistration => ({
      installationId: "22222222-2222-4222-8222-222222222222", projectId: id, slug: "beta", storeId: "33333333-3333-4333-8333-333333333333",
      generation: 1, projectDirectory: directory, state: "retired", createdAt: 1, updatedAt: 2, retiredAt: 2,
    });
    // The store folder itself is a junction to a folder elsewhere.
    symlinkSync(target, path.join(parent, ".MeritRouter"), "junction");
    expect(() => removeProjectRuntimeRoot(registration(parent), parent, [])).toThrow(/link, junction|resolves elsewhere/);
    expect(readFileSync(path.join(target, "keep.txt"), "utf8")).toBe("keep\n");
    // The configured directory differs from the registered one.
    const other = tempDir();
    expect(() => verifyProjectRuntimeRoot(registration(parent), other, [])).toThrow(/configured with/);
    // A real folder whose manifest names another project.
    const real = tempDir();
    mkdirSync(path.join(real, ".MeritRouter"));
    writeFileSync(path.join(real, ".MeritRouter", "project.json"), manifest);
    writeFileSync(path.join(real, ".MeritRouter", "data.txt"), "data\n");
    expect(() => removeProjectRuntimeRoot(registration(real, "44444444-4444-4444-8444-444444444444"), real, [])).toThrow(/names project/);
    expect(existsSync(path.join(real, ".MeritRouter", "data.txt"))).toBe(true);
    // A folder that overlaps an installation root.
    expect(() => removeProjectRuntimeRoot(registration(real), real, [path.join(real, ".MeritRouter", "inner")])).toThrow(/overlaps the installation/);
    expect(existsSync(path.join(real, ".MeritRouter", "data.txt"))).toBe(true);
    // The verified folder goes; its parent stays.
    expect(removeProjectRuntimeRoot(registration(real), real, [])).toBe(true);
    expect(existsSync(path.join(real, ".MeritRouter"))).toBe(false);
    expect(existsSync(real)).toBe(true);
  });
});

describe("legacy installation", () => {
  it("creates and deletes projects as before: no directory required, no project store", async () => {
    const env = makeEnv({ config: baseConfig({ repositories: {}, brain: { path: "brain", project: "alpha" }, projects: { alpha: { repositories: { app: { path: "repo" } } } } }) });
    envs.push(env);
    const sy = open(env, new FakeProvider());
    services.push(sy);
    expect(sy.layout).toBe("legacy");
    const created = await createProject(sy, { slug: "beta", repositories: { app: { path: "beta-app" } } });
    expect(created, JSON.stringify(created)).toMatchObject({ ok: true, runtimeRoot: null });
    expect(configOf(env).projects?.beta?.directory).toBeUndefined();
    expect(existsSync(path.join(env.dir, "beta-app", ".MeritRouter"))).toBe(false);
    expect(sy.db.prepare("SELECT COUNT(*) n FROM project_store_registrations").get()).toEqual({ n: 0 });
    const [queued] = await sy.submitTasks([summarizeTask()], { project: "beta" });
    expect(projectActivity(sy, "beta").queuedTasks).toBe(1);
    const preview = await previewProjectDeletion(sy, "beta");
    expect(preview).toMatchObject({ layout: "legacy", runtimeRoot: null });
    expect(preview.blockers.join("; ")).toMatch(/1 queued task/);
    sy.cancelTasks([queued!.taskId], "beta");
    const result = await deleteProject(sy, "beta", { confirm: "beta" });
    expect(result).toMatchObject({ slug: "beta", runtimeRoot: null });
    expect(configOf(env).projects?.beta).toBeUndefined();
    expect(existsSync(path.join(env.dir, "beta-app", ".git"))).toBe(true);
  }, 60_000);
});
