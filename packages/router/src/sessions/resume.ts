import { createHash } from "node:crypto";
import type { ChatMessage } from "../gateway/types.js";
import type { NotAppliedToolProof, RecoverEditsPolicy, ResumeAction, ResumeToolRef, SessionEvent, SessionEventOf, SessionWorkspace, ToolSideEffect } from "./events.js";

/**
 * Resume protocol (S2), as pure functions over a session's events: replay the transcript, find
 * tool intents that never got an outcome, and plan how to continue. The caller (executor,
 * runners) performs the plan's actions and records a `resumed` event; see `planResume`.
 */

/** A `tool_intent` with no `tool_outcome`, not superseded by a later intent for the same call, and not settled by a `resumed` event. */
export interface PendingIntent {
  seq: number;
  at: number;
  callId: string;
  name: string;
  args: unknown;
  sideEffect: ToolSideEffect;
  idempotent: boolean;
}

export interface TranscriptReplay {
  messages: ChatMessage[];
  /** Problems found while replaying (a gap left by a corrupt line, ...). */
  warnings: string[];
}

/** Tool-message texts a resume puts in the transcript for calls whose outcome is not known. */
export const RESUME_TEXT = {
  /** The call has no intent: it never started. */
  notRun: "interrupted before this call ran; call it again if it is still needed",
  /** `none` / `read`: safe to repeat. */
  retry: "interrupted; call again",
  /** Placeholder for a call an action covers; the caller replaces it with the action's result. */
  recovering: "interrupted; recovering",
  /** `command` not marked idempotent. */
  commandUnknown: "interrupted; outcome unknown: the command may or may not have run. Check its effects before running it again.",
  /** `brain`. */
  brainUnknown: "interrupted; outcome unknown; check the brain before repeating",
  /** `edit` with no recorded workspace to reconcile. */
  editUnknown: "interrupted; outcome unknown and no workspace is recorded to reconcile; re-read the files before editing again",
} as const;

/**
 * Replay `message` events: `transcript[index] = message`, dropping everything after `index` (a
 * later event for an index replaces the earlier one). A gap (an index past the end, left by a
 * corrupt line) is closed up and reported.
 */
export function replayTranscript(events: readonly SessionEvent[]): TranscriptReplay {
  const slots: Array<ChatMessage | undefined> = [];
  for (const e of events) {
    if (e.type !== "message") continue;
    slots.length = e.data.index;
    slots[e.data.index] = e.data.message as ChatMessage;
  }
  const messages: ChatMessage[] = [];
  const warnings: string[] = [];
  for (let i = 0; i < slots.length; i++) {
    const m = slots[i];
    if (m === undefined) warnings.push(`transcript gap: message ${i} is missing from the log`);
    else messages.push(m);
  }
  return { messages, warnings };
}

/** Intents with no outcome (see `PendingIntent`), oldest first. */
export function pendingIntentsFrom(events: readonly SessionEvent[]): PendingIntent[] {
  const open = new Map<number, PendingIntent>();
  const latestByCall = new Map<string, number>();
  for (const e of events) {
    if (e.type === "tool_intent") {
      const prev = latestByCall.get(e.data.callId);
      if (prev !== undefined) open.delete(prev); // a re-run supersedes the interrupted call
      latestByCall.set(e.data.callId, e.seq);
      open.set(e.seq, { seq: e.seq, at: e.at, callId: e.data.callId, name: e.data.name, args: e.data.args, sideEffect: e.data.sideEffect, idempotent: e.data.idempotent });
    } else if (e.type === "tool_outcome") {
      open.delete(e.data.intentSeq);
    } else if (e.type === "resumed") {
      for (const s of e.data.resolvedIntentSeqs) open.delete(s);
    }
  }
  return [...open.values()].sort((a, b) => a.seq - b.seq);
}

export interface PlanResumeOptions {
  /** Uncommitted changes left by an interrupted edit: commit them as "recovered" (default) or reset to the last committed head. */
  recoverEdits?: RecoverEditsPolicy;
  /** Why the session stopped, for the summary. Defaults to the last `ended` event's stop reason. */
  reason?: string;
}

