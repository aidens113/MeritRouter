"use client";

import { useMemo, useState, type ReactNode } from "react";
import YAML from "yaml";
import { Globe, RotateCcw, Save, SlidersHorizontal, Undo2 } from "lucide-react";
import { ActionStatus, useAction } from "@/components/client/actions";
import { LinesEditor } from "@/components/client/lines-editor";
import { blankRow, RowsEditor, type Column } from "@/components/client/settings-rows";
import { Badge, buttonClass, Card, CardHeader, cx } from "@/components/ui";
import type { OverrideItem } from "./fields";

// Override rows for the project settings page: each shows the install-wide value it inherits,
// "Override for this project" to set the project's own value, and "Reset to global" to drop it.
// A card saves its rows together through PATCH /api/projects/<slug>/settings; a reset sends null.

type RowCells = Record<string, string | boolean | string[]>;
type RoleDraft = { charter: string; rules: string[]; custom: boolean; grants: RowCells[] };
type Draft = string | boolean | string[] | RoleDraft | RowCells[];

export const GRANT_COLUMNS: Column[] = [
  { key: "pattern", label: "Path pattern", kind: "text", wide: true, placeholder: "projects/{project}/decisions/**", help: "Glob; {project}, {effort}, {task}, {repo} are filled in." },
  { key: "mode", label: "Access", kind: "select", options: ["read", "append", "write", "admin"] },
];

export const AUTO_APPROVE_COLUMNS: Column[] = [
  { key: "pattern", label: "Path pattern", kind: "text", wide: true, placeholder: "projects/demo/facts/**" },
  { key: "mode", label: "Up to access", kind: "select", options: ["read", "append", "write", "admin"] },
  { key: "min_tier", label: "Minimum tier", kind: "select", options: ["T1", "T2", "T3"] },
];

