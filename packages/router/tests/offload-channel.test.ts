/**
 * Supervisor offload channel backend (lane B): ChannelService (MeritRouter.channel) and RunChannel
 * (RunContext.channel), driven through a real MeritRouter with fake runners and a scripted
 * provider. Temp configs and stores only.
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MeritRouter } from "../src/core/service.js";
import type { CodingRunner } from "../src/core/executor.js";
import { baseResult, type RunContext, type RunOutcome } from "../src/runners/types.js";
import { ChannelService, PROBE_PURPOSE, REWORK_EVENT, RunChannel, reworkEventFor } from "../src/core/channel-service.js";
import { ChannelMessageError, toolRefs, type ChannelAwaitOutcome } from "../src/core/channel.js";
import { SupervisorChannelStore } from "../src/storage/supervisor-channel.js";
import { openDatabase } from "../src/storage/db.js";
import { prepareWorkspace } from "../src/runners/coding/finish.js";
import { baseConfig, FakeProvider, goodOutput, makeEnv, open, reply, ScriptedClient, servedFor, summarizeTask, type Env } from "./helpers.js";

let env: Env | undefined;
let sy: MeritRouter | undefined;
const extra: MeritRouter[] = [];
afterEach(async () => {
  for (const r of extra.splice(0)) await r.close();
  await sy?.close();
  sy = undefined;
  env?.cleanup();
  env = undefined;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Test config: the implement profile never classifies (no classifier requests). */
function config() {
  const cfg = baseConfig();
  (cfg.profiles as Record<string, Record<string, unknown>>).implement!.classify = "never";
  return cfg;
}

function implementTask(extra: Record<string, unknown> = {}) {
  return {
    profile: "implement",
    goal: "Change the fixture so the channel test can observe the worker",
    repositoryAliases: ["core"],
    writableRepository: "core",
    hints: { difficulty: "T2" },
    constraints: { acceptanceCriteria: ["the fixture runner ran"], allowedPaths: ["src/**"] },
    ...extra,
  };
}

/** A coding runner whose behaviour each test scripts; it never makes model requests. */
function fakeRunner(script: (ctx: RunContext, call: number) => Promise<RunOutcome | void>): CodingRunner & { contexts: RunContext[] } {
  const contexts: RunContext[] = [];
  return {
    contexts,
    async run(ctx) {
      contexts.push(ctx);
      const out = await script(ctx, contexts.length);
      return out ?? { state: "failed", result: baseResult({ executionStatus: "failed", stopReason: "fixture_done", unresolvedCriteria: ["the fixture runner ran"] }) };
    },
  };
}

/** A provider that answers every request with a completion output whose summary is `summary`. */
function answering(summary: (req: Parameters<ScriptedClient["handler"]>[0]) => string) {
  return new ScriptedClient((req) => reply(JSON.stringify(goodOutput(1, "inline", { summary: summary(req) })), servedFor(sy!, req)));
}

async function until<T>(get: () => T | undefined | null | false, timeoutMs = 10_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) throw new Error("condition not reached");
    await sleep(20);
  }
}

const messagesOf = (req: { messages: Array<{ content: unknown }> }) => req.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");

