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
