import { afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RepoReader } from "../src/context/repo-reader.js";
import { repositoryOperations } from "../src/harness/repository-operations.js";
import { harnessV2StartupContext, harnessV2Tools } from "../src/harness/operation-dispatch.js";
import { runAgentLoop, type LoopOptions } from "../src/harness/loop.js";
import { submitResultTool } from "../src/harness/worker.js";
import { checkEvidenceRef } from "../src/core/worker-output.js";
import type { WorkerTask } from "../src/core/task.js";
import type { HarnessEnv } from "../src/harness/tools.js";
import type { ChatRequest, ChatToolCall } from "../src/gateway/types.js";
import type { GateResponse } from "../src/gateway/gate.js";
import { makeEnv, type Env } from "./helpers.js";

const mocks = vi.hoisted(() => ({ ask: vi.fn() }));
vi.mock("../src/runners/types.js", () => ({ ask: mocks.ask }));
const fixtures: Env[] = [];
afterEach(() => { vi.clearAllMocks(); for (const f of fixtures.splice(0)) f.cleanup(); });
const call = (name: string, args: unknown = {}, id = name): ChatToolCall => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
function fixture() {
  const source = makeEnv({ files: { "src/a.txt": "first\r\nsecond\r\n" } }); fixtures.push(source);
  const env = {
    ctx: { taskId: "task", taskProject: "demo", signal: new AbortController().signal, now: Date.now,
      taskLease: { taskId: "task", owner: "owner", runCount: 1, incarnation: "a".repeat(32), project: "demo" },
      tasks: { dispatchable: () => true, get: () => ({ row: { deadline_at: null } }) },
      cfg: source.cfg, spec: { profile: "implement", context: {} }, plan: { candidates: [] },
      session: null, budget: { maxModelRequests: 6 } },
    role: "implementer", readers: new Map([["core", new RepoReader("core", source.repo, null)]]),
    workspace: { alias: "core", root: source.repo, allowedPaths: ["src/**"] },
    universe: { refs: new Map() }, edits: new Set(), allowArtifacts: true,
  } as unknown as HarnessEnv;
  return { source, env };
}
function loop(env: HarnessEnv, turns: ChatToolCall[][], limit = 6) {
  let used = 0;
  const offered: ChatRequest[] = [];
  env.ctx.budget.maxModelRequests = limit;
  // ask is mocked above; the loop only consumes admission's request counter.
  env.ctx.gate = { admission: { taskTotals: () => ({ requests: used }) } } as unknown as HarnessEnv["ctx"]["gate"];
  mocks.ask.mockImplementation(async (_ctx, req: { chat: ChatRequest }) => {
    offered.push(structuredClone(req.chat));
    return { endpoint: { id: "fixture" }, requestId: String(used), response: { message: { content: null, tool_calls: turns[used++] ?? [call("submit")] }, finishReason: "tool_calls" } } as unknown as GateResponse;
  });
  const options: LoopOptions<string> = { env, executionId: "execution", messages: [], tools: harnessV2Tools(env),
    terminal: { def: { type: "function", function: { name: "submit", description: "finish", parameters: { type: "object" } } }, accept: async () => ({ ok: true, value: "done" }) },
    maxTokens: 1000, inputBudget: 10000, maxInvalidTerminal: 1 };
  return { options, offered };
}

it("returns qualified partial and pinned read refs accepted by the real result validator", async () => {
  const { source, env } = fixture();
  const other = makeEnv({ files: { "src/a.txt": "other\n" } }); fixtures.push(other);
  env.readers.set("other", new RepoReader("other", other.repo, null));
  const read = repositoryOperations().find(op => op.name === "read_files")!;
  const run = (alias: string, start_line = 2, end_line = 2) => read.run(read.args.parse({ alias, files: [{ path: "src/a.txt", start_line, end_line }] }), env) as Promise<Array<{ ref: string; revision?: string; text: string }>>;
  const [partial] = await run("core");
  expect(partial!.ref).toBe("core:src/a.txt#L2-L2");
  const terminal = submitResultTool({ constraints: { acceptanceCriteria: ["read"] } } as WorkerTask, env.universe);
  const output = (ref: string) => ({ summary: "read", findings: [], criteria: [{ index: 0, status: "met", evidenceRefs: [ref] }] });
  expect((await terminal.accept(output(partial!.ref), env)).ok).toBe(true);
  expect((await terminal.accept(output("src/a.txt"), env)).ok).toBe(false);
  expect((await terminal.accept(output("unknown:src/a.txt"), env)).ok).toBe(false);
  expect(checkEvidenceRef("core:src/a.txt#L200-L201", env.universe)).toMatch(/past the end/);
  expect((await run("other", 1, 1))[0]!.ref).toBe("other:src/a.txt#L1-L1");
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: source.repo, encoding: "utf8" }).trim();
  env.readers.set("core", new RepoReader("core", source.repo, sha));
  writeFileSync(path.join(source.repo, "src/a.txt"), "changed\n");
  const [pinned] = await run("core");
  expect(pinned).toMatchObject({ ref: "core:src/a.txt#L2-L2", revision: sha });
  expect(pinned!.text).toContain("second");
  expect(checkEvidenceRef((await run("core", 100, 101))[0]!.ref, env.universe)).toBeNull();
});