export interface ResumePlan {
  /**
   * The transcript to continue from: the logged messages, plus the assistant message of a
   * response that was received but not yet logged, plus a tool message for every tool call of
   * the last assistant message that has none (the real output when its outcome was recorded,
   * otherwise the texts in `RESUME_TEXT`). Messages that actions cover hold `RESUME_TEXT.recovering`
   * at `action.messageIndex` (or `calls[].messageIndex`) until the caller replaces it.
   */
  messages: ChatMessage[];
  /** Work the caller must do before continuing, in order. */
  actions: ResumeAction[];
  /** What to tell the model; the caller appends it as a user message after the actions. */
  summary: string;
  /** Pending intents this plan settles; pass the plan to `recorder.resumed` so they stay settled. */
  resolvedIntentSeqs: number[];
  /** `model_request` events since the last resume with no response or error; dropped (their reservation already counts). */
  droppedRequestSeqs: number[];
  /** The last recorded workspace pointer. */
  workspace: SessionWorkspace | null;
  /** The reason used in the summary (null when unknown). */
  reason: string | null;
  /**
   * The endpoint that served the session's last recorded response: the continued run tries it
   * first while it is healthy, so the provider's prompt cache still holds the prefix. Null when
   * no response was recorded.
   */
  lastEndpointId: string | null;
  warnings: string[];
  /** Trusted proofs for exact never-run/reconciled occurrences; old plans may omit them. */
  notAppliedTools?: NotAppliedToolProof[];
  /** Pending edit intents whose recorded workspace HEAD never advanced since before the intent. */
  notAppliedCandidateIntents?: number[];
}

/** Bind retry authority to the entire exact transcript prefix, including this tool occurrence.
 * Reused call IDs or transcript compaction must never transfer a proof to a later applied call.
 */
export function notAppliedToolProof(messages: readonly ChatMessage[], messageIndex: number): NotAppliedToolProof | null {
  const message = messages[messageIndex];
  if (message?.role !== "tool") return null;
  return { messageIndex, callId: message.tool_call_id, transcriptSha256: createHash("sha256").update(JSON.stringify(messages.slice(0, messageIndex + 1))).digest("hex") };
}
export function validNotAppliedToolProof(messages: readonly ChatMessage[], proof: NotAppliedToolProof): boolean {
  const actual = notAppliedToolProof(messages, proof.messageIndex);
  return !!actual && actual.callId === proof.callId && actual.transcriptSha256 === proof.transcriptSha256;
}

/** The text to give the model for a reconciled edit, given the files the reconciliation found. */
export function editRecoveryMessage(policy: RecoverEditsPolicy, files: readonly string[]): string {
  if (files.length === 0) return "interrupted; no uncommitted changes were found, so the edit did not apply. Call it again if it is still needed.";
  const list = files.join(", ");
  return policy === "commit"
    ? `interrupted; the uncommitted changes (${list}) were committed as recovered. Re-read them before editing again.`
    : `interrupted; the uncommitted changes (${list}) were reset to the last commit. Re-apply the edit if it is still needed.`;
}

type Response = SessionEventOf<"model_response">;
type Intent = SessionEventOf<"tool_intent">;

function sameCalls(r: Response, ids: string[]): boolean {
  return r.data.toolCalls.length === ids.length && r.data.toolCalls.every((c, i) => c.id === ids[i]);
}

/**
 * Plan the resume of an interrupted session from its events (pure). Rules, for each tool call
 * whose outcome is not known:
 * - no intent (orphaned call): `RESUME_TEXT.notRun`;
 * - `none` / `read`: `RESUME_TEXT.retry`;
 * - `edit`: one `reconcile_edits` action over the workspace's repos (policy from options);
 *   without a recorded workspace, `RESUME_TEXT.editUnknown`;
 * - `delegate`: a `rerun_tool` action (idempotent by label);
 * - `command`: a `rerun_tool` action when `idempotent`, else `RESUME_TEXT.commandUnknown`;
 * - `brain`: `RESUME_TEXT.brainUnknown`;
 * - `external`: a `report_external` action (the stored question/answer state).
 * A `model_request` without a response is dropped. A tool call whose outcome was recorded but
 * whose tool message was not gets the recorded output.
 */
