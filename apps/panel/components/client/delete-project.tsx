"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, RefreshCw, Trash2, X } from "lucide-react";
import type { insights } from "meritrouter";
import { buttonClass, Mono } from "../ui";
import { callApi } from "./actions";
import { ConfirmDialog } from "./confirm-dialog";

type Preview = insights.ProjectDeletionPreview;

/**
 * The project settings page's Danger zone. Deleting takes two dialogs: the first lists what goes
 * and what stays, with current counts (GET /api/projects/<slug>/deletion) and any reason it cannot
 * be deleted now; the second asks for the slug before the red "Delete permanently"
 * (DELETE /api/projects/<slug>). Afterwards the panel goes to the projects grid.
 */
export function DangerZone({ slug, name }: { slug: string; name: string }) {
  const router = useRouter();
  const opener = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [first, setFirst] = useState(false);
  const [second, setSecond] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setPreview(null);
    setLoadError(null);
    setFirst(true);
    const r = await callApi(`/api/projects/${encodeURIComponent(slug)}/deletion`, "GET");
    if (!r.ok) return setLoadError(r.error ?? "The counts could not be read.");
    setPreview(r.preview as Preview);
  };

  // The second dialog starts on its input (the dialog itself focuses Cancel first).
  useEffect(() => {
    if (second) input.current?.focus();
  }, [second]);

  const remove = async (): Promise<boolean> => {
    setError(null);
    const r = await callApi(`/api/projects/${encodeURIComponent(slug)}`, "DELETE", { confirm: typed });
    if (!r.ok) {
      setError(r.error ?? "The project was not deleted.");
      return false;
    }
    router.push("/");
    router.refresh();
    return true;
  };

  const blocked = Boolean(preview?.blockers.length);
  return (
    // Not <Card>: its neutral border class would compete with the red one.
    <section id="danger" aria-labelledby="danger-title" className="min-w-0 scroll-mt-28 rounded-xl border border-bad/50 bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.03)] xl:scroll-mt-6">
      <div className="border-b border-bad/30 px-4 py-3">
        <h2 id="danger-title" className="text-sm font-semibold text-bad-ink">
          Danger zone
        </h2>
        <p className="mt-0.5 text-xs text-ink-3">Actions here cannot be undone.</p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="min-w-0 max-w-prose">
          <div className="text-sm font-medium text-ink">Delete this project</div>
          <p className="mt-0.5 text-xs text-ink-3">
            Removes its settings, tasks, sessions, worktrees, and brain folder. Its repository folders and branches are not touched, and its model requests and spend stay in the accounting. To hide it instead, archive it.
          </p>
        </div>
        <button ref={opener} type="button" className={buttonClass("danger")} onClick={start}>
          <Trash2 size={14} aria-hidden /> Delete project
        </button>
      </div>

      <ConfirmDialog
        open={first}
        onClose={() => setFirst(false)}
        onConfirm={() => {
          setTyped("");
          setError(null);
          setSecond(true);
        }}
        title={`Delete ${name}?`}
        description="Deleting removes the project from MeritRouter. Read what goes and what stays."
        confirmLabel="Continue"
        tone="danger"
        confirmDisabled={!preview || blocked}
      >
        {loadError ? (
          <p role="alert" className="text-bad-ink">
            {loadError}
          </p>
        ) : !preview ? (
          <p className="flex items-center gap-2 text-ink-3" role="status">
            <RefreshCw size={14} className="animate-spin" aria-hidden /> Counting what the project holds...
          </p>
        ) : (
          <div className="space-y-3">
            {blocked ? (
              <div role="alert" className="flex gap-2 rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-warn-ink">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
                <div>
                  <div className="font-medium">It cannot be deleted now</div>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4">
                    {preview.blockers.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : null}
            <List title="Removed" tone="bad" items={preview.removes} />
            <List title="Kept" tone="good" items={preview.keeps} />
          </div>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={second}
        onClose={() => {
          setSecond(false);
          setTimeout(() => opener.current?.focus(), 0);
        }}
        onConfirm={remove}
        title={`Delete ${name} permanently?`}
        description="This cannot be undone. Type the project's slug to confirm."
        confirmLabel="Delete permanently"
        tone="destructive"
        confirmDisabled={typed !== slug}
      >
        <label htmlFor="delete-project-slug" className="block text-sm text-ink-2">
          Type <Mono>{slug}</Mono> to confirm
        </label>
        <input
          ref={input}
          id="delete-project-slug"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          className="field mt-1 font-mono"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? "delete-project-error" : undefined}
        />
        {error ? (
          <p id="delete-project-error" role="alert" className="mt-2 text-sm text-bad-ink">
            {error}
          </p>
        ) : null}
      </ConfirmDialog>
    </section>
  );
}

function List({ title, tone, items }: { title: string; tone: "bad" | "good"; items: string[] }) {
  const Icon = tone === "bad" ? X : Check;
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wide text-ink-3">{title}</div>
      <ul className="mt-1 space-y-1">
        {items.map((i) => (
          <li key={i} className="flex gap-2 text-ink-2">
            <Icon size={14} className={tone === "bad" ? "mt-0.5 shrink-0 text-bad-ink" : "mt-0.5 shrink-0 text-good-ink"} aria-hidden />
            <span>{i}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
