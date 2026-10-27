import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { PROJECT_SLUG_RE } from "../config/schema.js";
import { immediate, type Db } from "../storage/db.js";

/**
 * Export of one project's rows from a legacy multi-project store into its bound project store.
 * Row ownership is declared per table below; anything the legacy schema holds that is neither
 * exported nor explicitly skipped is reported as unclassified, so a new table can never be
 * dropped silently.
 */

const T = "SELECT id FROM tasks WHERE project_id=@slug";
const S = "SELECT id FROM sessions WHERE project_id=@slug";
const L = "SELECT id FROM labs WHERE project_id=@slug";
const A = "SELECT id FROM task_workspace_attempts WHERE project_id=@slug";
const OWNED = "project_id=@slug";
const BY_TASK = `task_id IN (${T})`;
const BY_LAB = `lab_id IN (${L})`;
const BY_ATTEMPT = `attempt_id IN (${A})`;
const LEASE_OPS = "SELECT operation_id FROM task_lease_operation_projects WHERE project_id=@slug";
const PROTOCOL = "SELECT request_id FROM request_protocol_projects WHERE project_id=@slug";

/** Table -> SQL predicate selecting the project's rows (named parameter `@slug`). */
export const PROJECT_EXPORT_TABLES: Readonly<Record<string, string>> = Object.freeze({
  projects: "id=@slug",
  tasks: OWNED,
  task_deps: BY_TASK,
  executions: `id IN (SELECT execution_id FROM execution_members WHERE ${BY_TASK}) OR id IN (SELECT execution_id FROM model_requests WHERE ${OWNED})`,
  execution_members: BY_TASK,
  model_requests: OWNED,
  request_charges: BY_TASK,
  artifacts: BY_TASK,
  events: OWNED,
  workspaces: BY_TASK,
  brain_access_requests: OWNED,
  brain_grants: OWNED,
  job_state: OWNED,
  job_questions: BY_TASK,
  sessions: OWNED,
  session_events: `session_id IN (${S})`,
  task_contracts: BY_TASK,
  verdict_records: BY_TASK,
  verification_signals: BY_TASK,
  verification_audits: BY_TASK,
  job_plans: OWNED,
  file_leases: BY_TASK,
  job_budget_carves: `child_task_id IN (${T})`,
  merge_queue: BY_TASK,
  job_channel: `job_id IN (${T})`,
  web_requests: OWNED,
  task_request_grants: BY_TASK,
  budget_requests: OWNED,
  labs: OWNED,
  lab_ports: BY_LAB,
  lab_services: BY_LAB,
  lab_checks: BY_LAB,
  lab_events: BY_LAB,
  lab_promotions: BY_LAB,
  lab_teams: BY_LAB,
  lab_operations: OWNED,
  task_workspace_attempts: OWNED,
  lab_task_attempts: BY_ATTEMPT,
  task_lab_operations: BY_ATTEMPT,
  lab_attempt_processes: BY_ATTEMPT,
  request_captures: OWNED,
  task_lease_operation_keys: `id IN (${LEASE_OPS})`,
  task_lease_operations: `id IN (${LEASE_OPS})`,
  task_lease_operation_projects: OWNED,
  request_protocol_keys: `id IN (${PROTOCOL})`,
  request_protocol: `request_id IN (${PROTOCOL})`,
  request_protocol_projects: OWNED,
  worker_action_requests: OWNED,
  product_deliveries: OWNED,
  product_delivery_history: OWNED,
  project_request_protocol: OWNED,
  project_request_holds: OWNED,
  project_request_spend: OWNED,
  lab_command_owners: OWNED,
  lab_capacity_owners: OWNED,
  web_usage_protocol: OWNED,
});

