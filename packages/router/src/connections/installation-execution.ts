import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { z } from "zod";
import type { Admission } from "../admission/admission.js";
import type { Db } from "../storage/db.js";
import { immediate } from "../storage/db.js";
import { readStoreIdentity } from "../projects/store-identity.js";

export const InstallationExecutionSchema = z.object({ executionId: z.string().min(1).max(200), owner: z.string().min(1).max(300), nonce: z.string().regex(/^[a-f0-9]{32}$/), deadlineAt: z.number().int().positive() }).strict();
export type InstallationExecution = z.infer<typeof InstallationExecutionSchema>;
const issued = new Map<string, { proof: InstallationExecution; db: Db }>();
export function createInstallationExecution(admission: Admission, deadlineAt: number): InstallationExecution {
  if (readStoreIdentity(admission.db)?.role === "project") throw new Error("Installation requests cannot use a project store");
  const proof = immediate(admission.db, () => {
    const executionId = admission.createExecution("task", "direct", []);
    const value = InstallationExecutionSchema.parse({ executionId, owner: hostname() + ":" + process.pid + ":" + randomBytes(8).toString("hex"), nonce: randomBytes(16).toString("hex"), deadlineAt });
    admission.db.prepare("UPDATE executions SET detail_json=? WHERE id=?").run(JSON.stringify({ scope: "client_connection", ...value }), executionId);
    return value;
  });
  issued.set(proof.executionId, { proof: Object.freeze(proof), db: admission.db });
  return proof;
}
/** Process-issued proof plus exact persisted authority; elapsed time never refunds a dispatch. */
export function assertInstallationExecution(db: Db, value: InstallationExecution, now: number): InstallationExecution {
  const proof = InstallationExecutionSchema.parse(value), active = issued.get(proof.executionId);
  if (!active || active.db !== db || JSON.stringify(active.proof) !== JSON.stringify(proof) || readStoreIdentity(db)?.role === "project" || now >= proof.deadlineAt)
    throw new Error("Installation request host authority is absent or expired");
  const row = z.object({ profile: z.literal("direct"), status: z.literal("running"), detail_json: z.string() }).strict().parse(db.prepare("SELECT profile,status,detail_json FROM executions WHERE id=?").get(proof.executionId));
  const detail = z.object({ scope: z.literal("client_connection"), ...InstallationExecutionSchema.shape }).strict().parse(JSON.parse(row.detail_json));
  if (JSON.stringify(detail) !== JSON.stringify({ scope: "client_connection", ...proof }) || db.prepare("SELECT 1 FROM execution_members WHERE execution_id=? LIMIT 1").get(proof.executionId))
    throw new Error("Installation execution is not the exact empty-member host request");
  return proof;
}
export function retireInstallationExecution(proof: InstallationExecution): void {
  if (issued.get(proof.executionId)?.proof.nonce === proof.nonce) issued.delete(proof.executionId);
}
