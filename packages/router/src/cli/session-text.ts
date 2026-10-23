import type { SessionDetail, SessionView } from "../admin/insights.js";
import type { SessionEvent, SessionEventData } from "../sessions/events.js";
import { clock, duration, oneLine, stamp } from "./terminal.js";

// Agent sessions as terminal text: `meritrouter sessions` (a table) and `meritrouter session <id>`
// (a timeline: one line per event, with paging hints).

const compact = (v: unknown): string => (typeof v === "string" ? v : (JSON.stringify(v) ?? ""));

function messageText(m: SessionEventData<"message">["message"]): string {
  if (m.role === "tool") return `(${m.tool_call_id}) ${m.content}`;
  if (m.role === "assistant") return [m.content ?? "", m.tool_calls?.length ? `-> ${m.tool_calls.map((c) => c.function.name).join(", ")}` : ""].filter(Boolean).join(" ");
  if (typeof m.content === "string") return m.content;
  return m.content.map((p) => (p.type === "text" ? p.text : "[image]")).join(" ");
}

/** The name/ok column: what `session_events.name` and `ok` hold for the event. */
function eventName(e: SessionEvent): { name: string; ok?: boolean } {
  switch (e.type) {
    case "started": return { name: e.data.role };
    case "message": return { name: e.data.message.role };
    case "model_request": return { name: e.data.purpose };
    case "model_response": return { name: e.data.endpointId, ok: true };
    case "model_error": return { name: e.data.code ?? "error", ok: false };
    case "tool_intent": return { name: e.data.name };
    case "tool_outcome": return { name: e.data.name, ok: e.data.ok };
    case "ended": return { name: e.data.status };
    case "resumed": return { name: `${e.data.actions.length} action(s)` };
    default: return { name: "" };
  }
}

/** Fit the name/ok cell to `width`, shortening the name but never the ok/FAIL marker. */
function nameCell(e: SessionEvent, width: number): string {
  const { name, ok } = eventName(e);
  const mark = ok === undefined ? "" : ok ? " ok" : " FAIL";
  const room = width - mark.length;
  return `${name.length > room ? `${name.slice(0, room - 3)}...` : name}${mark}`.padEnd(width);
}

function eventSummary(e: SessionEvent): string {
  switch (e.type) {
    case "started": {
      const d = e.data;
      return [`agent ${d.agentLabel}`, d.profile && `profile ${d.profile}`, d.tier && `tier ${d.tier}`, d.taskId && `task ${d.taskId}`, d.parentSessionId && `parent ${d.parentSessionId}`, d.previousSessionId && `retries ${d.previousSessionId}`].filter(Boolean).join(", ");
    }
    case "message": return `#${e.data.index} ${messageText(e.data.message)}`;
    case "model_request": {
      const d = e.data;
      return [`${d.messageCount} msgs`, `max ${d.maxTokens} tok`, d.tools.length ? `tools ${d.tools.join(",")}` : "", d.responseFormat ? `format ${d.responseFormat}` : ""].filter(Boolean).join(", ");
    }
    case "model_response": {
      const d = e.data;
      const head = [d.finishReason ?? "?", `in ${d.usage.inputTokens ?? "?"} (${d.usage.cachedInputTokens === null ? "cache unknown" : `${d.usage.cachedInputTokens} cached`}) / out ${d.usage.outputTokens ?? "?"} tok`, d.attempts.length > 1 ? `${d.attempts.length} attempts` : ""].filter(Boolean).join(", ");
      const body = d.toolCalls.length ? `-> ${d.toolCalls.map((c) => c.function.name).join(", ")}` : (d.content ?? "");
      return body ? `${head}: ${body}` : head;
    }
    case "model_error": return `${e.data.status !== null ? `HTTP ${e.data.status}: ` : ""}${e.data.message}`;
    case "tool_intent": return `[${e.data.sideEffect}${e.data.idempotent ? ", idempotent" : ""}] ${compact(e.data.args)}`;
    case "tool_outcome": return `intent #${e.data.intentSeq}${e.data.truncated ? " (truncated)" : ""}: ${e.data.output}`;
    case "note": return e.data.data === undefined ? e.data.text : `${e.data.text} ${compact(e.data.data)}`;
    case "workspace": return e.data.repos.map((r) => `${r.alias} ${r.branch ?? "-"} @ ${(r.head ?? r.baseCommit ?? "?").slice(0, 10)}`).join("; ") || "(no repositories)";
    case "ended": return e.data.stopReason;
    case "resumed": {
      const d = e.data;
      const acts = d.actions.map((a) => (a.kind === "reconcile_edits" ? `reconcile edits (${a.policy})` : a.kind === "rerun_tool" ? `re-run ${a.name}` : `report ${a.name}`));
      const counts = [d.resolvedIntentSeqs.length && `${d.resolvedIntentSeqs.length} interrupted call(s) settled`, d.droppedRequestSeqs.length && `${d.droppedRequestSeqs.length} request(s) dropped`].filter(Boolean);
      return [acts.length ? acts.join(", ") : "", ...counts, d.summary].filter(Boolean).join("; ");
    }
    default: return "";
  }
}

