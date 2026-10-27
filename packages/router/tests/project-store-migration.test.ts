import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerTaskSchema } from "../src/core/task.js";
import type { ProjectContext } from "../src/projects/context.js";
import { projectRuntimePaths } from "../src/projects/runtime-paths.js";
import { ProjectRuntimeRegistry, type ProjectRuntimeBundle } from "../src/projects/runtime-registry.js";
import { fileDigests, inspectProjectFiles, projectExportManifest, projectExportManifestSha256 } from "../src/projects/store-export.js";
import { createCoordinationStoreIdentity, readProjectStoreMigration, readProjectStoreRegistration, type ProjectStoreIdentity } from "../src/projects/store-identity.js";
import {
  legacyProjectFence, listProjectMigrationRecovery, migrateLegacyProject, openProjectMigrationRecoveryStore, planProjectMigration,
  ProjectMigrationRefusedError, rollbackProjectMigration, type ProjectMigrationOptions, type ProjectMigrationPhase,
} from "../src/projects/store-migration.js";
import { SessionStore } from "../src/sessions/store.js";
import { openDatabase, SCHEMA_VERSION, type Db } from "../src/storage/db.js";
import { assertStoreRole, initializeStoreRole } from "../src/storage/store-role.js";
import { TaskStore } from "../src/storage/tasks.js";
import { ArtifactStore } from "../src/storage/artifacts.js";
import { summarizeTask } from "./helpers.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const NOW = 1_800_000_000_000;
const BIG = 9_007_199_254_740_993n; // beyond 2^53: digests must stay exact

