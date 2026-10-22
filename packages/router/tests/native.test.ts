import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Switchyard } from "../src/core/service.js";
import { createCodingRunner } from "../src/runners/coding/index.js";
import { blame } from "../src/attribution/index.js";
import { GatewayError } from "../src/core/errors.js";
import type { ChatRequest } from "../src/gateway/types.js";
import { baseConfig, endpoint, goodOutput, makeEnv, open, reply, ScriptedClient, servedFor, type Env } from "./helpers.js";

const agent = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-agent.mjs");
let env: Env | undefined;
let sy: Switchyard | undefined;
afterEach(async () => {
  await sy?.close();
  sy = undefined;
  env?.cleanup();
});

const check = `node -e "process.exit(require('fs').readFileSync('src/app.ts','utf8').includes('subtract')?0:1)"`;
const task = (o: Record<string, unknown> = {}) => ({
  profile: "implement",
  label: "add-subtract",
  goal: "Add subtract() to src/app.ts",
  repositoryAliases: ["core"],
  writableRepository: "core",
  hints: { difficulty: "T2" },
  constraints: { acceptanceCriteria: ["subtract exists"], allowedPaths: ["src/**"], checks: [check] },
  ...o,
});
const call = (name: string, args: unknown, id = "c1") => [{ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }];
const toolCount = (req: ChatRequest) => req.messages.filter((m) => m.role === "tool").length;
const worktreeOf = (taskId: string) => (sy!.db.prepare("SELECT worktree_path FROM workspaces WHERE task_id = ?").get(taskId) as { worktree_path: string }).worktree_path;
const submit = () => call("submit_result", goodOutput(1, "core:src/app.ts#L1-L3"), "s1");

