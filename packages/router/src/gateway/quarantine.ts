import { z } from "zod";
import { MeritRouterError } from "../core/errors.js";
import { immediate, type Db } from "../storage/db.js";

const Violation = z.object({ id: z.string(), policy_violation: z.string() });
const Acknowledgement = z.object({ requestId: z.string(), endpointId: z.string(), actor: z.string().trim().min(1).max(200), reason: z.string().trim().min(1).max(2000), at: z.number().int().nonnegative() }).strict();
const key = (requestId: string) => `quarantine_ack:${requestId}`;

function latest(db: Db, endpointId: string) {
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
