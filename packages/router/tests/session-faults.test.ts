import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { Switchyard, SwitchyardOptions } from "../src/core/service.js";
import type { ChatMessage, ChatRequest } from "../src/gateway/types.js";
import type { SessionEvent, SessionEventOf } from "../src/sessions/events.js";
import type { SessionRecord } from "../src/sessions/store.js";
import { FAULT_ENV, resetFaults, simulatedCrashCount } from "../src/core/faults.js";
import { baseConfig, goodOutput, makeEnv, open, reply, ScriptedClient, servedFor, summarizeTask, type Env, type ScriptedRequest } from "./helpers.js";

/**
 * Fault injection (S2): a run dies at a named point (SWITCHYARD_FAULT_AT), leaving its session
 * running and its lease held as a crashed process would. A fresh Switchyard on the same storage,
 * with the clock past the lease, must finish the task without repeating edits, delegations, or
 * paid charges.
 */

let env: Env | undefined;
let sy: Switchyard | undefined;
beforeEach(() => resetFaults());
afterEach(async () => {
  delete process.env[FAULT_ENV];
  resetFaults();
  await sy?.close();
  sy = undefined;
  env?.cleanup();
});

/** Past every lease (30 s in the test config), within every task deadline. */
const LATER = 10 * 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const call = (name: string, args: unknown, id = name) => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
const turnsIn = (messages: ChatMessage[]) => messages.filter((m) => m.role === "assistant").length;
const turns = (req: ChatRequest) => turnsIn(req.messages);
const isSupervisor = (req: ChatRequest) => String(req.messages[0]!.content).startsWith("# Supervisor charter");
const check = `node -e "process.exit(require('fs').readFileSync('src/app.ts','utf8').includes('subtract')?0:1)"`;
// Coding tasks below are hinted T2: standard verification (checks on the submitted revision), so
// "met" proves the checks passed on the resumed revision. Unhinted they classify T3 (deep), which
// needs an independent reviewer these single-endpoint tests do not have.
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd }).toString();
const count = (text: string, needle: string) => text.split(needle).length - 1;

function eventsOf(id: string): SessionEvent[] {
  const page = sy!.sessions.events(id, { limit: 10_000 })!;
  expect(page.corrupt).toEqual([]);
  return page.events;
}
function ofType<T extends SessionEvent["type"]>(events: SessionEvent[], type: T): SessionEventOf<T>[] {
  return events.filter((e): e is SessionEventOf<T> => e.type === type);
}
function runs(taskId: string): SessionRecord[] {
  return sy!.sessions.forTask(taskId).filter((s) => s.role !== "classifier");
}

/**
 * Start a worker with the fault armed, submit, wait for the simulated crash, and stop that
 * process. Checks the crash left the task running and its session running (as a dead process
 * would), then opens a fresh worker whose clock is past the lease, so recovery takes over.
 */
async function crashThenRecover(o: { client: ScriptedClient; fault: string; submit: (s: Switchyard) => Promise<string>; opts?: SwitchyardOptions; operator?: (s: Switchyard, taskId: string) => void }): Promise<string> {
  const before = simulatedCrashCount();
  process.env[FAULT_ENV] = o.fault;
  sy = open(env!, o.client, { worker: true, ...o.opts });
  const id = await o.submit(sy);
  for (let i = 0; i < 600 && simulatedCrashCount() === before; i++) await sleep(20);
  expect(simulatedCrashCount()).toBe(before + 1);
  delete process.env[FAULT_ENV];
  await sleep(50);
  await sy.close();
  sy = open(env!, o.client, { worker: false, ...o.opts });
  expect(sy.getStatus([id])[0]).toMatchObject({ state: "running" });
  expect(runs(id).at(-1)).toMatchObject({ status: "running" });
  await sy.close();
  if (o.operator) {
    // An operator acts first, from a process that runs no tasks.
    sy = open(env!, o.client, { worker: false, now: () => Date.now() + LATER, ...o.opts });
    o.operator(sy, id);
    await sy.close();
  }
  sy = open(env!, o.client, { worker: true, now: () => Date.now() + LATER, ...o.opts });
  return id;
}

/** Read-only worker: read src/app.ts until a read succeeds, then submit citing it. */
function reader(messages: ChatMessage[]) {
  const n = turnsIn(messages);
  const read = messages.some((m) => m.role === "tool" && m.content.startsWith("ref: core:src/app.ts"));
  return read ? [call("submit_result", goodOutput(1, "core:src/app.ts#L1-L3"), `submit${n}`)] : [call("read_file", { alias: "core", path: "src/app.ts" }, `read${n}`)];
}
const inspectTask = { profile: "inspect", label: "find-add", goal: "Where is add() defined?", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["names the file"] } };

