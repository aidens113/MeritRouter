import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { z } from "zod";
import { immediate, type Db } from "../storage/db.js";
import { canonicalJson } from "../storage/tasks.js";
import { LeaseRefSchema } from "../storage/lease-ref.js";
import { RequestReceipts } from "../admission/request-receipts.js";
import { RequestIdSchema, RequestOutcomeDTOSchema } from "../admission/request-ledger.js";
import type { Admission } from "../admission/admission.js";
import type { PaidSpend } from "../paid/spend.js";
import { readProjectStoreRegistration, type ProjectStoreIdentity } from "../projects/store-identity.js";
import { ProjectRequestStore } from "../admission/project-request-store.js";
import type { SqliteRequestAccountingBroker } from "../admission/sqlite-accounting-broker.js";
import { releaseOwnerAbsentSlot, SplitRequestSlotSchema } from "../gateway/capacity.js";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const EVENT = "transport_owner_reconciled";
const OUTCOME = RequestOutcomeDTOSchema.parse({ kind: "uncertain", errorKind: "operator_transport_owner_absent", errorMessage: "Local transport owner absent; remote request outcome remains unknown" });
const OUTCOME_DIGEST = digest(OUTCOME);
const Decision = z.object({ requestId: RequestIdSchema, expected: Hash, reason: z.string().trim().min(1).max(1000) }).strict();
const Slot = z.object({ id: z.string().min(1), platform: z.string().min(1), kind: z.literal("request"), holder: z.string().min(1), task_id: z.string().min(1), lease_owner: z.string().min(1), priority: z.number().int(), since: z.number(), seen_at: z.number(), lease_json: z.string(), nonce: z.string().min(1), uncertain: z.literal(0),
  // Split-store authority (migrations: global request accounting broker, project execution grants). Kept in the
  // strict shape so slotDigest and the release compare-and-swap cover them, and a future column fails closed.
  project_uuid: z.string().nullable(), store_uuid: z.string().nullable(), store_generation: z.number().int().nullable(), execution_grants_json: z.string().nullable() }).strict();
/**
 * This service reconciles the single-store request protocol only. A slot carrying project/store/grant
 * authority was taken by a split-store project Gate: its release authority is the coordination broker's
 * physical request receipt (ProviderCapacity.releaseReconciled), and its execution grants have their own
 * lifecycle that no slot release settles. Deleting it here would free provider capacity while the broker
 * still records the physical request as dispatched, so it is refused, never partially handled.
 */
const SPLIT_SLOT_COLUMNS = ["project_uuid", "store_uuid", "store_generation", "execution_grants_json"] as const;
const Model = z.object({ id: RequestIdSchema, execution_id: z.string(), gateway_model: z.string(), project_id: z.string(), status: z.enum(["reserved", "succeeded", "failed", "uncertain"]), finished_at: z.number().nullable(), est_input_tokens: z.number().int().nonnegative(), reserved_output_tokens: z.number().int().nonnegative() }).strict();
const ProcessState = z.enum(["absent", "live", "unknown"]);
export type LocalProcessState = z.infer<typeof ProcessState>;
const Owner = z.object({ host: z.string().min(1), pid: z.number().int().positive().safe(), suffix: z.string().regex(/^[a-f0-9]{6}$/) }).strict();
const Receipt = z.object({ schemaVersion: z.literal(1), requestId: RequestIdSchema, project: z.string(), expected: Hash, bindingDigest: Hash, reservationDigest: Hash, slotDigest: Hash, slotId: z.string(), slotNonce: z.string(), dispatchId: z.string().min(1), owner: z.string(), actor: z.object({ kind: z.literal("local_operator"), host: z.string(), pid: z.number().int().positive() }).strict(), reason: z.string().min(1).max(1000), proof: z.object({ kind: z.literal("same_host_pid_absent"), host: z.string(), pid: z.number().int().positive(), basis: z.literal("ESRCH") }).strict(), outcomeDigest: Hash, at: z.number() }).strict();
const Recorded = z.object({ id: z.number().int().positive(), project_id: z.string(), data_json: z.string() }).strict();
const Inspection = z.object({ requestId: RequestIdSchema, project: z.string(), snapshotDigest: Hash, slotId: z.string(), slotNonce: z.string(), platform: z.string(), dispatchId: z.string(), owner: z.string(), participantsDigest: Hash, process: z.object({ host: z.string(), pid: z.number().int().positive(), state: ProcessState }).strict(), activeCapturedLease: z.boolean(), eligible: z.boolean(), refusals: z.array(z.string()) }).strict();