function sessionLine(s: SessionView): string {
  return `${s.id} ${s.agentLabel} (${s.role}) ${s.status}${s.stopReason ? `: ${s.stopReason}` : ""}`;
}

/** The rows of `meritrouter sessions`, for `table`. */
export function sessionRows(list: SessionView[]): Array<Record<string, unknown>> {
  return list.map((s) => ({
    session: s.id,
    status: s.status,
    role: s.role,
    agent: s.agentLabel,
    task: s.taskLabel ?? s.taskId ?? "",
    job: s.jobId ?? "",
    requests: s.modelRequests,
    tools: s.toolCalls,
    events: s.lastSeq,
    started: stamp(s.createdAt),
    duration: duration(s.durationMs),
    reason: s.stopReason ?? "",
  }));
}

/** A terminal timeline: header, one line per event (seq, time, type, name/ok, summary), paging hint. */
export function sessionTimeline(d: SessionDetail, after: number): string {
  const s = d.session;
  const header = [
    sessionLine(s),
    [s.taskId && `task ${s.taskId}${s.taskLabel ? ` "${s.taskLabel}"` : ""}`, s.jobId && `job ${s.jobId}`, s.profile && `profile ${s.profile}`, s.tier && `tier ${s.tier}`].filter(Boolean).join("  ") || "(no task)",
    `started ${stamp(s.createdAt)}  ${s.endedAt ? `ended after ${duration(s.durationMs)}` : `running for ${duration(s.durationMs)}`}  model requests ${s.modelRequests}  tool calls ${s.toolCalls}  events ${s.lastSeq}`,
    ...(s.parentSessionId ? [`parent ${s.parentSessionId}`] : []),
    ...(s.previousSessionId ? [`retries ${s.previousSessionId}`] : []),
    `log ${s.logPath}`,
  ];
  const seqWidth = Math.max(3, String(s.lastSeq).length);
  const nameWidth = 32;
  const rows = d.events.map((e) => [String(e.seq).padStart(seqWidth), clock(e.at), e.type.padEnd(14), nameCell(e, nameWidth), oneLine(eventSummary(e))].join("  "));
  const cols = ["seq".padStart(seqWidth), "time".padEnd(12), "type".padEnd(14), "name/ok".padEnd(nameWidth), "summary"].join("  ");
  const lastShown = d.events.at(-1)?.seq ?? after;
  return [
    ...header,
    "",
    cols,
    ...(rows.length ? rows : [`(no events after seq ${after})`]),
    ...d.corrupt.map((c) => `CORRUPT ${c.line ? `line ${c.line}` : "log"}: ${c.error}${c.excerpt ? ` [${oneLine(c.excerpt, 60)}]` : ""}`),
    ...(d.hasMore ? [`more events: meritrouter session ${s.id} --after ${lastShown}`] : []),
    ...(d.children.length ? ["", "delegated sessions:", ...d.children.map((c) => `  ${sessionLine(c)}`)] : []),
    ...(d.taskSessions.length > 1 ? ["", "sessions of this task:", ...d.taskSessions.map((t) => `  ${t.id === s.id ? "*" : " "} ${sessionLine(t)}`)] : []),
  ].join("\n").trimEnd();
}
