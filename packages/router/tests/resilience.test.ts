import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import Database from "better-sqlite3";
import type { Switchyard } from "../src/core/service.js";
import { GatewayError } from "../src/core/errors.js";
import type { ChatMessage, ChatRequest, ChatResponse, InferenceClient } from "../src/gateway/types.js";
import { CircuitBreakers, countsAsProviderFailure, openDurationMs, readBreakerRecords, type BreakerSettings } from "../src/gateway/breaker.js";
import { planRoute } from "../src/routing/select.js";
import { watchdogVerdict, type SessionProgress } from "../src/core/watchdog.js";
import { openDatabase, type Db } from "../src/storage/db.js";
import { parseConfig } from "../src/config/load.js";
import * as insights from "../src/admin/insights.js";
import type { SessionEvent, SessionEventOf } from "../src/sessions/events.js";
import { baseConfig, endpoint, goodOutput, makeEnv, open, reply, ScriptedClient, servedFor, summarizeTask, type Env } from "./helpers.js";

/**
 * R1b: the progress watchdog, per-provider circuit breakers, and the R1 acceptance test (a real
 * worker process killed mid-run and restarted on the same storage resumes its session).
 */

let env: Env | undefined;
let sy: Switchyard | undefined;
let db: Db | undefined;
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  await sy?.close();
  sy = undefined;
  db?.close();
  db = undefined;
  env?.cleanup();
  env = undefined;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const call = (name: string, args: unknown, id = name) => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
const turnsIn = (messages: ChatMessage[]) => messages.filter((m) => m.role === "assistant").length;
const ofType = <T extends SessionEvent["type"]>(events: SessionEvent[], type: T): SessionEventOf<T>[] => events.filter((e): e is SessionEventOf<T> => e.type === type);
async function until(what: string, ok: () => boolean, timeoutMs = 20_000, stepMs = 50): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(stepMs);
  }
}

const SETTINGS: BreakerSettings = { enabled: true, failure_threshold: 3, open_seconds: 10, max_open_seconds: 35 };

describe("circuit breaker", () => {
  it("counts only provider and transport failures, and 429s outside a reported cooldown", () => {
    const e = (kind: GatewayError["kind"], status?: number) => new GatewayError(kind, "x", status);
    expect(countsAsProviderFailure(e("server", 502), false)).toBe(true);
    expect(countsAsProviderFailure(e("timeout"), false)).toBe(true);
    expect(countsAsProviderFailure(e("transport"), false)).toBe(true);
    expect(countsAsProviderFailure(e("rate_limited", 429), false)).toBe(true);
    expect(countsAsProviderFailure(e("rate_limited", 429), true)).toBe(false);
    expect(countsAsProviderFailure(e("pool_exhausted", 503), false)).toBe(true);
    expect(countsAsProviderFailure(e("pool_exhausted", 402), false)).toBe(false);
    for (const k of ["bad_request", "unknown_model", "auth", "policy_violation", "aborted"] as const) expect(countsAsProviderFailure(e(k, 400), false)).toBe(false);
  });

  it("opens at the threshold, admits one half-open probe, doubles the backoff on a failed probe up to the cap, and closes on success", () => {
    let now = 1_000_000;
    const b = new CircuitBreakers(() => now);
    b.attach(openDb(), () => SETTINGS);
    b.failure("groq", "server: 502");
    b.failure("groq", "server: 502");
    expect(b.get("groq")).toMatchObject({ state: "closed", failures: 2 });
    // A success in between resets the streak.
    b.success("groq");
    expect(b.get("groq")).toMatchObject({ state: "closed", failures: 0 });
    for (let i = 0; i < 3; i++) b.failure("groq", "timeout");
    expect(b.get("groq")).toMatchObject({ state: "open", failures: 3, opens: 1, openUntil: now + 10_000 });
    expect(b.admit("groq")).toBe(false);
    expect(b.blockedUntil("groq")).toBe(now + 10_000);
    expect(b.admit("other")).toBe(true);

    now += 10_000;
    expect(b.blockedUntil("groq")).toBeNull(); // due: the next request becomes the probe
    expect(b.admit("groq")).toBe(true);
    expect(b.get("groq")).toMatchObject({ state: "half_open", probing: true });
    expect(b.admit("groq")).toBe(false); // only one probe
    expect(b.blockedUntil("groq")).toBe(now);
    b.failure("groq", "server: 500");
    expect(b.get("groq")).toMatchObject({ state: "open", opens: 2, openUntil: now + 20_000 });

    now += 20_000;
    expect(b.admit("groq")).toBe(true);
    b.failure("groq", "server: 500");
    expect(b.get("groq")).toMatchObject({ opens: 3, openUntil: now + 35_000 }); // 40 s capped at 35 s
    expect(openDurationMs(SETTINGS, 10)).toBe(35_000);

    now += 35_000;
    expect(b.admit("groq")).toBe(true);
    // An aborted probe frees the slot without a verdict.
    b.release("groq");
    expect(b.get("groq")).toMatchObject({ state: "half_open", probing: false });
    expect(b.admit("groq")).toBe(true);
    b.success("groq");
    expect(b.get("groq")).toMatchObject({ state: "closed", failures: 0, opens: 0, openUntil: null });
    expect(b.admit("groq")).toBe(true);
  });

  it("mirrors state to the store so a restarted process keeps an open breaker, and is inert when disabled", () => {
    let now = 5_000;
    const store = openDb();
    const a = new CircuitBreakers(() => now);
    a.attach(store, () => SETTINGS);
    for (let i = 0; i < 3; i++) a.failure("groq", "transport: refused");
    expect(readBreakerRecords(store)).toEqual([expect.objectContaining({ platform: "groq", state: "open", lastFailure: "transport: refused" })]);
    const b = new CircuitBreakers(() => now);
    b.attach(store, () => SETTINGS);
    expect(b.admit("groq")).toBe(false);
    const off = new CircuitBreakers(() => now);
    off.attach(store, () => ({ ...SETTINGS, enabled: false }));
    expect(off.admit("groq")).toBe(true);
    expect(off.blockedUntil("groq")).toBeNull();
    now += 10_000;
    expect(b.admit("groq")).toBe(true);
  });
});

