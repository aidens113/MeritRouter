import { immediate, type Db } from "./db.js";
import { z } from "zod";
import { QUALIFICATION_PROJECT } from "../qualification/registry.js";
import { assertCriticalStoreDurability, readStoreIdentity, StoreIdentitySchema, type StoreIdentity } from "../projects/store-identity.js";
import { ownMergeBranchMetadata } from "./merge-branch-lock.js";

const sharedTables = ["endpoints", "endpoint_overrides", "routing_overrides", "scans", "paid_keys", "paid_spend",
  "provider_slots", "provider_key_state", "provider_usage", "web_backend_state", "request_deletion_tombstones",
  "project_store_registrations", "project_store_migrations", "physical_requests", "broker_paid_spend", "project_execution_grants", "endpoint_quarantines", "web_usage_reservations", "project_lab_ports", "project_lab_capacity"] as const;
const qualificationTables = ["qualification_runs", "qualification_results", "repository_registry", "qualification_tasks"] as const;
// Complete current logical-schema classification. New/restored tables require an explicit ownership decision.
const localTables = new Set([
  "tasks", "task_deps", "executions", "execution_members", "model_requests", "request_charges", "artifacts", "events", "workspaces", "meta",
  "classifications", "brain_access_requests", "brain_grants", "brain_files", "brain_fts", "job_state", "job_questions", "sessions", "session_events",
  "task_contracts", "verdict_records", "verification_signals", "verification_audits", "job_plans", "file_leases", "job_budget_carves", "merge_queue",
  "job_channel", "projects", "web_requests", "task_request_grants", "budget_requests", "labs", "lab_ports", "lab_services", "lab_checks", "lab_events",
  "lab_promotions", "lab_teams", "lab_operations", "lab_target_locks", "task_workspace_attempts", "lab_task_attempts", "task_lab_operations", "lab_attempt_processes",
  "request_captures", "task_lease_operation_keys", "task_lease_operations", "task_lease_operation_projects", "request_protocol_keys", "request_protocol",
  "request_protocol_projects", "worker_action_requests", "product_deliveries", "product_delivery_history", "store_identity",
  "project_request_protocol", "project_request_holds", "project_request_spend", "project_execution_claims", "project_execution_claim_members", "lab_command_owners", "lab_capacity_owners", "web_usage_protocol",
]);
const classifiedTables = new Set<string>([...localTables, ...sharedTables, ...qualificationTables]);
const brainFtsShadowTables = new Set(["brain_fts_data", "brain_fts_idx", "brain_fts_content", "brain_fts_docsize", "brain_fts_config"]);
const scopedTables = ["model_requests", "events", "brain_access_requests", "brain_grants", "job_state", "sessions", "job_plans", "web_requests",
  "budget_requests", "labs", "lab_operations", "task_workspace_attempts", "request_captures", "task_lease_operation_projects", "request_protocol_projects",
  "worker_action_requests", "product_deliveries", "product_delivery_history", "project_request_protocol", "project_request_holds", "project_request_spend", "project_execution_claims", "project_execution_claim_members", "lab_command_owners", "lab_capacity_owners", "web_usage_protocol"] as const;

function assertClassifiedSchema(db: Db): void {
  const rows = z.array(z.object({ schema: z.literal("main"), name: z.string(), type: z.enum(["table", "virtual", "shadow"]) }).passthrough())
    .parse(db.prepare("PRAGMA main.table_list").all());
  const present = new Set<string>();
  for (const row of rows) {
    if (row.name.startsWith("sqlite_")) continue;
    if (row.type === "shadow" && brainFtsShadowTables.has(row.name)) continue;
    if (!classifiedTables.has(row.name) || (row.type === "virtual") !== (row.name === "brain_fts") || row.type === "shadow") {
      throw new Error("Project store contains an unclassified schema object");
    }
    present.add(row.name);
  }
  if (present.size !== classifiedTables.size) throw new Error("Project store is missing classified schema tables");
}

function assertProjectContents(db: Db, identity: Extract<StoreIdentity, { role: "project" }>): void {
  assertClassifiedSchema(db);
  if (db.prepare("SELECT 1 FROM tasks WHERE project_id!=? OR project_id IS NULL LIMIT 1").get(identity.slug)) throw new Error("Project store contains a foreign or unowned task");
  if (db.prepare("SELECT 1 FROM projects WHERE id!=? LIMIT 1").get(identity.slug)) throw new Error("Project store contains another project registration");
  for (const table of sharedTables) if (db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) throw new Error(`Project store contains shared coordination data: ${table}`);
  if (identity.slug !== QUALIFICATION_PROJECT) {
    for (const table of qualificationTables) if (db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) throw new Error("User project store contains internal qualification data");
  }
  for (const table of scopedTables) {
    if (db.prepare(`SELECT 1 FROM ${table} WHERE project_id!=? OR project_id IS NULL LIMIT 1`).get(identity.slug)) throw new Error("Project store contains foreign or unowned project data");
  }
  if (db.prepare("SELECT 1 FROM lab_capacity_owners o LEFT JOIN labs l ON l.id=o.lab_id WHERE l.id IS NULL OR l.project_id!=o.project_id OR l.project_id!=? LIMIT 1").get(identity.slug)) throw new Error("Lab capacity owner contains a foreign Lab identity");
  if (db.prepare("SELECT 1 FROM lab_command_owners o LEFT JOIN labs l ON l.id=o.lab_id WHERE l.id IS NULL OR l.project_id!=o.project_id OR l.project_id!=? LIMIT 1").get(identity.slug)) throw new Error("Lab command owner contains a foreign Lab identity");
  if (db.prepare("SELECT 1 FROM project_execution_claims WHERE project_uuid!=? OR store_uuid!=? OR store_generation!=? LIMIT 1").get(identity.projectId,identity.storeId,identity.generation)) throw new Error("Project execution claims contain a foreign store generation");
  const metadata = z.array(z.object({ key: z.string(), value: z.string() })).parse(db.prepare("SELECT key,value FROM meta WHERE key!=?").all(`brain:index-generation:project:${identity.slug}`));
  if (metadata.some(row => !ownMergeBranchMetadata(db, identity, row.key, row.value))) throw new Error("Project store contains unclassified or shared metadata");
}
/** Checked role boundary only; does not migrate data or make existing services project-scoped. */
export function assertStoreRole(db: Db, expected: StoreIdentity): StoreIdentity {
  assertCriticalStoreDurability(db);
  const parsed = StoreIdentitySchema.parse(expected), existing = readStoreIdentity(db);
  if (!existing || JSON.stringify(existing) !== JSON.stringify(parsed)) throw new Error("Store role, owner or generation does not match expected identity");
  if (parsed.role === "project") assertProjectContents(db, parsed);
  return existing;
}
/** Explicit opt-in prerequisite: legacy openDatabase never calls this function. */
export function initializeStoreRole(db: Db, identity: StoreIdentity): StoreIdentity {
  assertCriticalStoreDurability(db);
  const parsed = StoreIdentitySchema.parse(identity);
  return immediate(db, () => {
    const existing = readStoreIdentity(db);
    if (existing) return assertStoreRole(db, parsed);
    if (parsed.role === "project") assertProjectContents(db, parsed);
    db.prepare("INSERT INTO store_identity(singleton,manifest_json) VALUES(1,?)").run(JSON.stringify(parsed));
    return assertStoreRole(db, parsed);
  });
}
