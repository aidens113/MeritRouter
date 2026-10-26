import { z } from "zod";
import type { Admission } from "./admission.js";
import type { GlobalReceipt } from "./accounting-broker.js";
import { ProjectRequestStore, type ProjectRequestRecord } from "./project-request-store.js";

/** History may settle after a run ends, but cannot be projected onto a re-created task identity. */
export function assertOriginalProjectParticipants(admission: Admission, store: ProjectRequestStore, record: ProjectRequestRecord): void {
  for (const part of record.input.participants) {
    const task = admission.tasks.get(part.taskId);
    if (!task || task.row.project_id !== store.identity.slug || task.row.lease_incarnation !== part.lease.incarnation)
      throw new Error("Original project participant incarnation is unavailable; accounting evidence retained");
  }
}
export function bindProjectRequest(admission: Admission, store: ProjectRequestStore, record: ProjectRequestRecord, value: GlobalReceipt): void {
  const receipt = store.assertGlobalReceipt(record, value);
  assertOriginalProjectParticipants(admission, store, record);
  const existing = store.db.prepare("SELECT execution_id,project_id FROM model_requests WHERE id=?").get(record.row.request_id);
  if (existing) {
    const row = z.object({ execution_id: z.string(), project_id: z.string() }).strict().parse(existing);
    const charges = z.array(z.object({ task_id: z.string(), lease_incarnation: z.string().nullable(), run_count: z.number().nullable() }).strict())
      .parse(store.db.prepare("SELECT task_id,lease_incarnation,run_count FROM request_charges WHERE request_id=?").all(record.row.request_id));
    if (row.execution_id !== record.input.executionId || row.project_id !== store.identity.slug || charges.length !== record.input.participants.length
      || charges.some(charge => !record.input.participants.some(part => part.taskId === charge.task_id && part.lease.incarnation === charge.lease_incarnation && part.lease.runCount === charge.run_count)))
      throw new Error("Project model request identity collision");
    store.update(record, "bound", receipt); return;
  }
  const input = record.input;
  store.db.prepare(`INSERT INTO model_requests(id,execution_id,purpose,gateway_model,endpoint_id,tier,route_note,status,reserved_at,est_input_tokens,reserved_output_tokens,project_id)
    VALUES(?,?,?,?,?,?,?,'reserved',?,?,?,?)`).run(input.requestId, input.executionId, input.purpose, input.gatewayModel, input.endpointId,
      input.tier, input.routeNote ?? null, receipt.admittedAt, input.estInputTokens, input.reservedOutputTokens, store.identity.slug);
  const charge = store.db.prepare("INSERT INTO request_charges(request_id,task_id,input_tokens,output_tokens,tokens_exact,lease_incarnation,run_count) VALUES(?,?,?,?,0,?,?)");
  const spend = store.db.prepare(`INSERT INTO project_request_spend(request_id,task_id,project_id,lease_incarnation,run_count,reserved_usd,liability_usd,actual_usd,global_outcome_digest)
    VALUES(?,?,?,?,?,?,?,?,?)`);
  const participants = input.participants.length;
  for (const part of input.participants) {
    charge.run(input.requestId, part.taskId, part.estInputTokens, part.reservedOutputTokens, part.lease.incarnation, part.lease.runCount);
    const reserved = (receipt.reservedUsd ?? 0) / participants, liability = Math.max(reserved, (receipt.liabilityUsd ?? 0) / participants);
    spend.run(input.requestId, part.taskId, store.identity.slug, part.lease.incarnation, part.lease.runCount, reserved, liability,
      receipt.actualUsd === null ? null : receipt.actualUsd / participants, receipt.outcomeDigest);
  }
  store.releasePreparation(record); store.update(record, "bound", receipt);
}
export function updateProjectLiability(store: ProjectRequestStore, record: ProjectRequestRecord, receipt: GlobalReceipt): void {
  store.assertGlobalReceipt(record, receipt);
  const count = record.input.participants.length;
  const actual = receipt.actualUsd ?? (receipt.state === "retired" || (receipt.state === "settled" && receipt.reservedUsd === null && !receipt.costQuarantined) ? 0 : null);
  for (const part of record.input.participants) {
    store.db.prepare(`UPDATE project_request_spend SET liability_usd=MAX(liability_usd,?),actual_usd=?,global_outcome_digest=?
      WHERE request_id=? AND task_id=? AND lease_incarnation=? AND run_count=?`)
      .run((receipt.liabilityUsd ?? 0) / count, actual === null ? null : actual / count, receipt.outcomeDigest, record.row.request_id,
        part.taskId, part.lease.incarnation, part.lease.runCount);
  }
}
export function applyProjectSettlement(admission: Admission, store: ProjectRequestStore, record: ProjectRequestRecord, receipt: GlobalReceipt): void {
  store.assertGlobalReceipt(record, receipt); assertOriginalProjectParticipants(admission, store, record);
  if (receipt.state !== "settled" && receipt.state !== "retired") throw new Error("Global accounting is not settled");
  if (receipt.costQuarantined) throw new Error("Unexpected global cost cannot be marked settled locally");
  if (record.outcome && receipt.state === "settled") {
    if (record.row.outcome_digest !== receipt.outcomeDigest) throw new Error("Global and local outcome digests disagree");
    const { paid: unused, ...localOnly } = record.reservation;
    admission.reconcile(localOnly, record.outcome);
  } else {
    // Financial recovery has no fabricated provider headers/status/text: preserve only authoritative numeric evidence.
    store.db.prepare("UPDATE model_requests SET status=?,finished_at=?,input_tokens=?,output_tokens=? WHERE id=?")
      .run(receipt.state === "retired" ? "failed" : receipt.outcome, store.now(), receipt.inputTokens, receipt.outputTokens, record.row.request_id);
    const inTotal = receipt.inputTokens, outTotal = receipt.outputTokens;
    const inEstimate = record.input.participants.reduce((sum, part) => sum + part.estInputTokens, 0) || 1;
    const outEstimate = record.input.participants.reduce((sum, part) => sum + part.reservedOutputTokens, 0) || 1;
    for (const part of record.input.participants) if (inTotal !== null || outTotal !== null) store.db.prepare(`UPDATE request_charges
      SET input_tokens=?,output_tokens=?,tokens_exact=? WHERE request_id=? AND task_id=? AND lease_incarnation=? AND run_count=?`)
      .run(inTotal === null ? part.estInputTokens : Math.ceil(inTotal * part.estInputTokens / inEstimate),
        outTotal === null ? part.reservedOutputTokens : Math.ceil(outTotal * part.reservedOutputTokens / outEstimate),
        record.input.participants.length === 1 && inTotal !== null && outTotal !== null ? 1 : 0,
        record.row.request_id, part.taskId, part.lease.incarnation, part.lease.runCount);
  }
  updateProjectLiability(store, record, receipt);
  store.db.prepare("UPDATE model_requests SET estimated_cost_usd=? WHERE id=?").run(receipt.actualUsd ?? receipt.liabilityUsd, record.row.request_id);
  store.update(record, receipt.state === "retired" ? "retired" : "settled", receipt,
    record.outcome ? null : receipt.state === "retired" ? "definitely_unsent" : "accounting_projection_only");
}
