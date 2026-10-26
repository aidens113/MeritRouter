import { z } from "zod";
import { QUALIFICATION_PROJECT } from "../qualification/registry.js";
import type { Db } from "./db.js";
import { ProjectEvidenceScope } from "./project-evidence-scope.js";
import { immediate } from "./db.js";
import { CAPTURE_LIMITS as L, CapturePayloadSchema, CaptureOutcomeSchema, CapturedInputSchema, CapturedOutputSchema, CaptureOmissionSchema, RequestCaptureViewSchema, captureBytes, captureTreeWithinBounds, type CaptureInputProjection, type CaptureOutputProjection, type CaptureOutcome, type CapturePayload, type RequestCaptureView, type RequestCaptureStore } from "../gateway/request-capture.js";

const Scope = z.array(z.string().min(1).max(128)).max(256);
const Input = z.object({ input: CapturedInputSchema, omissions: CaptureOmissionSchema.array().max(128), originalBytes: z.number().int().nonnegative().nullable() }).strict();
const Output = z.object({ output: CapturedOutputSchema, omissions: CaptureOmissionSchema.array().max(128), originalBytes: z.number().int().nonnegative().nullable() }).strict();
const Request = z.object({ project_id: z.string(), status: z.string() });
const Row = z.object({ request_id: z.string(), project_id: z.string(), scope_json: z.string(), payload_json: z.string().nullable(), bytes: z.number().int().nonnegative().max(L.recordBytes), phase: z.enum(["reserved", "dispatch_intent", "not_dispatched"]), unavailable_reason: z.string().nullable(), created_at: z.number().int().nonnegative(), expires_at: z.number().int().nonnegative() });
type Row = z.infer<typeof Row>;
const empty = (): CapturePayload => ({ input: null, output: null, outcome: null, omissions: [], originalBytes: null });

/** Private SQLite payload store. Never exposes an artifact reference, disk path, or cross-project payload. */
export class RequestCaptures implements RequestCaptureStore {
  private readonly ownership:ProjectEvidenceScope;
  constructor(private readonly db: Db, private readonly now: () => number = Date.now) {this.ownership=new ProjectEvidenceScope(db);}