function openDb(): Db {
  const dir = mkdtempSync(path.join(tmpdir(), "switchyard-breaker-"));
  const d = openDatabase(dir);
  cleanups.push(() => {
    d.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return d;
}

const small = endpoint({ providerId: "groq", gatewayModelId: "small:free", totalParametersB: 70 });
const big = endpoint();

describe("routing with open breakers", () => {
  it("ranks a platform with an open breaker after cooling ones and explains why", () => {
    const e = makeEnv({ endpoints: [small, big, endpoint({ providerId: "mistral", gatewayModelId: "mid:free", totalParametersB: 120 })] });
    env = e;
    sy = open(e, new ScriptedClient(() => reply("ok")));
    const health = (platform: string) =>
      platform === "groq" ? { status: "healthy", resumeAt: null, circuitOpenUntil: 99 } : platform === "mistral" ? { status: "rate_limited", resumeAt: Date.now() + 60_000 } : undefined;
    const plan = planRoute(sy.cfg, sy.catalog.endpoints(), [], { profile: "summarize", tier: "T1", inputModalities: ["text"], needsStructuredOutput: false }, { now: new Date(), qualification: () => null, health });
    expect(plan.candidates.map((c) => c.providerId)).toEqual(["openrouter", "mistral", "groq"]);
    expect(plan.explanations.find((x) => x.endpointId.startsWith("groq"))).toMatchObject({ eligible: true, circuitOpenUntil: 99, coolingDownUntil: null });
  });

  it("the gate skips a failing provider once its breaker opens, probes it after the backoff, and insights show the state", async () => {
    let offset = 0;
    const e = makeEnv({ endpoints: [small, big], config: baseConfig({ routing: { circuit_breaker: { failure_threshold: 3, open_seconds: 30 } } }) });
    env = e;
    let groqUp = false;
    const client = new ScriptedClient((req) => {
      const s = servedFor(sy!, req);
      if (s.provider === "groq" && !groqUp) throw new GatewayError("server", "gateway HTTP 502: upstream down", 502, undefined, true);
      return reply(JSON.stringify(goodOutput()), s);
    });
    sy = open(e, client, { worker: true, now: () => Date.now() + offset });
    const run = async () => {
      const [t] = await sy!.submitTasks([summarizeTask()]);
      return (await sy!.awaitResults([t!.taskId], { timeoutSeconds: 20 })).completed[0]!;
    };
    // groq is the smaller model, so it is tried first and fails over to openrouter.
    for (let i = 0; i < 3; i++) {
      const r = await run();
      expect(r).toMatchObject({ executionStatus: "completed" });
      expect(r.routing!.attempts.map((a) => a.outcome)).toEqual(["server", "succeeded"]);
    }
    // Open: routing ranks groq last, so openrouter answers and groq is never dispatched.
    const opened = await run();
    expect(opened.routing!.attempts).toEqual([{ endpointId: big.id, outcome: "succeeded" }]);
    // A plan made before the breaker opened still ranks groq first: the gate itself skips it.
    const stale = planRoute(sy.cfg, sy.catalog.endpoints(), [], { profile: "summarize", tier: "T1", inputModalities: ["text"], needsStructuredOutput: false }, { now: new Date(), qualification: () => null });
    expect(stale.candidates.map((c) => c.id)).toEqual([small.id, big.id]);
    const viaGate = await sy.gate.request({ plan: stale, executionId: sy.gate.admission.createExecution("task", "summarize", []), purpose: "completion", participants: [], chat: { messages: [{ role: "user", content: "hi" }], max_tokens: 10 } });
    expect(viaGate.attempts).toEqual([
      { endpointId: small.id, outcome: "skipped: circuit open for groq" },
      { endpointId: big.id, outcome: "succeeded" },
    ]);
    const view = await insights.providerHealth(sy);
    expect(view.breakers).toEqual([expect.objectContaining({ platform: "groq", state: "open", effective: "open", failures: 3, opens: 1 })]);
    expect(view.breakers[0]!.probeInMs).toBeGreaterThan(0);
    expect(view.settings).toMatchObject({ failure_threshold: 3, open_seconds: 30 });
    // The route preview shows it too.
    expect(insights.routingPreview(sy, "summarize", "T1").explanations.map((x) => [x.endpointId, x.circuitOpenUntil !== null])).toEqual([
      [big.id, false],
      [small.id, true],
    ]);

    // After the backoff one probe goes through; it succeeds and closes the breaker.
    offset += 31_000;
    groqUp = true;
    const probed = await run();
    expect(probed.routing!.attempts.map((a) => [a.endpointId, a.outcome])).toEqual([[small.id, "succeeded"]]);
    expect((await insights.providerHealth(sy)).breakers[0]).toMatchObject({ state: "closed", effective: "closed", failures: 0 });
  }, 60_000);

  it("when every candidate is behind an open breaker the request waits for capacity instead of failing", async () => {
    const e = makeEnv({ endpoints: [small] });
    env = e;
    sy = open(e, new ScriptedClient(() => reply("never")));
    for (let i = 0; i < 5; i++) sy.health.breakers.failure("groq", "server: 500");
    const plan = planRoute(sy.cfg, sy.catalog.endpoints(), [], { profile: "summarize", tier: "T1", inputModalities: ["text"], needsStructuredOutput: false }, { now: new Date(), qualification: () => null, health: sy.health.lookup });
    expect(plan.candidates).toHaveLength(1);
    const err = await sy.gate.request({ plan, executionId: "x", purpose: "completion", participants: [], chat: { messages: [{ role: "user", content: "hi" }], max_tokens: 10 } }).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(GatewayError);
    expect(err).toMatchObject({ kind: "rate_limited", possiblyConsumed: false, attempts: [{ endpointId: small.id, outcome: "skipped: circuit open for groq" }] });
    expect((err as GatewayError).retryAfterMs).toBeGreaterThan(25_000);
  });
});

describe("progress watchdog", () => {
  const cfg = parseConfig(baseConfig({ execution: { watchdog_minutes: 10, check_timeout_seconds: 900 }, gateway: { adapter: "freellmapi", base_url: "http://127.0.0.1:9/v1", request_timeout_seconds: 60 } }), path.join(tmpdir(), "x.yaml"));
  const at = 1_000_000;
  const min = 60_000;
  const v = (p: Partial<SessionProgress>, idle: number, checks = 0) => watchdogVerdict(cfg, { at, type: null, name: null, ...p }, at + idle, { checks });

  it("calls a session stuck after watchdog_minutes without an event, measured on the session's own clock", () => {
    expect(v({ type: "tool_outcome", name: "read_file" }, 10 * min)).toMatchObject({ kind: "ok", allowanceMs: 10 * min });
    expect(v({ type: "tool_outcome", name: "read_file" }, 10 * min + 1)).toMatchObject({ kind: "stuck", idleMs: 10 * min + 1 });
    expect(v({ type: "message" }, 11 * min)).toMatchObject({ kind: "stuck" });
  });

  it("extends the allowance for a running tool, a pending request, a response's tool calls, and final checks", () => {
    // A tool intent without outcome (a check running): the check timeout plus a margin.
    expect(v({ type: "tool_intent", name: "run_command" }, 15 * min)).toMatchObject({ kind: "ok", allowanceMs: 16 * min });
    expect(v({ type: "tool_intent", name: "run_command" }, 16 * min + 1)).toMatchObject({ kind: "stuck" });
    expect(v({ type: "model_response" }, 15 * min)).toMatchObject({ kind: "ok" });
    // A pending model request: every endpoint the gate may try times the gateway timeout (60 s x 5) is under 10 min.
    expect(v({ type: "model_request", name: "tool_loop" }, 10 * min + 1)).toMatchObject({ kind: "stuck", allowanceMs: 10 * min, waitingOn: "model request (tool_loop)" });
    // Final checks run unjournaled after the loop: each one's timeout counts.
    expect(v({ type: "tool_outcome", name: "submit_result" }, 30 * min, 2)).toMatchObject({ kind: "ok", allowanceMs: 31 * min });
    expect(v({ type: "tool_outcome", name: "submit_result" }, 31 * min + 1, 2)).toMatchObject({ kind: "stuck" });
  });

  it("exempts supervisors waiting in await_tasks or ask_user, and is off at 0", () => {
    expect(v({ type: "tool_intent", name: "await_tasks" }, 600 * min)).toEqual({ kind: "exempt", reason: "waiting in await_tasks" });
    expect(v({ type: "tool_intent", name: "ask_user" }, 600 * min)).toEqual({ kind: "exempt", reason: "waiting in ask_user" });
    const off = parseConfig(baseConfig({ execution: { watchdog_minutes: 0 } }), path.join(tmpdir(), "x.yaml"));
    expect(watchdogVerdict(off, { at, type: "message", name: null }, at + 600 * min, { checks: 0 })).toEqual({ kind: "disabled" });
  });

  it("aborts a stuck run as interrupted (watchdog) and the task resumes the same session to completion", async () => {
    let offset = 0;
    const e = makeEnv({ config: baseConfig({ execution: { max_concurrent_tasks: 4, lease_seconds: 3600, job_timeout_seconds: 7200 }, gateway: { adapter: "freellmapi", base_url: "http://127.0.0.1:9/v1", require_verified_chains: false, request_timeout_seconds: 10 } }) });
    env = e;
    let hung = 0;
    const requests: ChatRequest[] = [];
    const client: InferenceClient = {
      name: "hanging",
      complete(req, signal) {
        requests.push(structuredClone(req));
        const s = servedFor(sy!, req);
        const read = req.messages.some((m) => m.role === "tool" && m.content.startsWith("ref: core:src/app.ts"));
        if (!read) return Promise.resolve(reply(null, { ...s, toolCalls: [call("read_file", { alias: "core", path: "src/app.ts" }, `read${turnsIn(req.messages)}`)] }));
        if (hung++ === 0) {
          // The provider never answers; only the abort ends this request.
          return new Promise<ChatResponse>((_, reject) => signal?.addEventListener("abort", () => reject(new GatewayError("aborted", "request aborted by caller"))));
        }
        return Promise.resolve(reply(null, { ...s, toolCalls: [call("submit_result", goodOutput(1, "core:src/app.ts#L1-L3"), "submit")] }));
      },
    };
    sy = open(e, client, { worker: true, now: () => Date.now() + offset });
    const [t] = await sy.submitTasks([{ profile: "inspect", label: "find-add", goal: "Where is add() defined?", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["names the file"] } }]);
    const id = t!.taskId;
    await until("the second request to hang", () => hung === 1);
    // Nine minutes of silence is still within the allowance.
    offset += 9 * 60_000;
    await sleep(300);
    expect(sy.getStatus([id])[0]).toMatchObject({ state: "running" });
    offset += 2 * 60_000;
    const r = (await sy.awaitResults([id], { timeoutSeconds: 20 })).completed[0]!;
    expect(r).toMatchObject({ executionStatus: "completed", stopReason: "worker_submitted" });
    expect(requests).toHaveLength(3);

    const sessions = sy.sessions.forTask(id).filter((s) => s.role !== "classifier");
    expect(sessions).toHaveLength(1);
    const ev = sy.sessions.events(sessions[0]!.id, { limit: 10_000 })!.events;
    expect(ofType(ev, "ended").map((x) => [x.data.status, x.data.stopReason])).toEqual([
      ["interrupted", "watchdog"],
      ["completed", "worker_submitted"],
    ]);
    expect(ofType(ev, "resumed")).toHaveLength(1);
    // The hung request ended with the abort (logged as its error), so the resume had nothing to drop.
    const firstEnd = ev.findIndex((x) => x.type === "ended");
    expect(ofType(ev.slice(0, firstEnd), "model_error").map((x) => x.data.code)).toEqual(["gateway:aborted"]);
    const taskEvents = sy.tasks.events(id, 500).map((x) => x.type);
    expect(taskEvents).toEqual(expect.arrayContaining(["watchdog_abort", "interrupted", "resumed", "session_resumed"]));
    const abort = sy.tasks.events(id, 500).find((x) => x.type === "watchdog_abort")!.data as { waitingOn: string; allowanceMs: number };
    expect(abort).toMatchObject({ waitingOn: "model request (tool_loop)", allowanceMs: 10 * 60_000 });
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------
// R1 acceptance: a real worker process killed mid-run resumes its session after a restart.

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

interface FakeGateway {
  baseUrl: string;
  chats: Array<{ messages: ChatMessage[] }>;
  close: () => Promise<void>;
}

/** A FreeLLMAPI double over HTTP: GET /v1/providers and POST /v1/chat/completions. */
async function fakeGateway(answer: (body: { model: string; messages: ChatMessage[] }, n: number) => { toolCalls: unknown[] } | "hang"): Promise<FakeGateway> {
  const chats: FakeGateway["chats"] = [];
  const hanging = new Set<ServerResponse>();
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
    req.on("end", () => {
      if (req.method === "GET" && req.url?.endsWith("/providers")) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ providers: [] }));
        return;
      }
      if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse(raw) as { model: string; messages: ChatMessage[] };
      chats.push({ messages: body.messages });
      const a = answer(body, chats.length);
      if (a === "hang") {
        hanging.add(res);
        res.on("close", () => hanging.delete(res));
        return;
      }
      res
        .writeHead(200, { "content-type": "application/json", "x-routed-via": "openrouter/vendor/big-a:free", "x-request-id": `r${chats.length}` })
        .end(
          JSON.stringify({
            id: `c${chats.length}`,
            object: "chat.completion",
            model: "vendor/big-a:free",
            choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: a.toolCalls }, finish_reason: "tool_calls" }],
            usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
          }),
        );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    chats,
    close: () =>
      new Promise<void>((r) => {
        for (const res of hanging) res.destroy();
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

function startWorker(configPath: string, cwd: string): ChildProcess {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, FREELLMAPI_API_KEY: "test-key" };
  delete childEnv.SWITCHYARD_FAULT_AT;
  const child = spawn(process.execPath, [CLI, "worker", "--config", configPath], { cwd, env: childEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let log = "";
  child.stdout?.on("data", (c: Buffer) => (log += c.toString("utf8")));
  child.stderr?.on("data", (c: Buffer) => (log += c.toString("utf8")));
  (child as ChildProcess & { log: () => string }).log = () => log;
  return child;
}

/** Kill hard, as a power cut or Task Manager would: no signal handlers, no cleanup. */
async function killHard(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "pipe" });
    } catch {
      // taskkill fails when a grandchild (git, a check) exits or cannot be killed mid-walk; the
      // worker itself is normally gone by then. Fall back only if it is still running.
      const gone = await Promise.race([exited.then(() => true), sleep(5000).then(() => false)]);
      if (!gone) child.kill("SIGKILL");
    }
  } else child.kill("SIGKILL");
  await exited;
}

