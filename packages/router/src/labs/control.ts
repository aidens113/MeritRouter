import { z } from "zod";
import { immediate, newId } from "../storage/db.js";
import { MeritRouterError } from "../core/errors.js";
import { LabNameSchema } from "./recipe.js";
import type { LabRecord } from "./store.js";
import { LabsStore } from "./store.js";
import { LeaseRefSchema, type LeaseRef } from "../storage/lease-ref.js";
import { parseLabAuthority } from "./control-authority.js";
export const LabControlProjectSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/);
const Heads = z.record(z.string().min(1), z.string().regex(/^[a-f0-9]{40,64}$/));
export const LabOperationInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create"), goal: z.string().max(16000).optional(), targetBranches: z.record(z.string().min(1), z.string().min(1).max(300)).optional() }).strict(),
  z.object({ kind: z.literal("start") }).strict(), z.object({ kind: z.literal("stop") }).strict(), z.object({ kind: z.literal("destroy") }).strict(), z.object({ kind: z.literal("refresh") }).strict(),
  z.object({ kind: z.literal("restart"), service: LabNameSchema.optional() }).strict(), z.object({ kind: z.literal("check"), name: LabNameSchema }).strict(),
  z.object({ kind: z.literal("after_integrate"), expectedHeads: Heads }).strict(),
  z.object({ kind: z.literal("promote"), by: z.enum(["human", "supervisor", "auto"]), reason: z.string().max(2000).optional() }).strict(),
]);
export type LabOperationInput = z.infer<typeof LabOperationInputSchema>;
const Row = z.object({ id: z.string(), lab_id: z.string().nullable(), project_id: LabControlProjectSchema, lab_name: LabNameSchema, kind: z.string(), input_json: z.string(), state: z.enum(["pending", "running", "completed", "failed"]), requested_by: z.string(), owner_id: z.string().nullable(), lease_until: z.number(), result_json: z.string().nullable(), error_code: z.string().nullable(), error_message: z.string().nullable(), created_at: z.number(), updated_at: z.number() });
export interface LabOperation {
  taskLease: LeaseRef | null;
  id: string;
  labId: string | null;
  project: string;
  name: string;
  input: LabOperationInput;
  state: "pending" | "running" | "completed" | "failed";
  requestedBy: string;
  result: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
}
function hydrate(raw: unknown): LabOperation {
  const r = Row.parse(raw);
  const proof = z.object({ authority_json: z.string().nullable() }).parse(raw);
  return { taskLease: parseLabAuthority(proof.authority_json), id: r.id, labId: r.lab_id, project: r.project_id, name: r.lab_name, input: LabOperationInputSchema.parse(JSON.parse(r.input_json)), state: r.state, requestedBy: r.requested_by, result: r.result_json ? JSON.parse(r.result_json) : null, errorCode: r.error_code, errorMessage: r.error_message, createdAt: r.created_at, updatedAt: r.updated_at };
}
export class LabControl {
  private processing = new Set<string>();
  constructor(readonly store: LabsStore, readonly owner: string, readonly execute: (project: string, name: string, input: LabOperationInput, taskLease: LeaseRef | null, requestedBy: string) => Promise<unknown>, readonly available: (project: string, name: string) => boolean = () => true, readonly authorize: (project: string, taskLease: LeaseRef | null) => void = (_project, lease) => { if (lease) throw new MeritRouterError("lab_scope_denied", "model controls require a trusted authority validator"); }) {
  }
  activeOwner(labId: string): string | null {
    const owners = new Set(this.store.services(labId).filter(s => s.owner_id && s.owner_until > Date.now() && ["running", "starting", "backoff"].includes(s.state)).map(s => s.owner_id!));
    const operations = z.array(z.object({ owner_id: z.string() })).parse(this.store.db.prepare("SELECT owner_id FROM lab_operations WHERE lab_id=? AND state='running' AND owner_id IS NOT NULL AND lease_until>?").all(labId, Date.now()));
    for (const operation of operations)
      owners.add(operation.owner_id);
    if (owners.size > 1)
      throw new MeritRouterError("lab_owner_conflict", "lab services have conflicting live owners");
    return [...owners][0] ?? null;
  }
  submit(project: string, name: string, input: LabOperationInput, by: string, taskLease?: LeaseRef): LabOperation {
    LabControlProjectSchema.parse(project);
    LabNameSchema.parse(name);
    const parsed = LabOperationInputSchema.parse(input);
    z.string().min(1).max(200).parse(by);
    const lease = taskLease ? LeaseRefSchema.parse(taskLease) : null;
    if (by.startsWith("task:") && (!lease || by !== `task:${lease.taskId}` || project !== lease.project)) throw new MeritRouterError("lab_scope_denied", "model Lab controls require their original captured task lease");
    if (lease && by !== `task:${lease.taskId}`) throw new MeritRouterError("lab_scope_denied", "Lab actor and captured task authority differ");
    if (lease && parsed.kind === "promote" && parsed.by !== "supervisor") throw new MeritRouterError("lab_scope_denied", "model Lab promotion cannot impersonate a human or automatic operator");
    const lab = this.store.get(project, name);
    if(lab?.kind==="task_attempt")throw new MeritRouterError("lab_scope_denied","public controls cannot mutate a task-owned Lab");
    if (parsed.kind !== "create" && (!lab || lab.state === "destroyed"))
      throw new MeritRouterError("not_found", "unknown lab");
    if (parsed.kind === "create" && lab)
      throw new MeritRouterError("lab_conflict", "lab name already exists");
    const id = newId("lop"), now = Date.now();
    this.store.db.prepare("INSERT INTO lab_operations(id,lab_id,project_id,lab_name,kind,input_json,state,requested_by,created_at,updated_at,authority_json) VALUES(?,?,?,?,?,?,'pending',?,?,?,?)").run(id, lab?.id ?? null, project, name, parsed.kind, JSON.stringify(parsed), by, now, now, lease ? JSON.stringify(lease) : null);
    if (lab)
      this.store.event(lab.id, "operation_requested", { id, kind: parsed.kind, by });
    return this.get(project, name, id)!;
  }
  get(project: string, name: string, id: string): LabOperation | null {
    const raw = this.store.db.prepare("SELECT * FROM lab_operations WHERE id=? AND project_id=? AND lab_name=?").get(id, project, name);
    return raw ? hydrate(raw) : null;
  }
  async process(project: string, name: string): Promise<void> {
    const key = `${project}/${name}`;
    if (this.processing.has(key) || !this.available(project, name))
      return;
    const lab = this.store.get(project, name);
    if (lab?.state === "creating") {
      const creation = z.object({ creation_owner: z.string().nullable(), creation_until: z.number() }).parse(this.store.db.prepare("SELECT creation_owner,creation_until FROM labs WHERE id=?").get(lab.id));
      if (creation.creation_until > Date.now() && creation.creation_owner !== this.owner)
        return;
    }
    const active = lab ? this.activeOwner(lab.id) : null;
    if (active && active !== this.owner)
      return;
    const claimed = immediate(this.store.db, () => {
      if (this.store.db.prepare("SELECT id FROM lab_operations WHERE project_id=? AND lab_name=? AND state='running' AND lease_until>? LIMIT 1").get(project, name, Date.now()))
        return null;
      const raw = this.store.db.prepare("SELECT * FROM lab_operations WHERE project_id=? AND lab_name=? AND (state='pending' OR(state='running' AND lease_until<=?)) ORDER BY created_at,rowid LIMIT 1").get(project, name, Date.now());
      if (!raw)
        return null;
      const op = hydrate(raw);
      this.store.db.prepare("UPDATE lab_operations SET state='running',owner_id=?,lease_until=?,updated_at=? WHERE id=?").run(this.owner, Date.now() + 120000, Date.now(), op.id);
      return op;
    });
    if (!claimed)
      return;
    this.processing.add(key);
    const timer = setInterval(() => this.store.db.prepare("UPDATE lab_operations SET lease_until=?,updated_at=? WHERE id=? AND owner_id=? AND state='running'").run(Date.now() + 120000, Date.now(), claimed.id, this.owner), 10000);
    timer.unref();
    try {
      if (claimed.requestedBy.startsWith("task:") && (!claimed.taskLease || claimed.requestedBy !== `task:${claimed.taskLease.taskId}`)) throw new MeritRouterError("lab_scope_denied", "legacy model Lab operation has no trustworthy captured authority");
      if (claimed.taskLease && claimed.input.kind === "promote" && claimed.input.by !== "supervisor") throw new MeritRouterError("lab_scope_denied", "queued model promotion cannot impersonate a human or automatic operator");
      this.authorize(project, claimed.taskLease);
      const recoveredCreate = claimed.state === "running" && claimed.input.kind === "create" && lab && ["stopped", "running"].includes(lab.state);
      const result = recoveredCreate ? { recovered: true, labId: lab.id } : lab?.state === "destroyed" && claimed.input.kind === "destroy" ? { destroyed: true } : await this.execute(project, name, claimed.input, claimed.taskLease, claimed.requestedBy);
      const actual = this.store.get(project, name);
      this.store.db.prepare("UPDATE lab_operations SET state='completed',lab_id=?,result_json=?,lease_until=0,updated_at=? WHERE id=? AND owner_id=?").run(actual?.id ?? null, JSON.stringify(result ?? null), Date.now(), claimed.id, this.owner);
      if (actual)
        this.store.event(actual.id, "operation_completed", { id: claimed.id, kind: claimed.input.kind });
    }
    catch (err) {
      const e = err as Error & {
        code?: string;
      };
      this.store.db.prepare("UPDATE lab_operations SET state='failed',error_code=?,error_message=?,lease_until=0,updated_at=? WHERE id=? AND owner_id=?").run(e.code ?? "lab_operation_failed", e.message.slice(0, 4000), Date.now(), claimed.id, this.owner);
      const actual = this.store.get(project, name);
      if (actual)
        this.store.event(actual.id, "operation_failed", { id: claimed.id, kind: claimed.input.kind, error: e.message.slice(0, 4000) });
    }
    finally {
      clearInterval(timer);
      this.processing.delete(key);
    }
  }
  async processAll(): Promise<void> {
    const targets = z.array(z.object({ project_id: LabControlProjectSchema, lab_name: LabNameSchema }).strict()).parse(this.store.db.prepare("SELECT DISTINCT project_id,lab_name FROM lab_operations WHERE state IN ('pending','running') ORDER BY project_id,lab_name LIMIT 100").all());
    for (const t of targets)
      await this.process(t.project_id, t.lab_name);
  }
  async wait(project: string, name: string, id: string, options: {
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {}): Promise<LabOperation> {
    const timeout = z.number().int().min(100).max(3600000).parse(options.timeoutMs ?? 30000);
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (options.signal?.aborted)
        throw new MeritRouterError("lab_control_cancelled", `stopped waiting for operation ${id}; inspect its persisted status`);
      const op = this.get(project, name, id);
      if (!op)
        throw new MeritRouterError("not_found", "unknown lab operation");
      if (op.state === "failed")
        throw new MeritRouterError(op.errorCode ?? "lab_operation_failed", `lab operation ${id} failed; inspect its status and local supervisor logs`);
      if (op.state === "completed")
        return op;
      await new Promise(r => setTimeout(r, 50));
    }
    throw new MeritRouterError("lab_control_timeout", `operation ${id} is persisted but not finished; its active owner must process it`);
  }
}
