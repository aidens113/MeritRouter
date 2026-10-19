import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Switchyard, SwitchyardOptions } from "../src/core/service.js";
import type { ChatRequest, ChatResponse, InferenceClient } from "../src/gateway/types.js";
import type { SessionEvent, SessionEventOf } from "../src/sessions/events.js";
import type { SessionRecord } from "../src/sessions/store.js";
import { GatewayError } from "../src/core/errors.js";
import { FAULT_ENV, resetFaults, simulatedCrashCount } from "../src/core/faults.js";
import { createCodingRunner } from "../src/runners/coding/index.js";
import { baseConfig, endpoint, goodOutput, makeEnv, open, reply, ScriptedClient, servedFor, type Env } from "./helpers.js";

/**
 * Resume and verification together: a task interrupted while its result is being reviewed
 * resumes the author's session (an accepted submission finishes without a model request), the
 * interrupted reviewer is superseded by a new linked one, review requests already spent stay
 * charged, and a repair already done is never repeated.
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

const AUTHOR = endpoint({ providerId: "openrouter", gatewayModelId: "alpha/alpha-1:free", totalParametersB: 700 });
const REVIEWER = endpoint({ providerId: "groq", gatewayModelId: "beta/beta-2", totalParametersB: 400 });
/** Past every lease (30 s in the test config), within every task deadline. */
const LATER = 10 * 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const call = (name: string, args: unknown, id = name) => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
const toolCount = (req: ChatRequest) => req.messages.filter((m) => m.role === "tool").length;
const isReviewer = (req: ChatRequest) => !!req.tools?.some((t) => t.function.name === "submit_verdict");
const userText = (req: ChatRequest) => String(req.messages[1]?.content ?? "");
const isRepair = (req: ChatRequest) => userText(req).includes("Previous attempt");
const ADD = "export function add";

