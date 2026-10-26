import { assertStoreRole } from "../storage/store-role.js";
import { ProjectStoreIdentitySchema, type ProjectStoreIdentity } from "./store-identity.js";
import { z } from "zod";
import { PROJECT_SLUG_RE } from "../config/schema.js";
import type { ResolvedConfig } from "../config/load.js";
import type { Db } from "../storage/db.js";
import type { StoredTask, TaskStore } from "../storage/tasks.js";
import type { SessionStore } from "../sessions/store.js";
import type { ArtifactStore } from "../storage/artifacts.js";
import type { ContractStore } from "../verification/contract.js";
import { QUALIFICATION_PROJECT } from "../qualification/registry.js";

const projectIdentity = z.string().refine(value => PROJECT_SLUG_RE.test(value) || value === QUALIFICATION_PROJECT,
  "Expected a configured project identity");

/** Transitional same-database handle. Identity is explicit; these stores are NOT isolated yet. */
export interface ProjectRuntimeStore {
  readonly project: string;
  readonly identity?: ProjectStoreIdentity;
  readonly db: Db;
  readonly tasks: TaskStore;
  readonly sessions: SessionStore | null;
  readonly artifacts: ArtifactStore;
  readonly contracts: ContractStore;
}

/** Existing trusted store references only: no constructors, paths, transactions or filesystem writes. */
export function createProjectRuntimeStore(project: string, stores: Omit<ProjectRuntimeStore, "project">): ProjectRuntimeStore {
  return Object.freeze({ ...stores, project: projectIdentity.parse(project) });
}

/** Explicit isolated handle: construction validates actual local role and immutable identity. */
export function createSplitProjectRuntimeStore(identity:ProjectStoreIdentity,stores:Omit<ProjectRuntimeStore,"project"|"identity">):ProjectRuntimeStore & {readonly identity:ProjectStoreIdentity}{
  const pinned=ProjectStoreIdentitySchema.parse(identity);assertStoreRole(stores.db,pinned);
  if(stores.tasks.db!==stores.db)throw new Error("Split runtime task store uses another database");
  return Object.freeze({...stores,project:pinned.slug,identity:Object.freeze(pinned)});
}

/** Validate context and persisted task ownership before selecting a project store handle. */
export function projectStoresForTask(stores: ProjectRuntimeStore, task: StoredTask, cfg: ResolvedConfig): ProjectRuntimeStore {
  const project = projectIdentity.parse(stores.project);
  const configured = projectIdentity.parse(cfg.brain.project);
  const context = cfg as ResolvedConfig & { project?: { slug?: unknown } };
  if (context.project !== undefined && projectIdentity.parse(context.project.slug) !== configured) {
    throw new Error("Project context identity disagrees with its brain scope");
  }
  const taskProject = z.string().parse(task.row.project_id);
  if(stores.identity){assertStoreRole(stores.db,stores.identity);if(taskProject!==stores.identity.slug||configured!==stores.identity.slug)throw new Error("Split runtime requires exact explicit task project identity");}
  if ((taskProject || configured) !== project || configured !== project) {
    throw new Error("Project runtime store identity disagrees with task or context");
  }
  if(stores.identity){const current=stores.tasks.get(task.row.id);if(!current||current.row.lease_incarnation!==task.row.lease_incarnation||current.row.run_count!==task.row.run_count||current.row.lease_owner!==task.row.lease_owner)throw new Error("Split runtime task incarnation or run binding changed");}
  if (stores.tasks.projectOf(task.row.id) !== taskProject) {
    throw new Error("Project runtime store cannot resolve the current stored task owner");
  }
  return stores;
}
