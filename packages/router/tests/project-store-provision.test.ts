import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { databasePath, openDatabase, type Db } from "../src/storage/db.js";
import { initializeStoreRole } from "../src/storage/store-role.js";
import { createCoordinationStoreIdentity, createProjectStoreIdentity, readStoreIdentity, retireProjectStoreRegistration,
  type ProjectStoreIdentity } from "../src/projects/store-identity.js";
import { prepareProjectStore, provisionProjectStore, type ProjectStoreProvisionStep } from "../src/projects/store-provision.js";
import { ProjectRuntimeRegistry, type ProjectRuntimeBundle } from "../src/projects/runtime-registry.js";
import { projectContext } from "../src/projects/context.js";
import { projectRuntimePaths } from "../src/projects/runtime-paths.js";
import { git } from "../src/workspaces/git.js";
import { makeEnv, type Env } from "./helpers.js";

const envs: Env[] = [], dbs: Db[] = [], registries: ProjectRuntimeRegistry[] = [];
afterEach(async () => {
  await Promise.allSettled(registries.splice(0).map(registry => registry.close()));
  for (const db of dbs.splice(0)) if (db.open) db.close();
  for (const env of envs.splice(0)) env.cleanup();
});

function fixture() {
  const env = makeEnv(); envs.push(env);
  const install = path.join(env.dir, "install"), coordination = openDatabase(install, { durability: "full" }); dbs.push(coordination);
  const owner = createCoordinationStoreIdentity(); initializeStoreRole(coordination, owner);
  const dir = (name: string) => { const value = path.join(env.dir, name); mkdirSync(value, { recursive: true }); return value; };
  const input = (slug: string, projectDirectory: string) => ({ slug, projectDirectory, installationRoots: [install], now: 1000 });
  const rows = () => coordination.prepare("SELECT project_uuid id,slug,state,project_directory dir FROM project_store_registrations ORDER BY created_at").all() as { id: string; slug: string; state: string; dir: string }[];
  const registry = (slug: string, projectDirectory: string) => {
    const created = new ProjectRuntimeRegistry(coordination, {
      context: name => projectContext(env.cfg, { project: { slug: name, name, legacy: false }, projectDirectory,
        brain: { ...env.cfg.brain, project: name, path: projectRuntimePaths(projectDirectory).brain } }),
      build: built => ({ db: built.db, tasks: { db: built.db }, identity: built.identity, project: built.identity.slug,
        drain: async () => {} }) as unknown as ProjectRuntimeBundle,
    });
    registries.push(created); void slug; return created;
  };
  return { env, install, coordination, owner, dir, input, rows, registry };
}
function localIdentity(projectDirectory: string) {
  const db = openDatabase(projectRuntimePaths(projectDirectory).state, { readonly: true, fileMustExist: true });
  try { return readStoreIdentity(db); } finally { db.close(); }
}
/** Every path under a .git directory with its content hash (exclude, index, refs, locks). */
function gitSnapshot(gitDirectory: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const file = path.join(directory, name), rel = path.relative(gitDirectory, file).split(path.sep).join("/");
      if (lstatSync(file).isDirectory()) { out[`${rel}/`] = "dir"; walk(file); }
      else out[rel] = createHash("sha256").update(readFileSync(file)).digest("hex");
    }
  };
  walk(gitDirectory);
  return out;
}
const crash = (at: ProjectStoreProvisionStep) => ({ afterStep: (step: ProjectStoreProvisionStep) => { if (step === at) throw new Error(`injected crash after ${step}`); } });

