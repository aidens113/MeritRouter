import { z } from "zod";
import type { Db } from "../storage/db.js";
import type { ResolvedConfig } from "../config/load.js";
import { WorkerActionRequests } from "../harness/worker-actions.js";
import type { MeritRouter } from "../core/service.js";

/**
 * Where a project's worker actions live and the configuration they are decided under: the
 * project's own store (`worker_action_requests` is project-private) and, in a split installation,
 * the project's own context (its store is pinned to that project's identity). A legacy
 * installation keeps the installation database and configuration.
 */
export function workerActionScope(sy: MeritRouter, project: string): { db: Db; config: ResolvedConfig } {
  return { db: sy.projectStores(project).db, config: sy.layout === "split" ? sy.projectContext(project) : sy.cfg };
}

/** Trusted operator surface. Never expose this as a worker tool or accept actor identity from HTTP bodies. */
export function listWorkerActions(db: Db, input: { project: string; jobId?: string; taskId?: string; status?: string }) {
  const query = z.object({ project: z.string(), jobId: z.string().optional(), taskId: z.string().optional(), status: z.string().optional() }).strict().parse(input);
  return new WorkerActionRequests(db).list(query);
}
export function getWorkerAction(db: Db, input: { project: string; id: string }) {
  const value = z.object({ project: z.string(), id: z.string().min(1) }).strict().parse(input);
  return new WorkerActionRequests(db).get(value.project, value.id);
}
export async function decideWorkerAction(db: Db, config: ResolvedConfig, input: { project: string; id: string; decision: "approve" | "deny"; reason: string; response?: string }, signal?: AbortSignal) {
  const value = z.object({ project: z.string(), id: z.string().min(1), decision: z.enum(["approve", "deny"]), reason: z.string().trim().min(1).max(4000), response: z.string().max(20000).optional() }).strict().parse(input);
  return new WorkerActionRequests(db).decide({ ...value, config, actor: { kind: "operator" }, ...(signal ? { signal } : {}) });
}
