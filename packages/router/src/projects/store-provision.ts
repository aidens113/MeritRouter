import Database from "better-sqlite3";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { PROJECT_SLUG_RE } from "../config/schema.js";
import { databasePath, immediate, openDatabase, type Db } from "../storage/db.js";
import { initializeStoreRole } from "../storage/store-role.js";
import { isGitRepo } from "../workspaces/git.js";
import { ensureProjectMetadataExcluded } from "../workspaces/metadata-exclusion.js";
import { isExactRepositoryRoot } from "../workspaces/repository-root.js";
import { isProjectMetadataPath } from "./metadata-policy.js";
import { ProjectRuntimeManifestSchema, projectRuntimePaths, validateRuntimeLocation, type ProjectRuntimePaths } from "./runtime-paths.js";
import {
  assertCriticalStoreDurability, createProjectStoreIdentity, ProjectStoreIdentitySchema, ProjectStoreRegistrationSchema,
  readStoreIdentity, registerProjectStore, type ProjectStoreIdentity, type ProjectStoreRegistration,
} from "./store-identity.js";

export interface ProvisionProjectStoreInput { slug: string; projectDirectory: string; installationRoots: readonly string[]; now?: number }
export interface ProvisionedProjectStore { identity: ProjectStoreIdentity; registration: ProjectStoreRegistration; paths: ProjectRuntimePaths; adopted: boolean }
/** A local store that is bound, described by its v2 manifest and Git-excluded, but not registered. */
export interface PreparedProjectStore { identity: ProjectStoreIdentity; paths: ProjectRuntimePaths; adopted: boolean }
/** Completed steps, in order. A hook that throws simulates a crash immediately after that step. */
export type ProjectStoreProvisionStep = "validated" | "excluded" | "directory" | "database" | "identity" | "manifest" | "closed" | "registered";
export interface ProjectStoreProvisionOptions {
  /** Test seam for crash injection; production callers omit it. */
  afterStep?: (step: ProjectStoreProvisionStep) => void | Promise<void>;
}

