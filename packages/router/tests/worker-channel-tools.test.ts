import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../src/storage/db.js";
import { TaskStore } from "../src/storage/tasks.js";
import { SupervisorChannelStore } from "../src/storage/supervisor-channel.js";
import { RunChannel } from "../src/core/channel-service.js";
import { capturedLease } from "../src/storage/task-leases.js";
import type { ChannelAwaitOutcome, ChannelMessage, SupervisorChannelService } from "../src/core/channel.js";
import { supervisorChannelTools } from "../src/harness/supervisor-channel-tools.js";
import type { HarnessEnv } from "../src/harness/tools.js";

const dbs: Db[] = [];
const dirs: string[] = [];
afterEach(() => {
  while (dbs.length) dbs.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tempDb(): Db {
  const dir = mkdtempSync(path.join(tmpdir(), "mr-worker-channel-"));
  dirs.push(dir);
  const db = openDatabase(dir);
  dbs.push(db);
  return db;
}

/** A fake SupervisorChannelService (per brief: tests use fakes for ctx.channel). */
function fakeChannel(overrides: Partial<SupervisorChannelService> = {}): SupervisorChannelService {
  return {
    postFromWorker: async () => { throw new Error("postFromWorker not stubbed"); },
    awaitReply: async () => { throw new Error("awaitReply not stubbed"); },
    replyFromSupervisor: async () => { throw new Error("replyFromSupervisor not stubbed"); },
    replyFromWorker: async () => { throw new Error("replyFromWorker not stubbed"); },
    probe: async () => { throw new Error("probe not stubbed"); },
    rework: async () => { throw new Error("rework not stubbed"); },
    pendingForWorker: () => [],
    grantedTools: () => [],
    listPendingForSupervisor: () => [],
    markDelivered: () => { throw new Error("markDelivered not stubbed"); },
    acknowledge: () => { throw new Error("acknowledge not stubbed"); },
    replyTo: () => null,
    messagesForTask: () => [],
    ...overrides,
  };
}

function baseEnv(db: Db, channel: SupervisorChannelService | undefined): HarnessEnv {
  return {
    ctx: {
      taskId: "worker",
      tasks: { db },
      now: Date.now,
      cfg: { team: { budget_request_wait_seconds: 300 } },
      signal: new AbortController().signal,
      channel,
    },
    toolInvocationId: "call-1",
  } as unknown as HarnessEnv;
}

function submitWorkerTask(db: Db) {
  const tasks = new TaskStore(db, Date.now);
  tasks.submit([{ id: "worker", profile: "implement", goal: "edit something", repositoryAliases: ["core"], writableRepository: "core", constraints: { acceptanceCriteria: ["x"], allowedPaths: ["src/**"] } } as never], { project: "alpha" });
  return tasks;
}

/** A real RunChannel (core/channel-service.ts), bound to taskId's captured lease: the worker's
 * own side of the channel, with lease and ownership checks enforced as in production. */
function claimedWorkerChannel(db: Db, taskId = "worker"): SupervisorChannelService {
  const tasks = new TaskStore(db, Date.now);
  const claimed = tasks.claim("owner", { maxConcurrent: 10, maxWritersPerRepo: 1, leaseMs: 30000, defaultTimeoutMs: 30000 });
  const stored = claimed.find((c) => c.row.id === taskId);
  if (!stored) throw new Error(`${taskId} was not claimable`);
  return new RunChannel({ db, tasks }, taskId, capturedLease(stored), Date.now);
}

const tool = (name: string) => supervisorChannelTools().find((t) => t.def.function.name === name)!;

describe("supervisor-channel worker tools: availability", () => {
  it("are offered only when ctx.channel is set; a legacy task without one sees none of them", () => {
    const withoutChannel = baseEnv(tempDb(), undefined);
    const withChannel = baseEnv(tempDb(), fakeChannel());
    for (const name of ["ask_supervisor", "request_tools", "report_blocked", "reply_supervisor"]) {
      expect(tool(name).available?.(withoutChannel)).toBe(false);
      expect(tool(name).available?.(withChannel)).toBe(true);
    }
  });
});

describe("ask_supervisor / report_blocked", () => {
  it("posts a question and returns the supervisor's answer, without the model spending a request to wait", async () => {
    const posted: unknown[] = [];
    let awaited: [string, number] | undefined;
    const channel = fakeChannel({
      postFromWorker: async (input) => { posted.push(input); return { id: "msg-1", kind: "question" } as unknown as ChannelMessage; },
      awaitReply: async (id, ms) => {
        awaited = [id, ms];
        return { status: "answered", request: { id } as unknown as ChannelMessage, reply: { id: "reply-1", kind: "answer", body: "Use packages/router/config.yaml", refs: [] } as unknown as ChannelMessage } satisfies ChannelAwaitOutcome;
      },
    });
    const env = baseEnv(tempDb(), channel);
    const out = JSON.parse(await tool("ask_supervisor").run({ question: "Which config file?" }, env));
    expect(posted).toEqual([{ taskId: "worker", kind: "question", body: "Which config file?", idempotencyKey: "call-1" }]);
    expect(awaited?.[0]).toBe("msg-1");
    expect(awaited?.[1]).toBeGreaterThan(0);
    expect(out).toEqual({ status: "answered", kind: "answer", body: "Use packages/router/config.yaml", refs: [] });
  });

  it("clamps an explicit timeout_seconds to the project's configured wait", async () => {
    let seenMs: number | undefined;
    const channel = fakeChannel({
      postFromWorker: async () => ({ id: "msg-1" }) as unknown as ChannelMessage,
      awaitReply: async (_id, ms) => { seenMs = ms; return { status: "timeout", request: { id: "msg-1" } as unknown as ChannelMessage, guidance: "no answer, proceed or stop" }; },
    });
    const env = baseEnv(tempDb(), channel);
    const out = JSON.parse(await tool("report_blocked").run({ reason: "missing dependency", timeout_seconds: 999_999 }, env));
    expect(seenMs).toBe(300_000); // clamped to team.budget_request_wait_seconds (300s)
    expect(out).toEqual({ status: "timeout", guidance: "no answer, proceed or stop" });
  });

  it("reports an expired wait plainly", async () => {
    const channel = fakeChannel({
      postFromWorker: async () => ({ id: "msg-1" }) as unknown as ChannelMessage,
      awaitReply: async () => ({ status: "expired", request: { id: "msg-1" } as unknown as ChannelMessage }),
    });
    const env = baseEnv(tempDb(), channel);
    const out = JSON.parse(await tool("report_blocked").run({ reason: "stuck" }, env));
    expect(out.status).toBe("expired");
  });
});

describe("request_tools", () => {
  it("refuses an unknown tool name before posting anything", async () => {
    let posts = 0;
    const channel = fakeChannel({ postFromWorker: async () => { posts++; return {} as unknown as ChannelMessage; } });
    const env = baseEnv(tempDb(), channel);
    await expect(tool("request_tools").run({ tools: ["rm_rf"], reason: "need it" }, env)).rejects.toThrow(/not a worker tool/);
    expect(posts).toBe(0);
  });

  it("posts a tool_request naming the tools as tool:<name> refs", async () => {
    let seenRefs: string[] | undefined;
    const channel = fakeChannel({
      postFromWorker: async (input) => { seenRefs = input.refs; return { id: "msg-1" } as unknown as ChannelMessage; },
      awaitReply: async () => ({ status: "answered", request: { id: "msg-1" } as unknown as ChannelMessage, reply: { id: "r1", kind: "grant", body: "ok", refs: ["tool:web_search"] } as unknown as ChannelMessage }),
    });
    const env = baseEnv(tempDb(), channel);
    const out = JSON.parse(await tool("request_tools").run({ tools: ["web_search"], reason: "need to check the current API" }, env));
    expect(seenRefs).toEqual(["tool:web_search"]);
    expect(out).toEqual({ status: "answered", kind: "grant", body: "ok", refs: ["tool:web_search"] });
  });
});

describe("reply_supervisor", () => {
  it("answers a pending probe for its own task, recorded through the real SupervisorChannelStore", async () => {
    const db = tempDb();
    submitWorkerTask(db);
    const store = new SupervisorChannelStore(db);
    const { message: probe } = store.post({ taskId: "worker", direction: "supervisor_to_worker", kind: "probe", body: "Did you check the error path?" });
    const env = baseEnv(db, claimedWorkerChannel(db));
    const out = JSON.parse(await tool("reply_supervisor").run({ message_id: probe.id, answer: "Yes, it returns a 400 with a message." }, env));
    expect(out.status).toBe("answered");
    const reply = store.get(out.messageId);
    expect(reply).toMatchObject({ kind: "answer", direction: "worker_to_supervisor", inReplyTo: probe.id, body: "Yes, it returns a 400 with a message." });
    expect(store.get(probe.id)?.status).toBe("answered");
  });

  it("refuses a message id for another task", async () => {
    const db = tempDb();
    const tasks = new TaskStore(db, Date.now);
    tasks.submit([
      { id: "worker", profile: "implement", goal: "a", repositoryAliases: ["core"], writableRepository: "core", constraints: { acceptanceCriteria: ["x"], allowedPaths: ["src/**"] } } as never,
      { id: "other", profile: "implement", goal: "b", repositoryAliases: ["core"], writableRepository: "core", constraints: { acceptanceCriteria: ["x"], allowedPaths: ["src/**"] } } as never,
    ], { project: "alpha" });
    const store = new SupervisorChannelStore(db);
    const { message: probe } = store.post({ taskId: "other", direction: "supervisor_to_worker", kind: "probe", body: "for the other task" });
    // This worker's channel is bound to "worker", so a probe on "other" is not its own message.
    const env = baseEnv(db, claimedWorkerChannel(db, "worker"));
    await expect(tool("reply_supervisor").run({ message_id: probe.id, answer: "nope" }, env)).rejects.toThrow(/unknown message/);
  });

  it("refuses to answer a non-probe message as if it were one", async () => {
    const db = tempDb();
    submitWorkerTask(db);
    const store = new SupervisorChannelStore(db);
    const { message: question } = store.post({ taskId: "worker", direction: "worker_to_supervisor", kind: "question", body: "what now?" });
    const env = baseEnv(db, claimedWorkerChannel(db));
    await expect(tool("reply_supervisor").run({ message_id: question.id, answer: "x" }, env)).rejects.toThrow(/answers only supervisor probes/);
  });
});