describe("native coding worker", () => {
  it("confines edits to allowedPaths, commits each editing response as the agent and model, and passes checks", async () => {
    env = makeEnv({ config: baseConfig({ coding: { runner: "native" } }) });
    const client = new ScriptedClient((req) => {
      const s = servedFor(sy!, req);
      const n = toolCount(req);
      if (n === 0) return reply(null, { ...s, toolCalls: call("read_file", { alias: "core", path: "src/app.ts" }) });
      if (n === 1) return reply(null, { ...s, toolCalls: [...call("replace_in_file", { path: "src/app.ts", old_text: "  return a + b;\n}\n", new_text: "  return a + b;\n}\n\nexport function subtract(a: number, b: number) {\n  return a - b;\n}\n" }, "e1"), ...call("write_file", { path: "README.md", content: "hijacked" }, "e2")] });
      return reply(null, { ...s, toolCalls: submit() });
    });
    sy = open(env, client, { worker: true, coding: createCodingRunner(env.cfg) });
    const [sub] = await sy.submitTasks([task()]);
    const r = (await sy.awaitResults([sub!.taskId], { timeoutSeconds: 60 })).completed[0]!;
    expect(r.acceptanceStatus).toBe("met");
    expect(r.checks[0]!.exitCode).toBe(0);
    const wt = worktreeOf(sub!.taskId);
    expect(readFileSync(path.join(wt, "README.md"), "utf8")).toContain("A tiny fixture repository");
    const refused = client.requests[2]!.messages.find((m) => m.role === "tool" && m.content.includes("outside allowedPaths"));
    expect(refused).toBeDefined();
    const lines = await blame(wt, "src/app.ts");
    const added = lines.filter((l) => l.text.includes("subtract") || l.text.includes("a - b"));
    expect(added.every((l) => l.agent === "implementer:add-subtract" && l.model === "openrouter/vendor/big-a:free" && l.task === sub!.taskId)).toBe(true);
    expect(lines[0]!.role).toBe("human");
    expect(execFileSync("git", ["log", "--format=%an", "-1"], { cwd: wt }).toString()).toMatch(/^implementer add-subtract \(openrouter\/vendor\/big-a:free\)/);
  }, 90_000);

  it("attributes lines to each model when a task falls back mid-way", async () => {
    env = makeEnv({
      config: baseConfig({ coding: { runner: "native" } }),
      // A 429 cools that provider's key, so the fallback model is on another provider.
      endpoints: [endpoint({ gatewayModelId: "first", totalParametersB: 120 }), endpoint({ providerId: "groq", gatewayModelId: "second", totalParametersB: 200 })],
    });
    let firstCalls = 0;
    const client = new ScriptedClient((req) => {
      const s = servedFor(sy!, req);
      const n = toolCount(req);
      if (s.model === "first") {
        firstCalls++;
        if (firstCalls > 1) throw new GatewayError("rate_limited", "429", 429, 1000, false);
      }
      if (n === 0) return reply(null, { ...s, toolCalls: call("replace_in_file", { path: "src/app.ts", old_text: "return a + b;", new_text: "return a + b; // by first" }) });
      if (n === 1) return reply(null, { ...s, toolCalls: call("replace_in_file", { path: "src/app.ts", old_text: "export function add", new_text: "export function subtract(a: number, b: number) { return a - b; } // by second\nexport function add" }) });
      return reply(null, { ...s, toolCalls: submit() });
    });
    sy = open(env, client, { worker: true, coding: createCodingRunner(env.cfg) });
    const [sub] = await sy.submitTasks([task()]);
    await sy.awaitResults([sub!.taskId], { timeoutSeconds: 60 });
    const lines = await blame(worktreeOf(sub!.taskId), "src/app.ts");
    expect(lines.find((l) => l.text.includes("by first"))!.model).toBe("openrouter/first");
    expect(lines.find((l) => l.text.includes("by second"))!.model).toBe("groq/second");
  }, 90_000);

  it("external agents get per-response attribution through the job gateway", async () => {
    env = makeEnv({ config: baseConfig({ coding: { runner: "command", command: `node "${agent}" good` } }) });
    sy = open(env, new ScriptedClient((req) => reply(JSON.stringify(goodOutput()), servedFor(sy!, req))), { worker: true, coding: createCodingRunner(env.cfg) });
    const [sub] = await sy.submitTasks([task()]);
    const r = (await sy.awaitResults([sub!.taskId], { timeoutSeconds: 60 })).completed[0]!;
    expect(r.acceptanceStatus).toBe("met");
    const lines = await blame(worktreeOf(sub!.taskId), "src/app.ts");
    expect(lines.find((l) => l.text.includes("subtract"))!.model).toBe("openrouter/vendor/big-a:free");
  }, 90_000);

  it("writes each worker's report into the brain", async () => {
    env = makeEnv({ config: baseConfig({ coding: { runner: "native" } }) });
    const client = new ScriptedClient((req) => {
      const s = servedFor(sy!, req);
      return toolCount(req) === 0
        ? reply(null, { ...s, toolCalls: call("write_file", { path: "src/sub.ts", content: "export const subtract = (a: number, b: number) => a - b;\n" }) })
        : reply(null, { ...s, toolCalls: submit() });
    });
    sy = open(env, client, { worker: true, coding: createCodingRunner(env.cfg) });
    const [sub] = await sy.submitTasks([task({ constraints: { acceptanceCriteria: ["x"], allowedPaths: ["src/**"] } })]);
    await sy.awaitResults([sub!.taskId], { timeoutSeconds: 60 });
    await sy.close();
    sy = undefined;
    const report = readFileSync(path.join(env.dir, "brain/projects/demo/working/adhoc/reports/add-subtract.md"), "utf8");
    expect(report).toMatch(/^# Report: add-subtract/);
    expect(report).toMatch(/## Not verified/);
  }, 90_000);

  it("an escalation after a spent budget continues the unfinished work; an empty listing says so plainly", async () => {
    env = makeEnv({ config: baseConfig({ coding: { runner: "native" } }) });
    const NOTE = "previous attempt's unfinished work";
    const client = new ScriptedClient((req) => {
      const s = servedFor(sy!, req);
      const n = toolCount(req);
      const continuing = req.messages.some((m) => m.role === "user" && typeof m.content === "string" && m.content.includes(NOTE));
      if (!continuing) {
        // First attempt: write a file, then keep looking around until its budget (T2: 8) is spent.
        if (n === 0) return reply(null, { ...s, toolCalls: call("write_file", { path: "src/sub.ts", content: "export const subtract = (a: number, b: number) => a - b;\n" }) });
        return reply(null, { ...s, toolCalls: call("list_files", { alias: "core", dir: "src", glob: "*.nothing" }) });
      }
      if (n === 0) return reply(null, { ...s, toolCalls: call("read_file", { alias: "core", path: "src/sub.ts" }) });
      return reply(null, { ...s, toolCalls: submit() });
    });
    sy = open(env, client, { worker: true, coding: createCodingRunner(env.cfg) });
    const [sub] = await sy.submitTasks([task({ constraints: { acceptanceCriteria: ["subtract exists"], allowedPaths: ["src/**"] } })]);
    const r = (await sy.awaitResults([sub!.taskId], { timeoutSeconds: 60 })).completed[0]!;
    expect(r.routing).toMatchObject({ tier: "T3", escalatedFrom: "T2" });

    // The empty listing is a plain, complete answer (models otherwise list again and again).
    const listing = client.requests.flatMap((q) => q.messages).find((m) => m.role === "tool" && String(m.content).startsWith("No files"));
    expect(String(listing?.content)).toMatch(/^No files matching \*\.nothing in src\. This is a complete answer, not an error: nothing matches\.$/);

    // The escalated run was told about the unfinished work and found the first attempt's file.
    const second = client.requests.filter((q) => q.messages.some((m) => m.role === "user" && String(m.content).includes(NOTE)));
    expect(second.length).toBeGreaterThan(0);
    expect(String(second[0]!.messages.find((m) => m.role === "user" && String(m.content).includes(NOTE))!.content)).toMatch(/changed: src\/sub\.ts/);
    const readBack = second.flatMap((q) => q.messages).find((m) => m.role === "tool" && String(m.content).includes("a - b"));
    expect(readBack).toBeDefined();
    expect(readFileSync(path.join(worktreeOf(sub!.taskId), "src/sub.ts"), "utf8")).toContain("a - b");
  }, 90_000);

  it("coding task types default to a larger output allowance than other task types", () => {
    env = makeEnv({ config: baseConfig() });
    // The test config sets no max_output_tokens for implement or inspect, and 2000 for summarize.
    expect(env.cfg.profiles.implement!.max_output_tokens).toBe(16000);
    expect(env.cfg.profiles.inspect!.max_output_tokens).toBe(4000);
    expect(env.cfg.profiles.summarize!.max_output_tokens).toBe(2000);
  });

  it("the final request offers only the submit tool, so a model that keeps exploring still submits", async () => {
    env = makeEnv({ config: baseConfig({ coding: { runner: "native" } }) });
    const client = new ScriptedClient((req) => {
      const s = servedFor(sy!, req);
      // A model that would explore forever: it submits only when nothing else is offered. (It
      // reads src/app.ts, which its submission cites as evidence.)
      if ((req.tools ?? []).length === 1) return reply(null, { ...s, toolCalls: submit() });
      return reply(null, { ...s, toolCalls: call("read_file", { alias: "core", path: "src/app.ts" }) });
    });
    sy = open(env, client, { worker: true, coding: createCodingRunner(env.cfg) });
    const [sub] = await sy.submitTasks([task({ budget: { maxModelRequests: 3 }, constraints: { acceptanceCriteria: ["x"], allowedPaths: ["src/**"] } })]);
    const r = (await sy.awaitResults([sub!.taskId], { timeoutSeconds: 60 })).completed[0]!;
    const own = client.requests.filter((q) => (q.tools ?? []).some((t) => t.function.name === "submit_result"));
    expect(own.at(-1)!.tools!.map((t) => t.function.name)).toEqual(["submit_result"]);
    expect(own.slice(0, -1).every((q) => q.tools!.length > 1)).toBe(true);
    expect(r.stopReason).toBe("worker_submitted");
  }, 90_000);

  it("nudges a coding worker that has edited nothing by half its requests, and marks exact repeat reads", async () => {
    env = makeEnv({ config: baseConfig({ coding: { runner: "native" } }) });
    const client = new ScriptedClient((req) => {
      const s = servedFor(sy!, req);
      if ((req.tools ?? []).length === 1) return reply(null, { ...s, toolCalls: submit() });
      return reply(null, { ...s, toolCalls: call("read_file", { alias: "core", path: "src/app.ts" }) });
    });
    sy = open(env, client, { worker: true, coding: createCodingRunner(env.cfg) });
    const [sub] = await sy.submitTasks([task({ budget: { maxModelRequests: 6 }, constraints: { acceptanceCriteria: ["x"], allowedPaths: ["src/**"] } })]);
    await sy.awaitResults([sub!.taskId], { timeoutSeconds: 60 });
    const last = client.requests.at(-1)!.messages;
    const nudges = last.filter((m) => m.role === "user" && String(m.content).includes("have not changed any file yet"));
    expect(nudges).toHaveLength(1);
    expect(String(nudges[0]!.content)).toMatch(/You have used 3 of 6 requests/);
    expect(last.some((m) => m.role === "tool" && String(m.content).includes("[You made this exact read_file call 2 times"))).toBe(true);
  }, 90_000);

  it("file tools take file_path as path, say plainly when the path is missing, and context accepts a bare path for a single repository", async () => {
    env = makeEnv({ config: baseConfig({ coding: { runner: "native" } }) });
    const client = new ScriptedClient((req) => {
      const s = servedFor(sy!, req);
      const n = toolCount(req);
      if (n === 0) return reply(null, { ...s, toolCalls: call("write_file", { content: "lost?" }) });
      if (n === 1) return reply(null, { ...s, toolCalls: call("write_file", { file_path: "src/sub.ts", content: "export const subtract = (a: number, b: number) => a - b;\n" }) });
      return reply(null, { ...s, toolCalls: submit() });
    });
    sy = open(env, client, { worker: true, coding: createCodingRunner(env.cfg) });
    const [sub] = await sy.submitTasks([task({ context: { fileRefs: ["src/app.ts"] }, constraints: { acceptanceCriteria: ["x"], allowedPaths: ["src/**"] } })]);
    await sy.awaitResults([sub!.taskId], { timeoutSeconds: 60 });
    const tools = client.requests.at(-1)!.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
    expect(tools[0]).toMatch(/^error: write_file needs path: .*Nothing was written/);
    expect(tools[1]).toMatch(/^wrote src\/sub\.ts/);
    expect(readFileSync(path.join(worktreeOf(sub!.taskId), "src/sub.ts"), "utf8")).toContain("a - b");
    // The bare "src/app.ts" was read as core:src/app.ts (the only repository).
    expect(JSON.stringify(client.requests[0]!.messages)).toContain("core:src/app.ts");
  }, 90_000);
});

