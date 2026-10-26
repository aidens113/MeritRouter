import { randomUUID } from "node:crypto";
import { z } from "zod";
import { PROJECT_SLUG_RE } from "../config/schema.js";
import { QUALIFICATION_PROJECT } from "../qualification/registry.js";
import { immediate, type Db } from "../storage/db.js";
import { projectRuntimePaths } from "./runtime-paths.js";

const uuid = z.uuid().refine(value => value === value.toLowerCase(), "UUID must use canonical lowercase");
const count = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const slug = z.string().min(1).max(128).refine(value => PROJECT_SLUG_RE.test(value) || value === QUALIFICATION_PROJECT);
const common = { version: z.literal(1), installationId: uuid, storeId: uuid, generation: count };
export const CoordinationStoreIdentitySchema = z.object({ ...common, role: z.literal("coordination") }).strict();
export const ProjectStoreIdentitySchema = z.object({ ...common, role: z.literal("project"), projectId: uuid, slug }).strict();
export const StoreIdentitySchema = z.discriminatedUnion("role", [CoordinationStoreIdentitySchema, ProjectStoreIdentitySchema]);
export type StoreIdentity = z.infer<typeof StoreIdentitySchema>;
export type ProjectStoreIdentity = z.infer<typeof ProjectStoreIdentitySchema>;

/** Pure identity creation; no connection, directory, registration or runtime activation. */
export function createCoordinationStoreIdentity(): z.infer<typeof CoordinationStoreIdentitySchema> {
  return CoordinationStoreIdentitySchema.parse({ version: 1, role: "coordination", installationId: randomUUID(), storeId: randomUUID(), generation: 1 });
}
export function createProjectStoreIdentity(installationId: string, projectSlug: string): ProjectStoreIdentity {
  return ProjectStoreIdentitySchema.parse({ version: 1, role: "project", installationId, projectId: randomUUID(), slug: projectSlug, storeId: randomUUID(), generation: 1 });
}
export function readStoreIdentity(db: Db): StoreIdentity | null {
  const row = z.object({ manifest_json: z.string().max(8192) }).strict().optional().parse(
    db.prepare("SELECT manifest_json FROM store_identity WHERE singleton=1").get());
  return row ? StoreIdentitySchema.parse(JSON.parse(row.manifest_json)) : null;
}
export function assertCriticalStoreDurability(db: Db): void {
  if (db.pragma("synchronous", { simple: true }) !== 2) throw new Error("Split-store critical receipts require synchronous=FULL");
}
function coordination(db: Db): z.infer<typeof CoordinationStoreIdentitySchema> {
  assertCriticalStoreDurability(db);
  const identity = readStoreIdentity(db);
  if (!identity || identity.role !== "coordination") throw new Error("Project registration requires a bound coordination store");
  return identity;
}
const directory = z.string().min(1).max(4096).transform(value => projectRuntimePaths(value).projectDirectory);
export const ProjectStoreRegistrationSchema = z.object({
  installationId: uuid, projectId: uuid, slug, storeId: uuid, generation: count,
  projectDirectory: directory, state: z.enum(["registered", "migrating", "retired"]),
  createdAt: timestamp, updatedAt: timestamp, retiredAt: timestamp.nullable(),
}).strict().refine(value => (value.state === "retired") === (value.retiredAt !== null), "Registration retirement state disagrees");
export type ProjectStoreRegistration = z.infer<typeof ProjectStoreRegistrationSchema>;
const registrationSql = `SELECT installation_uuid AS installationId,project_uuid AS projectId,slug,store_uuid AS storeId,
  generation,project_directory AS projectDirectory,state,created_at AS createdAt,updated_at AS updatedAt,retired_at AS retiredAt
  FROM project_store_registrations WHERE project_uuid=?`;
