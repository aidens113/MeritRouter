"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { Pause, Play, RefreshCw } from "lucide-react";
import { buttonClass, cx } from "../ui";
import { ConfirmDialog } from "./confirm-dialog";

export interface ApiResult {
  ok: boolean;
  error?: string;
  errors?: string[];
  [k: string]: unknown;
}

export async function callApi(url: string, method: string, payload?: unknown): Promise<ApiResult> {
  try {
    const res = await fetch(url, {
      method,
      headers: payload !== undefined ? { "content-type": "application/json" } : {},
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
    });
    const text = await res.text();
    let data: ApiResult;
    try {
      data = JSON.parse(text) as ApiResult;
    } catch {
      data = { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    if (!res.ok && data.ok !== false) data = { ...data, ok: false, error: data.error ?? `HTTP ${res.status}` };
    return data;
  } catch (err) {
    return { ok: false, error: `Network error: ${(err as Error).message}` };
  }
}

/** Run an API mutation, then refresh server components. Tracks busy/error/message state. */
export function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  const run = useCallback(
    async (url: string, method: string, payload?: unknown, opts: { success?: string; refresh?: boolean } = {}) => {
      setBusy(true);
      setError(null);
      setErrors([]);
      setMessage(null);
      const r = await callApi(url, method, payload);
      setBusy(false);
      if (!r.ok) {
        setError(r.error ?? "Something went wrong");
        setErrors(r.errors ?? []);
      } else {
        if (opts.success) setMessage(opts.success);
        if (opts.refresh !== false) startTransition(() => router.refresh());
      }
      return r;
    },
    [router],
  );

  return { run, busy: busy || pending, error, errors, message, setError, setMessage };
}

export function ActionStatus({ error, message, errors }: { error: string | null; message?: string | null; errors?: string[] }) {
  if (error)
    return (
      <div role="alert" className="rounded-lg border border-bad/30 bg-bad-soft px-3 py-2 text-xs text-bad-ink">
        <div className="whitespace-pre-wrap">{error}</div>
        {errors && errors.length > 1 ? (
          <ul className="mt-1 list-disc pl-4">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  if (message)
    return (
      <div role="status" className="rounded-lg border border-good/30 bg-good-soft px-3 py-2 text-xs text-good-ink">
        {message}
      </div>
    );
  return null;
}

/** Simple action button: POST/DELETE/PATCH then refresh. Optional two-step confirmation. */
export function ActionButton({
  url,
  method = "POST",
  payload,
  children,
  variant = "secondary",
  small = false,
  confirm,
  success,
  className,
  onDone,
}: {
  url: string;
  method?: string;
  payload?: unknown;
  children: ReactNode;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  small?: boolean;
  confirm?: string;
  success?: string;
  className?: string;
  onDone?: (r: ApiResult) => void;
}) {
  const { run, busy, error, message } = useAction();
  const [arming, setArming] = useState(false);
  useEffect(() => {
    if (!arming) return;
    const t = setTimeout(() => setArming(false), 4000);
    return () => clearTimeout(t);
  }, [arming]);
  return (
    <span className={cx("inline-flex flex-col gap-1", className)}>
      <button
        type="button"
        disabled={busy}
        className={buttonClass(arming ? "danger" : variant, small)}
        onClick={async () => {
          if (confirm && !arming) {
            setArming(true);
            return;
          }
          setArming(false);
          const r = await run(url, method, payload, success ? { success } : {});
          onDone?.(r);
        }}
      >
        {busy ? <RefreshCw size={14} className="animate-spin" aria-hidden /> : null}
        {arming ? confirm : children}
      </button>
      <ActionStatus error={error} message={message} />
    </span>
  );
}

/**
 * Re-render server components every few seconds while the tab is visible. The status ("Live" or
 * "Paused") and the control that changes it are separate elements, and pausing asks first: it
 * only stops this page refreshing, never the tasks, jobs, or workers it shows.
 */
export function AutoRefresh({ seconds = 8 }: { seconds?: number }) {
  const router = useRouter();
  const [paused, setPaused] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (paused) return;
    timer.current = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      router.refresh();
    }, seconds * 1000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [paused, router, seconds]);
  return (
    <div role="group" aria-label="Live page updates" className="inline-flex flex-wrap items-center gap-2">
      <span
        role="status"
        aria-live="polite"
        title={paused ? "This page is not refreshing" : `This page refreshes every ${seconds} seconds`}
        className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-line bg-surface px-2.5 py-1 text-xs font-medium text-ink-2"
      >
        {paused ? (
          <span className="inline-flex h-2 w-2 rounded-full bg-ink-3 opacity-60" aria-hidden />
        ) : (
          <span className="relative flex h-2 w-2" aria-hidden>
            <span className="absolute inline-flex h-full w-full rounded-full bg-good opacity-60 motion-safe:animate-ping" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-good" />
          </span>
        )}
        <span className={paused ? "text-ink-2" : "text-good-ink"}>{paused ? "Paused" : "Live"}</span>
        <span className="font-normal text-ink-3">{paused ? " · not updating" : ` · updates every ${seconds}s`}</span>
      </span>
      <button
        type="button"
        className={buttonClass("secondary", true)}
        onClick={() => {
          if (paused) {
            setPaused(false);
            router.refresh();
          } else {
            setConfirming(true);
          }
        }}
      >
        {paused ? <Play size={12} aria-hidden /> : <Pause size={12} aria-hidden />}
        {paused ? "Resume updates" : "Pause updates"}
      </button>
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => setPaused(true)}
        title="Pause live updates?"
        description="This page stops refreshing until you resume. Tasks, jobs, and workers keep running; this only affects what this page shows."
        confirmLabel="Pause updates"
        cancelLabel="Cancel"
      />
    </div>
  );
}