const InputSchema = z.object({
  slug: z.string().min(1).max(128).refine(value => PROJECT_SLUG_RE.test(value), "Expected a project slug"),
  projectDirectory: z.string().min(1).max(4096),
  installationRoots: z.array(z.string().min(1).max(4096).refine(value => path.isAbsolute(value) && !value.includes("\0"),
    "Installation roots must be absolute")).min(1).max(64),
  now: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict();
type Input = z.infer<typeof InputSchema>;

const FTS_SHADOW_TABLES = new Set(["brain_fts_data", "brain_fts_idx", "brain_fts_content", "brain_fts_docsize", "brain_fts_config"]);
const SQLITE_SIDECARS = ["-wal", "-journal"] as const;

function refuse(message: string): never {
  throw new Error(`Project store provisioning refused: ${message}`);
}
const comparable = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
const samePath = (a: string, b: string) => comparable(a) === comparable(b);
/** True when `child` is `parent` or lies beneath it (host case rules). */
function within(child: string, parent: string): boolean {
  const c = comparable(child), p = comparable(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}
function spellings(value: string): string[] {
  const forms = [path.resolve(value)];
  try { forms.push(realpathSync(value)); } catch { /* a missing root still compares by its resolved path */ }
  return forms;
}

function coordinationOwner(db: Db) {
  let identity;
  try { identity = readStoreIdentity(db); } catch { identity = null; }
  if (!identity || identity.role !== "coordination") refuse("the installation database is not a bound coordination store");
  assertCriticalStoreDurability(db);
  return identity;
}

function assertOutsideInstallation(projectDirectory: string, roots: readonly string[]): void {
  if (isProjectMetadataPath(projectDirectory)) refuse(`${projectDirectory} lies inside a MeritRouter metadata directory`);
  for (const root of roots) {
    for (const project of spellings(projectDirectory)) for (const installation of spellings(root)) {
      if (within(project, installation) || within(installation, project)) {
        refuse(`project directory ${projectDirectory} overlaps the installation directory ${root}; choose a project directory that neither contains nor lies inside the MeritRouter installation`);
      }
    }
  }
}

function assertRealDirectory(projectDirectory: string): void {
  let real: string;
  try { real = realpathSync(projectDirectory); } catch { refuse(`project directory ${projectDirectory} must exist`); }
  if (!samePath(real, projectDirectory)) refuse(`project directory ${projectDirectory} must be given by its real path (it resolves to ${real})`);
}

function registrations(db: Db): ProjectStoreRegistration[] {
  const rows = db.prepare(`SELECT installation_uuid AS installationId,project_uuid AS projectId,slug,store_uuid AS storeId,generation,
    project_directory AS projectDirectory,state,created_at AS createdAt,updated_at AS updatedAt,retired_at AS retiredAt
    FROM project_store_registrations`).all();
  return rows.map(row => ProjectStoreRegistrationSchema.parse(row));
}

/** Returns this identity's own registration, refusing anything another project owns. */
function ownRegistration(db: Db, identity: ProjectStoreIdentity, projectDirectory: string): ProjectStoreRegistration | null {
  let own: ProjectStoreRegistration | null = null;
  for (const row of registrations(db)) {
    if (row.projectId === identity.projectId) {
      if (row.state === "retired") refuse(`the store in ${projectDirectory} belongs to retired project ${row.projectId}; remove its .MeritRouter directory to create the project again`);
      if (row.slug !== identity.slug || !samePath(row.projectDirectory, projectDirectory) || row.storeId !== identity.storeId || row.generation !== identity.generation) {
        refuse(`project ${row.projectId} is registered as "${row.slug}" at ${row.projectDirectory} with a different store generation`);
      }
      own = row;
    } else if (row.state !== "retired" && row.slug === identity.slug) {
      refuse(`slug "${identity.slug}" is already owned by ${row.state} project ${row.projectId} at ${row.projectDirectory}`);
    } else if (row.state !== "retired" && samePath(row.projectDirectory, projectDirectory)) {
      refuse(`directory ${projectDirectory} is already owned by ${row.state} project "${row.slug}" (${row.projectId})`);
    }
  }
  return own;
}

type LocalStore = { kind: "absent" } | { kind: "unbound" } | { kind: "bound"; identity: ProjectStoreIdentity };

function assertNoUserData(db: Database.Database, file: string): void {
  const tables = z.array(z.object({ name: z.string() }).strict())
    .parse(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all());
  for (const { name } of tables) {
    if (FTS_SHADOW_TABLES.has(name)) continue;
    if (db.prepare(`SELECT 1 FROM "${name.replace(/"/g, '""')}" LIMIT 1`).get()) {
      refuse(`${file} has no store identity but already holds data (${name}); move it aside, or migrate it explicitly`);
    }
  }
}

function inspectLocalStore(paths: ProjectRuntimePaths): LocalStore {
  const file = databasePath(paths.state);
  let stat;
  try { stat = lstatSync(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (SQLITE_SIDECARS.some(suffix => existsSync(file + suffix))) refuse(`${file} is missing but its SQLite journal remains; restore the database or remove the journal`);
    return { kind: "absent" };
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) refuse(`${file} is linked or is not a regular file`);
  // Read-only preflight: a foreign store is never migrated or rebound by this operation.
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const hasIdentityTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='store_identity'").get();
    const identity = hasIdentityTable ? readStoreIdentity(db) : null;
    if (identity) {
      if (identity.role !== "project") refuse(`${file} is a ${identity.role} store, not a project store`);
      return { kind: "bound", identity };
    }
    assertNoUserData(db, file);
    return { kind: "unbound" };
  } finally {
    db.close();
  }
}

async function readManifest(paths: ProjectRuntimePaths): Promise<z.infer<typeof ProjectRuntimeManifestSchema> | null> {
  try {
    const stat = await lstat(paths.manifest);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) refuse(`${paths.manifest} is linked or is not a regular file`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let raw: unknown;
  try { raw = JSON.parse(await readFile(paths.manifest, "utf8")); } catch { raw = null; }
  const parsed = ProjectRuntimeManifestSchema.safeParse(raw);
  if (!parsed.success) refuse(`${paths.manifest} is not a valid project runtime manifest`);
  return parsed.data;
}

async function writeManifestAtomically(paths: ProjectRuntimePaths, projectId: string): Promise<void> {
  const manifest = ProjectRuntimeManifestSchema.parse({ layoutVersion: 2, projectId, jobs: [], repositories: [] });
  const temporary = `${paths.manifest}.provision.tmp`;
  const handle = await open(temporary, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, paths.manifest);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export const SELF_IGNORE = "*\n";

/**
 * Keep private metadata out of Git without ever touching a repository the project does not own.
 * A project directory that is exactly a repository root gets the Git-local exclude rule in its
 * own `.git`. Any other directory (one inside an enclosing repository, such as a home folder that
 * is a repository, or one in no repository) gets a self-ignoring `.MeritRouter/.gitignore`
 * instead: it lives inside the authorized project directory and hides the metadata from every
 * enclosing repository, whose `.git` is never written or locked.
 */
async function excludeFromGit(paths: ProjectRuntimePaths): Promise<void> {
  const projectDirectory = paths.projectDirectory;
  if (existsSync(path.join(projectDirectory, ".git"))) {
    if (!(await isGitRepo(projectDirectory)) || !(await isExactRepositoryRoot(projectDirectory))) {
      refuse(`${projectDirectory} has a .git entry but Git cannot read it as this directory's own repository, so private metadata cannot be excluded`);
    }
    await ensureProjectMetadataExcluded(projectDirectory);
    return;
  }
  if (await isExactRepositoryRoot(projectDirectory)) { await ensureProjectMetadataExcluded(projectDirectory); return; }
  await selfIgnoreMetadata(paths);
}

async function selfIgnoreMetadata(paths: ProjectRuntimePaths): Promise<void> {
  await mkdir(paths.root).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
  await validateRuntimeLocation(paths.projectDirectory, paths.root);
  const file = path.join(paths.root, ".gitignore");
  try {
    const handle = await open(file, "wx", 0o644);
    try { await handle.writeFile(SELF_IGNORE); await handle.sync(); } finally { await handle.close(); }
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = await lstat(file);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.size > 65536) refuse(`${file} must be an unlinked regular file`);
  const rules = (await readFile(file, "utf8")).split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
  // A later negation could re-include metadata; only an effective trailing `*` is accepted.
  if (rules.at(-1) !== "*") refuse(`${file} does not ignore the private metadata directory; its last rule must be "*"`);
}

/**
 * Create or adopt the local store without registering it: validation, installation-overlap
 * refusal, Git exclusion, `.MeritRouter/state`, role binding and the v2 manifest. Migration
 * passes its own `identity` (for example a chosen generation) and registers it itself.
 */
export async function prepareProjectStore(coordinationDb: Db, input: ProvisionProjectStoreInput, identity?: ProjectStoreIdentity,
  options: ProjectStoreProvisionOptions = {}): Promise<PreparedProjectStore> {
  return (await prepare(coordinationDb, InputSchema.parse(input), identity, options)).prepared;
}

async function prepare(coordinationDb: Db, parsed: Input, requested: ProjectStoreIdentity | undefined, options: ProjectStoreProvisionOptions) {
  const step = async (name: ProjectStoreProvisionStep) => { await options.afterStep?.(name); };
  const owner = coordinationOwner(coordinationDb);
  const given = requested === undefined ? undefined : ProjectStoreIdentitySchema.parse(requested);
  if (given && (given.installationId !== owner.installationId || given.slug !== parsed.slug)) refuse("the supplied identity belongs to another installation or slug");
  assertOutsideInstallation(parsed.projectDirectory, parsed.installationRoots);
  const paths = projectRuntimePaths(parsed.projectDirectory);
  assertRealDirectory(paths.projectDirectory);
  await validateRuntimeLocation(paths.projectDirectory, paths.state);

  const local = inspectLocalStore(paths);
  const manifest = await readManifest(paths);
  let identity: ProjectStoreIdentity;
  if (local.kind === "bound") {
    const found = local.identity;
    if (found.installationId !== owner.installationId) refuse(`${paths.state} holds a store of another MeritRouter installation`);
    if (found.slug !== parsed.slug) refuse(`${paths.state} holds the store of project "${found.slug}"`);
    if (given && JSON.stringify(given) !== JSON.stringify(found)) refuse(`${paths.state} holds a different store generation than the one requested`);
    identity = found;
  } else {
    if (manifest) refuse(`${paths.manifest} exists without a bound project store; remove it or restore the store`);
    identity = given ?? createProjectStoreIdentity(owner.installationId, parsed.slug);
  }
  if (manifest && (manifest.layoutVersion !== 2 || manifest.projectId !== identity.projectId)) {
    refuse(`${paths.manifest} describes another project or an older layout; explicit migration is required`);
  }
  ownRegistration(coordinationDb, identity, paths.projectDirectory);
  await step("validated");

  // Before creating anything, so private files are never visible to Git even transiently.
  await excludeFromGit(paths);
  await step("excluded");

  await mkdir(paths.state, { recursive: true });
  await validateRuntimeLocation(paths.projectDirectory, paths.state);
  await step("directory");

  const db = local.kind === "bound"
    ? openDatabase(paths.state, { durability: "full", fileMustExist: true, expectedIdentity: identity })
    : openDatabase(paths.state, { durability: "full" });
  try {
    await step("database");
    initializeStoreRole(db, identity);
    await step("identity");
    if (!manifest) await writeManifestAtomically(paths, identity.projectId);
    await step("manifest");
  } finally {
    db.close();
  }
  await step("closed");
  return { prepared: { identity, paths, adopted: local.kind === "bound" }, step };
}

/**
 * Create a project's local split store and register it as the last step. Re-running after an
 * interruption adopts the orphan store (`adopted: true`) or refuses; it never mints a second
 * identity for one directory.
 */
export async function provisionProjectStore(coordinationDb: Db, input: ProvisionProjectStoreInput,
  options: ProjectStoreProvisionOptions = {}): Promise<ProvisionedProjectStore> {
  const parsed = InputSchema.parse(input);
  const { prepared, step } = await prepare(coordinationDb, parsed, undefined, options);
  const { identity, paths } = prepared;
  const registration = immediate(coordinationDb, () => {
    const own = ownRegistration(coordinationDb, identity, paths.projectDirectory);
    if (own?.state === "migrating") refuse(`project ${own.projectId} is migrating; complete or roll back the migration first`);
    return own ?? registerProjectStore(coordinationDb, identity, paths.projectDirectory, parsed.now ?? Date.now());
  });
  await step("registered");
  return { identity, registration, paths, adopted: prepared.adopted };
}
