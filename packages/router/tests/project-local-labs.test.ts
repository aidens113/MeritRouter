import path from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { LabManager } from "../src/labs/lab.js";
import { LabRecordSchema } from "../src/labs/store.js";
import { composeMountPathAllowed } from "../src/labs/compose-mount-policy.js";
import { labOwnedPath } from "../src/labs/paths.js";
import { ProjectRegistry } from "../src/projects/registry.js";
import { openDatabase, type Db } from "../src/storage/db.js";
import { git } from "../src/workspaces/git.js";
import { baseConfig, makeEnv, type Env } from "./helpers.js";

let env: Env | undefined, db: Db | undefined;
const managers: LabManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.close();
  db?.close(); db = undefined;
  env?.cleanup(); env = undefined;
});
function setup(options: { missingDirectory?: boolean } = {}) {
  const config = baseConfig({ repositories: {}, brain: { path: "brain", project: "alpha" },
    projects: { alpha: { repositories: { app: { path: "repo" } }, lab: { data: ["db"] } },
      beta: { repositories: { app: { path: "repo-beta" } }, lab: { data: ["db"] } } } });
  env = makeEnv({ config });
  execFileSync("git", ["clone", "-q", env.repo, path.join(env.dir, "repo-beta")], { windowsHide: true });
  db = openDatabase(env.cfg.storageDir);
  const registry = new ProjectRegistry(env.cfg);
  const manager = new LabManager({ db, storageDir: env.cfg.storageDir, cfg: env.cfg, monitor: false,
    project: slug => {
      const context = registry.context(slug);
      if (!context) throw new Error("unknown fixture project");
      if (options.missingDirectory) return { ...context, projectDirectory: null };
      return context;
    } });
  managers.push(manager); return manager;
}

describe("project-owned Lab roots", () => {
  it("creates isolated Lab repositories, data and metadata only inside each registered project", async () => {
    const manager = setup(), alpha = await manager.create("alpha", "preview"), beta = await manager.create("beta", "preview");
    expect(alpha.lab.root).toBe(path.join(env!.repo, ".MeritRouter", "labs", "alpha", "preview"));
    expect(beta.lab.root).toBe(path.join(env!.dir, "repo-beta", ".MeritRouter", "labs", "beta", "preview"));
    expect(existsSync(path.join(alpha.lab.root, "data", "db"))).toBe(true);
    expect(alpha.lab.repositories[0]!.worktree).toBe(path.join(alpha.lab.root, "repos", "app"));
    expect(existsSync(path.join(env!.cfg.storageDir, "labs"))).toBe(false);
    expect(await git(env!.repo, ["status", "--porcelain"])).toBe("");
    expect(() => manager.labPath(alpha.lab, beta.lab.root)).toThrow(/escapes/);
    await manager.destroy("alpha", "preview");
    expect(existsSync(alpha.lab.root)).toBe(false);
    expect(manager.status("beta", "preview").lab.id).toBe(beta.lab.id);
    expect(await git(env!.repo, ["show-ref", "--verify", `refs/heads/${alpha.lab.repositories[0]!.branch}`])).toContain(alpha.heads.app);
  });
  it("refuses new Labs without a trusted project directory instead of falling back to install storage", async () => {
    const manager = setup({ missingDirectory: true });
    await expect(manager.create("alpha", "preview")).rejects.toThrow(/project directory is required/);
    expect(manager.store.list()).toEqual([]);
    expect(existsSync(path.join(env!.cfg.storageDir, "labs"))).toBe(false);
  });
  it("preserves the exact persisted legacy root until explicit migration", async () => {
    const manager = setup(), root = path.join(env!.cfg.storageDir, "labs", "alpha", "legacy");
    mkdirSync(root, { recursive: true });
    const marker = JSON.stringify({ id: "legacy-lab", project: "alpha", name: "legacy" });
    writeFileSync(path.join(root, ".meritrouter-lab.json"), marker);
    const now = Date.now();
    manager.store.insert(LabRecordSchema.parse({ id: "legacy-lab", project: "alpha", name: "legacy", state: "stopped", root,
      recipe: { data: ["db"] }, repositories: [], ports: {}, env: {}, goal: "retained", createdAt: now, updatedAt: now, lastActivity: now }));
    expect(manager.status("alpha", "legacy").lab.root).toBe(root);
    expect(readFileSync(path.join(root, ".meritrouter-lab.json"), "utf8")).toBe(marker);
    expect(manager.store.get("alpha", "legacy")!.root).toBe(root);
    expect(existsSync(path.join(env!.repo, ".MeritRouter"))).toBe(false);
  });
  it("does not grant legacy storage authority to a fabricated Lab path", () => {
    const manager = setup(), root = path.join(env!.cfg.storageDir, "labs", "alpha", "unknown");
    expect(() => manager.labStorageDirectory("alpha", "unknown", root)).toThrow(/persisted ownership/);
  });
  it("preserves configured repository junction spelling with a canonical project owner", async () => {
    const manager = setup(), link = path.join(env!.dir, "configured-repository");
    symlinkSync(env!.repo, link, process.platform === "win32" ? "junction" : "dir");
    manager.options.project("alpha").repositoryPaths.app!.path = link;
    const created = await manager.create("alpha", "linked");
    expect(created.lab.root).toBe(path.join(env!.repo, ".MeritRouter", "labs", "alpha", "linked"));
    expect(created.lab.repositories[0]!.source).toBe(link);
    await manager.destroy("alpha", "linked");
  });
  it("rejects metadata junctions before writes or persistent Lab admission", async () => {
    const manager = setup(), foreign = path.join(env!.dir, "foreign");
    mkdirSync(foreign); writeFileSync(path.join(foreign, "sentinel"), "preserved");
    symlinkSync(foreign, path.join(env!.repo, ".MeritRouter"), process.platform === "win32" ? "junction" : "dir");
    await expect(manager.create("alpha", "preview")).rejects.toThrow(/symbolic|junction/i);
    expect(manager.store.list()).toEqual([]);
    expect(readFileSync(path.join(foreign, "sentinel"), "utf8")).toBe("preserved");
    expect(existsSync(path.join(foreign, "labs"))).toBe(false);
  });
  it("rejects a linked ancestor of a managed Lab path, including above the labs segment", () => {
    setup(); const foreign = path.join(env!.dir, "foreign"), link = path.join(env!.dir, "link");
    mkdirSync(foreign); symlinkSync(foreign, link, process.platform === "win32" ? "junction" : "dir");
    expect(() => labOwnedPath(link, path.join(link, "labs", "alpha", "one"))).toThrow(/symbolic/);
  });
});

