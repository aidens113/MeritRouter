import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MeritRouter } from "../src/core/service.js";
import type { ChatRequest } from "../src/gateway/types.js";
import type { SessionEvent, SessionEventOf } from "../src/sessions/events.js";
import type { SessionRecord } from "../src/sessions/store.js";
import { createCodingRunner } from "../src/runners/coding/index.js";
import { baseConfig, endpoint, goodOutput, makeEnv, openWithTestSupervisor as open, reply, ScriptedClient, servedFor, summarizeTask, type Env } from "./helpers.js";

const agent = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-agent.mjs");
let env: Env | undefined;
let sy: MeritRouter | undefined;
afterEach(async () => {
  await sy?.close();
  sy = undefined;
  env?.cleanup();
});

const call = (name: string, args: unknown, id = name) => ({ id, type: "function" as const, function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } });
const toolCount = (req: ChatRequest) => req.messages.filter((m) => m.role === "tool").length;
const turns = (req: ChatRequest) => req.messages.filter((m) => m.role === "assistant").length;

function eventsOf(id: string): SessionEvent[] {
  const page = sy!.sessions.events(id, { limit: 10_000 })!;
  expect(page.corrupt).toEqual([]);
  return page.events;
}
function ofType<T extends SessionEvent["type"]>(events: SessionEvent[], type: T): SessionEventOf<T>[] {
  return events.filter((e): e is SessionEventOf<T> => e.type === type);
}
/** The task's run sessions (not its classifier sessions), oldest first. */
function runs(taskId: string): SessionRecord[] {
  return sy!.sessions.forTask(taskId).filter((s) => s.role !== "classifier");
}
/** Every tool intent paired with its outcome. */
function journal(events: SessionEvent[]) {
  const outcomes = new Map(ofType(events, "tool_outcome").map((o) => [o.data.intentSeq, o]));
  return ofType(events, "tool_intent").map((i) => ({ name: i.data.name, sideEffect: i.data.sideEffect, ok: outcomes.get(i.seq)?.data.ok, seq: i.seq, outcomeSeq: outcomes.get(i.seq)?.seq }));
}

describe("completion runner sessions", () => {
  it("records the transcript, request, and response, and ends with the outcome", async () => {
    env = makeEnv();
    sy = open(env, new ScriptedClient((req) => reply(JSON.stringify(goodOutput()), servedFor(sy!, req))), { worker: true });
    const [sub] = await sy.submitTasks([summarizeTask({ label: "sum-log" })]);
    await sy.awaitResults([sub!.taskId], { timeoutSeconds: 10 });
    const [s, ...rest] = sy.sessions.forTask(sub!.taskId);
    expect(rest).toEqual([]);
    expect(s).toMatchObject({ role: "summarizer", agentLabel: "summarizer:sum-log", profile: "summarize", tier: "T1", status: "completed", stopReason: "worker_answered", modelRequests: 1, toolCalls: 0, previousSessionId: null, parentSessionId: null });
    const ev = eventsOf(s!.id);
    expect(ev.map((e) => e.type)).toEqual(["started", "message", "message", "model_request", "model_response", "ended"]);
    expect(ofType(ev, "model_request")[0]!.data).toMatchObject({ purpose: "completion", messageCount: 2, responseFormat: "json_object" });
    expect(ofType(ev, "model_response")[0]!.data.endpointId).toBe("openrouter/vendor/big-a:free");
  });

  it("an escalation is a new session linked to the run it replaces", async () => {
    env = makeEnv();
    sy = open(env, new ScriptedClient((req) => reply("not json", servedFor(sy!, req))), { worker: true });
    const [sub] = await sy.submitTasks([summarizeTask()]);
    await sy.awaitResults([sub!.taskId], { timeoutSeconds: 10 });
    const [t1, t2] = runs(sub!.taskId);
    expect(t1).toMatchObject({ tier: "T1", status: "failed", stopReason: "invalid_output; escalated to T2", modelRequests: 2 });
    expect(t2).toMatchObject({ tier: "T2", status: "failed", stopReason: "invalid_output", previousSessionId: t1!.id, modelRequests: 2 });
  });
});

