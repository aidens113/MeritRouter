"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, FileCode2, FileDiff, FileJson, FileText, Loader2 } from "lucide-react";
import { callApi } from "./actions";
import { cx } from "../ui";

interface Loaded {
  text: string;
  truncated: boolean;
  mediaType: string;
  kind: string;
}

/** Expandable artifact: loads on first open; patches render as a unified diff. */
export function ArtifactViewer({ refId, kind, label, bytes, mediaType, defaultOpen = false }: { refId: string; kind: string; label: string; bytes?: number; mediaType?: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const isDiff = kind === "patch" || mediaType === "text/x-diff";
  const Icon = isDiff ? FileDiff : mediaType === "application/json" ? FileJson : kind.endsWith("log") || kind === "agent_output" ? FileCode2 : FileText;

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && !data && !loading) {
      setLoading(true);
      const r = await callApi(`/api/artifacts?ref=${encodeURIComponent(refId)}`, "GET");
      setLoading(false);
      if (!r.ok) setError(r.error ?? "Could not load artifact");
      else {
        const row = r.row as { mediaType: string; kind: string };
        setData({ text: String(r.text ?? ""), truncated: Boolean(r.truncated), mediaType: row.mediaType, kind: row.kind });
      }
    }
  };
  useEffect(() => {
    if (defaultOpen) void toggle();
    // Open once on mount when asked; later toggles are the user's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="rounded-lg border border-line">
      <button type="button" onClick={toggle} aria-expanded={open} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface-2">
        {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
        <Icon size={14} className="text-ink-3" aria-hidden />
        <span className="min-w-0 flex-1 truncate font-medium text-ink">{label}</span>
        <span className="shrink-0 text-xs text-ink-3">
          {kind.replace(/_/g, " ")}
          {bytes !== undefined ? ` · ${bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`}` : ""}
        </span>
      </button>
      {open ? (
        <div className="border-t border-line">
          {loading ? (
            <div className="flex items-center gap-2 px-3 py-3 text-xs text-ink-3">
              <Loader2 size={13} className="animate-spin" aria-hidden /> Loading…
            </div>
          ) : error ? (
            <div className="px-3 py-3 text-xs text-bad-ink">{error}</div>
          ) : data ? (
            <div className="max-h-[32rem] overflow-auto">
              {isDiff ? <Diff text={data.text} /> : <pre className="whitespace-pre-wrap break-words p-3 font-mono text-xs text-ink-2">{pretty(data)}</pre>}
              {data.truncated ? <div className="border-t border-line px-3 py-2 text-xs text-warn-ink">Showing the first 200 KB only.</div> : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function pretty(d: Loaded): string {
  if (d.mediaType === "application/json") {
    try {
      return JSON.stringify(JSON.parse(d.text), null, 2);
    } catch {
      return d.text;
    }
  }
  return d.text || "(empty)";
}

export function Diff({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <div className="py-1" role="region" aria-label="Patch">
      {lines.map((l, i) => {
        const cls = l.startsWith("+++") || l.startsWith("---") || l.startsWith("diff ") || l.startsWith("index ") ? "diff-meta font-semibold" : l.startsWith("@@") ? "diff-hunk" : l.startsWith("+") ? "diff-add" : l.startsWith("-") ? "diff-del" : "";
        return (
          <div key={i} className={cx("diff-line", cls)}>
            {l || " "}
          </div>
        );
      })}
    </div>
  );
}