function seedProject(legacy: Db, legacyDir: string, base: string, p: string): void {
  legacy.prepare("INSERT INTO projects(id,name,created_at) VALUES(?,?,?)").run(p, p, NOW);
  new TaskStore(legacy, () => NOW).submit([
    WorkerTaskSchema.parse(summarizeTask({ id: `${p}-1`, goal: `secret-${p} goal` })),
    WorkerTaskSchema.parse(summarizeTask({ id: `${p}-2`, dependsOn: [`${p}-1`] })),
  ], { project: p });
  legacy.prepare("UPDATE tasks SET state='completed',finished_at=? WHERE project_id=?").run(NOW, p);
  legacy.prepare("INSERT INTO executions(id,kind,profile,status,created_at,finished_at) VALUES(?,?,?,?,?,?)").run(`x-${p}`, "task", "summarize", "completed", NOW, NOW);
  legacy.prepare("INSERT INTO execution_members(execution_id,task_id,item_id,outcome) VALUES(?,?,?,?)").run(`x-${p}`, `${p}-1`, `${p}-1`, "completed");
  legacy.prepare(`INSERT INTO model_requests(id,execution_id,purpose,gateway_model,status,reserved_at,finished_at,est_input_tokens,reserved_output_tokens,input_tokens,reported_cost_usd)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(`r-${p}`, `x-${p}`, "execution", "model", "succeeded", NOW, NOW, 10, 5, BIG, 0.1);
  legacy.prepare("INSERT INTO request_charges(request_id,task_id,input_tokens,output_tokens) VALUES(?,?,?,?)").run(`r-${p}`, `${p}-1`, 9, 4);
  legacy.prepare("INSERT INTO events(task_id,ts,type,data_json) VALUES(?,?,?,?)").run(`${p}-1`, NOW, "note", JSON.stringify({ text: `secret-${p}` }));
  new ArtifactStore(legacy, legacyDir, () => NOW).write({ taskId: `${p}-1`, executionId: `x-${p}`, kind: "text", label: "out", content: `artifact-${p}\n` });
  legacy.prepare(`INSERT INTO workspaces(task_id,repo_alias,source_path,worktree_path,base_sha,source_dirty,dirty_paths_json,status,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(`${p}-1`, "repo", path.join(base, "repo"), path.join(base, `wt-${p}`), "a".repeat(40), 0, "[]", "removed", NOW, NOW);
  legacy.prepare("INSERT INTO job_questions(task_id,question,answer,answered_by,asked_at,answered_at) VALUES(?,?,?,?,?,?)").run(`${p}-1`, "q", "a", "human", NOW, NOW);
  legacy.prepare("INSERT INTO product_deliveries(task_id,project_id,stage,spec_json,updated_at) VALUES(?,?,?,?,?)").run(`${p}-1`, p, "spec", "{}", NOW);
  legacy.prepare(`INSERT INTO budget_requests(task_id,role,requests,reason,used,cap,approver,status,granted,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(`${p}-1`, "worker", 2, "more", 1, 4, "human", "approved", 2, NOW);
  const session = new SessionStore(legacy, legacyDir, () => NOW).create({ taskId: `${p}-1`, role: "summarizer", agentLabel: `agent-${p}` });
  session.end("completed", "done");
}

function fullDigest(db: Db): string {
  const hash = createHash("sha256");
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'brain_fts%' ORDER BY name").all() as Array<{ name: string }>);
  for (const { name } of tables) {
    const statement = db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`); statement.safeIntegers(true);
    hash.update(name + JSON.stringify(statement.all(), (_k, v) => typeof v === "bigint" ? `${v}n` : v));
  }
  return hash.digest("hex");
}

function fixture() {
  const base = realpathSync.native(mkdtempSync(path.join(tmpdir(), "mr-a3-")));
  const install = path.join(base, "install"), alpha = path.join(base, "alpha"), beta = path.join(base, "beta"), backupDir = path.join(base, "backups");
  for (const dir of [install, alpha, beta]) mkdirSync(dir);
  const coordDir = path.join(install, "coordination"), legacyDir = path.join(install, "legacy");
  const state = { coordination: openDatabase(coordDir, { durability: "full" }), legacy: openDatabase(legacyDir) };
  initializeStoreRole(state.coordination, createCoordinationStoreIdentity());
  seedProject(state.legacy, legacyDir, base, "alpha");
  seedProject(state.legacy, legacyDir, base, "beta");
  new SessionStore(state.legacy, legacyDir, () => NOW).create({ role: "supervisor", agentLabel: "unowned" }).end("completed", "done");
  const registries: ProjectRuntimeRegistry[] = [];
  cleanups.push(async () => {
    await Promise.allSettled(registries.map(r => r.close()));
    for (const db of [state.coordination, state.legacy]) if (db.open) db.close();
    rmSync(base, { recursive: true, force: true });
  });
  const input = (slug = "alpha", dir = alpha) => ({ slug, projectDirectory: dir, installationRoots: [install], legacyStorageDir: legacyDir, backupDir, now: NOW });
  const migrate = (options: ProjectMigrationOptions = {}, slug = "alpha", dir = alpha) => migrateLegacyProject(state.coordination, state.legacy, input(slug, dir), options);
  const registry = () => {
    const r = new ProjectRuntimeRegistry(state.coordination, {
      context: slug => ({ project: { slug, name: slug, legacy: false }, brain: { project: slug, path: "brain" }, storage: {}, projectDirectory: slug === "alpha" ? alpha : beta }) as unknown as ProjectContext,
      build: construction => ({ db: construction.db, tasks: { db: construction.db }, identity: construction.identity, project: construction.identity.slug, drain: async () => {} }) as unknown as ProjectRuntimeBundle,
    });
    registries.push(r);
    return r;
  };
  const reopenCoordination = () => { state.coordination = openDatabase(coordDir, { durability: "full", fileMustExist: true }); };
  const rows = (sql: string, ...params: unknown[]) => state.coordination.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  return { base, install, alpha, beta, backupDir, coordDir, legacyDir, state, input, migrate, registry, reopenCoordination, rows };
}
type Fixture = ReturnType<typeof fixture>;

function targetDb(f: Fixture, identity: ProjectStoreIdentity): Db {
  return openDatabase(projectRuntimePaths(f.alpha).state, { durability: "full", fileMustExist: true, expectedIdentity: identity });
}
function legacySha(f: Fixture, slug: string): string {
  return projectExportManifestSha256(projectExportManifest(f.state.legacy, slug, "project"));
}
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
function storeSha(db: Db, projectDirectory: string): string {
  const scan = inspectProjectFiles(db, "alpha", { runtimeRoot: projectRuntimePaths(projectDirectory).root });
  expect(scan.problems).toEqual([]);
  return projectExportManifestSha256({ ...projectExportManifest(db, "alpha", "store"), files: fileDigests(scan.files) });
}
function registeredCount(f: Fixture): number {
  return (f.state.coordination.prepare("SELECT COUNT(*) n FROM project_store_registrations WHERE state='registered'").get() as { n: number }).n;
}
function backupFiles(f: Fixture): string[] { return existsSync(f.backupDir) ? readdirSync(f.backupDir) : []; }

describe("legacy project migration", () => {
  it("migrates one quiescent project, verifies digests, isolates the other project and opens through the registry", async () => {
    const f = fixture();
    // An older absolute log pointer: it resolves in the legacy layout and must be canonicalised in the target only.
    const session = f.state.legacy.prepare("SELECT id,log_path FROM sessions WHERE task_id='alpha-1'").get() as { id: string; log_path: string };
    const legacyLog = path.join(f.legacyDir, session.log_path);
    f.state.legacy.prepare("UPDATE sessions SET log_path=? WHERE id=?").run(legacyLog, session.id);
    const artifact = f.state.legacy.prepare("SELECT id,rel_path,sha256 FROM artifacts WHERE task_id='alpha-1'").get() as { id: string; rel_path: string; sha256: string };
    const legacyArtifact = path.join(f.legacyDir, "artifacts", ...artifact.rel_path.split("/"));
    const legacyFiles = { log: sha(legacyLog), artifact: sha(legacyArtifact) };
    expect(legacyFiles.artifact).toBe(artifact.sha256);
    const before = { alpha: legacySha(f, "alpha"), beta: legacySha(f, "beta"), legacy: fullDigest(f.state.legacy) };
    const plan = planProjectMigration(f.state.coordination, f.state.legacy, { slug: "alpha", projectDirectory: f.alpha, installationRoots: [f.install], legacyStorageDir: f.legacyDir });
    expect(plan.blockers).toEqual([]);
    expect(plan.ready).toBe(true);
    const counts = Object.fromEntries(plan.manifest!.tables.map(t => [t.table, t.rows]));
    expect(counts).toMatchObject({ projects: 1, tasks: 2, task_deps: 1, executions: 1, execution_members: 1, model_requests: 1, request_charges: 1,
      events: 3, artifacts: 1, workspaces: 1, job_questions: 1, product_deliveries: 1, product_delivery_history: 1, budget_requests: 1, sessions: 1 });
    expect(counts.session_events).toBeGreaterThanOrEqual(2);
    expect(plan.manifest!.files).toEqual([
      { kind: "artifact", id: artifact.id, path: `artifacts/${artifact.rel_path}`, bytes: 15, sha256: legacyFiles.artifact },
      { kind: "session", id: session.id, path: `sessions/${session.id}.jsonl`, bytes: expect.any(Number), sha256: legacyFiles.log },
    ]);
    expect(f.rows("SELECT * FROM project_store_registrations")).toEqual([]);

    const result = await f.migrate();
    expect(result.checkpointSha256).toBe(plan.checkpointSha256);
    expect(result.registration.state).toBe("registered");
    expect(result.journal).toMatchObject({ state: "committed", sourceGeneration: 1, targetGeneration: 2, targetSchema: SCHEMA_VERSION, sourceSchema: SCHEMA_VERSION });
    expect(result.identity.generation).toBe(2);
    expect(existsSync(result.backupFile) && existsSync(result.manifestFile)).toBe(true);

    const bundle = f.registry().openRegistered(result.identity.projectId);
    expect(bundle.identity).toEqual(result.identity);
    const target = bundle.db;
    assertStoreRole(target, result.identity);
    const stored = projectExportManifest(target, "alpha", "store");
    expect(stored.tables).toEqual(plan.manifest!.tables);
    expect(projectExportManifestSha256(stored)).not.toBe(result.checkpointSha256); // rows alone are not the checkpoint
    expect(storeSha(target, f.alpha)).toBe(result.checkpointSha256);
    const dump = JSON.stringify(projectExportManifest(target, "alpha", "store")) + JSON.stringify(
      ["tasks", "model_requests", "sessions", "events", "artifacts", "executions", "product_delivery_history"].map(t => target.prepare(`SELECT * FROM ${t}`).all()));
    expect(dump).toContain("secret-alpha");
    expect(dump).not.toContain("beta");
    const big = target.prepare("SELECT input_tokens FROM model_requests"); big.safeIntegers(true);
    expect(big.get()).toEqual({ input_tokens: BIG });

    // Payload files round-trip and resolve through the split runtime's own stores.
    const paths = projectRuntimePaths(f.alpha);
    expect(target.prepare("SELECT log_path FROM sessions WHERE id=?").get(session.id)).toEqual({ log_path: `sessions/${session.id}.jsonl` });
    const sessions = new SessionStore(target, paths.state);
    expect(sessions.get(session.id)!.logPath).toBe(path.join(paths.sessions, `${session.id}.jsonl`));
    expect(sessions.events(session.id)!.events.map(e => e.type)).toEqual(["started", "ended"]);
    expect(sha(path.join(paths.sessions, `${session.id}.jsonl`))).toBe(legacyFiles.log);
    const artifacts = new ArtifactStore(target, paths.state);
    expect(artifacts.absolutePath(artifacts.get(artifact.id)!)).toBe(path.join(paths.artifacts, ...artifact.rel_path.split("/")));
    expect(artifacts.read(`artifact:${artifact.id}`)!.content.toString()).toBe("artifact-alpha\n");
    expect(sha(path.join(paths.artifacts, ...artifact.rel_path.split("/")))).toBe(legacyFiles.artifact);
    expect(readdirSync(paths.sessions)).toEqual([`${session.id}.jsonl`]);
    expect(sha(legacyLog)).toBe(legacyFiles.log);
    expect(sha(legacyArtifact)).toBe(legacyFiles.artifact);
    expect(f.state.legacy.prepare("SELECT log_path FROM sessions WHERE id=?").get(session.id)).toEqual({ log_path: legacyLog });

    expect(legacySha(f, "alpha")).toBe(before.alpha);
    expect(legacySha(f, "beta")).toBe(before.beta);
    expect(fullDigest(f.state.legacy)).toBe(before.legacy);
    expect(listProjectMigrationRecovery(f.state.coordination)).toEqual([]);
    expect(legacyProjectFence(f.state.coordination, "alpha")).toEqual({ fenced: true, projectId: result.identity.projectId, state: "registered" });
    expect(legacyProjectFence(f.state.coordination, "beta").fenced).toBe(false);

    const again = planProjectMigration(f.state.coordination, f.state.legacy, { slug: "alpha", projectDirectory: f.alpha, installationRoots: [f.install], legacyStorageDir: f.legacyDir });
    expect(again.blockers.map(b => b.code)).toEqual(expect.arrayContaining(["already_registered", "target_exists"]));
  });

  it("refuses every non-quiescent or non-exportable legacy condition with an actionable reason", () => {
    const f = fixture();
    const db = f.state.legacy;
    const cases: Array<[string, () => void]> = [
      ["tasks_not_terminal", () => db.prepare("UPDATE tasks SET state='running' WHERE id='alpha-2'").run()],
      ["task_leases_live", () => db.prepare("UPDATE tasks SET lease_owner='worker',lease_expires_at=? WHERE id='alpha-1'").run(NOW)],
      ["labs_present", () => db.prepare(`INSERT INTO labs(id,project_id,name,state,root,recipe_json,repositories_json,ports_json,env_json,goal,created_at,updated_at,last_activity)
        VALUES('lab-1','alpha','lab','destroyed','/x','{}','[]','[]','{}','g',?,?,?)`).run(NOW, NOW, NOW)],
      ["worktrees_retained", () => db.prepare("UPDATE workspaces SET status='ready' WHERE task_id='alpha-1'").run()],
      ["workspace_attempts_open", () => {
        db.prepare(`INSERT INTO task_workspace_attempts(id,task_id,project_id,run_count,lease_owner,execution_id,source_worktree,writable_alias,repositories_json,state,created_at,updated_at)
          VALUES('att-1','alpha-1','alpha',1,'w','x-attempt',?,'repo','[]','submitted',?,?)`).run(path.join(f.base, "attempt-gone"), NOW, NOW);
        db.prepare(`INSERT INTO lab_task_attempts(attempt_id,lab_id,desired_state,phase,checks_json,recipe_json,recipe_digest,deadline_at,created_at,updated_at)
          VALUES('att-1',NULL,'running','checking','[]','{}','d',?,?,?)`).run(NOW, NOW, NOW);
      }],
      ["merge_pending", () => db.prepare(`INSERT INTO merge_queue(id,job_id,task_id,kind,repo_alias,branch,lock_key,integration_worktree,source_base,source_head,commits_json,state,created_at,updated_at)
        VALUES('m-1','alpha-1','alpha-1','task','repo','b','alpha/repo:main','/w','a','b','[]','queued',?,?)`).run(NOW, NOW)],
      ["file_leases_held", () => db.prepare("INSERT INTO file_leases(task_id,repository,globs_json,mode,acquired_at) VALUES('alpha-1','alpha/repo','[]','write',?)").run(NOW)],
      ["job_questions_open", () => db.prepare("INSERT INTO job_questions(task_id,question,asked_at) VALUES('alpha-2','open?',?)").run(NOW)],
      ["budget_requests_pending", () => db.prepare(`INSERT INTO budget_requests(task_id,role,requests,reason,used,cap,approver,status,created_at) VALUES('alpha-2','w',1,'r',0,1,'human','pending',?)`).run(NOW)],
      ["brain_access_pending", () => db.prepare(`INSERT INTO brain_access_requests(task_id,role,pattern,mode,reason,status,created_at) VALUES('alpha-1','w','x/**','read','r','pending',?)`).run(NOW)],
      ["requests_unresolved", () => db.prepare("UPDATE model_requests SET status='reserved' WHERE id='r-alpha'").run()],
      ["request_holds_active", () => {
        db.prepare(`INSERT INTO project_request_protocol(request_id,project_id,owner_json,fingerprint,binding_json,global_json,reservation_json,phase,created_at,updated_at)
          VALUES('pr-1','alpha','{}','f','{}','{}','{}','settled',?,?)`).run(NOW, NOW);
        db.prepare(`INSERT INTO project_request_holds(request_id,task_id,project_id,lease_incarnation,run_count,input_tokens,output_tokens,paid_usd,active)
          VALUES('pr-1','alpha-1','alpha','i',1,0,0,0,1)`).run();
      }],
      ["execution_claims_unresolved", () => db.prepare(`INSERT INTO project_execution_claims(grant_id,nonce,project_id,project_uuid,store_uuid,store_generation,binding_json,phase,created_at,updated_at)
        VALUES('g-1','n','alpha','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',1,'{}','claimed',?,?)`).run(NOW, NOW)],
      ["shared_execution", () => db.prepare("INSERT INTO execution_members(execution_id,task_id,item_id) VALUES('x-alpha','beta-1','b')").run()],
      ["foreign_key_closure", () => db.prepare("INSERT INTO request_charges(request_id,task_id,input_tokens,output_tokens) VALUES('r-beta','alpha-2',1,1)").run()],
      ["ownership_conflict", () => db.prepare("UPDATE events SET project_id='beta' WHERE task_id='alpha-1'").run()],
      ["unclassified_tables", () => db.exec("CREATE TABLE surprise(x)")],
    ];
    const baseline = fullDigest(db);
    for (const [code, mutate] of cases) {
      const sentinel = new Error("undo");
      let codes: string[] = [], remedies: string[] = [];
      try {
        db.transaction(() => {
          mutate();
          const plan = planProjectMigration(f.state.coordination, db, { slug: "alpha", projectDirectory: f.alpha, installationRoots: [f.install], legacyStorageDir: f.legacyDir });
          codes = plan.blockers.map(b => b.code); remedies = plan.blockers.map(b => b.remedy);
          expect(plan.ready, code).toBe(false);
          throw sentinel;
        })();
      } catch (error) { if (error !== sentinel) throw error; }
      expect(codes, code).toContain(code);
      expect(remedies.every(r => r.length > 10), code).toBe(true);
    }
    expect(fullDigest(db)).toBe(baseline);
    db.pragma(`user_version = ${SCHEMA_VERSION - 1}`);
    expect(planProjectMigration(f.state.coordination, db, { slug: "alpha", projectDirectory: f.alpha, installationRoots: [f.install], legacyStorageDir: f.legacyDir }).blockers.map(b => b.code)).toContain("schema_mismatch");
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
    const gamma = path.join(f.base, "gamma"); mkdirSync(gamma);
    expect(planProjectMigration(f.state.coordination, db, { slug: "gamma", projectDirectory: gamma, installationRoots: [f.install], legacyStorageDir: f.legacyDir }).blockers.map(b => b.code)).toEqual(["no_legacy_rows"]);
    const inside = path.join(f.install, "inside"); mkdirSync(inside);
    expect(planProjectMigration(f.state.coordination, db, { slug: "alpha", projectDirectory: inside, installationRoots: [f.install], legacyStorageDir: f.legacyDir }).blockers.map(b => b.code)).toContain("installation_overlap");
    mkdirSync(path.join(f.base, "wt-alpha"));
    expect(planProjectMigration(f.state.coordination, db, { slug: "alpha", projectDirectory: f.alpha, installationRoots: [f.install], legacyStorageDir: f.legacyDir }).blockers.map(b => b.code)).toEqual(["worktrees_on_disk"]);
  });

  it("refuses migration with no side effects when the project is busy or its metadata directory exists", async () => {
    const f = fixture();
    f.state.legacy.prepare("UPDATE tasks SET state='running' WHERE id='alpha-2'").run();
    const legacyBefore = fullDigest(f.state.legacy);
    await expect(f.migrate()).rejects.toThrow(ProjectMigrationRefusedError);
    await expect(f.migrate()).rejects.toThrow(/alpha-2 \(running\).*cancel them/s);
    f.state.legacy.prepare("UPDATE tasks SET state='completed' WHERE id='alpha-2'").run();
    mkdirSync(projectRuntimePaths(f.alpha).root);
    await expect(f.migrate()).rejects.toThrow(/target_exists.*Move the existing/s);
    expect(f.rows("SELECT * FROM project_store_registrations")).toEqual([]);
    expect(f.rows("SELECT * FROM project_store_migrations")).toEqual([]);
    expect(backupFiles(f)).toEqual([]);
    expect(readdirSync(projectRuntimePaths(f.alpha).root)).toEqual([]);
    f.state.legacy.prepare("UPDATE tasks SET state='running' WHERE id='alpha-2'").run();
    expect(fullDigest(f.state.legacy)).toBe(legacyBefore);
  });

  it("refuses missing, foreign, outside or corrupt payload files", async () => {
    const f = fixture();
    const codes = () => planProjectMigration(f.state.coordination, f.state.legacy, { slug: "alpha", projectDirectory: f.alpha, installationRoots: [f.install], legacyStorageDir: f.legacyDir }).blockers.map(b => b.code);
    const artifact = f.state.legacy.prepare("SELECT rel_path FROM artifacts WHERE task_id='alpha-1'").get() as { rel_path: string };
    const file = path.join(f.legacyDir, "artifacts", ...artifact.rel_path.split("/")), saved = readFileSync(file);
    rmSync(file);
    expect(codes()).toEqual(["file_missing"]);
    await expect(f.migrate()).rejects.toThrow(/file_missing.*Restore them from a backup/s);
    expect(f.rows("SELECT * FROM project_store_registrations")).toEqual([]);
    expect(existsSync(projectRuntimePaths(f.alpha).root) || backupFiles(f).length > 0).toBe(false);
    writeFileSync(file, Buffer.concat([saved, Buffer.from("tampered")]));
    expect(codes()).toEqual(["artifact_digest_mismatch"]);
    writeFileSync(file, saved);
    expect(codes()).toEqual([]);
    const outside = path.join(f.base, "elsewhere.jsonl"); writeFileSync(outside, "{}\n");
    const session = f.state.legacy.prepare("SELECT id,log_path FROM sessions WHERE task_id='alpha-1'").get() as { id: string; log_path: string };
    f.state.legacy.prepare("UPDATE sessions SET log_path=? WHERE id=?").run(outside, session.id);
    expect(codes()).toEqual(["file_outside_storage"]);
    f.state.legacy.prepare("UPDATE sessions SET log_path=? WHERE id=?").run(session.log_path, session.id);
    f.state.legacy.prepare("UPDATE artifacts SET rel_path='../escape.txt' WHERE task_id='alpha-1'").run();
    expect(codes()).toEqual(["file_outside_storage"]);
    f.state.legacy.prepare("UPDATE artifacts SET rel_path=? WHERE task_id='alpha-1'").run(artifact.rel_path);
    f.state.legacy.prepare("UPDATE sessions SET status='running' WHERE id=?").run(session.id);
    expect(codes()).toEqual(["sessions_running"]);
    f.state.legacy.prepare("UPDATE sessions SET status='completed' WHERE id=?").run(session.id);
    expect(planProjectMigration(f.state.coordination, f.state.legacy, { slug: "alpha", projectDirectory: f.alpha, installationRoots: [f.install], legacyStorageDir: f.base }).blockers.map(b => b.code))
      .toContain("legacy_storage_mismatch");
  });

  const crashes: Array<[string, (fail: () => never) => ProjectMigrationOptions, boolean]> = [
    ...(["planned", "backup"] as ProjectMigrationPhase[]).map(phase => [phase, (fail: () => never) => ({ afterPhase: (p: ProjectMigrationPhase) => { if (p === phase) fail(); } }), false] as [string, (fail: () => never) => ProjectMigrationOptions, boolean]),
    ...(["prepared", "store", "copying", "exported", "files", "verified"] as ProjectMigrationPhase[]).map(phase => [phase, (fail: () => never) => ({ afterPhase: (p: ProjectMigrationPhase) => { if (p === phase) fail(); } }), true] as [string, (fail: () => never) => ProjectMigrationOptions, boolean]),
    ["mid-export table", fail => ({ afterExportTable: table => { if (table === "sessions") fail(); } }), true],
    ["provision step database", fail => ({ provision: { afterStep: step => { if (step === "database") fail(); } } }), true],
  ];
  it.each(crashes)("crash after %s leaves no registered half-store and recovers", async (_name, options, journaled) => {
    const f = fixture();
    const legacyBefore = fullDigest(f.state.legacy);
    await expect(f.migrate(options(() => { throw new Error("injected crash"); }))).rejects.toThrow(/injected crash/);
    expect(registeredCount(f)).toBe(0);
    const journal = f.rows("SELECT migration_uuid id,project_uuid projectId,state FROM project_store_migrations") as Array<{ id: string; projectId: string; state: string }>;
    if (!journaled) {
      expect(journal).toEqual([]);
      expect(f.rows("SELECT * FROM project_store_registrations")).toEqual([]);
      expect(existsSync(projectRuntimePaths(f.alpha).root)).toBe(false);
      expect(backupFiles(f)).toEqual([]);
    } else {
      expect(journal).toHaveLength(1);
      expect(journal[0]!.state).toBe("recovery_required");
      expect(readProjectStoreRegistration(f.state.coordination, journal[0]!.projectId)!.state).toBe("migrating");
      expect(() => f.registry().openRegistered(journal[0]!.projectId)).toThrow(/requires migration/);
      expect(listProjectMigrationRecovery(f.state.coordination)).toEqual([expect.objectContaining({ migrationId: journal[0]!.id, access: "read-only-recovery", dispatchable: false, registrationState: "migrating" })]);
      await expect(f.migrate()).rejects.toThrow(new RegExp(`migration_pending.*${journal[0]!.id}`, "s"));
      const undone = await rollbackProjectMigration(f.state.coordination, f.state.legacy, { legacyStorageDir: f.legacyDir, migrationId: journal[0]!.id });
      expect(undone).toMatchObject({ targetRemoved: true, legacyIntact: true, previousState: "recovery_required" });
      expect(existsSync(projectRuntimePaths(f.alpha).root)).toBe(false);
      expect(readProjectStoreRegistration(f.state.coordination, journal[0]!.projectId)!.state).toBe("retired");
      expect(listProjectMigrationRecovery(f.state.coordination)).toEqual([]);
    }
    expect(fullDigest(f.state.legacy)).toBe(legacyBefore);
    const result = await f.migrate();
    const bundle = f.registry().openRegistered(result.identity.projectId);
    expect(storeSha(bundle.db, f.alpha)).toBe(result.checkpointSha256);
  });

  it("a crash right after commit leaves a complete registered store", async () => {
    const f = fixture();
    await expect(f.migrate({ afterPhase: p => { if (p === "committed") throw new Error("late crash"); } })).rejects.toThrow("late crash");
    const [row] = f.rows("SELECT project_uuid projectId,state FROM project_store_registrations") as Array<{ projectId: string; state: string }>;
    expect(row!.state).toBe("registered");
    expect(f.rows("SELECT state FROM project_store_migrations")).toEqual([{ state: "committed" }]);
    expect(() => f.registry().openRegistered(row!.projectId)).not.toThrow();
    await expect(f.migrate()).rejects.toThrow(/already_registered/);
  });

  it("a hard crash (coordination connection lost) leaves the journaled phase for startup recovery", async () => {
    const f = fixture();
    await expect(f.migrate({ afterPhase: p => { if (p === "exported") { f.state.coordination.close(); throw new Error("power loss"); } } })).rejects.toThrow(/power loss/);
    f.reopenCoordination();
    const [entry, ...rest] = listProjectMigrationRecovery(f.state.coordination);
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({ journalState: "copying", registrationState: "migrating", access: "read-only-recovery", slug: "alpha" });
    expect(() => f.registry().openRegistered(entry!.projectId)).toThrow(/requires migration/);
    const inspect = openProjectMigrationRecoveryStore(f.state.coordination, entry!.migrationId!);
    try {
      expect(inspect.readonly).toBe(true);
      expect(inspect.prepare("SELECT COUNT(*) n FROM tasks").get()).toEqual({ n: 2 });
    } finally { inspect.close(); }
    await rollbackProjectMigration(f.state.coordination, f.state.legacy, { legacyStorageDir: f.legacyDir, migrationId: entry!.migrationId! });
    expect(readProjectStoreMigration(f.state.coordination, entry!.migrationId!)!.state).toBe("rolled_back");
    const result = await f.migrate();
    expect(result.registration.state).toBe("registered");
  });

  it("rollback before first dispatch restores the coordination state, removes only the target and keeps legacy rows", async () => {
    const f = fixture();
    const snapshot = () => {
      const tables = (f.state.coordination.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'brain_fts%' AND name NOT IN ('project_store_registrations','project_store_migrations') ORDER BY name").all() as Array<{ name: string }>);
      return { other: tables.map(({ name }) => [name, f.state.coordination.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]),
        live: f.rows("SELECT * FROM project_store_registrations WHERE state!='retired'") };
    };
    const before = snapshot(), legacyBefore = fullDigest(f.state.legacy);
    const result = await f.migrate();
    const registry = f.registry();
    registry.openRegistered(result.identity.projectId);
    await registry.close(); // a loaded runtime must be drained before its directory can be removed
    const undone = await rollbackProjectMigration(f.state.coordination, f.state.legacy, { legacyStorageDir: f.legacyDir, migrationId: result.migrationId });
    expect(undone).toEqual({ migrationId: result.migrationId, projectId: result.identity.projectId, slug: "alpha", previousState: "committed", targetRemoved: true, legacyIntact: true });
    expect(snapshot()).toEqual(before);
    expect(f.rows("SELECT state FROM project_store_registrations")).toEqual([{ state: "retired" }]);
    expect(f.rows("SELECT state FROM project_store_migrations")).toEqual([{ state: "rolled_back" }]);
    expect(existsSync(projectRuntimePaths(f.alpha).root)).toBe(false);
    expect(existsSync(f.alpha) && existsSync(result.backupFile)).toBe(true);
    expect(result.manifest.files).toHaveLength(2);
    for (const file of result.manifest.files!) expect(existsSync(path.join(result.paths.root, ...file.path.split("/")))).toBe(false);
    expect(fullDigest(f.state.legacy)).toBe(legacyBefore);
    expect(legacyProjectFence(f.state.coordination, "alpha").fenced).toBe(false);
    expect(() => f.registry().openRegistered(result.identity.projectId)).toThrow();
    // Idempotent, and a fresh migration mints a new project identity.
    await expect(rollbackProjectMigration(f.state.coordination, f.state.legacy, { legacyStorageDir: f.legacyDir, migrationId: result.migrationId })).resolves.toMatchObject({ targetRemoved: true });
    const second = await f.migrate();
    expect(second.identity.projectId).not.toBe(result.identity.projectId);
    // The old rolled-back journal never touches the new store.
    await expect(rollbackProjectMigration(f.state.coordination, f.state.legacy, { legacyStorageDir: f.legacyDir, migrationId: result.migrationId })).rejects.toThrow(/another store/);
    expect(existsSync(projectRuntimePaths(f.alpha).state)).toBe(true);
  });

  it("refuses rollback after a copied payload file changed on the target", async () => {
    const f = fixture();
    const result = await f.migrate();
    const session = result.manifest.files!.find(file => file.kind === "session")!;
    appendFileSync(path.join(result.paths.root, ...session.path.split("/")), "{\"type\":\"late\"}\n");
    await expect(rollbackProjectMigration(f.state.coordination, f.state.legacy, { legacyStorageDir: f.legacyDir, migrationId: result.migrationId })).rejects.toThrow(/changed after the export/);
    expect(readProjectStoreRegistration(f.state.coordination, result.identity.projectId)!.state).toBe("registered");
    expect(existsSync(result.paths.sessions)).toBe(true);
  });

  it("refuses rollback after a dispatch-like change on the target", async () => {
    const f = fixture();
    const result = await f.migrate();
    const target = targetDb(f, result.identity);
    target.prepare("UPDATE tasks SET state='queued',finished_at=NULL WHERE id='alpha-2'").run();
    target.close();
    await expect(rollbackProjectMigration(f.state.coordination, f.state.legacy, { legacyStorageDir: f.legacyDir, migrationId: result.migrationId })).rejects.toThrow(/changed after the export/);
    expect(readProjectStoreRegistration(f.state.coordination, result.identity.projectId)!.state).toBe("registered");
    expect(readProjectStoreMigration(f.state.coordination, result.migrationId)!.state).toBe("committed");
    expect(existsSync(projectRuntimePaths(f.alpha).state)).toBe(true);
    expect(() => f.registry().openRegistered(result.identity.projectId)).not.toThrow();
  });
});