/** Rows of plain objects from editor cells: required text columns, optional ones dropped when empty. */
function rowsValue(cols: Column[], rows: RowCells[]): { value: Array<Record<string, unknown>> } | { error: string } {
  const out: Array<Record<string, unknown>> = [];
  for (const [i, r] of rows.entries()) {
    const o: Record<string, unknown> = {};
    for (const c of cols) {
      const v = r[c.key];
      if (c.kind === "bool") o[c.key] = Boolean(v);
      else if (c.kind === "multi") o[c.key] = v;
      else {
        const s = String(v ?? "").trim();
        if (!s && c.kind !== "optText") return { error: `Row ${i + 1}: ${c.label} is required` };
        if (s) o[c.key] = s;
      }
    }
    out.push(o);
  }
  return { value: out };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function toDraft(item: OverrideItem, v: unknown): Draft {
  switch (item.kind) {
    case "bool":
      return Boolean(v);
    case "list":
      return Array.isArray(v) ? v.map(String) : [];
    case "yaml":
      return v === undefined ? "" : YAML.stringify(v).trimEnd();
    case "role": {
      const r = isObj(v) ? v : {};
      const grants = Array.isArray(r.brain_grants) ? (r.brain_grants as Array<Record<string, unknown>>) : null;
      return { charter: typeof r.charter_file === "string" ? r.charter_file : "", rules: Array.isArray(r.extra_rules) ? r.extra_rules.map(String) : [], custom: grants !== null, grants: (grants ?? []).map((g) => blankRow(GRANT_COLUMNS, g)) };
    }
    case "autoApprove":
      return (Array.isArray(v) ? (v as Array<Record<string, unknown>>) : []).map((g) => blankRow(AUTO_APPROVE_COLUMNS, g));
    default:
      return v === undefined || v === null ? "" : String(v);
  }
}

function fromDraft(item: OverrideItem, d: Draft): { value: unknown } | { error: string } {
  switch (item.kind) {
    case "bool":
      return { value: Boolean(d) };
    case "list":
      return { value: (d as string[]).map((s) => s.trim()).filter(Boolean) };
    case "yaml": {
      try {
        const v = YAML.parse(d as string) as unknown;
        if (v === null || v === undefined) return { error: "Enter a value, or reset to global" };
        return { value: v };
      } catch (err) {
        return { error: `Not valid YAML: ${(err as Error).message.split("\n")[0]}` };
      }
    }
    case "role": {
      const r = d as RoleDraft;
      const value: Record<string, unknown> = { extra_rules: r.rules.map((x) => x.trim()).filter(Boolean) };
      if (r.charter.trim()) value.charter_file = r.charter.trim();
      if (r.custom) {
        const g = rowsValue(GRANT_COLUMNS, r.grants);
        if ("error" in g) return g;
        value.brain_grants = g.value;
      }
      return { value };
    }
    case "autoApprove":
      return rowsValue(AUTO_APPROVE_COLUMNS, d as RowCells[]);
    case "text":
      return String(d).trim() ? { value: String(d).trim() } : { error: "Required" };
    case "enum":
      return String(d) ? { value: String(d) } : { error: "Choose a value" };
    default: {
      const s = String(d).trim();
      if (!s) return { error: "Enter a number, or reset to global" };
      const n = Number(s);
      if (!Number.isFinite(n)) return { error: "Enter a number" };
      if (item.kind === "int" && !Number.isInteger(n)) return { error: "Enter a whole number" };
      if (item.min !== undefined && n < item.min) return { error: `At least ${item.min}` };
      if (item.max !== undefined && n > item.max) return { error: `At most ${item.max}` };
      return { value: n };
    }
  }
}

/** A short rendering of a global value: scalars inline, lists joined, objects as YAML. */
export function GlobalValue({ item }: { item: OverrideItem }) {
  const v = item.global;
  if (v === undefined || v === null) return <span className="italic">{item.unsetNote ?? "not set"}</span>;
  if (typeof v === "boolean") return <span className="font-medium text-ink-2">{v ? "on" : "off"}</span>;
  if (Array.isArray(v) && v.every((x) => typeof x !== "object")) return v.length ? <span className="font-mono text-ink-2">{v.join(", ")}</span> : <span className="italic">none</span>;
  if (typeof v === "object") {
    const text = YAML.stringify(v).trimEnd();
    return (
      <details className="inline-block align-top">
        <summary className="cursor-pointer text-accent-ink hover:underline">show ({text.split("\n").length} lines)</summary>
        <pre className="mt-1 max-h-60 overflow-auto rounded-md bg-surface-2 p-2 font-mono text-[11px] text-ink-2">{text}</pre>
      </details>
    );
  }
  return <span className="font-mono text-ink-2">{String(v)}{item.unit ? ` ${item.unit}` : ""}</span>;
}

type RowState = { on: boolean; draft: Draft };

/** State and patch building for a set of override rows. */
export function useOverrideRows(items: OverrideItem[]) {
  const initial = useMemo(() => Object.fromEntries(items.map((i) => [i.id, { on: i.overridden, draft: toDraft(i, i.overridden ? i.override : i.global) } as RowState])), [items]);
  const [rows, setRows] = useState<Record<string, RowState>>(initial);
  const dirtyIds = items.filter((i) => {
    const a = rows[i.id]!;
    const b = initial[i.id]!;
    return a.on !== b.on || (a.on && JSON.stringify(a.draft) !== JSON.stringify(b.draft));
  }).map((i) => i.id);

  const set = (id: string, s: Partial<RowState>) => setRows((r) => ({ ...r, [id]: { ...r[id]!, ...s } }));
  const reset = () => setRows(initial);
  /** The patch for the changed rows, or the rows' local errors. */
  const build = (): { patch: Array<{ path: string[]; value: unknown }>; errors: Record<string, string> } => {
    const patch: Array<{ path: string[]; value: unknown }> = [];
    const errors: Record<string, string> = {};
    for (const i of items) {
      if (!dirtyIds.includes(i.id)) continue;
      const st = rows[i.id]!;
      if (!st.on) {
        patch.push({ path: i.path, value: null });
        continue;
      }
      const r = fromDraft(i, st.draft);
      if ("error" in r) errors[i.id] = r.error;
      else patch.push({ path: i.path, value: r.value });
    }
    return { patch, errors };
  };
  return { rows, set, reset, dirtyIds, build, initial };
}

/** Assign server field errors (`team.max_agents`, `verification.levels.deep.review`) to rows. */
export function errorsForRows(items: OverrideItem[], fieldErrors: Record<string, string[]> | undefined): { byRow: Record<string, string>; rest: string[] } {
  const byRow: Record<string, string> = {};
  const rest: string[] = [];
  for (const [k, msgs] of Object.entries(fieldErrors ?? {})) {
    const item = items.find((i) => k === i.id || k.startsWith(`${i.id}.`));
    if (item) byRow[item.id] = [byRow[item.id], ...msgs.map((m) => (k === item.id ? m : `${k.slice(item.id.length + 1)}: ${m}`))].filter(Boolean).join("; ");
    else rest.push(...msgs.map((m) => (k === "form" ? m : `${k}: ${m}`)));
  }
  return { byRow, rest };
}

export function OverrideRow({
  item,
  state,
  dirty,
  error,
  disabled,
  onChange,
}: {
  item: OverrideItem;
  state: RowState;
  dirty: boolean;
  error: string | undefined;
  disabled?: boolean;
  onChange: (s: Partial<RowState>) => void;
}) {
  const id = `ov-${item.id.replace(/[^\w-]/g, "-")}`;
  return (
    <div className={cx("grid gap-3 px-4 py-3 sm:grid-cols-[1fr_auto]", state.on && "bg-accent-soft/30")}>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={state.on && item.kind !== "role" && item.kind !== "autoApprove" ? id : undefined} className="text-sm font-medium text-ink">
            {item.label}
          </label>
          {state.on ? <Badge tone="accent" icon={<SlidersHorizontal size={11} aria-hidden />}>this project</Badge> : <Badge icon={<Globe size={11} aria-hidden />}>global</Badge>}
          {dirty ? <Badge tone="warn">{state.on ? "unsaved" : "resets on save"}</Badge> : null}
        </div>
        {item.help ? <p id={`${id}-help`} className="mt-0.5 text-xs leading-relaxed text-ink-3">{item.help}</p> : null}
        {/* A div, not a p: an object value renders a <details> with a <pre>, which a <p> cannot hold. */}
        <div className="mt-1 text-xs text-ink-3">
          Global value: <GlobalValue item={item} />
        </div>
        {state.on ? (
          <div className="mt-2">
            <Editor id={id} item={item} draft={state.draft} error={error} onChange={(draft) => onChange({ draft })} />
          </div>
        ) : null}
        {error ? (
          <p role="alert" id={`${id}-error`} className="mt-1 text-xs text-bad-ink">
            {error}
          </p>
        ) : null}
      </div>
      <div className="flex items-start sm:justify-end">
        {state.on ? (
          <button type="button" disabled={disabled} className={buttonClass("ghost", true)} onClick={() => onChange({ on: false, draft: toDraft(item, item.global) })}>
            <Undo2 size={13} aria-hidden /> Reset to global
          </button>
        ) : (
          <button type="button" disabled={disabled} className={buttonClass("secondary", true)} onClick={() => onChange({ on: true })}>
            <SlidersHorizontal size={13} aria-hidden /> Override for this project
          </button>
        )}
      </div>
    </div>
  );
}

function Editor({ id, item, draft, error, onChange }: { id: string; item: OverrideItem; draft: Draft; error: string | undefined; onChange: (d: Draft) => void }) {
  const aria = { "aria-invalid": Boolean(error), "aria-describedby": [item.help ? `${id}-help` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined };
  switch (item.kind) {
    case "bool":
      return (
        <label className="flex items-center gap-2 text-sm text-ink">
          <input id={id} type="checkbox" checked={Boolean(draft)} onChange={(e) => onChange(e.target.checked)} {...aria} /> {draft ? "On" : "Off"} for this project
        </label>
      );
    case "enum":
      return (
        <select id={id} value={String(draft)} onChange={(e) => onChange(e.target.value)} className="field max-w-xs" {...aria}>
          {item.options?.map((o) => (
            <option key={o} value={o}>
              {o.replace(/_/g, " ")}
            </option>
          ))}
        </select>
      );
    case "list":
      return (
        <div id={id}>
          <LinesEditor value={draft as string[]} onChange={onChange} mono placeholder="pnpm test*" addLabel="Add" />
        </div>
      );
    case "yaml":
      return <textarea id={id} value={String(draft)} onChange={(e) => onChange(e.target.value)} rows={Math.min(16, Math.max(4, String(draft).split("\n").length + 1))} spellCheck={false} className="field font-mono text-[12px]" {...aria} />;
    case "role": {
      const r = draft as RoleDraft;
      const up = (p: Partial<RoleDraft>) => onChange({ ...r, ...p });
      return (
        <div className="space-y-3 rounded-lg border border-line bg-surface p-3">
          <label className="block text-xs text-ink-3">
            Charter file
            <input value={r.charter} onChange={(e) => up({ charter: e.target.value })} className="field mt-0.5 font-mono text-[13px]" placeholder="built-in charter" />
            <span className="mt-0.5 block">Markdown file replacing the built-in charter, relative to the config file. Empty: built-in.</span>
          </label>
          <div>
            <div className="text-xs text-ink-3">Extra rules (appended to the charter)</div>
            <div className="mt-1">
              <LinesEditor value={r.rules} onChange={(rules) => up({ rules })} placeholder="e.g. Never edit generated files under src/gen/" addLabel="Add rule" />
            </div>
          </div>
          <div>
            <label className="flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" checked={r.custom} onChange={(e) => up({ custom: e.target.checked, grants: e.target.checked && !r.grants.length ? [blankRow(GRANT_COLUMNS, { pattern: "", mode: "read" })] : r.grants })} />
              Custom brain grants
            </label>
            <span className="mt-0.5 block text-xs text-ink-3">Off: the built-in defaults for the role. On: exactly the grants below.</span>
            {r.custom ? (
              <div className="mt-2">
                <RowsEditor columns={GRANT_COLUMNS} rows={r.grants} onChange={(grants) => up({ grants })} newRow={blankRow(GRANT_COLUMNS, { pattern: "", mode: "read" })} addLabel="Add grant" empty="No grants: this role cannot read or write the brain." />
              </div>
            ) : null}
          </div>
        </div>
      );
    }
    case "autoApprove":
      return <RowsEditor columns={AUTO_APPROVE_COLUMNS} rows={draft as RowCells[]} onChange={onChange} newRow={blankRow(AUTO_APPROVE_COLUMNS, { pattern: "", mode: "read", min_tier: "T1" })} addLabel="Add rule" empty="No rules: every request waits for the approver." />;
    default:
      return (
        <div className="flex items-center gap-2">
          <input
            id={id}
            value={String(draft)}
            onChange={(e) => onChange(e.target.value)}
            inputMode={item.kind === "text" ? undefined : "decimal"}
            className={cx("field max-w-xs", item.kind === "text" ? "font-mono text-[13px]" : "tabular")}
            {...aria}
          />
          {item.unit ? <span className="shrink-0 text-xs text-ink-3">{item.unit}</span> : null}
        </div>
      );
  }
}

/** Save bar shared by the settings cards. */
export function SaveBar({ busy, dirty, onSave, onDiscard, error, message, errors, label = "Save changes" }: { busy: boolean; dirty: number; onSave: () => void; onDiscard: () => void; error: string | null; message: string | null; errors?: string[]; label?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3">
      <button type="button" className={buttonClass("primary", true)} disabled={busy || dirty === 0} onClick={onSave}>
        <Save size={13} aria-hidden /> {label}
      </button>
      {dirty ? (
        <button type="button" className={buttonClass("ghost", true)} onClick={onDiscard}>
          <RotateCcw size={13} aria-hidden /> Discard changes
        </button>
      ) : null}
      <div className="min-w-0 flex-1">
        <ActionStatus error={error} message={message} errors={errors} />
      </div>
    </div>
  );
}

/** A card of override rows (verification, team policy, commands and paths, roles). */
export function OverridesCard({ id, slug, title, description, items, locked, children }: { id: string; slug: string; title: string; description: ReactNode; items: OverrideItem[]; locked?: ReactNode; children?: ReactNode }) {
  const o = useOverrideRows(items);
  const { run, busy, error, message, setError } = useAction();
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [rest, setRest] = useState<string[]>([]);
  const ownCount = items.filter((i) => i.overridden).length;

  const save = async () => {
    const { patch, errors } = o.build();
    setRowErrors(errors);
    setRest([]);
    if (Object.keys(errors).length) return setError("Fix the highlighted settings.");
    const r = await run(`/api/projects/${encodeURIComponent(slug)}/settings`, "PATCH", { patch }, { success: "Saved. Running workers pick the change up automatically." });
    if (!r.ok) {
      const m = errorsForRows(items, r.fieldErrors as Record<string, string[]> | undefined);
      setRowErrors(m.byRow);
      setRest(m.rest);
    }
  };

  return (
    <Card id={id}>
      <CardHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {title}
            {ownCount ? <Badge tone="accent">{ownCount} set for this project</Badge> : <Badge>all global</Badge>}
          </span>
        }
        description={description}
      />
      {children}
      {locked ? (
        <div className="p-4 text-sm text-ink-2">{locked}</div>
      ) : (
        <>
          <div className="divide-y divide-line">
            {items.map((i) => (
              <OverrideRow key={i.id} item={i} state={o.rows[i.id]!} dirty={o.dirtyIds.includes(i.id)} error={rowErrors[i.id]} disabled={busy} onChange={(s) => o.set(i.id, s)} />
            ))}
          </div>
          <SaveBar
            busy={busy}
            dirty={o.dirtyIds.length}
            onSave={() => void save()}
            onDiscard={() => {
              o.reset();
              setRowErrors({});
              setRest([]);
              setError(null);
            }}
            error={error}
            message={message}
            errors={rest}
          />
        </>
      )}
    </Card>
  );
}
