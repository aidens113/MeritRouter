import { randomUUID } from "node:crypto";
import type { HarnessEnv } from "./tools.js";
import { OperationResultSchema, type OperationDefinition, type OperationResult } from "./operation-contract.js";
import { boundedOutput } from "./output-pages.js";
import { isSimulatedCrash } from "../core/faults.js";
import { assertRunAuthority } from "./task-authority.js";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { SessionEventSchema } from "../sessions/events.js";
import { z } from "zod";
interface OperationState {
  result: OperationResult | null;
  controller: AbortController;
}
const states = new WeakMap<object, Map<string, OperationState>>();
function stateMap(env: HarnessEnv) {
  let map = states.get(env.ctx.tasks); if (!map) {
    map = new Map();
    states.set(env.ctx.tasks, map);
  } return map;
}
const OperationNote = z.object({ kind: z.literal("harness_v2_operation"), taskId: z.string(), operationId: z.string(), sideEffect: z.string(), result: OperationResultSchema.optional() });
export async function operationStatus(env: HarnessEnv, id: string) {
  const live = stateMap(env).get(`${env.ctx.taskId}:${id}`);
  if (live)
    return live.result ?? { operationId: id, status: "running" };
  const session = env.ctx.session;
  if (!session?.logPath)
    return { operationId: id, status: "unknown" };
  let recovered: z.infer<typeof OperationNote> | undefined;
  const stream = createReadStream(session.logPath, { encoding: "utf8", signal: env.ctx.signal }), lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let input: unknown;
      try {
        input = JSON.parse(line);
      }
      catch {
        continue;
      }
      const event = SessionEventSchema.safeParse(input);
      if (!event.success || event.data.type !== "note")
        continue;
      const note = OperationNote.safeParse(event.data.data.data);
      if (note.success && note.data.taskId === env.ctx.taskId && note.data.operationId === id)
        recovered = note.data;
    }
  }
  finally {
    lines.close();
    stream.destroy();
  }
  return recovered?.result ?? { operationId: id, status: recovered ? (recovered.sideEffect === "read" ? "interrupted" : "unknown_effect") : "unknown", diagnostics: recovered ? ["Recovered intent without confirmed outcome; do not replay effects automatically."] : [] };
}
export function cancelOperation(env: HarnessEnv, id: string) {
  const state = stateMap(env).get(`${env.ctx.taskId}:${id}`); if (!state)
    return { status: "unknown" }; state.controller.abort(new Error("operation cancelled")); return { status: state.result?.status ?? "cancellation_requested", operationId: id };
}
/** Await real completion after abort, never release effects through Promise.race. */
export async function executeOperation(def: OperationDefinition, input: Record<string, unknown>, env: HarnessEnv): Promise<OperationResult> {
  const started = Date.now(), id = env.toolInvocationId ?? randomUUID(), controller = new AbortController(), key = `${env.ctx.taskId}:${id}`;
  const parsed = def.args.safeParse(input);
  if (!parsed.success)
    return OperationResultSchema.parse({ version: "2", operationId: id, status: "failed", durationMs: Date.now() - started, diagnostics: [`Invalid ${def.name} arguments: ${parsed.error.message}`, `Expected schema is advertised by ${def.name}; no operation executed.`] });
  const signal = AbortSignal.any([env.ctx.signal, controller.signal]);
  const row = env.ctx.tasks.get(env.ctx.taskId)?.row;
  if(row?.deadline_at!=null&&env.ctx.now()>=row.deadline_at)return {version:"2",operationId:id,status:"denied",durationMs:Date.now()-started,diagnostics:["Task deadline already expired; no operation executed."]};
  const remaining = row?.deadline_at == null ? Infinity : Math.max(1, row.deadline_at - env.ctx.now());
  const timeout = Math.min(Number(parsed.data.timeout_ms ?? 30000), 300000, remaining);
  const timer = setTimeout(() => controller.abort(new Error("operation timeout")), timeout);
  timer.unref?.();
  const state: OperationState = { controller, result: null };
  stateMap(env).set(key, state);
  env.ctx.session?.note?.("Harness v2 operation started", { kind: "harness_v2_operation", taskId: env.ctx.taskId, operationId: id, sideEffect: def.sideEffect });
  const child: HarnessEnv = { ...env, ctx: { ...env.ctx, signal }, toolInvocationId: id };
  let result: OperationResult;
  try {
    assertRunAuthority(child.ctx);
    if (def.available && !def.available(env))
      throw new Error("Operation unavailable under current role/capabilities");
    const data = await def.run(parsed.data, child);
    const status = typeof data === "object" && data !== null && "status" in data ? (data as {
      status: unknown;
    }).status : null;
    result = { version: "2", operationId: id, status: signal.aborted ? (def.sideEffect === "read" ? (env.ctx.signal.aborted ? "cancelled" : "timed_out") : "unknown_effect") : status === "partial" ? "unknown_effect" : status === "failed" ? "failed" : status === "waiting_approval" ? "waiting_approval" : "succeeded", durationMs: Date.now() - started, data: boundedOutput(data, env), diagnostics: signal.aborted ? [String(signal.reason??"cancelled after partial work")] : [] };
  }
  catch (error) {
    if (isSimulatedCrash(error))
      throw error;
    const message = (error as Error).message ?? String(error);
    result = { version: "2", operationId: id, status: signal.aborted ? (def.sideEffect === "read" ? (env.ctx.signal.aborted ? "cancelled" : "timed_out") : "unknown_effect") : "failed", durationMs: Date.now() - started, diagnostics: [message] };
  }
  finally {
    clearTimeout(timer);
  }
  const alias=typeof parsed.data.alias==="string"?parsed.data.alias:env.workspace?.alias??(env.readers.size===1?env.readers.keys().next().value:undefined);
  const reader=alias?env.readers.get(alias):undefined;
  state.result = OperationResultSchema.parse({...result,...(reader?{workspace:{alias:reader.alias,revision:reader.commit,mode:reader.commit?"pinned":"worktree"}}:{})});
  const { data: _data, ...summary } = state.result;
  env.ctx.session?.note?.("Harness v2 operation settled", { kind: "harness_v2_operation", taskId: env.ctx.taskId, operationId: id, sideEffect: def.sideEffect, result: summary });
  // Retain only bounded recent status records. Artifacts/session journal remain durable.
  const map = stateMap(env);
  if (map.size > 256) {
    for (const [k, v] of map) {
      if (v.result && k !== key) {
        map.delete(k);
        if (map.size <= 256)
          break;
      }
    }
  }
  return state.result;
}
