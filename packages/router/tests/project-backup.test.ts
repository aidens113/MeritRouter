import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { openDatabase, type Db } from "../src/storage/db.js";
import { initializeStoreRole } from "../src/storage/store-role.js";
import { createCoordinationStoreIdentity, createProjectStoreIdentity, registerProjectStore, type ProjectStoreIdentity } from "../src/projects/store-identity.js";
import { projectRuntimePaths, type ProjectRuntimePaths } from "../src/projects/runtime-paths.js";
import { backupStorage, liveLeases } from "../src/operations/backup.js";
import { backupProjectStore, restoreProjectStore, readProjectBackupManifest, liveExecutionClaims } from "../src/operations/project-backup.js";

// A2: backup/restore of one project's own split store, built by hand (no provisioning helper
// exists yet). Every fixture uses OS-temp directories and fake providers; nothing touches a real
// installation.

const temps: string[] = [];
const openDbs: Db[] = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) {
    try { if (db.open) db.close(); } catch { /* already closed by the code under test */ }
  }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  temps.push(d);
  return d;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** One bound coordination store, by hand: open full-durability, then initializeStoreRole. */
function makeCoordination(): { dir: string; db: Db; installationId: string } {
  const dir = tempDir("meritrouter-coord-");
  const db = openDatabase(dir, { durability: "full" });
  openDbs.push(db);
  const identity = initializeStoreRole(db, createCoordinationStoreIdentity());
  if (identity.role !== "coordination") throw new Error("expected coordination identity");
  return { dir, db, installationId: identity.installationId };
}

/** One registered project store, by hand: mkdir state, open full-durability, initializeStoreRole, register. */
function makeProject(coordinationDb: Db, installationId: string, slug: string): { projectDir: string; paths: ProjectRuntimePaths; db: Db; identity: ProjectStoreIdentity } {
  const projectDir = tempDir(`meritrouter-proj-${slug}-`);
  const paths = projectRuntimePaths(projectDir);
  mkdirSync(paths.state, { recursive: true });
  const db = openDatabase(paths.state, { durability: "full" });
  openDbs.push(db);
  const identity = createProjectStoreIdentity(installationId, slug);
  initializeStoreRole(db, identity);
  registerProjectStore(coordinationDb, identity, projectDir);
  return { projectDir, paths, db, identity };
}

