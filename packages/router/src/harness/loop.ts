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
import { RepeatObservations, type RepeatOutcome } from "./repeat-policy.js";
import { assertRunAuthority } from "./task-authority.js";

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
  | { kind: "stalled"; reason: string; messages: ChatMessage[] }
  | { kind: "invalid_terminal"; errors: string[]; messages: ChatMessage[] };

/** Sent after a reply cut off at the output limit with no tool calls; the two parts are joined. */
export const CONTINUE_TEXT = "Your previous reply was cut off at the output limit. Continue exactly where you stopped: do not repeat anything already written, and end with the tool calls you meant to make.";

/** Headroom kept below an endpoint's context when the budget follows the serving endpoint. */
const BUDGET_MARGIN_TOKENS = 500;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

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
  assertRunAuthority(env.ctx);
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

  let notAppliedToolIndexes: ReadonlySet<number> = new Set();
  if (o.resume) {
    const r = await applyResume({ env, messages, tools, terminal: o.terminal }, o.resume);
    assertRunAuthority(env.ctx);
    if (r.kind === "finished") {
      sync();
      return { kind: "terminal", value: r.value, messages };
    }
    notAppliedToolIndexes = r.notAppliedToolIndexes;
  }

  // Progress guards (live 2026-10-21: coding workers spent whole budgets reading and searching):
  // a coding run that has edited nothing by half its requests is told to write now. One exact
  // repeated observation is always fresh; three unchanged observations stop a stalled run.
  const canEdit = byName.has("write_file");
  const runStart = env.ctx.gate.admission.taskTotals(env.ctx.taskId).requests;
  const allowance = env.ctx.budget.maxModelRequests - runStart;
  let edited = false;
  let stallNudged = false;
  const effects = new Map<string, RepeatOutcome>();
  const observations = new RepeatObservations();
  // Restore completed/uncertain effect protection across resume. Fresh reads start a new
  // observation window; pending effects remain governed by applyResume's reconciliation.
  if (o.resume) {
    const calls = new Map<string, ChatToolCall>();
    for (const [messageIndex, message] of messages.entries()) {
      if (message.role === "assistant") for (const call of message.tool_calls ?? []) calls.set(call.id, call);
      if (message.role !== "tool") continue;
      const call = calls.get(message.tool_call_id);
      const tool = call && byName.get(call.function.name);
      const args = call && parseArgs(call.function.arguments);
      if (!call || !tool || args === undefined || tool.sideEffect === "read" || tool.sideEffect === "none") continue;
      if (notAppliedToolIndexes?.has(messageIndex)) continue;
      const behavior = typeof tool.repeatBehavior === "function" ? tool.repeatBehavior(args as Record<string, unknown>) : tool.repeatBehavior;
      if (behavior) continue;
      const ok = !String(message.content).startsWith("error:");
      if (ok && tool.sideEffect === "edit") {
        for (const key of effects.keys()) {
          if (byName.get(key.slice(0, key.indexOf(" ")))?.sideEffect === "edit") effects.delete(key);
        }
      }
      effects.set(`${call.function.name} ${canonicalJson(args)}`, { ok, output: String(message.content) });
    }
  }
  // Budget control: a worker that may ask for more is told once when it runs low (again after a grant).
  const canAsk = byName.has("request_more_budget");
  let lowNoticeAt: number | null = null;
  let cap = env.ctx.budget.maxModelRequests;

  for (;;) {
    // Shutdown, cancellation, or deadline: stop before spending another request.
    if (env.ctx.signal.aborted) throw new Error(`aborted: ${String(env.ctx.signal.reason ?? "aborted")}`);
    const used = env.ctx.gate.admission.taskTotals(env.ctx.taskId).requests;
    const remaining = env.ctx.budget.maxModelRequests - used;
    if (env.ctx.budget.maxModelRequests > cap) {
      // An approved request for more raised the cap during this run.
      cap = env.ctx.budget.maxModelRequests;
      finalNotice = false;
      lowNoticeAt = null;
    }
    const lowMark = Math.max(2, Math.ceil(allowance / 10));
    if (canAsk && allowance >= 6 && lowNoticeAt === null && remaining > 1 && remaining <= lowMark) {
      lowNoticeAt = used;
      messages.push({ role: "user", content: `You have ${remaining} model requests left. If they will not finish the brief, call request_more_budget now with how many more you need and why; otherwise finish and call ${terminalName}.` });
    }
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
    let repeatedToolCall: string | null = null;
    const executeCall = async (call: ChatToolCall, args: unknown, t: HarnessTool | undefined, previous?: RepeatOutcome): Promise<RepeatOutcome> => {
      assertRunAuthority(env.ctx);
      return journaled(session, call, args, t ? { sideEffect: t.sideEffect, idempotent: t.idempotent } : { sideEffect: "none" }, async () => {
        if (!t) return { ok: false, output: `error: unknown or unavailable tool ${call.function.name}` };
        if (previous) return { ok: false, output: `the exact call already ran; MeritRouter did not repeat it to avoid duplicating its side effect. Its previous outcome was: ${previous.output}` };
        try {
          if (args === undefined) throw new Error(`${call.function.name} arguments are not valid JSON`);
          const invocationEnv = { ...env, toolInvocationId: `${session?.id ?? o.executionId}:${call.id}` };
          const output = await t.run(args as Record<string, unknown>, invocationEnv);
          return { ok: t.outputSucceeded?.(output) ?? true, output };
        } catch (err) {
          if (env.ctx.signal.aborted) throw err;
          return { ok: false, output: `error: ${(err as Error).message}` };
        }
      });
    };
    // Only repository observations can be coalesced. Waits, cancellation, approvals,
    // commands and every mutation remain ordering barriers, even when called read-only.
    const pureReads = new Set(["read_files", "list_paths", "search_text", "git_status", "git_diff", "read_output_page", "read_file", "list_files", "search"]);
    const prefetched = new Map<ChatToolCall, RepeatOutcome>();
    for (const [callIndex, call] of calls.entries()) {
      assertRunAuthority(env.ctx);
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
      // The final request offers only the terminal tool, even if a provider invents others.
      const t = remaining === 1 ? undefined : byName.get(call.function.name);
      const signature = t && args !== undefined
        ? `${call.function.name} ${canonicalJson(args)}` : null;
      const behavior = t && args !== undefined
        ? typeof t.repeatBehavior === "function" ? t.repeatBehavior(args as Record<string, unknown>) : t.repeatBehavior
        : undefined;
      const fresh = !!t && (t.sideEffect === "read" || t.sideEffect === "none" || !!behavior);
      const previous = signature && !fresh ? effects.get(signature) : undefined;
      if (!prefetched.has(call) && remaining !== 1 && t?.sideEffect === "read" && pureReads.has(call.function.name)) {
        const group: ChatToolCall[] = [];
        for (let index = callIndex; index < calls.length && group.length < 4; index++) {
          const candidate = calls[index]!;
          if (byName.get(candidate.function.name)?.sideEffect !== "read" || !pureReads.has(candidate.function.name)) break;
          group.push(candidate);
        }
        // Quiesce all started reads before propagating cancellation or a simulated crash.
        const outcomes = await Promise.allSettled(group.map(async candidate => {
          const value = await executeCall(candidate, parseArgs(candidate.function.arguments), byName.get(candidate.function.name));
          prefetched.set(candidate, value);
        }));
        for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
      }
      const r = prefetched.get(call) ?? await executeCall(call, args, t, previous);
      if (r.ok && t?.sideEffect === "edit") edited = true;
      let output = r.output;
      if (previous) {
        output += `\n[Repeated identical effect. No action was repeated; the task is stopping for reconciliation.]`;
        repeatedToolCall ??= call.function.name;
      } else if (signature && fresh && (behavior !== "execute" || !r.ok)) {
        const state = observations.observe(signature, { ...r, output: t?.observationOutput?.(r.output) ?? r.output });
        if (state.warn) output += `\n[Repeated identical observation. The tool ran freshly but returned unchanged state; repeating it again will stop the task unless state changes.]`;
        if (state.stalled) {
          output += `\n[Three fresh observations returned unchanged state. The task is stopping because no progress was observed.]`;
          repeatedToolCall ??= call.function.name;
        }
      } else if (signature && !fresh) {
        // Even an error may have happened after an effect. Never blindly retry it.
        if (r.ok && t?.sideEffect === "edit") {
          // A different successful edit changes the workspace revision. An earlier edit
          // may now be intentional again (A -> B -> A), while its immediate repeat is not.
          for (const key of effects.keys()) {
            const name = key.slice(0, key.indexOf(" "));
            if (byName.get(name)?.sideEffect === "edit") effects.delete(key);
          }
        }
        effects.set(signature, r);
      }
      if (!previous && r.ok && t && behavior !== "observe" && t.sideEffect !== "read" && t.sideEffect !== "none") {
        observations.progress();
        // A successful edit, install, or service lifecycle operation can change what a
        // prior command observes. Keep the current command protected against an immediate
        // duplicate, but permit check -> repair/install/restart -> same check.
        for (const key of effects.keys()) {
          if (key === signature) continue;
          const name = key.slice(0, key.indexOf(" "));
          if (byName.get(name)?.sideEffect === "command") effects.delete(key);
        }
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: output });
    }
    assertRunAuthority(env.ctx);
    if (env.edits.size) await o.onResponse?.({ endpointId, requestId, edits: [...env.edits] });
    sync();
    if (finished !== undefined) return { kind: "terminal", value: finished, messages };
    if (repeatedToolCall) return { kind: "stalled", reason: `repeated_tool_call:${repeatedToolCall}`, messages };
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
