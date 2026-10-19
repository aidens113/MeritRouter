"use client";

import { Plus, X } from "lucide-react";
import { buttonClass } from "../ui";

/** Editable list of sentences (acceptance criteria, check commands, extra rules): one input per item. */
export function LinesEditor({
  value,
  onChange,
  placeholder,
  addLabel = "Add",
  mono = false,
  id,
  disabled = false,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  addLabel?: string;
  mono?: boolean;
  id?: string;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      {value.map((v, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <span className="tabular w-5 shrink-0 text-right text-xs text-ink-3">{i + 1}.</span>
          <input
            id={i === 0 ? id : undefined}
            value={v}
            disabled={disabled}
            onChange={(e) => onChange(value.map((x, j) => (j === i ? e.target.value : x)))}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onChange([...value.slice(0, i + 1), "", ...value.slice(i + 1)]);
              }
            }}
            placeholder={placeholder}
            className={mono ? "field font-mono text-[13px]" : "field"}
          />
          <button type="button" disabled={disabled} className={buttonClass("ghost", true)} onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label={`Remove item ${i + 1}`}>
            <X size={13} aria-hidden />
          </button>
        </div>
      ))}
      <button type="button" disabled={disabled} className={buttonClass("secondary", true)} onClick={() => onChange([...value, ""])}>
        <Plus size={13} aria-hidden /> {addLabel}
      </button>
    </div>
  );
}
