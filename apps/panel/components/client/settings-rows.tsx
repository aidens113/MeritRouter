"use client";

import { useMemo, useState } from "react";
import { Plus, RotateCcw, Save, Trash2 } from "lucide-react";
import { ActionStatus, useAction } from "./actions";
import { LinesEditor } from "./lines-editor";
import { Badge, buttonClass, Card, CardHeader, cx } from "../ui";

export type ColumnKind = "text" | "optText" | "int" | "number" | "optNumber" | "bool" | "select" | "multi";

export interface Column {
  key: string;
  label: string;
  kind: ColumnKind;
  help?: string;
  options?: string[];
  placeholder?: string;
  /** Wider field (spans two grid columns). */
  wide?: boolean;
}

type Draft = Record<string, string | boolean | string[]>;

function toDraft(cols: Column[], row: Record<string, unknown>): Draft {
  return Object.fromEntries(
    cols.map((c) => {
      const v = row[c.key];
      if (c.kind === "bool") return [c.key, Boolean(v)];
      if (c.kind === "multi") return [c.key, Array.isArray(v) ? v.map(String) : []];
      return [c.key, v === undefined || v === null ? "" : String(v)];
    }),
  );
}

/** Convert one draft row to config values; returns the first problem found instead when invalid. */
function fromDraft(cols: Column[], d: Draft, n: number): { value: Record<string, unknown> } | { error: string } {
  const out: Record<string, unknown> = {};
  for (const c of cols) {
    const v = d[c.key];
    if (c.kind === "bool") out[c.key] = Boolean(v);
    else if (c.kind === "multi") out[c.key] = v as string[];
    else {
      const s = String(v ?? "").trim();
      if (c.kind === "optText" || c.kind === "optNumber") {
        if (!s) continue;
      } else if (!s) return { error: `Row ${n}: ${c.label} is required` };
      if (c.kind === "int" || c.kind === "number" || c.kind === "optNumber") {
        const num = Number(s);
        if (!Number.isFinite(num)) return { error: `Row ${n}: ${c.label} must be a number` };
        if (c.kind === "int" && !Number.isInteger(num)) return { error: `Row ${n}: ${c.label} must be a whole number` };
        out[c.key] = num;
      } else out[c.key] = s;
    }
  }
  return { value: out };
}

export function blankRow(cols: Column[], defaults: Record<string, unknown> = {}): Draft {
  return toDraft(cols, defaults);
}

/**
 * Controlled editor for a list of objects, each row a small grid of labelled fields. `errors`
 * (keyed `<row index>.<column key>`) are shown under their text fields.
 */
