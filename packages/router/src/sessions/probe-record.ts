/**
 * The recorded material a supervisor probe of a finished task is answered from: the task's goal
 * and result, and the tail of its worker session's transcript, rendered as bounded plain text.
 *
 * A finished task has no live lease, and the gate sends no task request without one, so a probe
 * cannot reopen the worker's session. Instead a new read-only task (core/channel-service.ts)
 * reads this record, quoted as data, and answers the question from it; that task's model request
 * goes through the gate like any other.
 */
import type { ChatMessage } from "../gateway/types.js";
import type { StoredTask } from "../storage/tasks.js";
import type { SessionStore } from "./store.js";
import { authorSessions } from "./run-sessions.js";

/** Default size of the rendered record, in characters (keeps the probe to one cheap request). */
export const PROBE_RECORD_MAX_CHARS = 48_000;
const MESSAGE_MAX_CHARS = 2_000;
const TOOL_ARGS_MAX_CHARS = 400;

export interface ProbeRecord {
  text: string;
  /** The worker sessions the record drew on (oldest first), for evidence refs. */
  sessionIds: string[];
  /** Transcript messages left out to fit the size bound. */
  omittedMessages: number;
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)} [... ${s.length - max} more characters]` : s);

function contentText(m: ChatMessage): string {
  if (typeof m.content === "string") return m.content;
  if (m.content === null) return "";
  return m.content.map((p) => (p.type === "text" ? p.text : "[image]")).join("\n");
}

/** One transcript message as a bounded line block. System prompts are left out (they are the harness's, not the worker's). */
function renderMessage(m: ChatMessage): string | null {
  if (m.role === "system") return null;
  const body = clip(contentText(m), MESSAGE_MAX_CHARS);
  if (m.role === "assistant") {
    const calls = (m.tool_calls ?? []).map((c) => `  -> ${c.function.name}(${clip(c.function.arguments, TOOL_ARGS_MAX_CHARS)})`);
    return [`[worker]${body ? ` ${body}` : ""}`, ...calls].join("\n");
  }
  if (m.role === "tool") return `[tool result ${m.tool_call_id}] ${body}`;
  return `[harness] ${body}`;
}

/** Render a finished task's record for a probe, at most `maxChars` characters (most recent transcript first to be kept). */
export function renderProbeRecord(task: StoredTask, sessions: SessionStore | null, maxChars = PROBE_RECORD_MAX_CHARS): ProbeRecord {
  const r = task.result;
  const head: string[] = [
    `Task ${task.row.id} (profile ${task.spec.profile}, state ${task.row.state}${task.row.state_reason ? `: ${task.row.state_reason}` : ""}).`,
    "Goal:",
    clip(task.spec.goal, 6_000),
  ];
  if (r) {
    head.push(
      `Result: execution ${r.executionStatus}, acceptance ${r.acceptanceStatus}${r.stopReason ? `, stop reason ${r.stopReason}` : ""}.`,
      "Summary:",
      clip(r.summary || "(none)", 6_000),
    );
    if (r.findings.length) head.push("Findings:", ...r.findings.slice(0, 30).map((f) => `- ${clip(f.description, 600)}${f.evidenceRefs.length ? ` (${f.evidenceRefs.slice(0, 6).join(", ")})` : ""}`));
    if (r.checks.length) head.push("Checks run by the harness:", ...r.checks.map((c) => `- \`${clip(c.command, 300)}\` exit ${c.exitCode ?? "none"} (log ${c.logRef})`));
    if (r.changedPaths?.length) head.push(`Changed paths: ${r.changedPaths.slice(0, 60).join(", ")}${r.changedPaths.length > 60 ? ", ..." : ""}`);
    if (r.unresolvedCriteria.length) head.push("Unresolved criteria:", ...r.unresolvedCriteria.map((c) => `- ${clip(c, 400)}`));
  } else {
    head.push("No result was recorded.");
  }

  const author = sessions ? authorSessions(sessions, task.row.id) : [];
  const sessionIds = author.map((s) => s.id);
  const last = author.at(-1);
  const transcript = last && sessions ? (sessions.transcript(last.id) ?? []) : [];
  const blocks = transcript.map(renderMessage).filter((b): b is string => b !== null);

  const headText = head.join("\n");
  let budget = Math.max(0, maxChars - headText.length - 200);
  const kept: string[] = [];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]!;
    if (b.length + 1 > budget) break;
    kept.unshift(b);
    budget -= b.length + 1;
  }
  const omitted = blocks.length - kept.length;
  const parts = [headText];
  if (last) {
    parts.push(`\nWorker session ${last.id} transcript${omitted ? ` (the ${omitted} earliest message(s) are omitted)` : ""}:`);
    parts.push(kept.length ? kept.join("\n") : "(no transcript messages fit or were recorded)");
  } else {
    parts.push("\nNo worker session was recorded for this task.");
  }
  return { text: parts.join("\n"), sessionIds, omittedMessages: omitted };
}