describe("read-only worker", () => {
  it("dies after a read ran but before its outcome was logged: the read is retried and the task finishes in the same session", async () => {
    env = makeEnv();
    const client = new ScriptedClient((req) => reply(null, { ...servedFor(sy!, req), toolCalls: reader(req.messages) }));
    const id = await crashThenRecover({ client, fault: "after_tool_run:1:read_file", submit: async (s) => (await s.submitTasks([inspectTask]))[0]!.taskId });
    const r = (await sy!.awaitResults([id], { timeoutSeconds: 30 })).completed[0]!;
    // A worker's own "met" is a claim: read-only results are never better than not_verified.
    expect(r).toMatchObject({ executionStatus: "completed", stopReason: "worker_submitted", acceptanceStatus: "not_verified", unresolvedCriteria: [] });

    const [s, ...rest] = runs(id);
    expect(rest).toEqual([]);
    expect(s).toMatchObject({ status: "completed", previousSessionId: null });
    const ev = eventsOf(s!.id);
    expect(ofType(ev, "ended").map((e) => e.data.stopReason)).toEqual(["process_died", "worker_submitted"]);
    const [resumed, ...more] = ofType(ev, "resumed");
    expect(more).toEqual([]);
    expect(resumed!.data.summary).toContain("read_file (call read0): interrupted; call again");
    expect(resumed!.data.resolvedIntentSeqs).toHaveLength(1);
    // The model saw the retry text, read again, then submitted: one request before the crash, two after.
    expect(client.requests).toHaveLength(3);
    expect(client.requests[1]!.messages.some((m) => m.role === "tool" && m.content === "interrupted; call again")).toBe(true);
  });

  it("dies after submit_result was accepted but before its outcome was logged: it finishes without another (paid) request", async () => {
    env = makeEnv({
      config: baseConfig({
        paid: {
          enabled: true,
          budgets: { per_week_usd: 5 },
          tiers: { T1: "preferred" },
          providers: { acme: { kind: "openai_compatible", base_url: "https://api.acme.test/v1" } },
          models: [{ provider: "acme", model: "acme-large", input_usd_per_million: 2, output_usd_per_million: 8, context_limit_tokens: 100000, output_limit_tokens: 8000, ignore_size_floor: true }],
        },
      }),
      endpoints: [],
    });
    // Only the paid provider acme serves (no free endpoint is configured).
    const calls: ScriptedRequest[] = [];
    const paid = new ScriptedClient((r) => {
      if (r.provider !== "acme") throw new Error("only the paid provider may be used");
      calls.push(r);
      const base = reply(null, { model: r.model, toolCalls: reader(r.messages) });
      return { ...base, usage: { ...base.usage, inputTokens: 1000, outputTokens: 500 } };
    });
    const id = await crashThenRecover({
      client: paid,
      fault: "after_tool_run:1:submit_result",
      submit: async (s) => {
        s.vault.add({ provider: "acme", secret: "sk-acme-0000-1111" });
        return (await s.submitTasks([inspectTask]))[0]!.taskId;
      },
    });
    const r = (await sy!.awaitResults([id], { timeoutSeconds: 30 })).completed[0]!;
    // A worker's own "met" is a claim: read-only results are never better than not_verified.
    expect(r).toMatchObject({ executionStatus: "completed", stopReason: "worker_submitted", acceptanceStatus: "not_verified", unresolvedCriteria: [] });
    expect(r.servedEndpoints).toEqual(["paid:acme/acme-large"]);

    // Two paid requests in all (read, submit), each charged once; the resume asked the model nothing.
    expect(calls).toHaveLength(2);
    expect(sy!.spend.summary().week).toBeCloseTo(2 * 0.006, 6);
    const [s] = runs(id);
    const ev = eventsOf(s!.id);
    expect(ofType(ev, "model_response")).toHaveLength(2);
    expect(ofType(ev, "model_request")).toHaveLength(2);
    // The submission was validated again (evidence restored from the logged read) and journaled under its call id.
    const submits = ofType(ev, "tool_intent").filter((i) => i.data.name === "submit_result");
    expect(submits.map((i) => i.data.callId)).toEqual(["submit1", "submit1"]);
    expect(ofType(ev, "tool_outcome").filter((o) => o.data.name === "submit_result").map((o) => o.data.output)).toEqual(["accepted"]);
  });
});