export function planResume(events: readonly SessionEvent[], opts: PlanResumeOptions = {}): ResumePlan {
  const policy = opts.recoverEdits ?? "commit";
  const { messages, warnings } = replayTranscript(events);

  let workspace: SessionWorkspace | null = null;
  let lastEnded: string | null = null;
  let lastRequest: SessionEventOf<"model_request"> | null = null;
  let lastResponseAfterRequest: Response | null = null;
  const responses: Response[] = [];
  const intents: Intent[] = [];
  const outcomes = new Map<number, SessionEventOf<"tool_outcome">>();
  const absenceProofs: NotAppliedToolProof[] = [];
  let unanswered: number[] = [];
  let openRequest: number | null = null;
  for (const e of events) {
    switch (e.type) {
      case "workspace":
        workspace = e.data;
        break;
      case "ended":
        lastEnded = e.data.stopReason;
        break;
      case "model_request":
        if (openRequest !== null) unanswered.push(openRequest);
        openRequest = e.seq;
        lastRequest = e;
        lastResponseAfterRequest = null;
        break;
      case "model_response":
        openRequest = null;
        responses.push(e);
        if (lastRequest) lastResponseAfterRequest = e;
        break;
      case "model_error":
        openRequest = null;
        break;
      case "tool_intent":
        intents.push(e);
        break;
      case "tool_outcome":
        outcomes.set(e.data.intentSeq, e);
        break;
      case "resumed":
        absenceProofs.push(...(e.data.notAppliedTools ?? []));
        unanswered = [];
        openRequest = null;
        break;
      default:
        break;
    }
  }
  if (openRequest !== null) unanswered.push(openRequest);

  // A response received but not logged as a transcript message yet (the loop logs a turn after its tools run).
  if (lastRequest && lastResponseAfterRequest && messages.length <= lastRequest.data.messageCount) {
    if (messages.length < lastRequest.data.messageCount) warnings.push(`transcript has ${messages.length} message(s) but the last request sent ${lastRequest.data.messageCount}`);
    const r = lastResponseAfterRequest.data;
    messages.push(r.toolCalls.length ? { role: "assistant", content: r.content, tool_calls: r.toolCalls } : { role: "assistant", content: r.content });
  }

  const actions: ResumeAction[] = [];
  const resolved: number[] = [];
  const lines: string[] = [];
  const handled = new Set<number>();
  const editCalls: ResumeToolRef[] = [];
  const completedEdits: string[] = [];
  const editRefs: Array<{ ref: ResumeToolRef; label: string }> = [];
  const notAppliedCandidateIntents: number[] = [];

  const settle = (p: PendingIntent, messageIndex: number | null): string => {
    handled.add(p.seq);
    resolved.push(p.seq);
    const ref: ResumeToolRef = { intentSeq: p.seq, callId: p.callId, name: p.name, args: p.args, messageIndex };
    const label = `${p.name} (call ${p.callId})`;
    switch (p.sideEffect) {
      case "none":
      case "read":
        lines.push(`- ${label}: ${RESUME_TEXT.retry}.`);
        return RESUME_TEXT.retry;
      case "edit":
        editRefs.push({ ref, label });
        return RESUME_TEXT.recovering;
      case "delegate":
        actions.push({ kind: "rerun_tool", sideEffect: "delegate", ...ref });
        lines.push(`- ${label}: interrupted; re-submitted (delegation is idempotent by label), see its result.`);
        return RESUME_TEXT.recovering;
      case "command":
        if (p.idempotent) {
          actions.push({ kind: "rerun_tool", sideEffect: "command", ...ref });
          lines.push(`- ${label}: interrupted; run again (idempotent), see its result.`);
          return RESUME_TEXT.recovering;
        }
        lines.push(`- ${label}: ${RESUME_TEXT.commandUnknown}`);
        return RESUME_TEXT.commandUnknown;
      case "brain":
        lines.push(`- ${label}: ${RESUME_TEXT.brainUnknown}.`);
        return RESUME_TEXT.brainUnknown;
      case "external":
        actions.push({ kind: "report_external", ...ref });
        lines.push(`- ${label}: interrupted; its stored state is reported in its result.`);
        return RESUME_TEXT.recovering;
    }
  };
  const toPending = (i: Intent): PendingIntent => ({ seq: i.seq, at: i.at, callId: i.data.callId, name: i.data.name, args: i.data.args, sideEffect: i.data.sideEffect, idempotent: i.data.idempotent });

  // The last assistant turn: every tool call gets a tool message.
  let tail = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "assistant") {
      tail = i;
      break;
    }
  }
  const tailMsg = tail >= 0 ? messages[tail] : undefined;
  if (tailMsg && tailMsg.role === "assistant" && tailMsg.tool_calls?.length && messages.slice(tail + 1).every((m) => m.role === "tool")) {
    const calls = tailMsg.tool_calls;
    const ids = calls.map((c) => c.id);
    const turn = [...responses].reverse().find((r) => sameCalls(r, ids));
    const turnSeq = turn?.seq ?? 0;
    const answered = new Set(messages.slice(tail + 1).map((m) => (m.role === "tool" ? m.tool_call_id : "")));
    for (const call of calls) {
      if (answered.has(call.id)) continue;
      const index = messages.length;
      let intent: Intent | undefined;
      for (const i of intents) if (i.seq > turnSeq && i.data.callId === call.id) intent = i;
      if (!intent) {
        lines.push(`- ${call.function.name} (call ${call.id}): ${RESUME_TEXT.notRun}.`);
        messages.push({ role: "tool", tool_call_id: call.id, content: RESUME_TEXT.notRun });
        const proof = notAppliedToolProof(messages, index);
        if (proof) absenceProofs.push(proof);
        continue;
      }
      const outcome = outcomes.get(intent.seq);
      if (outcome) {
        if (intent.data.sideEffect === "edit") completedEdits.push(call.id);
        const content = outcome.data.truncated ? `${outcome.data.output}\n[output truncated in the session log]` : outcome.data.output;
        messages.push({ role: "tool", tool_call_id: call.id, content });
        continue;
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: settle(toPending(intent), index) });
    }
  }

  // Pending intents with no slot in the transcript (an external agent's calls, a call id the transcript lacks).
  for (const p of pendingIntentsFrom(events)) if (!handled.has(p.seq)) settle(p, null);

  if (editRefs.length || completedEdits.length) {
    const repos = workspace?.repos ?? [];
    if (repos.length) {
      for (const { ref } of editRefs) editCalls.push(ref);
      notAppliedCandidateIntents.push(...editCalls.filter(call => {
        const before = [...events].reverse().find(event => event.type === "workspace" && event.seq < call.intentSeq);
        if (before?.type !== "workspace") return false;
        return repos.every(repo => {
          const prior = before.data.repos.find(candidate => candidate.alias === repo.alias && candidate.worktree === repo.worktree);
          if (!prior?.head || prior.head !== repo.head) return false;
          return events.filter(event => event.type === "workspace" && event.seq > call.intentSeq).every(event =>
            event.type === "workspace" && event.data.repos.some(candidate => candidate.alias === repo.alias && candidate.worktree === repo.worktree && candidate.head === prior.head));
        });
      }).map(call => call.intentSeq));
      actions.push({ kind: "reconcile_edits", policy, repos, calls: editCalls, completedCallIds: completedEdits });
      for (const { label } of editRefs) lines.push(`- ${label}: interrupted; uncommitted changes were ${policy === "commit" ? "committed as recovered" : "reset to the last commit"}, see its result.`);
      if (!editRefs.length) lines.push(`- Edits that finished before the interruption were not committed yet; they were ${policy === "commit" ? "committed as recovered" : "reset to the last commit"}.`);
    } else {
      if (editRefs.length) warnings.push("interrupted edits but no workspace recorded; nothing to reconcile");
      for (const { ref, label } of editRefs) {
        if (ref.messageIndex !== null) {
          const m = messages[ref.messageIndex];
          if (m && m.role === "tool") m.content = RESUME_TEXT.editUnknown;
        }
        lines.push(`- ${label}: ${RESUME_TEXT.editUnknown}.`);
      }
    }
  }

  const reason = opts.reason ?? lastEnded;
  const head = `This session was interrupted${reason ? ` (${reason})` : ""} and has been resumed from its log.`;
  const dropped = unanswered.length ? [`- The last model request got no response; it was dropped.`] : [];
  const body = [...dropped, ...lines];
  const summary = body.length ? `${head}\n${body.join("\n")}\nContinue from here.` : `${head} Nothing was in flight. Continue from here.`;

  const lastEndpointId = responses.length ? responses[responses.length - 1]!.data.endpointId : null;
  const notAppliedTools = [...new Map(absenceProofs.filter(proof => validNotAppliedToolProof(messages, proof)).map(proof => [proof.messageIndex, proof])).values()];
  return { messages, actions, summary, resolvedIntentSeqs: resolved.sort((a, b) => a - b), droppedRequestSeqs: unanswered, workspace, reason, lastEndpointId, warnings, ...(notAppliedTools.length ? { notAppliedTools } : {}), ...(notAppliedCandidateIntents.length ? { notAppliedCandidateIntents } : {}) };
}
