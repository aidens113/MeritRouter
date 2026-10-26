import { assertStoreRole } from "../storage/store-role.js";
import { readStoreIdentity,type ProjectStoreIdentity } from "../projects/store-identity.js";
import { z } from "zod";
import { loadConfig, type ResolvedConfig } from "../config/load.js";
import { ProfileNameSchema } from "../config/schema.js";
import type { Db } from "../storage/db.js";
import { LeaseRefSchema, type LeaseRef } from "../storage/lease-ref.js";

const pinnedProjects=new WeakMap<Db,ProjectStoreIdentity>();
/** Legacy stores remain explicit; bound coordination stores can never host private tool authority. */
export function projectToolIdentity(db:Db,project?:string):ProjectStoreIdentity|null {
 const actual=readStoreIdentity(db);if(!actual)return null;
 if(actual.role!=="project")throw new Error("Private task tools require a project store, not coordination");
 const pinned=pinnedProjects.get(db)??actual;if(!pinnedProjects.has(db))pinnedProjects.set(db,pinned);
 assertStoreRole(db,pinned);if(project!==undefined&&project!==pinned.slug)throw new Error("Project tool scope differs from pinned store identity");return pinned;
}

/** Supervisor privilege comes from the persisted live task and trusted current profile configuration. */
export function currentSupervisorAuthority(db: Db, cfg: ResolvedConfig, authority: LeaseRef, now = Date.now()): boolean {
  const lease = LeaseRefSchema.parse(authority);
  projectToolIdentity(db,cfg.brain.project);
  if(lease.project!==cfg.brain.project&&readStoreIdentity(db)?.role==="project")return false;
  const found = db.prepare(`SELECT profile,spec_json FROM tasks WHERE id=? AND project_id=?
    AND state='running' AND cancel_requested=0 AND lease_owner=? AND run_count=? AND lease_incarnation=?
    AND lease_expires_at>? AND (deadline_at IS NULL OR deadline_at>?)`)
    .get(lease.taskId, lease.project, lease.owner, lease.runCount, lease.incarnation, now, now);
  if (!found) return false;
  const row = z.object({ profile: ProfileNameSchema, spec_json: z.string() }).parse(found);
  const spec = z.object({ profile: ProfileNameSchema }).parse(JSON.parse(row.spec_json));
  return row.profile === spec.profile && loadConfig(cfg.configPath).profiles[row.profile]?.mode === "supervisor";
}
