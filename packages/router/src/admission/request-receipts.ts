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
  /** Top-level bounded GC commits independently of a later admission refusal. */
  prune(): { receipts: number; keys: number } {
    if (this.db.inTransaction) throw new Error("request receipt cleanup requires a top-level transaction");
    return immediate(this.db, () => {
      const now = this.now();
      const receipts = this.db.prepare("DELETE FROM request_protocol WHERE request_id IN (SELECT request_id FROM request_protocol WHERE state='settled' AND expires_at<? AND NOT EXISTS(SELECT 1 FROM provider_slots s WHERE s.id=json_extract(request_protocol.binding_json,'$.slot.id')) LIMIT 64)").run(now).changes;
      const keys = this.db.prepare("DELETE FROM request_protocol_keys WHERE id IN (SELECT k.id FROM request_protocol_keys k LEFT JOIN request_protocol p ON p.request_id=k.id WHERE k.expires_at<? AND p.request_id IS NULL LIMIT 64)").run(now).changes;
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
      if (this.db.prepare("SELECT 1 FROM request_protocol_keys WHERE id=?").get(parsed.requestId)) throw new Error("request ID was purged and cannot be reused");
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
  purgeProject(project: string): { receipts: number } {
    return immediate(this.db, () => {
      const blocked = this.blockers(project);
      if (blocked.requests || blocked.slots) throw new Error("project has unresolved request protocol/transport holds");
      const receipts = this.db.prepare("DELETE FROM request_protocol WHERE request_id IN (SELECT request_id FROM request_protocol_projects WHERE project_id=?)").run(project).changes;
      return { receipts };
    });
  }
}