describe("accepted submission", () => {
  it("dies after submit_result's acceptance was logged (a later call in the same turn was in flight): it finishes with that result", async () => {
    env = makeEnv();
    const client = new ScriptedClient((req) => {
      const s = servedFor(sy!, req);
      if (turns(req) === 0) return reply(null, { ...s, toolCalls: [call("read_file", { alias: "core", path: "src/app.ts" }, "read0")] });
      return reply(null, { ...s, toolCalls: [call("submit_result", goodOutput(1, "core:src/app.ts#L1-L3"), "submit1"), call("read_file", { alias: "core", path: "README.md" }, "read1")] });
    });
    const id = await crashThenRecover({ client, fault: "after_tool_intent:2:read_file", submit: async (s) => (await s.submitTasks([inspectTask]))[0]!.taskId });
    const r = (await sy!.awaitResults([id], { timeoutSeconds: 30 })).completed[0]!;
    expect(r).toMatchObject({ executionStatus: "completed", stopReason: "worker_submitted", summary: "done" });
    expect(client.requests).toHaveLength(2);
    const ev = eventsOf(runs(id)[0]!.id);
    // Accepted once, before the crash; the resume re-validated it without journaling it again.
    expect(ofType(ev, "tool_outcome").filter((o) => o.data.name === "submit_result").map((o) => o.data.output)).toEqual(["accepted"]);
    expect(ofType(ev, "tool_intent").filter((i) => i.data.name === "submit_result")).toHaveLength(1);
  });
});

