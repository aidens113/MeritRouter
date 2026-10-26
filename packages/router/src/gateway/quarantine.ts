import { readStoreIdentity } from "../projects/store-identity.js";
import { z } from "zod";
import { MeritRouterError } from "../core/errors.js";
import { immediate, type Db } from "../storage/db.js";

const Violation = z.object({ id: z.string(), policy_violation: z.string() });
const Acknowledgement = z.object({ requestId: z.string(), endpointId: z.string(), actor: z.string().trim().min(1).max(200), reason: z.string().trim().min(1).max(2000), at: z.number().int().nonnegative() }).strict();
const key = (requestId: string) => `quarantine_ack:${requestId}`;

function latest(db: Db, endpointId: string) {
  if(readStoreIdentity(db)?.role==="coordination"){
    const row=db.prepare("SELECT request_id AS id,code AS policy_violation FROM endpoint_quarantines WHERE endpoint_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(endpointId);
    return row?Violation.parse(row):null;
  }
  const row = db.prepare("SELECT id, policy_violation FROM model_requests WHERE endpoint_id = ? AND policy_violation IS NOT NULL ORDER BY reserved_at DESC, rowid DESC LIMIT 1").get(endpointId);
  return row ? Violation.parse(row) : null;
}

/** Acknowledgements are tied to one violation; a later mismatch quarantines again. */
export function quarantineReason(db: Db, endpointId: string): string | null {
  const violation = latest(db, endpointId);
  if (!violation) return null;
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key(violation.id)) as { value: string } | undefined;
  if (row) {
    try {
      const ack = Acknowledgement.parse(JSON.parse(row.value));
      if (ack.endpointId === endpointId && ack.requestId === violation.id) return null;
    } catch { /* Invalid stored acknowledgement never lifts a quarantine. */ }
  }
  return `quarantined after a policy violation: ${violation.policy_violation}`;
}

/** Preserve violation evidence and require a human explanation before allowing a retry. */
export function acknowledgeQuarantine(db: Db, endpointId: string, input: { actor: string; reason: string }, now = Date.now()) {
  return immediate(db, () => {
    const violation = latest(db, endpointId);
    if (!violation || !quarantineReason(db, endpointId)) throw new MeritRouterError("not_quarantined", "This model has no pending quarantine to acknowledge");
    const ack = Acknowledgement.parse({ ...input, endpointId, requestId: violation.id, at: now });
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(key(violation.id), JSON.stringify(ack));
    return ack;
  });
}

/** Minimal shared policy evidence; provider diagnostics, messages and paths stay in the project. */
export function recordEndpointQuarantine(db:Db,value:{requestId:string;endpointId:string;code:"served_endpoint_mismatch"|"provider_policy_violation";outcomeDigest:string},now=Date.now()):void{
 const input=z.object({requestId:z.string().min(1).max(300),endpointId:z.string().min(1).max(300),code:z.enum(["served_endpoint_mismatch","provider_policy_violation"]),outcomeDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(value);
 if(readStoreIdentity(db)?.role!=="coordination")throw new Error("Shared quarantine requires coordination store");
 immediate(db,()=>{const old=db.prepare("SELECT endpoint_id,code,outcome_digest FROM endpoint_quarantines WHERE request_id=?").get(input.requestId);
 if(old){if(JSON.stringify(old)!==JSON.stringify({endpoint_id:input.endpointId,code:input.code,outcome_digest:input.outcomeDigest}))throw new Error("Shared quarantine conflict");return;}
 db.prepare("INSERT INTO endpoint_quarantines(request_id,endpoint_id,code,outcome_digest,created_at) VALUES(?,?,?,?,?)").run(input.requestId,input.endpointId,input.code,input.outcomeDigest,z.number().int().nonnegative().parse(now));});
}
