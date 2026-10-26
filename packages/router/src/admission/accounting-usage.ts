import type { Db } from "../storage/db.js";

/** Exact-ID overlap counts once at the more conservative exposure until legacy projection purge. */
export const ACCOUNTING_SPEND_SQL = `SELECT p.request_id,p.key_ref,p.provider,p.endpoint_id,
  MAX(COALESCE(p.actual_usd,p.liability_usd),COALESCE(old.actual_usd,old.reserved_usd,0)) AS reserved_usd,
  NULL AS actual_usd,MAX(p.created_at,COALESCE(old.created_at,p.created_at)) AS created_at,
  r.project_uuid AS project_uuid FROM broker_paid_spend p JOIN physical_requests r ON r.id=p.request_id
  LEFT JOIN paid_spend old ON old.request_id=p.request_id
  UNION ALL SELECT p.request_id,p.key_ref,p.provider,p.endpoint_id,p.reserved_usd,p.actual_usd,p.created_at,
  NULL AS project_uuid
  FROM paid_spend p JOIN model_requests r ON r.id=p.request_id
  WHERE NOT EXISTS(SELECT 1 FROM broker_paid_spend b WHERE b.request_id=p.request_id)
    AND NOT EXISTS(SELECT 1 FROM physical_requests q WHERE q.id=p.request_id AND q.cost_quarantined=1)
  UNION ALL SELECT r.id,COALESCE(r.key_ref,old.key_ref,'unresolved:'||r.provider),r.provider,r.endpoint_id,
    MAX(r.unexpected_liability_usd,COALESCE(old.actual_usd,old.reserved_usd,0)),NULL,
    MAX(r.reserved_at,COALESCE(old.created_at,r.reserved_at)),r.project_uuid
  FROM physical_requests r LEFT JOIN paid_spend old ON old.request_id=r.id WHERE r.cost_quarantined=1 AND r.paid=0`;
export function assertAccountingOverlap(db: Db): void {
  if (db.prepare(`SELECT 1 FROM physical_requests r LEFT JOIN broker_paid_spend b ON b.request_id=r.id
    WHERE (r.paid=1 AND b.request_id IS NULL) OR (r.paid=0 AND b.request_id IS NOT NULL)
      OR (b.request_id IS NOT NULL AND (b.key_ref!=r.key_ref OR b.provider!=r.provider OR b.endpoint_id!=r.endpoint_id)) LIMIT 1`).get()) {
    throw new Error("Broker paid authority is incomplete or inconsistent; explicit reconciliation required");
  }
  if (db.prepare(`SELECT 1 FROM broker_paid_spend b JOIN paid_spend p ON p.request_id=b.request_id
    WHERE b.key_ref!=p.key_ref OR b.provider!=p.provider OR b.endpoint_id!=p.endpoint_id LIMIT 1`).get()) {
    throw new Error("Legacy and broker paid identities disagree; explicit reconciliation required");
  }
}
export function physicalRequestCount(db: Db, since: number, projectId?: string): number {
  const sql = `WITH requests AS (
    SELECT b.id,MAX(b.reserved_at,COALESCE(r.reserved_at,b.reserved_at)) AS reserved_at,b.project_uuid
    FROM physical_requests b LEFT JOIN model_requests r ON r.id=b.id
    UNION ALL SELECT r.id,r.reserved_at,NULL
    FROM model_requests r WHERE NOT EXISTS(SELECT 1 FROM physical_requests b WHERE b.id=r.id))
    SELECT COUNT(*) AS count FROM requests WHERE reserved_at>? ${projectId ? "AND (project_uuid=? OR project_uuid IS NULL)" : ""}`;
  return (db.prepare(sql).get(...(projectId ? [since, projectId] : [since])) as { count: number }).count;
}
