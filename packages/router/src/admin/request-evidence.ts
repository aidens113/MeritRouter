import { closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { createHash } from "node:crypto";
import type { Switchyard } from "../core/service.js";
import { SessionEventSchema, type SessionEvent, type SessionEventOf } from "../sessions/events.js";
import { maskSecrets, requestSecrets } from "../providers/secret-masking.js";

export const REQUEST_EVIDENCE_LIMITS = { sessions: 12, journalBytes: 512 * 1024, totalJournalBytes: 4 * 1024 * 1024, events: 5000, lineBytes: 128 * 1024, messages: 96, transcriptSlots: 4096, tools: 48, textBytes: 128 * 1024, itemBytes: 8000, tasks: 50, files: 100, artifacts: 40 } as const;
const Id = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/);
const SessionRow = z.object({ id: Id, agent_label: z.string().max(240), role: z.string().max(100), task_id: z.string().nullable() });
const RequestRow = z.object({ id: Id, execution_id: z.string().max(500), project_id: z.string().max(200), status: z.string().max(100) });
const secretKey = /^(?:authorization|proxy-authorization|headers?|env|environment|api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|credentials?)$/i;
type ToolCall = { id: string; name: string; arguments: string };
export interface RequestExchange {
  sessionId: string; agent: string; role: string; requestSeq: number; responseSeq: number;
  sessions: Array<{sessionId: string; agent: string; role: string}>;
  parameters: { purpose: string; messageCount: number; maxTokens: number; temperature: number | null; tools: string[]; toolChoice: string | null; responseFormat: string | null };
  input: Array<{ index: number; role: string; content: string; toolCallId?: string; toolCalls: ToolCall[] }>;
  response: { content: string | null; finishReason: string | null; toolCalls: ToolCall[] };
  actions: Array<{ callId: string; name: string; sideEffect: string; arguments: string; outcome: string | null; ok: boolean | null; truncated: boolean; file: string | null }>;
  partial: boolean;
}
export interface RequestRelatedTask {
  taskId: string; summary: string | null; changedPaths: string[];
  artifacts: Array<{ id: string; kind: string; label: string; bytes: number }>;
  commits: Array<{ repository: string; sha: string }>;
}
export interface RequestEvidence {
  payloadScopeExclusive: boolean;
  state: "available" | "partial" | "unavailable"; explanation: string; warnings: string[];
  exchanges: RequestExchange[]; relatedTasks: RequestRelatedTask[]; limits: typeof REQUEST_EVIDENCE_LIMITS;
}

/** A separate bounded reader: SessionStore.events currently reads the whole file before paging. */
function journal(sy: Switchyard, id: string, remaining: { bytes: number }, warnings: string[]) {
  let fd: number | undefined;
  const events: SessionEvent[] = [];
  try {
    const directory = path.join(sy.cfg.storageDir, "sessions"), file = path.join(directory, `${Id.parse(id)}.jsonl`);
    if (lstatSync(directory).isSymbolicLink() || !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error("unsafe");
    fd = openSync(file, "r");
    const capacity = Math.min(REQUEST_EVIDENCE_LIMITS.journalBytes, remaining.bytes);
    if (capacity <= 0) { warnings.push("Journal read budget reached; some session evidence is unavailable."); return events; }
    const bytes = Buffer.alloc(capacity), count = readSync(fd, bytes, 0, capacity, 0); remaining.bytes -= count;
    const capped = fstatSync(fd).size > count;
    if (capped) warnings.push(`${id}: journal byte limit reached.`);
    const text = bytes.subarray(0, count).toString("utf8");
    const lines = text.split("\n");
    let previous = 0;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      if (!line.trim()) continue;
      if (index >= REQUEST_EVIDENCE_LIMITS.events) { warnings.push(`${id}: event limit reached.`); break; }
      if (Buffer.byteLength(line) > REQUEST_EVIDENCE_LIMITS.lineBytes || (capped && index === lines.length - 1)) { warnings.push(`${id}: oversized or incomplete journal line omitted.`); continue; }
      try {
        const event = SessionEventSchema.parse(JSON.parse(line));
        if (event.seq <= previous) { warnings.push(`${id}: non-increasing journal sequence omitted.`); continue; }
        if (previous && event.seq !== previous + 1) warnings.push(`${id}: journal sequence gap.`);
        previous = event.seq; events.push(event);
      } catch { warnings.push(`${id}: malformed or truncated journal line omitted.`); }
    }
  } catch { warnings.push(`${id}: journal is missing, unreadable or unsafe.`); }
  finally { if (fd !== undefined) closeSync(fd); }
  return events;
}

