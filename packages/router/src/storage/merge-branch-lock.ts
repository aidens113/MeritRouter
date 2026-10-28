import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { Db } from "./db.js";
import { ProjectStoreIdentitySchema, type ProjectStoreIdentity } from "../projects/store-identity.js";

/** Shared only by the queue writer and project-store ownership validator. */
export const BranchOwnerSchema = z.object({
  nonce: z.string().uuid(), host: z.string().min(1), pid: z.number().int().positive(), instance: z.string().uuid(),
  owner: z.string().min(1), heartbeat: z.number().finite(), jobId: z.string(),
  leaseOwner: z.string().nullable(), runCount: z.number().int().nonnegative().nullable(),
}).strict();
export const MergeBranchBindingSchema = z.object({
  itemId: z.string().min(1), physicalOwner: z.string().refine(path.isAbsolute), branch: z.string().min(1),
  integrationWorktree: z.string().refine(path.isAbsolute), queueOwner: z.string().min(1),
  projectStore: ProjectStoreIdentitySchema.nullable(),
}).strict();
export const BoundBranchOwnerSchema = BranchOwnerSchema.extend({ binding: MergeBranchBindingSchema }).strict();
/** Old mutexes still block or require proven-dead-process takeover; they gain no split authority. */
export const QueueBranchOwnerSchema = z.union([BoundBranchOwnerSchema, BranchOwnerSchema]);
export function mergeBranchKey(physicalOwner: string, branch: string): string {
  return `merge-branch:${createHash("sha256").update(JSON.stringify([physicalOwner, branch])).digest("hex")}`;
}

/** No Git execution here: acquisition recorded the actual physical identity on the own queue item. */
export function ownMergeBranchMetadata(db: Db, identity: ProjectStoreIdentity, key: string, value: string): boolean {
  try {
    const lock = BoundBranchOwnerSchema.parse(JSON.parse(value));
    const binding = lock.binding;
    if (JSON.stringify(binding.projectStore) !== JSON.stringify(ProjectStoreIdentitySchema.parse(identity))) return false;
    if (key !== mergeBranchKey(binding.physicalOwner, binding.branch) || lock.owner !== binding.queueOwner) return false;
    const raw = db.prepare(`SELECT m.job_id,m.branch,m.integration_worktree,m.detail_json,t.project_id,t.profile
      FROM merge_queue m JOIN tasks t ON t.id=m.job_id WHERE m.id=?`).get(binding.itemId);
    const row = z.object({ job_id: z.string(), branch: z.string(), integration_worktree: z.string(), detail_json: z.string().nullable(), project_id: z.string(), profile: z.string() }).parse(raw);
    if (row.project_id !== identity.slug || row.profile !== "supervise" || row.job_id !== lock.jobId || row.branch !== binding.branch || row.integration_worktree !== binding.integrationWorktree) return false;
    const recorded = MergeBranchBindingSchema.parse(JSON.parse(row.detail_json ?? "{}").mergeBranchBinding);
    return JSON.stringify(recorded) === JSON.stringify(binding);
  } catch { return false; }
}