const COORDINATION = "coordination-owned shared accounting or registry state; stays in the coordination store";
const QUALIFICATION = "internal qualification data; never part of a user project store";
/** Tables deliberately not exported, with the reason. */
export const PROJECT_EXPORT_SKIPPED: Readonly<Record<string, string>> = Object.freeze({
  store_identity: "each store binds its own identity",
  meta: "brain index generation markers; regenerated with the project brain index",
  classifications: "content-addressed classifier cache shared by all projects; regenerated on demand",
  brain_files: "brain search index; rebuilt from the project's brain files",
  brain_fts: "brain search index; rebuilt from the project's brain files",
  lab_target_locks: "installation-wide target lock leases keyed by repository, not project rows",
  project_execution_claims: "split-store execution authority bound to a store generation; unresolved claims block migration, terminal ones stay in the legacy store",
  project_execution_claim_members: "members of split-store execution claims (see project_execution_claims)",
  ...Object.fromEntries(["endpoints", "endpoint_overrides", "routing_overrides", "scans", "paid_keys", "paid_spend", "provider_slots",
    "provider_key_state", "provider_usage", "web_backend_state", "request_deletion_tombstones", "project_store_registrations",
    "project_store_migrations", "physical_requests", "broker_paid_spend", "project_execution_grants", "endpoint_quarantines",
    "web_usage_reservations", "project_lab_ports", "project_lab_capacity"].map(name => [name, COORDINATION])),
  ...Object.fromEntries(["qualification_runs", "qualification_results", "repository_registry", "qualification_tasks"].map(name => [name, QUALIFICATION])),
});
const FTS_SHADOW = /^brain_fts_(data|idx|content|docsize|config)$/;

const SlugSchema = z.string().min(1).max(128).refine(value => PROJECT_SLUG_RE.test(value), "Expected a project slug");
const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

export interface TableDigest { table: string; rows: number; sha256: string }
/** A payload file a row points at; `path` is canonical and relative to the project runtime root. */
export interface FileDigest { kind: "artifact" | "session"; id: string; path: string; bytes: number; sha256: string }
export interface ProjectExportManifest { format: 1; slug: string; tables: TableDigest[]; files?: FileDigest[] }
export interface ExportClosureViolation { table: string; column: string; parent: string; rows: number; reason: string }

function schemaTables(db: Db): string[] {
  return z.array(z.object({ name: z.string() }).strict())
    .parse(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all())
    .map(row => row.name);
}
/** Tables present in `db` that this module neither exports nor skips. */
export function unclassifiedExportTables(db: Db): string[] {
  return schemaTables(db).filter(name => !(name in PROJECT_EXPORT_TABLES) && !(name in PROJECT_EXPORT_SKIPPED) && !FTS_SHADOW.test(name));
}
/** Export tables that `db` lacks (an older or foreign schema). */
export function missingExportTables(db: Db): string[] {
  const present = new Set(schemaTables(db));
  return Object.keys(PROJECT_EXPORT_TABLES).filter(name => !present.has(name)).sort();
}

const ColumnSchema = z.object({ name: z.string(), pk: z.number().int() }).passthrough();
function columnsOf(db: Db, table: string): { columns: string[]; keys: string[] } {
  const rows = z.array(ColumnSchema).parse(db.prepare("SELECT * FROM pragma_table_info(?)").all(table));
  if (rows.length === 0) throw new Error(`Table ${table} is missing`);
  const columns = rows.map(row => row.name).sort();
  const keys = rows.filter(row => row.pk > 0).sort((a, b) => a.pk - b.pk).map(row => row.name);
  return { columns, keys: keys.length ? keys : columns };
}

const ForeignKeySchema = z.object({ id: z.number().int(), seq: z.number().int(), table: z.string(), from: z.string(), to: z.string().nullable() }).passthrough();
function foreignKeys(db: Db, table: string): Array<{ parent: string; from: string[]; to: Array<string | null> }> {
  const rows = z.array(ForeignKeySchema).parse(db.prepare("SELECT * FROM pragma_foreign_key_list(?)").all(table));
  const byId = new Map<number, { parent: string; from: string[]; to: Array<string | null> }>();
  for (const row of rows.sort((a, b) => a.id - b.id || a.seq - b.seq)) {
    const entry = byId.get(row.id) ?? { parent: row.table, from: [], to: [] };
    entry.from.push(row.from); entry.to.push(row.to); byId.set(row.id, entry);
  }
  return [...byId.values()];
}

