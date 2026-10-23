import "server-only";
import { insights } from "meritrouter";
import { getSy } from "./sy";

/**
 * One change watcher per scope (`all` or a project slug) for the whole panel process, however many
 * tabs are open: it checks the store about once a second (router `insights.liveChanges`, which does
 * not query the store when nothing wrote to it) and hands each change to every open /api/live
 * stream of that scope. It stops when its last stream closes.
 */

export interface LiveMessage {
  /** The resume cursor after this change (the SSE event id). */
  cursor: string;
  topics: string[];
  reset?: boolean;
}

type Listener = (msg: LiveMessage) => void;
type Watcher = { scope: string; cursor: insights.LiveCursor | null; listeners: Set<Listener>; timer: ReturnType<typeof setInterval> | null; failing: boolean };

export const LIVE_POLL_MS = 1000;

const KEY = Symbol.for("meritrouter.panel.live");
const g = globalThis as unknown as Record<symbol, Map<string, Watcher> | undefined>;
const watchers = (g[KEY] ??= new Map<string, Watcher>());

function tick(w: Watcher): void {
  const r = getSy();
  if (!r.sy) return;
  try {
    if (!w.cursor) {
      w.cursor = insights.liveCursor(r.sy, w.scope);
      if (w.failing) {
        w.failing = false;
        const msg: LiveMessage = { cursor: insights.encodeLiveCursor(w.cursor), topics: [], reset: true };
        for (const listener of [...w.listeners]) {
          try { listener(msg); } catch { /* stream cleanup belongs to its close handler */ }
        }
      }
      return;
    }
    const check = insights.liveChanges(r.sy, w.cursor);
    w.cursor = check.cursor;
    w.failing = false;
    if (!check.topics.length) return;
    const msg: LiveMessage = { cursor: insights.encodeLiveCursor(check.cursor), topics: check.topics };
    for (const l of [...w.listeners]) {
      try {
        l(msg);
      } catch {
        // a stream that failed to write is removed by its own close handler
      }
    }
  } catch (err) {
    // Log once per failure streak; the next tick retries from a fresh cursor.
    if (!w.failing) console.error(`[panel] live updates (${w.scope}) failed:`, err);
    w.failing = true;
    w.cursor = null;
  }
}

/** Listen for changes in `scope`; returns the function that stops listening. */
export function subscribeLive(scope: string, listener: Listener): () => void {
  let w = watchers.get(scope);
  if (!w) {
    w = { scope, cursor: null, listeners: new Set(), timer: null, failing: false };
    watchers.set(scope, w);
  }
  w.listeners.add(listener);
  if (!w.timer) {
    tick(w);
    const watcher = w;
    w.timer = setInterval(() => tick(watcher), LIVE_POLL_MS);
    // Never keep the process alive for a watcher alone.
    (w.timer as { unref?: () => void }).unref?.();
  }
  const watcher = w;
  return () => {
    watcher.listeners.delete(listener);
    if (watcher.listeners.size === 0) {
      if (watcher.timer) clearInterval(watcher.timer);
      watcher.timer = null;
      watcher.cursor = null;
      watchers.delete(watcher.scope);
    }
  };
}

/** How many streams are open per scope (for diagnostics). */
export function liveStreams(): Record<string, number> {
  return Object.fromEntries([...watchers.values()].map((w) => [w.scope, w.listeners.size]));
}
