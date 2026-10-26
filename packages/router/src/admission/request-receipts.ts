import { createHash } from "node:crypto";
import { z } from "zod";
import { immediate, type Db } from "../storage/db.js";
import { canonicalJson } from "../storage/tasks.js";
import { ReserveRequestDTOSchema, ReservationDTOSchema, RequestIdSchema, type ReserveRequestDTO, type ReservationDTO, type RequestOutcomeDTO } from "./request-ledger.js";
const WINDOW = 7 * 86400000, MAX_ROWS = 100000;
const Row = z.object({ request_id: RequestIdSchema, fingerprint: z.string().regex(/^[a-f0-9]{64}$/), binding_json: z.string().max(262144), reservation_json: z.string().max(262144), state: z.enum(["reserved", "dispatch_intent", "settled"]), dispatch_id: z.string().nullable(), outcome_digest: z.string().nullable(), created_at: z.number(), expires_at: z.number() });
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
/** Private immutable protocol bindings. Opaque anti-replay keys outlive scoped purge. */
export class RequestReceipts {
  constructor(readonly db: Db, readonly now: () => number = Date.now) {}
  private row(id: string) { return Row.optional().parse(this.db.prepare("SELECT * FROM request_protocol WHERE request_id=?").get(RequestIdSchema.parse(id))); }
  private bound(reservation: ReservationDTO) {
    const parsed = ReservationDTOSchema.parse(reservation), row = this.row(parsed.requestId);
    if (!row || row.fingerprint !== parsed.fingerprint) throw new Error("unknown, purged or mismatched request receipt");
    const bound = ReservationDTOSchema.parse(JSON.parse(row.reservation_json));
    if (digest({ ...parsed, disposition: "fresh" }) !== digest({ ...bound, disposition: "fresh" })) throw new Error("request receipt binding changed");
    return { row, bound };
  }
  /** Validated immutable accounting authority for explicit local operator reconciliation. */
  inspectBinding(requestId: string) {
    const row = this.row(RequestIdSchema.parse(requestId));
    if (!row) throw new Error("request receipt is missing or retired");
    const binding = ReserveRequestDTOSchema.parse(JSON.parse(row.binding_json));
    const reservation = ReservationDTOSchema.parse(JSON.parse(row.reservation_json));
    if (reservation.requestId !== row.request_id || reservation.fingerprint !== row.fingerprint) throw new Error("request reservation identity differs from its original receipt");
    this.bound(reservation);
    if (binding.requestId !== row.request_id || digest(binding) !== row.fingerprint ||
      reservation.executionId !== binding.executionId || reservation.estInputTokens !== binding.estInputTokens || reservation.reservedOutputTokens !== binding.reservedOutputTokens ||
      canonicalJson(reservation.participants) !== canonicalJson(binding.participants) || canonicalJson(reservation.paid ?? null) !== canonicalJson(binding.paid ?? null))
      throw new Error("request receipt immutable binding is inconsistent");
    return { binding, reservation, fingerprint: row.fingerprint, state: row.state, dispatchId: row.dispatch_id, outcomeDigest: row.outcome_digest };
  }
  /** Top-level bounded GC commits independently of a later admission refusal. */
  prune(): { receipts: number; keys: number } {
    if (this.db.inTransaction) throw new Error("request receipt cleanup requires a top-level transaction");
    return immediate(this.db, () => {
      const now = this.now();
      const receipts = this.db.prepare("DELETE FROM request_protocol WHERE request_id IN (SELECT request_id FROM request_protocol WHERE state='settled' AND expires_at<? AND NOT EXISTS(SELECT 1 FROM provider_slots s WHERE s.id=json_extract(request_protocol.binding_json,'$.slot.id')) LIMIT 64)").run(now).changes;
      this.db.prepare("DELETE FROM request_deletion_tombstones WHERE request_id IN (SELECT t.request_id FROM request_deletion_tombstones t WHERE t.expires_at<? AND NOT EXISTS(SELECT 1 FROM provider_slots s WHERE s.id=t.slot_id) LIMIT 64)").run(now);
      const keys = this.db.prepare("DELETE FROM request_protocol_keys WHERE id IN (SELECT k.id FROM request_protocol_keys k LEFT JOIN request_protocol p ON p.request_id=k.id WHERE k.expires_at<? AND p.request_id IS NULL AND NOT EXISTS(SELECT 1 FROM request_deletion_tombstones t WHERE t.request_id=k.id) LIMIT 64)").run(now).changes;
      return { receipts, keys };
    });
  }
  reserve(input: ReserveRequestDTO, change: () => unknown): ReservationDTO {
    // A savepoint cannot independently commit GC. Default Gate invokes this outside transactions.
    if (this.db.inTransaction) throw new Error("request reservation cannot run inside an external transaction");
    ReserveRequestDTOSchema.parse(input);
    this.prune();
    return immediate(this.db, () => {
      const parsed = ReserveRequestDTOSchema.parse(input), now = this.now(), issued = Number.parseInt(parsed.requestId.split("_")[1]!, 36);
      if (!Number.isSafeInteger(issued) || issued > now + 60000 || issued < now - WINDOW) throw new Error("request ID is outside retry window");
      const packed = canonicalJson(parsed);
      if (Buffer.byteLength(packed) > 262144 || parsed.participants.length > 256) throw new Error("request binding exceeds limit");
      const fingerprint = digest(parsed), previous = this.row(parsed.requestId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new Error("request ID reused with different payload");
        return { ...ReservationDTOSchema.parse(JSON.parse(previous.reservation_json)), disposition: "replayed" };
      }
      if (this.db.prepare("SELECT 1 FROM request_protocol_keys WHERE id=?").get(parsed.requestId)
        || this.db.prepare("SELECT 1 FROM request_deletion_tombstones WHERE request_id=?").get(parsed.requestId)) throw new Error("request ID was purged and cannot be reused");
      if ((this.db.prepare("SELECT COUNT(*) FROM request_protocol_keys").pluck().get() as number) >= MAX_ROWS) throw new Error("request receipt capacity exhausted; reconcile retained requests before retry");
      const projects = [...new Set(parsed.participants.map(p => p.lease.project))];
      if (projects.length > 1) throw new Error("request cannot mix project authorities");
      for (const p of parsed.participants) {
        if (!this.db.prepare("SELECT 1 FROM execution_members WHERE execution_id=? AND task_id=?").get(parsed.executionId, p.taskId)) throw new Error("request execution membership missing");
      }
      const reserved = ReservationDTOSchema.parse({ ...(change() as object), fingerprint, disposition: "fresh" });
      this.db.prepare("INSERT INTO request_protocol_keys(id,expires_at) VALUES(?,?)").run(parsed.requestId, now + WINDOW);
      this.db.prepare("INSERT INTO request_protocol(request_id,fingerprint,binding_json,reservation_json,state,created_at,expires_at) VALUES(?,?,?,?,'reserved',?,?)").run(parsed.requestId, fingerprint, packed, JSON.stringify(reserved), now, now + WINDOW);
      for (const project of projects) this.db.prepare("INSERT INTO request_protocol_projects(request_id,project_id) VALUES(?,?)").run(parsed.requestId, project);
      return reserved;
    });
  }
  private slot(input: ReserveRequestDTO): void {
    if (input.slot?.id && !this.db.prepare("SELECT 1 FROM provider_slots WHERE id=? AND nonce=? AND kind='request' AND uncertain=0").get(input.slot.id, input.slot.nonce)) throw new Error("physical request slot ownership lost");
  }
  beginDispatch(reservation: ReservationDTO, dispatchId: string, assert: (participants: ReservationDTO["participants"]) => void): { disposition: "fresh" | "replayed" } {
    return immediate(this.db, () => {
      z.string().min(1).max(100).parse(dispatchId);
      const { row, bound } = this.bound(reservation);
      if (row.dispatch_id !== null) {
        if (row.dispatch_id !== dispatchId) throw new Error("request dispatch identity changed");
        return { disposition: "replayed" as const };
      }
      if (row.state !== "reserved") throw new Error("request is already settled");
      assert(bound.participants);
      this.slot(ReserveRequestDTOSchema.parse(JSON.parse(row.binding_json)));
      this.db.prepare("UPDATE request_protocol SET state='dispatch_intent',dispatch_id=? WHERE request_id=?").run(dispatchId, row.request_id);
      return { disposition: "fresh" as const };
    });
  }
  assertDispatch(reservation: ReservationDTO, dispatchId: string): void {
    const { row } = this.bound(reservation);
    if (row.state !== "dispatch_intent" || row.dispatch_id !== dispatchId) throw new Error("request dispatch generation lost");
    this.slot(ReserveRequestDTOSchema.parse(JSON.parse(row.binding_json)));
  }
  reconcile(reservation: ReservationDTO, outcome: RequestOutcomeDTO, change: (bound: ReservationDTO) => void): void {
    immediate(this.db, () => {
      const { row, bound } = this.bound(reservation), fingerprint = digest(outcome);
      if (row.state === "settled") {
        if (row.outcome_digest !== fingerprint) throw new Error("conflicting request settlement; original accounting retained");
        return;
      }
      if (row.state === "reserved" && outcome.kind !== "failed") throw new Error("unintended request cannot have consumed outcome");
      // Consumed transport evidence belongs to this original request even after
      // task deletion/recreation. Accounting's charge CAS cannot target a new incarnation.
      change(bound);
      this.db.prepare("UPDATE request_protocol SET state='settled',outcome_digest=? WHERE request_id=?").run(fingerprint, row.request_id);
    });
  }
  receipt(id: string): { state: "reserved" | "dispatch_intent" | "settled" } | null { const row = this.row(id); return row ? { state: row.state } : null; }
  blockers(project: string): { requests: number; slots: number } {
    const requests = this.db.prepare("SELECT COUNT(*) FROM request_protocol p JOIN request_protocol_projects s ON s.request_id=p.request_id WHERE s.project_id=? AND p.state!='settled'").pluck().get(z.string().parse(project)) as number;
    const slots = this.db.prepare("SELECT COUNT(*) FROM provider_slots WHERE kind='request' AND (nonce IS NOT NULL OR lease_json IS NOT NULL) AND (COALESCE(json_valid(lease_json),0)=0 OR EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(lease_json) THEN lease_json ELSE '[]' END) WHERE json_extract(value,'$.project')=?))").pluck().get(project) as number;
    return { requests, slots };
  }
  /** Check authority before destructive cleanup; unknown/mixed ownership remains a refusal. */
  assertProjectPurge(project: string): void {
    z.string().parse(project);
    if (this.db.prepare("SELECT 1 FROM request_protocol_projects a JOIN request_protocol_projects b ON a.request_id=b.request_id WHERE a.project_id=? AND b.project_id!=? LIMIT 1").get(project, project)) throw new Error("request recovery cannot prove exclusive project ownership");
    const rows = this.db.prepare("SELECT p.* FROM request_protocol p JOIN request_protocol_projects s ON s.request_id=p.request_id WHERE s.project_id=?").all(project);
    for (const value of rows) {
      const row = Row.parse(value), binding = ReserveRequestDTOSchema.parse(JSON.parse(row.binding_json));
      if (binding.participants.some(p => p.lease.project !== project)) throw new Error("request recovery cannot cross project authority");
      this.bound(ReservationDTOSchema.parse(JSON.parse(row.reservation_json)));
      if (binding.slot?.id) {
        const slot = this.db.prepare("SELECT nonce FROM provider_slots WHERE id=?").get(binding.slot.id) as { nonce: string | null } | undefined;
        if (slot && slot.nonce !== binding.slot.nonce) throw new Error("unresolved transport identity mismatch; recovery evidence retained");
      }
    }
    for (const slot of this.projectSlots(project)) {
      if (this.db.prepare("SELECT 1 FROM provider_slots s JOIN tasks t ON t.id=s.task_id WHERE s.id=? AND t.project_id!=? LIMIT 1").get(slot.id, project)
        || this.db.prepare("SELECT 1 FROM request_protocol p JOIN request_protocol_projects s ON s.request_id=p.request_id WHERE json_extract(p.binding_json,'$.slot.id')=? AND s.project_id!=? LIMIT 1").get(slot.id, project)) throw new Error("transport recovery cannot cross project authority");
      if (slot.lease_json !== null) {
        const leases = z.array(z.object({ project: z.string() }).passthrough()).parse(JSON.parse(slot.lease_json));
        if (leases.some(lease => lease.project !== project)) throw new Error("transport recovery cannot cross project authority");
      }
    }
  }
  private projectSlots(project: string) {
    return z.array(z.object({ id: z.string(), nonce: z.string().nullable(), lease_json: z.string().nullable() })).parse(this.db.prepare(`SELECT id,nonce,lease_json FROM provider_slots WHERE kind='request' AND (nonce IS NOT NULL OR lease_json IS NOT NULL)
      AND (task_id IN (SELECT id FROM tasks WHERE project_id=@project)
        OR EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(lease_json) THEN lease_json ELSE '[]' END) WHERE json_extract(value,'$.project')=@project)
        OR id IN (SELECT json_extract(p.binding_json,'$.slot.id') FROM request_protocol p JOIN request_protocol_projects s ON s.request_id=p.request_id WHERE s.project_id=@project))`).all({ project }));
  }
  retention(project: string): { pendingRequests: number; retainedTransportHolds: number } {
    return { pendingRequests: this.blockers(project).requests, retainedTransportHolds: this.projectSlots(project).length };
  }
  /** Revoke dispatch and remove private bindings without pretending remote transport stopped. */
  purgeProject(project: string): { receipts: number } {
    return immediate(this.db, () => {
      this.assertProjectPurge(project);
      const slots = this.projectSlots(project), now = this.now();
      const rows = this.db.prepare("SELECT p.* FROM request_protocol p JOIN request_protocol_projects s ON s.request_id=p.request_id WHERE s.project_id=?").all(project);
      for (const value of rows) {
        const row = Row.parse(value), binding = ReserveRequestDTOSchema.parse(JSON.parse(row.binding_json));
        const reservation = ReservationDTOSchema.parse(JSON.parse(row.reservation_json));
        this.db.prepare("INSERT INTO request_deletion_tombstones(request_id,fingerprint,reservation_digest,slot_id,slot_nonce,retired_at,expires_at) VALUES(?,?,?,?,?,?,?)")
          .run(row.request_id, row.fingerprint, digest({ ...reservation, disposition: "fresh" }), binding.slot?.id ?? null, binding.slot?.nonce ?? null, now, row.expires_at);
        if (row.state !== "settled") {
          const status = row.state === "reserved" ? "failed" : "uncertain";
          // Already-recorded success/failure is authoritative even if its acknowledgement was lost.
          const changed = this.db.prepare("UPDATE model_requests SET status=?,finished_at=?,error_kind='project_deleted',error_message='Project deleted; pending request retired without replay' WHERE id=? AND status='reserved'").run(status, now, row.request_id).changes;
          if (changed) {
            this.db.prepare("UPDATE paid_spend SET actual_usd=CASE WHEN ?='failed' THEN 0 ELSE reserved_usd END,cost_basis=CASE WHEN ?='failed' THEN 'not_billed' ELSE 'uncertain' END,settled_at=? WHERE request_id=? AND settled_at IS NULL").run(status, status, now, row.request_id);
            this.db.prepare("UPDATE model_requests SET estimated_cost_usd=(SELECT actual_usd FROM paid_spend WHERE request_id=?) WHERE id=? AND EXISTS(SELECT 1 FROM paid_spend WHERE request_id=?)").run(row.request_id, row.request_id, row.request_id);
          }
        }
      }
      for (const slot of slots) {
        // Keep exact physical identity/nonce and platform capacity; strip task/project authority.
        this.db.prepare("UPDATE provider_slots SET uncertain=1,task_id='',holder='',lease_owner=NULL,lease_json='[]' WHERE id=? AND ((nonce IS NULL AND ? IS NULL) OR nonce=?)").run(slot.id, slot.nonce, slot.nonce);
      }
      const receipts = this.db.prepare("DELETE FROM request_protocol WHERE request_id IN (SELECT request_id FROM request_protocol_projects WHERE project_id=?)").run(project).changes;
      return { receipts };
    });
  }
}
