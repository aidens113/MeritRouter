"use client";

import { useMemo, useState, type ReactNode } from "react";
import { Lock, Plus, RotateCcw, Save, Trash2, X } from "lucide-react";
import type { Field, Section } from "@/lib/settings-schema";
import { ActionStatus, useAction } from "./actions";
import { Badge, buttonClass, Card, CardHeader, cx } from "../ui";

type Value = string | number | boolean | string[] | null | undefined;
type Draft = string | boolean | string[];

const keyOf = (f: Field) => f.path.join(".");

function toDraft(f: Field, v: Value): Draft {
  if (f.kind === "bool") return Boolean(v);
  if (f.kind === "list") return Array.isArray(v) ? v.map(String) : [];
  return v === undefined || v === null ? "" : String(v);
}

function parse(f: Field, d: Draft): { value?: unknown; error?: string } {
  if (f.kind === "bool") return { value: Boolean(d) };
  if (f.kind === "list") return { value: (d as string[]).map((s) => s.trim()).filter(Boolean) };
  const s = String(d).trim();
  if (f.kind === "optText") return { value: s ? s : null };
  if (f.kind === "text" || f.kind === "enum") return s ? { value: s } : { error: "Required" };
  if (f.kind === "url") {
    try {
      new URL(s);
      return { value: s };
    } catch {
      return { error: "Enter a full URL, e.g. http://localhost:3001/v1" };
    }
  }
  if ((f.kind === "optInt" || f.kind === "optNumber") && !s) return { value: null };
  if (!s) return { error: "Required" };
  const n = Number(s);
  if (!Number.isFinite(n)) return { error: "Enter a number" };
  if ((f.kind === "int" || f.kind === "optInt") && !Number.isInteger(n)) return { error: "Enter a whole number" };
  if (f.min !== undefined && n < f.min) return { error: `At least ${f.min}` };
  if (f.max !== undefined && n > f.max) return { error: `At most ${f.max}` };
  return { value: n };
}

function same(a: Draft, b: Draft): boolean {
  return Array.isArray(a) && Array.isArray(b) ? a.join("\u0000") === b.join("\u0000") : a === b;
}

/** Map server validation messages ("tiers.T1.max_score: ...") onto fields. */
function mapErrors(fields: Field[], errors: string[]): { byField: Record<string, string>; rest: string[] } {
  const byField: Record<string, string> = {};
  const rest: string[] = [];
  const lines = errors.flatMap((e) => e.split("\n").map((l) => l.trim())).filter((l) => l && !/^invalid config /.test(l));
  for (const raw of lines) {
    const l = raw.replace(/^profile ([\w-]+): ([\w.]+)/, "profiles.$1.$2:");
    const m = /^([\w.-]+):\s*(.*)$/.exec(l);
    const path = m?.[1];
    const field = path ? fields.find((f) => path === keyOf(f) || path.startsWith(`${keyOf(f)}.`)) ?? fields.find((f) => keyOf(f).startsWith(`${path}.`)) : undefined;
    if (field && m) byField[keyOf(field)] = m[2] || raw;
    else rest.push(raw);
  }
  return { byField, rest };
}

