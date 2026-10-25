"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, startTransition, type ReactNode } from "react";
import { Pause, Play } from "lucide-react";
import { buttonClass, cx } from "../ui";
import { ConfirmDialog } from "./confirm-dialog";

/**
 * Live updates (panel-v2 U1). One Server-Sent Events connection per tab (`/api/live`, scoped to
 * the project being viewed or `all`) says which topics changed; a page declares the topics it
 * shows (`useLive` / `<LiveStatus topics>`), and only a change to one of them re-renders the
 * page's server components in place (router.refresh: no reload, scroll position and open
 * disclosures kept), at most about once a second. Pausing stops this tab's refreshes, never the
 * work it shows; changes that arrive while paused are applied on resume. Hidden tabs release
 * their connection and catch up from the saved cursor when visible again.
 */

export type LiveState = "connecting" | "live" | "reconnecting" | "paused" | "offline";

/** Least time between two refreshes of the page. */
const MIN_GAP_MS = 1000;
/** Changes arriving together are applied together. */
const COALESCE_MS = 120;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];

/** Whether a subscription is reached by changed topics: `tasks:x` also by `tasks:*`. */
export function topicMatches(subscription: string, changed: readonly string[]): boolean {
  const colon = subscription.indexOf(":");
  if (colon < 0) return changed.includes(subscription);
  return changed.includes(subscription) || changed.includes(`${subscription.slice(0, colon)}:*`);
}

interface Snapshot {
  state: LiveState;
  paused: boolean;
  /** Changes for this page that arrived while paused (or hidden). */
  waiting: boolean;
  /** When the page last refreshed because of a change. */
  lastUpdate: number | null;
}

interface LiveApi {
  subscribe(id: string, topics: string[]): () => void;
  setPaused(paused: boolean): void;
  store: { get(): Snapshot; listen(cb: () => void): () => void };
}

const LiveContext = createContext<LiveApi | null>(null);

