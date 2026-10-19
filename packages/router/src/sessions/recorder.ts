import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { immediate, type Db } from "../storage/db.js";
import type { ChatMessage, ChatRequest } from "../gateway/types.js";
import type { GateAttempt, GateResponse } from "../gateway/gate.js";
import {
  SessionEventSchema,
  TOOL_OUTPUT_CAP_BYTES,
  type SessionEndStatus,
  type SessionEventData,
  type SessionEventType,
  type SessionWorkspace,
  type ToolSideEffect,
} from "./events.js";

/** What `ask()` sends through the gate, minus routing details. */
export interface ModelRequestInput {
  executionId: string;
  purpose: string;
  chat: Omit<ChatRequest, "model">;
}

export interface ModelErrorInput {
  executionId: string;
  error: unknown;
  attempts?: GateAttempt[];
}

export interface ToolIntentInput {
  /** The model's tool call id (or a synthetic one). */
  callId: string;
  name: string;
  /** Parsed arguments (or the raw argument string when they did not parse). */
  args: unknown;
  sideEffect: ToolSideEffect;
  /** For `command` tools: safe to re-run on resume. Defaults to false. */
  idempotent?: boolean;
}

export interface ToolOutcomeInput {
  ok: boolean;
  /** Tool output; stored truncated to `TOOL_OUTPUT_CAP_BYTES`. */
  output: string;
}

interface IndexUpdate {
  name?: string | null;
  ok?: boolean | null;
  requests?: number;
  tools?: number;
  workspace?: SessionWorkspace;
  ended?: { status: SessionEndStatus; stopReason: string };
}

/** Cheap identity of a logged message; tool outputs are keyed by call id because compaction rewrites them in place. */
function fingerprint(m: ChatMessage): string {
  if (m.role === "tool") return `tool:${m.tool_call_id}`;
  if (m.role === "assistant") return `assistant:${(m.tool_calls ?? []).map((c) => c.id).join(",")}:${(m.content ?? "").slice(0, 200)}`;
  const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
  return `${m.role}:${c.length}:${c.slice(0, 200)}`;
}

function errorFields(err: unknown): { message: string; code: string | null; status: number | null } {
  const e = err as { message?: unknown; code?: unknown; status?: unknown } | null;
  return {
    message: e && typeof e.message === "string" ? e.message : String(err),
    code: e && typeof e.code === "string" ? e.code : null,
    status: e && typeof e.status === "number" ? e.status : null,
  };
}

function capOutput(output: string): { output: string; truncated: boolean } {
  const buf = Buffer.from(output, "utf8");
  if (buf.length <= TOOL_OUTPUT_CAP_BYTES) return { output, truncated: false };
  return { output: buf.subarray(0, TOOL_OUTPUT_CAP_BYTES).toString("utf8"), truncated: true };
}

/**
 * Appends events to one session's log. Each append writes one JSON line and fsyncs it, then
 * updates the `sessions` counters and inserts the `session_events` index row in one SQLite
 * transaction. A failure to record throws: the log is the record of truth.
 */
export class SessionRecorder {
  private seq: number;
  private endedSeq: number | null = null;
  private readonly logged: string[] = [];
  private readonly intents = new Map<number, { callId: string; name: string }>();

  constructor(
    readonly id: string,
    private readonly db: Db,
    /** Absolute path of the JSONL log. */
    readonly logPath: string,
    private readonly now: () => number,
    lastSeq = 0,
  ) {
    this.seq = lastSeq;
  }

  /** Sequence number of the last appended event (0 before any). */
  get lastSeq(): number {
    return this.seq;
  }

  get ended(): boolean {
    return this.endedSeq !== null;
  }

  /**
   * Log every transcript message not yet logged, by index. A message that differs from the one
   * logged at its index (the transcript was rewritten) is logged again from that index on.
   * Returns the transcript length.
   */
  syncMessages(messages: ChatMessage[]): number {
    let start = Math.min(messages.length, this.logged.length);
    for (let i = 0; i < start; i++) {
      if (fingerprint(messages[i]!) !== this.logged[i]) {
        start = i;
        break;
      }
    }
    if (start < this.logged.length) this.logged.length = start;
    for (let i = start; i < messages.length; i++) {
      const m = messages[i]!;
      this.append("message", { index: i, message: m }, { name: m.role });
      this.logged.push(fingerprint(m));
    }
    return messages.length;
  }

