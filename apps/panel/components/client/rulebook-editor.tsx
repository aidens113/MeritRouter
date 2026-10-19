"use client";

import { useState, type ReactNode } from "react";
import { Plus, RotateCcw, Save, Trash2 } from "lucide-react";
import type { Rulebook } from "switchyard-router";
import { ActionStatus, useAction } from "./actions";
import { buttonClass, cx } from "../ui";

type Band = { max: number | null; points: number };
type MinBand = { min: number; points: number };

const FEATURE_LABEL: Record<string, string> = {
  extra_repository: "Each extra repository",
  checks_required: "Checks must pass",
  output_schema: "Structured output required",
  retry_after_failure: "Retry after a failed attempt",
  non_text_input: "Input includes images, audio, video, or files",
};

const GROUP_HELP: Record<string, string> = {
  kind: "What kind of work the classifier thinks it is (pick one)",
  reasoning: "How much reasoning it needs (pick one)",
  novelty: "Following an existing pattern or designing something new (pick one)",
  risk: "Risky areas touched (any number; points add up)",
  environment: "Environment needs (any number; points add up)",
  ambiguity: "How clear the goal is (pick one). 'reject' sends the task back to the supervisor",
};

const num = (s: string, fallback: number) => {
  const n = Number(s);
  return Number.isFinite(n) ? n : fallback;
};

