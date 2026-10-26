import { createHash } from "node:crypto";
import { z } from "zod";
import type { Db } from "../storage/db.js";
import { immediate } from "../storage/db.js";
import { canonicalJson } from "../storage/tasks.js";
import { assertStoreRole } from "../storage/store-role.js";
import { ProjectStoreIdentitySchema, type ProjectStoreIdentity } from "../projects/store-identity.js";
import { accountingIdentityDigest, accountingOwnerDigest, GlobalReceiptSchema, ReserveGlobalRequestSchema, globalReservationFingerprint,
  type GlobalReceipt, type ReserveGlobalRequest } from "./accounting-broker.js";
import { ReserveRequestDTOSchema, ReservationDTOSchema, RequestIdSchema, RequestOutcomeDTOSchema,
  type ReserveRequestDTO, type ReservationDTO, type RequestOutcomeDTO } from "./request-ledger.js";

export const projectRequestDigest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
export const ProjectRequestPhaseSchema = z.enum(["prepared", "bound", "dispatch_intent", "settled", "retired", "uncertain", "quarantined"]);
export type ProjectRequestPhase = z.infer<typeof ProjectRequestPhaseSchema>;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const rowSchema = z.object({ request_id: RequestIdSchema, project_id: z.string(), owner_json: z.string().max(8192), fingerprint: hash,
  binding_json: z.string().max(262144), global_json: z.string().max(131072), reservation_json: z.string().max(262144), phase: ProjectRequestPhaseSchema,
  global_receipt_json: z.string().max(16384).nullable(), dispatch_id: z.string().max(300).nullable(), transport_consumed: z.union([z.literal(0), z.literal(1)]),
  outcome_json: z.string().max(1048576).nullable(), outcome_digest: hash.nullable(), reason_code: z.string().max(200).nullable(),
  created_at: z.number().int().nonnegative(), updated_at: z.number().int().nonnegative() }).strict();
