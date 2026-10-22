import { insights } from "switchyard-router";
import { json } from "@/lib/api";
import { getSy } from "@/lib/sy";
import { findProject } from "@/lib/project";
import { subscribeLive, type LiveMessage } from "@/lib/live-hub";

export const dynamic = "force-dynamic";

/** A comment line now and then keeps proxies and the browser from closing an idle stream. */
const HEARTBEAT_MS = 15_000;
/** How long the browser waits before reconnecting on its own (the client also backs off itself). */
const RETRY_MS = 2_000;

/**
 * Server-Sent Events: what changed in the store, as topics (`tasks`, `tasks:<id>`, `jobs:<id>`,
 * `requests`, `brain`, ...). `?scope=all` (default) or `?scope=<project slug>`. Each `change`
 * event's id is a resume cursor: a reconnect that sends it back (`Last-Event-ID`, or `?cursor=`)
 * first gets one event for whatever changed while it was away. Nothing is sent while nothing
 * changes, apart from a heartbeat comment.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const scope = url.searchParams.get("scope") || "all";
  const r = getSy();
  if (!r.sy) return json({ ok: false, error: `SwitchYard is not configured: ${r.error}` }, 503);
  const sy = r.sy;
  if (scope !== "all" && !findProject(sy, scope, { archived: true })) return json({ ok: false, error: `No project ${scope}` }, 404);
  const resume = req.headers.get("last-event-id") || url.searchParams.get("cursor") || "";

  const encoder = new TextEncoder();
  let stop: (() => void) | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let unsubscribe = () => {};
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      function close() {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe();
        req.signal.removeEventListener("abort", close);
        try {
          controller.close();
        } catch {
          // already closed by the client
        }
      }
      const write = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          close();
        }
      };
      const send = (event: string, id: string, data: unknown) => write(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      write(`retry: ${RETRY_MS}\n\n`);
      // Catch up a resumed client first, then hand over to the shared watcher.
      try {
        const from = resume ? insights.decodeLiveCursor(resume, scope) : null;
        if (from) {
          const check = insights.liveChanges(sy, from);
          if (check.topics.length) send("change", insights.encodeLiveCursor(check.cursor), { topics: check.topics, resumed: true });
        }
        send("hello", insights.encodeLiveCursor(insights.liveCursor(sy, scope)), { scope });
      } catch (err) {
        console.error("[panel] live updates: reading the store failed:", err);
        send("hello", "", { scope });
      }
      if (closed) return;
      unsubscribe = subscribeLive(scope, (m: LiveMessage) => send("change", m.cursor, { topics: m.topics }));
      heartbeat = setInterval(() => write(`: ${Date.now()}\n\n`), HEARTBEAT_MS);
      stop = close;
      if (req.signal.aborted) close();
      else req.signal.addEventListener("abort", close);
    },
    cancel() {
      stop?.();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      // no-transform keeps the response compressor from buffering the stream.
      "cache-control": "no-cache, no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