describe("native coding worker", () => {
  it("dies with an edit applied but uncommitted: the edit is committed as recovered, in the same worktree, and never repeated", async () => {
    env = makeEnv({ config: baseConfig({ coding: { runner: "native" } }) });
    const client = new ScriptedClient((req) => {
      const s = servedFor(sy!, req);
      if (turns(req) === 0) return reply(null, { ...s, toolCalls: [call("replace_in_file", { path: "src/app.ts", old_text: "export function add", new_text: "export function subtract(a: number, b: number) {\n  return a - b;\n}\n\nexport function add" }, "edit0")] });
      return reply(null, { ...s, toolCalls: [call("submit_result", goodOutput(1, "core:src/app.ts#L1-L3"), `submit${turns(req)}`)] });
    });
    const task = { profile: "implement", label: "sub", goal: "Add subtract(a, b) to src/app.ts", repositoryAliases: ["core"], writableRepository: "core", hints: { difficulty: "T2" }, constraints: { acceptanceCriteria: ["subtract exists"], allowedPaths: ["src/**"], checks: [check] } };
    const id = await crashThenRecover({ client, fault: "after_tool_run:1:replace_in_file", submit: async (s) => (await s.submitTasks([task]))[0]!.taskId });
    const r = (await sy!.awaitResults([id], { timeoutSeconds: 60 })).completed[0]!;
    expect(r).toMatchObject({ executionStatus: "completed", acceptanceStatus: "met", stopReason: "worker_submitted" });
    expect(r.checks.map((c) => c.exitCode)).toEqual([0]);
    // Agent-loop requests (the classifier's carry no tools): the edit turn, then the submit after the resume.
    const loop = client.requests.filter((q) => q.tools?.length);
    expect(loop).toHaveLength(2);

    // One session, one worktree: the resumed run continued where the dead one was.
    const [s, ...rest] = runs(id);
    expect(rest).toEqual([]);
    const wt = s!.workspace!.repos[0]!.worktree;
    expect(readdirSync(path.join(env.cfg.storageDir, "worktrees")).filter((d) => d.startsWith(id))).toEqual([path.basename(wt)]);
    expect((sy!.db.prepare("SELECT worktree_path FROM workspaces WHERE task_id = ?").get(id) as { worktree_path: string }).worktree_path).toBe(wt);

    // The edit happened once and is committed as recovered under the worker's identity.
    expect(count(readFileSync(path.join(wt, "src/app.ts"), "utf8"), "export function subtract")).toBe(1);
    const log = git(wt, "log", "--format=%s|%(trailers:key=Agent,valueonly)", `${s!.workspace!.repos[0]!.baseCommit}..HEAD`).trim().split("\n");
    expect(log).toEqual(["implementer: recovered edits after interruption|implementer:sub"]);
    expect(s!.workspace!.repos[0]!.head).toBe(git(wt, "rev-parse", "HEAD").trim());

    const ev = eventsOf(s!.id);
    const resumed = ofType(ev, "resumed")[0]!;
    expect(resumed.data.actions).toEqual([expect.objectContaining({ kind: "reconcile_edits", policy: "commit", result: "interrupted; the uncommitted changes (src/app.ts) were committed as recovered. Re-read them before editing again." })]);
    // The model was told, in the edit's own tool message.
    const told = loop[1]!.messages.find((m) => m.role === "tool" && m.tool_call_id === "edit0");
    expect(told?.content).toMatch(/committed as recovered/);
    // The edit tool ran once: one intent (settled by the resume), no repeat.
    expect(ofType(ev, "tool_intent").filter((i) => i.data.name === "replace_in_file")).toHaveLength(1);
  }, 60_000);

  it("dies after an edit's intent but before it ran: nothing to recover, the model edits once more, and the file has the change once", async () => {
    env = makeEnv({ config: baseConfig({ coding: { runner: "native" } }) });
    // Edit until a tool result says the edit took effect, then submit.
    const client = new ScriptedClient((req) => {
      const s = servedFor(sy!, req);
      const n = turns(req);
      const edited = req.messages.some((m) => m.role === "tool" && m.content.startsWith("replaced"));
      if (!edited) return reply(null, { ...s, toolCalls: [call("replace_in_file", { path: "src/app.ts", old_text: "export function add", new_text: "export function subtract(a: number, b: number) {\n  return a - b;\n}\n\nexport function add" }, `edit${n}`)] });
      return reply(null, { ...s, toolCalls: [call("submit_result", goodOutput(1, "core:src/app.ts#L1-L3"), `submit${n}`)] });
    });
    const task = { profile: "implement", label: "sub", goal: "Add subtract(a, b) to src/app.ts", repositoryAliases: ["core"], writableRepository: "core", hints: { difficulty: "T2" }, constraints: { acceptanceCriteria: ["subtract exists"], allowedPaths: ["src/**"], checks: [check] } };
    const id = await crashThenRecover({ client, fault: "after_tool_intent:1:replace_in_file", submit: async (s) => (await s.submitTasks([task]))[0]!.taskId });
    const r = (await sy!.awaitResults([id], { timeoutSeconds: 60 })).completed[0]!;
    expect(r).toMatchObject({ executionStatus: "completed", acceptanceStatus: "met" });
    const [s] = runs(id);
    const wt = s!.workspace!.repos[0]!.worktree;
    expect(count(readFileSync(path.join(wt, "src/app.ts"), "utf8"), "export function subtract")).toBe(1);
    // Only the re-made edit's per-response commit: no recovered commit, since nothing had changed.
    const log = git(wt, "log", "--format=%s", `${s!.workspace!.repos[0]!.baseCommit}..HEAD`).trim().split("\n");
    expect(log).toEqual(["implementer: edit src/app.ts"]);
    const resumed = ofType(eventsOf(s!.id), "resumed")[0]!;
    expect(resumed.data.actions).toEqual([expect.objectContaining({ kind: "reconcile_edits", result: expect.stringMatching(/no uncommitted changes were found, so the edit did not apply/) })]);
  }, 60_000);
});

describe("lost response", () => {
  it("dies after a response was logged but before its tool calls ran: the response is restored, its calls marked not run, no request repeated", async () => {
    env = makeEnv();
    const client = new ScriptedClient((req) => reply(null, { ...servedFor(sy!, req), toolCalls: reader(req.messages) }));
    const id = await crashThenRecover({ client, fault: "after_model_response:1:tool_loop", submit: async (s) => (await s.submitTasks([inspectTask]))[0]!.taskId });
    const r = (await sy!.awaitResults([id], { timeoutSeconds: 30 })).completed[0]!;
    expect(r).toMatchObject({ executionStatus: "completed", stopReason: "worker_submitted" });
    // The logged response is reused (its turn rebuilt from the log); the model is asked again only for the next turn.
    expect(client.requests).toHaveLength(3);
    const second = client.requests[1]!.messages;
    expect(second.find((m) => m.role === "tool" && m.tool_call_id === "read0")?.content).toBe("interrupted before this call ran; call it again if it is still needed");
    const [s] = runs(id);
    const ev = eventsOf(s!.id);
    expect(ofType(ev, "model_response")).toHaveLength(3);
    expect(ofType(ev, "resumed")[0]!.data.droppedRequestSeqs).toEqual([]);
  });
});