/** Export tables ordered so every foreign-key parent precedes its children (ties by name). */
export function projectExportOrder(db: Db): string[] {
  const tables = Object.keys(PROJECT_EXPORT_TABLES).sort();
  const parents = new Map(tables.map(table => [table, new Set(foreignKeys(db, table).map(fk => fk.parent)
    .filter(parent => parent !== table && parent in PROJECT_EXPORT_TABLES))]));
  const order: string[] = [];
  const placed = new Set<string>();
  while (order.length < tables.length) {
    const next = tables.find(table => !placed.has(table) && [...parents.get(table)!].every(parent => placed.has(parent)));
    if (!next) throw new Error("Project export tables have a foreign-key cycle");
    order.push(next); placed.add(next);
  }
  return order;
}

/** Every exported row's foreign keys must point at rows the same export carries. */
export function projectExportClosureViolations(db: Db, slug: string): ExportClosureViolation[] {
  const params = { slug: SlugSchema.parse(slug) };
  const violations: ExportClosureViolation[] = [];
  for (const table of Object.keys(PROJECT_EXPORT_TABLES).sort()) {
    for (const fk of foreignKeys(db, table)) {
      const where = PROJECT_EXPORT_TABLES[table]!;
      if (fk.from.length !== 1) {
        violations.push({ table, column: fk.from.join(","), parent: fk.parent, rows: 0, reason: "composite foreign keys are not supported by the export" });
        continue;
      }
      const from = fk.from[0]!;
      const pending = z.object({ n: z.number() }).parse(db.prepare(`SELECT COUNT(*) n FROM ${quote(table)} WHERE (${where}) AND ${quote(from)} IS NOT NULL`).get(params)).n;
      if (pending === 0) continue;
      const parentWhere = PROJECT_EXPORT_TABLES[fk.parent];
      if (parentWhere === undefined) {
        violations.push({ table, column: from, parent: fk.parent, rows: pending, reason: "references a table the export does not carry" });
        continue;
      }
      const to = fk.to[0] ?? columnsOf(db, fk.parent).keys[0]!;
      const orphans = z.object({ n: z.number() }).parse(db.prepare(`SELECT COUNT(*) n FROM ${quote(table)} WHERE (${where}) AND ${quote(from)} IS NOT NULL
        AND ${quote(from)} NOT IN (SELECT ${quote(to)} FROM ${quote(fk.parent)} WHERE (${parentWhere}) AND ${quote(to)} IS NOT NULL)`).get(params)).n;
      if (orphans > 0) violations.push({ table, column: from, parent: fk.parent, rows: orphans, reason: "references rows owned by another project or by none" });
    }
  }
  return violations;
}

/** Exact, storage-class-preserving encoding (read with safeIntegers). */
function encodeValue(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === "bigint") return `i:${value.toString()}`;
  if (typeof value === "number") { const bytes = Buffer.alloc(8); bytes.writeDoubleBE(value); return `r:${bytes.toString("hex")}`; }
  if (typeof value === "string") return `t:${value}`;
  if (Buffer.isBuffer(value)) return `b:${value.toString("base64")}`;
  throw new Error("Unsupported SQLite value in export");
}

export const canonicalSessionLog = (id: string) => `sessions/${id}.jsonl`;
/**
 * The export projection of a legacy row. The split runtime resolves a session log only at
 * `<runtime root>/sessions/<id>.jsonl` and requires `log_path` to say exactly that, so the
 * pointer is canonicalised (a no-op for rows already in that form, such as every row the
 * current SessionStore writes). The payload file itself is copied separately.
 */
