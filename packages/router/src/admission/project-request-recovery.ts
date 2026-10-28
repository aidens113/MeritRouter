import { z } from "zod";
import type { Db } from "../storage/db.js";
import type { ProjectStoreIdentity } from "../projects/store-identity.js";
import { RequestIdSchema } from "./request-ledger.js";
import type { RequestAccountingBroker } from "./accounting-broker.js";
import { ProjectRequestStore, type ProjectRequestRecord } from "./project-request-store.js";

export interface ProjectSettlementRecovery {
  db: Db;
  identity: ProjectStoreIdentity;
  /** The project's own ledger recovery (reconcile a durable local outcome, or project a settled receipt). */
  ledger: { recover(requestId: string): Promise<unknown> };
  broker: Pick<RequestAccountingBroker, "readReceipt">;
  now(): number;
}

/** Whether any participant's captured task lease is still held: its owner may be settling the request itself. */
function liveParticipant(db: Db, record: ProjectRequestRecord, now: number): boolean {
  return record.input.participants.some(part => !!db.prepare("SELECT 1 FROM tasks WHERE id=? AND lease_owner=? AND run_count=? AND lease_incarnation=? AND project_id=? AND lease_expires_at>?")
    .get(part.lease.taskId, part.lease.owner, part.lease.runCount, part.lease.incarnation, part.lease.project, now));
}

/**
 * Startup/periodic recovery of one split project's requests whose owner stopped between a durable step
 * and settlement. It only finishes what durable evidence already decides: a saved local outcome is settled
 * globally and projected once; a globally settled or retired receipt is projected locally. It never
 * reserves, dispatches or invents an outcome, skips requests whose captured lease is still live, and leaves
 * cost-quarantined and dispatch-intent-without-outcome requests to their explicit operator paths.
 * Returns the request IDs it settled.
 */
export async function recoverProjectSettlements(input: ProjectSettlementRecovery, limit = 100): Promise<string[]> {
  const store = new ProjectRequestStore(input.db, input.identity, () => input.now()), recovered: string[] = [];
  const ids = z.array(z.object({ request_id: RequestIdSchema }).strict()).parse(input.db.prepare(
    "SELECT request_id FROM project_request_protocol WHERE phase NOT IN ('settled','retired') ORDER BY created_at,request_id LIMIT ?").all(z.number().int().min(1).max(1000).parse(limit)));
  for (const { request_id: id } of ids) {
    try {
      const record = store.read(id);
      if (!record || liveParticipant(input.db, record, input.now())) continue;
      const global = input.broker.readReceipt(id);
      if (global?.costQuarantined || global?.unboundedCost) continue;
      if (record.outcome === null && global?.state !== "settled" && global?.state !== "retired") continue;
      await input.ledger.recover(id);
      if (["settled", "retired"].includes(store.read(id)?.row.phase ?? "")) recovered.push(id);
    } catch {
      // Evidence stays durable; the ledger marked what it could, and the next pass retries.
    }
  }
  return recovered;
}
