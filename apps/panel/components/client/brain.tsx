"use client";

import { useState } from "react";
import { Check, RotateCcw, Save, X } from "lucide-react";
import { ActionStatus, useAction } from "./actions";
import { buttonClass } from "../ui";

/** Edit a brain file in place. Saved as you; protocol errors from the server are listed inline. */
export function BrainEditor({ path, initial, kind, maxCurrentState }: { path: string; initial: string; kind: string; maxCurrentState: number }) {
  const [text, setText] = useState(initial);
  const { run, busy, error, errors, message } = useAction();
  const dirty = text !== initial;
  const rules =
    kind === "working_doc"
      ? `Working document rules: keep the header block (Status, Status detail, Created, Last updated, Owner, Scope, Paired document, Related), keep "## Current State" under ${maxCurrentState} lines, and never change existing Work Ledger entries (append only).`
      : kind === "report"
        ? 'Report rules: title "# Report: <label>", sections Outcome (starting Done, Partial, or Blocked), What changed and why, Commands run and observed results, Not verified, Open questions or contradictions found.'
        : "Saved as you and committed to the brain repository.";
  return (
    <div className="space-y-3">
      <p className="text-xs text-ink-3">{rules}</p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        rows={Math.min(40, Math.max(14, initial.split("\n").length + 2))}
        className="field font-mono text-xs leading-relaxed"
        aria-label={`Edit ${path}`}
        aria-invalid={errors.length > 0}
      />
      <div className="flex flex-wrap items-start gap-3">
        <button type="button" className={buttonClass("primary", true)} disabled={busy || !dirty} onClick={() => run("/api/brain", "PUT", { path, content: text }, { success: "Saved and committed as you." })}>
          <Save size={13} aria-hidden /> Save
        </button>
        {dirty ? (
          <button type="button" className={buttonClass("ghost", true)} onClick={() => setText(initial)}>
            <RotateCcw size={13} aria-hidden /> Discard changes
          </button>
        ) : null}
        <div className="min-w-0 flex-1">
          {error && errors.length ? (
            <div role="alert" className="rounded-lg border border-bad/30 bg-bad-soft px-3 py-2 text-xs text-bad-ink">
              <div className="font-medium">{error}</div>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </div>
          ) : (
            <ActionStatus error={error} message={message} />
          )}
        </div>
      </div>
    </div>
  );
}

/** Approve or deny one access request with a reason. */
export function AccessDecision({ id }: { id: number }) {
  const [reason, setReason] = useState("");
  const { run, busy, error, message } = useAction();
  const decide = (approve: boolean) => run(`/api/brain/access/${id}`, "POST", { approve, reason }, { success: approve ? "Approved" : "Denied" });
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <input value={reason} onChange={(e) => setReason(e.target.value)} className="field max-w-md flex-1" placeholder="Reason (the worker and its supervisor see it)" aria-label="Reason" />
        <button type="button" className={buttonClass("primary", true)} disabled={busy || !reason.trim()} onClick={() => void decide(true)}>
          <Check size={13} aria-hidden /> Approve
        </button>
        <button type="button" className={buttonClass("danger", true)} disabled={busy || !reason.trim()} onClick={() => void decide(false)}>
          <X size={13} aria-hidden /> Deny
        </button>
      </div>
      <ActionStatus error={error} message={message} />
    </div>
  );
}
