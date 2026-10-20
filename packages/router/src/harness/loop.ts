import type { ChatMessage, ChatTool, ChatToolCall } from "../gateway/types.js";
import { estimateTokens } from "../gateway/types.js";
import { AdmissionDenied } from "../core/errors.js";
import { ask } from "../runners/types.js";
import { availableTools, type HarnessEnv, type HarnessTool } from "./tools.js";
import { journaled, parseArgs } from "./journal.js";
import { applyResume, type ResumeInput } from "./resume.js";

export interface TerminalTool<T> {
  def: ChatTool;
  /** Validate the agent's final submission; errors go back to the agent. */
  accept(args: unknown, env: HarnessEnv): Promise<{ ok: true; value: T } | { ok: false; errors: string[] }>;
}

export interface ResponseInfo {
  endpointId: string;
  requestId: string;
  /** Files edited by tool calls in this response. */
  edits: string[];
}

export interface LoopOptions<T> {
  env: HarnessEnv;
  executionId: string;
  messages: ChatMessage[];
  tools: HarnessTool[];
  terminal: TerminalTool<T>;
  maxTokens: number;
  inputBudget: number;
  maxInvalidTerminal: number;
  /** Called after each response's tool calls ran (per-response commits). */
  onResponse?: (info: ResponseInfo) => Promise<void>;
  /**
   * Continue an interrupted session: `messages` is the plan's transcript, `env.ctx.session` the
   * reopened session. The plan is applied before the first request (see `applyResume`).
   */
  resume?: ResumeInput;
  purpose?: string;
}

export type LoopResult<T> =
  | { kind: "terminal"; value: T; messages: ChatMessage[] }
  | { kind: "budget_exhausted"; messages: ChatMessage[] }
  | { kind: "invalid_terminal"; errors: string[]; messages: ChatMessage[] };

/** Replace the oldest tool outputs with a stub until the conversation fits the budget. */
export function compact(messages: ChatMessage[], maxInputTokens: number): void {
  for (const m of messages) {
    if (estimateTokens(messages) <= maxInputTokens) return;
    if (m.role === "tool" && !m.content.startsWith("[elided")) m.content = "[elided to fit context; call the tool again if needed]";
  }
}

/**
 * One agent loop for every role. Each iteration is one admitted model request through the
 * gate; tool calls run with code-enforced limits; the loop ends when the terminal tool's
 * submission validates or the task's request budget runs out.
 */
export async function runAgentLoop<T>(o: LoopOptions<T>): Promise<LoopResult<T>> {
  const { env, messages } = o;
  const session = env.ctx.session;
  /** Log transcript messages the session has not seen (the next request would; the last turn has none). */
  const sync = () => session?.syncMessages(messages);
  // Tools this run may not have are neither offered nor run (a call to one is an unknown tool).
  const tools = availableTools(o.tools, env);
  const byName = new Map(tools.map((t) => [t.def.function.name, t]));
  const defs = [...tools.map((t) => t.def), o.terminal.def];
  const terminalName = o.terminal.def.function.name;
  let invalid = 0;
  let lastErrors: string[] = [];

  if (o.resume) {
    const r = await applyResume({ env, messages, tools, terminal: o.terminal }, o.resume);
    if (r.kind === "finished") {
      sync();
      return { kind: "terminal", value: r.value, messages };
    }
  }

  for (;;) {
    // Shutdown, cancellation, or deadline: stop before spending another request.
    if (env.ctx.signal.aborted) throw new Error(`aborted: ${String(env.ctx.signal.reason ?? "aborted")}`);
    const used = env.ctx.gate.admission.taskTotals(env.ctx.taskId).requests;
    const remaining = env.ctx.budget.maxModelRequests - used;
    if (remaining <= 0) {
      sync();
      return { kind: "budget_exhausted", messages };
    }
    if (remaining === 1) messages.push({ role: "user", content: `This is your final model request. Call ${terminalName} now with what you have; mark anything unverified as unknown.` });
    compact(messages, o.inputBudget);

    let response;
    let endpointId = "";
    let requestId = "";
    try {
      const res = await ask(env.ctx, {
        executionId: o.executionId,
        purpose: o.purpose ?? "agent_loop",
        chat: { messages, max_tokens: o.maxTokens, temperature: 0.2, tools: defs, tool_choice: remaining === 1 ? "required" : "auto" },
      });
      response = res.response;
      endpointId = res.endpoint.id;
      requestId = res.requestId;
    } catch (err) {
      if (err instanceof AdmissionDenied && err.reason === "task_request_budget_exhausted") {
        sync();
        return { kind: "budget_exhausted", messages };
      }
      throw err;
    }

    // Tools run on behalf of the model that produced this response: attribute their writes to it.
    if (env.brain) {
      env.brain.actor.model = endpointId;
      env.brain.actor.request = requestId;
    }
    const calls: ChatToolCall[] = response.message.tool_calls ?? [];
    messages.push({ role: "assistant", content: response.message.content, ...(calls.length ? { tool_calls: calls } : {}) });
    env.edits.clear();
    if (calls.length === 0) {
      messages.push({ role: "user", content: `Use the tools, then call ${terminalName}. Plain text answers are not accepted.` });
      sync();
      continue;
    }

    let finished: T | undefined;
    for (const call of calls) {
      const args = parseArgs(call.function.arguments);
      if (call.function.name === terminalName) {
        const r = await journaled(session, call, args, { sideEffect: "none" }, async () => {
          const v = args === undefined ? { ok: false as const, errors: [`${terminalName} arguments are not valid JSON`] } : await o.terminal.accept(args, env);
          if (v.ok) {
            finished = v.value;
            return { ok: true, output: "accepted" };
          }
          lastErrors = v.errors;
          invalid++;
          return { ok: false, output: `rejected:\n- ${v.errors.join("\n- ")}\nFix and call ${terminalName} again.` };
        });
        messages.push({ role: "tool", tool_call_id: call.id, content: r.output });
        continue;
      }
      const t = byName.get(call.function.name);
      const r = await journaled(session, call, args, t ? { sideEffect: t.sideEffect, idempotent: t.idempotent } : { sideEffect: "none" }, async () => {
        if (!t) return { ok: false, output: `error: unknown tool ${call.function.name}` };
        try {
          if (args === undefined) throw new Error(`${call.function.name} arguments are not valid JSON`);
          return { ok: true, output: await t.run(args as Record<string, unknown>, env) };
        } catch (err) {
          return { ok: false, output: `error: ${(err as Error).message}` };
        }
      });
      messages.push({ role: "tool", tool_call_id: call.id, content: r.output });
    }
    if (env.edits.size) await o.onResponse?.({ endpointId, requestId, edits: [...env.edits] });
    sync();
    if (finished !== undefined) return { kind: "terminal", value: finished, messages };
    if (invalid > o.maxInvalidTerminal) return { kind: "invalid_terminal", errors: lastErrors, messages };
  }
}