/** Only ESRCH proves absence. EPERM and all other probe failures remain unknown. */
export function localProcessState(pid: number): LocalProcessState {
  try { process.kill(pid, 0); return "live"; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "absent" : "unknown"; }
}
function processOwner(owner: string) {
  const match = /^([^:]+):([1-9][0-9]*):([a-f0-9]{6})$/.exec(owner);
  if (!match) throw new Error("transport owner is not a recognized local process identity");
  return Owner.parse({ host: match[1], pid: Number(match[2]), suffix: match[3] });
}

/** Explicit trusted operator service; never registered as a model/MCP tool. */
export class TransportRecovery {
  private readonly receipts: RequestReceipts;
  constructor(private readonly db: Db, private readonly admission: Admission, private readonly spend: PaidSpend,
    // Trusted dependency injection for tests, never supplied by CLI flags or model arguments.
    private readonly probe: (pid: number) => LocalProcessState = localProcessState) {
    this.receipts = new RequestReceipts(db, () => admission.serverNow());
  }
  private bound(requestId: string, project?: string) {
    const authority = this.receipts.inspectBinding(requestId);
    const projects = [...new Set(authority.binding.participants.map(participant => participant.lease.project))];
    if (projects.length !== 1 || !authority.binding.participants.length || (project !== undefined && projects[0] !== z.string().parse(project)))
      throw new Error("transport recovery cannot cross project authority or recover anonymous participants");
    const rows = z.array(z.object({ project_id: z.string() }).strict()).parse(this.db.prepare("SELECT project_id FROM request_protocol_projects WHERE request_id=?").all(requestId));
    if (rows.length !== 1 || rows[0]!.project_id !== projects[0]) throw new Error("request project binding is inconsistent");
    const bindingDigest = digest(authority.binding), reservationDigest = digest({ ...authority.reservation, disposition: "fresh" });
    return { ...authority, project: projects[0]!, bindingDigest, reservationDigest };
  }
  private model(requestId: string) {
    return Model.parse(this.db.prepare("SELECT id,execution_id,gateway_model,project_id,status,finished_at,est_input_tokens,reserved_output_tokens FROM model_requests WHERE id=?").get(requestId));
  }
  private candidate(requestId: string, project?: string) {
    const bound = this.bound(requestId, project);
    const { binding } = bound;
    if (bound.state !== "dispatch_intent" || !bound.dispatchId || !binding.slot?.id || !binding.slot.nonce)
      throw new Error("only an identified dispatch-intent transport may be reconciled");
    const slot = Slot.parse(this.db.prepare("SELECT * FROM provider_slots WHERE id=?").get(binding.slot.id));
    if (SPLIT_SLOT_COLUMNS.some(column => slot[column] !== null))
      throw new Error("transport slot carries split-store coordination authority; single-store transport recovery cannot release it");
    if (new Set(binding.participants.map(participant => participant.taskId)).size !== binding.participants.length) throw new Error("duplicate request participant identity");
    const leases = z.array(LeaseRefSchema).min(1).max(256).parse(JSON.parse(slot.lease_json));
    const transportProvider = binding.paid?.provider ?? slot.platform;
    if ((slot.platform !== transportProvider && slot.platform !== `paid:${transportProvider}`) || slot.nonce !== binding.slot.nonce || slot.task_id !== binding.participants[0]!.taskId ||
      canonicalJson(leases) !== canonicalJson(binding.participants.map(participant => participant.lease)) ||
      binding.participants.some(participant => participant.leaseOwner !== slot.lease_owner) || !binding.gatewayModel.startsWith(`direct:${transportProvider}/`))
      throw new Error("request and transport slot immutable identities disagree");
    const model = this.model(requestId);
    if (model.status !== "reserved" || model.finished_at !== null || model.execution_id !== binding.executionId || model.gateway_model !== binding.gatewayModel || model.project_id !== bound.project || model.est_input_tokens !== binding.estInputTokens || model.reserved_output_tokens !== binding.reservedOutputTokens)
      throw new Error("request is already settled or its accounting binding changed");
    const charges = z.array(z.object({ task_id: z.string(), input_tokens: z.number(), output_tokens: z.number(), tokens_exact: z.literal(0), lease_incarnation: z.string(), run_count: z.number().int() }).strict()).parse(this.db.prepare("SELECT task_id,input_tokens,output_tokens,tokens_exact,lease_incarnation,run_count FROM request_charges WHERE request_id=? ORDER BY task_id").all(requestId));
    if (charges.length !== binding.participants.length || binding.participants.some(participant => !charges.some(charge => charge.task_id === participant.taskId && charge.lease_incarnation === participant.lease.incarnation && charge.run_count === participant.lease.runCount && charge.input_tokens === participant.estInputTokens && charge.output_tokens === participant.reservedOutputTokens)))
      throw new Error("request charge binding changed; original evidence retained");
    if (binding.paid) {
      const paid = z.object({ key_ref: z.string(), provider: z.string(), reserved_usd: z.number(), actual_usd: z.null(), settled_at: z.null() }).strict().parse(this.db.prepare("SELECT key_ref,provider,reserved_usd,actual_usd,settled_at FROM paid_spend WHERE request_id=?").get(requestId));
      if (paid.key_ref !== binding.paid.key.ref || paid.provider !== binding.paid.provider || Math.abs(paid.reserved_usd - binding.paid.worstCaseUsd) > 0.000001)
        throw new Error("paid reservation binding changed");
    } else if (this.db.prepare("SELECT 1 FROM paid_spend WHERE request_id=?").get(requestId)) throw new Error("unexpected paid reservation binding");
    const owner = processOwner(slot.lease_owner);
    if (owner.host !== hostname()) throw new Error("foreign-host transport ownership cannot be proved locally");
    const slotDigest = digest(slot);
    const snapshotDigest = digest({ requestId, fingerprint: bound.fingerprint, dispatchId: bound.dispatchId, bindingDigest: bound.bindingDigest, reservationDigest: bound.reservationDigest, slotDigest, model, charges });
    return { ...bound, slot, leases, model, owner, slotDigest, snapshotDigest };
  }
  private active(leases: z.infer<typeof LeaseRefSchema>[]): boolean {
    return leases.some(lease => !!this.db.prepare("SELECT 1 FROM tasks WHERE id=? AND lease_owner=? AND run_count=? AND lease_incarnation=? AND project_id=? AND lease_expires_at>?").get(lease.taskId, lease.owner, lease.runCount, lease.incarnation, lease.project, this.admission.serverNow()));
  }
  inspect(requestId: string, project?: string) {
    const candidate = this.candidate(RequestIdSchema.parse(requestId), project);
    const state = ProcessState.parse(this.probe(candidate.owner.pid)), activeCapturedLease = this.active(candidate.leases);
    const refusals = [...(state !== "absent" ? [`local owner process is ${state}`] : []), ...(activeCapturedLease ? ["captured task lease remains live"] : [])];
    return Inspection.parse({ requestId, project: candidate.project, snapshotDigest: candidate.snapshotDigest, slotId: candidate.slot.id, slotNonce: candidate.slot.nonce, platform: candidate.slot.platform, dispatchId: candidate.dispatchId, owner: candidate.slot.lease_owner, participantsDigest: digest(candidate.leases), process: { host: candidate.owner.host, pid: candidate.owner.pid, state }, activeCapturedLease, eligible: !refusals.length, refusals });
  }
  private replay(input: z.infer<typeof Decision>, project?: string) {
    const rows = this.db.prepare("SELECT id,project_id,data_json FROM events WHERE type=? AND json_extract(CASE WHEN json_valid(data_json) THEN data_json ELSE '{}' END,'$.requestId')=? ORDER BY id").all(EVENT, input.requestId);
    if (!rows.length) return null;
    if (rows.length !== 1) throw new Error("transport recovery audit receipt is ambiguous");
    const row = Recorded.parse(rows[0]), receipt = Receipt.parse(JSON.parse(row.data_json)), bound = this.bound(input.requestId, project), model = this.model(input.requestId);
    if (row.project_id !== receipt.project || receipt.expected !== input.expected || receipt.bindingDigest !== bound.bindingDigest || receipt.reservationDigest !== bound.reservationDigest || receipt.project !== bound.project || receipt.outcomeDigest !== OUTCOME_DIGEST || bound.outcomeDigest !== OUTCOME_DIGEST || bound.state !== "settled" || bound.dispatchId !== receipt.dispatchId || model.status !== "uncertain" || model.finished_at === null || model.execution_id !== bound.binding.executionId || model.gateway_model !== bound.binding.gatewayModel || model.project_id !== bound.project || model.est_input_tokens !== bound.binding.estInputTokens || model.reserved_output_tokens !== bound.binding.reservedOutputTokens ||
      bound.binding.slot?.id !== receipt.slotId || bound.binding.slot.nonce !== receipt.slotNonce || this.db.prepare("SELECT 1 FROM provider_slots WHERE id=?").get(receipt.slotId))
      throw new Error("transport recovery retry differs from its committed receipt");
    return { ...receipt, eventId: row.id, disposition: "replayed" as const };
  }
  reconcile(value: unknown, project?: string) {
    const input = Decision.parse(value);
    return immediate(this.db, () => {
      const previous = this.replay(input, project);
      if (previous) return previous;
      const candidate = this.candidate(input.requestId, project);
      if (candidate.snapshotDigest !== input.expected) throw new Error("transport recovery snapshot changed; inspect again");
      if (this.active(candidate.leases)) throw new Error("captured task lease remains live");
      if (ProcessState.parse(this.probe(candidate.owner.pid)) !== "absent") throw new Error("local transport owner is live or absence is unknown");
      // No awaits, provider calls, quota releases, or lease-state mutations in this transaction.
      this.receipts.reconcile(candidate.reservation, OUTCOME, original => {
        const { paid, ...accounting } = original;
        this.admission.reconcile({ ...accounting, ...(paid ? { paid: { ...paid, spend: this.spend } } : {}) }, OUTCOME);
      });
      const removed = this.db.prepare("DELETE FROM provider_slots WHERE id=? AND kind='request' AND nonce=? AND uncertain=0 AND holder=? AND task_id=? AND lease_owner=? AND lease_json=? AND platform=? AND priority=? AND since=? AND seen_at=? AND project_uuid IS NULL AND store_uuid IS NULL AND store_generation IS NULL AND execution_grants_json IS NULL")
        .run(candidate.slot.id, candidate.slot.nonce, candidate.slot.holder, candidate.slot.task_id, candidate.slot.lease_owner, candidate.slot.lease_json, candidate.slot.platform, candidate.slot.priority, candidate.slot.since, candidate.slot.seen_at).changes;
      if (removed !== 1) throw new Error("exact transport slot release lost its compare-and-swap");
      const receipt = Receipt.parse({ schemaVersion: 1, requestId: input.requestId, project: candidate.project, expected: input.expected, bindingDigest: candidate.bindingDigest, reservationDigest: candidate.reservationDigest, slotDigest: candidate.slotDigest, slotId: candidate.slot.id, slotNonce: candidate.slot.nonce, dispatchId: candidate.dispatchId, owner: candidate.slot.lease_owner, actor: { kind: "local_operator", host: hostname(), pid: process.pid }, reason: input.reason, proof: { kind: "same_host_pid_absent", host: candidate.owner.host, pid: candidate.owner.pid, basis: "ESRCH" }, outcomeDigest: OUTCOME_DIGEST, at: this.admission.serverNow() });
      const recorded = this.db.prepare("INSERT INTO events(task_id,project_id,ts,type,data_json) VALUES(NULL,?,?,?,?)").run(receipt.project, receipt.at, EVENT, JSON.stringify(receipt));
      return { ...receipt, eventId: Number(recorded.lastInsertRowid), disposition: "fresh" as const };
    });
  }
}

