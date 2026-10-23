"use client";

import { useId, useState } from "react";
import { buttonClass } from "../ui";
import { ActionStatus, useAction } from "./actions";

export function WorkerActionDecision({ id, project, operation }: { id: string; project: string; operation: boolean }) {
  const uid = useId();
  const { run, busy, error, errors, message } = useAction();
  const [reason, setReason] = useState("");
  const [response, setResponse] = useState("");
  const decide = (decision: "approve" | "deny") => run(`/api/worker-actions/${encodeURIComponent(id)}`, "POST", { project, decision, reason: reason.trim(), ...(operation && decision === "approve" ? { response } : {}) }, { success: decision === "deny" ? "Worker action denied" : operation ? "Response recorded for the worker" : "Command finished; review the recorded result" });
  return <div className="space-y-3">
    <label htmlFor={`${uid}-reason`} className="block text-sm font-medium text-ink">Decision reason
      <textarea id={`${uid}-reason`} className="field mt-1 font-normal" rows={2} maxLength={4000} value={reason} onChange={e => setReason(e.target.value)} disabled={busy} required />
    </label>
    {operation ? <label htmlFor={`${uid}-response`} className="block text-sm font-medium text-ink">Result of the operation you performed
      <textarea id={`${uid}-response`} className="field mt-1 font-normal" rows={4} maxLength={20000} value={response} onChange={e => setResponse(e.target.value)} disabled={busy} placeholder="Perform the requested operation, then report its result to the worker." />
      <span className="mt-1 block text-xs font-normal text-ink-3">This response is your report. It is not independent check evidence.</span>
    </label> : <p className="text-xs text-ink-2">Approval runs the exact command above with supervisor access, once, for this request.</p>}
    <div className="flex flex-wrap gap-2">
      <button type="button" className={buttonClass("primary", true)} disabled={busy || !reason.trim() || (operation && !response.trim())} onClick={() => decide("approve")}>{operation ? "Send operation result" : "Approve and run command"}</button>
      <button type="button" className={buttonClass("danger", true)} disabled={busy || !reason.trim()} onClick={() => decide("deny")}>Deny request</button>
    </div>
    <ActionStatus error={error} errors={errors} message={message} />
  </div>;
}