/** Table editor for the difficulty rulebook (points per measured feature and per classifier tag). */
export function RulebookEditor({ initial, isDefault, path }: { initial: Rulebook; isDefault: boolean; path: string | null }) {
  const [rb, setRb] = useState<Rulebook>(structuredClone(initial));
  const { run, busy, error, errors, message } = useAction();
  const dirty = JSON.stringify(rb) !== JSON.stringify(initial);
  const set = (fn: (r: Rulebook) => void) =>
    setRb((cur) => {
      const next = structuredClone(cur);
      fn(next);
      return next;
    });

  return (
    <div className="space-y-6">
      <p className="text-sm text-ink-2">
        {isDefault ? "Using the built-in rulebook. Saving writes rulebook.yaml next to the config and points scoring.rulebook_file at it." : `Editing ${path}.`} New scores apply to tasks classified after workers restart; each classification records the rulebook version it used.
      </p>

      <div className="grid gap-6 lg:grid-cols-2">
        <Block title="Kind of work" help="Points by task mode.">
          <table className="data-table tabular">
            <tbody>
              {(["completion", "read_only", "coding"] as const).map((m) => (
                <tr key={m}>
                  <td className="text-ink">{m.replace("_", "-")}</td>
                  <td className="w-28">
                    <PointsInput value={rb.features.mode[m]} onChange={(v) => set((r) => void (r.features.mode[m] = v))} label={`${m} points`} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Block>

        <Block title="Other measured features" help="Points added when the feature is present.">
          <table className="data-table tabular">
            <tbody>
              {(["extra_repository", "checks_required", "output_schema", "retry_after_failure", "non_text_input"] as const).map((k) => (
                <tr key={k}>
                  <td className="text-ink">{FEATURE_LABEL[k]}</td>
                  <td className="w-28">
                    <PointsInput value={rb.features[k]} onChange={(v) => set((r) => void (r.features[k] = v))} label={FEATURE_LABEL[k]!} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Block>

        <Block title="Lines of code in scope" help="First band whose limit the task fits under. Leave the last limit empty for 'anything larger'.">
          <Bands bands={rb.features.lines_in_scope} unit="lines" onChange={(b) => set((r) => void (r.features.lines_in_scope = b))} />
        </Block>

        <Block title="Context size" help="Estimated tokens of supplied context, by band.">
          <Bands bands={rb.features.context_tokens} unit="tokens" onChange={(b) => set((r) => void (r.features.context_tokens = b))} />
          <label className="mt-3 flex items-center gap-2 text-sm text-ink-2">
            Split tasks above
            <input className="field w-32 tabular" value={rb.features.split_above_context_tokens} onChange={(e) => set((r) => void (r.features.split_above_context_tokens = Math.max(1, Math.round(num(e.target.value, r.features.split_above_context_tokens)))))} />
            tokens (returned to the supervisor as T4)
          </label>
        </Block>

        <Block title="Acceptance criteria" help="Points when a task has at least this many criteria (the highest matching row applies).">
          <MinBands bands={rb.features.acceptance_criteria} onChange={(b) => set((r) => void (r.features.acceptance_criteria = b))} />
        </Block>

        <Block title="Classifier confidence" help="Below this confidence the tier is rounded up by one.">
          <label className="flex items-center gap-2 text-sm text-ink-2">
            Round up below
            <input className="field w-24 tabular" value={rb.low_confidence_threshold} onChange={(e) => set((r) => void (r.low_confidence_threshold = Math.min(1, Math.max(0, num(e.target.value, r.low_confidence_threshold)))))} />
            (0 to 1)
          </label>
          <label className="mt-3 flex items-center gap-2 text-sm text-ink-2">
            Rulebook version
            <input className="field w-48 font-mono" value={rb.version} onChange={(e) => set((r) => void (r.version = e.target.value))} />
          </label>
        </Block>
      </div>

      <div>
        <h3 className="mb-1 text-sm font-semibold text-ink">Classifier tags</h3>
        <p className="mb-3 text-xs text-ink-3">The classifier tags each task; these points are added to the measured score. Tags can only raise a tier, never lower it.</p>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {(Object.keys(rb.tags) as Array<keyof Rulebook["tags"]>).map((g) => (
            <div key={g} className="rounded-lg border border-line">
              <div className="border-b border-line px-3 py-2">
                <div className="text-sm font-medium text-ink">{g}</div>
                <div className="text-[11px] text-ink-3">{GROUP_HELP[g]}</div>
              </div>
              <table className="data-table tabular">
                <tbody>
                  {Object.entries(rb.tags[g]).map(([v, pts]) => (
                    <tr key={v}>
                      <td className="text-ink">{v.replace(/_/g, " ")}</td>
                      <td className="w-40">
                        <div className="flex items-center gap-2">
                          <PointsInput value={pts === "reject" ? 0 : pts} disabled={pts === "reject"} onChange={(n) => set((r) => void ((r.tags[g] as Record<string, number | "reject">)[v] = n))} label={`${g} ${v} points`} />
                          <label className="flex items-center gap-1 text-[11px] text-ink-3" title="Return the task to the supervisor">
                            <input type="checkbox" checked={pts === "reject"} onChange={(e) => set((r) => void ((r.tags[g] as Record<string, number | "reject">)[v] = e.target.checked ? "reject" : 0))} />
                            reject
                          </label>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
        <button type="button" className={buttonClass("primary", true)} disabled={busy || !dirty} onClick={() => run("/api/rulebook", "POST", { rulebook: rb }, { success: "Rulebook saved" })}>
          <Save size={13} aria-hidden /> Save rulebook
        </button>
        {dirty ? (
          <button type="button" className={buttonClass("ghost", true)} onClick={() => setRb(structuredClone(initial))}>
            <RotateCcw size={13} aria-hidden /> Discard changes
          </button>
        ) : null}
        <ActionStatus error={error} message={message} errors={errors} />
      </div>
    </div>
  );
}

function Block({ title, help, children }: { title: string; help: string; children: ReactNode }) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      <p className="mb-2 text-xs text-ink-3">{help}</p>
      {children}
    </div>
  );
}

function PointsInput({ value, onChange, label, disabled }: { value: number; onChange: (v: number) => void; label: string; disabled?: boolean }) {
  const [text, setText] = useState(String(value));
  const [last, setLast] = useState(value);
  if (value !== last) {
    setLast(value);
    setText(String(value));
  }
  const bad = text.trim() === "" || !Number.isFinite(Number(text));
  return (
    <input
      aria-label={label}
      value={disabled ? "–" : text}
      disabled={disabled}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value.trim() !== "" && Number.isFinite(n)) {
          setLast(n);
          onChange(n);
        }
      }}
      className={cx("field py-1 text-right tabular", disabled && "opacity-50")}
      aria-invalid={bad && !disabled}
      inputMode="decimal"
    />
  );
}

function Bands({ bands, unit, onChange }: { bands: Band[]; unit: string; onChange: (b: Band[]) => void }) {
  return (
    <div>
      <table className="data-table tabular">
        <thead>
          <tr>
            <th>Up to ({unit})</th>
            <th>Points</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {bands.map((b, i) => (
            <tr key={i}>
              <td>
                <input
                  className="field py-1 tabular"
                  value={b.max === null ? "" : b.max}
                  placeholder="anything larger"
                  aria-label={`Band ${i + 1} limit`}
                  onChange={(e) => onChange(bands.map((x, j) => (j === i ? { ...x, max: e.target.value.trim() === "" ? null : num(e.target.value, x.max ?? 0) } : x)))}
                />
              </td>
              <td className="w-28">
                <PointsInput value={b.points} label={`Band ${i + 1} points`} onChange={(v) => onChange(bands.map((x, j) => (j === i ? { ...x, points: v } : x)))} />
              </td>
              <td className="w-10">
                <button type="button" className={buttonClass("ghost", true)} disabled={bands.length <= 1} onClick={() => onChange(bands.filter((_, j) => j !== i))} aria-label="Remove band">
                  <Trash2 size={12} aria-hidden />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className={cx(buttonClass("ghost", true), "mt-1")} onClick={() => onChange([...bands, { max: null, points: 0 }])}>
        <Plus size={12} aria-hidden /> Add band
      </button>
    </div>
  );
}

function MinBands({ bands, onChange }: { bands: MinBand[]; onChange: (b: MinBand[]) => void }) {
  return (
    <div>
      <table className="data-table tabular">
        <thead>
          <tr>
            <th>At least (criteria)</th>
            <th>Points</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {bands.map((b, i) => (
            <tr key={i}>
              <td>
                <input className="field py-1 tabular" value={b.min} aria-label={`Row ${i + 1} minimum`} onChange={(e) => onChange(bands.map((x, j) => (j === i ? { ...x, min: num(e.target.value, x.min) } : x)))} />
              </td>
              <td className="w-28">
                <PointsInput value={b.points} label={`Row ${i + 1} points`} onChange={(v) => onChange(bands.map((x, j) => (j === i ? { ...x, points: v } : x)))} />
              </td>
              <td className="w-10">
                <button type="button" className={buttonClass("ghost", true)} onClick={() => onChange(bands.filter((_, j) => j !== i))} aria-label="Remove row">
                  <Trash2 size={12} aria-hidden />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className={cx(buttonClass("ghost", true), "mt-1")} onClick={() => onChange([...bands, { min: 1, points: 0 }])}>
        <Plus size={12} aria-hidden /> Add row
      </button>
    </div>
  );
}