it("recognizes actual batched edits on a v2-only surface without a false no-edit nudge", async () => {
  const { source, env } = fixture();
  const create = { items: [{ id: "edit", operation: "apply_edits", args: { edits: [{ action: "create", path: "src/new.ts", content: "export const done = true;\n" }] } }] };
  const { options, offered } = loop(env, [[call("batch", create)], [call("workspace_info")], [call("list_paths")], [call("submit")]]);
  expect((await runAgentLoop(options)).kind).toBe("terminal");
  expect(readFileSync(path.join(source.repo, "src/new.ts"), "utf8")).toContain("done = true");
  expect(offered.at(-1)!.messages.some(m => m.role === "user" && String(m.content).includes("have not changed any file yet"))).toBe(false);
});

it.each(["read-only", "rejected-edit"])("does not count a %s batch as implementation progress", async kind => {
  const { env } = fixture();
  const item = kind === "read-only" ? { id: "observe", operation: "workspace_info", args: {} }
    : { id: "reject", operation: "apply_edits", args: { edits: [{ action: "patch", path: "src/a.txt", expected_sha256: "0".repeat(64), old_text: "first", new_text: "wrong" }] } };
  const { options, offered } = loop(env, [[call("batch", { items: [item] })], [call("workspace_info")], [call("list_paths")], [call("submit")]]);
  expect((await runAgentLoop(options)).kind).toBe("terminal");
  const nudge = offered.at(-1)!.messages.find(m => m.role === "user" && String(m.content).includes("have not changed any file yet"));
  expect(nudge?.content).toContain("apply_edits");
  expect(nudge?.content).not.toContain("write_file");
  expect(nudge?.content).toContain("respect file ownership");
  expect(env.edits.size).toBe(0);
});

it.each(["apply_edits", "batch"])("retains actual edit progress when %s partially applies then fails", async name => {
  const { source, env } = fixture();
  let laterChecks = 0;
  env.workspace!.guard = rel => rel === "src/later.ts" && ++laterChecks >= 2 ? "later effect refused" : null;
  const editArgs = { edits: [
    { action: "create", path: "src/first.ts", content: "export const retained = true;\n" },
    { action: "create", path: "src/later.ts", content: "must not appear\n" },
  ] };
  const args = name === "batch" ? { items: [{ id: "partial", operation: "apply_edits", args: editArgs }] } : editArgs;
  const { options, offered } = loop(env, [[call(name, args)], [call("workspace_info")], [call("list_paths")], [call("submit")]]);
  expect((await runAgentLoop(options)).kind).toBe("terminal");
  expect(readFileSync(path.join(source.repo, "src/first.ts"), "utf8")).toContain("retained = true");
  expect(options.messages.find(m => m.role === "tool")?.content).toContain("partial");
  expect(offered.at(-1)!.messages.some(m => m.role === "user" && String(m.content).includes("have not changed any file yet"))).toBe(false);
});

it("explains final-turn tool refusal without executing the invented effect", async () => {
  const { env } = fixture();
  const { options, offered } = loop(env, [[call("apply_edits", { edits: [{ action: "create", path: "src/refused.ts", content: "no" }] })]], 1);
  const result = await runAgentLoop(options);
  expect(result.kind).toBe("budget_exhausted");
  expect(offered[0]!.tools!.map(t => t.function.name)).toEqual(["submit"]);
  expect(result.messages.find(m => m.role === "tool")?.content).toContain("final model request is submission-only");
  expect(env.edits.size).toBe(0);
});

it("reports configured command defaults separately from the unchanged read/edit default", () => {
  const { env } = fixture();
  env.ctx.cfg.execution.check_timeout_seconds = 600;
  const context = harnessV2StartupContext(env);
  const facts = JSON.parse(context.split("Startup workspace facts: ")[1]!);
  expect(facts).toMatchObject({ defaultTimeoutMs: 30000, commandTimeoutMs: 300000, maximumTimeoutMs: 300000 });
  expect(context).toContain("Explicit shorter ancestor budgets");
  expect(context).not.toContain("timeout_ms defaults to30000 and can be increased");
});