export function readProjectStoreRegistration(db: Db, projectId: string): ProjectStoreRegistration | null {
  const owner = coordination(db), row = db.prepare(registrationSql).get(uuid.parse(projectId));
  if (!row) return null;
  const registration = ProjectStoreRegistrationSchema.parse(row);
  if (registration.installationId !== owner.installationId) throw new Error("Registration belongs to another installation");
  return registration;
}
/** Registration metadata only. Does not authorize dispatch or relocate an existing store. */
export function registerProjectStore(db: Db, input: ProjectStoreIdentity, projectDirectory: string, now = Date.now()): ProjectStoreRegistration {
  const owner = coordination(db), identity = ProjectStoreIdentitySchema.parse(input);
  if (identity.installationId !== owner.installationId) throw new Error("Project identity belongs to another installation");
  const record = ProjectStoreRegistrationSchema.parse({ installationId: identity.installationId, projectId: identity.projectId,
    slug: identity.slug, storeId: identity.storeId, generation: identity.generation,
    projectDirectory, state: "registered", createdAt: now, updatedAt: now, retiredAt: null });
  return immediate(db, () => {
    const existing = readProjectStoreRegistration(db, identity.projectId);
    if (existing) {
      if (existing.state !== "registered" || existing.slug !== record.slug || existing.storeId !== record.storeId
        || existing.generation !== record.generation || existing.projectDirectory !== record.projectDirectory) throw new Error("Existing project registration cannot be replaced");
      return existing;
    }
    db.prepare(`INSERT INTO project_store_registrations(project_uuid,installation_uuid,slug,store_uuid,generation,project_directory,state,created_at,updated_at,retired_at)
      VALUES(?,?,?,?,?,?,'registered',?,?,NULL)`).run(record.projectId, record.installationId, record.slug, record.storeId, record.generation, record.projectDirectory, record.createdAt, record.updatedAt);
    return record;
  });
}
/** Future lifecycle metadata CAS, not task cancellation, payload deletion or accounting retirement. */
export function retireProjectStoreRegistration(db: Db, input: ProjectStoreIdentity, now = Date.now()): ProjectStoreRegistration {
  const identity = ProjectStoreIdentitySchema.parse(input); timestamp.parse(now);
  return immediate(db, () => {
    const record = readProjectStoreRegistration(db, identity.projectId);
    if (!record || record.installationId !== identity.installationId || record.storeId !== identity.storeId || record.generation !== identity.generation || record.slug !== identity.slug) throw new Error("Project registration generation does not match");
    if (record.state === "migrating") throw new Error("A migrating project requires explicit migration recovery");
    if (record.state !== "retired") db.prepare("UPDATE project_store_registrations SET state='retired',retired_at=?,updated_at=? WHERE project_uuid=?").run(now, now, record.projectId);
    return readProjectStoreRegistration(db, record.projectId)!;
  });
}
export const ProjectStoreMigrationSchema = z.object({
  migrationId: uuid, installationId: uuid, projectId: uuid, sourceStoreId: uuid, targetStoreId: uuid,
  sourceGeneration: count, targetGeneration: count, sourceSchema: count, targetSchema: count,
  checkpointSha256: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(["prepared", "copying", "verified", "committed", "rolled_back", "recovery_required"]),
  createdAt: timestamp, updatedAt: timestamp,
}).strict().refine(value => value.targetGeneration === value.sourceGeneration + 1 && value.sourceStoreId !== value.targetStoreId,
  "Migration must advance one generation into a different store");
export type ProjectStoreMigration = z.infer<typeof ProjectStoreMigrationSchema>;
/** Journal read boundary only; migration effects and state transitions remain unimplemented. */
export function readProjectStoreMigration(db: Db, migrationId: string): ProjectStoreMigration | null {
  const owner = coordination(db);
  const row = db.prepare(`SELECT migration_uuid AS migrationId,installation_uuid AS installationId,project_uuid AS projectId,
    source_store_uuid AS sourceStoreId,target_store_uuid AS targetStoreId,source_generation AS sourceGeneration,target_generation AS targetGeneration,
    source_schema AS sourceSchema,target_schema AS targetSchema,checkpoint_sha256 AS checkpointSha256,state,created_at AS createdAt,updated_at AS updatedAt
    FROM project_store_migrations WHERE migration_uuid=?`).get(uuid.parse(migrationId));
  if (!row) return null;
  const record = ProjectStoreMigrationSchema.parse(row);
  const registration = readProjectStoreRegistration(db, record.projectId);
  if (record.installationId !== owner.installationId || !registration) throw new Error("Migration journal belongs to an unknown owner");
  return record;
}