/** A passing or failing verdict for the evidence package the scripted reviewer was given. */
function verdict(req: ChatRequest, pass: boolean) {
  const t = userText(req);
  const ref = /## Patch against the base \((artifact:[A-Za-z0-9_-]+)/.exec(t)![1]!;
  const ids = [...t.matchAll(/^- (\S+) \[verify: /gm)].map((m) => m[1]!);
  return {
    verdict: pass ? "pass" : "fail",
    examinedRevision: /examinedRevision: (\S+)/.exec(t)![1]!,
    policyVersion: /policyVersion: (\S+)/.exec(t)![1]!,
    criteria: ids.map((id) => ({ id, outcome: pass ? "pass" : "fail", evidenceRefs: [ref], ...(pass ? {} : { reason: "subtract returns a + b" }) })),
    blockingFindings: pass ? [] : [{ description: "subtract returns a + b", evidenceRefs: [ref], criterionId: ids[0] }],
    missingEvidence: [],
    recommendedAction: pass ? "accept" : "repair",
  };
}
/** The reviewer passes only a correct subtract. */
function reviewer(req: ChatRequest) {
  const ok = /```diff\n[\s\S]*\+\s+return a - b;[\s\S]*```/.test(userText(req));
  return reply(null, { ...servedFor(sy!, req), toolCalls: [call("submit_verdict", verdict(req, ok))] });
}
/** Native coding author: attempt 1 writes subtract with `first`; a repair rewrites it to `fixed`. */
function author(req: ChatRequest, first: string, fixed = "a - b") {
  const s = servedFor(sy!, req);
  if (toolCount(req) === 0) {
    const edit = isRepair(req)
      ? call("replace_in_file", { path: "src/app.ts", old_text: `  return ${first};\n}\n\n${ADD}`, new_text: `  return ${fixed};\n}\n\n${ADD}` }, "e2")
      : call("replace_in_file", { path: "src/app.ts", old_text: ADD, new_text: `export function subtract(a: number, b: number) {\n  return ${first};\n}\n\n${ADD}` }, "e1");
    return reply(null, { ...s, toolCalls: [edit] });
  }
  return reply(null, { ...s, toolCalls: [call("submit_result", goodOutput(1, "core:src/app.ts#L1-L3"))] });
}
// Hinted T3: deep verification, so an independent review is required.
const task = {
  profile: "implement",
  label: "subtract",
  goal: "Add subtract(a, b) to src/app.ts",
  repositoryAliases: ["core"],
  writableRepository: "core",
  hints: { difficulty: "T3" },
  constraints: { acceptanceCriteria: [{ id: "sub", text: "subtract(a, b) returns a - b", verify: "review" }], allowedPaths: ["src/**"], checks: [`node -e "process.exit(0)"`] },
};

function events(id: string): SessionEvent[] {
  const page = sy!.sessions.events(id, { limit: 10_000 })!;
  expect(page.corrupt).toEqual([]);
  return page.events;
}
function ofType<T extends SessionEvent["type"]>(ev: SessionEvent[], type: T): SessionEventOf<T>[] {
  return ev.filter((e): e is SessionEventOf<T> => e.type === type);
}
const byRole = (id: string, role: string): SessionRecord[] => sy!.sessions.forTask(id).filter((s) => s.role === role);
const taskEvents = (id: string, type: string) => sy!.tasks.events(id, 1000).filter((e) => e.type === type);

/** Run with the fault armed until the simulated crash, then reopen with the clock past the lease. */
async function crashThenRecover(client: InferenceClient, fault: string, opts: SwitchyardOptions = {}): Promise<string> {
  const before = simulatedCrashCount();
  process.env[FAULT_ENV] = fault;
  sy = open(env!, client, { worker: true, coding: createCodingRunner(env!.cfg), ...opts });
  const id = (await sy.submitTasks([task]))[0]!.taskId;
  for (let i = 0; i < 1500 && simulatedCrashCount() === before; i++) await sleep(20);
  expect(simulatedCrashCount()).toBe(before + 1);
  delete process.env[FAULT_ENV];
  await sleep(50);
  await sy.close();
  sy = open(env!, client, { worker: true, coding: createCodingRunner(env!.cfg), now: () => Date.now() + LATER, ...opts });
  return id;
}

async function result(id: string) {
  const out = await sy!.awaitResults([id], { timeoutSeconds: 90 });
  expect(out.timedOut).toBe(false);
  return out.completed[0]!;
}

describe("crash during review", () => {
  it("resumes the author's session, supersedes the interrupted reviewer, and reviews once more", async () => {
    env = makeEnv({ config: baseConfig({ coding: { runner: "native" } }), endpoints: [AUTHOR, REVIEWER] });
    const client = new ScriptedClient((req) => (isReviewer(req) ? reviewer(req) : author(req, "a - b")));
    // The reviewer's first response is logged, then the process dies before its verdict is handled.
    const id = await crashThenRecover(client, "after_model_response:1:verification");
    const r = await result(id);
    expect(r).toMatchObject({ executionStatus: "completed", acceptanceStatus: "met", verificationStatus: "passed", stopReason: "worker_submitted" });

    // The author's session was resumed (not the reviewer's): its accepted submission finished
    // without another request, in the same worktree.
    const authorRequests = client.requests.filter((q) => !isReviewer(q));
    expect(authorRequests).toHaveLength(2);
    const [impl, ...moreImpl] = byRole(id, "implementer");
    expect(moreImpl).toEqual([]);
    expect(impl).toMatchObject({ status: "completed" });
    expect(ofType(events(impl!.id), "ended").map((e) => e.data.stopReason)).toEqual(["process_died", "worker_submitted"]);
    expect(ofType(events(impl!.id), "resumed")).toHaveLength(1);
    expect(taskEvents(id, "worktree_ready")).toHaveLength(1);
    expect(taskEvents(id, "worktree_reused")).toHaveLength(1);

    // The interrupted reviewer is ended as superseded; a new reviewer session links to it.
    const [dead, fresh, ...moreRev] = byRole(id, "reviewer");
    expect(moreRev).toEqual([]);
    expect(dead).toMatchObject({ status: "cancelled", parentSessionId: impl!.id });
    expect(dead!.stopReason).toMatch(/^superseded/);
    expect(ofType(events(dead!.id), "ended").map((e) => [e.data.status, e.data.stopReason])).toEqual([
      ["interrupted", "process_died"],
      ["cancelled", "superseded: review 2 runs again"],
    ]);
    expect(fresh).toMatchObject({ status: "completed", parentSessionId: impl!.id, previousSessionId: dead!.id });
    expect(taskEvents(id, "review_superseded").map((e) => (e.data as { sessionId: string }).sessionId)).toEqual([dead!.id]);

    // Verification completed once: one recorded review (attempt 2), no repair.
    expect(r.verification!.reviews!.map((x) => [x.attempt, x.verdict, x.sessionId])).toEqual([[2, "pass", fresh!.id]]);
    expect(taskEvents(id, "quality_repair")).toEqual([]);
    expect(taskEvents(id, "retry_started")).toEqual([]);
    // The request the dead reviewer spent stays charged to the review allowance.
    const by = sy!.gate.admission.taskTotalsByPurpose(id);
    expect(by.verification).toBe(2);
    expect(by.verification).toBeLessThanOrEqual(sy!.contract(id)!.contract.budget.review);
    expect(by.repair).toBe(0);
  }, 120_000);

  it("a crash during the re-review after a repair resumes the repair session and never repairs again", async () => {
    env = makeEnv({ config: baseConfig({ coding: { runner: "native" } }), endpoints: [AUTHOR, REVIEWER] });
    const client = new ScriptedClient((req) => (isReviewer(req) ? reviewer(req) : author(req, "a + b")));
    // Review 1 fails (one request), the repair runs, and the process dies during the re-review.
    const id = await crashThenRecover(client, "after_model_response:2:verification");
    const r = await result(id);
    expect(r).toMatchObject({ executionStatus: "completed", acceptanceStatus: "met", verificationStatus: "passed" });

    // Exactly one repair, and no author request after the restart (2 first attempt + 2 repair).
    expect(taskEvents(id, "quality_repair")).toHaveLength(1);
    expect(taskEvents(id, "retry_started")).toHaveLength(1);
    expect(taskEvents(id, "worktree_ready")).toHaveLength(2);
    const authorRequests = client.requests.filter((q) => !isReviewer(q));
    expect(authorRequests).toHaveLength(4);
    expect(authorRequests.filter(isRepair)).toHaveLength(2);
    const [first, repair, ...moreImpl] = byRole(id, "implementer");
    expect(moreImpl).toEqual([]);
    expect(first).toMatchObject({ status: "completed" });
    expect(repair).toMatchObject({ status: "completed", previousSessionId: first!.id });
    expect(ofType(events(repair!.id), "ended").map((e) => e.data.stopReason)).toEqual(["process_died", "worker_submitted"]);
    const patch = sy!.artifacts.read(r.patchRefs[0]!)!.content.toString("utf8");
    expect(patch).toContain("+  return a - b;");
    expect(patch).not.toContain("+  return a + b;");

    // Reviews: the failing one (restored from before the crash), then the re-review; the
    // interrupted re-review was superseded.
    expect(r.verification!.reviews!.map((x) => [x.attempt, x.verdict])).toEqual([
      [1, "fail"],
      [3, "pass"],
    ]);
    const reviewers = byRole(id, "reviewer");
    expect(reviewers.map((s) => [s.status, s.parentSessionId])).toEqual([
      ["completed", first!.id],
      ["cancelled", repair!.id],
      ["completed", repair!.id],
    ]);
    expect(reviewers[2]!.previousSessionId).toBe(reviewers[1]!.id);
    const by = sy!.gate.admission.taskTotalsByPurpose(id);
    expect(by.verification).toBe(3);
    expect(by.repair).toBe(2);
    const b = sy!.contract(id)!.contract.budget;
    expect(by.repair).toBeLessThanOrEqual(b.repair);
    expect(sy!.gate.admission.taskTotals(id).requests).toBeLessThanOrEqual(b.total);
    // The repair ran at the tier it started at, before and after the restart.
    expect(r.routing).toMatchObject({ tier: "T3" });
  }, 120_000);
  it("a re-review that still fails after the restart goes to the supervisor: the one repair is not repeated", async () => {
    env = makeEnv({ config: baseConfig({ coding: { runner: "native" } }), endpoints: [AUTHOR, REVIEWER] });
    // The repair is still wrong (b - a), so every review fails.
    const client = new ScriptedClient((req) => (isReviewer(req) ? reviewer(req) : author(req, "a + b", "b - a")));
    const id = await crashThenRecover(client, "after_model_response:2:verification");
    const r = await result(id);
    // A reviewer-only defect with no retry left: the supervisor decides (restored retry count, not a second repair).
    expect(r).toMatchObject({ executionStatus: "completed", acceptanceStatus: "needs_supervisor" });
    expect(r.verification!.reviews!.map((x) => [x.attempt, x.verdict])).toEqual([
      [1, "fail"],
      [3, "fail"],
    ]);
    expect(taskEvents(id, "quality_repair")).toHaveLength(1);
    expect(taskEvents(id, "worktree_ready")).toHaveLength(2);
    expect(client.requests.filter((q) => !isReviewer(q))).toHaveLength(4);
    expect(byRole(id, "implementer")).toHaveLength(2);
  }, 120_000);
});

describe("watchdog during review", () => {
  it("follows the reviewer session: a stuck reviewer is aborted, the author's session resumes, and a new reviewer passes", async () => {
    let offset = 0;
    env = makeEnv({
      config: baseConfig({
        coding: { runner: "native" },
        execution: { max_concurrent_tasks: 4, lease_seconds: 3600, job_timeout_seconds: 7200 },
        // A short request timeout keeps the allowance for a pending request at watchdog_minutes (10).
        gateway: { adapter: "freellmapi", base_url: "http://127.0.0.1:9/v1", require_verified_chains: false, request_timeout_seconds: 10 },
      }),
      endpoints: [AUTHOR, REVIEWER],
    });
    let hung = 0;
    const requests: ChatRequest[] = [];
    const client: InferenceClient = {
      name: "hanging-reviewer",
      complete(req, signal): Promise<ChatResponse> {
        requests.push(structuredClone(req));
        if (!isReviewer(req)) return Promise.resolve(author(req, "a - b"));
        if (hung++ === 0) {
          // The first reviewer's provider never answers; only the abort ends this request.
          return new Promise<ChatResponse>((_, reject) => signal?.addEventListener("abort", () => reject(new GatewayError("aborted", "request aborted by caller"))));
        }
        return Promise.resolve(reviewer(req));
      },
    };
    sy = open(env, client, { worker: true, coding: createCodingRunner(env.cfg), now: () => Date.now() + offset });
    const id = (await sy.submitTasks([task]))[0]!.taskId;
    for (let i = 0; i < 1500 && hung === 0; i++) await sleep(20);
    expect(hung).toBe(1);
    offset += 11 * 60_000;
    const r = await result(id);
    expect(r).toMatchObject({ executionStatus: "completed", acceptanceStatus: "met", verificationStatus: "passed" });

    const [impl, ...moreImpl] = byRole(id, "implementer");
    expect(moreImpl).toEqual([]);
    const [stuck, fresh, ...moreRev] = byRole(id, "reviewer");
    expect(moreRev).toEqual([]);
    // The watchdog judged the reviewer (the session making progress), not the idle author.
    const abort = taskEvents(id, "watchdog_abort");
    expect(abort).toHaveLength(1);
    expect(abort[0]!.data).toMatchObject({ sessionId: stuck!.id, role: "reviewer", waitingOn: "model request (verification)" });
    expect(ofType(events(stuck!.id), "ended").map((e) => [e.data.status, e.data.stopReason])).toEqual([
      ["interrupted", "watchdog"],
      ["cancelled", "superseded: review 2 runs again"],
    ]);
    expect(fresh).toMatchObject({ status: "completed", parentSessionId: impl!.id, previousSessionId: stuck!.id });
    // The author's session was the one re-queued and resumed; its submission needed no new request.
    expect(ofType(events(impl!.id), "ended").map((e) => [e.data.status, e.data.stopReason])).toEqual([
      ["interrupted", "watchdog"],
      ["completed", "worker_submitted"],
    ]);
    expect(requests.filter((q) => !isReviewer(q))).toHaveLength(2);
    expect(taskEvents(id, "session_resumed").map((e) => (e.data as { sessionId: string }).sessionId)).toEqual([impl!.id]);
  }, 120_000);
});