const ROW_TRANSFORMS: Readonly<Record<string, (columns: string[]) => ((row: unknown[]) => unknown[])>> = {
  sessions: columns => {
    const id = columns.indexOf("id"), log = columns.indexOf("log_path");
    return row => { const next = [...row]; next[log] = canonicalSessionLog(String(row[id])); return next; };
  },
};

function selectRows(db: Db, table: string, scope: "project" | "store", slug: string) {
  const { columns, keys } = columnsOf(db, table);
  const where = scope === "project" ? ` WHERE (${PROJECT_EXPORT_TABLES[table]!})` : "";
  const statement = db.prepare(`SELECT ${columns.map(quote).join(",")} FROM ${quote(table)}${where} ORDER BY ${keys.map(quote).join(",")}`);
  statement.safeIntegers(true); statement.raw(true);
  const raw = (scope === "project" ? statement.iterate({ slug }) : statement.iterate()) as IterableIterator<unknown[]>;
  const transform = scope === "project" ? ROW_TRANSFORMS[table]?.(columns) : undefined;
  const rows = transform ? (function* () { for (const row of raw) yield transform(row); })() : raw;
  return { columns, rows };
}

class TableHasher {
  private readonly hash = createHash("sha256");
  rows = 0;
  constructor(columns: string[]) { this.hash.update(`${JSON.stringify(columns)}\n`); }
  add(row: unknown[]): void { this.hash.update(`${JSON.stringify(row.map(encodeValue))}\n`); this.rows++; }
  digest(table: string): TableDigest { return { table, rows: this.rows, sha256: this.hash.digest("hex") }; }
}

/**
 * Per-table counts and digests in export order. `project` digests the project's rows of a
 * legacy store; `store` digests whole tables of a project store, so extra rows also differ.
 */
export function projectExportManifest(db: Db, slug: string, scope: "project" | "store"): ProjectExportManifest {
  const parsed = SlugSchema.parse(slug);
  const read = () => projectExportOrder(db).map(table => {
    const { columns, rows } = selectRows(db, table, scope, parsed);
    const hasher = new TableHasher(columns);
    for (const row of rows) hasher.add(row);
    return hasher.digest(table);
  });
  // One read transaction gives one consistent snapshot across tables.
  return { format: 1, slug: parsed, tables: db.inTransaction ? read() : db.transaction(read)() };
}