function standaloneConfig() {
  const cfg = baseConfig({ coding: { runner: "native" }, supervisor: { max_workers_per_job: 2 } });
  (cfg.profiles as Record<string, unknown>).supervise = { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100, max_model_requests: 30, max_output_tokens: 4000, classify: "never", min_tier: "T3" };
  return cfg;
}

describe("supervisor", () => {
  it("dies after a delegation ran but before its outcome was logged: the re-run is deduplicated, one child task, one brief", async () => {
    env = makeEnv({ config: standaloneConfig() });
    const script = [
      () => [call("brain_set_current_state", { body: "**Plan:** delegate subtract()." }, "plan0"), call("delegate", { tasks: [{ label: "subtract", profile: "implement", goal: "Add subtract(a, b) to src/app.ts", acceptance_criteria: ["subtract exists"], allowed_paths: ["src/**"], checks: [check], difficulty: "T2" }] }, "delegate0")],
      () => [call("await_tasks", { timeout_seconds: 60 }, "await1")],
      () => [call("integrate_task", { task_id: "subtract" }, "integrate2")],
      () => [call("run_check", { command: check }, "check3")],
      () => [call("finish_job", { status: "completed", summary: "subtract() added and integrated", verified: [{ claim: "subtract exists on the job branch", evidence: "run_check exit 0" }], not_verified: [] }, "finish4")],
    ];
    const client = new ScriptedClient((req) => {
      const s = servedFor(sy!, req);
      if (isSupervisor(req)) return reply(null, { ...s, toolCalls: script[turns(req)]!() });
      if (turns(req) === 0) return reply(null, { ...s, toolCalls: [call("replace_in_file", { path: "src/app.ts", old_text: "export function add", new_text: "export function subtract(a: number, b: number) {\n  return a - b;\n}\n\nexport function add" }, "w-edit")] });
      return reply(null, { ...s, toolCalls: [call("submit_result", goodOutput(1, "core:src/app.ts#L1-L3"), "w-submit")] });
    });
    const id = await crashThenRecover({ client, fault: "after_tool_run:1:delegate", submit: async (s) => (await s.startJob({ goal: "Add subtract() to the app", repositories: ["core"], checks: [check], label: "subtract-job" })).taskId });
    const r = (await sy!.awaitResults([id], { timeoutSeconds: 120 })).completed[0]!;
    expect(r).toMatchObject({ stopReason: "supervisor_completed", acceptanceStatus: "met" });

    // Exactly one child task and one brief, though the delegation ran twice.
    const children = sy!.tasks.childrenOf(id);
    expect(children.map((c) => c.spec.label)).toEqual(["subtract"]);
    const doc = readFileSync(path.join(env.dir, `brain/projects/demo/working/job-${id}.md`), "utf8");
    expect(count(doc, "### Brief: subtract")).toBe(1);

    // The supervisor continued its own session; the re-run is journaled under the original call id.
    const [s, ...rest] = runs(id);
    expect(rest).toEqual([]);
    const ev = eventsOf(s!.id);
    const resumed = ofType(ev, "resumed")[0]!;
    expect(resumed.data.actions).toEqual([expect.objectContaining({ kind: "rerun_tool", sideEffect: "delegate", callId: "delegate0", result: expect.stringMatching(/^subtract -> \S+ \(\w+, already submitted\)$/) })]);
    expect(ofType(ev, "tool_intent").filter((i) => i.data.name === "delegate").map((i) => i.data.callId)).toEqual(["delegate0", "delegate0"]);
    // The child's session still names the supervisor's (only) session as its parent.
    expect(runs(children[0]!.row.id)[0]).toMatchObject({ parentSessionId: s!.id });

    // The integrated change is there once.
    const integration = s!.workspace!.repos[0]!.worktree;
    expect(count(readFileSync(path.join(integration, "src/app.ts"), "utf8"), "return a - b")).toBe(1);
  }, 180_000);
});

