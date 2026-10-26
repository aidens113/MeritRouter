import { afterEach, expect, it, vi } from "vitest";
import { Brain } from "../src/brain/brain.js";
import { BrainAccess } from "../src/brain/access.js";
import { MemoryPreferences } from "../src/brain/preferences.js";
import { refreshMemoryMessages } from "../src/context/memory.js";
import type { MemoryManifest } from "../src/context/memory-manifest.js";
import { estimateTokens, type ChatMessage, type ChatTool } from "../src/gateway/types.js";
import type { GateResponse } from "../src/gateway/gate.js";
import type { ModelEndpoint } from "../src/models/catalog.js";
import { AdmissionDenied } from "../src/core/errors.js";
import * as requests from "../src/runners/types.js";
import { runAgentLoop } from "../src/harness/loop.js";
import type { HarnessEnv, HarnessTool } from "../src/harness/tools.js";
import { openDatabase } from "../src/storage/db.js";
import { makeEnv, endpoint, type Env } from "./helpers.js";

let env: Env | undefined, db: ReturnType<typeof openDatabase> | undefined;
afterEach(() => { vi.restoreAllMocks(); db?.close(); db = undefined; env?.cleanup(); env = undefined; });
const decision = "Repair retained actual candidate; do not recreate old source. ".repeat(60).trim();
const def = (name: string, description = "fixture"): ChatTool => ({ type: "function", function: { name, description, parameters: { type: "object", properties: {} } } });
function history(): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: "Supervisor charter" }, { role: "user", content: "Continue retained repair." }];
  for (let n = 0; n < 5; n++) {
    messages.push({ role: "assistant", content: null, tool_calls: [{ id: `old-${n}`, type: "function", function: { name: n === 0 ? "run_check" : "read_files", arguments: "{}" } }] });
    messages.push({ role: "tool", tool_call_id: `old-${n}`, content: "x".repeat(112_000) });
  }
  return messages;
}
async function setup() {
  env = makeEnv(); db = openDatabase(env.cfg.storageDir);
  const brain = new Brain(env.cfg, db), access = new BrainAccess(db, env.cfg);
  const principal = () => access.principalFor("supervisor", { project: "demo", effort: "effort", task: "task", jobId: "task", repos: [], tier: "T3" });
  const actor = { agent: "supervisor:task", role: "supervisor", task: "task" };
  const store = new MemoryPreferences(brain, () => null);
  await store.writeProject(principal(), actor, { id: "current-repair", kind: "decision", body: decision, source: { kind: "decision", ref: "task:retained" } }, null);
  const manifests: MemoryManifest[] = [], event = vi.fn();
  const small = endpoint({ gatewayModelId: "small", contextLimitTokens: 131_072 }) as unknown as ModelEndpoint;
  const large = endpoint({ gatewayModelId: "large", contextLimitTokens: 262_144 }) as unknown as ModelEndpoint;
  let used = 0;
  const harness = { role: "supervisor", brain: { brain, access, principal, actor, workingDoc: "projects/demo/working/effort.md" }, universe: { refs: new Map() }, edits: new Set(), ctx: {
    cfg: env.cfg, taskId: "task", profile: { ...env.cfg.profiles.inspect, mode: "supervisor", max_output_tokens: 8000 },
    budget: { maxModelRequests: 5, maxInputTokens: null, maxOutputTokens: null }, spec: { goal: "Continue retained repair", repositoryAliases: [] },
    plan: { candidates: [small, large], profile: "supervise", tier: "T3", paidPolicy: "never" }, brain, now: Date.now,
    signal: new AbortController().signal, taskLease: { taskId: "task", owner: "fixture", runCount: 1, project: "demo", incarnation: "a".repeat(32) },
    tasks: { db, dispatchable: () => true, event }, gate: { admission: { taskTotals: () => ({ requests: used }) } },
    artifacts: { writeJson: ({ value }: { value: MemoryManifest }) => { manifests.push(value); return "artifact:manifest"; } },
  } } as unknown as HarnessEnv;
  return { harness, manifests, brain, store, principal, actor, small, large, event, use: () => { used++; } };
}