function redactor(events: SessionEvent[], warnings: string[], budget = { remaining: REQUEST_EVIDENCE_LIMITS.textBytes as number }) {
  const secrets = new Set<string>();
  const collect = (value: unknown, depth = 0) => {
    if (depth > 10 || !value) return;
    if (typeof value === "string" && /^[\[{]/.test(value)) { try { collect(JSON.parse(value), depth + 1); } catch { /* ordinary text */ } return; }
    if (typeof value !== "object") return;
    for (const [key, item] of Object.entries(value).slice(0, 200)) {
      if (secretKey.test(key) && typeof item === "string" && item.length >= 4) secrets.add(item);
      else if (secretKey.test(key) && item && typeof item === "object") {
        for (const nested of Object.values(item).slice(0, 200)) if (typeof nested === "string" && nested.length >= 4) {
          secrets.add(nested); const match = /^Bearer\s+(.+)$/i.exec(nested); if (match) secrets.add(match[1]!);
        }
      }
      else collect(item, depth + 1);
    }
  };
  for (const event of events) collect(event.data);
  const clean = (value: unknown, depth = 0): unknown => {
    if (depth > 10) { warnings.push("Nested recorded content exceeds the display depth limit."); return "[nested content omitted]"; }
    if (Array.isArray(value)) { if (value.length > 100) warnings.push("Nested recorded content exceeds the display item limit."); return value.slice(0, 100).map(v => clean(v, depth + 1)); }
    if (value && typeof value === "object") { const entries = Object.entries(value); if (entries.length > 100) warnings.push("Nested recorded content exceeds the display item limit."); return Object.fromEntries(entries.slice(0, 100).map(([key, item]) => [key, secretKey.test(key) ? "[private field omitted]" : clean(item, depth + 1)])); }
    if (typeof value !== "string") return value;
    try { for (const secret of requestSecrets({}, value)) secrets.add(secret); } catch { /* plain text */ }
    return maskSecrets(value, secrets)
      .replace(/((?:authorization|proxy-authorization)\s*["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s"',;}]+/gi, "$1[redacted]")
      .replace(/((?:api[-_]?key|access[-_]?token|password|secret)\s*["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi, "$1[redacted]")
      .replace(/([?&](?:key|api[-_]?key|access[-_]?token|token|password|secret)=)[^&\s"']+/gi, "$1[redacted]")
      .replace(/data:image\/[^\s"']+/gi, "[image data omitted]");
  };
  return (value: unknown) => {
    const cleaned = clean(value), text = typeof cleaned === "string" ? cleaned : JSON.stringify(cleaned, null, 2) ?? "";
    const bytes = Buffer.from(text); const size = Math.min(budget.remaining, REQUEST_EVIDENCE_LIMITS.itemBytes, bytes.length);
    budget.remaining -= size;
    if (size < bytes.length) warnings.push("Recorded content is shortened by the display byte limits.");
    return bytes.subarray(0, size).toString("utf8") + (size < bytes.length ? "\n[display truncated]" : "");
  };
}

function exchange(events: SessionEvent[], row: z.infer<typeof SessionRow>, request: z.infer<typeof RequestRow>, warnings: string[], budget: {remaining: number}, seen: Map<string, RequestExchange>): RequestExchange[] {
  const text = redactor(events, warnings, budget);
  const transcript = new Map<number, SessionEventOf<"message">["data"]["message"]>();
  let boundary: SessionEventOf<"model_request"> | null = null;
  let snapshot: Array<{index: number; message: SessionEventOf<"message">["data"]["message"]}> = [];
  let boundaryPartial = false;
  const result: RequestExchange[] = [];
  const calls = (values: Array<{id: string; function: { name: string; arguments: string }}>) => values.slice(0, REQUEST_EVIDENCE_LIMITS.tools).map(call => ({ id: text(call.id), name: text(call.function.name), arguments: (() => { try { return text(JSON.parse(call.function.arguments)); } catch { return text(call.function.arguments); } })() }));
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    if (event.type === "message") {
      if (event.data.index >= REQUEST_EVIDENCE_LIMITS.transcriptSlots) { warnings.push("Transcript index exceeds replay limit."); continue; }
      for (const index of transcript.keys()) if (index >= event.data.index) transcript.delete(index);
      transcript.set(event.data.index, event.data.message);
    } else if (event.type === "model_request") {
      boundary = event; snapshot = []; boundaryPartial = false;
      const count = Math.min(event.data.messageCount, REQUEST_EVIDENCE_LIMITS.transcriptSlots);
      for (let index = 0; index < count; index++) {
        const message = transcript.get(index);
        if (!message) { boundaryPartial = true; continue; }
        if (snapshot.length >= REQUEST_EVIDENCE_LIMITS.messages) { boundaryPartial = true; break; }
        snapshot.push({ index, message });
      }
      if (count < event.data.messageCount) boundaryPartial = true;
    } else if (event.type === "model_error") {
      boundary = null;
    } else if (event.type === "model_response") {
      if (event.data.requestId !== request.id) { boundary = null; continue; }
      if (!boundary || boundary.data.executionId !== request.execution_id) { warnings.push(`${row.id}: exact response exists but preceding request boundary is unavailable.`); continue; }
      if (boundary.data.tools.length > REQUEST_EVIDENCE_LIMITS.tools || event.data.toolCalls.length > REQUEST_EVIDENCE_LIMITS.tools) warnings.push("Recorded tool list exceeds the display limit.");
      const end = events.findIndex((e, index) => index > i && ["model_request", "model_response", "model_error"].includes(e.type));
      const key = createHash("sha256").update(JSON.stringify({ parameters: boundary.data, input: snapshot, response: event.data, tools: events.slice(i + 1, end < 0 ? events.length : end).filter(e => ["tool_intent", "tool_outcome"].includes(e.type)).map(e => ({type:e.type,data:e.data})) })).digest("hex");
      const existing = seen.get(key);
      if (existing) { existing.sessions.push({sessionId:row.id, agent:row.agent_label, role:row.role}); boundary = null; continue; }
      const recordedResponse = { content: event.data.content === null ? null : text(event.data.content), finishReason: event.data.finishReason ? text(event.data.finishReason) : null, toolCalls: calls(event.data.toolCalls) };
      const allowed = new Map(event.data.toolCalls.map(call => [call.id, call.function.name]));
      const duplicateCalls = new Set(event.data.toolCalls.filter((call, index, all) => all.findIndex(other => other.id === call.id) !== index).map(call => call.id));
      if (duplicateCalls.size) { warnings.push("Duplicate response tool call IDs cannot prove action ownership."); for (const id of duplicateCalls) allowed.delete(id); }
      const actions: RequestExchange["actions"] = [];
      const intents = new Map<number, SessionEventOf<"tool_intent">>();
      for (let next = i + 1; next < events.length; next++) {
        const follow = events[next]!;
        if (["model_request", "model_response", "model_error"].includes(follow.type)) break;
        if (follow.type === "tool_intent" && allowed.get(follow.data.callId) === follow.data.name) {
          if (intents.size < REQUEST_EVIDENCE_LIMITS.tools) intents.set(follow.seq, follow);
        } else if (follow.type === "tool_outcome") {
          const intent = intents.get(follow.data.intentSeq);
          if (!intent || intent.data.callId !== follow.data.callId || intent.data.name !== follow.data.name) continue;
          const args = z.object({ path: z.string().max(2000).optional() }).safeParse(intent.data.args);
          const recordedFile = follow.data.ok && intent.data.sideEffect === "edit" && ["write_file", "replace_in_file", "delete_file"].includes(intent.data.name) && args.success ? args.data.path ?? null : null;
          actions.push({ callId: text(intent.data.callId), name: text(intent.data.name), sideEffect: intent.data.sideEffect, arguments: text(intent.data.args), outcome: text(follow.data.output), ok: follow.data.ok, truncated: follow.data.truncated, file: recordedFile ? text(recordedFile) : null });
          intents.delete(follow.data.intentSeq);
        }
      }
      for (const intent of intents.values()) actions.push({ callId: text(intent.data.callId), name: text(intent.data.name), sideEffect: intent.data.sideEffect, arguments: text(intent.data.args), outcome: null, ok: null, truncated: false, file: null });
      const projected: RequestExchange = { sessionId: row.id, agent: row.agent_label, role: row.role, sessions: [{sessionId:row.id,agent:row.agent_label,role:row.role}], requestSeq: boundary.seq, responseSeq: event.seq,
        parameters: { purpose: text(boundary.data.purpose), messageCount: boundary.data.messageCount, maxTokens: boundary.data.maxTokens, temperature: boundary.data.temperature, tools: boundary.data.tools.slice(0, REQUEST_EVIDENCE_LIMITS.tools).map(text), toolChoice: boundary.data.toolChoice ? text(boundary.data.toolChoice) : null, responseFormat: boundary.data.responseFormat ? text(boundary.data.responseFormat) : null },
        input: snapshot.map(({index,message}) => ({ index, role: message.role, content: message.content === null ? "" : text(message.content), ...(message.role === "tool" ? { toolCallId: text(message.tool_call_id) } : {}), toolCalls: message.role === "assistant" ? calls(message.tool_calls ?? []) : [] })), response: recordedResponse, actions: actions.slice(0, REQUEST_EVIDENCE_LIMITS.tools), partial: boundaryPartial };
      seen.set(key, projected); result.push(projected);
      boundary = null;
    }
  }
  return result;
}

/** Exact request-id journal correlation. Related task evidence is deliberately not causal. */
export function requestEvidence(sy: Switchyard, project: string, id: string): RequestEvidence | null {
  const parsed = RequestRow.safeParse(sy.db.prepare("SELECT id,execution_id,project_id,status FROM model_requests WHERE id=? AND project_id=?").get(id, project));
  if (!parsed.success) return null;
  const request = parsed.data, warnings: string[] = [], remaining = { bytes: REQUEST_EVIDENCE_LIMITS.totalJournalBytes };
  const participants = z.array(z.object({ project_id: z.string().nullable() })).parse(sy.db.prepare("SELECT DISTINCT t.project_id FROM request_charges c LEFT JOIN tasks t ON t.id=c.task_id WHERE c.request_id=?").all(id));
  const payloadAllowed = participants.length === 1 && participants[0]!.project_id === project;
  if (!payloadAllowed) warnings.push("Exchange payload withheld because participant project scope cannot be proven exclusive. Related evidence is limited to this project.");
  const sessions = sy.db.prepare(`SELECT DISTINCT s.id,s.agent_label,s.role,s.task_id FROM sessions s JOIN request_charges c ON c.task_id=s.task_id JOIN tasks t ON t.id=c.task_id WHERE c.request_id=? AND s.project_id=? AND t.project_id=? ORDER BY s.created_at DESC LIMIT ?`).all(id, project, project, REQUEST_EVIDENCE_LIMITS.sessions + 1).flatMap(row => { const parsed = SessionRow.safeParse(row); if (!parsed.success) warnings.push("Malformed session metadata omitted."); return parsed.success ? [parsed.data] : []; });
  if (sessions.length > REQUEST_EVIDENCE_LIMITS.sessions) warnings.push("Related session count exceeds the read limit.");
  const exchanges: RequestExchange[] = [];
  const commits = new Map<string, Array<{ repository: string; sha: string }>>();
  const displayBudget = { remaining: REQUEST_EVIDENCE_LIMITS.textBytes as number }, seen = new Map<string, RequestExchange>();
  for (const row of payloadAllowed ? sessions.slice(0, REQUEST_EVIDENCE_LIMITS.sessions) : []) {
    const events = journal(sy, row.id, remaining, warnings);
    exchanges.push(...exchange(events, row, request, warnings, displayBudget, seen));
    if (row.task_id) for (const event of events) if (event.type === "workspace") {
      commits.set(row.task_id, event.data.repos.slice(0, 20).flatMap(repo => /^[a-f0-9]{40,64}$/.test(repo.head ?? "") && Object.hasOwn(sy.projectContext(project).repositoryPaths, repo.alias) ? [{ repository: repo.alias, sha: repo.head! }] : []));
    }
  }
  const relatedTasks: RequestRelatedTask[] = [];
  const rows = sy.db.prepare("SELECT DISTINCT t.id,t.result_json FROM tasks t JOIN request_charges c ON c.task_id=t.id WHERE c.request_id=? AND t.project_id=? LIMIT ?").all(id, project, REQUEST_EVIDENCE_LIMITS.tasks) as Array<{ id: string; result_json: string | null }>;
  const display = redactor([], warnings, displayBudget);
  for (const row of rows) {
    let summary: string | null = null, changedPaths: string[] = [];
    try {
      if (row.result_json && Buffer.byteLength(row.result_json) <= 1024 * 1024) {
        const result = z.object({ summary: z.string().optional(), changedPaths: z.array(z.string()).optional() }).parse(JSON.parse(row.result_json));
        summary = result.summary ? display(result.summary) : null; changedPaths = (result.changedPaths ?? []).slice(0, REQUEST_EVIDENCE_LIMITS.files).map(display);
      } else if (row.result_json) warnings.push("Related task result exceeds the read limit.");
    } catch { warnings.push("Related task result is malformed; evidence omitted."); }
    const Artifact = z.object({ id: Id, kind: z.string().max(200), label: z.string().max(2000), bytes: z.number().nonnegative() });
    const artifacts = sy.db.prepare("SELECT id,kind,label,bytes FROM artifacts WHERE task_id=? ORDER BY created_at DESC LIMIT ?").all(row.id, REQUEST_EVIDENCE_LIMITS.artifacts).flatMap(raw => { const parsed = Artifact.safeParse(raw); if (!parsed.success) { warnings.push("Malformed related artifact metadata omitted."); return []; } return [{ ...parsed.data, label: display(parsed.data.label) }]; });
    relatedTasks.push({ taskId: row.id, summary, changedPaths, artifacts, commits: commits.get(row.id) ?? [] });
  }
  if (exchanges.length > 1) warnings.push("Multiple distinct recorded exchanges claim this request ID; inspect their session boundaries.");
  const partial = warnings.length > 0 || exchanges.some(e => e.partial);
  return { payloadScopeExclusive: payloadAllowed, state: exchanges.length ? partial ? "partial" : "available" : "unavailable",
    explanation: exchanges.length ? "Recorded logical model input and response, anchored by this exact response request ID. This is not the serialized provider HTTP body; tool definitions and provider transformations were not recorded. Historical in-place edits not emitted to the journal may be absent from this reconstruction. Shared batches may have the same exchange in several charged-task sessions." : "No complete exact request-ID exchange could be reconstructed. Failed endpoint attempts, external/direct requests or missing journals may have accounting records without recorded input/output. Related task evidence below is context, not sent data.",
    warnings: [...new Set(warnings)].slice(0, 12), exchanges: exchanges.slice(0, REQUEST_EVIDENCE_LIMITS.sessions), relatedTasks, limits: REQUEST_EVIDENCE_LIMITS };
}
