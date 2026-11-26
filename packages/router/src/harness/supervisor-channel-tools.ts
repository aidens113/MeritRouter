/**
 * Always-on worker tools over the supervisor offload channel (core/channel.ts,
 * storage/supervisor-channel.ts; supervisor-offload Phase 1 contracts): `ask_supervisor`,
 * `request_tools`, `report_blocked` (each posts a request and waits for the reply without
 * spending a model request: watchdog-exempt by name, core/watchdog.ts WATCHDOG_EXEMPT_TOOLS),
 * and `reply_supervisor` (answers a supervisor probe by message id).
 *
 * Only offered when `ctx.channel` is set (core/channel.ts SupervisorChannelService): a legacy
 * task with no channel wiring sees none of these, so its behaviour is unchanged.
 */
import { z } from "zod";
import type { ChannelAwaitOutcome } from "../core/channel.js";
import { CHANNEL_MESSAGE_MAX_BODY_CHARS, toolRefs } from "../core/channel.js";
import { KNOWN_WORKER_TOOLS } from "../core/brief.js";
import type { HarnessEnv, HarnessTool } from "./tools.js";

function def(name: string, description: string, properties: Record<string, unknown>, required: string[]) {
  return { type: "function" as const, function: { name, description, parameters: { type: "object", properties, required } } };
}

/** How long a channel wait may run: the project's configured human/supervisor wait, capped and defaulted sensibly. */
function waitMs(env: HarnessEnv, requestedSeconds: unknown): number {
  const capSeconds = env.ctx.cfg.team.budget_request_wait_seconds;
  const requested = typeof requestedSeconds === "number" && Number.isFinite(requestedSeconds) ? requestedSeconds : Math.min(capSeconds, 120);
  return Math.max(1, Math.min(requested, capSeconds)) * 1000;
}

function renderOutcome(outcome: ChannelAwaitOutcome): string {
  if (outcome.status === "answered") {
    return JSON.stringify({ status: "answered", kind: outcome.reply.kind, body: outcome.reply.body, refs: outcome.reply.refs ?? [] });
  }
  if (outcome.status === "timeout") return JSON.stringify({ status: "timeout", guidance: outcome.guidance });
  return JSON.stringify({ status: "expired", note: "the supervisor's wait for an answer to this ended before one arrived; proceed on your own judgment or report blocked." });
}

const TIMEOUT_PROPERTY = { timeout_seconds: { type: "integer", minimum: 1, description: "How long to wait for a reply before giving up (default and max: the project's configured wait)." } };

function requestTool(
  name: string,
  kind: "question" | "tool_request" | "help" | "blocked",
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  body: (a: Record<string, unknown>) => string,
  refs?: (a: Record<string, unknown>) => string[],
): HarnessTool {
  return {
    def: def(name, description, { ...properties, ...TIMEOUT_PROPERTY }, required),
    sideEffect: "external",
    available: (env) => !!env.ctx.channel,
    run: async (a, env) => {
      const channel = env.ctx.channel;
      if (!channel) throw new Error("no supervisor channel is available for this task");
      const msg = await channel.postFromWorker({
        taskId: env.ctx.taskId,
        kind,
        body: body(a),
        ...(refs ? { refs: refs(a) } : {}),
        idempotencyKey: env.toolInvocationId,
      });
      const outcome = await channel.awaitReply(msg.id, waitMs(env, a.timeout_seconds), env.ctx.signal);
      return renderOutcome(outcome);
    },
  };
}

const questionText = (a: Record<string, unknown>) => z.string().trim().min(1).max(CHANNEL_MESSAGE_MAX_BODY_CHARS).parse(a.question);
const reasonText = (a: Record<string, unknown>) => z.string().trim().min(1).max(CHANNEL_MESSAGE_MAX_BODY_CHARS).parse(a.reason);

function toolGrantRefs(a: Record<string, unknown>): string[] {
  const names = z.array(z.string().min(1)).min(1).max(20).parse(a.tools);
  const unknown = names.filter((n) => !KNOWN_WORKER_TOOLS.has(n));
  if (unknown.length) throw new Error(`not a worker tool: ${unknown.join(", ")}`);
  return toolRefs(names);
}

function askSupervisorTool(): HarnessTool {
  return requestTool(
    "ask_supervisor",
    "question",
    "Ask your supervisor a question and wait for its answer. Waiting here does not spend a model request; use this before guessing at anything the brief leaves ambiguous.",
    { question: { type: "string" } },
    ["question"],
    questionText,
  );
}

function requestToolsTool(): HarnessTool {
  return requestTool(
    "request_tools",
    "tool_request",
    "Ask your supervisor to grant tools you were not given, with a reason. A granted tool becomes available starting your next turn; waiting here does not spend a model request.",
    { tools: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20, description: "Tool names you need." }, reason: { type: "string" } },
    ["tools", "reason"],
    reasonText,
    toolGrantRefs,
  );
}

function reportBlockedTool(): HarnessTool {
  return requestTool(
    "report_blocked",
    "blocked",
    "Tell your supervisor you are blocked and why, then wait for guidance. Use this instead of guessing past a missing dependency, an unresolvable conflict, or scope you cannot complete. Waiting here does not spend a model request.",
    { reason: { type: "string" } },
    ["reason"],
    reasonText,
  );
}

function replySupervisorTool(): HarnessTool {
  return {
    def: def(
      "reply_supervisor",
      "Answer your supervisor's probe (a question it sent about your work) by the probe's message id. Only a pending probe for your own task can be answered this way.",
      { message_id: { type: "string" }, answer: { type: "string" } },
      ["message_id", "answer"],
    ),
    sideEffect: "external",
    available: (env) => !!env.ctx.channel,
    run: async (a, env) => {
      const channel = env.ctx.channel;
      if (!channel) throw new Error("no supervisor channel is available for this task");
      const messageId = z.string().min(1).parse(a.message_id);
      const answer = z.string().trim().min(1).max(CHANNEL_MESSAGE_MAX_BODY_CHARS).parse(a.answer);
      // RunContext.channel is the worker's own side of the channel (core/channel-service.ts
      // RunChannel): replyFromWorker is this worker answering a supervisor probe, with lease
      // and ownership checks already enforced there.
      const reply = await channel.replyFromWorker({ messageId, kind: "answer", body: answer });
      return JSON.stringify({ status: "answered", messageId: reply.id });
    },
  };
}

/** The four always-on supervisor-channel tools (core/brief.ts ALWAYS_ON_WORKER_TOOLS minus submit_result). */
export function supervisorChannelTools(): HarnessTool[] {
  return [askSupervisorTool(), requestToolsTool(), reportBlockedTool(), replySupervisorTool()];
}
