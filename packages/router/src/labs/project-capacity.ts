import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { immediate, type Db } from "../storage/db.js";
import { ProjectEvidenceScope } from "../storage/project-evidence-scope.js";
import { canonicalJson } from "../storage/tasks.js";
import { assertCriticalStoreDurability, readProjectStoreRegistration, readStoreIdentity, ProjectStoreIdentitySchema, type ProjectStoreIdentity } from "../projects/store-identity.js";
import { RepositoryServiceCommandSchema, repositoryServiceRetirement } from "../workspaces/repository-command.js";
import { LabsStore, type LabRecord } from "./store.js";
import { LabNameSchema } from "./recipe.js";
import { TaskAttemptStore } from "./task-attempt-store.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const label = z.string().min(1).max(256), hex = z.string().regex(/^[a-f0-9]{64}$/);
const Limits = z.object({ max_active: z.number().int().min(1).max(100), max_services: z.number().int().min(1).max(1000) }).strict();
export type ProjectLabCapacityLimits = z.infer<typeof Limits>;
const Kind = z.enum(["lab", "service"]);
const Receipt = z.object({ reservation_id: hex, installation_uuid: z.uuid(), project_uuid: z.uuid(), store_uuid: z.uuid(), generation: z.number().int().positive(), kind: Kind, lab_digest: hex, member_digest: hex, created_at: z.number().int().nonnegative() }).strict();
const Owner = z.object({ reservation_id: hex, project_id: label, lab_id: label, service_name: LabNameSchema, command_token: z.string().regex(/^[a-f0-9]{48}$/), process_id: z.string().nullable(), handle_json: z.string(), created_at: z.number().int().nonnegative(), updated_at: z.number().int().nonnegative() }).strict();
const CommandOwner = z.object({ id: z.string(), project_id: label, lab_id: label, kind: z.enum(["lab-service", "task-service"]), logical_name: LabNameSchema, token: z.string().regex(/^[a-f0-9]{48}$/), command_digest: hex, worktree_path: z.string(), process_id: z.string().nullable(), handle_json: z.string(), phase: z.enum(["prepared", "running"]) }).strict();
const Process = z.object({ id: label, lab_id: label, attempt_id: label, kind: z.literal("service"), logical_name: LabNameSchema, token: z.string().regex(/^[a-f0-9]{48}$/), pid: z.number().int().positive().nullable(), state: z.enum(["intent", "registered", "running", "stopped"]) }).strict();
const key = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);