describe("completion task", () => {
  it("dies with a model request logged but not sent: it re-runs fresh in a new session linked to the dead one", async () => {
    env = makeEnv();
    const client = new ScriptedClient((req) => reply(JSON.stringify(goodOutput()), servedFor(sy!, req)));
    const id = await crashThenRecover({ client, fault: "after_model_request:1:completion", submit: async (s) => (await s.submitTasks([summarizeTask()]))[0]!.taskId });
    const r = (await sy!.awaitResults([id], { timeoutSeconds: 30 })).completed[0]!;
    expect(r).toMatchObject({ executionStatus: "completed", stopReason: "worker_answered" });
    const [dead, fresh, ...rest] = runs(id);
    expect(rest).toEqual([]);
    expect(dead).toMatchObject({ status: "interrupted", stopReason: "process_died", modelRequests: 1 });
    expect(fresh).toMatchObject({ status: "completed", previousSessionId: dead!.id, modelRequests: 1 });
    expect(ofType(eventsOf(fresh!.id), "resumed")).toEqual([]);
    // The dead run's request never reached the gateway; the fresh run made the only one.
    expect(client.requests).toHaveLength(1);
  });
});

describe("operator resume", () => {
  const task = { profile: "implement", label: "sub", goal: "Add subtract(a, b) to src/app.ts", repositoryAliases: ["core"], writableRepository: "core", hints: { difficulty: "T2" }, constraints: { acceptanceCriteria: ["subtract exists"], allowedPaths: ["src/**"], checks: [check] } };
  const coder = () =>
    new ScriptedClient((req) => {
      const s = servedFor(sy!, req);
      const n = turns(req);
      const edited = req.messages.some((m) => m.role === "tool" && (m.content.startsWith("replaced") || m.content.includes("committed as recovered")));
      if (!edited) return reply(null, { ...s, toolCalls: [call("replace_in_file", { path: "src/app.ts", old_text: "export function add", new_text: "export function subtract(a: number, b: number) {\n  return a - b;\n}\n\nexport function add" }, `edit${n}`)] });
      return reply(null, { ...s, toolCalls: [call("submit_result", goodOutput(1, "core:src/app.ts#L1-L3"), `submit${n}`)] });
    });

  it("resume <task> starts a coding task over in a fresh worktree, linked to the interrupted session", async () => {
    env = makeEnv({ config: baseConfig({ coding: { runner: "native" } }) });
    const id = await crashThenRecover({
      client: coder(),
      fault: "after_tool_run:1:replace_in_file",
      submit: async (s) => (await s.submitTasks([task]))[0]!.taskId,
      operator: (s, taskId) => {
        s.tasks.recoverExpiredLeases();
        s.sessions.markDeadRunning((x) => x.taskId !== taskId);
        expect(s.resumeTask(taskId)).toBe("queued");
      },
    });
    const r = (await sy!.awaitResults([id], { timeoutSeconds: 60 })).completed[0]!;
    expect(r).toMatchObject({ executionStatus: "completed", acceptanceStatus: "met" });
    const [old, fresh, ...rest] = runs(id);
    expect(rest).toEqual([]);
    expect(old).toMatchObject({ status: "interrupted", stopReason: "process_died" });
    expect(fresh).toMatchObject({ status: "completed", previousSessionId: old!.id });
    expect(fresh!.workspace!.repos[0]!.worktree).not.toBe(old!.workspace!.repos[0]!.worktree);
    // The old worktree keeps the dead run's uncommitted edit as evidence.
    expect(git(old!.workspace!.repos[0]!.worktree, "status", "--porcelain")).toMatch(/src\/app\.ts/);
  }, 60_000);

  it("resumeSession continues that session in its own worktree", async () => {
    env = makeEnv({ config: baseConfig({ coding: { runner: "native" } }) });
    let sessionId = "";
    const id = await crashThenRecover({
      client: coder(),
      fault: "after_tool_run:1:replace_in_file",
      submit: async (s) => (await s.submitTasks([task]))[0]!.taskId,
      operator: (s, taskId) => {
        sessionId = runs(taskId)[0]!.id;
        expect(() => s.resumeSession("s_nope")).toThrow(/unknown session/);
        // The session is still marked running (its process died): resumeSession settles it first.
        expect(s.resumeSession(sessionId)).toEqual({ taskId, state: "queued" });
      },
    });
    const r = (await sy!.awaitResults([id], { timeoutSeconds: 60 })).completed[0]!;
    expect(r).toMatchObject({ executionStatus: "completed", acceptanceStatus: "met" });
    const [only, ...rest] = runs(id);
    expect(rest).toEqual([]);
    expect(only).toMatchObject({ id: sessionId, status: "completed" });
    expect(ofType(eventsOf(sessionId), "resumed")).toHaveLength(1);
  }, 60_000);
});
