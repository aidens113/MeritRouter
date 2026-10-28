import { existsSync } from "node:fs";
import path from "node:path";
import type { ResolvedConfig } from "../config/load.js";
import { databasePath, immediate, openDatabase, type Db } from "../storage/db.js";
import { initializeStoreRole } from "../storage/store-role.js";
import {
  assertCriticalStoreDurability, createProjectStoreIdentity, readStoreIdentity, registerProjectStore,
  type ProjectStoreIdentity,
} from "../projects/store-identity.js";
import { projectRuntimePaths, type ProjectRuntimePaths } from "../projects/runtime-paths.js";
import { QUALIFICATION_PROJECT } from "./registry.js";

function refuse(message: string): never {
  throw new Error(`Qualification store provisioning refused: ${message}`);
}

const samePath = (a: string, b: string) =>
  process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);

/**
 * Where the installation keeps the qualification project's own store: inside its own storage
 * directory, never a user's. This is the one place a project store legitimately lives inside the
 * installation root, so provisioning it bypasses `provisionProjectStore`'s overlap refusal
 * entirely (see `ensureQualificationStore`) rather than weakening that refusal for real projects.
 */
export function qualificationStoreDirectory(cfg: Pick<ResolvedConfig, "storageDir">): string {
  return path.join(cfg.storageDir, "qualification");
}

function coordinationOwner(db: Db) {
  let identity;
  try {
    identity = readStoreIdentity(db);
  } catch {
    identity = null;
  }
  if (!identity || identity.role !== "coordination") refuse("the installation database is not a bound coordination store");
  assertCriticalStoreDurability(db);
  return identity;
}

interface RegistrationRow {
  projectId: string;
  storeId: string;
  generation: number;
  projectDirectory: string;
  state: "registered" | "migrating" | "retired";
}

function registrationBySlug(db: Db, slug: string): RegistrationRow | null {
  const row = db
    .prepare(
      `SELECT project_uuid AS projectId, store_uuid AS storeId, generation, project_directory AS projectDirectory, state
         FROM project_store_registrations WHERE slug = ?`,
    )
    .get(slug) as RegistrationRow | undefined;
  return row ?? null;
}

/**
 * Create (once) or adopt the installation-owned qualification store at
 * `<storageDir>/qualification/.MeritRouter`, and register it exactly like a split project's store
 * (same identity shape, same `project_store_registrations` row), so the generic
 * `ProjectRuntimeHost`/`ProjectScheduler` machinery opens and dispatches it like any other project.
 * Synchronous and idempotent: safe to call before every qualification or comparison submission.
 * Not a general-purpose provisioning path — it never validates a caller-supplied directory and
 * must only ever be called with the fixed qualification directory above.
 */
export function ensureQualificationStore(
  coordinationDb: Db,
  cfg: Pick<ResolvedConfig, "storageDir">,
  now = Date.now(),
): { identity: ProjectStoreIdentity; paths: ProjectRuntimePaths } {
  const owner = coordinationOwner(coordinationDb);
  const paths = projectRuntimePaths(qualificationStoreDirectory(cfg));

  const existing = registrationBySlug(coordinationDb, QUALIFICATION_PROJECT);
  if (existing) {
    if (existing.state === "retired") refuse("the qualification store was retired; restart this installation after removing its .MeritRouter directory");
    if (!samePath(existing.projectDirectory, paths.projectDirectory)) {
      refuse(`the qualification store is registered at ${existing.projectDirectory}, not ${paths.projectDirectory}`);
    }
    const identity: ProjectStoreIdentity = {
      version: 1, role: "project", installationId: owner.installationId, projectId: existing.projectId,
      storeId: existing.storeId, generation: existing.generation, slug: QUALIFICATION_PROJECT,
    };
    return { identity, paths };
  }

  const file = databasePath(paths.state);
  let identity: ProjectStoreIdentity;
  if (existsSync(file)) {
    // Adopt an orphan store left by an interrupted provision (a crash between the two steps below).
    const probe = openDatabase(paths.state, { durability: "full", fileMustExist: true });
    try {
      const found = readStoreIdentity(probe);
      if (!found || found.role !== "project" || found.slug !== QUALIFICATION_PROJECT || found.installationId !== owner.installationId) {
        refuse(`${file} already holds a store that is not this installation's qualification store`);
      }
      identity = found;
    } finally {
      probe.close();
    }
  } else {
    identity = createProjectStoreIdentity(owner.installationId, QUALIFICATION_PROJECT);
    const db = openDatabase(paths.state, { durability: "full" });
    try {
      initializeStoreRole(db, identity);
    } finally {
      db.close();
    }
  }

  immediate(coordinationDb, () => {
    if (!registrationBySlug(coordinationDb, QUALIFICATION_PROJECT)) registerProjectStore(coordinationDb, identity, paths.projectDirectory, now);
  });
  return { identity, paths };
}