describe("worker questions: post, wait without requests, reply", () => {
  it("wires RunContext.channel, waits without model requests, and resumes with the supervisor's answer", async () => {
    env = makeEnv({ config: config() });
    const client = answering(() => "unused");
    let outcome: ChannelAwaitOutcome | undefined;
    const runner = fakeRunner(async (ctx) => {
      expect(ctx.channel).toBeInstanceOf(RunChannel);
      const q = await ctx.channel!.postFromWorker({ taskId: ctx.taskId, kind: "question", body: "Which file holds the config?", idempotencyKey: "call-1" });
      outcome = await ctx.channel!.awaitReply(q.id, 10_000, ctx.signal);
    });
    sy = open(env, client, { worker: true, coding: runner });
    const [t] = await sy.submitTasks([implementTask()]);
    const question = await until(() => sy!.channel.listPendingForSupervisor().find((m) => m.taskId === t!.taskId));
    expect(question).toMatchObject({ kind: "question", direction: "worker_to_supervisor", status: "pending", body: "Which file holds the config?" });
    // The worker is waiting: no model request is made while it waits.
    await sleep(300);
    expect(client.requests).toHaveLength(0);
    expect(outcome).toBeUndefined();
    const answer = await sy.channel.replyFromSupervisor({ messageId: question.id, kind: "answer", body: "src/config.ts" });
    expect(answer).toMatchObject({ direction: "supervisor_to_worker", kind: "answer", inReplyTo: question.id });
    await sy.awaitResults([t!.taskId], { timeoutSeconds: 10 });
    expect(outcome).toMatchObject({ status: "answered", reply: { id: answer.id, status: "delivered", body: "src/config.ts" } });
    expect(client.requests).toHaveLength(0);
    // Answered requests leave the inbox; the wait is recorded on the task.
    expect(sy.channel.listPendingForSupervisor().filter((m) => m.taskId === t!.taskId)).toEqual([]);
    expect(sy.tasks.events(t!.taskId, 200).map((e) => e.type)).toEqual(expect.arrayContaining(["channel_wait", "channel_wait_end"]));
  }, 30_000);

  it("times out with 'no answer, proceed or stop', and rejects on abort and on cancellation", async () => {
    env = makeEnv({ config: config() });
    const seen: Array<ChannelAwaitOutcome | string> = [];
    let release!: () => void;
    const cancelWait = new Promise<void>((r) => (release = r));
    const runner = fakeRunner(async (ctx) => {
      const q = await ctx.channel!.postFromWorker({ taskId: ctx.taskId, kind: "blocked", body: "The fixture needs a decision" });
      const started = Date.now();
      seen.push(await ctx.channel!.awaitReply(q.id, 150, ctx.signal));
      expect(Date.now() - started).toBeGreaterThanOrEqual(140);
      const abort = new AbortController();
      setTimeout(() => abort.abort(new Error("caller stopped waiting")), 50);
      await ctx.channel!.awaitReply(q.id, 10_000, abort.signal).then(() => seen.push("resolved"), (e: Error) => seen.push(`rejected: ${e.message}`));
      release();
      // Cancellation aborts the run signal, which ends the wait.
      await ctx.channel!.awaitReply(q.id, 20_000, ctx.signal).then(() => seen.push("resolved"), () => seen.push("cancelled"));
    });
    sy = open(env, answering(() => "unused"), { worker: true, coding: runner });
    const [t] = await sy.submitTasks([implementTask()]);
    await cancelWait;
    await sleep(100);
    sy.cancelTasks([t!.taskId]);
    await sy.awaitResults([t!.taskId], { timeoutSeconds: 10 });
    expect(seen[0]).toMatchObject({ status: "timeout", guidance: "no answer, proceed or stop", request: { status: "pending" } });
    expect(seen[1]).toBe("rejected: caller stopped waiting");
    expect(seen[2]).toBe("cancelled");
    // The task finished: its unanswered request is expired, not left in the inbox.
    expect(sy.channel.listPendingForSupervisor()).toEqual([]);
    const all = new SupervisorChannelStore(sy.db).listForTask(t!.taskId);
    expect(all.map((m) => [m.kind, m.status])).toEqual([["blocked", "expired"]]);
  }, 30_000);

  it("survives a restart: pending rows reload, a reply recorded later reaches the waiter", async () => {
    env = makeEnv({ config: config() });
    const client = answering(() => "unused");
    const a = open(env, client);
    const [t] = await a.submitTasks([implementTask()]);
    const q = await a.channel.postFromWorker({ taskId: t!.taskId, kind: "question", body: "Proceed with plan B?", idempotencyKey: "call-7" });
    await a.close();

    sy = open(env, client);
    // Same idempotency key after the restart: the same message, not a duplicate.
    const again = await sy.channel.postFromWorker({ taskId: t!.taskId, kind: "question", body: "Proceed with plan B?", idempotencyKey: "call-7" });
    expect(again.id).toBe(q.id);
    expect(sy.channel.listPendingForSupervisor().map((m) => m.id)).toEqual([q.id]);
    const waiting = sy.channel.awaitReply(q.id, 5_000, new AbortController().signal);
    await sleep(150);
    await sy.channel.replyFromSupervisor({ messageId: q.id, kind: "deny", body: "No: stay on plan A" });
    expect(await waiting).toMatchObject({ status: "answered", reply: { kind: "deny", status: "delivered" } });
  });

  it("records exactly one reply when two supervisors answer at once", async () => {
    env = makeEnv({ config: config() });
    sy = open(env, answering(() => "unused"));
    const [t] = await sy.submitTasks([implementTask()]);
    const q = await sy.channel.postFromWorker({ taskId: t!.taskId, kind: "help", body: "Stuck on the build" });
    const other = openDatabase(env.cfg.storageDir);
    try {
      const otherStore = new SupervisorChannelStore(other);
      const results = await Promise.allSettled([
        sy.channel.replyFromSupervisor({ messageId: q.id, kind: "answer", body: "first" }),
        Promise.resolve().then(() => otherStore.answer(q.id, { kind: "answer", body: "second" }).reply),
        sy.channel.replyFromSupervisor({ messageId: q.id, kind: "answer", body: "third" }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const r of results.filter((r): r is PromiseRejectedResult => r.status === "rejected")) expect((r.reason as ChannelMessageError).code).toBe("already_answered");
      expect(new SupervisorChannelStore(sy.db).listForTask(t!.taskId).filter((m) => m.kind === "answer")).toHaveLength(1);
    } finally {
      other.close();
    }
  });
});

describe("tool requests and grants", () => {
  it("grants requested tools for the next turn and refuses write tools to a read-only task and unknown tools", async () => {
    env = makeEnv({ config: config() });
    sy = open(env, answering(() => "unused"));
    const [coding, readOnly] = await sy.submitTasks([implementTask(), { profile: "inspect", goal: "Look at the fixture readme", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["reports the title"] } }]);
    const req = await sy.channel.postFromWorker({ taskId: coding!.taskId, kind: "tool_request", body: "I need the web and a command runner", refs: toolRefs(["web_search", "run_command"]) });
    await expect(sy.channel.replyFromSupervisor({ messageId: req.id, kind: "grant", body: "web only", refs: toolRefs(["web_fetch"]) })).rejects.toThrow(/not requested/);
    await sy.channel.replyFromSupervisor({ messageId: req.id, kind: "grant", body: "web only", refs: toolRefs(["web_search"]) });
    expect(sy.channel.grantedTools(coding!.taskId)).toEqual(["web_search"]);
    expect(sy.channel.pendingForWorker(coding!.taskId).map((m) => m.kind)).toEqual(["grant"]);

    await expect(sy.channel.postFromWorker({ taskId: readOnly!.taskId, kind: "tool_request", body: "let me edit", refs: toolRefs(["write_file"]) })).rejects.toThrow(/read-only/);
    await expect(sy.channel.postFromWorker({ taskId: readOnly!.taskId, kind: "tool_request", body: "root please", refs: toolRefs(["sudo_everything"]) })).rejects.toThrow(/not worker tools/);
    // A write grant is refused even if the request slipped through to the store directly.
    const direct = new SupervisorChannelStore(sy.db).post({ taskId: readOnly!.taskId, direction: "worker_to_supervisor", kind: "tool_request", body: "edit", refs: toolRefs(["write_file"]) }).message;
    await expect(sy.channel.replyFromSupervisor({ messageId: direct.id, kind: "grant", body: "ok", refs: toolRefs(["write_file"]) })).rejects.toThrow(/read-only/);
    expect(sy.channel.grantedTools(readOnly!.taskId)).toEqual([]);
  });
});

describe("RunChannel boundaries", () => {
  it("speaks only for its own task and refuses supervisor calls", async () => {
    env = makeEnv({ config: config() });
    let checked = false;
    const runner = fakeRunner(async (ctx) => {
      const ch = ctx.channel!;
      await expect(ch.postFromWorker({ taskId: "someone-else", kind: "question", body: "hi" })).rejects.toThrow(/not someone-else/);
      await expect(ch.probe(ctx.taskId, "x")).rejects.toThrow(/supervisor call/);
      await expect(ch.rework(ctx.taskId, "x")).rejects.toThrow(/supervisor call/);
      expect(() => ch.listPendingForSupervisor()).toThrow(/not readable by a worker/);
      // A worker cannot answer its own request (that would let it grant itself tools).
      const own = await ch.postFromWorker({ taskId: ctx.taskId, kind: "tool_request", body: "web", refs: toolRefs(["web_search"]) });
      await expect(ch.replyFromSupervisor({ messageId: own.id, kind: "grant", body: "self", refs: toolRefs(["web_search"]) })).rejects.toThrow(/answers only supervisor probes/);
      checked = true;
    });
    sy = open(env, answering(() => "unused"), { worker: true, coding: runner });
    const [t] = await sy.submitTasks([implementTask()]);
    await sy.awaitResults([t!.taskId], { timeoutSeconds: 10 });
    expect(checked).toBe(true);
    expect(sy.channel.grantedTools(t!.taskId)).toEqual([]);
  }, 30_000);
});

describe("probe", () => {
  it("queues a probe for a running task; the worker answers it at its next turn with evidence refs", async () => {
    env = makeEnv({ config: config() });
    const runner = fakeRunner(async (ctx) => {
      const probe = await until(() => ctx.channel!.pendingForWorker(ctx.taskId).find((m) => m.kind === "probe"));
      await ctx.channel!.replyFromSupervisor({ messageId: probe.id, kind: "answer", body: "I changed src/app.ts only", refs: ["core:src/app.ts#L1-L3"] });
    });
    const client = answering(() => "unused");
    sy = open(env, client, { worker: true, coding: runner });
    const [t] = await sy.submitTasks([implementTask()]);
    await until(() => runner.contexts.length > 0);
    const probe = await sy.channel.probe(t!.taskId, "Which files did you touch?");
    expect(probe).toMatchObject({ direction: "supervisor_to_worker", kind: "probe", status: "pending" });
    const answer = await until(() => sy!.channel.listPendingForSupervisor().find((m) => m.inReplyTo === probe.id));
    expect(answer).toMatchObject({ direction: "worker_to_supervisor", kind: "answer", body: "I changed src/app.ts only", refs: ["core:src/app.ts#L1-L3"] });
    // The supervisor acknowledges the answer and it leaves the inbox.
    (sy.channel as ChannelService).acknowledge([answer.id]);
    expect(sy.channel.listPendingForSupervisor().find((m) => m.id === answer.id)).toBeUndefined();
    await sy.awaitResults([t!.taskId], { timeoutSeconds: 10 });
    expect(client.requests).toHaveLength(0);
  }, 30_000);

  it("answers a probe of a finished task from its recorded session through one gated read-only task", async () => {
    env = makeEnv({ config: config() });
    let probeRequest: Parameters<ScriptedClient["handler"]>[0] | undefined;
    const client = answering((req) => {
      const text = messagesOf(req);
      if (text.includes("Supervisor's question")) {
        probeRequest = req;
        return "The error happened at step 3 (boom).";
      }
      return "Log summary: ERROR boom at step 3";
    });
    sy = open(env, client, { worker: true });
    const [t] = await sy.submitTasks([summarizeTask()]);
    await sy.awaitResults([t!.taskId], { timeoutSeconds: 10 });
    const before = client.requests.length;

    const probe = await sy.channel.probe(t!.taskId, "At which step did the error happen?");
    expect(probe.status).toBe("answered");
    // One model request, sent through the gate for a new read-only task.
    expect(client.requests.length).toBe(before + 1);
    const text = messagesOf(probeRequest!);
    expect(text).toContain("At which step did the error happen?");
    expect(text).toContain(`Task ${t!.taskId}`);
    expect(text).toContain("Log summary: ERROR boom at step 3");
    const reply = (sy.channel as ChannelService).replyTo(probe.id)!;
    expect(reply).toMatchObject({ direction: "worker_to_supervisor", kind: "answer", status: "pending" });
    expect(reply.body).toContain("The error happened at step 3 (boom).");
    expect(reply.refs?.[0]).toBe(`task:${t!.taskId}`);
    const answerTaskId = reply.refs!.at(-1)!.replace(/^task:/, "");
    expect(answerTaskId).not.toBe(t!.taskId);
    expect(sy.listTasks(undefined, 10).find((x) => x.taskId === answerTaskId)).toMatchObject({ purpose: PROBE_PURPOSE, profile: "summarize" });
    expect(sy.channel.listPendingForSupervisor().map((m) => m.id)).toContain(reply.id);
  }, 30_000);

  it("answers from the record when a running task finishes without answering its probe", async () => {
    env = makeEnv({ config: config() });
    const runner = fakeRunner(async (ctx) => {
      // Sees the probe, ignores it, and finishes.
      await until(() => ctx.channel!.pendingForWorker(ctx.taskId).some((m) => m.kind === "probe"));
    });
    const client = answering(() => "The record shows the fixture runner stopped with fixture_done.");
    sy = open(env, client, { worker: true, coding: runner });
    const [t] = await sy.submitTasks([implementTask()]);
    await until(() => runner.contexts.length > 0);
    const probe = await sy.channel.probe(t!.taskId, "Why did you stop?");
    expect(probe.status).toBe("pending");
    const answer = await until(() => (sy!.channel as ChannelService).replyTo(probe.id), 20_000);
    expect(answer.body).toContain("fixture_done");
    expect(answer.refs?.[0]).toBe(`task:${t!.taskId}`);
  }, 30_000);
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" }).trim();
}

describe("rework", () => {
  it("creates a linked task in the same scope that starts from the prior candidate commit with the feedback", async () => {
    env = makeEnv({ config: config() });
    let candidate = "";
    let base = "";
    const seen: Array<{ start: string | null; head: string; content: string; worktree: string }> = [];
    const runner = fakeRunner(async (ctx, call) => {
      const { ws } = await prepareWorkspace(ctx);
      const file = path.join(ws.worktreePath, "src/app.ts");
      seen.push({ start: ctx.retry?.startFrom?.commit ?? null, head: git(ws.worktreePath, "rev-parse", "HEAD"), content: readFileSync(file, "utf8"), worktree: ws.worktreePath });
      if (call === 1) {
        base = ws.baseSha;
        writeFileSync(file, `${readFileSync(file, "utf8")}export const first = 1;\n`);
        git(ws.worktreePath, "add", "-A");
        git(ws.worktreePath, "commit", "-q", "-m", "first attempt\n\nAgent: implementer\nTask: t\nModel: fixture");
        candidate = git(ws.worktreePath, "rev-parse", "HEAD");
        return { state: "completed", result: baseResult({ summary: "first", changedPaths: ["src/app.ts"], baseCommits: { core: ws.baseSha } }) };
      }
    });
    sy = open(env, answering(() => "unused"), { worker: true, coding: runner });
    const [t] = await sy.submitTasks([implementTask({ label: "first-try", constraints: { acceptanceCriteria: ["the fixture runner ran"], allowedPaths: ["src/**"] } })]);
    await sy.awaitResults([t!.taskId], { timeoutSeconds: 20 });
    expect(candidate).toMatch(/^[0-9a-f]{40}$/);

    const reworkId = await sy.channel.rework(t!.taskId, "Also export a second constant named second.", ["src/app.ts exports second"]);
    // Idempotent: the same feedback returns the same rework task.
    expect(await sy.channel.rework(t!.taskId, "Also export a second constant named second.", ["src/app.ts exports second"])).toBe(reworkId);
    await sy.awaitResults([reworkId], { timeoutSeconds: 20 });

    const rework = sy.tasks.get(reworkId)!;
    expect(rework.spec.goal).toContain("Also export a second constant named second.");
    expect(rework.spec.goal.startsWith("Change the fixture so the channel test can observe the worker")).toBe(true);
    expect(rework.spec.constraints.acceptanceCriteria).toEqual(["the fixture runner ran", "src/app.ts exports second"]);
    expect(rework.spec.writableRepository).toBe("core");
    expect(rework.spec.constraints.allowedPaths).toEqual(["src/**"]);
    expect(rework.spec.context.baseCommits?.core).toBe(base);
    expect(reworkEventFor(sy.db, reworkId)).toMatchObject({ reworkOf: t!.taskId, start: { alias: "core", commit: candidate }, base });

    // The rework's worktree started at the candidate commit, with the first attempt's change in it.
    expect(seen).toHaveLength(2);
    expect(seen[1]!.start).toBe(candidate);
    expect(seen[1]!.head).toBe(candidate);
    expect(seen[1]!.content).toContain("export const first = 1;");
    expect(seen[1]!.worktree).not.toBe(seen[0]!.worktree);
    // The source checkout itself is untouched.
    expect(readFileSync(path.join(env.repo, "src/app.ts"), "utf8")).not.toContain("first");

    // Lineage and the settled notice on the original task.
    const store = new SupervisorChannelStore(sy.db);
    expect(store.reworkOf(reworkId)).toBe(t!.taskId);
    expect(store.reworksOf(t!.taskId)).toEqual([reworkId]);
    const notices = store.listForTask(t!.taskId).filter((m) => m.kind === "rework");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ status: "delivered", refs: [`task:${reworkId}`] });
    expect(notices[0]!.body).toContain("src/app.ts exports second");
  }, 60_000);

  it("refuses a running task, and repairs lineage left by a crash on reconcile", async () => {
    env = makeEnv({ config: config() });
    sy = open(env, answering(() => "unused"));
    const [queued] = await sy.submitTasks([implementTask()]);
    await expect(sy.channel.rework(queued!.taskId, "Do it differently please")).rejects.toThrow(/finished work/);
    await expect(sy.channel.rework("no-such-task", "Do it differently please")).rejects.toThrow(/unknown task/);

    // A rework task whose lineage was never recorded (crash between submit and link).
    sy.db.prepare("UPDATE tasks SET state='completed', finished_at=? WHERE id=?").run(Date.now(), queued!.taskId);
    const [orphan] = await sy.submitTasks([implementTask({ goal: "An orphaned rework of the fixture change for reconcile" })]);
    sy.tasks.event(orphan!.taskId, REWORK_EVENT, { reworkOf: queued!.taskId, feedback: "fix it", criteria: [], start: null, base: null });
    const store = new SupervisorChannelStore(sy.db);
    expect(store.reworkOf(orphan!.taskId)).toBeNull();
    await (sy.channel as ChannelService).reconcile();
    expect(store.reworkOf(orphan!.taskId)).toBe(queued!.taskId);
    expect(store.listForTask(queued!.taskId).filter((m) => m.kind === "rework").map((m) => m.status)).toEqual(["delivered"]);
  });
});

