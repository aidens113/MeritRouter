"use client";

import { useState, type ReactNode } from "react";
import { CheckCircle2, RotateCcw, Save } from "lucide-react";
import type { EndpointOverride } from "switchyard-router";
import { ActionStatus, useAction } from "./actions";
import { Badge, buttonClass, cx, HelpTip } from "../ui";

type Tri = "" | "true" | "false";

const triOf = (v: boolean | undefined): Tri => (v === undefined ? "" : v ? "true" : "false");
const triVal = (t: Tri): boolean | undefined => (t === "" ? undefined : t === "true");

export interface OverrideEditorProps {
  id: string;
  current: EndpointOverride | null;
  discovered: {
    totalB: number | null;
    activeB: number | null;
    contextTokens: number | null;
    outputTokens: number | null;
    modalities: string[];
    supportsTools: boolean;
    supportsStructuredOutput: boolean;
    free: boolean;
    needsConfirmation: boolean;
    heuristic: boolean;
  };
  profiles: string[];
  modalities: string[];
}

/** Edits the panel override for one model (sent whole; empty fields mean "use discovered value"). */
export function OverrideEditor({ id, current, discovered, profiles, modalities }: OverrideEditorProps) {
  const o = current ?? {};
  const [totalB, setTotalB] = useState(o.totalParametersB != null ? String(o.totalParametersB) : "");
  const [activeB, setActiveB] = useState(o.activeParametersB != null ? String(o.activeParametersB) : "");
  const [confirm, setConfirm] = useState(Boolean(o.confirmParams));
  const [status, setStatus] = useState<string>(o.forceStatus ?? "");
  const [denied, setDenied] = useState<string[]>(o.deniedProfiles ?? []);
  const [free, setFree] = useState<Tri>(triOf(o.freeVerified));
  const [ctx, setCtx] = useState(o.contextLimitTokens ? String(o.contextLimitTokens) : "");
  const [out, setOut] = useState(o.outputLimitTokens ? String(o.outputLimitTokens) : "");
  const [mods, setMods] = useState<string[] | null>(o.inputModalities ?? null);
  const [tools, setTools] = useState<Tri>(triOf(o.supportsTools));
  const [structured, setStructured] = useState<Tri>(triOf(o.supportsStructuredOutput));
  const [scopes, setScopes] = useState((o.quotaScopeIds ?? []).join(", "));
  const [note, setNote] = useState(o.note ?? "");
  const [localError, setLocalError] = useState<string | null>(null);
  const { run, busy, error, message } = useAction();

  const build = (): EndpointOverride | string => {
    const n: EndpointOverride = {};
    const pos = (s: string, label: string, int = false): number | undefined | string => {
      if (!s.trim()) return undefined;
      const v = Number(s);
      if (!Number.isFinite(v) || v <= 0 || (int && !Number.isInteger(v))) return `${label} must be a positive ${int ? "whole " : ""}number`;
      return v;
    };
    const t = pos(totalB, "Total parameters");
    const a = pos(activeB, "Active parameters");
    const c = pos(ctx, "Context limit", true);
    const ou = pos(out, "Output limit", true);
    for (const v of [t, a, c, ou]) if (typeof v === "string") return v;
    if (typeof t === "number") n.totalParametersB = t;
    if (typeof a === "number") n.activeParametersB = a;
    if (typeof c === "number") n.contextLimitTokens = c;
    if (typeof ou === "number") n.outputLimitTokens = ou;
    if (confirm) n.confirmParams = true;
    if (status === "active" || status === "disabled") n.forceStatus = status;
    if (denied.length) n.deniedProfiles = denied as EndpointOverride["deniedProfiles"];
    const fv = triVal(free);
    if (fv !== undefined) n.freeVerified = fv;
    if (mods) {
      if (!mods.length) return "Pick at least one input type, or reset input types to discovered";
      n.inputModalities = mods as EndpointOverride["inputModalities"];
    }
    const tv = triVal(tools);
    if (tv !== undefined) n.supportsTools = tv;
    const sv = triVal(structured);
    if (sv !== undefined) n.supportsStructuredOutput = sv;
    const sc = scopes.split(",").map((s) => s.trim()).filter(Boolean);
    if (sc.length) n.quotaScopeIds = sc;
    if (note.trim()) n.note = note.trim();
    return n;
  };

  const save = async (override: EndpointOverride | null, success: string) => {
    setLocalError(null);
    await run("/api/models/override", "POST", { id, override }, { success });
  };

  const onSave = async () => {
    const n = build();
    if (typeof n === "string") {
      setLocalError(n);
      return;
    }
    await save(Object.keys(n).length ? n : null, Object.keys(n).length ? "Override saved" : "No overrides left: using discovered values");
  };

  const active = current ? Object.keys(current).filter((k) => (current as Record<string, unknown>)[k] !== undefined) : [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        {active.length ? (
          <>
            <Badge tone="accent">Overrides active</Badge>
            <span className="text-xs text-ink-3">{active.map(labelFor).join(", ")}</span>
          </>
        ) : (
          <span className="text-xs text-ink-3">No overrides: every value comes from discovery or the models file.</span>
        )}
        <HelpTip term="override" />
      </div>

      {discovered.needsConfirmation && discovered.heuristic && !current?.confirmParams ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warn/40 bg-warn-soft px-3 py-2.5 text-sm">
          <span className="text-ink">
            The size <strong>{discovered.totalB}B</strong> was read from the model name or description. If it is right, confirm it so the model can be used.
          </span>
          <button type="button" className={buttonClass("primary", true)} disabled={busy} onClick={() => save({ ...(current ?? {}), confirmParams: true }, "Parameter count confirmed")}>
            <CheckCircle2 size={13} aria-hidden /> Confirm {discovered.totalB}B
          </button>
        </div>
      ) : null}

      <Group title="Status">
        <Radio
          name="status"
          value={status}
          onChange={setStatus}
          options={[
            ["", "Automatic", "Active when size, price, and limits are known"],
            ["active", "Force enable", "Use even if the size is unconfirmed"],
            ["disabled", "Force disable", "Never route to this model"],
          ]}
        />
      </Group>

      <Group title="Size (billions of parameters)" help="provenance">
        <div className="grid gap-3 sm:grid-cols-2">
          <NumberField label="Total parameters" value={totalB} onChange={setTotalB} placeholder={discovered.totalB != null ? `discovered: ${discovered.totalB}` : "unknown"} suffix="B" />
          <NumberField label="Active parameters (MoE)" value={activeB} onChange={setActiveB} placeholder={discovered.activeB != null ? `discovered: ${discovered.activeB}` : "dense / unknown"} suffix="B" />
        </div>
        <label className="mt-2 flex items-center gap-2 text-sm text-ink-2">
          <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
          Accept the discovered size as correct (confirm)
        </label>
        <p className="mt-1 text-xs text-ink-3">Entering a size marks it Exact (your override) and confirms it.</p>
      </Group>

      <Group title="Block for task types">
        <div className="flex flex-wrap gap-2">
          {profiles.map((p) => (
            <label key={p} className={cx("flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-sm", denied.includes(p) ? "border-bad/40 bg-bad-soft text-bad-ink" : "border-line text-ink-2")}>
              <input type="checkbox" checked={denied.includes(p)} onChange={(e) => setDenied((d) => (e.target.checked ? [...d, p] : d.filter((x) => x !== p)))} />
              {p}
            </label>
          ))}
        </div>
        <p className="mt-1 text-xs text-ink-3">Blocked task types never use this model, at any tier. For one tier only, add a Block rule on the Routing page.</p>
      </Group>

      <Group title="Price" help="freeVerified">
        <Radio
          name="free"
          value={free}
          onChange={(v) => setFree(v as Tri)}
          options={[
            ["", "Automatic", discovered.free ? "currently verified free" : "currently not verified free"],
            ["true", "Mark free", "You checked this model is free on your accounts"],
            ["false", "Mark not free", "Never route to it while paid routing is off"],
          ]}
        />
      </Group>

      <Group title="Limits and capabilities">
        <div className="grid gap-3 sm:grid-cols-2">
          <NumberField label="Context limit" value={ctx} onChange={setCtx} placeholder={discovered.contextTokens ? `discovered: ${discovered.contextTokens}` : "unknown"} suffix="tokens" />
          <NumberField label="Output limit" value={out} onChange={setOut} placeholder={discovered.outputTokens ? `discovered: ${discovered.outputTokens}` : "unknown"} suffix="tokens" />
          <TriSelect label="Tool calling" value={tools} onChange={setTools} discovered={discovered.supportsTools} />
          <TriSelect label="Structured output" value={structured} onChange={setStructured} discovered={discovered.supportsStructuredOutput} />
        </div>
        <div className="mt-3">
          <div className="mb-1 flex items-center gap-2 text-sm text-ink-2">
            Input types
            {mods ? (
              <button type="button" className="text-xs text-accent-ink hover:underline" onClick={() => setMods(null)}>
                reset to discovered ({discovered.modalities.join(", ")})
              </button>
            ) : (
              <span className="text-xs text-ink-3">discovered: {discovered.modalities.join(", ")}</span>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {modalities.map((m) => {
              const list = mods ?? discovered.modalities;
              return (
                <label key={m} className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-sm text-ink-2">
                  <input type="checkbox" checked={list.includes(m)} onChange={(e) => setMods(e.target.checked ? [...list, m] : list.filter((x) => x !== m))} />
                  {m}
                </label>
              );
            })}
          </div>
        </div>
      </Group>

      <Group title="Quota scope and note" help="quotaScope">
        <label className="block text-sm text-ink-2">
          Quota scope ids (comma separated)
          <input value={scopes} onChange={(e) => setScopes(e.target.value)} className="field mt-1" placeholder="e.g. groq-personal" />
        </label>
        <label className="mt-3 block text-sm text-ink-2">
          Note
          <input value={note} onChange={(e) => setNote(e.target.value)} className="field mt-1" placeholder="Why you changed this (shown on the model)" />
        </label>
      </Group>

      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
        <button type="button" className={buttonClass("primary")} disabled={busy} onClick={onSave}>
          <Save size={14} aria-hidden /> Save overrides
        </button>
        {current ? (
          <button type="button" className={buttonClass("secondary")} disabled={busy} onClick={() => save(null, "Overrides removed")}>
            <RotateCcw size={14} aria-hidden /> Reset all overrides
          </button>
        ) : null}
      </div>
      <ActionStatus error={localError ?? error} message={message} />
    </div>
  );
}

function labelFor(k: string): string {
  return (
    {
      totalParametersB: "size",
      activeParametersB: "active size",
      confirmParams: "size confirmed",
      forceStatus: "status",
      deniedProfiles: "blocked task types",
      freeVerified: "price",
      contextLimitTokens: "context limit",
      outputLimitTokens: "output limit",
      inputModalities: "input types",
      supportsTools: "tool calling",
      supportsStructuredOutput: "structured output",
      quotaScopeIds: "quota scope",
      note: "note",
    } as Record<string, string>
  )[k] ?? k;
}

function Group({ title, help, children }: { title: string; help?: "provenance" | "freeVerified" | "quotaScope"; children: ReactNode }) {
  return (
    <fieldset>
      <legend className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-ink">
        {title}
        {help ? <HelpTip term={help} /> : null}
      </legend>
      {children}
    </fieldset>
  );
}

function Radio({ name, value, onChange, options }: { name: string; value: string; onChange: (v: string) => void; options: Array<[string, string, string]> }) {
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      {options.map(([v, label, hint]) => (
        <label key={v} className={cx("cursor-pointer rounded-lg border px-3 py-2 text-sm", value === v ? "border-accent bg-accent-soft" : "border-line hover:bg-surface-2")}>
          <span className="flex items-center gap-2 font-medium text-ink">
            <input type="radio" name={name} checked={value === v} onChange={() => onChange(v)} />
            {label}
          </span>
          <span className="mt-0.5 block pl-5 text-xs text-ink-3">{hint}</span>
        </label>
      ))}
    </div>
  );
}

function NumberField({ label, value, onChange, placeholder, suffix }: { label: string; value: string; onChange: (v: string) => void; placeholder: string; suffix: string }) {
  return (
    <label className="block text-sm text-ink-2">
      {label}
      <span className="mt-1 flex items-center gap-2">
        <input inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="field" />
        <span className="text-xs text-ink-3">{suffix}</span>
      </span>
    </label>
  );
}

function TriSelect({ label, value, onChange, discovered }: { label: string; value: Tri; onChange: (v: Tri) => void; discovered: boolean }) {
  return (
    <label className="block text-sm text-ink-2">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value as Tri)} className="field mt-1">
        <option value="">Discovered ({discovered ? "yes" : "no"})</option>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </select>
    </label>
  );
}