  private request(id: string) {
    return Request.safeParse(this.db.prepare("SELECT project_id,status FROM model_requests WHERE id=?").get(id));
  }
  private registered(project: string): boolean {
    return project === QUALIFICATION_PROJECT || !!this.db.prepare("SELECT 1 FROM projects WHERE id=?").get(project);
  }
  private scope(id: string): { projects: string[]; unknown: boolean } {
    const rows = this.db.prepare("SELECT t.project_id,p.id AS registered_project FROM request_charges c LEFT JOIN tasks t ON t.id=c.task_id LEFT JOIN projects p ON p.id=t.project_id WHERE c.request_id=? LIMIT 257").all(id);
    if (rows.length > 256) return { projects: [], unknown: true };
    const projects: string[] = []; let unknown = false;
    for (const row of rows) {
      const p = z.object({ project_id: z.string().min(1).max(128), registered_project: z.string().nullable() }).safeParse(row);
      if (!p.success || (p.data.project_id !== QUALIFICATION_PROJECT && p.data.project_id !== p.data.registered_project)) unknown = true;
      else if (!projects.includes(p.data.project_id)) projects.push(p.data.project_id);
    }
    return { projects: projects.sort(), unknown };
  }
  private row(id: string): Row | null {
    this.ownership.assert();
    // Never materialize an oversized corrupted DB payload in the JS process.
    const raw = this.db.prepare("SELECT request_id,project_id,scope_json,CASE WHEN length(CAST(payload_json AS BLOB))<=1048576 THEN payload_json ELSE NULL END AS payload_json,bytes,phase,unavailable_reason,created_at,expires_at FROM request_captures WHERE request_id=?").get(id);
    if(!raw)return null;const row=Row.parse(raw);this.ownership.assertProject(row.project_id);return row;
  }
  private payload(row: Row): CapturePayload {
    if (!row.payload_json || Buffer.byteLength(row.payload_json) + Buffer.byteLength(row.scope_json) + 256 !== row.bytes) throw new Error("capture byte length mismatch");
    const raw: unknown = JSON.parse(row.payload_json);
    if (!captureTreeWithinBounds(raw)) throw new Error("capture structure exceeds limits");
    const p = CapturePayloadSchema.parse(raw);
    if ((p.input && captureBytes(p.input) > L.inputBytes) || (p.output && captureBytes(p.output) > L.outputBytes)) throw new Error("capture section exceeds limit");
    return p;
  }
  private packed(payload: CapturePayload, scopeJson: string) {
    if (!captureTreeWithinBounds(payload)) throw new Error("capture structure exceeds limits");
    const json = JSON.stringify(CapturePayloadSchema.parse(payload));
    const bytes = Buffer.byteLength(json) + Buffer.byteLength(scopeJson) + 256;
    if (bytes > L.recordBytes) throw new Error("capture record exceeds byte limit");
    return { json, bytes };
  }
  async begin(requestId: string, raw: CaptureInputProjection, participantTaskIds: readonly string[]): Promise<void> {
    this.ownership.assert();
    for(const taskId of participantTaskIds)this.ownership.assertTask(taskId);
    const expected = z.array(z.string().min(1).max(128)).max(256).parse(participantTaskIds).sort();
    if (!captureTreeWithinBounds(raw)) throw new Error("capture input structure exceeds limits");
    const projection = Input.parse(raw);
    if (captureBytes(projection.input) > L.inputBytes) throw new Error("capture input exceeds byte limit");
    immediate(this.db, () => {
      if (this.db.prepare("SELECT 1 FROM request_deletion_tombstones WHERE request_id=?").get(requestId)) throw new Error("capture request was purged and cannot be recreated");
      const request = this.request(requestId); if (!request.success) throw new Error("capture requires an admitted request");
      this.ownership.assertProject(request.data.project_id);
      const prior = this.row(requestId);
      if (prior) {
        if (!prior.payload_json || JSON.stringify(this.payload(prior).input) === JSON.stringify(projection.input)) return;
        throw new Error("immutable capture input conflict");
      }
      this.prune(64);
      const scope = this.scope(requestId);
      const charged = z.array(z.string()).parse(this.db.prepare("SELECT task_id FROM request_charges WHERE request_id=? ORDER BY task_id LIMIT 257").pluck().all(requestId));
      if (JSON.stringify(expected) !== JSON.stringify(charged)) scope.unknown = true;
      if (!scope.projects.length && request.data.project_id) { scope.projects.push(request.data.project_id); if (!this.registered(request.data.project_id)) scope.unknown = true; }
      const scopeJson = JSON.stringify(Scope.parse(scope.projects));
      const reason = scope.unknown ? "scope_unavailable" : scope.projects.length > 1 ? "mixed_project_payload" : expected.length && scope.projects[0] !== request.data.project_id ? "scope_unavailable" : null;
      const payload = reason ? empty() : { input: projection.input, output: null, outcome: null, omissions: projection.omissions, originalBytes: projection.originalBytes };
      const packed = this.packed(payload, scopeJson);
      if (!this.room(request.data.project_id, packed.bytes, 1)) return; // Observational refusal; never evict accounting.
      const now = this.now();
      this.db.prepare("INSERT INTO request_captures(request_id,project_id,scope_json,payload_json,bytes,phase,unavailable_reason,created_at,expires_at) VALUES (?,?,?,?,?,'reserved',?,?,?)").run(requestId, request.data.project_id, scopeJson, reason ? null : packed.json, reason ? Buffer.byteLength(scopeJson) + 256 : packed.bytes, reason, now, now + L.retentionMs);
    });
  }
  async dispatched(requestId: string): Promise<void> {
    this.ownership.assert();if(this.ownership.project!==null)this.row(requestId);
    this.db.prepare("UPDATE request_captures SET phase='dispatch_intent' WHERE request_id=? AND phase='reserved'").run(requestId);
  }
  async complete(requestId: string, rawOutcome: CaptureOutcome, rawProjection?: CaptureOutputProjection, notDispatched = false): Promise<void> {
    this.ownership.assert();
    if (rawProjection && !captureTreeWithinBounds(rawProjection)) throw new Error("capture output structure exceeds limits");
    const outcome = CaptureOutcomeSchema.parse(rawOutcome), projection = rawProjection ? Output.parse(rawProjection) : undefined;
    if (projection && captureBytes(projection.output) > L.outputBytes) throw new Error("capture output exceeds byte limit");
    immediate(this.db, () => {
      const row = this.row(requestId); if (!row || row.unavailable_reason || !row.payload_json) return;
      const payload = this.payload(row), output = projection?.output ?? null;
      if (payload.outcome) {
        if (JSON.stringify(payload.outcome) === JSON.stringify(outcome) && JSON.stringify(payload.output) === JSON.stringify(output)) return;
        throw new Error("immutable capture outcome conflict");
      }
      payload.output = output; payload.outcome = outcome;
      const omissions = [...payload.omissions, ...(projection?.omissions ?? [])];
      payload.omissions = omissions.slice(0, 128);
      if (omissions.length > 128) payload.omissions[127] = { path: "$", reason: "count_limit", originalBytes: null, storedBytes: 0, omittedCount: omissions.length - 127 };
      payload.originalBytes = payload.originalBytes === null || projection?.originalBytes === null ? null : payload.originalBytes + (projection?.originalBytes ?? 0);
      const packed = this.packed(payload, row.scope_json);
      this.prune(64);
      const current = this.row(requestId); if (!current?.payload_json || current.unavailable_reason) return;
      if (!this.room(row.project_id, packed.bytes - row.bytes, 0)) { this.evict(row, "evicted"); return; }
      this.db.prepare("UPDATE request_captures SET payload_json=?,bytes=?,phase=? WHERE request_id=?").run(packed.json, packed.bytes, notDispatched ? "not_dispatched" : "dispatch_intent", requestId);
    });
  }
  private room(project: string, extra: number, records: number): boolean {
    const sums = this.db.prepare("SELECT COUNT(*) AS n,COALESCE(SUM(bytes),0) AS total,COALESCE(SUM(CASE WHEN project_id=? THEN bytes ELSE 0 END),0) AS project FROM request_captures").get(project) as { n: number; total: number; project: number };
    return sums.n + records <= L.records && sums.total + extra <= L.totalBytes && sums.project + extra <= L.projectBytes;
  }
  private evict(row: Row, reason: "expired" | "evicted") {
    const retained = Buffer.byteLength(row.scope_json) + 256;
    this.db.prepare("UPDATE request_captures SET payload_json=NULL,bytes=?,unavailable_reason=? WHERE request_id=?").run(retained, reason, row.request_id);
    return Math.max(0, row.bytes - retained);
  }
  prune(limit = 64): { captures: number; bytes: number } {
    this.ownership.assert();
    const bound = z.number().int().min(1).max(256).parse(limit);
    return immediate(this.db, () => {
      let captures = 0, bytes = 0;
      const expired = this.db.prepare("SELECT request_id FROM request_captures WHERE payload_json IS NOT NULL AND expires_at<=? ORDER BY expires_at,request_id LIMIT ?").all(this.now(), bound) as Array<{ request_id: string }>;
      for (const ref of expired) { const row = this.row(ref.request_id)!; bytes += this.evict(row, "expired"); captures++; }
      const totals = this.db.prepare("SELECT project_id,COUNT(*) AS n,COALESCE(SUM(bytes),0) AS bytes FROM request_captures GROUP BY project_id").all() as Array<{ project_id: string; n: number; bytes: number }>;
      let total = totals.reduce((sum, row) => sum + row.bytes, 0), count = totals.reduce((sum, row) => sum + row.n, 0);
      const projects = new Map(totals.map(row => [row.project_id, row.bytes]));
      if (count + 1 > L.records || total + L.recordBytes > L.totalBytes || totals.some(row => row.bytes + L.recordBytes > L.projectBytes)) {
        const candidates = this.db.prepare("SELECT request_id,project_id,bytes FROM request_captures WHERE ? OR project_id IN (SELECT project_id FROM request_captures GROUP BY project_id HAVING SUM(bytes)+?>?) ORDER BY created_at,request_id LIMIT ?").all(count + 1 > L.records || total + L.recordBytes > L.totalBytes ? 1 : 0, L.recordBytes, L.projectBytes, bound - captures) as Array<{ request_id: string; project_id: string; bytes: number }>;
        for (const row of candidates) {
          this.ownership.assertProject(row.project_id);
          if (count + 1 <= L.records && total + L.recordBytes <= L.totalBytes && (projects.get(row.project_id) ?? 0) + L.recordBytes <= L.projectBytes) continue;
          this.db.prepare("DELETE FROM request_captures WHERE request_id=?").run(row.request_id);
          captures++; bytes += row.bytes; count--; total -= row.bytes; projects.set(row.project_id, (projects.get(row.project_id) ?? 0) - row.bytes);
        }
      }
      return { captures, bytes };
    });
  }
  purgeProject(project: string): { captures: number; bytes: number } {
    this.ownership.assertProject(project);
    z.string().min(1).max(128).parse(project);
    return immediate(this.db, () => {
      const where = "project_id=@project OR EXISTS(SELECT 1 FROM json_each(scope_json) WHERE value=@project)";
      const stats = this.db.prepare(`SELECT COUNT(*) AS captures,COALESCE(SUM(bytes),0) AS bytes FROM request_captures WHERE ${where}`).get({ project }) as { captures: number; bytes: number };
      this.db.prepare(`DELETE FROM request_captures WHERE ${where}`).run({ project }); return stats;
    });
  }
  read(requestId: string, scope: { project: string | null }): RequestCaptureView | null {
    this.ownership.assert();if(scope.project!==null)this.ownership.assertProject(scope.project);
    z.object({ project: z.string().min(1).max(128).nullable() }).strict().parse(scope);
    const request = this.request(requestId); if (!request.success || request.data.project_id !== (scope.project ?? "")) return null;
    const base = { schemaVersion: 1 as const, requestId, provenance: "normalized_gate_v1" as const, ...empty(), availability: "unavailable" as const, unavailableReason: "not_captured" as const, dispatch: "outcome_unknown" as const, storedBytes: 0, capturedAt: null, expiresAt: null };
    try {
      const row = this.row(requestId); if (!row) return RequestCaptureViewSchema.parse(base);
      const projects = Scope.parse(JSON.parse(row.scope_json));
      const current = this.scope(requestId);
      if (!current.projects.length && !current.unknown && request.data.project_id) { current.projects.push(request.data.project_id); if (!this.registered(request.data.project_id)) current.unknown = true; }
      const reason = current.unknown ? "scope_unavailable" : current.projects.length > 1 || projects.length > 1 ? "mixed_project_payload" : JSON.stringify(current.projects) !== JSON.stringify(projects) || (projects.length && projects[0] !== (scope.project ?? "")) ? "scope_unavailable" : row.expires_at <= this.now() ? "expired" : row.unavailable_reason;
      const metadata = { dispatch: request.data.status === "uncertain" ? "outcome_unknown" : row.phase, storedBytes: row.bytes, capturedAt: row.created_at, expiresAt: row.expires_at };
      if (reason) return RequestCaptureViewSchema.parse({ ...base, ...metadata, unavailableReason: reason });
      const payload = this.payload(row);
      const lostOutcome = ["succeeded", "failed", "uncertain"].includes(request.data.status) && !payload.outcome;
      const lostOutput = payload.outcome?.kind === "succeeded" && !payload.output;
      return RequestCaptureViewSchema.parse({ ...base, ...metadata, ...payload, availability: !payload.outcome || lostOutcome || lostOutput || payload.omissions.length ? "partial" : "complete", unavailableReason: lostOutcome || lostOutput ? "capture_failed" : null });
    } catch { return RequestCaptureViewSchema.parse({ ...base, unavailableReason: "corrupt" }); }
  }
}
