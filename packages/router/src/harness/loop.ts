import type { ChatMessage, ChatTool, ChatToolCall } from "../gateway/types.js";
import { estimateTokens } from "../gateway/types.js";
import type { GateResponse } from "../gateway/gate.js";
import type { ModelEndpoint } from "../models/catalog.js";
import { AdmissionDenied } from "../core/errors.js";
import { ask } from "../runners/types.js";
import { availableTools, type HarnessEnv, type HarnessTool } from "./tools.js";
import { journaled, parseArgs } from "./journal.js";
import { applyResume, type ResumeInput } from "./resume.js";
import { compact } from "./compaction.js";

export { compact } from "./compaction.js";

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
  /**
   * Input budget that fits every fallback endpoint (the smallest context among them). While a
   * larger endpoint keeps serving the conversation, its own budget applies instead.
   */
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

/** Sent after a reply cut off at the output limit with no tool calls; the two parts are joined. */
export const CONTINUE_TEXT = "Your previous reply was cut off at the output limit. Continue exactly where you stopped: do not repeat anything already written, and end with the tool calls you meant to make.";

/** Headroom kept below an endpoint's context when the budget follows the serving endpoint. */
const BUDGET_MARGIN_TOKENS = 500;

/** The retry of a turn whose tool call was cut short: a larger output allowance, or another endpoint. */
interface TurnRetry {
  maxTokens: number;
  avoid: string[];
  /** The truncated response, used as is when no endpoint can take the retry. */
  fallback: GateResponse;
}

