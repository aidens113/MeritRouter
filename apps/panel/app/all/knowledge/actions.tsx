"use client";

import { useId, useState } from "react";
import { Check, Undo2, X } from "lucide-react";
import { ActionStatus, useAction } from "@/components/client/actions";
import { buttonClass } from "@/components/ui";

/** Approve or reject a promotion waiting for a person. A rejection needs a reason (kept with the lesson in its project). */
export function PromotionDecision({ project, id }: { project: string; id: string }) {
  const [reason, setReason] = useState("");
  const inputId = useId();
  const { run, busy, error, errors, message } = useAction();
  const decide = (approve: boolean) => run("/api/promotions", "POST", { project, id, approve, reason: reason.trim() || undefined }, { success: approve ? "Approved: the lesson is now in global knowledge." : "Rejected: the lesson was kept in its project with your reason." });
  return (
    <div className="space-y-1.5">
      <label htmlFor={inputId} className="block text-xs font-medium text-ink-3">
        Reason <span className="font-normal">(required to reject; optional note when approving)</span>
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input id={inputId} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} className="field min-w-0 max-w-md flex-1 basis-56" placeholder="Why it does or does not apply to every project" />
        <button type="button" className={buttonClass("primary", true)} disabled={busy} onClick={() => void decide(true)}>
          <Check size={13} aria-hidden /> Approve
        </button>
        <button type="button" className={buttonClass("danger", true)} disabled={busy || !reason.trim()} title={reason.trim() ? undefined : "Give a reason to reject"} onClick={() => void decide(false)}>
          <X size={13} aria-hidden /> Reject
        </button>
      </div>
      <ActionStatus error={error} errors={errors} message={message} />
    </div>
  );
}

/** Revert a global entry: one recorded brain commit removes it (who and why are kept in the history). */
export function RevertEntry({ path, title }: { path: string; title: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const inputId = useId();
  const { run, busy, error, errors } = useAction();
  if (!open)
    return (
      <button type="button" className={buttonClass("ghost", true)} onClick={() => setOpen(true)} aria-label={`Revert ${title}`}>
        <Undo2 size={13} aria-hidden /> Revert
      </button>
    );
  return (
    <div className="w-full space-y-1.5 rounded-lg border border-bad/30 bg-surface-2 p-3">
      <label htmlFor={inputId} className="block text-xs font-medium text-ink-2">
        Why revert &ldquo;{title}&rdquo;? Agents of every project stop reading it; the removal and your reason are committed to the brain&apos;s history.
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input id={inputId} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} className="field min-w-0 max-w-md flex-1 basis-56" placeholder="Reason (recorded in the commit)" />
        <button type="button" className={buttonClass("danger", true)} disabled={busy || !reason.trim()} onClick={() => void run("/api/promotions/revert", "POST", { path, reason: reason.trim() })}>
          <Undo2 size={13} aria-hidden /> Revert entry
        </button>
        <button type="button" className={buttonClass("ghost", true)} disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      <ActionStatus error={error} errors={errors} />
    </div>
  );
}