describe("split layout: each project's own store", () => {
  it("keeps channel rows in the project's store and answers a finished-task probe there", async () => {
    const alpha = mkdtempSync(path.join(tmpdir(), "meritrouter-test-offload-split-"));
    try {
      mkdirSync(path.join(alpha, "src"), { recursive: true });
      writeFileSync(path.join(alpha, "src", "app.ts"), "export const one = 1;\n");
      git(alpha, "init", "-q", "-b", "main");
      git(alpha, "add", "-A");
      git(alpha, "commit", "-q", "-m", "init");
      env = makeEnv({ config: baseConfig({ storage: { directory: ".meritrouter", layout: "split" }, repositories: {}, brain: { path: "brain", project: "alpha" }, projects: { alpha: { directory: alpha, repositories: { app: { path: alpha } } } } }) });
      const provider = new FakeProvider();
      sy = open(env, provider, { worker: true });
      await sy.createSplitProject({ slug: "alpha", directory: alpha });
      const [t] = await sy.submitTasks([summarizeTask()], { project: "alpha" });
      await sy.awaitResults([t!.taskId], { timeoutSeconds: 30, project: "alpha" });
      const chats = provider.chats().length;

      const probe = await sy.channel.probe(t!.taskId, "What did the log say?");
      expect(probe.status).toBe("answered");
      expect(provider.chats().length).toBe(chats + 1);
      const projectDb = sy.projectStores("alpha").db;
      // The rows live in alpha's own store, not the installation's.
      expect(new SupervisorChannelStore(projectDb).listForTask(t!.taskId).map((m) => m.kind)).toEqual(["probe", "answer"]);
      expect(sy.db.prepare("SELECT COUNT(*) AS n FROM channel_messages").get()).toEqual({ n: 0 });
      const inbox = sy.channel.listPendingForSupervisor("alpha");
      expect(inbox).toHaveLength(1);
      expect(inbox[0]).toMatchObject({ projectId: "alpha", inReplyTo: probe.id, kind: "answer" });
      expect(sy.channel.listPendingForSupervisor().map((m) => m.id)).toEqual([inbox[0]!.id]);
    } finally {
      await sy?.close();
      sy = undefined;
      rmSync(alpha, { recursive: true, force: true });
    }
  }, 60_000);
});