describe("read-only runner sessions", () => {
  it("journals every tool call (intent before, outcome after), including the terminal tool", async () => {
    env = makeEnv();
    const client = new ScriptedClient((req) => {
      const s = servedFor(sy!, req);
      if (toolCount(req) === 0) return reply(null, { ...s, toolCalls: [call("read_file", { alias: "core", path: "src/app.ts" }, "r1"), call("no_such_tool", {}, "u1"), call("search", "{not json", "j1")] });
      return reply(null, { ...s, toolCalls: [call("submit_result", goodOutput(1, "core:src/app.ts#L1-L3"), "s1")] });
    });
    sy = open(env, client, { worker: true });
    const [sub] = await sy.submitTasks([{ profile: "inspect", goal: "Find add", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["add located"] } }]);
    const r = (await sy.awaitResults([sub!.taskId], { timeoutSeconds: 20 })).completed[0]!;
    expect(r.executionStatus).toBe("completed");
    const [s] = runs(sub!.taskId);
    expect(s).toMatchObject({ role: "inspector", status: "completed", stopReason: "worker_submitted", modelRequests: 2, toolCalls: 4 });
    const ev = eventsOf(s!.id);
    const j = journal(ev);
    expect(j.map(({ name, sideEffect, ok }) => ({ name, sideEffect, ok }))).toEqual([
      { name: "read_file", sideEffect: "read", ok: true },
      { name: "no_such_tool", sideEffect: "none", ok: false },
      { name: "search", sideEffect: "read", ok: false },
      { name: "submit_result", sideEffect: "none", ok: true },
    ]);
    // Each outcome follows its intent, and the next intent follows that outcome.
    for (const [i, x] of j.entries()) {
      expect(x.outcomeSeq).toBeGreaterThan(x.seq);
      if (j[i + 1]) expect(j[i + 1]!.seq).toBeGreaterThan(x.outcomeSeq!);
    }
    // Unparseable arguments are journaled as the raw string.
    expect(ofType(ev, "tool_intent").find((e) => e.data.name === "search")!.data.args).toBe("{not json");
    // The final turn (after the last request) is in the log too: the transcript ends with "accepted".
    const last = ofType(ev, "message").at(-1)!.data.message;
    expect(last).toMatchObject({ role: "tool", tool_call_id: "s1", content: "accepted" });
  });

  it("a spent request budget ends the session as failed with stopReason budget_exhausted", async () => {
    env = makeEnv();
    sy = open(env, new ScriptedClient((req) => reply(null, { ...servedFor(sy!, req), toolCalls: [call("read_file", { alias: "core", path: "README.md", start_line: turns(req) + 1 }, `r${turns(req)}`)] })), { worker: true });
    const [sub] = await sy.submitTasks([{ profile: "inspect", goal: "Read forever", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["x"] }, budget: { maxModelRequests: 2 } }]);
    const r = (await sy.awaitResults([sub!.taskId], { timeoutSeconds: 20 })).completed[0]!;
    expect(r.executionStatus).toBe("budget_exhausted");
    const [s, ...rest] = runs(sub!.taskId);
    expect(rest).toEqual([]);
    expect(s).toMatchObject({ status: "failed", stopReason: "budget_exhausted", modelRequests: 2, toolCalls: 2 });
  });
});

describe("batch sessions", () => {
  it("every batch item has its own session that records the shared request", async () => {
    env = makeEnv({ config: baseConfig({ execution: { max_concurrent_tasks: 1, lease_seconds: 30 } }) });
    const client = new ScriptedClient((req) => {
      const ids = [...String((req.messages[1] as { content: string }).content).matchAll(/<item id="(i\d+)">/g)].map((m) => m[1]!);
      return reply(JSON.stringify({ items: ids.map((id) => ({ id, result: goodOutput() })) }), servedFor(sy!, req));
    });
    sy = open(env, client);
    const subs = await sy.submitTasks([summarizeTask({ goal: "a" }), summarizeTask({ goal: "b" }), summarizeTask({ goal: "c" })]);
    sy.recover();
    (sy as unknown as { startWorker: (n: number) => void }).startWorker(50);
    await sy.awaitResults(subs.map((s) => s.taskId), { timeoutSeconds: 10 });
    expect(client.requests).toHaveLength(1);
    const requestIds = new Set<string>();
    for (const sub of subs) {
      const [s, ...rest] = runs(sub.taskId);
      expect(rest).toEqual([]);
      expect(s).toMatchObject({ role: "summarizer", status: "completed", stopReason: "worker_answered_in_batch", modelRequests: 1 });
      const ev = eventsOf(s!.id);
      const shared = ofType(ev, "note").find((n) => n.data.text.startsWith("shared batch request"))!;
      expect((shared.data.data as { members: unknown[] }).members).toHaveLength(3);
      expect(ofType(ev, "model_request")[0]!.data).toMatchObject({ purpose: "batch", messageCount: 2 });
      requestIds.add(ofType(ev, "model_response")[0]!.data.requestId);
      expect(ofType(ev, "note").some((n) => /^batch item i\d accepted$/.test(n.data.text))).toBe(true);
    }
    expect(requestIds.size).toBe(1);
  });
});