// ---------- split-store installations ----------

const SPLIT_RECEIPT_KEY = (requestId: string) => `transport_owner_reconciled:${requestId}`;
const SplitReceipt = z.object({ schemaVersion: z.literal(1), layout: z.literal("split"), requestId: RequestIdSchema, project: z.string().min(1),
  projectId: z.string().min(1), storeId: z.string().min(1), generation: z.number().int().positive(), expected: Hash, fingerprint: Hash, slotDigest: Hash,
  slotId: z.string().min(1), slotNonce: z.string().min(1), dispatchId: z.string().min(1), owner: z.string().min(1),
  actor: z.object({ kind: z.literal("local_operator"), host: z.string(), pid: z.number().int().positive() }).strict(), reason: z.string().min(1).max(1000),
  proof: z.object({ kind: z.literal("same_host_pid_absent"), host: z.string(), pid: z.number().int().positive(), basis: z.literal("ESRCH") }).strict(),
  outcomeDigest: Hash, at: z.number() }).strict();
type SplitReceiptValue = z.infer<typeof SplitReceipt>;
const Charges = z.array(z.object({ task_id: z.string(), input_tokens: z.number(), output_tokens: z.number(), tokens_exact: z.literal(0), lease_incarnation: z.string(), run_count: z.number().int() }).strict());

