"use client";
import { useId, useState } from "react";
import { ActionStatus, useAction } from "./actions";
import { buttonClass } from "../ui";

export function QuarantineControl({ id }: { id: string }) {
  const field = useId();
  const [reason, setReason] = useState("");
  const { run, busy, error, message } = useAction();
  return <div className="mb-5 space-y-3 rounded-lg border border-line p-3">
    <p className="text-sm">A different model was served. Record why retrying is appropriate. The original violation stays in history; another mismatch quarantines this model again.</p>
    <label htmlFor={field} className="block text-sm">Reason to permit a retry</label>
    <textarea id={field} className="field w-full" maxLength={2000} value={reason} onChange={e => setReason(e.target.value)} disabled={busy} />
    <button className={buttonClass("primary", true)} disabled={busy || !reason.trim()} onClick={() => run("/api/models/quarantine", "POST", { id, reason: reason.trim() }, { success: "Quarantine acknowledged; retries permitted" })}>Acknowledge and permit retry</button>
    <ActionStatus error={error} message={message} />
  </div>;
}