describe("classifier sessions", () => {
  it("each classified task gets a classifier session, and its run session does not link to it", async () => {
    env = makeEnv({ endpoints: [endpoint({ totalParametersB: 120 })] });
    const client = new ScriptedClient((req) => {
      if (String(req.messages[0]!.content).startsWith("You classify")) {
        const ids = [...String((req.messages[1] as { content: string }).content).matchAll(/<item id="(c\d+)">/g)].map((m) => m[1]);
        return reply(JSON.stringify({ items: ids.map((id) => ({ id, tags: { kind: "locate", reasoning: "lookup", novelty: "existing_pattern", risk: [], environment: [], ambiguity: "low" }, confidence: 0.9, rationale: "simple", suggestedTier: "T2" })) }), servedFor(sy!, req));
      }
      return reply(null, { ...servedFor(sy!, req), toolCalls: [call("submit_result", goodOutput(1, "core:src/app.ts#L1-L2"), "1")] });
    });
    sy = open(env, client, { worker: true });
    const task = (goal: string) => ({ profile: "analyze", goal, repositoryAliases: ["core"], context: { fileRefs: ["core:src/app.ts"] }, constraints: { acceptanceCriteria: ["find add"] } });
    const subs = await sy.submitTasks([task("one"), task("two")]);
    await sy.awaitResults(subs.map((s) => s.taskId), { timeoutSeconds: 10 });
    const requestIds = new Set<string>();
    for (const sub of subs) {
      const [c, run, ...rest] = sy.sessions.forTask(sub.taskId);
      expect(rest).toEqual([]);
      expect(c).toMatchObject({ role: "classifier", agentLabel: `classifier:${sub.taskId}`, status: "completed", stopReason: "classified", modelRequests: 1 });
      const ev = eventsOf(c!.id);
      expect(ofType(ev, "note").map((n) => n.data.text)).toEqual(["memory context omitted",expect.stringMatching(/^shared classification request \(2 items\)/), "verdict"]);
      expect(ofType(ev,"note")[0]!.data.data).toMatchObject({memoryManifest:{schemaVersion:1,role:"classifier",project:"demo",entries:[],omissions:[{reason:"Technical task-metadata classification; product memory is not applicable"}]}});
      requestIds.add(ofType(ev, "model_response")[0]!.data.requestId);
      expect(run).toMatchObject({ role: "analyst", status: "completed", previousSessionId: null });
    }
    expect(requestIds.size).toBe(1);
  });
});

