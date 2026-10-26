import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DB_FILE, openDatabase, SCHEMA_VERSION, type Db } from "../src/storage/db.js";
import { MIGRATIONS } from "../src/storage/migrations.js";
import { assertStoreRole, initializeStoreRole } from "../src/storage/store-role.js";
import { createCoordinationStoreIdentity, createProjectStoreIdentity, ProjectStoreMigrationSchema,
  readProjectStoreMigration, readProjectStoreRegistration, readStoreIdentity, registerProjectStore,
  retireProjectStoreRegistration, StoreIdentitySchema } from "../src/projects/store-identity.js";

const roots: string[] = [], databases: Db[] = [];
afterEach(() => { for (const db of databases.splice(0)) if (db.open) db.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function directory() { const root = mkdtempSync(path.join(tmpdir(), "mr-store-identity-")); roots.push(root); return root; }
function store(full = true) { const db = openDatabase(directory(), { durability: full ? "full" : "normal" }); databases.push(db); return db; }
function coordination() { const db = store(), identity = createCoordinationStoreIdentity(); initializeStoreRole(db, identity); return { db, identity }; }
function task(db: Db, project: string) { db.prepare("INSERT INTO tasks(id,spec_hash,profile,spec_json,state,created_at,updated_at,project_id) VALUES('task','hash','fixture','{}','pending',1,1,?)").run(project); }

describe("explicit split store identity prerequisite", () => {
  it("preserves legacy normal opening and leaves its role unbound", () => {
    const db = store(false);
    expect(db.pragma("synchronous", { simple: true })).toBe(1);
    expect(readStoreIdentity(db)).toBeNull();
    expect(() => initializeStoreRole(db, createCoordinationStoreIdentity())).toThrow(/FULL/);
    expect(readStoreIdentity(db)).toBeNull();
  });
  it("persists a stable immutable role across reopening and rejects another owner/role/generation", () => {
    const root = directory(), db = openDatabase(root, { durability: "full" }); databases.push(db);
    const identity = createCoordinationStoreIdentity();
    expect(initializeStoreRole(db, identity)).toEqual(identity);
    expect(initializeStoreRole(db, identity)).toEqual(identity);
    expect(() => initializeStoreRole(db, { ...identity, generation: 2 })).toThrow(/generation/);
    expect(() => assertStoreRole(db, createCoordinationStoreIdentity())).toThrow(/owner/);
    expect(() => initializeStoreRole(db, createProjectStoreIdentity(identity.installationId, "alpha"))).toThrow(/role/);
    db.close(); const reopened = openDatabase(root, { durability: "full" }); databases.push(reopened);
    expect(assertStoreRole(reopened, identity)).toEqual(identity);
  });
  it("accepts only own tasks, own project identity and classified local metadata", () => {
    const { identity } = coordination(), db = store(), project = createProjectStoreIdentity(identity.installationId, "alpha");
    task(db, "alpha"); db.prepare("INSERT INTO projects(id,name,created_at) VALUES('alpha','Alpha',1)").run();
    db.prepare("INSERT INTO meta(key,value) VALUES('brain:index-generation:project:alpha','1')").run();
    expect(initializeStoreRole(db, project)).toEqual(project);
    db.prepare("UPDATE tasks SET project_id='beta'").run();
    expect(() => assertStoreRole(db, project)).toThrow(/foreign/);
    db.prepare("UPDATE tasks SET project_id=''").run();
    expect(() => assertStoreRole(db, project)).toThrow(/foreign/);
    db.prepare("UPDATE tasks SET project_id='alpha'").run();
    db.prepare("INSERT INTO meta(key,value) VALUES('provider_discovery_last','1')").run();
    expect(() => assertStoreRole(db, project)).toThrow(/metadata/);
  });
  it.each(["provider_usage", "paid_keys", "paid_spend"])("refuses %s contamination before role binding", table => {
    const db = store(), project = createProjectStoreIdentity(randomUUID(), "alpha");
    // Native rows must meet their existing schema; use trusted sqlite changes only in this fixture.
    if (table === "provider_usage") db.prepare("INSERT INTO provider_usage(scope,at,tokens,reservation) VALUES('fixture',1,1,'r')").run();
    if (table === "paid_keys") db.prepare("INSERT INTO paid_keys(provider,label,billing_class,enc,iv,tag,enabled,last4,created_at) VALUES('fixture','fixture','paid','fake','fake','fake',1,'fake',1)").run();
    if (table === "paid_spend") {
      db.prepare("INSERT INTO executions(id,kind,profile,status,created_at) VALUES('exec','task','fixture','running',1)").run();
      db.prepare("INSERT INTO model_requests(id,execution_id,purpose,gateway_model,status,reserved_at,est_input_tokens,reserved_output_tokens) VALUES('request','exec','fixture','fake','reserved',1,1,1)").run();
      db.prepare("INSERT INTO paid_spend(request_id,key_ref,provider,endpoint_id,reserved_usd,created_at) VALUES('request','key','fixture','fake',1,1)").run();
    }
    expect(() => initializeStoreRole(db, project)).toThrow(/shared coordination/);
    expect(readStoreIdentity(db)).toBeNull();
  });
  it("rechecks FULL durability after binding rather than trusting the manifest", () => {
    const { db, identity } = coordination(); db.pragma("synchronous = NORMAL");
    expect(() => assertStoreRole(db, identity)).toThrow(/FULL/);
  });
  it("refuses shared deletion tombstones rather than treating them as local request projections", () => {
    const db = store(), project = createProjectStoreIdentity(randomUUID(), "alpha");
    db.prepare("INSERT INTO request_deletion_tombstones(request_id,fingerprint,reservation_digest,retired_at,expires_at) VALUES('request','fingerprint','digest',1,2)").run();
    expect(() => initializeStoreRole(db, project)).toThrow(/shared coordination/);
    expect(readStoreIdentity(db)).toBeNull();
  });
  it.each(["pool_verifications", "fl_key_billing", "paid_spend_by_ref", "future_private_table"])("refuses an unclassified restored/extension table %s", table => {
    const db = store(), project = createProjectStoreIdentity(randomUUID(), "alpha");
    db.exec(`CREATE TABLE ${table}(id TEXT)`);
    expect(() => initializeStoreRole(db, project)).toThrow(/unclassified schema/);
    expect(readStoreIdentity(db)).toBeNull();
  });
  it("keeps qualification records in the explicitly reserved internal project only", () => {
    const db = store();
    db.prepare("INSERT INTO qualification_runs(id,endpoint_id,suite_version,status,started_at) VALUES('run','fixture','fixture','running',1)").run();
    const project = createProjectStoreIdentity(randomUUID(), "alpha");
    expect(() => initializeStoreRole(db, project)).toThrow(/internal qualification/);
    const internal = createProjectStoreIdentity(project.installationId, "_qualification");
    expect(initializeStoreRole(db, internal)).toEqual(internal);
  });
  it("rejects foreign direct-owned evidence even when the task table itself has only own tasks", () => {
    const db = store(), project = createProjectStoreIdentity(randomUUID(), "alpha"); task(db, "alpha");
    db.prepare("INSERT INTO events(task_id,ts,type,data_json,project_id) VALUES(NULL,1,'fixture','{}','beta')").run();
    expect(() => initializeStoreRole(db, project)).toThrow(/foreign or unowned project data/);
    expect(readStoreIdentity(db)).toBeNull();
  });
  it("rejects unowned tasks before creating a project manifest or touching existing rows", () => {
    const db = store(), project = createProjectStoreIdentity(randomUUID(), "alpha"); task(db, "");
    const before = db.prepare("SELECT * FROM tasks").all();
    expect(() => initializeStoreRole(db, project)).toThrow(/foreign or unowned/);
    expect(readStoreIdentity(db)).toBeNull();
    expect(db.prepare("SELECT * FROM tasks").all()).toEqual(before);
  });
  it("does not reuse prior UUID/store authority when a retired slug is recreated", () => {
    const { db, identity } = coordination(), root = directory();
    const old = createProjectStoreIdentity(identity.installationId, "facebook-mvp");
    const original = registerProjectStore(db, old, root, 10);
    expect(registerProjectStore(db, old, root, 20)).toEqual(original);
    const fresh = createProjectStoreIdentity(identity.installationId, "facebook-mvp");
    expect(fresh.projectId).not.toBe(old.projectId); expect(fresh.storeId).not.toBe(old.storeId);
    expect(() => registerProjectStore(db, fresh, root)).toThrow();
    expect(() => retireProjectStoreRegistration(db, { ...old, generation: 2 })).toThrow(/generation/);
    retireProjectStoreRegistration(db, old, 30);
    expect(registerProjectStore(db, fresh, root, 40).state).toBe("registered");
    expect(readProjectStoreRegistration(db, old.projectId)?.state).toBe("retired");
    expect(() => registerProjectStore(db, old, root)).toThrow(/replaced/);
  });
  it("refuses project-role registration, wrong installation, malformed rows and redirected identity", () => {
    const { db, identity } = coordination(), project = createProjectStoreIdentity(identity.installationId, "alpha"), root = directory();
    expect(() => registerProjectStore(db, createProjectStoreIdentity(randomUUID(), "beta"), root)).toThrow(/installation/);
    expect(() => registerProjectStore(db, project, "relative")).toThrow();
    registerProjectStore(db, project, root);
    db.prepare("UPDATE project_store_registrations SET installation_uuid=?").run(randomUUID());
    expect(() => readProjectStoreRegistration(db, project.projectId)).toThrow(/installation/);
    db.prepare("UPDATE store_identity SET manifest_json=?").run(JSON.stringify({ ...identity, generation: -1 }));
    expect(() => readStoreIdentity(db)).toThrow();
    expect(() => StoreIdentitySchema.parse({ ...identity, secret: "no" })).toThrow();
    const local = store(); initializeStoreRole(local, project);
    expect(() => registerProjectStore(local, project, root)).toThrow(/coordination/);
  });
  it("reads validated migration journals without granting migration or generation-switch authority", () => {
    const { db, identity } = coordination(), project = createProjectStoreIdentity(identity.installationId, "alpha");
    registerProjectStore(db, project, directory());
    const record = ProjectStoreMigrationSchema.parse({ migrationId: randomUUID(), installationId: identity.installationId,
      projectId: project.projectId, sourceStoreId: project.storeId, targetStoreId: randomUUID(), sourceGeneration: 1,
      targetGeneration: 2, sourceSchema: SCHEMA_VERSION, targetSchema: SCHEMA_VERSION,
      checkpointSha256: "a".repeat(64), state: "prepared", createdAt: 1, updatedAt: 1 });
    db.prepare(`INSERT INTO project_store_migrations(migration_uuid,project_uuid,installation_uuid,source_store_uuid,target_store_uuid,
      source_generation,target_generation,source_schema,target_schema,checkpoint_sha256,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(record.migrationId, record.projectId, record.installationId, record.sourceStoreId, record.targetStoreId, 1, 2,
        record.sourceSchema, record.targetSchema, record.checkpointSha256, record.state, 1, 1);
    expect(readProjectStoreMigration(db, record.migrationId)).toEqual(record);
    expect(readProjectStoreRegistration(db, project.projectId)?.generation).toBe(1);
    expect(() => db.prepare(`INSERT INTO project_store_migrations SELECT ?,project_uuid,installation_uuid,source_store_uuid,target_store_uuid,
      source_generation,target_generation,source_schema,target_schema,checkpoint_sha256,state,created_at,updated_at
      FROM project_store_migrations WHERE migration_uuid=?`).run(randomUUID(), record.migrationId)).toThrow(/UNIQUE/);
    db.prepare("UPDATE project_store_migrations SET checkpoint_sha256='invalid'").run();
    expect(() => readProjectStoreMigration(db, record.migrationId)).toThrow();
    expect(() => ProjectStoreMigrationSchema.parse({ ...record, targetGeneration: 3 })).toThrow();
  });
  it("upgrades the preceding applied schema additively without binding or changing legacy data", () => {
    const root = directory(), previous = new Database(path.join(root, DB_FILE)); databases.push(previous);
    for (const migration of MIGRATIONS.slice(0, -1)) previous.exec(migration);
    previous.pragma(`user_version = ${MIGRATIONS.length - 1}`);
    previous.prepare("INSERT INTO meta(key,value) VALUES('legacy','preserve')").run(); previous.close();
    const upgraded = openDatabase(root); databases.push(upgraded);
    expect(upgraded.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(upgraded.prepare("SELECT value FROM meta WHERE key='legacy'").get()).toEqual({ value: "preserve" });
    expect(readStoreIdentity(upgraded)).toBeNull();
    expect(upgraded.prepare("SELECT COUNT(*) AS n FROM project_store_registrations").get()).toEqual({ n: 0 });
  });
});
