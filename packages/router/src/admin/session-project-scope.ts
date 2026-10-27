import { closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { MeritRouter } from "../core/service.js";
import { SessionEventSchema, type SessionEvent } from "../sessions/events.js";
import { openProjectStores } from "./project-reads.js";

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const Participant = z.object({ task_id: Id, project_id: z.string().min(1).nullable() });
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_EVENTS = 50_000;
export const SESSION_SCOPE_UNAVAILABLE = "This historical timeline is unavailable because its complete participant project scope could not be verified. Accounting and safe session metadata remain available.";

/** Validate the entire historical cohort before exposing any page, including failures and pre-response input. */
export function scopedSessionTimeline(sy: MeritRouter, id: string, project: string): SessionEvent[] | null {
  if (!Id.safeParse(id).success) return null;
  // `sessions`, `tasks`, `model_requests`, `executions`, `execution_members` and `request_charges`
  // are project-private; this entire cohort lives in `project`'s own store, never `sy.db`.
  const opened = openProjectStores(sy, project);
  if (!opened.ok) return null;
  const db = opened.stores.db;
  const owner = z.object({task_id:Id.nullable(),project_id:z.string().max(200)}).safeParse(db.prepare("SELECT task_id, project_id FROM sessions WHERE id=?").get(id)).data;
  if (!owner || owner.project_id !== project || !owner.task_id) return null;
  const task = z.object({project_id:z.string().max(200)}).safeParse(db.prepare("SELECT project_id FROM tasks WHERE id=?").get(owner.task_id)).data;
  if (task?.project_id !== project) return null;
  let fd: number | undefined;
  try {
    const directory = path.join(sy.cfg.storageDir, "sessions");
    const file = path.join(directory, `${id}.jsonl`);
    if (lstatSync(directory).isSymbolicLink()) return null;
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) return null;
    fd = openSync(file, "r");
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.ino !== stat.ino || opened.size > MAX_BYTES) return null;
    const bytes = Buffer.alloc(opened.size + 1);
    let count = 0;
    while (count < bytes.length) { const n = readSync(fd, bytes, count, bytes.length-count, null); if (!n) break; count += n; }
    if (count > opened.size) return null;
    const lines = bytes.subarray(0,count).toString("utf8").split(/\r?\n/);
    if (lines.length > MAX_EVENTS + 1) return null;
    const events: SessionEvent[] = [];
    const executions = new Set<string>();
    const requests = new Set<string>();
    const recordedMembers = new Map<string, Map<string,string>>();
    for (const line of lines) {
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > 512 * 1024) return null;
      const event = SessionEventSchema.parse(JSON.parse(line));
      if (event.seq !== events.length + 1) return null;
      events.push(event);
      if (event.type === "model_request" || event.type === "model_error") executions.add(Id.parse(event.data.executionId));
      if (event.type === "model_response") requests.add(Id.parse(event.data.requestId));
      if (event.type === "note" && event.data.data && typeof event.data.data === "object" && "executionId" in event.data.data) {
        const execution = Id.parse(event.data.data.executionId);
        executions.add(execution);
        if ("members" in event.data.data) {
          const members = z.array(z.object({taskId:Id,itemId:z.string().min(1).max(200)})).min(1).max(10_000).parse(event.data.data.members);
          if (new Set(members.map(m=>m.taskId)).size !== members.length || new Set(members.map(m=>m.itemId)).size !== members.length) return null;
          const prior = recordedMembers.get(execution) ?? new Map<string,string>();
          for (const member of members) {
            if (prior.has(member.taskId) && prior.get(member.taskId) !== member.itemId) return null;
            prior.set(member.taskId,member.itemId);
          }
          recordedMembers.set(execution,prior);
        }
      }
    }
    if (executions.size > 256 || requests.size > 1024) return null;
    for (const request of requests) {
      const row = z.object({execution_id:Id,project_id:z.string()}).safeParse(db.prepare("SELECT execution_id,project_id FROM model_requests WHERE id=?").get(request)).data;
      if (!row || row.project_id !== project) return null;
      executions.add(Id.parse(row.execution_id));
    }
    if (executions.size > 256) return null;
    // No successful anchor is necessary: model_request/model_error execution membership is authoritative too.
    for (const execution of executions) {
      const kind = z.object({kind:z.enum(["task","batch"])}).parse(db.prepare("SELECT kind FROM executions WHERE id=?").get(execution)).kind;
      const original = recordedMembers.get(execution);
      if (kind === "batch" && !original) return null;
      if (original) {
        for (const [taskId,itemId] of original) {
          const proof = z.object({project_id:z.string(),item_id:z.string()}).safeParse(db.prepare("SELECT t.project_id,m.item_id FROM execution_members m JOIN tasks t ON t.id=m.task_id WHERE m.execution_id=? AND m.task_id=?").get(execution,taskId)).data;
          if (!proof || proof.project_id !== project || proof.item_id !== itemId) return null;
        }
      }
      const members = z.array(Participant).max(10_000).parse(db.prepare(`
        SELECT m.task_id,t.project_id FROM execution_members m LEFT JOIN tasks t ON t.id=m.task_id WHERE m.execution_id=?
        UNION SELECT c.task_id,t.project_id FROM request_charges c JOIN model_requests r ON r.id=c.request_id LEFT JOIN tasks t ON t.id=c.task_id WHERE r.execution_id=? LIMIT 10001
      `).all(execution,execution));
      if (original && members.some(m=>!original.has(m.task_id))) return null;
      if (!members.length || !members.some(m=>m.task_id===owner.task_id) || members.some(m=>m.project_id!==project)) return null;
      const uncharged = db.prepare("SELECT 1 FROM model_requests r WHERE r.execution_id=? AND NOT EXISTS(SELECT 1 FROM request_charges c WHERE c.request_id=r.id) LIMIT 1").get(execution);
      if (uncharged) return null;
    }
    // A model-bearing session lacking any verifiable execution cannot safely expose its earlier context.
    const indexed = z.object({model_requests:z.number().int().nonnegative(),last_seq:z.number().int().nonnegative()}).parse(db.prepare("SELECT model_requests,last_seq FROM sessions WHERE id=?").get(id));
    if (events.length !== indexed.last_seq || events.filter(e=>e.type === "model_request").length !== indexed.model_requests || ((indexed.model_requests > 0 || events.some(e=>e.type === "message" || e.type === "tool_intent" || e.type === "model_response")) && !executions.size)) return null;
    return events;
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}