/** Installation-wide accounting only; all names, native bindings and lifecycle evidence stay local. */
export class ProjectLabCapacity {
  private readonly identity: ProjectStoreIdentity;
  private readonly scope: ProjectEvidenceScope;
  private readonly labs: LabsStore;
  constructor(private readonly global: Db, private readonly local: Db, identity: ProjectStoreIdentity,
    private readonly authority: { assertCurrent(): void; assertPinned(): void },
    private readonly limits: () => ProjectLabCapacityLimits, private readonly now: () => number = Date.now) {
    this.identity = Object.freeze(ProjectStoreIdentitySchema.parse(identity));
    this.scope = new ProjectEvidenceScope(local); this.labs = new LabsStore(local);
    if (global === local || canonicalJson(readStoreIdentity(local)) !== canonicalJson(this.identity)) throw new Error("Lab capacity requires an exact separate project store");
    Limits.parse(limits()); this.coordinationOwner();
  }
  usesDatabase(db: Db): boolean { return db === this.local; }
  private coordinationOwner(): void {
    assertCriticalStoreDurability(this.global);
    const owner = readStoreIdentity(this.global);
    if (owner?.role !== "coordination" || owner.installationId !== this.identity.installationId) throw new Error("Lab capacity requires matching coordination ownership");
  }
  private lab(labId: string, release = false): LabRecord {
    if (release) this.authority.assertPinned(); else this.authority.assertCurrent();
    this.scope.assert(); const lab = this.labs.byId(label.parse(labId));
    if (!lab || lab.project !== this.identity.slug) throw new Error("Lab capacity owner is unavailable in this project");
    if (lab.kind === "task_attempt") {
      const row = z.object({ attempt_id: label }).strict().parse(this.local.prepare("SELECT attempt_id FROM lab_task_attempts WHERE lab_id=?").get(lab.id));
      const attempts = new TaskAttemptStore(this.local), attempt = attempts.get(row.attempt_id), request = attempts.lab(row.attempt_id);
      if (attempt.project !== this.identity.slug || request?.labId !== lab.id) throw new Error("Task Lab capacity identity changed");
    }
    return lab;
  }
  private binding(labId: string, kind: z.infer<typeof Kind>, name?: string) {
    const lab = digest(label.parse(labId)), member = digest(kind === "lab" ? "lab" : LabNameSchema.parse(name));
    return { lab, member, id: digest(canonicalJson({ owner: this.identity, kind, lab, member })) };
  }
  /** No local reads or callbacks execute inside this independent coordination transaction. */
  private transaction<T>(action: () => T): T {
    this.coordinationOwner();
    if (this.global.inTransaction) throw new Error("Lab capacity requires an independent coordination transaction");
    return immediate(this.global, () => {
      const registration = readProjectStoreRegistration(this.global, this.identity.projectId);
      if (!registration || registration.state !== "registered" || registration.storeId !== this.identity.storeId || registration.generation !== this.identity.generation) throw new Error("Lab capacity project generation is unavailable");
      return action();
    });
  }
  private receipt(raw: unknown, labId: string, kind: z.infer<typeof Kind>, name?: string) {
    const row = Receipt.parse(raw), bound = this.binding(labId, kind, name);
    if (row.reservation_id !== bound.id || row.installation_uuid !== this.identity.installationId || row.project_uuid !== this.identity.projectId || row.store_uuid !== this.identity.storeId || row.generation !== this.identity.generation || row.kind !== kind || row.lab_digest !== bound.lab || row.member_digest !== bound.member) throw new Error("Lab capacity receipt binding changed");
    return row;
  }
  private reserveGlobal(labId: string, kind: z.infer<typeof Kind>, limits: ProjectLabCapacityLimits, name?: string, allowNew = true): void {
    const bound = this.binding(labId, kind, name);
    this.transaction(() => {
      const existing = this.global.prepare("SELECT * FROM project_lab_capacity WHERE reservation_id=?").get(bound.id);
      if (existing) { this.receipt(existing, labId, kind, name); return; }
      if (!allowNew) throw new Error("A new Lab capacity slot requires its durable creating intent; recovery evidence retained");
      if (kind === "service") {
        const labReceipt = this.global.prepare("SELECT * FROM project_lab_capacity WHERE reservation_id=?").get(this.binding(labId, "lab").id);
        if (!labReceipt) throw new Error("Service capacity requires its reserved Lab slot"); this.receipt(labReceipt, labId, "lab");
      }
      const count = z.object({ n: z.number().int().nonnegative() }).strict().parse(this.global.prepare("SELECT count(*) n FROM project_lab_capacity WHERE installation_uuid=? AND kind=?").get(this.identity.installationId, kind));
      if (count.n >= (kind === "lab" ? limits.max_active : limits.max_services)) throw new Error(`Installation ${kind} capacity reached`);
      this.global.prepare("INSERT INTO project_lab_capacity(reservation_id,installation_uuid,project_uuid,store_uuid,generation,kind,lab_digest,member_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(bound.id, this.identity.installationId, this.identity.projectId, this.identity.storeId, this.identity.generation, kind, bound.lab, bound.member, this.now());
    });
  }
  reserveLab(labId: string): void {
    const limits = Limits.parse(this.limits());
    immediate(this.local, () => { const lab = this.lab(labId); if (lab.state === "destroyed" || lab.state === "failed") throw new Error("Lab capacity requires a live creating or existing admitted Lab"); this.reserveGlobal(lab.id, "lab", limits, undefined, lab.state === "creating"); });
  }
  private owner(labId: string, name: string) { return Owner.optional().parse(this.local.prepare("SELECT * FROM lab_capacity_owners WHERE lab_id=? AND service_name=?").get(labId, LabNameSchema.parse(name))); }
  private command(lab: LabRecord, name: string) {
    if (!Object.hasOwn(lab.recipe.services, name)) throw new Error("Service capacity requires a declared immutable Lab service");
    const repository = lab.repositories.find(repo => repo.alias === lab.recipe.services[name]!.repo);
    if (!repository) throw new Error("Service capacity has no declared Lab repository");
    const service = this.labs.service(lab.id, name);
    if (!service || !["starting", "running", "backoff"].includes(service.state) || service.owner_id === null || service.owner_until <= this.now()) throw new Error("Service capacity requires a durable live starting intent");
    const raw = CommandOwner.parse(this.local.prepare("SELECT id,project_id,lab_id,kind,logical_name,token,command_digest,worktree_path,process_id,handle_json,phase FROM lab_command_owners WHERE lab_id=? AND logical_name=? AND kind IN ('lab-service','task-service')").get(lab.id, name));
    const handle = RepositoryServiceCommandSchema.parse(JSON.parse(raw.handle_json));
    if (raw.project_id !== lab.project || raw.lab_id !== lab.id || raw.logical_name !== name || raw.kind !== (lab.kind === "retained" ? "lab-service" : "task-service") || raw.id !== handle.id || raw.token !== handle.descriptor.member || handle.descriptor.kind !== raw.kind || handle.descriptor.group !== `lab:${lab.project}:${lab.id}` || raw.command_digest !== handle.descriptor.commandSha256 || key(raw.worktree_path) !== key(handle.repo) || key(repository.worktree) !== key(handle.repo)) throw new Error("Service command capacity binding changed");
    if (raw.process_id) {
      const process = this.process(raw.process_id);
      if (lab.kind !== "task_attempt" || process.lab_id !== lab.id || process.logical_name !== name || process.token !== raw.token || process.state === "stopped") throw new Error("Task service capacity process identity changed");
      const attempt = new TaskAttemptStore(this.local).get(process.attempt_id);
      if (attempt.project !== lab.project || new TaskAttemptStore(this.local).lab(process.attempt_id)?.labId !== lab.id) throw new Error("Task service capacity belongs to another attempt");
      if (service.token !== null && service.token !== raw.token || service.pid !== null && service.pid !== process.pid) throw new Error("Task service projection differs from its command identity");
    } else if (lab.kind !== "retained" || service.token !== raw.token) throw new Error("Retained service capacity token differs from its command identity");
    return { service, raw, handle };
  }
  private process(id: string) { return Process.parse(this.local.prepare("SELECT id,lab_id,attempt_id,kind,logical_name,token,pid,state FROM lab_attempt_processes WHERE id=?").get(id)); }
  private ownerHandle(lab: LabRecord, name: string, owner: z.infer<typeof Owner>) {
    const handle = RepositoryServiceCommandSchema.parse(JSON.parse(owner.handle_json));
    const repository = lab.repositories.find(repo => repo.alias === lab.recipe.services[name]?.repo);
    if (!repository || key(repository.worktree) !== key(handle.repo) || owner.project_id !== lab.project || owner.lab_id !== lab.id || owner.service_name !== name || owner.reservation_id !== this.binding(lab.id, "service", name).id || handle.descriptor.group !== `lab:${lab.project}:${lab.id}` || handle.descriptor.member !== owner.command_token || handle.descriptor.kind !== (lab.kind === "retained" ? "lab-service" : "task-service")) throw new Error("Private service capacity owner changed");
    return handle;
  }
  async reserveService(labId: string, name: string): Promise<void> {
    const limits = Limits.parse(this.limits()); LabNameSchema.parse(name);
    const snapshot = immediate(this.local, () => { const lab = this.lab(labId); return { lab, command: this.command(lab, name), previous: this.owner(lab.id, name) }; });
    const old = snapshot.previous;
    if (old && old.handle_json !== JSON.stringify(snapshot.command.handle) && await repositoryServiceRetirement(this.ownerHandle(snapshot.lab, name, old)) === null) throw new Error("Previous service capacity binding has no exact quiescent/unsent archive; slot retained");
    immediate(this.local, () => {
      const lab = this.lab(labId), command = this.command(lab, name), previous = this.owner(lab.id, name);
      if (canonicalJson({ lab, command, previous }) !== canonicalJson(snapshot)) throw new Error("Service capacity intent changed during retirement verification");
      this.reserveGlobal(lab.id, "service", limits, name);
      const now = this.now();
      this.local.prepare("INSERT INTO lab_capacity_owners(reservation_id,project_id,lab_id,service_name,command_token,process_id,handle_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(reservation_id) DO UPDATE SET command_token=excluded.command_token,process_id=excluded.process_id,handle_json=excluded.handle_json,updated_at=excluded.updated_at")
        .run(this.binding(lab.id, "service", name).id, lab.project, lab.id, name, command.raw.token, command.raw.process_id, JSON.stringify(command.handle), previous?.created_at ?? now, now);
    });
  }
  private stoppedService(lab: LabRecord, name: string, owner: z.infer<typeof Owner> | undefined) {
    const service = this.labs.service(lab.id, name);
    if (!service || !["stopped", "failed"].includes(service.state) || service.pid !== null || service.token !== null || service.owner_id !== null || service.owner_until !== 0 || this.local.prepare("SELECT 1 FROM lab_command_owners WHERE lab_id=? AND logical_name=? AND kind IN ('lab-service','task-service')").get(lab.id, name)) throw new Error("Service capacity release requires durable stopped identity and no unknown command owner");
    if (owner?.process_id) { const process = this.process(owner.process_id); if (process.lab_id !== lab.id || process.logical_name !== name || process.token !== owner.command_token || process.state !== "stopped") throw new Error("Task service capacity release lacks exact stopped process identity"); }
    return service;
  }
  async releaseService(labId: string, name: string): Promise<void> {
    LabNameSchema.parse(name);
    const snapshot = immediate(this.local, () => { const lab = this.lab(labId, true), owner = this.owner(lab.id, name); return { lab, owner, service: this.stoppedService(lab, name, owner) }; });
    if (snapshot.owner && await repositoryServiceRetirement(this.ownerHandle(snapshot.lab, name, snapshot.owner)) === null) throw new Error("Service capacity release lacks exact archived quiescent/unsent retirement evidence; slot retained");
    immediate(this.local, () => {
      const lab = this.lab(labId, true), owner = this.owner(lab.id, name), service = this.stoppedService(lab, name, owner);
      if (canonicalJson({ lab, owner, service }) !== canonicalJson(snapshot)) throw new Error("Service capacity ownership changed during retirement verification");
      this.transaction(() => {
        const id = this.binding(lab.id, "service", name).id, raw = this.global.prepare("SELECT * FROM project_lab_capacity WHERE reservation_id=?").get(id);
        if (raw) { this.receipt(raw, lab.id, "service", name); if (!owner) throw new Error("Service capacity owner proof is missing; global slot retained"); this.global.prepare("DELETE FROM project_lab_capacity WHERE reservation_id=?").run(id); }
      });
      if (owner) this.local.prepare("DELETE FROM lab_capacity_owners WHERE reservation_id=? AND command_token=? AND handle_json=?").run(owner.reservation_id, owner.command_token, owner.handle_json);
    });
  }
  releaseLab(labId: string): void {
    immediate(this.local, () => {
      const lab = this.lab(labId, true);
      if (lab.kind === "retained" ? lab.state !== "destroyed" : !["stopped", "destroyed"].includes(lab.state)) throw new Error("Lab capacity release requires its terminal lifecycle");
      if (this.local.prepare("SELECT 1 FROM lab_capacity_owners WHERE lab_id=?").get(lab.id) || this.local.prepare("SELECT 1 FROM lab_command_owners WHERE lab_id=?").get(lab.id) || this.local.prepare("SELECT 1 FROM lab_attempt_processes WHERE lab_id=? AND state!='stopped'").get(lab.id) || this.local.prepare("SELECT 1 FROM lab_services WHERE lab_id=? AND (state NOT IN ('stopped','failed') OR pid IS NOT NULL OR token IS NOT NULL OR owner_id IS NOT NULL OR owner_until!=0)").get(lab.id)) throw new Error("Lab capacity release lacks quiescent service/command ownership");
      if (lab.kind === "task_attempt") {
        const row = z.object({ attempt_id: label }).strict().parse(this.local.prepare("SELECT attempt_id FROM lab_task_attempts WHERE lab_id=?").get(lab.id)), request = new TaskAttemptStore(this.local).lab(row.attempt_id)!;
        if (!["retained", "pruned"].includes(request.phase) || request.desiredState !== "stopped" || request.result?.cleanup !== "complete" || request.cleanupError !== null) throw new Error("Task Lab capacity release requires durable retained/pruned cleanup proof");
      }
      this.transaction(() => {
        const bound = this.binding(lab.id, "lab");
        if (this.global.prepare("SELECT 1 FROM project_lab_capacity WHERE installation_uuid=? AND project_uuid=? AND store_uuid=? AND generation=? AND kind='service' AND lab_digest=?").get(this.identity.installationId, this.identity.projectId, this.identity.storeId, this.identity.generation, bound.lab)) throw new Error("Lab capacity still has retained service accounting");
        const raw = this.global.prepare("SELECT * FROM project_lab_capacity WHERE reservation_id=?").get(bound.id);
        if (raw) { this.receipt(raw, lab.id, "lab"); this.global.prepare("DELETE FROM project_lab_capacity WHERE reservation_id=?").run(bound.id); }
      });
    });
  }
}
