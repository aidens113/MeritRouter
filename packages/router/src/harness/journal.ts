import type { ChatToolCall } from "../gateway/types.js";
import type { SessionRecorder } from "../sessions/recorder.js";
import type { ToolSideEffect } from "../sessions/events.js";
import { faultPoint } from "../core/faults.js";

/** Parse a tool call's arguments; undefined when they are not valid JSON. */
export function parseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return undefined;
  }
}

/**
 * Run one tool call under the session's tool journal: the intent is durable before the tool
 * runs, the outcome after. Without a session the call just runs. A resume re-runs a call under
 * its original call id, so a crash during recovery re-plans from the re-run instead of
 * repeating it again.
 */
export async function journaled(
  session: SessionRecorder | null,
  call: Pick<ChatToolCall, "id"> & { function: Pick<ChatToolCall["function"], "name" | "arguments"> },
  args: unknown,
  effect: { sideEffect: ToolSideEffect; idempotent?: boolean | undefined },
  run: () => Promise<{ ok: boolean; output: string }>,
): Promise<{ ok: boolean; output: string }> {
  const name = call.function.name;
  const intent = session?.toolIntent({
    callId: call.id,
    name,
    args: args === undefined ? call.function.arguments : args,
    sideEffect: effect.sideEffect,
    ...(effect.idempotent !== undefined ? { idempotent: effect.idempotent } : {}),
  });
  faultPoint("after_tool_intent", name);
  const r = await run();
  faultPoint("after_tool_run", name);
  if (session && intent !== undefined) session.toolOutcome(intent, r);
  return r;
}
