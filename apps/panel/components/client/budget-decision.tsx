"use client";

import { useId, useState } from "react";
import { buttonClass } from "../ui";
import { ActionStatus, useAction } from "./actions";

export function BudgetDecision({ id, project, requested, available }: { id: number; project: string; requested: number; available: number | null }) {
  const uid = useId();
  const { run, busy, error, errors, message } = useAction();
  const [reason, setReason] = useState("");
  const [grant, setGrant] = useState(String(Math.min(requested, available ?? requested)));
  const amount = Number(grant);
  const validGrant = grant.trim() !== "" && Number.isSafeInteger(amount) && amount > 0 && amount <= 1000 && (available === null || amount <= available);
  const decide = (approve: boolean) => run(`/api/budget/requests/${id}`, "POST", { project, approve, reason: reason.trim(), ...(approve ? { grant: amount } : {}) }, { success: approve ? `Approved ${amount} additional model requests` : "Budget request denied" });
  return <div className="space-y-3">
    <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
      <label htmlFor={`${uid}-grant`} className="text-sm font-medium text-ink">Requests to grant
        <input id={`${uid}-grant`} className="field mt-1" type="number" min={1} max={Math.min(1000, available ?? 1000)} step={1} value={grant} onChange={(e) => setGrant(e.target.value)} disabled={busy} aria-describedby={`${uid}-limit`} />
        <span id={`${uid}-limit`} className="mt-1 block text-xs font-normal text-ink-3">{available === null ? "No supervising job pool" : `${available} available in the job pool`}. Partial grants are allowed.</span>
      </label>
      <label htmlFor={`${uid}-reason`} className="text-sm font-medium text-ink">Decision reason
        <textarea id={`${uid}-reason`} className="field mt-1 font-normal" rows={2} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy} placeholder="Why you approve or deny this request" required />
      </label>
    </div>
    <div className="flex flex-wrap gap-2">
      <button type="button" className={buttonClass("primary", true)} disabled={busy || !reason.trim() || !validGrant} onClick={() => decide(true)}>Approve budget</button>
      <button type="button" className={buttonClass("danger", true)} disabled={busy || !reason.trim()} onClick={() => decide(false)}>Deny request</button>
    </div>
    <ActionStatus error={error} errors={errors} message={message} />
  </div>;
}
