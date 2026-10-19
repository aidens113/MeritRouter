"use client";

import { useState } from "react";
import { CheckCircle2, RotateCcw, Save } from "lucide-react";
import { ActionStatus, useAction } from "./actions";
import { buttonClass } from "../ui";

/** Plain YAML editor with validate-before-save. `endpoint` receives { text, save }. */
export function YamlEditor({ initial, endpoint, saveLabel = "Save", rows = 24, note }: { initial: string; endpoint: string; saveLabel?: string; rows?: number; note?: string }) {
  const [text, setText] = useState(initial);
  const [validated, setValidated] = useState<string | null>(null);
  const { run, busy, error, errors, message } = useAction();
  const dirty = text !== initial;
  return (
    <div className="space-y-3">
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setValidated(null);
        }}
        rows={rows}
        spellCheck={false}
        className="field font-mono text-xs leading-relaxed"
        aria-label="YAML"
      />
      {note ? <p className="text-xs text-ink-3">{note}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={buttonClass("secondary", true)}
          disabled={busy}
          onClick={async () => {
            const r = await run(endpoint, "POST", { text, save: false }, { success: "Valid: safe to save", refresh: false });
            setValidated(r.ok ? text : null);
          }}
        >
          <CheckCircle2 size={13} aria-hidden /> Validate
        </button>
        <button
          type="button"
          className={buttonClass("primary", true)}
          disabled={busy || !dirty || validated !== text}
          title={validated !== text ? "Validate first" : undefined}
          onClick={() => run(endpoint, "POST", { text, save: true }, { success: "Saved (the previous file was kept as .bak)" })}
        >
          <Save size={13} aria-hidden /> {saveLabel}
        </button>
        {dirty ? (
          <button
            type="button"
            className={buttonClass("ghost", true)}
            onClick={() => {
              setText(initial);
              setValidated(null);
            }}
          >
            <RotateCcw size={13} aria-hidden /> Revert
          </button>
        ) : null}
        <span className="text-xs text-ink-3">{dirty ? (validated === text ? "Validated" : "Validate before saving") : "No changes"}</span>
      </div>
      <ActionStatus error={error} message={message} errors={errors} />
    </div>
  );
}