/** The pinned local services of one split project, resolved by its registered slug (trusted host wiring). */
export interface SplitRecoveryProject {
  identity: ProjectStoreIdentity;
  db: Db;
  now(): number;
  /** The project's own request-ledger recovery, which projects a settled physical receipt into the project store. */
  recover(requestId: string): Promise<{ state: string } | null>;
}
type SplitBroker = Pick<SqliteRequestAccountingBroker, "readReceipt" | "settleAbsentTransportOwner">;

/**
 * Explicit trusted operator recovery for a split installation: a request whose same-host local owner process
 * is proved absent (ESRCH) while the coordination broker still records its physical dispatch intent. One
 * coordination transaction settles the physical request `uncertain` (quota, tokens and paid liability retained,
 * never refunded), releases the exact request slot, and records an idempotent receipt; the project ledger then
 * projects that settlement into the project store. Execution grants are never read for authority or changed.
 */
export class SplitTransportRecovery {
  constructor(private readonly db: Db, private readonly broker: SplitBroker, private readonly project: (slug: string) => SplitRecoveryProject,
    // Trusted dependency injection for tests, never supplied by CLI flags or model arguments.
    private readonly probe: (pid: number) => LocalProcessState = localProcessState) {}
  private local(projectId: string, storeId: string, generation: number, project?: string) {
    const registration = readProjectStoreRegistration(this.db, projectId);
    if (!registration || registration.state !== "registered" || registration.storeId !== storeId || registration.generation !== generation)
      throw new Error("request project store generation is not the registered one");
    if (project !== undefined && registration.slug !== z.string().parse(project)) throw new Error("transport recovery cannot cross project authority");
    const local = this.project(registration.slug), identity = local.identity;
    if (identity.role !== "project" || identity.projectId !== projectId || identity.storeId !== storeId || identity.generation !== generation || identity.slug !== registration.slug)
      throw new Error("request project binding is inconsistent");
    return { ...local, slug: registration.slug, store: new ProjectRequestStore(local.db, identity, () => local.now()) };
  }
  private candidate(requestId: string, project?: string) {
    const global = this.broker.readReceipt(requestId);
    if (!global) throw new Error("no physical request is recorded for this request");
    const local = this.local(global.owner.projectId, global.owner.storeId, global.owner.generation, project);
    const record = local.store.read(requestId);
    if (!record) throw new Error("request project binding is inconsistent");
    local.store.assertGlobalReceipt(record, global);
    if (global.state !== "dispatch_intent" || !global.dispatchId || global.costQuarantined || global.unboundedCost || !record.global.slot)
      throw new Error("only an identified dispatch-intent transport may be reconciled");
    if (!["dispatch_intent", "uncertain"].includes(record.row.phase) || record.row.dispatch_id !== global.dispatchId)
      throw new Error("request and project dispatch bindings disagree");
    if (record.outcome !== null) throw new Error("request has a durable local outcome; project ledger recovery must settle it");
    const physical = z.object({ provider: z.string(), slot_id: z.string(), slot_nonce: z.string() }).strict()
      .parse(this.db.prepare("SELECT provider,slot_id,slot_nonce FROM physical_requests WHERE id=?").get(requestId));
    const slot = SplitRequestSlotSchema.parse(this.db.prepare("SELECT * FROM provider_slots WHERE id=?").get(record.global.slot.id));
    const participants = record.input.participants;
    if (new Set(participants.map(participant => participant.taskId)).size !== participants.length) throw new Error("duplicate request participant identity");
    const leases = z.array(LeaseRefSchema).min(1).max(256).parse(JSON.parse(slot.lease_json));
    if (physical.slot_id !== slot.id || physical.slot_nonce !== slot.nonce || slot.nonce !== record.global.slot.nonce
      || (slot.platform !== physical.provider && slot.platform !== `paid:${physical.provider}`)
      || slot.project_uuid !== global.owner.projectId || slot.store_uuid !== global.owner.storeId || slot.store_generation !== global.owner.generation
      || slot.task_id !== participants[0]!.taskId || canonicalJson(leases) !== canonicalJson(participants.map(participant => participant.lease))
      || participants.some(participant => participant.leaseOwner !== slot.lease_owner))
      throw new Error("request and transport slot immutable identities disagree");
    const model = Model.parse(local.db.prepare("SELECT id,execution_id,gateway_model,project_id,status,finished_at,est_input_tokens,reserved_output_tokens FROM model_requests WHERE id=?").get(requestId));
    if (model.status !== "reserved" || model.finished_at !== null || model.execution_id !== record.input.executionId || model.gateway_model !== record.input.gatewayModel
      || model.project_id !== local.slug || model.est_input_tokens !== record.input.estInputTokens || model.reserved_output_tokens !== record.input.reservedOutputTokens)
      throw new Error("request is already settled or its accounting binding changed");
    const charges = Charges.parse(local.db.prepare("SELECT task_id,input_tokens,output_tokens,tokens_exact,lease_incarnation,run_count FROM request_charges WHERE request_id=? ORDER BY task_id").all(requestId));
    if (charges.length !== participants.length || participants.some(participant => !charges.some(charge => charge.task_id === participant.taskId && charge.lease_incarnation === participant.lease.incarnation && charge.run_count === participant.lease.runCount)))
      throw new Error("request charge binding changed; original evidence retained");
    const owner = processOwner(slot.lease_owner);
    if (owner.host !== hostname()) throw new Error("foreign-host transport ownership cannot be proved locally");
    const slotDigest = digest(slot);
    const snapshotDigest = digest({ layout: "split", requestId, global, phase: record.row.phase, recordFingerprint: record.row.fingerprint, slotDigest, model, charges });
    return { global, local, slot, leases, owner, slotDigest, snapshotDigest, dispatchId: global.dispatchId };
  }
  private active(candidate: ReturnType<SplitTransportRecovery["candidate"]>): boolean {
    const now = candidate.local.now();
    return candidate.leases.some(lease => !!candidate.local.db.prepare("SELECT 1 FROM tasks WHERE id=? AND lease_owner=? AND run_count=? AND lease_incarnation=? AND project_id=? AND lease_expires_at>?").get(lease.taskId, lease.owner, lease.runCount, lease.incarnation, lease.project, now));
  }
  inspect(requestId: string, project?: string) {
    const candidate = this.candidate(RequestIdSchema.parse(requestId), project);
    const state = ProcessState.parse(this.probe(candidate.owner.pid)), activeCapturedLease = this.active(candidate);
    const refusals = [...(state !== "absent" ? [`local owner process is ${state}`] : []), ...(activeCapturedLease ? ["captured task lease remains live"] : [])];
    return Inspection.parse({ requestId, project: candidate.local.slug, snapshotDigest: candidate.snapshotDigest, slotId: candidate.slot.id, slotNonce: candidate.slot.nonce, platform: candidate.slot.platform, dispatchId: candidate.dispatchId, owner: candidate.slot.lease_owner, participantsDigest: digest(candidate.leases), process: { host: candidate.owner.host, pid: candidate.owner.pid, state }, activeCapturedLease, eligible: !refusals.length, refusals });
  }
  private replay(input: z.infer<typeof Decision>, project?: string): SplitReceiptValue | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key=?").get(SPLIT_RECEIPT_KEY(input.requestId)) as { value: string } | undefined;
    if (!row) return null;
    const receipt = SplitReceipt.parse(JSON.parse(row.value)), global = this.broker.readReceipt(input.requestId);
    if (project !== undefined && receipt.project !== z.string().parse(project)) throw new Error("transport recovery cannot cross project authority");
    if (!global || receipt.requestId !== input.requestId || receipt.expected !== input.expected || global.state !== "settled" || global.outcome !== "uncertain"
      || global.outcomeDigest !== OUTCOME_DIGEST || receipt.outcomeDigest !== OUTCOME_DIGEST || global.dispatchId !== receipt.dispatchId || global.fingerprint !== receipt.fingerprint
      || global.owner.projectId !== receipt.projectId || global.owner.storeId !== receipt.storeId || global.owner.generation !== receipt.generation
      || this.db.prepare("SELECT 1 FROM provider_slots WHERE id=?").get(receipt.slotId))
      throw new Error("transport recovery retry differs from its committed receipt");
    return receipt;
  }
  /** Settle and release in the coordination store, then project into the project store (retried by an identical replay). */
  async reconcile(value: unknown, project?: string) {
    const input = Decision.parse(value);
    let receipt = this.replay(input, project), disposition: "fresh" | "replayed" = "replayed";
    if (!receipt) {
      try { receipt = this.settle(input, project); disposition = "fresh"; }
      catch (error) {
        // An identical recovery that committed after this one's replay check (while it read or waited for the
        // coordination lock) is a replay, not a failure. Anything else keeps its original refusal.
        const raced = this.replay(input, project);
        if (!raced) throw error;
        receipt = raced;
      }
    }
    return this.projected(receipt, input.requestId, disposition, project);
  }
  private settle(input: z.infer<typeof Decision>, project?: string): SplitReceiptValue {
    const seen = this.candidate(input.requestId, project);
    if (seen.snapshotDigest !== input.expected) throw new Error("transport recovery snapshot changed; inspect again");
    let committed: SplitReceiptValue | null = null;
    this.broker.settleAbsentTransportOwner({ requestId: input.requestId, fingerprint: seen.global.fingerprint, dispatchId: seen.dispatchId, slot: { id: seen.slot.id, nonce: seen.slot.nonce }, outcomeDigest: OUTCOME_DIGEST }, {
      // Inside the coordination transaction: the evidence is re-read, never taken from the earlier inspection.
      guard: () => {
        const fresh = this.candidate(input.requestId, project);
        if (fresh.snapshotDigest !== input.expected) throw new Error("transport recovery snapshot changed; inspect again");
        if (this.active(fresh)) throw new Error("captured task lease remains live");
        if (ProcessState.parse(this.probe(fresh.owner.pid)) !== "absent") throw new Error("local transport owner is live or absence is unknown");
      },
      commit: () => {
        releaseOwnerAbsentSlot(this.db, seen.slot, OUTCOME_DIGEST);
        committed = SplitReceipt.parse({ schemaVersion: 1, layout: "split", requestId: input.requestId, project: seen.local.slug, projectId: seen.global.owner.projectId, storeId: seen.global.owner.storeId, generation: seen.global.owner.generation, expected: input.expected, fingerprint: seen.global.fingerprint, slotDigest: seen.slotDigest, slotId: seen.slot.id, slotNonce: seen.slot.nonce, dispatchId: seen.dispatchId, owner: seen.slot.lease_owner, actor: { kind: "local_operator", host: hostname(), pid: process.pid }, reason: input.reason, proof: { kind: "same_host_pid_absent", host: seen.owner.host, pid: seen.owner.pid, basis: "ESRCH" }, outcomeDigest: OUTCOME_DIGEST, at: seen.local.now() });
        // A plain INSERT: a concurrent identical recovery loses on the key and never writes a second receipt.
        this.db.prepare("INSERT INTO meta(key,value) VALUES(?,?)").run(SPLIT_RECEIPT_KEY(input.requestId), JSON.stringify(committed));
      },
    });
    return SplitReceipt.parse(committed);
  }
  /** The project store is separate: its projection follows the committed coordination receipt and is retried on replay. */
  private async projected(receipt: SplitReceiptValue, requestId: string, disposition: "fresh" | "replayed", project?: string) {
    let projection: "applied" | "pending" = "pending", projectionError: string | undefined;
    try {
      const local = this.local(receipt.projectId, receipt.storeId, receipt.generation, project), record = local.store.read(requestId);
      if (record && ["settled", "retired"].includes(record.row.phase)) projection = "applied";
      else if ((await local.recover(requestId))?.state === "settled") projection = "applied";
    } catch (error) { projectionError = error instanceof Error ? error.message : String(error); }
    return { ...receipt, disposition, projection, ...(projectionError ? { projectionError } : {}) };
  }
}