  modelRequest(req: ModelRequestInput): number {
    const c = req.chat;
    return this.append(
      "model_request",
      {
        executionId: req.executionId,
        purpose: req.purpose,
        messageCount: c.messages.length,
        maxTokens: c.max_tokens,
        temperature: c.temperature ?? null,
        tools: (c.tools ?? []).map((t) => t.function.name),
        toolChoice: c.tool_choice ?? null,
        responseFormat: c.response_format?.type ?? null,
      },
      { name: req.purpose, requests: 1 },
    );
  }

  modelResponse(res: GateResponse): number {
    const r = res.response;
    return this.append(
      "model_response",
      {
        requestId: res.requestId,
        endpointId: res.endpoint.id,
        content: r.message.content,
        toolCalls: r.message.tool_calls ?? [],
        finishReason: r.finishReason,
        usage: r.usage,
        servedModel: r.telemetry.servedModel,
        servedProvider: r.telemetry.servedProvider,
        attempts: res.attempts,
        estimatedInputTokens: res.estimatedInputTokens,
      },
      { name: res.endpoint.id, ok: true },
    );
  }

  modelError(input: ModelErrorInput): number {
    const f = errorFields(input.error);
    return this.append("model_error", { executionId: input.executionId, ...f, attempts: input.attempts ?? [] }, { name: f.code, ok: false });
  }

  /** Record a tool call before it runs. Returns the intent's sequence number for `toolOutcome`. */
  toolIntent(input: ToolIntentInput): number {
    const seq = this.append(
      "tool_intent",
      { callId: input.callId, name: input.name, args: input.args, sideEffect: input.sideEffect, idempotent: input.idempotent ?? false },
      { name: input.name, tools: 1 },
    );
    this.intents.set(seq, { callId: input.callId, name: input.name });
    return seq;
  }

  /** Record a tool call's result after it ran. */
  toolOutcome(intentSeq: number, input: ToolOutcomeInput): number {
    const intent = this.intents.get(intentSeq);
    if (!intent) throw new Error(`session ${this.id}: no tool intent at seq ${intentSeq}`);
    this.intents.delete(intentSeq);
    return this.append("tool_outcome", { intentSeq, callId: intent.callId, name: intent.name, ok: input.ok, ...capOutput(input.output) }, { name: intent.name, ok: input.ok });
  }

  note(text: string, data?: unknown): number {
    return this.append("note", data === undefined ? { text } : { text, data }, {});
  }

  setWorkspace(workspace: SessionWorkspace): number {
    return this.append("workspace", workspace, { workspace });
  }

  /** End the session. Calling it again is a no-op that returns the first `ended` event's seq. */
  end(status: SessionEndStatus, stopReason: string): number {
    if (this.endedSeq !== null) return this.endedSeq;
    const seq = this.append("ended", { status, stopReason }, { name: status, ended: { status, stopReason } });
    this.endedSeq = seq;
    return seq;
  }

  /** @internal Used by `SessionStore.create` for the `started` event. */
  append<T extends SessionEventType>(type: T, data: SessionEventData<T>, idx: IndexUpdate): number {
    if (this.endedSeq !== null) throw new Error(`session ${this.id} has ended`);
    const seq = this.seq + 1;
    const at = this.now();
    const event = SessionEventSchema.parse({ seq, at, type, data });
    const bytes = Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
    const fd = openSync(this.logPath, "a");
    try {
      let off = 0;
      while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // The line is durable: its seq is taken even if the index update below fails.
    this.seq = seq;
    immediate(this.db, () => {
      this.db
        .prepare("INSERT INTO session_events (session_id, seq, type, at, name, ok) VALUES (?, ?, ?, ?, ?, ?)")
        .run(this.id, seq, type, at, idx.name ?? null, idx.ok === undefined || idx.ok === null ? null : idx.ok ? 1 : 0);
      this.db
        .prepare(
          `UPDATE sessions SET last_seq = ?, updated_at = ?, model_requests = model_requests + ?, tool_calls = tool_calls + ?,
             workspace_json = COALESCE(?, workspace_json),
             status = COALESCE(?, status), stop_reason = COALESCE(?, stop_reason), ended_at = COALESCE(?, ended_at)
           WHERE id = ?`,
        )
        .run(seq, at, idx.requests ?? 0, idx.tools ?? 0, idx.workspace ? JSON.stringify(idx.workspace) : null, idx.ended?.status ?? null, idx.ended?.stopReason ?? null, idx.ended ? at : null, this.id);
    });
    return seq;
  }
}