export function SectionForm({ section, values, badge }: { section: Section; values: Record<string, Value>; badge?: string }) {
  const initial = useMemo(() => Object.fromEntries(section.fields.map((f) => [keyOf(f), toDraft(f, values[keyOf(f)])])), [section, values]);
  const [draft, setDraft] = useState<Record<string, Draft>>(initial);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [sectionErrors, setSectionErrors] = useState<string[]>([]);
  const { run, busy, error, message, setError } = useAction();
  const dirty = section.fields.filter((f) => !f.readOnly && !same(draft[keyOf(f)]!, initial[keyOf(f)]!));

  const save = async () => {
    const errs: Record<string, string> = {};
    const patch: Array<{ path: string[]; value: unknown }> = [];
    for (const f of dirty) {
      const p = parse(f, draft[keyOf(f)]!);
      if (p.error) errs[keyOf(f)] = p.error;
      else patch.push({ path: f.path, value: p.value });
    }
    setFieldErrors(errs);
    setSectionErrors([]);
    if (Object.keys(errs).length) {
      setError("Fix the highlighted fields.");
      return;
    }
    const r = await run("/api/config", "POST", { patch }, { success: "Saved. Running workers pick the change up automatically." });
    if (!r.ok) {
      const { byField, rest } = mapErrors(section.fields, r.errors?.length ? r.errors : [r.error ?? ""]);
      setFieldErrors(byField);
      setSectionErrors(rest);
      if (Object.keys(byField).length && !rest.length) setError("The config was not saved: fix the highlighted fields.");
    }
  };

  return (
    <Card id={section.id}>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            {section.title}
            {badge ? <Badge>{badge}</Badge> : null}
            {dirty.length ? <Badge tone="warn">{dirty.length} unsaved</Badge> : null}
          </span>
        }
        description={section.description}
      />
      <div className="grid gap-x-6 gap-y-5 p-4 md:grid-cols-2">
        {section.fields.map((f) => (
          <FieldInput key={keyOf(f)} field={f} value={draft[keyOf(f)]!} error={fieldErrors[keyOf(f)]} onChange={(v) => setDraft((d) => ({ ...d, [keyOf(f)]: v }))} />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3">
        <button type="button" className={buttonClass("primary", true)} disabled={busy || dirty.length === 0} onClick={save}>
          <Save size={13} aria-hidden /> Save changes
        </button>
        {dirty.length ? (
          <button
            type="button"
            className={buttonClass("ghost", true)}
            onClick={() => {
              setDraft(initial);
              setFieldErrors({});
              setSectionErrors([]);
              setError(null);
            }}
          >
            <RotateCcw size={13} aria-hidden /> Discard changes
          </button>
        ) : null}
        <div className="min-w-0 flex-1">
          <ActionStatus error={error} message={message} errors={sectionErrors} />
        </div>
      </div>
    </Card>
  );
}

function FieldInput({ field: f, value, error, onChange }: { field: Field; value: Draft; error: string | undefined; onChange: (v: Draft) => void }) {
  const id = `f-${keyOf(f)}`;
  const label = (
    <span className="flex items-center gap-1.5 text-sm font-medium text-ink">
      {f.label}
      {f.readOnly ? <Lock size={12} className="text-ink-3" aria-label="read only" /> : null}
    </span>
  );
  const help = (
    <span id={`${id}-help`} className="mt-1 block text-xs leading-relaxed text-ink-3">
      {f.help}
    </span>
  );
  const err = error ? (
    <span role="alert" className="mt-1 block text-xs text-bad-ink">
      {error}
    </span>
  ) : null;

  if (f.kind === "bool") {
    return (
      <div>
        <label htmlFor={id} className="flex cursor-pointer items-start gap-3">
          <input id={id} type="checkbox" role="switch" checked={Boolean(value)} disabled={f.readOnly} onChange={(e) => onChange(e.target.checked)} className="peer sr-only" aria-describedby={`${id}-help`} />
          <span className={cx("relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-accent", value ? "bg-accent" : "bg-surface-3")} aria-hidden>
            <span className={cx("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all", value ? "left-4.5" : "left-0.5")} />
          </span>
          <span>
            {label}
            {help}
          </span>
        </label>
        {err}
      </div>
    );
  }
  if (f.kind === "list") return <ListInput id={id} label={label} help={help} err={err} value={value as string[]} onChange={onChange} placeholder={f.placeholder} />;
  return (
    <div>
      <label htmlFor={id}>{label}</label>
      <div className="mt-1 flex items-center gap-2">
        {f.kind === "enum" ? (
          <select id={id} value={String(value)} disabled={f.readOnly} onChange={(e) => onChange(e.target.value)} className="field" aria-invalid={Boolean(error)} aria-describedby={`${id}-help`}>
            {!f.options?.includes(String(value)) && value !== "" ? <option value={String(value)}>{String(value)}</option> : null}
            {f.options?.map((o) => (
              <option key={o} value={o}>
                {o.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        ) : f.multiline ? (
          <textarea id={id} rows={6} value={String(value)} readOnly={f.readOnly} disabled={f.readOnly} onChange={e => onChange(e.target.value)} placeholder={f.placeholder} className="field resize-y font-mono text-[13px]" aria-invalid={Boolean(error)} aria-describedby={`${id}-help`} />
        ) : (
          <input
            id={id}
            value={String(value)}
            readOnly={f.readOnly}
            disabled={f.readOnly}
            inputMode={["int", "number", "optInt", "optNumber"].includes(f.kind) ? "decimal" : undefined}
            onChange={(e) => onChange(e.target.value)}
            placeholder={f.placeholder}
            className={cx("field", f.kind === "url" || f.kind === "text" || f.kind === "optText" ? "font-mono text-[13px]" : "tabular")}
            aria-invalid={Boolean(error)}
            aria-describedby={`${id}-help`}
          />
        )}
        {f.unit ? <span className="shrink-0 text-xs text-ink-3">{f.unit}</span> : null}
      </div>
      {err}
      {help}
      {f.optionHelp?.[String(value)] ? <span className="mt-1 block rounded-md bg-surface-2 px-2 py-1 text-xs leading-relaxed text-ink-2">{f.optionHelp[String(value)]}</span> : null}
    </div>
  );
}

function ListInput({ id, label, help, err, value, onChange, placeholder }: { id: string; label: ReactNode; help: ReactNode; err: ReactNode; value: string[]; onChange: (v: string[]) => void; placeholder: string | undefined }) {
  const [text, setText] = useState("");
  const add = () => {
    const items = text
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s && !value.includes(s));
    if (items.length) onChange([...value, ...items]);
    setText("");
  };
  return (
    <div className="md:col-span-2">
      <label htmlFor={id}>{label}</label>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 rounded-lg border border-line-strong bg-surface p-1.5">
        {value.map((v) => (
          <span key={v} className="inline-flex items-center gap-1 rounded-md bg-surface-2 px-2 py-0.5 font-mono text-xs text-ink">
            {v}
            <button type="button" onClick={() => onChange(value.filter((x) => x !== v))} aria-label={`Remove ${v}`} className="text-ink-3 hover:text-bad-ink">
              <X size={12} aria-hidden />
            </button>
          </span>
        ))}
        <input
          id={id}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add();
            } else if (e.key === "Backspace" && !text && value.length) onChange(value.slice(0, -1));
          }}
          onBlur={add}
          placeholder={value.length ? "add another…" : (placeholder ?? "type and press Enter")}
          className="min-w-[8rem] flex-1 bg-transparent px-1 py-0.5 text-sm text-ink outline-none"
        />
      </div>
      {err}
      {help}
    </div>
  );
}

export function RepositoriesForm({ repos }: { repos: Array<{ alias: string; path: string; writable: boolean; resolved: string }> }) {
  const [rows, setRows] = useState(repos.map((r) => ({ ...r, isNew: false })));
  const [removed, setRemoved] = useState<string[]>([]);
  const { run, busy, error, errors, message, setError } = useAction();
  const changed = removed.length > 0 || rows.some((r) => r.isNew || repos.find((x) => x.alias === r.alias)?.path !== r.path || repos.find((x) => x.alias === r.alias)?.writable !== r.writable);

  const save = async () => {
    const patch: Array<{ path: string[]; value: unknown }> = removed.map((a) => ({ path: ["repositories", a], value: null }));
    for (const r of rows) {
      if (!/^[A-Za-z0-9._-]+$/.test(r.alias)) {
        setError(`Alias "${r.alias}" is not valid: use letters, digits, dots, dashes, or underscores.`);
        return;
      }
      if (!r.path.trim()) {
        setError(`Repository ${r.alias} needs a path.`);
        return;
      }
      patch.push({ path: ["repositories", r.alias], value: { path: r.path, writable: r.writable } });
    }
    await run("/api/config", "POST", { patch }, { success: "Repositories saved" });
  };

  return (
    <Card id="repositories">
      <CardHeader title="Repositories" description="Repositories workers may read (and, when writable, edit through isolated worktrees). Tasks refer to them by alias, e.g. core:src/app.ts." />
      <div className="space-y-2 p-4">
        {rows.length === 0 ? <p className="text-sm text-ink-3">No repositories yet. Add one so inspect, analyze, review, and implement tasks can read code.</p> : null}
        {rows.map((r, i) => (
          <div key={i} className="grid items-end gap-2 md:grid-cols-[10rem_1fr_auto_auto]">
            <label className="text-xs text-ink-3">
              Alias
              <input value={r.alias} readOnly={!r.isNew} onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, alias: e.target.value } : x)))} className="field mt-0.5 font-mono" placeholder="core" />
            </label>
            <label className="text-xs text-ink-3">
              Path (relative to the config file, or absolute)
              <input value={r.path} onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)))} className="field mt-0.5 font-mono" placeholder="../my-repo" />
            </label>
            <label className="mb-2 flex items-center gap-1.5 text-sm text-ink-2">
              <input type="checkbox" checked={r.writable} onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, writable: e.target.checked } : x)))} /> Writable
            </label>
            <button
              type="button"
              className={buttonClass("ghost", true)}
              aria-label={`Remove ${r.alias || "repository"}`}
              onClick={() => {
                if (!r.isNew) setRemoved((x) => [...x, r.alias]);
                setRows((rs) => rs.filter((_, j) => j !== i));
              }}
            >
              <Trash2 size={13} aria-hidden />
            </button>
          </div>
        ))}
        <button type="button" className={buttonClass("secondary", true)} onClick={() => setRows((rs) => [...rs, { alias: "", path: "", writable: false, resolved: "", isNew: true }])}>
          <Plus size={13} aria-hidden /> Add repository
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3">
        <button type="button" className={buttonClass("primary", true)} disabled={busy || !changed} onClick={save}>
          <Save size={13} aria-hidden /> Save repositories
        </button>
        <ActionStatus error={error} message={message} errors={errors} />
      </div>
    </Card>
  );
}