describe("coding runner sessions", () => {
  const check = `node -e "process.exit(require('fs').readFileSync('src/app.ts','utf8').includes('subtract')?0:1)"`;
  const implement = (o: Record<string, unknown> = {}) => ({
    profile: "implement",
    label: "add-subtract",
    goal: "Add subtract() to src/app.ts",
    repositoryAliases: ["core"],
    writableRepository: "core",
    hints: { difficulty: "T2" },
    constraints: { acceptanceCriteria: ["subtract exists"], allowedPaths: ["src/**"], checks: [check] },
    ...o,
  });

  it("native: edits are journaled as edits and the workspace head follows each commit", async () => {
    env = makeEnv({ config: baseConfig({ coding: { runner: "native" } }) });
    const client = new ScriptedClient((req) => {
      const s = servedFor(sy!, req);
      if (toolCount(req) === 0) return reply(null, { ...s, toolCalls: [call("replace_in_file", { path: "src/app.ts", old_text: "export function add", new_text: "export function subtract(a: number, b: number) {\n  return a - b;\n}\n\nexport function add" }, "e1")] });
      return reply(null, { ...s, toolCalls: [call("submit_result", goodOutput(1, "core:src/app.ts#L1-L3"), "s1")] });
    });
    sy = open(env, client, { worker: true, coding: createCodingRunner(env.cfg) });
    const [sub] = await sy.submitTasks([implement()]);
    const r = (await sy.awaitResults([sub!.taskId], { timeoutSeconds: 60 })).completed[0]!;
    expect(r.acceptanceStatus).toBe("met");
    const [s] = runs(sub!.taskId);
    expect(s).toMatchObject({ role: "implementer", agentLabel: "implementer:add-subtract", status: "completed" });
    const ev = eventsOf(s!.id);
    expect(journal(ev).map((x) => `${x.name}:${x.sideEffect}:${x.ok}`)).toEqual(["replace_in_file:edit:true", "submit_result:none:true"]);
    const ws = ofType(ev, "workspace");
    expect(ws).toHaveLength(2);
    const [before, after] = ws.map((w) => w.data.repos[0]!);
    expect(before).toMatchObject({ alias: "core", branch: null, baseCommit: r.baseCommits.core, head: r.baseCommits.core });
    expect(after!.worktree).toBe(before!.worktree);
    expect(after!.head).not.toBe(before!.head);
    expect(s!.workspace!.repos[0]!.head).toBe(after!.head);
  }, 90_000);

  it("external agent: records refusal without a workspace or gateway requests", async () => {
    env = makeEnv({ config: baseConfig({ coding: { runner: "command", command: `node "${agent}" good` } }) });
    const client = new ScriptedClient((req) => reply(JSON.stringify(goodOutput()), servedFor(sy!, req)));
    sy = open(env, client, { worker: true, coding: createCodingRunner(env.cfg) });
    const [sub] = await sy.submitTasks([implement()]);
    const result = (await sy.awaitResults([sub!.taskId], { timeoutSeconds: 60 })).completed[0]!;
    expect(result.stopReason).toBe("worker_sandbox_unavailable");
    expect(client.requests).toHaveLength(0);
    const [session] = runs(sub!.taskId);
    expect(session).toMatchObject({ status: "failed", stopReason: "worker_sandbox_unavailable", modelRequests: 0 });
    expect(ofType(eventsOf(session!.id), "model_request")).toHaveLength(0);
    expect(ofType(eventsOf(session!.id), "workspace")).toHaveLength(0);
  }, 90_000);
});