export function projectExportManifestSha256(manifest: ProjectExportManifest): string {
  const canonical = { format: manifest.format, slug: manifest.slug, tables: manifest.tables.map(t => ({ table: t.table, rows: t.rows, sha256: t.sha256 })),
    files: (manifest.files ?? []).map(f => ({ kind: f.kind, id: f.id, path: f.path, bytes: f.bytes, sha256: f.sha256 })) };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** Files whose presence, size or digest differ between two manifests. */
export function differingExportFiles(expected: ProjectExportManifest, actual: ProjectExportManifest): string[] {
  const key = (f: FileDigest) => `${f.path}:${f.bytes}:${f.sha256}`;
  const a = new Set((expected.files ?? []).map(key)), b = new Set((actual.files ?? []).map(key));
  return [...new Set([...(expected.files ?? []).filter(f => !b.has(key(f))), ...(actual.files ?? []).filter(f => !a.has(key(f)))].map(f => f.path))].sort();
}

/** Tables whose count or digest differ between two manifests. */
export function differingExportTables(expected: ProjectExportManifest, actual: ProjectExportManifest): string[] {
  const other = new Map(actual.tables.map(t => [t.table, t]));
  const names = new Set([...expected.tables.map(t => t.table), ...actual.tables.map(t => t.table)]);
  return [...names].filter(name => {
    const a = expected.tables.find(t => t.table === name), b = other.get(name);
    return !a || !b || a.rows !== b.rows || a.sha256 !== b.sha256;
  }).sort();
}

export interface ProjectExportHooks {
  /** Test seam: runs inside the target transaction after each table; throwing aborts the whole copy. */
  afterTable?: (table: string) => void;
}

/**
 * Copy the project's rows from `source` into the empty, bound project store `target` in one
 * IMMEDIATE transaction, in foreign-key order. Triggers are dropped and recreated verbatim
 * inside the transaction so derived rows (for example delivery history) are copied, not
 * regenerated. Returns the digests of what was read from `source`.
 */
export function exportProjectRows(source: Db, target: Db, slug: string, hooks: ProjectExportHooks = {}): ProjectExportManifest {
  const parsed = SlugSchema.parse(slug);
  const order = projectExportOrder(target);
  const sourceOrder = projectExportOrder(source);
  if (JSON.stringify(order) !== JSON.stringify(sourceOrder)) throw new Error("Source and target export schemas differ");
  const copy = () => immediate(target, () => {
    for (const table of order) {
      if (target.prepare(`SELECT 1 FROM ${quote(table)} LIMIT 1`).get()) throw new Error(`Target project store is not empty (${table})`);
    }
    const TriggerSchema = z.array(z.object({ name: z.string(), sql: z.string() }).strict());
    const triggers = TriggerSchema.parse(target.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all());
    for (const trigger of triggers) target.exec(`DROP TRIGGER ${quote(trigger.name)}`);
    const tables: TableDigest[] = [];
    for (const table of order) {
      const { columns, rows } = selectRows(source, table, "project", parsed);
      const targetColumns = columnsOf(target, table).columns;
      if (JSON.stringify(columns) !== JSON.stringify(targetColumns)) throw new Error(`Source and target columns differ for ${table}`);
      const insert = target.prepare(`INSERT INTO ${quote(table)}(${columns.map(quote).join(",")}) VALUES(${columns.map(() => "?").join(",")})`);
      const hasher = new TableHasher(columns);
      for (const row of rows) { insert.run(...row); hasher.add(row); }
      tables.push(hasher.digest(table));
      hooks.afterTable?.(table);
    }
    for (const trigger of triggers) target.exec(trigger.sql);
    const restored = TriggerSchema.parse(target.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all());
    if (JSON.stringify(restored) !== JSON.stringify(triggers)) throw new Error("Target triggers were not restored verbatim");
    if ((target.pragma("foreign_key_check") as unknown[]).length > 0) throw new Error("Exported rows violate a foreign key in the target store");
    return { format: 1 as const, slug: parsed, tables };
  });
  // The source is read inside one transaction, so the copy is one consistent snapshot.
  return source.inTransaction ? copy() : source.transaction(copy)();
}

// ---------------------------------------------------------------------------------------------
// Payload files: session logs and artifact files the exported rows point at.

export interface ProjectFileEntry extends FileDigest { source: string }
export interface ProjectFileProblem { code: "file_missing" | "file_outside_storage" | "file_path_invalid" | "artifact_digest_mismatch"; ref: string }
export type ProjectFileLocation = { legacyStorageDir: string } | { runtimeRoot: string };

/** Same component rule as ProjectEvidenceScope, which guards every split-store evidence path. */
const segmentOk = (value: string) => value.length >= 1 && value.length <= 256 && value !== "." && value !== ".." && !/[\\/:\0]/.test(value);
const comparable = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
function inside(child: string, parent: string): boolean {
  const c = comparable(child), p = comparable(parent);
  return c !== p && c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/** sha256 and size of a regular file (never through a symbolic link); null when absent or not a plain file. */
export function fileSha256(file: string): { bytes: number; sha256: string } | null {
  let stat;
  try { stat = lstatSync(file); } catch { return null; }
  if (stat.isSymbolicLink() || !stat.isFile()) return null;
  const hash = createHash("sha256"), buffer = Buffer.alloc(1 << 20), fd = openSync(file, "r");
  let bytes = 0;
  try {
    for (let n = readSync(fd, buffer, 0, buffer.length, null); n > 0; n = readSync(fd, buffer, 0, buffer.length, null)) { hash.update(buffer.subarray(0, n)); bytes += n; }
  } finally { closeSync(fd); }
  return { bytes, sha256: hash.digest("hex") };
}

/**
 * Locate and digest the payload files of session and artifact rows. With `legacyStorageDir` the
 * rows are the project's rows of a legacy store and files resolve as the legacy SessionStore and
 * ArtifactStore resolve them (`path.resolve(storageDir, log_path)`, `storageDir/artifacts/<rel_path>`);
 * with `runtimeRoot` the rows are every row of a project store and files resolve under
 * `<project>/.MeritRouter`, as the split runtime does.
 */
export function inspectProjectFiles(db: Db, slug: string, location: ProjectFileLocation): { files: ProjectFileEntry[]; problems: ProjectFileProblem[] } {
  const params = { slug: SlugSchema.parse(slug) };
  const legacy = "legacyStorageDir" in location;
  const base = path.resolve(legacy ? location.legacyStorageDir : location.runtimeRoot);
  const scoped = (table: string) => legacy ? ` WHERE (${PROJECT_EXPORT_TABLES[table]!})` : "";
  const run = (sql: string) => legacy ? db.prepare(sql).all(params) : db.prepare(sql).all();
  const sessions = z.array(z.object({ id: z.string(), log_path: z.string() }).strict()).parse(run(`SELECT id,log_path FROM sessions${scoped("sessions")} ORDER BY id`));
  const artifacts = z.array(z.object({ id: z.string(), rel_path: z.string(), sha256: z.string(), bytes: z.number() }).strict())
    .parse(run(`SELECT id,rel_path,sha256,bytes FROM artifacts${scoped("artifacts")} ORDER BY id`));
  const files: ProjectFileEntry[] = [], problems: ProjectFileProblem[] = [];
  for (const row of sessions) {
    const ref = `session ${row.id}: ${row.log_path}`;
    if (!segmentOk(`${row.id}.jsonl`)) { problems.push({ code: "file_path_invalid", ref }); continue; }
    const source = path.resolve(base, row.log_path);
    if (legacy ? !inside(source, base) : comparable(source) !== comparable(path.join(base, "sessions", `${row.id}.jsonl`))) {
      problems.push({ code: legacy ? "file_outside_storage" : "file_path_invalid", ref }); continue;
    }
    const digest = fileSha256(source);
    if (!digest) { problems.push({ code: "file_missing", ref: `${ref} (${source})` }); continue; }
    files.push({ kind: "session", id: row.id, path: canonicalSessionLog(row.id), source, ...digest });
  }
  for (const row of artifacts) {
    const ref = `artifact ${row.id}: ${row.rel_path}`;
    const segments = row.rel_path.split("/");
    if (!segments.every(segmentOk)) {
      problems.push({ code: path.isAbsolute(row.rel_path) || segments.includes("..") ? "file_outside_storage" : "file_path_invalid", ref }); continue;
    }
    const source = path.join(base, "artifacts", ...segments);
    const digest = fileSha256(source);
    if (!digest) { problems.push({ code: "file_missing", ref: `${ref} (${source})` }); continue; }
    if (digest.sha256 !== row.sha256 || digest.bytes !== row.bytes) { problems.push({ code: "artifact_digest_mismatch", ref }); continue; }
    files.push({ kind: "artifact", id: row.id, path: `artifacts/${row.rel_path}`, source, ...digest });
  }
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { files, problems };
}

export const fileDigests = (files: readonly ProjectFileEntry[]): FileDigest[] =>
  files.map(({ kind, id, path: file, bytes, sha256 }) => ({ kind, id, path: file, bytes, sha256 }));
