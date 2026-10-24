"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, RotateCcw, Save, X } from "lucide-react";
import { ActionStatus, callApi, useAction } from "./actions";
import { buttonClass } from "../ui";
import { Markdown } from "../markdown";

/** Edit a brain file in place. Saved as you; protocol errors from the server are listed inline. */
export function BrainEditor({ project, path, initial, digest, kind, maxCurrentState }: { project: string; path: string; initial: string; digest: string; kind: string; maxCurrentState: number }) {
  const router = useRouter();
  const [text, setText] = useState(initial);
  const [baseline, setBaseline] = useState({ content: initial, digest });
  const [latest, setLatest] = useState<{ content: string; digest: string } | null>(null);
  const observedDigest = useRef(digest);
  const currentText = useRef(text);
  currentText.current = text;
  const { run, busy, error, errors, message } = useAction();
  const dirty = text !== baseline.content;
  useEffect(() => {
    if (digest === observedDigest.current) return;
    observedDigest.current = digest;
    if (digest === baseline.digest) return;
    if (!dirty) { setText(initial); setBaseline({ content: initial, digest }); }
    else setLatest({ content: initial, digest });
  }, [initial, digest, baseline.digest, dirty]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    const navigate = (event: MouseEvent) => {
      const link = (event.target as Element).closest?.("a[href]") as HTMLAnchorElement | null;
      if (link && link.href !== window.location.href && !window.confirm("Discard this document's unsaved draft?")) {
        event.preventDefault(); event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", navigate, true);
    return () => { window.removeEventListener("beforeunload", warn); document.removeEventListener("click", navigate, true); };
  }, [dirty]);
  const loadLatest = async () => {
    const result = await callApi(`/api/brain?project=${encodeURIComponent(project)}&path=${encodeURIComponent(path)}`, "GET");
    if (result.ok && result.document) {
      const saved = result.document as { content: string; digest: string };
      if (saved.digest !== baseline.digest) setLatest(saved);
    }
  };
  const save = async () => {
    const submitted = text;
    const result = await run("/api/brain", "PUT", { project, path, content: submitted, expectedDigest: baseline.digest }, { success: "Saved and committed as you.", refresh: false });
    if (!result.ok) { await loadLatest(); return; }
    const current = await callApi(`/api/brain?project=${encodeURIComponent(project)}&path=${encodeURIComponent(path)}`, "GET");
    if (current.ok && current.document) {
      const saved = current.document as { content: string; digest: string };
      const written = result.saved as { digest?: string } | undefined;
      if (written?.digest && written.digest !== saved.digest) setLatest(saved);
      else {
        if (currentText.current === submitted) setText(saved.content);
        setBaseline(saved); setLatest(null);
      }
    }
    router.refresh();
  };
  const rules =
    kind === "working_doc"
      ? `Working document rules: keep the header block (Status, Status detail, Created, Last updated, Owner, Scope, Paired document, Related), keep "## Current State" under ${maxCurrentState} lines, and never change existing Work Ledger entries (append only).`
      : kind === "report"
        ? 'Report rules: title "# Report: <label>", sections Outcome (starting Done, Partial, or Blocked), What changed and why, Commands run and observed results, Not verified, Open questions or contradictions found.'
        : "Saved as you and committed to the brain repository.";
  return (
    <div className="space-y-3">
      <p className="text-xs text-ink-3">{rules}</p>
      {latest ? <div role="alert" className="space-y-2 rounded border border-warn p-3 text-sm">
        <p>A newer version exists. Your draft is preserved below. Compare and merge it before saving.</p>
        <details><summary className="cursor-pointer">Read latest saved version</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">{latest.content}</pre></details>
        <button type="button" className={buttonClass("secondary", true)} onClick={() => { setBaseline(latest); setLatest(null); }}>I reviewed the latest version; keep my draft for merging</button>
      </div> : null}
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
        <button type="button" className={buttonClass("primary", true)} disabled={busy || !dirty || !!latest} onClick={() => void save()}>
          <Save size={13} aria-hidden /> Save
        </button>
        {dirty ? (
          <button type="button" className={buttonClass("ghost", true)} onClick={() => setText(baseline.content)}>
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

/** Create-only saves protect existing memory from accidental replacement. */
export function BrainCreate({ project, base }: { project: string; base: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [kind, setKind] = useState("notes");
  const [content, setContent] = useState("# New memory\n\n");
  const { run, busy, error, message } = useAction();
  const valid = /^[a-z0-9][a-z0-9_-]{0,79}$/.test(name);
  const typed = kind === "facts" || kind === "decisions";
  const path = `projects/${project}/${typed ? "memory" : kind}/${name || "document-name"}.md`;
  const create = async () => {
    const result = typed
      ? await run("/api/brain/memory", "POST", { project, scope: "project", kind: kind === "facts" ? "project_fact" : "decision", id: name, body: content, expectedDigest: null, operation: "write", confirmInstruction: true }, { refresh: false, success: "Created memory" })
      : await run("/api/brain", "PUT", { project, path, content, expectedDigest: null }, { refresh: false, success: "Created note" });
    if (result.ok) { router.push(`${base}/brain?path=${encodeURIComponent(path)}`); router.refresh(); }
  };
  return <details className="rounded border border-line p-3">
    <summary className="cursor-pointer text-sm font-medium">Create project memory</summary>
    <div className="mt-3 space-y-2">
      <label className="block text-xs">Type<select className="field" value={kind} onChange={event => setKind(event.target.value)}><option value="notes">Note</option><option value="facts">Fact</option><option value="decisions">Decision</option></select></label>
      <label className="block text-xs">Document name<input className="field" value={name} onChange={event => setName(event.target.value)} placeholder="local-testing" /></label>
      <p className="break-all font-mono text-xs text-ink-3">{path}</p>
      <label className="block text-xs">Markdown<textarea className="field font-mono text-xs" rows={8} value={content} onChange={event => setContent(event.target.value)} /></label>
      <details><summary className="cursor-pointer text-xs">Preview memory</summary><div className="rounded border border-line p-3"><Markdown text={content} basePath={path} linkBase={base} /></div></details>
      <button className={buttonClass("primary", true)} type="button" disabled={!valid || busy || !content.trim()} onClick={() => void create()}>Create memory</button>
      <ActionStatus error={error} message={message} />
    </div>
  </details>;
}

/** Approve or deny one access request with a reason. */
export function AccessDecision({ id, project }: { id: number; project: string }) {
  const [reason, setReason] = useState("");
  const { run, busy, error, message } = useAction();
  const decide = (approve: boolean) => run(`/api/brain/access/${id}`, "POST", { project, approve, reason }, { success: approve ? "Approved" : "Denied" });
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
