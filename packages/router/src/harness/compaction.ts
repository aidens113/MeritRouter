import type { ChatMessage } from "../gateway/types.js";
import { estimateTokens } from "../gateway/types.js";

/**
 * Prefix-stable context compaction for the agent loop.
 *
 * Providers cache the request prefix, so every rewrite of an early message makes the next
 * request pay for the whole conversation again. Compaction therefore happens rarely and in one
 * large batch: only when the conversation exceeds its budget, and then down to
 * `COMPACT_TARGET` of the budget, so the transcript must grow by half the budget again before
 * the prefix changes next. Old turns (an assistant message with its tool results and any
 * nudges after it) are replaced, as a contiguous run, by one summary message listing the tool
 * calls they made; the newest turn always stays. Only when the newest turn alone is too large
 * are its tool outputs stubbed.
 */

/** Compaction cuts the conversation to this share of the budget. */
export const COMPACT_TARGET = 0.5;
/** The summary message that stands in for compacted turns starts with this. */
export const COMPACTED_PREFIX = "[Context compacted:";
/** A stubbed tool output. */
export const ELIDED_OUTPUT = "[elided to fit context; call the tool again if needed]";
/** At most this many tool calls are listed in the summary (the newest are kept). */
const MAX_SUMMARY_CALLS = 60;
const MAX_ARGS_CHARS = 120;

function callLines(messages: readonly ChatMessage[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const c of m.tool_calls ?? []) {
      const args = c.function.arguments.replace(/\s+/g, " ");
      out.push(`- ${c.function.name}(${args.length > MAX_ARGS_CHARS ? `${args.slice(0, MAX_ARGS_CHARS)}...` : args})`);
    }
  }
  return out;
}

function summaryText(turns: number, lines: string[]): string {
  const kept = lines.slice(-MAX_SUMMARY_CALLS);
  const dropped = lines.length - kept.length;
  return [
    `${COMPACTED_PREFIX} ${turns} earlier turn(s) were removed to fit the context window. Their tool outputs are no longer shown; call a tool again if you need a result.]`,
    ...(lines.length ? ["Tool calls made in those turns:", ...(dropped > 0 ? [`- (${dropped} earlier call(s) not listed)`] : []), ...kept] : []),
  ].join("\n");
}

/** The calls listed in an earlier summary (to carry them into the next one) and its turn count. */
function parseSummary(m: ChatMessage | undefined): { turns: number; lines: string[] } | null {
  if (!m || m.role !== "user" || typeof m.content !== "string" || !m.content.startsWith(COMPACTED_PREFIX)) return null;
  const turns = Number(/^\[Context compacted: (\d+)/.exec(m.content)?.[1] ?? 0);
  return { turns, lines: m.content.split("\n").filter((l) => l.startsWith("- ") && !l.startsWith("- (")) };
}

/** Stub tool outputs, oldest first, until the conversation fits (the last resort). */
function stubOutputs(messages: ChatMessage[], maxInputTokens: number): boolean {
  let changed = false;
  for (const m of messages) {
    if (estimateTokens(messages) <= maxInputTokens) break;
    if (m.role === "tool" && m.content !== ELIDED_OUTPUT) {
      m.content = ELIDED_OUTPUT;
      changed = true;
    }
  }
  return changed;
}

/**
 * Fit the conversation into `maxInputTokens`, in place. Returns whether anything changed (the
 * cached prefix then breaks once). Does nothing while the conversation fits.
 */
export function compact(messages: ChatMessage[], maxInputTokens: number, opts: { target?: number } = {}): boolean {
  if (estimateTokens(messages) <= maxInputTokens) return false;
  const target = Math.floor(maxInputTokens * (opts.target ?? COMPACT_TARGET));
  const head = messages.findIndex((m) => m.role === "assistant");
  if (head < 0) return stubOutputs(messages, maxInputTokens);
  const starts: number[] = [];
  for (let i = head; i < messages.length; i++) if (messages[i]!.role === "assistant") starts.push(i);
  if (starts.length < 2) return stubOutputs(messages, maxInputTokens);

  // An earlier summary sits in the head (it precedes the first kept turn): fold it into the new one.
  const prevIndex = messages.slice(0, head).findIndex((m) => parseSummary(m) !== null);
  const prev = prevIndex >= 0 ? parseSummary(messages[prevIndex]) : null;
  const headMessages = messages.slice(0, head).filter((_, i) => i !== prevIndex);

  // The fewest oldest turns whose removal brings the conversation to the target (always keep the newest turn).
  let cut = starts.length - 1;
  for (let k = 1; k < starts.length; k++) {
    const removed = messages.slice(head, starts[k]);
    const trial = [...headMessages, { role: "user" as const, content: summaryText((prev?.turns ?? 0) + k, [...(prev?.lines ?? []), ...callLines(removed)]) }, ...messages.slice(starts[k])];
    if (estimateTokens(trial) <= target) {
      cut = k;
      break;
    }
  }
  const removed = messages.slice(head, starts[cut]);
  const summary: ChatMessage = { role: "user", content: summaryText((prev?.turns ?? 0) + cut, [...(prev?.lines ?? []), ...callLines(removed)]) };
  const next = [...headMessages, summary, ...messages.slice(starts[cut])];
  messages.splice(0, messages.length, ...next);
  stubOutputs(messages, maxInputTokens);
  return true;
}