describe("Compose project-local Lab mount boundary", () => {
  const root = path.join(tmpdir(), "project-local-compose", ".MeritRouter", "labs", "alpha", "preview");
  const authority = { labRoot: root, worktree: path.join(root, "repos", "app"), dataRoots: [path.join(root, "data", "db")] };
  it("permits only exact host-approved Lab repository subpaths and declared data", () => {
    expect(composeMountPathAllowed(authority, path.join(root, "repos", "app", "public"), "/public")).toBe(true);
    expect(composeMountPathAllowed(authority, path.join(root, "data", "db"), "/data")).toBe(true);
    expect(composeMountPathAllowed(authority, path.join(root, "data", "other"), "/other")).toBe(false);
  });
  it.each(["state", "brain", "sessions", "credentials"])("refuses sibling project metadata %s", name => {
    const source = path.join(tmpdir(), "project-local-compose", ".MeritRouter", name);
    expect(composeMountPathAllowed(authority, source, "/data")).toBe(false);
  });
  it.each([".git", ".MeritRouter", "docker.sock"])("refuses nested private/socket paths %s", name => {
    expect(composeMountPathAllowed(authority, path.join(authority.worktree, name), "/data")).toBe(false);
    expect(composeMountPathAllowed(authority, authority.dataRoots[0]!, `/${name}`)).toBe(false);
  });
  it("refuses crafted metadata lookalikes instead of granting all private roots", () => {
    for (const bad of [root.replace(`${path.sep}labs${path.sep}`, `${path.sep}state${path.sep}`), `${root}-other`, root.replace(".MeritRouter", ".meritrouter")]) {
      expect(composeMountPathAllowed({ ...authority, labRoot: bad }, authority.dataRoots[0]!, "/data")).toBe(false);
    }
  });
  it("preserves existing nonmetadata authority validation behavior", () => {
    const plain = path.join(tmpdir(), "legacy-compose");
    expect(composeMountPathAllowed({ labRoot: plain, worktree: path.join(plain, "repos", "app"), dataRoots: [path.join(plain, "data", "db")] }, path.join(plain, "data", "db"), "/data")).toBe(true);
  });
});
