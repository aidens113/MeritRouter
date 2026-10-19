"use client";

import { useState } from "react";
import { Check, RefreshCw, X } from "lucide-react";
import { buttonClass } from "../ui";
import { ActionStatus, useAction } from "./actions";

/**
 * Accept or reject a finished task's result as the person using the panel. The decision, `panel`
 * as the acceptor, and the reason are recorded on the result. A reason is required to reject, and
 * to accept a result that is not already met.
 */
export function AcceptanceActions({ taskId, reasonRequired }: { taskId: string; reasonRequired: boolean }) {
  const { run, busy, error, errors, message } = useAction();
  const [reason, setReason] = useState("");
  const [last, setLast] = useState<"accept" | "reject" | null>(null);
  const trimmed = reason.trim();
  const decide = async (decision: "accept" | "reject") => {
    setLast(decision);
    const r = await run(`/api/tasks/${decision}`, "POST", { id: taskId, ...(trimmed ? { reason: trimmed } : {}) }, { success: decision === "accept" ? "Accepted: recorded as panel" : "Rejected: the result is now unmet" });
    if (r.ok) setReason("");
  };
  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium text-ink">
        Reason
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
          maxLength={4000}
          className="field mt-1 font-normal"
          placeholder="What you checked against the goal and criteria, or what is wrong"
        />
        <span className="mt-1 block text-xs font-normal text-ink-3">Recorded on the result with you (panel) as the acceptor. Required to reject{reasonRequired ? " and to accept" : ""}.</span>
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={buttonClass("primary", true)} disabled={busy || (reasonRequired && !trimmed)} onClick={() => decide("accept")}>
          {busy && last === "accept" ? <RefreshCw size={13} className="animate-spin" aria-hidden /> : <Check size={13} aria-hidden />} Accept result
        </button>
        <button type="button" className={buttonClass("danger", true)} disabled={busy || !trimmed} onClick={() => decide("reject")}>
          {busy && last === "reject" ? <RefreshCw size={13} className="animate-spin" aria-hidden /> : <X size={13} aria-hidden />} Reject result
        </button>
      </div>
      <ActionStatus error={error} errors={errors} message={message} />
    </div>
  );
}