describe("supervisor sessions", () => {
  it("records the job workspace, journals supervisor tools, and parents delegated sessions", async () => {
    const cfg = baseConfig({ coding: { runner: "native" }, supervisor: { max_workers_per_job: 2 } });
    (cfg.profiles as Record<string, unknown>).supervise = { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100, max_model_requests: 30, max_output_tokens: 4000, classify: "never", min_tier: "T3" };
    env = makeEnv({ config: cfg });
    const isSupervisor = (req: ChatRequest) => String(req.messages[0]!.content).startsWith("# Supervisor charter");
    const script = [
      () => [call("delegate", { tasks: [{ label: "subtract", profile: "implement", goal: "Add subtract(a, b) to src/app.ts", acceptance_criteria: ["subtract exists"], allowed_paths: ["src/**"], difficulty: "T2" }] })],
      () => [call("await_tasks", { timeout_seconds: 60 })],
      // The task declares no checks, so its result is not_verified: integrating records the acceptance.
      () => [call("integrate_task", { task_id: "subtract", accept: true, reason: "read the patch: subtract(a, b) returns a - b" })],
      () => [call("finish_job", { status: "completed", summary: "integrated", verified: [{ claim: "integrated", evidence: "integrate_task" }], not_verified: [] })],
    ];
    const client = new ScriptedClient((req) => {
      const s = servedFor(sy!, req);
      if (isSupervisor(req)) return reply(null, { ...s, toolCalls: script[turns(req)]!() });
      if (turns(req) === 0) return reply(null, { ...s, toolCalls: [call("replace_in_file", { path: "src/app.ts", old_text: "export function add", new_text: "export function subtract(a: number, b: number) {\n  return a - b;\n}\n\nexport function add" })] });
      return reply(null, { ...s, toolCalls: [call("submit_result", goodOutput(1, "core:src/app.ts#L1-L3"))] });
    });
    sy = open(env, client, { worker: true });
    const job = await sy.startJob({ goal: "Add subtract() to the app", repositories: ["core"], label: "subtract-job" });
    const r = (await sy.awaitResults([job.taskId], { timeoutSeconds: 120 })).completed[0]!;
    expect(r.stopReason).toBe("supervisor_completed");

    const [sup, ...more] = runs(job.taskId);
    expect(more).toEqual([]);
    expect(sup).toMatchObject({ role: "supervisor", agentLabel: "supervisor:subtract-job", jobId: job.taskId, status: "completed", modelRequests: 4 });
    const ev = eventsOf(sup!.id);
    expect(journal(ev).map((x) => `${x.name}:${x.sideEffect}:${x.ok}`)).toEqual(["delegate:delegate:true", "await_tasks:none:true", "integrate_task:edit:true", "finish_job:none:true"]);
    const ws = ofType(ev, "workspace").map((w) => w.data.repos[0]!);
    expect(ws[0]).toMatchObject({ alias: "core", branch: `meritrouter/job-${job.taskId}`, head: ws[0]!.baseCommit });
    // integrate_task cherry-picked the worker's commit: the recorded head moved.
    expect(ws.at(-1)!.head).not.toBe(ws[0]!.head);

    const childId = sy.listTasks().find((t) => t.taskId !== job.taskId)!.taskId;
    const [child] = runs(childId);
    expect(child).toMatchObject({ role: "implementer", agentLabel: "implementer:subtract", parentSessionId: sup!.id, jobId: job.taskId, status: "completed" });
    expect(sy.sessions.list({ parentSessionId: sup!.id }).map((s) => s.id)).toEqual([child!.id]);
  }, 180_000);

  it("a shutdown ends the session as interrupted; the resumed run continues that session", async () => {
    const cfg = baseConfig({ coding: { runner: "native" } });
    (cfg.profiles as Record<string, unknown>).supervise = { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100, max_model_requests: 30, max_output_tokens: 4000, classify: "never", min_tier: "T3" };
    env = makeEnv({ config: cfg });
    const client = new ScriptedClient((req) => {
      const calls = turns(req) === 0 ? [call("ask_user", { question: "Which format?" })] : [call("finish_job", { status: "blocked", summary: "stopped", verified: [], not_verified: ["all"] })];
      return reply(null, { ...servedFor(sy!, req), toolCalls: calls });
    });
    sy = open(env, client, { worker: true });
    const job = await sy.startJob({ goal: "Pick a format", repositories: ["core"] });
    for (let i = 0; i < 100 && !sy.questions().length; i++) await new Promise((r) => setTimeout(r, 100));
    await sy.close();
    sy = open(env, client, { worker: false });
    const [first] = runs(job.taskId);
    expect(first).toMatchObject({ status: "interrupted", stopReason: "shutdown" });
    // An aborted in-flight effect retains an unresolved intent for resume reconciliation.
    expect(journal(eventsOf(first!.id)).map((x) => `${x.name}:${x.sideEffect}:${x.ok}`)).toEqual(["ask_user:external:undefined"]);
    expect(ofType(eventsOf(first!.id), "tool_outcome")).toHaveLength(0);
    sy.answerQuestion(sy.questions()[0]!.id, "CSV");
    await sy.close();
    sy = open(env, client, { worker: true });
    await sy.awaitResults([job.taskId], { timeoutSeconds: 30 });
    // S2: the same session is reopened and continued, not a new one.
    const [again, ...rest] = runs(job.taskId);
    expect(rest).toEqual([]);
    expect(again).toMatchObject({ id: first!.id, status: "completed", stopReason: "supervisor_blocked" });
    const evs = eventsOf(first!.id);
    expect(ofType(evs, "note").some((n) => n.data.text === "reopened")).toBe(true);
    expect(ofType(evs, "resumed")).toHaveLength(1);
    // The continued transcript holds the resume notice with the answer given meanwhile.
    const messages = ofType(evs, "message").map((m) => m.data.message);
    expect(messages.some((m) => m.role === "user" && typeof m.content === "string" && m.content.includes('"Which format?" -> CSV'))).toBe(true);
  }, 120_000);
});
