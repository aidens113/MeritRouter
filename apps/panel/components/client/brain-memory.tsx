"use client";

import { useEffect, useRef, useState } from "react";
import type { MemoryRecord } from "meritrouter";
import { ActionStatus, useAction } from "./actions";
import { buttonClass } from "../ui";
import { Markdown } from "../markdown";

type Entry = { record: MemoryRecord; digest: string; path: string };
/** Explicit operator instructions; inferred global lessons keep their separate promotion gate. */
export function BrainMemory({ project, base }: { project: string; base: string }) {
  const [scope, setScope] = useState<"project" | "global">("project");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [after, setAfter] = useState<string | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [selected, setSelected] = useState<Entry | null>(null);
  const [latest, setLatest] = useState<Entry | null>(null);
  const [id, setId] = useState("");
  const [kind, setKind] = useState<MemoryRecord["kind"]>("user_preference");
  const [text, setText] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { run, busy, error, message } = useAction();
  const request = useRef<AbortController | null>(null);
  const dirty = text !== (selected?.record.body ?? "");
  const list = async (cursor: string | null = null) => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    const signal = controller.signal;
    setLoading(true); setLoadError(null);
    try {
      const response = await fetch(`/api/brain/memory?project=${encodeURIComponent(project)}&scope=${scope}${cursor ? `&after=${encodeURIComponent(cursor)}` : ""}`, { signal });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error ?? "Could not load memory");
      setEntries(result.records); setNext(result.next); setAfter(cursor);
    } catch (err) { if (!(err instanceof Error && err.name === "AbortError")) setLoadError((err as Error).message); }
    finally { if (!signal?.aborted) setLoading(false); }
  };
  useEffect(() => { void list(); return () => request.current?.abort(); }, [scope, project]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    const navigate = (event: MouseEvent) => {
      const link = (event.target as Element).closest?.("a[href]") as HTMLAnchorElement | null;
      if (link && link.href !== window.location.href && !window.confirm("Discard the unsaved memory draft?")) { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", navigate, true);
    return () => { window.removeEventListener("beforeunload", warn); document.removeEventListener("click", navigate, true); };
  }, [dirty]);
  const reset = () => { setSelected(null); setLatest(null); setId(""); setText(""); setKind("user_preference"); setConfirmed(false); };
  const canDiscard = () => !dirty || window.confirm("Discard the unsaved memory draft?");
  const choose = (entry: Entry) => {
    if (dirty && entry.path === selected?.path && entry.digest !== selected.digest) { setLatest(entry); return; }
    if (!canDiscard()) return; setSelected(entry); setLatest(null); setId(entry.record.id); setKind(entry.record.kind); setText(entry.record.body); setConfirmed(false);
  };
  const save = async (operation: "write" | "revoke") => {
    if (operation === "revoke" && !window.confirm(`Revoke ${scope} preference '${id}'? Its history will be retained.`)) return;
    const result = await run("/api/brain/memory", "POST", { project, scope, kind, id, body: text, expectedDigest: selected?.digest ?? null, operation, confirmInstruction: confirmed }, { refresh: false, success: operation === "revoke" ? "Preference revoked; history retained." : "Memory saved." });
    if (result.ok) { reset(); await list(); }
  };
  return <section className="grid gap-6 lg:grid-cols-[19rem_1fr]">
    <div className="space-y-3 rounded-lg border border-line p-4">
      <h2 className="text-sm font-semibold">Written memory</h2>
      <label className="block text-xs">Scope<select className="field" value={scope} onChange={event => { if (canDiscard()) { reset(); setScope(event.target.value as "project" | "global"); } }}><option value="project">This project</option><option value="global">Global user preferences</option></select></label>
      <p className="text-xs text-ink-3">{scope === "global" ? "Explicit instructions that apply across projects. Inferred lessons require Global Knowledge promotion review." : "Project facts, decisions, lessons and your project-specific preferences."}</p>
      <button type="button" className={buttonClass("secondary", true)} onClick={() => { if (canDiscard()) reset(); }}>New memory</button>
      {loading ? <p role="status">Loading memory…</p> : null}
      {loadError ? <p role="alert" className="text-sm text-bad-ink">{loadError} <button onClick={() => void list()} className="underline">Restart list</button></p> : null}
      {!loading && !entries.length ? <p className="text-sm text-ink-3">No typed memory on this page.</p> : null}
      <ul className="space-y-2">{entries.map(entry => <li key={entry.path}><button type="button" className="w-full rounded border border-line p-2 text-left text-sm hover:bg-surface-2" onClick={() => choose(entry)}><span className="block font-medium">{entry.record.id}</span><span className="text-xs text-ink-3">{entry.record.kind} · {entry.record.status} · revision {entry.record.revision}</span></button></li>)}</ul>
      <div className="flex gap-3 text-xs text-accent-ink">{after ? <button onClick={() => void list()}>First page</button> : null}{next ? <button onClick={() => void list(next)}>Next page →</button> : null}</div>
    </div>
    <div className="space-y-3 rounded-lg border border-line p-4">
      <h2 className="text-sm font-semibold">{selected ? "Edit memory" : "Create memory"}</h2>
      {latest ? <div role="alert" className="space-y-2 rounded border border-warn p-3 text-sm"><p>A newer revision exists. Your draft is preserved. Merge the current content before saving.</p><pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs">{latest.record.body}</pre><button className={buttonClass("secondary", true)} onClick={() => { setSelected(latest); setLatest(null); setConfirmed(false); }}>I reviewed the latest revision; keep my draft for merging</button></div> : null}
      <label className="block text-xs">Stable ID<input className="field" value={id} disabled={!!selected} placeholder="preferred-testing-style" onChange={event => { setId(event.target.value); setConfirmed(false); }} /></label>
      <label className="block text-xs">Kind<select className="field" value={kind} disabled={!!selected} onChange={event => { setKind(event.target.value as MemoryRecord["kind"]); setConfirmed(false); }}><option value="user_preference">User preference</option>{scope === "project" ? <><option value="project_fact">Project fact</option><option value="decision">Decision</option><option value="empirical_lesson">Empirical lesson</option></> : null}</select></label>
      <label className="block text-xs">{kind === "user_preference" ? "Your exact instruction" : "Memory content"}<textarea className="field font-mono text-sm" rows={12} value={text} onChange={event => { setText(event.target.value); setConfirmed(false); }} /></label>
      <details><summary className="cursor-pointer text-xs">Preview</summary><Markdown text={text} basePath={selected?.path ?? `projects/${project}/memory/${id}.md`} linkBase={base} /></details>
      {selected ? <p className="text-xs text-ink-3">Source: {selected.record.source.ref}. Author: {selected.record.author.id} ({selected.record.author.role}). Revision {selected.record.revision}, {selected.record.status}. {selected.record.scope.kind === "global" ? "Global scope." : `Project ${selected.record.scope.project}.`}</p> : null}
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />{kind === "user_preference" ? `This is my instruction and I authorize it for ${scope === "global" ? "all projects" : "this project"}.` : "I confirm this project memory and its source."}</label>
      <div className="flex gap-3"><button className={buttonClass("primary", true)} disabled={busy || !!latest || !confirmed || !/^[a-z0-9][a-z0-9_-]{0,80}$/.test(id) || !text.trim()} onClick={() => void save("write")}>Save memory</button>{selected?.record.kind === "user_preference" && selected.record.status !== "revoked" ? <button className={buttonClass("danger", true)} disabled={busy || !!latest || !confirmed} onClick={() => void save("revoke")}>Revoke preference</button> : null}</div>
      <ActionStatus error={error} message={message} />
      {error ? <p className="text-xs text-ink-3">Your draft is preserved. Refresh the list, inspect the current revision, and merge before retrying a conflict.</p> : null}
    </div>
  </section>;
}