/** A canary task, session row + log file, and artifact row + file in a project's own store. */
function plantCanaries(db: Db, paths: ProjectRuntimePaths, slug: string, suffix = ""): void {
  const now = Date.now();
  db.prepare("INSERT INTO tasks(id,spec_hash,profile,spec_json,state,created_at,updated_at,project_id) VALUES(?,?,?,?,?,?,?,?)")
    .run(`task-${slug}${suffix}`, "h", "default", "{}", "completed", now, now, slug);
  mkdirSync(paths.sessions, { recursive: true });
  const logName = `session-${slug}${suffix}.jsonl`;
  writeFileSync(path.join(paths.sessions, logName), `{"seq":1,"at":${now},"type":"started"}\n{"seq":2,"at":${now},"type":"ended"}\n`);
  db.prepare("INSERT INTO sessions(id,role,agent_label,status,log_path,created_at,updated_at,project_id) VALUES(?,?,?,?,?,?,?,?)")
    .run(`session-${slug}${suffix}`, "worker", "worker", "completed", `sessions/${logName}`, now, now, slug);
  mkdirSync(paths.artifacts, { recursive: true });
  const artifactName = `artifact-${slug}${suffix}.txt`;
  writeFileSync(path.join(paths.artifacts, artifactName), `canary artifact body for ${slug}${suffix}\n`);
  db.prepare("INSERT INTO artifacts(id,kind,label,rel_path,media_type,sha256,bytes,created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(`art-${slug}${suffix}`, "note", "canary", artifactName, "text/plain", "x", 10, now);
  writeFileSync(paths.manifest, JSON.stringify({ canary: `project.json for ${slug}${suffix}` }, null, 2));
}

/** A one-commit git brain with a canary file, at `paths.brain`. */
function plantBrain(paths: ProjectRuntimePaths, slug: string): void {
  mkdirSync(paths.brain, { recursive: true });
  git(paths.brain, "init", "-q", "-b", "main");
  git(paths.brain, "config", "core.autocrlf", "false");
  writeFileSync(path.join(paths.brain, "note.md"), `brain canary for ${slug}\n`);
  git(paths.brain, "add", "note.md");
  git(paths.brain, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "canary note");
}

describe("project backup and restore", () => {
  it("round-trips a project's tasks, session log, artifact, project.json, and brain, surviving a mutation in between", async () => {
    const coord = makeCoordination();
    const project = makeProject(coord.db, coord.installationId, "alpha");
    plantCanaries(project.db, project.paths, "alpha");
    plantBrain(project.paths, "alpha");

    const target = path.join(tempDir("meritrouter-pb-target-"), "backup");
    const manifest = await backupProjectStore(coord.db, { slug: "alpha", targetDir: target });
    expect(manifest.format).toBe(1);
    expect(manifest.identity).toMatchObject({ installationId: coord.installationId, slug: "alpha", generation: 1 });
    expect(manifest.sourceProjectDirectory).toBe(project.paths.projectDirectory);
    expect(manifest.tasks).toBe(1);
    expect(manifest.sessions).toBe(1);
    expect(manifest.sessionLogs).toBe(1);
    expect(manifest.artifacts).toBe(1);
    expect(manifest.artifactFiles).toBe(1);
    expect(manifest.missing).toEqual([]);
    expect(manifest.brain).toMatchObject({ included: true, head: "main" });
    expect(readProjectBackupManifest(target)).toEqual(manifest);
    expect(readdirSync(target).sort()).toEqual(expect.arrayContaining(["meritrouter.db", "manifest.json", "sessions", "artifacts", "project.json", "brain.bundle"]));

    // Mutate everything after the backup: a stale task, a corrupted session log, a changed
    // artifact, a rewritten project.json, and a second brain commit.
    project.db.prepare("UPDATE tasks SET state='failed' WHERE id=?").run("task-alpha");
    writeFileSync(path.join(project.paths.sessions, "session-alpha.jsonl"), "corrupted\n");
    writeFileSync(path.join(project.paths.artifacts, "artifact-alpha.txt"), "mutated\n");
    writeFileSync(project.paths.manifest, JSON.stringify({ canary: "mutated" }));
    writeFileSync(path.join(project.paths.brain, "note.md"), "brain canary for alpha, mutated\n");
    git(project.paths.brain, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-am", "mutation");

    // A restore replaces the project's database file; close this process's handle first
    // (Windows cannot rename a directory containing an open file).
    project.db.close();

    const r = restoreProjectStore(coord.db, { backupDir: target, force: true });
    expect(r.projectDirectory).toBe(project.paths.projectDirectory);
    expect(r.previousMovedTo).not.toBeNull();
    expect(r.brain.action).toBe("replace");

    const restoredDb = new Database(path.join(project.paths.state, "meritrouter.db"), { readonly: true });
    try {
      expect((restoredDb.prepare("SELECT state FROM tasks WHERE id=?").get("task-alpha") as { state: string }).state).toBe("completed");
    } finally {
      restoredDb.close();
    }
    expect(readFileSync(path.join(project.paths.sessions, "session-alpha.jsonl"), "utf8")).toContain('"type":"ended"');
    expect(readFileSync(path.join(project.paths.artifacts, "artifact-alpha.txt"), "utf8")).toBe("canary artifact body for alpha\n");
    expect(JSON.parse(readFileSync(project.paths.manifest, "utf8"))).toEqual({ canary: "project.json for alpha" });
    expect(readFileSync(path.join(project.paths.brain, "note.md"), "utf8")).toBe("brain canary for alpha\n");
  });

  it("refuses a restore when the current registration's generation disagrees with the backup", async () => {
    const coord = makeCoordination();
    const project = makeProject(coord.db, coord.installationId, "beta");
    plantCanaries(project.db, project.paths, "beta");

    const target = path.join(tempDir("meritrouter-pb-gen-"), "backup");
    await backupProjectStore(coord.db, { slug: "beta", targetDir: target });

    // Bump the registration's generation directly in the coordination DB (not via a schema edit
    // or the migration machinery): simulates a store that has since migrated past this backup.
    coord.db.prepare("UPDATE project_store_registrations SET generation=2, updated_at=? WHERE slug=?").run(Date.now(), "beta");

    expect(() => restoreProjectStore(coord.db, { backupDir: target })).toThrow(/generation/);
  });

  it("refuses a restore while the project store holds a live task lease", async () => {
    const coord = makeCoordination();
    const project = makeProject(coord.db, coord.installationId, "gamma");
    plantCanaries(project.db, project.paths, "gamma");

    const target = path.join(tempDir("meritrouter-pb-lease-"), "backup");
    await backupProjectStore(coord.db, { slug: "gamma", targetDir: target });

    const expiresAt = Date.now() + 60_000;
    project.db.prepare("UPDATE tasks SET state='running', lease_owner='host:1:abc', lease_expires_at=? WHERE id=?").run(expiresAt, "task-gamma");
    expect(liveLeases(project.paths.state).map((l) => l.id)).toEqual(["task-gamma"]);

    expect(() => restoreProjectStore(coord.db, { backupDir: target, force: true })).toThrow(/live leases/);

    // Clearing the lease but leaving a live execution claim still refuses.
    project.db.prepare("UPDATE tasks SET state='completed', lease_expires_at=0 WHERE id=?").run("task-gamma");
    project.db.prepare(
      "INSERT INTO project_execution_claims(grant_id,nonce,project_id,project_uuid,store_uuid,store_generation,binding_json,phase,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    ).run("grant-1", "nonce-1", "gamma", project.identity.projectId, project.identity.storeId, project.identity.generation, "{}", "started", Date.now(), Date.now());
    expect(liveExecutionClaims(project.paths.state).map((c) => c.grantId)).toEqual(["grant-1"]);
    expect(() => restoreProjectStore(coord.db, { backupDir: target, force: true })).toThrow(/execution claim/);
  });

  it("keeps an installation backup of the coordination store free of a project's canary bytes", async () => {
    const coord = makeCoordination();
    const project = makeProject(coord.db, coord.installationId, "delta");
    plantCanaries(project.db, project.paths, "delta", "-very-unique-marker");

    const instTarget = path.join(tempDir("meritrouter-pb-inst-"), "backup");
    const installationManifest = await backupStorage({ storageDir: coord.dir, targetDir: instTarget });
    expect(installationManifest.installationRole).toBe("coordination");

    // The installation backup must never contain the project's own directory or canary bytes.
    expect(existsSync(path.join(instTarget, "sessions", "session-delta-very-unique-marker.jsonl"))).toBe(false);
    const files = [path.join(instTarget, "meritrouter.db"), path.join(instTarget, "manifest.json")];
    for (const f of files) {
      if (!existsSync(f)) continue;
      expect(readFileSync(f, "latin1")).not.toContain("very-unique-marker");
    }

    // A project backup of the same canary does contain the marker, proving the check is meaningful.
    const projTarget = path.join(tempDir("meritrouter-pb-proj-"), "backup");
    await backupProjectStore(coord.db, { slug: "delta", targetDir: projTarget });
    expect(readFileSync(path.join(projTarget, "artifacts", "artifact-delta-very-unique-marker.txt"), "utf8")).toContain("very-unique-marker");
  });

  it("refuses a target directory inside the project's own runtime directory or the installation storage", async () => {
    const coord = makeCoordination();
    const project = makeProject(coord.db, coord.installationId, "epsilon");
    plantCanaries(project.db, project.paths, "epsilon");

    await expect(backupProjectStore(coord.db, { slug: "epsilon", targetDir: path.join(project.paths.root, "bk") })).rejects.toThrow(/own runtime directory/);
    await expect(backupProjectStore(coord.db, { slug: "epsilon", targetDir: path.join(coord.dir, "bk") })).rejects.toThrow(/installation storage directory/);
  });
});