export interface ProjectRequestRecord {
  row: z.infer<typeof rowSchema>;
  input: ReserveRequestDTO;
  global: ReserveGlobalRequest;
  reservation: ReservationDTO;
  receipt: GlobalReceipt | null;
  outcome: RequestOutcomeDTO | null;
}
export function projectGlobalRequest(identity: ProjectStoreIdentity, input: ReserveRequestDTO, fingerprint: string, dispatchNotAfter: number): ReserveGlobalRequest {
  return ReserveGlobalRequestSchema.parse({ requestId: input.requestId,
    owner: { installationId: identity.installationId, projectId: identity.projectId, storeId: identity.storeId, generation: identity.generation },
    payloadDigest: input.payloadDigest, bindingDigest: fingerprint, endpointId: input.endpointId, keyRef: input.keyRef || null,
    providerReservationId: input.providerReservationId, slot: input.slot?.id ? { id: input.slot.id, nonce: input.slot.nonce } : null,
    estimatedInputTokens: input.estInputTokens, reservedOutputTokens: input.reservedOutputTokens, dispatchNotAfter,
    participants: input.participants.map(part => ({ taskDigest: accountingIdentityDigest(identity.projectId, part.taskId),
      ownerDigest: accountingOwnerDigest(part.lease.owner), incarnation: part.lease.incarnation, runCount: part.lease.runCount })) });
}
/** Private persistence primitives; caller owns local->global ordering and authority validation. */
export class ProjectRequestStore {
  readonly identity: ProjectStoreIdentity;
  constructor(readonly db: Db, identity: ProjectStoreIdentity, readonly now: () => number) {
    this.identity = ProjectStoreIdentitySchema.parse(identity); this.assertOwner();
  }
  assertOwner(): void { assertStoreRole(this.db, this.identity); }
  transaction<T>(work: () => T): T {
    if (this.db.inTransaction) throw new Error("Project protocol requires a top-level local transaction");
    this.assertOwner(); return immediate(this.db, work);
  }
  read(requestId: string): ProjectRequestRecord | null {
    this.assertOwner();
    const value = this.db.prepare("SELECT * FROM project_request_protocol WHERE request_id=?").get(RequestIdSchema.parse(requestId));
    if (!value) return null;
    const row = rowSchema.parse(value), owner = ProjectStoreIdentitySchema.parse(JSON.parse(row.owner_json));
    const input = ReserveRequestDTOSchema.parse(JSON.parse(row.binding_json)), global = ReserveGlobalRequestSchema.parse(JSON.parse(row.global_json));
    const reservation = ReservationDTOSchema.parse(JSON.parse(row.reservation_json));
    if (canonicalJson(owner) !== canonicalJson(this.identity) || row.project_id !== this.identity.slug
      || row.request_id !== input.requestId || projectRequestDigest(input) !== row.fingerprint
      || canonicalJson(global) !== canonicalJson(projectGlobalRequest(this.identity, input, row.fingerprint, global.dispatchNotAfter))
      || reservation.fingerprint !== row.fingerprint || reservation.requestId !== row.request_id
      || canonicalJson(reservation) !== canonicalJson(this.reservation(input, row.fingerprint))) throw new Error("Project request immutable binding changed");
    const receipt = row.global_receipt_json ? GlobalReceiptSchema.parse(JSON.parse(row.global_receipt_json)) : null;
    if (receipt) this.assertGlobalReceipt({ row, input, global, reservation, receipt: null, outcome: null }, receipt);
    const outcome = row.outcome_json ? RequestOutcomeDTOSchema.parse(JSON.parse(row.outcome_json)) : null;
    if ((outcome === null) !== (row.outcome_digest === null) || (outcome && projectRequestDigest(outcome) !== row.outcome_digest)) throw new Error("Private outcome digest changed");
    return { row, input, global, reservation, receipt, outcome };
  }
  reservation(input: ReserveRequestDTO, fingerprint: string): ReservationDTO {
    return ReservationDTOSchema.parse({ requestId: input.requestId, fingerprint, disposition: "fresh", executionId: input.executionId,
      participants: input.participants, estInputTokens: input.estInputTokens, reservedOutputTokens: input.reservedOutputTokens,
      ...(input.paid ? { paid: input.paid } : {}) });
  }
  bound(value: ReservationDTO): ProjectRequestRecord {
    const parsed = ReservationDTOSchema.parse(value), record = this.read(parsed.requestId);
    if (!record || canonicalJson({ ...parsed, disposition: "fresh" }) !== canonicalJson(record.reservation)) throw new Error("Project request reservation is unknown or changed");
    return record;
  }
  assertGlobalReceipt(record: ProjectRequestRecord, input: GlobalReceipt): GlobalReceipt {
    const receipt = GlobalReceiptSchema.parse(input);
    if (receipt.requestId !== record.row.request_id || receipt.fingerprint !== globalReservationFingerprint(record.global)
      || canonicalJson(receipt.owner) !== canonicalJson(record.global.owner)) throw new Error("Global receipt does not match the original project preparation");
    return receipt;
  }
  insert(input: ReserveRequestDTO, deadline: number): ProjectRequestRecord {
    const parsed = ReserveRequestDTOSchema.parse(input), fingerprint = projectRequestDigest(parsed);
    const packed = canonicalJson(parsed), global = projectGlobalRequest(this.identity, parsed, fingerprint, deadline);
    if (Buffer.byteLength(packed) > 262144 || parsed.participants.length > 128) throw new Error("Private preparation exceeds supported bounds");
    if ((this.db.prepare("SELECT COUNT(*) AS n FROM project_request_protocol WHERE phase NOT IN ('settled','retired')").get() as { n: number }).n >= 100000) throw new Error("Unresolved project request capacity exhausted");
    const reservation = this.reservation(parsed, fingerprint), now = this.now();
    this.db.prepare(`INSERT INTO project_request_protocol(request_id,project_id,owner_json,fingerprint,binding_json,global_json,reservation_json,phase,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,'prepared',?,?)`).run(parsed.requestId, this.identity.slug, canonicalJson(this.identity), fingerprint, packed, canonicalJson(global), canonicalJson(reservation), now, now);
    const hold = this.db.prepare(`INSERT INTO project_request_holds(request_id,task_id,project_id,lease_incarnation,run_count,input_tokens,output_tokens,paid_usd)
      VALUES(?,?,?,?,?,?,?,?)`);
    for (const part of parsed.participants) hold.run(parsed.requestId, part.taskId, this.identity.slug, part.lease.incarnation, part.lease.runCount,
      part.estInputTokens, part.reservedOutputTokens, parsed.paid ? Math.ceil(parsed.paid.worstCaseUsd * 1e6) / 1e6 / parsed.participants.length : 0);
    return this.read(parsed.requestId)!;
  }
  update(record: ProjectRequestRecord, phase: ProjectRequestPhase, receipt?: GlobalReceipt, reason: string | null = null): void {
    ProjectRequestPhaseSchema.parse(phase); z.string().max(200).regex(/^[a-z_]+$/).nullable().parse(reason);
    const validated = receipt ? this.assertGlobalReceipt(record, receipt) : null;
    this.db.prepare("UPDATE project_request_protocol SET phase=?,global_receipt_json=COALESCE(?,global_receipt_json),reason_code=?,updated_at=? WHERE request_id=? AND fingerprint=?")
      .run(phase, validated ? canonicalJson(validated) : null, reason, this.now(), record.row.request_id, record.row.fingerprint);
  }
  saveOutcome(record: ProjectRequestRecord, value: RequestOutcomeDTO): RequestOutcomeDTO {
    const outcome = RequestOutcomeDTOSchema.parse(value), packed = canonicalJson(outcome), digest = projectRequestDigest(outcome);
    if (Buffer.byteLength(packed) > 1048576) throw new Error("Private outcome exceeds supported bounds");
    if (record.row.outcome_digest !== null && record.row.outcome_digest !== digest) throw new Error("Conflicting private outcome; original evidence retained");
    this.db.prepare("UPDATE project_request_protocol SET outcome_json=?,outcome_digest=?,updated_at=? WHERE request_id=?")
      .run(packed, digest, this.now(), record.row.request_id);
    return outcome;
  }
  markDispatch(record: ProjectRequestRecord, dispatchId: string): void {
    z.string().min(1).max(300).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/).parse(dispatchId);
    if (record.row.dispatch_id !== null && record.row.dispatch_id !== dispatchId) throw new Error("Project dispatch identity changed");
    this.db.prepare("UPDATE project_request_protocol SET phase='dispatch_intent',dispatch_id=?,updated_at=? WHERE request_id=?")
      .run(dispatchId, this.now(), record.row.request_id);
  }
  releasePreparation(record: ProjectRequestRecord): void {
    this.db.prepare("UPDATE project_request_holds SET active=0 WHERE request_id=?").run(record.row.request_id);
  }
  resizePreparation(record: ProjectRequestRecord, receipt: GlobalReceipt): void {
    this.assertGlobalReceipt(record, receipt);
    this.db.prepare("UPDATE project_request_holds SET paid_usd=MAX(paid_usd,?) WHERE request_id=? AND active=1")
      .run((receipt.liabilityUsd ?? receipt.reservedUsd ?? 0) / record.input.participants.length, record.row.request_id);
  }
  pendingForTask(taskId: string, excluding: string): ProjectRequestRecord[] {
    const ids = z.array(z.object({ request_id: RequestIdSchema }).strict()).parse(this.db.prepare(`SELECT p.request_id FROM project_request_protocol p
      JOIN project_request_holds h ON h.request_id=p.request_id WHERE h.task_id=? AND p.request_id!=? AND p.phase NOT IN ('settled','retired')`).all(taskId, excluding));
    return ids.map(row => this.read(row.request_id)!);
  }
}