export function LiveProvider({ scope, children }: { scope: string; children: ReactNode }) {
  const router = useRouter();
  const subs = useRef(new Map<string, string[]>());
  const snap = useRef<Snapshot>({ state: "connecting", paused: false, waiting: false, lastUpdate: null });
  const listeners = useRef(new Set<() => void>());
  const pending = useRef(false);
  const lastRefresh = useRef(0);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connected = useRef(false);

  const update = useCallback((patch: Partial<Snapshot>) => {
    const next = { ...snap.current, ...patch };
    if ((Object.keys(patch) as Array<keyof Snapshot>).every((k) => snap.current[k] === patch[k])) return;
    snap.current = next;
    listeners.current.forEach((l) => l());
  }, []);

  const flush = useCallback(() => {
    if (flushTimer.current) clearTimeout(flushTimer.current);
    flushTimer.current = null;
    if (!pending.current) return;
    if (snap.current.paused || document.visibilityState !== "visible") {
      update({ waiting: true });
      return;
    }
    const wait = Math.max(COALESCE_MS, lastRefresh.current + MIN_GAP_MS - Date.now());
    flushTimer.current = setTimeout(() => {
      flushTimer.current = null;
      if (!pending.current || snap.current.paused) return;
      if (document.visibilityState !== "visible") {
        update({ waiting: true });
        return;
      }
      pending.current = false;
      lastRefresh.current = Date.now();
      update({ waiting: false, lastUpdate: lastRefresh.current });
      startTransition(() => router.refresh());
    }, wait);
  }, [router, update]);

  const onChange = useCallback(
    (topics: string[]) => {
      let hit = false;
      for (const wanted of subs.current.values()) if (wanted.some((t) => topicMatches(t, topics))) hit = true;
      if (!hit) return;
      pending.current = true;
      flush();
    },
    [flush],
  );

  // The connection: reconnects with backoff, resuming from the last event id.
  useEffect(() => {
    let es: EventSource | null = null;
    let cursor = "";
    let attempt = 0;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const disconnect = () => {
      if (retry) clearTimeout(retry);
      retry = null;
      const source = es;
      es = null;
      connected.current = false;
      source?.close();
    };

    const connect = () => {
      if (stopped || document.visibilityState !== "visible") return;
      disconnect();
      const q = new URLSearchParams({ scope });
      if (cursor) q.set("cursor", cursor);
      const source = new EventSource(`/api/live?${q.toString()}`);
      es = source;
      const current = () => es === source && !stopped && document.visibilityState === "visible";
      const remember = (e: MessageEvent) => {
        if (e.lastEventId) cursor = e.lastEventId;
      };
      source.addEventListener("hello", (e) => {
        if (!current()) return;
        remember(e as MessageEvent);
        attempt = 0;
        connected.current = true;
        if (!snap.current.paused) update({ state: "live" });
      });
      source.addEventListener("change", (e) => {
        if (!current()) return;
        remember(e as MessageEvent);
        try {
          const data = JSON.parse((e as MessageEvent).data as string) as { topics?: unknown };
          if (Array.isArray(data.topics)) onChange(data.topics.filter((t): t is string => typeof t === "string"));
        } catch {
          // a malformed event is ignored
        }
      });
      source.addEventListener("reset", (e) => {
        if (!current()) return;
        remember(e as MessageEvent);
        pending.current = true;
        flush();
      });
      source.onerror = () => {
        // Take over from the browser's own retry so the wait grows and the cursor is sent back.
        source.close();
        if (!current()) return;
        es = null;
        connected.current = false;
        if (!snap.current.paused) update({ state: navigator.onLine === false ? "offline" : "reconnecting" });
        const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
        attempt++;
        retry = setTimeout(connect, delay);
      };
    };

    const soon = () => {
      // Back on the network or the tab: try at once instead of waiting out the backoff.
      if (!es && !stopped && document.visibilityState === "visible") {
        attempt = 0;
        connect();
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        soon();
        flush();
      } else {
        disconnect();
        if (flushTimer.current) clearTimeout(flushTimer.current);
        flushTimer.current = null;
        // Without a cursor, the next hello cannot tell us what the hidden page missed.
        if (!cursor) pending.current = true;
        if (pending.current) update({ waiting: true });
        if (!snap.current.paused) update({ state: "reconnecting" });
      }
    };

    update({ state: snap.current.paused ? "paused" : "connecting" });
    onVisible();
    window.addEventListener("online", soon);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      disconnect();
      window.removeEventListener("online", soon);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [scope, onChange, update, flush]);

  useEffect(
    () => () => {
      if (flushTimer.current) clearTimeout(flushTimer.current);
    },
    [],
  );

  const api = useMemo<LiveApi>(
    () => ({
      subscribe(id, topics) {
        subs.current.set(id, topics);
        return () => {
          subs.current.delete(id);
        };
      },
      setPaused(paused) {
        update({ paused, state: paused ? "paused" : connected.current ? "live" : "reconnecting" });
        if (!paused) flush();
      },
      store: {
        get: () => snap.current,
        listen(cb) {
          listeners.current.add(cb);
          return () => listeners.current.delete(cb);
        },
      },
    }),
    [update, flush],
  );

  return <LiveContext.Provider value={api}>{children}</LiveContext.Provider>;
}

const OUTSIDE: Snapshot = { state: "offline", paused: false, waiting: false, lastUpdate: null };

/** Refresh this page when one of `topics` changes. Outside a LiveProvider (sign-in page) it does nothing. */
export function useLive(topics: string[]): Snapshot & { setPaused(p: boolean): void; inside: boolean } {
  const api = useContext(LiveContext);
  const id = useId();
  const key = topics.join(" ");
  useEffect(() => {
    if (!api || !key) return;
    return api.subscribe(id, key.split(" "));
  }, [api, id, key]);
  const s = useSyncExternalStore(
    (cb) => (api ? api.store.listen(cb) : () => undefined),
    () => (api ? api.store.get() : OUTSIDE),
    () => OUTSIDE,
  );
  return { ...s, setPaused: (p) => api?.setPaused(p), inside: !!api };
}

/** Subscribe to topics without showing anything (a section that wants more than its page header lists). */
export function LiveTopics({ topics }: { topics: string[] }) {
  useLive(topics);
  return null;
}

const LABEL: Record<LiveState, string> = {
  connecting: "Connecting",
  live: "Live",
  reconnecting: "Reconnecting",
  paused: "Paused",
  offline: "Offline",
};

/**
 * The page header's live state: subscribes to `topics` and shows whether changes are arriving
 * (live, reconnecting, paused) with the pause control. Pausing asks first: it only stops this tab
 * refreshing, never the tasks, jobs, or workers it shows.
 */
export function LiveStatus({ topics, className }: { topics: string[]; className?: string }) {
  const live = useLive(topics);
  const [confirming, setConfirming] = useState(false);
  if (!live.inside) return null;
  const { state, paused, waiting } = live;
  const tone = state === "live" ? "good" : state === "paused" ? "idle" : "warn";
  const title =
    state === "live"
      ? "Changes appear here as they happen"
      : state === "paused"
        ? waiting
          ? "Paused: changes are waiting; resume to show them"
          : "Paused: this page is not updating"
        : state === "connecting"
          ? "Connecting to live updates"
          : "The live connection dropped; retrying";
  return (
    <div role="group" aria-label="Live page updates" className={cx("inline-flex items-center gap-1.5", className)}>
      <span
        role="status"
        aria-live="polite"
        title={title}
        data-live-state={state}
        className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-line bg-surface px-2.5 py-1 text-xs font-medium text-ink-2"
      >
        {tone === "good" ? (
          <span className="relative flex h-2 w-2" aria-hidden>
            <span className="absolute inline-flex h-full w-full rounded-full bg-good opacity-60 motion-safe:animate-ping" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-good" />
          </span>
        ) : (
          <span className={cx("inline-flex h-2 w-2 rounded-full", tone === "warn" ? "bg-warn" : "bg-ink-3 opacity-60")} aria-hidden />
        )}
        <span className={tone === "good" ? "text-good-ink" : tone === "warn" ? "text-warn-ink" : "text-ink-2"}>{LABEL[state]}</span>
        {paused && waiting ? <span className="font-normal text-ink-3">· changes waiting</span> : null}
      </span>
      <button
        type="button"
        className={buttonClass("ghost", true)}
        aria-label={paused ? "Resume live updates" : "Pause live updates"}
        title={paused ? "Resume live updates" : "Pause live updates"}
        onClick={() => (paused ? live.setPaused(false) : setConfirming(true))}
      >
        {paused ? <Play size={12} aria-hidden /> : <Pause size={12} aria-hidden />}
        <span className="sr-only sm:not-sr-only">{paused ? "Resume" : "Pause"}</span>
      </button>
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => live.setPaused(true)}
        title="Pause live updates?"
        description="This tab stops showing changes until you resume. Tasks, jobs, and workers keep running; this only affects what this tab shows."
        confirmLabel="Pause updates"
        cancelLabel="Cancel"
      />
    </div>
  );
}