it.each([false, true])("keeps fresh memory through actual loop compaction with fallback after larger sticky refusal=%s", async sticky => {
  const f = await setup(), original = history(), before = structuredClone(original);
  const read: HarnessTool = { def: def("read_files", "r".repeat(4000)), sideEffect: "read", run: async () => "unused" };
  const command: HarnessTool = { def: def("run_check"), sideEffect: "command", run: async () => "must not replay" };
  const terminal = { def: def("submit"), accept: async () => ({ ok: true as const, value: "done" }) };
  const defs = [read.def, command.def, terminal.def], maxTokens = 8000;
  if (!sticky) f.harness.ctx.plan.candidates = [f.small];
  expect(estimateTokens(original)).toBeGreaterThan(140_000);
  const messages = await refreshMemoryMessages(f.harness, original, { tools: defs, outputTokens: maxTokens, reservedTokens: 1000 });
  expect(original).toEqual(before);
  expect(f.event).not.toHaveBeenCalled();
  expect(messages.slice(0, original.length)).toEqual(original);
  expect(messages.some(m => typeof m.content === "string" && m.content.includes(decision))).toBe(true);
  expect(f.manifests.at(-1)).toMatchObject({ tokenBudget: 12000 });
  expect(f.manifests.at(-1)!.estimatedTokens).toBeLessThanOrEqual(12000);
  let attempts = 0;
  vi.spyOn(requests, "ask").mockImplementation(async (_ctx, req) => {
    attempts++;
    expect(req.chat.messages.some(m => typeof m.content === "string" && m.content.includes(decision))).toBe(true);
    if (sticky && attempts === 1) {
      expect(estimateTokens(req.chat.messages, defs) + maxTokens).toBeLessThanOrEqual(262144);
      throw new AdmissionDenied("context_does_not_fit", "large endpoint unavailable; refit fallback");
    }
    expect(estimateTokens(req.chat.messages, defs) + maxTokens + 1000).toBeLessThanOrEqual(131072);
    expect(JSON.stringify(req.chat.messages)).toContain("[Context compacted:");
    f.use();
    return { endpoint: f.small, requestId: "fixture-response", response: { message: { content: null, tool_calls: [{ id: "final", type: "function", function: { name: "submit", arguments: "{}" } }] }, finishReason: "tool_calls" } } as unknown as GateResponse;
  });
  const result = await runAgentLoop({ env: f.harness, executionId: "execution", messages, tools: [read, command], terminal, maxTokens,
    inputBudget: 131072 - maxTokens - estimateTokens([], defs) - 1000, maxInvalidTerminal: 2,
    resume: { plan: { messages, actions: [], summary: "Continue after interruption.", resolvedIntentSeqs: [], droppedRequestSeqs: [], workspace: null, reason: "interrupted", lastEndpointId: sticky ? f.large.id : null, warnings: [] }, actor: f.harness.brain!.actor, pointer: null },
  });
  expect(result.kind).toBe("terminal");
  expect(attempts).toBe(sticky ? 2 : 1);
  // Projection did not mutate effect evidence. Only the real loop recorded its later loss.
  expect(f.event).toHaveBeenCalledWith("task", "agent_effect_history_compacted", { schemaVersion: 1, executionId: "execution" });
  expect(original).toEqual(before);
});

it("refuses to invent room for an immovable head and emits a source-free omission without reading records", async () => {
  const f = await setup(), read = vi.spyOn(f.brain, "read");
  const original: ChatMessage[] = [{ role: "system", content: "x".repeat(600_000) }, { role: "user", content: "Continue retained repair" }];
  const before = structuredClone(original);
  const result = await refreshMemoryMessages(f.harness, original, { tools: [def("submit")], outputTokens: 8000, reservedTokens: 1000 });
  expect(result).toEqual(original); expect(original).toEqual(before);
  expect(f.manifests.at(-1)).toMatchObject({ tokenBudget: 0, entries: [], omissions: [{ ref: "context:memory", reason: expect.stringContaining("headroom") }] });
  expect(JSON.stringify(f.manifests.at(-1))).not.toContain("current-repair.md");
  expect(read).not.toHaveBeenCalled();
});

it("respects task input, actual tools/output and explicit memory caps despite reclaimable history", async () => {
  const f = await setup(); f.harness.ctx.budget.maxInputTokens = 12000;
  const tools = [def("read_files", "x".repeat(40_000))], pinned = structuredClone(tools), original = history();
  const result = await refreshMemoryMessages(f.harness, original, { tools, outputTokens: 4000, maxTokens: 700, reservedTokens: 1000 });
  expect(result).toEqual(original); expect(tools).toEqual(pinned);
  expect(f.manifests.at(-1)).toMatchObject({ tokenBudget: 0, entries: [], omissions: [expect.objectContaining({ ref: "context:memory" })] });
  f.harness.ctx.budget.maxInputTokens = 20000;
  await refreshMemoryMessages(f.harness, original, { tools: [def("submit")], outputTokens: 4000, maxTokens: 700, reservedTokens: 1000 });
  expect(f.manifests.at(-1)!.tokenBudget).toBeLessThanOrEqual(700);
});


it.each([false, true])("uses routed token units for full-role memory beside an immutable head (dense Unicode=%s)", async dense => {
  const f = await setup();
  for (let n = 0; n < 3; n++) await f.store.writeProject(f.principal(), f.actor, {
    id: `boundary-${n}`, kind: "decision", body: `retained repair boundary ${n} ` + (dense ? String.fromCodePoint(0x754c).repeat(6000) : "x".repeat(14000)),
    source: { kind: "decision", ref: "task:boundary" },
  }, null);
  const tools = [def("submit", "t".repeat(6000))], output = 8000, reserved = 1000;
  const headBudget = 131072 - output - reserved - 2000 - 12000 - estimateTokens([], tools);
  const original: ChatMessage[] = [{ role: "system", content: "h".repeat((headBudget - 20) * 3) }, { role: "user", content: "Continue retained repair." }];
  const before = structuredClone(original);
  const result = await refreshMemoryMessages(f.harness, original, { tools, outputTokens: output, reservedTokens: reserved });
  expect(original).toEqual(before);
  expect(f.manifests.at(-1)!.entries.length).toBeGreaterThan(0);
  if (dense) expect(result.some(m => typeof m.content === "string" && m.content.includes(String.fromCodePoint(0x754c)))).toBe(true);
  expect(f.manifests.at(-1)!.estimatedTokens).toBeLessThanOrEqual(12000);
  expect(estimateTokens(result, tools) + output + reserved).toBeLessThanOrEqual(131072);
});