describe("project store provisioning", () => {
  it("provisions a store that the runtime registry opens, with a v2 manifest and one registration", async () => {
    const f = fixture(), alpha = f.dir("alpha");
    const result = await provisionProjectStore(f.coordination, f.input("alpha", alpha));
    expect(result.adopted).toBe(false);
    expect(result.identity).toMatchObject({ role: "project", slug: "alpha", installationId: f.owner.installationId, generation: 1 });
    expect(result.registration).toMatchObject({ projectId: result.identity.projectId, state: "registered", createdAt: 1000 });
    expect(result.paths.state).toBe(path.join(alpha, ".MeritRouter", "state"));
    expect(JSON.parse(readFileSync(result.paths.manifest, "utf8"))).toEqual({ layoutVersion: 2, projectId: result.identity.projectId, jobs: [], repositories: [] });
    expect(existsSync(`${result.paths.manifest}.provision.tmp`)).toBe(false);
    expect(localIdentity(alpha)).toEqual(result.identity);
    const bundle = f.registry("alpha", alpha).openRegistered(result.identity.projectId);
    expect(bundle.identity).toEqual(result.identity);
    expect(bundle.db.pragma("synchronous", { simple: true })).toBe(2);
    expect(f.rows()).toHaveLength(1);
  });

  it("is idempotent for a fully provisioned project and leaves its manifest untouched", async () => {
    const f = fixture(), alpha = f.dir("alpha");
    const first = await provisionProjectStore(f.coordination, f.input("alpha", alpha));
    const manifest = readFileSync(first.paths.manifest);
    const again = await provisionProjectStore(f.coordination, f.input("alpha", alpha));
    expect(again).toMatchObject({ adopted: true, identity: first.identity, registration: first.registration });
    expect(readFileSync(first.paths.manifest)).toEqual(manifest);
    expect(f.rows()).toHaveLength(1);
  });

  const steps: [ProjectStoreProvisionStep, boolean][] = [["validated", false], ["excluded", false], ["directory", false], ["database", false],
    ["identity", true], ["manifest", true], ["closed", true], ["registered", true]];
  it.each(steps)("re-running after a crash at %s completes with one identity (adopted=%s)", async (step, adopted) => {
    const f = fixture(), project = f.env.repo;
    await expect(provisionProjectStore(f.coordination, f.input("alpha", project), crash(step))).rejects.toThrow(/injected crash/);
    const orphan = existsSync(databasePath(projectRuntimePaths(project).state)) ? localIdentity(project) : null;
    const result = await provisionProjectStore(f.coordination, f.input("alpha", project));
    expect(result.adopted).toBe(adopted);
    if (adopted) expect(result.identity).toEqual(orphan);
    expect(localIdentity(project)).toEqual(result.identity);
    expect(f.rows()).toEqual([{ id: result.identity.projectId, slug: "alpha", state: "registered", dir: project }]);
    expect(JSON.parse(readFileSync(result.paths.manifest, "utf8")).projectId).toBe(result.identity.projectId);
    expect(f.registry("alpha", project).openRegistered(result.identity.projectId).identity).toEqual(result.identity);
  });

  it("adds .MeritRouter to the repository's Git exclude without staging anything", async () => {
    const f = fixture(), repo = f.env.repo;
    await provisionProjectStore(f.coordination, f.input("alpha", repo));
    const exclude = readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain("MeritRouter private project metadata");
    expect(exclude).toMatch(/^\.\[mM\]\[eE\]\[rR\]\[iI\]\[tT\]\[rR\]\[oO\]\[uU\]\[tT\]\[eE\]\[rR\]\/$/m);
    expect((await git(repo, ["check-ignore", ".MeritRouter/state/meritrouter.db"])).trim()).toBe(".MeritRouter/state/meritrouter.db");
    expect(await git(repo, ["status", "--porcelain", "--untracked-files=all"])).toBe("");
  });

  it("hides a subdirectory project's metadata with its own .gitignore, never the enclosing repository's exclude", async () => {
    const f = fixture(), sub = path.join(f.env.repo, "src"), exclude = path.join(f.env.repo, ".git", "info", "exclude");
    const before = existsSync(exclude) ? readFileSync(exclude) : null;
    await provisionProjectStore(f.coordination, f.input("alpha", sub));
    expect(existsSync(exclude) ? readFileSync(exclude) : null).toEqual(before);
    expect(readFileSync(path.join(sub, ".MeritRouter", ".gitignore"), "utf8")).toBe("*\n");
    expect(await git(f.env.repo, ["status", "--porcelain", "--untracked-files=all"])).toBe("");
  });

  it("leaves an enclosing repository's .git byte-identical when the project directory is a plain folder inside it", async () => {
    const f = fixture(), enclosing = f.dir("enclosing"), project = path.join(enclosing, "work", "alpha");
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: enclosing });
    writeFileSync(path.join(enclosing, "README.md"), "enclosing\n");
    execFileSync("git", ["add", "README.md"], { cwd: enclosing });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init"], { cwd: enclosing });
    mkdirSync(path.join(enclosing, ".git", "info"), { recursive: true });
    writeFileSync(path.join(enclosing, ".git", "info", "exclude"), "# owner rules\n");
    mkdirSync(project, { recursive: true });
    const before = gitSnapshot(path.join(enclosing, ".git"));
    const result = await provisionProjectStore(f.coordination, f.input("alpha", project));
    expect(localIdentity(project)).toEqual(result.identity);
    expect(gitSnapshot(path.join(enclosing, ".git"))).toEqual(before);
    expect(execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: enclosing, encoding: "utf8" })).toBe("");
    // Idempotent: a second provisioning accepts its own .gitignore and still writes nothing to Git.
    await provisionProjectStore(f.coordination, f.input("alpha", project));
    expect(gitSnapshot(path.join(enclosing, ".git"))).toEqual(before);
  });

  it("refuses a metadata .gitignore that would re-include private files", async () => {
    const f = fixture(), alpha = f.dir("alpha");
    mkdirSync(path.join(alpha, ".MeritRouter"));
    writeFileSync(path.join(alpha, ".MeritRouter", ".gitignore"), "*\n!state/\n");
    await expect(provisionProjectStore(f.coordination, f.input("alpha", alpha))).rejects.toThrow(/last rule must be "\*"/);
    expect(existsSync(path.join(alpha, ".MeritRouter", "state"))).toBe(false);
  });

  it("refuses an unbound or non-FULL coordination database before touching the project directory", async () => {
    const f = fixture(), alpha = f.dir("alpha");
    for (const durability of ["full", "normal"] as const) {
      const unbound = openDatabase(path.join(f.env.dir, `unbound-${durability}`), { durability }); dbs.push(unbound);
      await expect(provisionProjectStore(unbound, f.input("alpha", alpha))).rejects.toThrow(/coordination store/);
    }
    const lax = openDatabase(f.install, { durability: "normal" }); dbs.push(lax);
    await expect(provisionProjectStore(lax, f.input("alpha", alpha))).rejects.toThrow(/FULL/);
    expect(existsSync(path.join(alpha, ".MeritRouter"))).toBe(false);
  });

  it("refuses a project directory equal to, inside, or containing an installation root", async () => {
    const f = fixture(), outer = f.dir("outer"), cases: [string, string[]][] = [
      [f.install, [f.install]],
      [f.dir("install/projects/alpha"), [f.install]],
      [outer, [path.join(outer, "nested", "config")]],
      [outer, [path.join(outer, ".meritrouter")]],
      [outer, [path.join(outer, ".MERITROUTER", "storage")]],
    ];
    if (process.platform === "win32") cases.push([outer, [path.join(outer.toUpperCase(), "config")]], [outer.toLowerCase(), [outer.toUpperCase()]]);
    for (const [projectDirectory, installationRoots] of cases) {
      await expect(provisionProjectStore(f.coordination, { slug: "alpha", projectDirectory, installationRoots })).rejects.toThrow(/overlaps the installation/);
    }
    await expect(provisionProjectStore(f.coordination, { slug: "alpha", projectDirectory: outer, installationRoots: [] })).rejects.toThrow();
    expect(existsSync(path.join(outer, ".MeritRouter"))).toBe(false);
    expect(f.rows()).toHaveLength(0);
  });

  it("refuses a project directory inside MeritRouter metadata", async () => {
    const f = fixture(), alpha = f.dir("alpha"), nested = f.dir("alpha/.MeritRouter/inner");
    await expect(provisionProjectStore(f.coordination, f.input("beta", nested))).rejects.toThrow(/metadata directory/);
    void alpha;
  });

  it("gives a slug re-created after retirement a new project UUID, refusing the retired store left in place", async () => {
    const f = fixture(), alpha = f.dir("alpha"), other = f.dir("other");
    const first = await provisionProjectStore(f.coordination, f.input("alpha", alpha));
    retireProjectStoreRegistration(f.coordination, first.identity, 2000);
    await expect(provisionProjectStore(f.coordination, f.input("alpha", alpha))).rejects.toThrow(/retired project/);
    rmSync(path.join(alpha, ".MeritRouter"), { recursive: true });
    const second = await provisionProjectStore(f.coordination, f.input("alpha", alpha));
    expect(second.adopted).toBe(false);
    expect(second.identity.projectId).not.toBe(first.identity.projectId);
    expect(second.identity.storeId).not.toBe(first.identity.storeId);
    retireProjectStoreRegistration(f.coordination, second.identity, 3000);
    const third = await provisionProjectStore(f.coordination, f.input("alpha", other));
    expect(new Set([first, second, third].map(r => r.identity.projectId)).size).toBe(3);
    expect(f.rows().map(r => r.state)).toEqual(["retired", "retired", "registered"]);
  });

  it("refuses a slug or directory owned by another live project and never re-mints a lost registered store", async () => {
    const f = fixture(), alpha = f.dir("alpha"), beta = f.dir("beta");
    const first = await provisionProjectStore(f.coordination, f.input("alpha", alpha));
    await expect(provisionProjectStore(f.coordination, f.input("alpha", beta))).rejects.toThrow(/slug "alpha" is already owned/);
    await expect(provisionProjectStore(f.coordination, f.input("beta", alpha))).rejects.toThrow(/store of project "alpha"/);
    rmSync(path.join(alpha, ".MeritRouter"), { recursive: true });
    await expect(provisionProjectStore(f.coordination, f.input("beta", alpha))).rejects.toThrow(/directory .* is already owned/);
    await expect(provisionProjectStore(f.coordination, f.input("alpha", alpha))).rejects.toThrow(/already owned by registered project/);
    expect(existsSync(databasePath(projectRuntimePaths(alpha).state))).toBe(false);
    expect(f.rows()).toEqual([{ id: first.identity.projectId, slug: "alpha", state: "registered", dir: alpha }]);
    expect(existsSync(path.join(beta, ".MeritRouter"))).toBe(false);
  });

  it("refuses orphans from another installation, unbound databases holding data, and manifests without a store", async () => {
    const f = fixture(), foreign = f.dir("foreign"), dirty = f.dir("dirty"), stray = f.dir("stray");
    const foreignDb = openDatabase(projectRuntimePaths(foreign).state, { durability: "full" });
    initializeStoreRole(foreignDb, createProjectStoreIdentity(randomUUID(), "alpha")); foreignDb.close();
    await expect(provisionProjectStore(f.coordination, f.input("alpha", foreign))).rejects.toThrow(/another MeritRouter installation/);
    const dirtyDb = openDatabase(projectRuntimePaths(dirty).state, { durability: "full" });
    dirtyDb.prepare("INSERT INTO tasks(id,spec_hash,profile,spec_json,state,created_at,updated_at,project_id) VALUES('t','h','p','{}','pending',1,1,'alpha')").run(); dirtyDb.close();
    await expect(provisionProjectStore(f.coordination, f.input("alpha", dirty))).rejects.toThrow(/already holds data/);
    expect(localIdentity(dirty)).toBeNull();
    mkdirSync(path.join(stray, ".MeritRouter"));
    writeFileSync(path.join(stray, ".MeritRouter", "project.json"), JSON.stringify({ layoutVersion: 2, projectId: randomUUID(), jobs: [], repositories: [] }));
    await expect(provisionProjectStore(f.coordination, f.input("alpha", stray))).rejects.toThrow(/without a bound project store/);
    expect(existsSync(databasePath(projectRuntimePaths(stray).state))).toBe(false);
    expect(f.rows()).toHaveLength(0);
  });

  it("refuses an adopted store whose manifest names another project", async () => {
    const f = fixture(), alpha = f.dir("alpha");
    await expect(provisionProjectStore(f.coordination, f.input("alpha", alpha), crash("closed"))).rejects.toThrow(/injected/);
    const paths = projectRuntimePaths(alpha);
    writeFileSync(paths.manifest, JSON.stringify({ layoutVersion: 2, projectId: randomUUID(), jobs: [], repositories: [] }));
    await expect(provisionProjectStore(f.coordination, f.input("alpha", alpha))).rejects.toThrow(/describes another project/);
    expect(f.rows()).toHaveLength(0);
  });

  it("prepares a chosen identity without registering it, and adopts only that identity", async () => {
    const f = fixture(), alpha = f.dir("alpha");
    const chosen: ProjectStoreIdentity = { ...createProjectStoreIdentity(f.owner.installationId, "alpha"), generation: 2 };
    const prepared = await prepareProjectStore(f.coordination, f.input("alpha", alpha), chosen);
    expect(prepared).toMatchObject({ identity: chosen, adopted: false });
    expect(localIdentity(alpha)).toEqual(chosen);
    expect(f.rows()).toHaveLength(0);
    expect(await prepareProjectStore(f.coordination, f.input("alpha", alpha), chosen)).toMatchObject({ identity: chosen, adopted: true });
    await expect(prepareProjectStore(f.coordination, f.input("alpha", alpha), { ...chosen, generation: 3 })).rejects.toThrow(/different store generation/);
    await expect(prepareProjectStore(f.coordination, f.input("alpha", f.dir("beta")), createProjectStoreIdentity(randomUUID(), "alpha"))).rejects.toThrow(/another installation/);
  });
});