describe("R1 acceptance: kill and restart a worker process", () => {
  it.skipIf(!existsSync(CLI))("a native coding run killed mid-request resumes its session in a restarted worker, with the edit made once (needs dist/cli.js: pnpm --filter switchyard-router build)", async () => {
    const edit = call("replace_in_file", { path: "src/app.ts", old_text: "export function add", new_text: "export function subtract(a: number, b: number) {\n  return a - b;\n}\n\nexport function add" }, "edit0");
    let hangs = 0;
    const gw = await fakeGateway((body) => {
      if (turnsIn(body.messages) === 0) return { toolCalls: [edit] };
      // The first request after the edit never gets an answer: the worker is killed while waiting.
      if (hangs++ === 0) return "hang";
      return { toolCalls: [call("submit_result", goodOutput(1, "core:src/app.ts#L1-L5"), "submit1")] };
    });
    cleanups.push(() => gw.close());
    const check = `node -e "process.exit(require('fs').readFileSync('src/app.ts','utf8').includes('subtract')?0:1)"`;
    const raw = baseConfig({
      gateway: { adapter: "freellmapi", base_url: gw.baseUrl, require_verified_chains: false },
      execution: { max_concurrent_tasks: 2, lease_seconds: 10 },
      coding: { runner: "native" },
      profiles: { implement: { mode: "coding", min_total_parameters_b: 100, max_model_requests: 8, tools: "scoped_edit_and_checks", workspace: "isolated_worktree", classify: "never" } },
    });
    env = makeEnv({ config: raw });
    const configPath = env.cfg.configPath;

    // Submit from a process that runs no tasks, then hand the queue to a real worker process.
    const submitter = open(env, new ScriptedClient(() => reply("unused")), { worker: false });
    const [t] = await submitter.submitTasks([{ profile: "implement", label: "sub", goal: "Add subtract(a, b) to src/app.ts", repositoryAliases: ["core"], writableRepository: "core", constraints: { acceptanceCriteria: ["subtract exists"], allowedPaths: ["src/**"], checks: [check] } }]);
    await submitter.close();
    const id = t!.taskId;

    const children: ChildProcess[] = [];
    cleanups.push(async () => {
      for (const c of children) await killHard(c).catch(() => undefined);
    });
    const first = startWorker(configPath, env.dir);
    children.push(first);
    db = new Database(path.join(env.cfg.storageDir, "switchyard.db"), { readonly: true, fileMustExist: false });
    const describeChild = (c: ChildProcess) => `exit=${c.exitCode} log=${(c as ChildProcess & { log: () => string }).log()}`;
    await until(`the worker's second model request (${describeChild(first)})`, () => hangs === 1, 30_000);
    const sessionId = (db.prepare("SELECT id FROM sessions WHERE task_id = ? AND role != 'classifier'").get(id) as { id: string }).id;
    const before = db.prepare("SELECT type, name FROM session_events WHERE session_id = ? ORDER BY seq").all(sessionId) as Array<{ type: string; name: string | null }>;
    expect(before.filter((e) => e.type === "tool_intent").map((e) => e.name)).toEqual(["replace_in_file"]);
    expect(before.filter((e) => e.type === "model_request")).toHaveLength(2);
    expect(before.at(-1)!.type).toBe("model_request");

    await killHard(first);
    const row = () => db!.prepare("SELECT state, lease_expires_at FROM tasks WHERE id = ?").get(id) as { state: string; lease_expires_at: number | null };
    expect(row().state).toBe("running");
    // A restarted worker recovers the task once its dead owner's lease has expired.
    await until("the dead worker's lease to expire", () => Date.now() > (row().lease_expires_at ?? 0) + 200, 15_000);

    const second = startWorker(configPath, env.dir);
    children.push(second);
    await until(`the task to finish in the restarted worker (${describeChild(second)})`, () => ["completed", "failed", "cancelled"].includes(row().state), 40_000, 100);
    await killHard(second);
    db.close();
    db = undefined;

    sy = open(env, new ScriptedClient(() => reply("unused")), { worker: false });
    const status = sy.getStatus([id])[0]!;
    expect(status).toMatchObject({ state: "completed" });
    const result = sy.collectResults([id]).completed[0]!;
    expect(result).toMatchObject({ executionStatus: "completed", stopReason: "worker_submitted", acceptanceStatus: "met" });

    // One session, resumed: died with the process, then finished.
    const sessions = sy.sessions.forTask(id).filter((s) => s.role !== "classifier");
    expect(sessions.map((s) => s.id)).toEqual([sessionId]);
    const ev = sy.sessions.events(sessionId, { limit: 10_000 })!;
    expect(ev.corrupt).toEqual([]);
    expect(ofType(ev.events, "ended").map((x) => x.data.stopReason)).toEqual(["process_died", "worker_submitted"]);
    expect(ofType(ev.events, "resumed")).toHaveLength(1);
    expect(ofType(ev.events, "resumed")[0]!.data.droppedRequestSeqs).toHaveLength(1);

    // No duplicated side effects: the edit ran once, the file has it once, three requests in all.
    expect(ofType(ev.events, "tool_intent").filter((x) => x.data.name === "replace_in_file")).toHaveLength(1);
    const wt = sessions[0]!.workspace!.repos[0]!.worktree;
    expect(readFileSync(path.join(wt, "src/app.ts"), "utf8").split("export function subtract").length - 1).toBe(1);
    expect(gw.chats).toHaveLength(3);
    expect(result.checks.map((c) => c.exitCode)).toEqual([0]);
  }, 90_000);
});