/**
 * One agent loop for every role. Each iteration is one admitted model request through the
 * gate; tool calls run with code-enforced limits; the loop ends when the terminal tool's
 * submission validates or the task's request budget runs out.
 *
 * Caching and continuity: every request names the endpoint that served the previous turn
 * (`preferEndpointId`, tried first while healthy) and a per-task cache key, and the transcript
 * only grows, except for rare batch compaction (see harness/compaction.ts). A reply cut off at
 * the output limit gets one continuation request (plain text) or one retry of the turn (a
 * truncated tool call: a larger `max_tokens` where the endpoint allows, otherwise another
 * endpoint); both are ordinary requests counted against the task's budget.
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
  const toolTokens = estimateTokens([], defs);
  const cacheKey = env.ctx.taskId;
  let invalid = 0;
  let lastErrors: string[] = [];
  let finalNotice = false;

  /** The input budget while `ep` serves: its own context, never less than the fallback budget. */
  const budgetFor = (ep: ModelEndpoint | undefined): number | null =>
    ep?.contextLimitTokens ? Math.max(o.inputBudget, ep.contextLimitTokens - o.maxTokens - toolTokens - BUDGET_MARGIN_TOKENS) : null;

  // The endpoint that served the last turn (a resumed session's last recorded response at first).
  let sticky: string | null = o.resume?.plan.lastEndpointId ?? null;
  let servingBudget = budgetFor(env.ctx.plan.candidates.find((c) => c.id === sticky));
  // Per-turn recovery state: at most one continuation and one truncated-call retry per turn.
  let continued: ChatMessage | null = null;
  let continuedThisTurn = false;
  let retry: TurnRetry | null = null;
  let retriedThisTurn = false;

  if (o.resume) {
    const r = await applyResume({ env, messages, tools, terminal: o.terminal }, o.resume);
    if (r.kind === "finished") {
      sync();
      return { kind: "terminal", value: r.value, messages };
    }
  }

  // Progress guards (live 2026-10-21: coding workers spent whole budgets reading and searching):
  // a coding run that has edited nothing by half its requests is told to write now, and an exact
  // repeat of an earlier read is marked as such.
  const canEdit = byName.has("write_file");
  const runStart = env.ctx.gate.admission.taskTotals(env.ctx.taskId).requests;
  const allowance = env.ctx.budget.maxModelRequests - runStart;
  let edited = false;
  let stallNudged = false;
  const seenCalls = new Map<string, number>();

  for (;;) {
    // Shutdown, cancellation, or deadline: stop before spending another request.
    if (env.ctx.signal.aborted) throw new Error(`aborted: ${String(env.ctx.signal.reason ?? "aborted")}`);
    const used = env.ctx.gate.admission.taskTotals(env.ctx.taskId).requests;
    const remaining = env.ctx.budget.maxModelRequests - used;
    if (canEdit && !edited && !stallNudged && allowance >= 4 && used - runStart >= Math.ceil(allowance / 2) && remaining > 1) {
      stallNudged = true;
      messages.push({
        role: "user",
        content: `You have used ${used - runStart} of ${allowance} requests and have not changed any file yet. Write your implementation now with write_file. If something you depend on does not exist yet (another task's module or interface), define the smallest version you need yourself, state that assumption in your result, and continue; do not search for it again.`,
      });
    }
    if (remaining <= 0) {
      sync();
      return { kind: "budget_exhausted", messages };
    }
    if (remaining === 1 && !finalNotice) {
      finalNotice = true;
      messages.push({ role: "user", content: `This is your final model request. Call ${terminalName} now with what you have; mark anything unverified as unknown.` });
    }
    const budget = servingBudget ?? o.inputBudget;
    compact(messages, budget);

    const pending: TurnRetry | null = retry;
    retry = null;
    let res: GateResponse;
    try {
      res = await ask(env.ctx, {
        executionId: o.executionId,
        purpose: o.purpose ?? "agent_loop",
        // The final request offers only the terminal tool: a model told to submit still called
        // other tools (live 2026-10-21), and some providers ignore tool_choice.
        chat: { messages, max_tokens: pending?.maxTokens ?? o.maxTokens, temperature: 0.2, tools: remaining === 1 ? [o.terminal.def] : defs, tool_choice: remaining === 1 ? "required" : "auto" },
        preferEndpointId: sticky,
        cacheKey,
        ...(pending?.avoid.length ? { avoidEndpointIds: pending.avoid } : {}),
      });
    } catch (err) {
      if (err instanceof AdmissionDenied && err.reason === "task_request_budget_exhausted") {
        sync();
        return { kind: "budget_exhausted", messages };
      }
      // Grown to the serving endpoint's context, and nothing that size is available now: fit the fallback budget.
      if (err instanceof AdmissionDenied && err.reason === "context_does_not_fit" && budget > o.inputBudget) {
        servingBudget = null;
        if (pending) retry = pending;
        continue;
      }
      // No endpoint could take the retry of a cut-short turn: keep the truncated response as it is.
      if (pending && err instanceof AdmissionDenied) res = pending.fallback;
      else throw err;
    }
    const endpointId = res.endpoint.id;
    const requestId = res.requestId;
    sticky = endpointId;
    servingBudget = budgetFor(res.endpoint);

    // Tools run on behalf of the model that produced this response: attribute their writes to it.
    if (env.brain) {
      env.brain.actor.model = endpointId;
      env.brain.actor.request = requestId;
    }
    const response = res.response;
    let content = response.message.content;
    let calls: ChatToolCall[] = response.message.tool_calls ?? [];

    // The answer to a continuation request: join it to the reply it continues.
    if (continued) {
      const at = messages.indexOf(continued);
      const before = continued.role === "assistant" ? (continued.content ?? "") : "";
      if (at >= 0) messages.splice(at);
      content = `${before}${content ?? ""}` || null;
      continued = null;
    } else if (response.finishReason === "length" && res !== pending?.fallback) {
      const broken = calls.some((c) => parseArgs(c.function.arguments) === undefined);
      // A tool call (or the whole reply) cut short: retry the turn once without keeping the broken reply.
      if ((broken || (!calls.length && !content)) && !retriedThisTurn) {
        const next = turnRetry(res, estimateTokens(messages, defs), o.maxTokens, env.ctx.plan.candidates);
        if (next) {
          retriedThisTurn = true;
          retry = next;
          continue;
        }
      } else if (!calls.length && content && !continuedThisTurn) {
        // Plain text cut short: ask the same endpoint to continue it.
        continuedThisTurn = true;
        const partial: ChatMessage = { role: "assistant", content };
        continued = partial;
        messages.push(partial, { role: "user", content: CONTINUE_TEXT });
        continue;
      }
    }

    messages.push({ role: "assistant", content, ...(calls.length ? { tool_calls: calls } : {}) });
    continuedThisTurn = false;
    retriedThisTurn = false;
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
      if (r.ok && t?.sideEffect === "edit") edited = true;
      // An exact repeat of an earlier read: the answer cannot have changed unless a file was edited since.
      let output = r.output;
      if (t && t.sideEffect !== "edit" && args !== undefined) {
        const key = `${call.function.name} ${JSON.stringify(args)}`;
        const n = (seenCalls.get(key) ?? 0) + 1;
        seenCalls.set(key, n);
        if (n > 1) output += `\n[You made this exact ${call.function.name} call ${n} times; the result is the same. Use it and move on.]`;
      }
      if (t?.sideEffect === "edit" && r.ok) seenCalls.clear();
      messages.push({ role: "tool", tool_call_id: call.id, content: output });
    }
    if (env.edits.size) await o.onResponse?.({ endpointId, requestId, edits: [...env.edits] });
    sync();
    if (finished !== undefined) return { kind: "terminal", value: finished, messages };
    if (invalid > o.maxInvalidTerminal) return { kind: "invalid_terminal", errors: lastErrors, messages };
  }
}

/**
 * How to retry a turn whose reply was cut short: twice the output allowance on the same
 * endpoint when its output limit and context allow more than now, otherwise the same allowance
 * on any other candidate. Null when neither is possible (the truncated reply is then kept).
 */
export function turnRetry(res: GateResponse, inputTokens: number, maxTokens: number, candidates: readonly ModelEndpoint[]): TurnRetry | null {
  const ep = res.endpoint;
  const room = Math.min(ep.outputLimitTokens ?? maxTokens, (ep.contextLimitTokens ?? Infinity) - inputTokens);
  const larger = Math.min(maxTokens * 2, room);
  if (larger > maxTokens) return { maxTokens: larger, avoid: [], fallback: res };
  if (candidates.some((c) => c.id !== ep.id)) return { maxTokens, avoid: [ep.id], fallback: res };
  return null;
}