export function RowsEditor({ columns, rows, onChange, newRow, addLabel, empty, errors = {} }: { columns: Column[]; rows: Draft[]; onChange: (r: Draft[]) => void; newRow: Draft; addLabel: string; empty: string; errors?: Record<string, string> }) {
  const set = (i: number, k: string, v: string | boolean | string[]) => onChange(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return (
    <div className="space-y-3">
      {rows.length === 0 ? <p className="text-sm text-ink-3">{empty}</p> : null}
      {rows.map((r, i) => (
        <div key={i} className="rounded-lg border border-line p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-ink-3">#{i + 1}</span>
            <button type="button" className={buttonClass("ghost", true)} onClick={() => onChange(rows.filter((_, j) => j !== i))} aria-label={`Remove row ${i + 1}`}>
              <Trash2 size={13} aria-hidden /> Remove
            </button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {columns.map((c) => (
              <div key={c.key} className={cx(c.wide && "sm:col-span-2")}>
                {c.kind === "bool" ? (
                  <label className="mt-5 flex items-center gap-2 text-sm text-ink" title={c.help}>
                    <input type="checkbox" checked={Boolean(r[c.key])} onChange={(e) => set(i, c.key, e.target.checked)} />
                    {c.label}
                  </label>
                ) : c.kind === "multi" ? (
                  <fieldset title={c.help}>
                    <legend className="text-xs text-ink-3">{c.label}</legend>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                      {c.options?.map((o) => (
                        <label key={o} className="flex items-center gap-1 text-sm text-ink-2">
                          <input
                            type="checkbox"
                            checked={(r[c.key] as string[]).includes(o)}
                            onChange={(e) => set(i, c.key, e.target.checked ? [...(r[c.key] as string[]), o] : (r[c.key] as string[]).filter((x) => x !== o))}
                          />
                          {o}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                ) : (
                  <label className="block text-xs text-ink-3" title={c.help}>
                    {c.label}
                    {c.kind === "select" ? (
                      <select value={String(r[c.key])} onChange={(e) => set(i, c.key, e.target.value)} className="field mt-0.5">
                        {!c.options?.includes(String(r[c.key])) ? <option value={String(r[c.key])}>{String(r[c.key]) || "Choose…"}</option> : null}
                        {c.options?.map((o) => (
                          <option key={o} value={o}>
                            {o.replace(/_/g, " ")}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        value={String(r[c.key])}
                        onChange={(e) => set(i, c.key, e.target.value)}
                        placeholder={c.placeholder}
                        inputMode={c.kind === "text" || c.kind === "optText" ? undefined : "decimal"}
                        className={cx("field mt-0.5", c.kind === "text" || c.kind === "optText" ? "font-mono text-[13px]" : "tabular")}
                        aria-invalid={Boolean(errors[`${i}.${c.key}`])}
                        aria-describedby={errors[`${i}.${c.key}`] ? `row-${i}-${c.key}-error` : undefined}
                      />
                    )}
                    {errors[`${i}.${c.key}`] ? (
                      <span id={`row-${i}-${c.key}-error`} role="alert" className="mt-1 block break-all text-xs text-bad-ink">
                        {errors[`${i}.${c.key}`]}
                      </span>
                    ) : null}
                    {c.help ? <span className="mt-0.5 block text-[11px] leading-snug text-ink-3">{c.help}</span> : null}
                  </label>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
      <button type="button" className={buttonClass("secondary", true)} onClick={() => onChange([...rows, { ...newRow }])}>
        <Plus size={13} aria-hidden /> {addLabel}
      </button>
    </div>
  );
}

/**
 * A settings card for a list-valued config entry (paid.models, brain.mounts, …). When `keyField`
 * is set, the rows are saved as a map keyed by that field (paid.providers).
 */
export function RowsForm({
  id,
  title,
  description,
  path,
  columns,
  rows,
  keyField,
  newRow,
  addLabel,
  empty,
}: {
  id: string;
  title: string;
  description: string;
  path: string[];
  columns: Column[];
  rows: Array<Record<string, unknown>>;
  keyField?: string;
  newRow: Record<string, unknown>;
  addLabel: string;
  empty: string;
}) {
  const initial = useMemo(() => rows.map((r) => toDraft(columns, r)), [rows, columns]);
  const [draft, setDraft] = useState<Draft[]>(initial);
  const { run, busy, error, errors, message, setError } = useAction();
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);

  const save = async () => {
    const values: Array<Record<string, unknown>> = [];
    for (const [i, d] of draft.entries()) {
      const r = fromDraft(columns, d, i + 1);
      if ("error" in r) return setError(r.error);
      values.push(r.value);
    }
    let value: unknown = values;
    if (keyField) {
      const map: Record<string, unknown> = {};
      for (const v of values) {
        const k = String(v[keyField]);
        if (map[k]) return setError(`Two entries are named ${k}`);
        const { [keyField]: _omit, ...rest } = v;
        map[k] = rest;
      }
      value = map;
    }
    await run("/api/config", "POST", { patch: [{ path, value }] }, { success: "Saved. Running workers pick the change up automatically." });
  };

  return (
    <Card id={id}>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            {title}
            {dirty ? <Badge tone="warn">unsaved</Badge> : null}
          </span>
        }
        description={description}
      />
      <div className="p-4">
        <RowsEditor columns={columns} rows={draft} onChange={setDraft} newRow={toDraft(columns, newRow)} addLabel={addLabel} empty={empty} />
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3">
        <button type="button" className={buttonClass("primary", true)} disabled={busy || !dirty} onClick={() => void save()}>
          <Save size={13} aria-hidden /> Save
        </button>
        {dirty ? (
          <button type="button" className={buttonClass("ghost", true)} onClick={() => setDraft(initial)}>
            <RotateCcw size={13} aria-hidden /> Discard changes
          </button>
        ) : null}
        <div className="min-w-0 flex-1">
          <ActionStatus error={error} message={message} errors={errors} />
        </div>
      </div>
    </Card>
  );
}

const GRANT_COLUMNS: Column[] = [
  { key: "pattern", label: "Path pattern", kind: "text", wide: true, placeholder: "projects/{project}/decisions/**", help: "Glob; {project}, {effort}, {task}, {repo} are filled in." },
  { key: "mode", label: "Access", kind: "select", options: ["read", "append", "write", "admin"] },
];

export interface RoleValue {
  charter_file?: string;
  extra_rules?: string[];
  brain_grants?: Array<{ pattern: string; mode: string }>;
}

/** Per-role charter override, extra rules, and brain grants. */
export function RolesForm({ roles, values, help }: { roles: string[]; values: Record<string, RoleValue | undefined>; help: Record<string, string> }) {
  const [role, setRole] = useState(roles[0]!);
  const [state, setState] = useState(() =>
    Object.fromEntries(
      roles.map((r) => {
        const v = values[r];
        return [r, { charter: v?.charter_file ?? "", rules: v?.extra_rules ?? [], custom: Boolean(v?.brain_grants), grants: (v?.brain_grants ?? []).map((g) => toDraft(GRANT_COLUMNS, g)) }];
      }),
    ),
  );
  const { run, busy, error, errors, message, setError } = useAction();
  const cur = state[role]!;
  const update = (patch: Partial<typeof cur>) => setState((s) => ({ ...s, [role]: { ...s[role]!, ...patch } }));
  const configured = roles.filter((r) => values[r]);

  const save = async () => {
    const grants: Array<Record<string, unknown>> = [];
    if (cur.custom) {
      for (const [i, d] of cur.grants.entries()) {
        const r = fromDraft(GRANT_COLUMNS, d, i + 1);
        if ("error" in r) return setError(r.error);
        grants.push(r.value);
      }
    }
    const rules = cur.rules.map((x) => x.trim()).filter(Boolean);
    const value: Record<string, unknown> = { extra_rules: rules };
    if (cur.charter.trim()) value.charter_file = cur.charter.trim();
    if (cur.custom) value.brain_grants = grants;
    const empty = !cur.charter.trim() && !rules.length && !cur.custom;
    await run("/api/config", "POST", { patch: [{ path: ["roles", role], value: empty ? null : value }] }, { success: empty ? `${role} uses the built-in charter and grants.` : `Saved ${role}.` });
  };

  return (
    <Card id="roles">
      <CardHeader title="Roles" description="Each agent role's rules (charter) and default brain access. Leave a role empty to use the built-in charter and grants." />
      <div className="space-y-4 p-4">
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="Role">
          {roles.map((r) => (
            <button key={r} type="button" role="tab" aria-selected={r === role} onClick={() => setRole(r)} className={cx("rounded-lg px-2.5 py-1 text-sm", r === role ? "bg-accent-soft font-medium text-accent-ink" : "text-ink-2 hover:bg-surface-2")}>
              {r}
              {configured.includes(r) ? <span className="ml-1 text-[10px] text-ink-3">customised</span> : null}
            </button>
          ))}
        </div>
        <p className="text-xs text-ink-3">{help[role]}</p>
        <label className="block text-sm font-medium text-ink">
          Charter file
          <input value={cur.charter} onChange={(e) => update({ charter: e.target.value })} className="field mt-1 font-mono text-[13px] font-normal" placeholder="built-in charter" />
          <span className="mt-1 block text-xs font-normal text-ink-3">Markdown file replacing the built-in charter for this role, relative to the config file. Empty: built-in.</span>
        </label>
        <div>
          <div className="text-sm font-medium text-ink">Extra rules</div>
          <div className="mt-1">
            <LinesEditor value={cur.rules} onChange={(v) => update({ rules: v })} placeholder="e.g. Never edit generated files under src/gen/" addLabel="Add rule" />
          </div>
          <span className="mt-1 block text-xs text-ink-3">Appended to the charter as &ldquo;Additional rules&rdquo;.</span>
        </div>
        <div>
          <label className="flex items-center gap-2 text-sm font-medium text-ink">
            <input type="checkbox" checked={cur.custom} onChange={(e) => update({ custom: e.target.checked, grants: e.target.checked && !cur.grants.length ? [toDraft(GRANT_COLUMNS, { pattern: "", mode: "read" })] : cur.grants })} />
            Custom brain grants
          </label>
          <span className="mt-1 block text-xs text-ink-3">Off: the built-in defaults (supervisors read everything and write their project; workers read their job&apos;s context and write only their report). On: exactly the grants below.</span>
          {cur.custom ? (
            <div className="mt-2">
              <RowsEditor columns={GRANT_COLUMNS} rows={cur.grants} onChange={(g) => update({ grants: g })} newRow={toDraft(GRANT_COLUMNS, { pattern: "", mode: "read" })} addLabel="Add grant" empty="No grants: this role cannot read or write the brain." />
            </div>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3">
        <button type="button" className={buttonClass("primary", true)} disabled={busy} onClick={() => void save()}>
          <Save size={13} aria-hidden /> Save {role}
        </button>
        <div className="min-w-0 flex-1">
          <ActionStatus error={error} message={message} errors={errors} />
        </div>
      </div>
    </Card>
  );
}
