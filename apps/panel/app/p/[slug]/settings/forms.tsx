"use client";

import { useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Archive, CheckCircle2, CircleAlert, Info, Lock, Plus, Trash2 } from "lucide-react";
import { ActionStatus, callApi, useAction } from "@/components/client/actions";
import { blankRow, RowsEditor, type Column } from "@/components/client/settings-rows";
import { Badge, buttonClass, Card, CardHeader, cx, Mono } from "@/components/ui";
import type { OverrideItem } from "./fields";
import { errorsForRows, OverrideRow, SaveBar, useOverrideRows } from "./overrides";

const settingsUrl = (slug: string) => `/api/projects/${encodeURIComponent(slug)}/settings`;
type FieldErrors = Record<string, string[]>;

function FieldError({ id, msgs }: { id: string; msgs: string[] | undefined }) {
  if (!msgs?.length) return null;
  return (
    <span id={id} role="alert" className="mt-1 block text-xs text-bad-ink">
      {msgs.join("; ")}
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// General: name, read-only slug, archive.

export function GeneralCard({ slug, name, legacy, configPath, keyPath, activity, archived = false }: { slug: string; name: string; legacy: boolean; configPath: string; keyPath: string; activity: { runningTasks: number; queuedTasks: number }; archived?: boolean }) {
  const router = useRouter();
  const [draft, setDraft] = useState(name);
  const [nameError, setNameError] = useState<string[] | undefined>();
  const { run, busy, error, message } = useAction();
  const [arming, setArming] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const dirty = draft.trim() !== name;
  const blocked = activity.runningTasks + activity.queuedTasks > 0;

  const saveName = async () => {
    const v = draft.trim();
    if (!v || v.length > 80) return setNameError(["1 to 80 characters"]);
    setNameError(undefined);
    const r = await run(settingsUrl(slug), "PATCH", { patch: [{ path: ["name"], value: v === slug ? null : v }] }, { success: "Name saved." });
    if (!r.ok) setNameError((r.fieldErrors as FieldErrors | undefined)?.name);
  };

  const archive = async () => {
    setArchiving(true);
    setArchiveError(null);
    const r = await callApi(`/api/projects/${encodeURIComponent(slug)}`, "PATCH", { archived: true });
    setArchiving(false);
    setArming(false);
    if (!r.ok) return setArchiveError(r.error ?? "Not archived");
    router.push("/");
  };

  return (
    <Card id="general">
      <CardHeader title="General" description={<>Stored in <Mono>{configPath}</Mono> {keyPath ? <>under <Mono>{keyPath}</Mono></> : "at the top level (a single-project config)"}.</>} />
      <div className="grid gap-5 p-4 md:grid-cols-2">
        <div>
          <label htmlFor="project-name" className="text-sm font-medium text-ink">
            Name
          </label>
          <input
            id="project-name"
            value={draft}
            disabled={legacy}
            onChange={(e) => setDraft(e.target.value)}
            className="field mt-1"
            aria-invalid={Boolean(nameError)}
            aria-describedby={nameError ? "project-name-error project-name-help" : "project-name-help"}
          />
          <FieldError id="project-name-error" msgs={nameError} />
          <span id="project-name-help" className="mt-1 block text-xs text-ink-3">
            {legacy ? "A single-project config names its project by its slug. Add a second project to give this one a name." : "Shown in the switcher and on the projects grid."}
          </span>
        </div>
        <div>
          <span className="flex items-center gap-1.5 text-sm font-medium text-ink">
            Slug <Lock size={12} className="text-ink-3" aria-label="read only" />
          </span>
          <div className="mt-1 rounded-lg border border-line bg-surface-2 px-3 py-1.5 font-mono text-sm text-ink-2">{slug}</div>
          <span className="mt-1 block text-xs text-ink-3">Fixed: tasks, sessions, the brain folder (projects/{slug}/), and URLs use it.</span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3">
        <button type="button" className={buttonClass("primary", true)} disabled={busy || !dirty || legacy} onClick={() => void saveName()}>
          Save name
        </button>
        <div className="min-w-0 flex-1">
          <ActionStatus error={nameError ? null : error} message={message} />
        </div>
      </div>
      <div className="space-y-2 border-t border-line px-4 py-4">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
          <Archive size={14} aria-hidden /> Archive
        </h3>
        <p className="max-w-2xl text-xs text-ink-3">
          Archiving takes the project off the grid, the switcher, and project pickers. Its settings, tasks, sessions, and brain are kept. Archived projects are listed at the bottom of the projects grid, where you can unarchive them. Archiving is refused while the project has running or queued tasks.
        </p>
        {archived ? <p className="text-xs font-medium text-warn-ink">This project is archived. Unarchive it at the top of this page.</p> : null}
        {blocked && !archived ? (
          <p className="text-xs text-warn-ink">
            Now: {activity.runningTasks} running and {activity.queuedTasks} queued task{activity.runningTasks + activity.queuedTasks === 1 ? "" : "s"}, so archiving will be refused until they finish or are cancelled.
          </p>
        ) : null}
        {archived ? null : arming ? (
          <div role="alertdialog" aria-labelledby="archive-confirm" className="flex flex-wrap items-center gap-2 rounded-lg border border-bad/40 bg-bad-soft px-3 py-2">
            <span id="archive-confirm" className="text-sm text-bad-ink">
              Archive <strong>{name}</strong>?
            </span>
            <button type="button" className={buttonClass("danger", true)} disabled={archiving} onClick={() => void archive()} autoFocus>
              Yes, archive it
            </button>
            <button type="button" className={buttonClass("ghost", true)} onClick={() => setArming(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <button type="button" className={buttonClass("danger", true)} onClick={() => setArming(true)}>
            <Archive size={13} aria-hidden /> Archive project…
          </button>
        )}
        <ActionStatus error={archiveError} />
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Repositories: add, remove, writable, and a server-side folder check.

type RepoCheck = { resolved: string; isGit: boolean; hint: string | null; problem: string | null };
type RepoRow = { alias: string; path: string; writable: boolean; isNew: boolean; check: RepoCheck | null };

export function RepositoriesCard({ slug, rows: initialRows }: { slug: string; rows: Array<{ alias: string; path: string; writable: boolean } & RepoCheck> }) {
  const initial = useMemo(() => initialRows.map((r) => ({ alias: r.alias, path: r.path, writable: r.writable, isNew: false, check: { resolved: r.resolved, isGit: r.isGit, hint: r.hint, problem: r.problem } })), [initialRows]);
  const [rows, setRows] = useState<RepoRow[]>(initial);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const { run, busy, error, message, setError } = useAction();
  const strip = (rs: RepoRow[]) => JSON.stringify(rs.map((r) => [r.alias, r.path, r.writable]));
  const dirty = strip(rows) !== strip(initial);
  const set = (i: number, p: Partial<RepoRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));

  const check = async (i: number, p: string) => {
    if (!p.trim()) return set(i, { check: null });
    const r = await callApi(`/api/projects/${encodeURIComponent(slug)}/repositories?path=${encodeURIComponent(p)}`, "GET");
    if (r.ok) setRows((rs) => rs.map((x, j) => (j === i && x.path === p ? { ...x, check: r.check as RepoRow["check"] } : x)));
  };

  const save = async () => {
    setFieldErrors({});
    const r = await run(`/api/projects/${encodeURIComponent(slug)}/repositories`, "PUT", { repositories: rows.map((x) => ({ alias: x.alias, path: x.path, writable: x.writable })) }, { success: "Repositories saved. Running workers pick the change up automatically." });
    if (!r.ok) {
      const fe = (r.fieldErrors as FieldErrors | undefined) ?? {};
      setFieldErrors(fe);
      if (Object.keys(fe).some((k) => k !== "form")) setError(fe.form?.join("; ") || "Not saved: check the highlighted rows.");
    } else {
      // The save prepared the folders: show what the server finds there now.
      const saved = (r.repositories as Array<{ alias: string } & RepoCheck> | undefined) ?? [];
      setRows((rs) =>
        rs.map((x) => {
          const now = saved.find((y) => y.alias === x.alias.trim());
          return { ...x, isNew: false, check: now ? { resolved: now.resolved, isGit: now.isGit, hint: now.hint, problem: now.problem } : x.check };
        }),
      );
    }
  };

  return (
    <Card id="repositories">
      <CardHeader title="Repositories" description="The repositories this project's workers read, and edit through isolated worktrees when writable. Tasks name them by alias, e.g. app:src/index.ts. Any folder works: one that does not exist yet is created, and one without git is set up with git when you save." />
      <div className="space-y-3 p-4">
        {rows.length === 0 ? <p className="text-sm text-ink-3">No repositories. Add one so inspect, analyze, review, and implement tasks can read code.</p> : null}
        {rows.map((r, i) => {
          const aErr = fieldErrors[`repositories.${i}.alias`];
          const pErr = fieldErrors[`repositories.${i}.path`];
          return (
            <div key={i} className="rounded-lg border border-line p-3">
              <div className="grid items-start gap-3 md:grid-cols-[10rem_1fr_auto_auto]">
                <label className="block text-xs text-ink-3">
                  Alias
                  <input
                    value={r.alias}
                    readOnly={!r.isNew}
                    onChange={(e) => set(i, { alias: e.target.value })}
                    className={cx("field mt-0.5 font-mono", !r.isNew && "bg-surface-2")}
                    placeholder="app"
                    aria-invalid={Boolean(aErr)}
                    aria-describedby={aErr ? `repo-${i}-alias-error` : undefined}
                  />
                  <FieldError id={`repo-${i}-alias-error`} msgs={aErr} />
                </label>
                <label className="block min-w-0 text-xs text-ink-3">
                  Folder (relative to the config file, or absolute)
                  <input
                    value={r.path}
                    onChange={(e) => set(i, { path: e.target.value, check: null })}
                    onBlur={(e) => void check(i, e.target.value)}
                    className="field mt-0.5 font-mono"
                    placeholder="../my-repo"
                    aria-invalid={Boolean(pErr)}
                    aria-describedby={`repo-${i}-check${pErr ? ` repo-${i}-path-error` : ""}`}
                  />
                  <FieldError id={`repo-${i}-path-error`} msgs={pErr} />
                  <span id={`repo-${i}-check`} className="mt-1 flex min-w-0 items-start gap-1 text-[11px]">
                    {r.check ? (
                      r.check.problem ? (
                        <>
                          <CircleAlert size={12} className="mt-px shrink-0 text-warn-ink" aria-hidden />
                          <span className="break-all text-warn-ink">{r.check.problem}</span>
                        </>
                      ) : r.check.hint ? (
                        <>
                          <Info size={12} className="mt-px shrink-0 text-ink-3" aria-hidden />
                          <span className="min-w-0 text-ink-3">
                            <span className="break-all">{r.check.resolved}</span>: {r.check.hint}
                          </span>
                        </>
                      ) : (
                        <>
                          <CheckCircle2 size={12} className="mt-px shrink-0 text-good-ink" aria-hidden />
                          <span className="break-all text-ink-3">git repository at {r.check.resolved}</span>
                        </>
                      )
                    ) : r.path.trim() && !pErr ? (
                      <span className="text-ink-3">Checked when you leave the field.</span>
                    ) : null}
                  </span>
                </label>
                <label className="mt-5 flex items-center gap-1.5 text-sm text-ink-2">
                  <input type="checkbox" checked={r.writable} onChange={(e) => set(i, { writable: e.target.checked })} /> Writable
                </label>
                <button type="button" className={cx(buttonClass("ghost", true), "mt-4")} aria-label={`Remove ${r.alias || `row ${i + 1}`}`} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
                  <Trash2 size={13} aria-hidden /> Remove
                </button>
              </div>
            </div>
          );
        })}
        <button type="button" className={buttonClass("secondary", true)} onClick={() => setRows((rs) => [...rs, { alias: "", path: "", writable: true, isNew: true, check: null }])}>
          <Plus size={13} aria-hidden /> Add repository
        </button>
      </div>
      <SaveBar
        busy={busy}
        dirty={dirty ? 1 : 0}
        label="Save repositories"
        onSave={() => void save()}
        onDiscard={() => {
          setRows(initial);
          setFieldErrors({});
          setError(null);
        }}
        error={error}
        message={message}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Brain: this project's mounts, the access approver, and auto-approve rules.

const MOUNT_COLUMNS: Column[] = [
  { key: "prefix", label: "Brain prefix", kind: "text", placeholder: "projects/<slug>/working" },
  { key: "path", label: "Folder", kind: "text", wide: true, placeholder: "../my-repo/docs/working", help: "Relative to the config file." },
  { key: "commit", label: "SwitchYard commits there", kind: "bool", help: "Off: you commit changes in that repository yourself." },
];

type Mount = { prefix: string; path: string; commit: boolean };

export function BrainCard({ slug, globalMounts, mounts, items, legacy }: { slug: string; globalMounts: Mount[]; mounts: Mount[]; items: OverrideItem[]; legacy: boolean }) {
  const initialMounts = useMemo(() => mounts.map((m) => blankRow(MOUNT_COLUMNS, m)), [mounts]);
  const [rows, setRows] = useState(initialMounts);
  const o = useOverrideRows(items);
  const { run, busy, error, message, setError } = useAction();
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [mountErrors, setMountErrors] = useState<Record<string, string>>({});
  const [rest, setRest] = useState<string[]>([]);
  const mountsDirty = JSON.stringify(rows) !== JSON.stringify(initialMounts);
  const dirty = o.dirtyIds.length + (mountsDirty ? 1 : 0);

  const save = async () => {
    const { patch, errors } = o.build();
    setRowErrors(errors);
    setMountErrors({});
    setRest([]);
    if (mountsDirty) {
      const value: Mount[] = [];
      for (const [i, r] of rows.entries()) {
        const prefix = String(r.prefix ?? "").trim();
        const p = String(r.path ?? "").trim();
        if (!prefix || !p) return setError(`Mount ${i + 1}: enter both a brain prefix and a folder.`);
        value.push({ prefix, path: p, commit: Boolean(r.commit) });
      }
      patch.unshift({ path: ["brain", "mounts"], value: value.length ? value.map((m) => (m.commit ? m : { prefix: m.prefix, path: m.path })) : null });
    }
    if (Object.keys(errors).length) return setError("Fix the highlighted settings.");
    const r = await run(settingsUrl(slug), "PATCH", { patch }, { success: "Saved. Running workers pick the change up automatically." });
    if (!r.ok) {
      // brain.mounts.<i>.<field> errors go under that mount's field (e.g. a folder that does not exist).
      const fe = { ...((r.fieldErrors as FieldErrors | undefined) ?? {}) };
      const byMount: Record<string, string> = {};
      for (const k of Object.keys(fe)) {
        const m = /^brain\.mounts\.(\d+)\.(\w+)$/.exec(k);
        if (!m) continue;
        byMount[`${m[1]}.${m[2]}`] = fe[k]!.join("; ");
        delete fe[k];
      }
      setMountErrors(byMount);
      const m = errorsForRows(items, fe);
      setRowErrors(m.byRow);
      setRest(m.rest);
      if (Object.keys(byMount).length) setError("Not saved: check the highlighted mounts.");
    }
  };

  return (
    <Card id="brain">
      <CardHeader title="Brain" description="Where this project's agents keep knowledge (the brain repository, under projects/<slug>/), extra folders mounted into it, and who decides requests for more access." />
      <div className="space-y-3 border-b border-line p-4">
        <h3 className="text-sm font-semibold text-ink">{legacy ? "Brain mounts" : "This project's mounts"}</h3>
        <p className="text-xs text-ink-3">Map a brain path prefix to an existing folder, for example a repository&apos;s docs/working, so agents read and write it as part of the brain.{legacy ? "" : " These are added to the install-wide mounts below."}</p>
        <RowsEditor columns={MOUNT_COLUMNS} rows={rows} onChange={setRows} newRow={blankRow(MOUNT_COLUMNS, { prefix: `projects/${slug}/`, path: "", commit: false })} addLabel="Add mount" empty="No mounts of its own." errors={mountErrors} />
        {!legacy ? (
          <div className="text-xs text-ink-3">
            Install-wide mounts (every project, edited in Settings):{" "}
            {globalMounts.length ? (
              globalMounts.map((m, i) => (
                <span key={m.prefix}>
                  {i ? ", " : ""}
                  <Mono>{`${m.prefix} → ${m.path}`}</Mono>
                </span>
              ))
            ) : (
              <span className="italic">none</span>
            )}
          </div>
        ) : null}
      </div>
      <div className="divide-y divide-line">
        {items.map((i) => (
          <OverrideRow key={i.id} item={i} state={o.rows[i.id]!} dirty={o.dirtyIds.includes(i.id)} error={rowErrors[i.id]} disabled={busy || legacy} onChange={(s) => o.set(i.id, s)} />
        ))}
      </div>
      <SaveBar
        busy={busy}
        dirty={dirty}
        onSave={() => void save()}
        onDiscard={() => {
          setRows(initialMounts);
          o.reset();
          setRowErrors({});
          setMountErrors({});
          setRest([]);
          setError(null);
        }}
        error={error}
        message={message}
        errors={rest}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Scheduling and budgets: the project's share of the one worker and of the global budgets.

type Budgets = { per_day_usd: number | null; per_week_usd: number | null; per_month_usd: number | null };
export interface LimitsProps {
  priority: number | null;
  max_concurrent_tasks: number | null;
  paid_budgets: Budgets;
  request_share: number | null;
  global: { maxConcurrentTasks: number; paidEnabled: boolean; paidBudgets: Budgets; requestsPerHour: number | null; requestsPerDay: number | null };
}

const str = (n: number | null) => (n === null ? "" : String(n));
const usd = (n: number | null) => (n === null ? "no limit" : `$${n}`);

export function SchedulingCard({ slug, limits, legacy }: { slug: string; limits: LimitsProps; legacy: boolean }) {
  const initial = useMemo(
    () => ({
      priority: str(limits.priority),
      max: str(limits.max_concurrent_tasks),
      day: str(limits.paid_budgets.per_day_usd),
      week: str(limits.paid_budgets.per_week_usd),
      month: str(limits.paid_budgets.per_month_usd),
      share: limits.request_share === null ? "" : String(Math.round(limits.request_share * 1000) / 10),
    }),
    [limits],
  );
  const [d, setD] = useState(initial);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const { run, busy, error, message, setError } = useAction();
  const changed = (Object.keys(initial) as Array<keyof typeof initial>).filter((k) => d[k].trim() !== initial[k]);
  const g = limits.global;

  const parse = (k: keyof typeof initial, opts: { int?: boolean; min?: number; max?: number; gt?: number }): { value: number | null } | { error: string } => {
    const s = d[k].trim();
    if (!s) return { value: null };
    const n = Number(s);
    if (!Number.isFinite(n)) return { error: "Enter a number, or leave empty" };
    if (opts.int && !Number.isInteger(n)) return { error: "Enter a whole number" };
    if (opts.gt !== undefined && n <= opts.gt) return { error: `More than ${opts.gt}` };
    if (opts.min !== undefined && n < opts.min) return { error: `At least ${opts.min}` };
    if (opts.max !== undefined && n > opts.max) return { error: `At most ${opts.max}` };
    return { value: n };
  };

  const save = async () => {
    const e: Record<string, string> = {};
    const patch: Array<{ path: string[]; value: unknown }> = [];
    const field = (k: keyof typeof initial, path: string[], o: Parameters<typeof parse>[1], map: (n: number) => number = (n) => n) => {
      const r = parse(k, o);
      if ("error" in r) e[k] = r.error;
      else if (changed.includes(k)) patch.push({ path, value: r.value === null ? null : map(r.value) });
      return r;
    };
    field("priority", ["priority"], { gt: 0, max: 100 });
    field("max", ["max_concurrent_tasks"], { int: true, min: 1 });
    field("share", ["request_share"], { gt: 0, max: 100 }, (n) => Math.round(n * 10) / 1000);
    const b = { per_day_usd: parse("day", { min: 0 }), per_week_usd: parse("week", { min: 0 }), per_month_usd: parse("month", { min: 0 }) };
    for (const [k, key] of [["per_day_usd", "day"], ["per_week_usd", "week"], ["per_month_usd", "month"]] as const) {
      const x = b[k];
      if ("error" in x) e[key] = x.error;
    }
    if (changed.some((k) => k === "day" || k === "week" || k === "month")) {
      const value = Object.fromEntries(Object.entries(b).flatMap(([k, r]) => ("value" in r && r.value !== null ? [[k, r.value]] : [])));
      patch.push({ path: ["paid_budgets"], value: Object.keys(value).length ? value : null });
    }
    setErrs(e);
    if (Object.keys(e).length) return setError("Fix the highlighted fields.");
    const r = await run(settingsUrl(slug), "PATCH", { patch }, { success: "Saved. The scheduler and admission use the new values at once." });
    if (!r.ok) {
      const fe = (r.fieldErrors as FieldErrors | undefined) ?? {};
      const byKey: Record<string, string> = {};
      const keyOf: Record<string, string> = { priority: "priority", max_concurrent_tasks: "max", request_share: "share", "paid_budgets.per_day_usd": "day", "paid_budgets.per_week_usd": "week", "paid_budgets.per_month_usd": "month" };
      for (const [k, v] of Object.entries(fe)) if (keyOf[k]) byKey[keyOf[k]!] = v.join("; ");
      setErrs(byKey);
    }
  };

  const shareNow = parse("share", { gt: 0, max: 100 });
  const share = "value" in shareNow && shareNow.value !== null ? shareNow.value / 100 : null;
  const prio = (() => {
    const p = parse("priority", { gt: 0, max: 100 });
    return "value" in p && p.value !== null ? p.value : 1;
  })();

  const input = (k: keyof typeof initial, label: string, unit: string, placeholder: string, help: ReactNode) => (
    <div>
      <label htmlFor={`lim-${k}`} className="flex items-center gap-2 text-sm font-medium text-ink">
        {label}
        {d[k].trim() !== initial[k] ? <Badge tone="warn">unsaved</Badge> : null}
      </label>
      <div className="mt-1 flex items-center gap-2">
        <input
          id={`lim-${k}`}
          value={d[k]}
          disabled={legacy}
          onChange={(e) => setD((x) => ({ ...x, [k]: e.target.value }))}
          inputMode="decimal"
          placeholder={placeholder}
          className="field tabular max-w-[10rem]"
          aria-invalid={Boolean(errs[k])}
          aria-describedby={`lim-${k}-help${errs[k] ? ` lim-${k}-error` : ""}`}
        />
        <span className="shrink-0 text-xs text-ink-3">{unit}</span>
      </div>
      {errs[k] ? (
        <span id={`lim-${k}-error`} role="alert" className="mt-1 block text-xs text-bad-ink">
          {errs[k]}
        </span>
      ) : null}
      <span id={`lim-${k}-help`} className="mt-1 block text-xs leading-relaxed text-ink-3">
        {help}
      </span>
    </div>
  );

  return (
    <Card id="scheduling">
      <CardHeader title="Scheduling and budgets" description="This project's share of the one worker and of the install-wide budgets. Empty means no per-project limit; the install-wide limits always apply on top." />
      {legacy ? <p className="border-b border-line px-4 py-3 text-sm text-ink-2">A single-project config has no per-project limits: the install-wide ones are this project&apos;s. Add a second project to set them.</p> : null}
      <div className="grid gap-x-6 gap-y-5 p-4 md:grid-cols-2">
        {input("priority", "Priority", "weight", "1", <>While several projects have tasks ready, each is served in proportion to its priority. At {prio}, this project is served {prio === 1 ? "as often as" : `${prio}× as often as`} a project of priority 1. Empty: 1.</>)}
        {input("max", "Tasks at once", "tasks", "no cap", <>Most worker tasks of this project running at the same time, within the install&apos;s {g.maxConcurrentTasks}. Others wait queued. Supervisors are bounded by jobs at once instead.</>)}
        {input(
          "share",
          "Share of the request allocation",
          "%",
          "no share",
          g.requestsPerHour || g.requestsPerDay ? (
            <>
              Part of the install-wide allocation ({[g.requestsPerHour ? `${g.requestsPerHour} requests an hour` : "", g.requestsPerDay ? `${g.requestsPerDay} a day` : ""].filter(Boolean).join(", ")}) this project may use.
              {share !== null ? <> At {Math.round(share * 1000) / 10}%: {[g.requestsPerHour ? `${Math.max(1, Math.floor(g.requestsPerHour * share))} an hour` : "", g.requestsPerDay ? `${Math.max(1, Math.floor(g.requestsPerDay * share))} a day` : ""].filter(Boolean).join(", ")}.</> : null}
            </>
          ) : (
            <>Part of the install-wide request allocation this project may use. No allocation is set (Settings, Allocation), so a share has no effect yet.</>
          ),
        )}
        <div className="md:col-span-2">
          <h3 className="text-sm font-semibold text-ink">Paid spend</h3>
          <p className="mt-0.5 text-xs text-ink-3">
            Most this project may spend on paid models, within the install-wide budgets ({usd(g.paidBudgets.per_day_usd)} a day, {usd(g.paidBudgets.per_week_usd)} a week, {usd(g.paidBudgets.per_month_usd)} a month). When it is used up, this project falls back to free models and the others keep paid routing.
            {g.paidEnabled ? "" : " Paid routing is off for the whole install, so nothing is spent either way."}
          </p>
        </div>
        {input("day", "Per day", "USD", "no limit", "Any 24 hours.")}
        {input("week", "Per week", "USD", "no limit", "Any 7 days.")}
        {input("month", "Per month", "USD", "no limit", "Any 30 days.")}
      </div>
      <SaveBar
        busy={busy}
        dirty={changed.length}
        onSave={() => void save()}
        onDiscard={() => {
          setD(initial);
          setErrs({});
          setError(null);
        }}
        error={error}
        message={message}
      />
    </Card>
  );
}
