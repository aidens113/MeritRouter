import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Switchyard } from "../src/core/service.js";
import type { ChatRequest } from "../src/gateway/types.js";
import { createCodingRunner } from "../src/runners/coding/index.js";
import { BudgetRequests, jobPool } from "../src/admission/budget-requests.js";
import { childRequestBudget, effectiveBudget, UNLIMITED_REQUESTS, verificationTotal } from "../src/admission/admission.js";
import { grantBriefs } from "../src/harness/budget-tools.js";
import { grantOf } from "../src/admission/job-pool.js";
import { budgetRequestsView, decideBudgetRequest, jobBudget } from "../src/admin/budget.js";
import { coordinationGuard } from "../src/harness/coordination-edits.js";
import { ChannelStore } from "../src/storage/channel.js";
import { verificationTrail } from "../src/verification/trail.js";
import { baseConfig, goodOutput, makeEnv, openWithTestSupervisor as open, reply, ScriptedClient, servedFor, type Env } from "./helpers.js";

let env: Env | undefined;
let sy: Switchyard | undefined;
afterEach(async () => {
  await sy?.close();
  sy = undefined;
  env?.cleanup();
  env = undefined;
});

const call = (name: string, args: unknown, id = name) => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
const turns = (req: ChatRequest) => req.messages.filter((m) => m.role === "assistant").length;
const isSupervisor = (req: ChatRequest) => String(req.messages[0]!.content).startsWith("# Supervisor charter");
const toolOutputs = (req: ChatRequest) => req.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function jobConfig(team: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const cfg = baseConfig({ coding: { runner: "native" }, team: { max_agents: 4, ...team }, ...extra });
  (cfg.profiles as Record<string, unknown>).supervise = { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100, max_model_requests: 30, max_output_tokens: 4000, classify: "never", min_tier: "T3" };
  // Investigation workers with room to show a budget growing past its first cap.
  (cfg.profiles as Record<string, unknown>).inspect = { mode: "read_only", min_total_parameters_b: 30, max_model_requests: 12, tools: "repository_read", classify: "never" };
  return cfg;
}

const brief = (label: string, extra: Record<string, unknown> = {}) => ({ label, profile: "inspect", goal: `Look into ${label}`, acceptance_criteria: ["reports what it found"], difficulty: "T1", ...extra });
const readMe = (startLine?: number) => call("read_file", { alias: "core", path: "README.md", ...(startLine ? { start_line: startLine } : {}) }, `r${Math.random().toString(36).slice(2, 8)}`);
const submit = () => call("submit_result", goodOutput(1, "core:README.md#L1-L3"), "s1");
/** A worker that reads, then submits. */
const readThenSubmit = (req: ChatRequest) => (turns(req) === 0 ? [readMe()] : [submit()]);
const finish = () => call("finish_job", { status: "completed", summary: "done", verified: [{ claim: "worker result read", evidence: "await_tasks" }], not_verified: [] });

/** A scripted job: the supervisor's turns by index; workers answer with `worker`. */
function scripted(script: Array<(req: ChatRequest) => ReturnType<typeof call>[]>, worker: (req: ChatRequest) => ReturnType<typeof call>[]) {
  return new ScriptedClient((req) => {
    const s = servedFor(sy!, req);
    if (isSupervisor(req)) return reply(null, { ...s, toolCalls: script[turns(req)]!(req) });
    return reply(null, { ...s, toolCalls: worker(req) });
  });
}

describe("budget control: supervisor-set budgets (D1, D2)", () => {
  it("lets an uncapped supervisor continue beyond 300 requests and reports the pool as uncapped", async () => {
    const config = jobConfig({}, { execution: { max_concurrent_tasks: 4, lease_seconds: 120 }, verification: { max_total_requests_per_task: null } });
    (config.profiles as Record<string, Record<string, unknown>>).supervise!.max_model_requests = null;
    env = makeEnv({ config });
    const turnsBeforeFinish = 301;
    const script = Array.from({ length: turnsBeforeFinish }, () => () => [call("await_tasks", { timeout_seconds: 1 })]);
    script.push(() => [finish()]);
    const client = scripted(script, readThenSubmit);
    sy = open(env, client, { worker: true });
    const { taskId: job } = await sy.startJob({ goal: "Keep iterating", repositories: ["core"] });
    const result = (await sy.awaitResults([job], { timeoutSeconds: 120 })).completed[0]!;
    expect(result.stopReason).toBe("supervisor_completed");
    expect(client.requests.filter(isSupervisor)).toHaveLength(turnsBeforeFinish + 1);
    expect(String(client.requests.find(isSupervisor)!.messages[0]!.content)).toContain("Model request budget: uncapped");
    expect(jobPool(sy.db, sy.cfg, job)).toMatchObject({ cap: null, available: null, used: turnsBeforeFinish + 1 });
    expect(env.cfg.profiles.supervise!.max_model_requests).toBeNull();
    expect(env.cfg.verification.max_total_requests_per_task).toBeNull();
  }, 120_000);

  it("continues enforcing an explicitly configured task-wide request cap", async () => {
    env = makeEnv({ config: jobConfig({}, { verification: { max_total_requests_per_task: 7 } }) });
    sy = open(env, new ScriptedClient(() => reply("unused")), { worker: false });
    const { taskId: job } = await sy.startJob({ goal: "Respect the configured cap", repositories: ["core"] });
    const spec = sy.tasks.get(job)!.spec;
    expect(effectiveBudget(sy.cfg, spec).maxModelRequests).toBe(7);
    expect(verificationTotal(sy.cfg, spec)).toBe(7);
    expect(jobPool(sy.db, sy.cfg, job)).toMatchObject({ cap: 7, available: 3, used: 0 });
    expect(() => grantBriefs(sy!.db, sy!.cfg, job, [{ it: { ...brief("over"), max_requests: 4 }, label: "over" }])).toThrow(/4 model requests but your job has 3 left/);
  }, 120_000);

  it("does not split an uncapped parent's budget into a finite sub-job carve", () => {
    expect(childRequestBudget({ parentCap: UNLIMITED_REQUESTS, parentUsed: 10, carved: 100, share: 0.5, min: 4 })).toEqual({
      requests: UNLIMITED_REQUESTS,
      remaining: UNLIMITED_REQUESTS,
    });
  });

  it("sets a child's budget, refuses an over-ask with the number left, and returns unused requests to the pool", async () => {
    env = makeEnv({ config: jobConfig() });
    let pending: unknown;
    const client = scripted(
      [
        () => [call("delegate", { tasks: [brief("big", { max_requests: 40 })] })],
        () => [call("delegate", { tasks: [brief("small", { max_requests: 3 })] })],
        () => {
          pending = jobPool(sy!.db, sy!.cfg, job)!;
          return [call("await_tasks", { timeout_seconds: 60 })];
        },
        () => [finish()],
      ],
      readThenSubmit,
    );
    sy = open(env, client, { worker: true });
    const { taskId: job } = await sy.startJob({ goal: "Look into things", repositories: ["core"] });
    const r = (await sy.awaitResults([job], { timeoutSeconds: 90 })).completed[0]!;
    expect(r.stopReason).toBe("supervisor_completed");
    const outputs = toolOutputs(client.requests.filter(isSupervisor).at(-1)!);
    // 30 budget, 1 used by the supervisor, 4 kept for it: 25 left, so 40 is refused with that number.
    expect(outputs[0]).toMatch(/^error: big: needs 40 model requests but your job has 25 left for new tasks \(budget 30: you used 1, open tasks hold 0, 4 kept for your own requests\); nothing was dispatched/);
    expect(sy.tasks.childrenOf(job).map((c) => c.spec.label)).toEqual(["small"]);
    expect(outputs[1]).toMatch(/small -> t_\w+ \(queued\); budget 3 requests/);
    const small = sy.tasks.childrenOf(job)[0]!;
    // The grant is the task's own budget and a hold on the job's pool while it is open.
    expect(small.spec.budget?.maxModelRequests).toBe(3);
    expect(grantOf(sy.db, small.row.id)).toMatchObject({ jobId: job, requests: 3, source: "supervisor" });
    expect(pending).toMatchObject({ cap: 30, held: 3 });
    // Finished, it holds only what it used (2 requests): the third came back.
    const after = jobBudget(sy, job)!;
    expect(after.tasks).toEqual([expect.objectContaining({ label: "small", state: "completed", granted: 3, used: 2, held: 2, extra: 0 })]);
    expect(after.pool.held).toBe(2);
    expect(after.pool.available).toBe(30 - after.pool.used - 2 - 4);
  }, 120_000);

  it("accepts a JSON-stringified task array returned by a model", async () => {
    env = makeEnv({ config: jobConfig() });
    const client = scripted(
      [
        () => [call("delegate", { tasks: JSON.stringify([brief("stringified")]) })],
        () => [call("await_tasks", { timeout_seconds: 60 })],
        () => [finish()],
      ],
      readThenSubmit,
    );
    sy = open(env, client, { worker: true });
    const { taskId: job } = await sy.startJob({ goal: "Dispatch a serialized brief", repositories: ["core"] });
    const r = (await sy.awaitResults([job], { timeoutSeconds: 90 })).completed[0]!;
    expect(r.stopReason).toBe("supervisor_completed");
    expect(sy.tasks.childrenOf(job).map((child) => child.spec.label)).toEqual(["stringified"]);
    expect(toolOutputs(client.requests.filter(isSupervisor)[1]!).join("\n")).toMatch(/stringified -> t_\w+ \(queued\)/);
  }, 120_000);

  it("gives a brief without max_requests the configured default (the tier cap unless team.default_task_requests is set)", async () => {
    env = makeEnv({ config: jobConfig({ default_task_requests: 5 }) });
    const client = scripted([() => [call("delegate", { tasks: [brief("a")] })], () => [call("await_tasks", { timeout_seconds: 60 })], () => [finish()]], readThenSubmit);
    sy = open(env, client, { worker: true });
    const { taskId: job } = await sy.startJob({ goal: "Look", repositories: ["core"] });
    await sy.awaitResults([job], { timeoutSeconds: 90 });
    const a = sy.tasks.childrenOf(job)[0]!;
    expect(a.spec.budget?.maxModelRequests).toBe(5);
    expect(grantOf(sy.db, a.row.id)).toMatchObject({ requests: 5, source: "default" });
  }, 120_000);
});

describe("budget control: requests for more (D3, D4, D5)", () => {
  it("a worker near its cap asks, the supervisor approves, and the worker continues past its old cap", async () => {
    env = makeEnv({ config: jobConfig() });
    let decided = "";
    const client = scripted(
      [
        () => [call("delegate", { tasks: [brief("dig", { max_requests: 3 })] })],
        () => [call("await_tasks", { timeout_seconds: 60 })],
        (req) => {
          const id = Number(/budget request (\d+) from dig/.exec(toolOutputs(req).at(-1)!)?.[1]);
          return [call("decide_budget_request", { id, approve: true, grant: 3, reason: "it listed what remains" })];
        },
        (req) => {
          decided = toolOutputs(req).at(-1)!;
          return [call("await_tasks", { timeout_seconds: 60 })];
        },
        () => [finish()],
      ],
      (req) => {
        const n = turns(req);
        if (n === 1) return [call("request_more_budget", { requests: 4, reason: "read the readme; three more files to read" })];
        return n >= 5 ? [submit()] : [readMe(n + 1)];
      },
    );
    sy = open(env, client, { worker: true });
    const { taskId: job } = await sy.startJob({ goal: "Dig", repositories: ["core"] });
    const r = (await sy.awaitResults([job], { timeoutSeconds: 120 })).completed[0]!;
    expect(r.stopReason).toBe("supervisor_completed");
    const dig = sy.tasks.childrenOf(job)[0]!;
    const res = sy.tasks.get(dig.row.id)!.result!;
    expect(res.stopReason).toBe("worker_submitted");
    // Six requests against a first cap of three: the approval raised it to six.
    expect(res.usage.modelRequests).toBe(6);
    const workerReqs = client.requests.filter((q) => !isSupervisor(q));
    expect(toolOutputs(workerReqs[2]!).at(-1)).toMatch(/^budget request \d+ approved by .*: 3 more model request\(s\) \(it listed what remains\)\. Your limit is now 6; you have used 2/);
    expect(decided).toMatch(/approved \(\+3\); job \w+ pool: \d+ available of 30/);
    // Recorded: the row, the task's budget history, the job's events and channel, the status.
    const [req] = new BudgetRequests(sy.db).list({ taskId: dig.row.id });
    expect(req).toMatchObject({ status: "approved", requests: 4, granted: 3, used: 2, cap: 3, approver: "supervisor", jobId: job });
    expect(sy.tasks.events(dig.row.id, 100).find((e) => e.type === "budget_granted")?.data).toMatchObject({ granted: 3, extraTotal: 3, contractTotal: 6, grantTotal: 6 });
    expect(sy.tasks.events(job, 200).filter((e) => e.type.startsWith("budget_")).map((e) => e.type)).toEqual(["budget_requested", "budget_request_decided"]);
    const posts = new ChannelStore(sy.db).list(job).map((p) => p.text);
    expect(posts.some((t) => t.startsWith("Budget request #") && t.includes("4 more model request(s)"))).toBe(true);
    expect(posts.some((t) => /approved: \+3 request\(s\)/.test(t))).toBe(true);
    expect((sy.getStatus([dig.row.id])[0] as { maxModelRequests: number }).maxModelRequests).toBe(6);
    expect(verificationTrail({ tasks: sy.tasks, catalog: sy.catalog, sessions: sy.sessions, admission: sy.admission }, dig.row.id, null).budgetGrants).toEqual([expect.objectContaining({ requestId: req!.id, granted: 3, extraTotal: 3, contractTotal: 6 })]);
    // The session shows the call and its outcome.
    const sess = sy.sessions.forTask(dig.row.id).at(-1)!;
    const log = sy.db.prepare("SELECT type, name FROM session_events WHERE session_id = ? AND type IN ('tool_intent', 'note')").all(sess.id) as Array<{ type: string; name: string | null }>;
    expect(log.some((e) => e.type === "tool_intent" && e.name === "request_more_budget")).toBe(true);
    // The grant came out of the pool: the task held 3 + 3 while open, and now what it used.
    expect(jobBudget(sy, job)!.tasks[0]).toMatchObject({ granted: 3, extra: 3, used: 6, held: 6 });
  }, 180_000);

  it("a denial lets the worker submit with what it has", async () => {
    env = makeEnv({ config: jobConfig() });
    const client = scripted(
      [
        () => [call("delegate", { tasks: [brief("dig", { max_requests: 3 })] })],
        () => [call("await_tasks", { timeout_seconds: 60 })],
        (req) => [call("decide_budget_request", { id: Number(/budget request (\d+)/.exec(toolOutputs(req).at(-1)!)?.[1]), approve: false, reason: "the brief is small; finish it" })],
        () => [call("await_tasks", { timeout_seconds: 60 })],
        () => [finish()],
      ],
      (req) => {
        const n = turns(req);
        if (n === 0) return [call("request_more_budget", { requests: 10, reason: "want more" })];
        return n >= 2 ? [submit()] : [readMe()];
      },
    );
    sy = open(env, client, { worker: true });
    const { taskId: job } = await sy.startJob({ goal: "Dig", repositories: ["core"] });
    await sy.awaitResults([job], { timeoutSeconds: 120 });
    const dig = sy.tasks.childrenOf(job)[0]!;
    const res = sy.tasks.get(dig.row.id)!.result!;
    expect(res.stopReason).toBe("worker_submitted");
    expect(res.usage.modelRequests).toBe(3);
    const second = client.requests.filter((q) => !isSupervisor(q))[1]!;
    expect(toolOutputs(second).at(-1)).toMatch(/denied by .*: the brief is small; finish it\. Finish with what you have: you have 2 request\(s\) left/);
    expect(new BudgetRequests(sy.db).list({ taskId: dig.row.id })[0]).toMatchObject({ status: "denied", granted: 0 });
    expect(sy.tasks.events(dig.row.id, 100).some((e) => e.type === "budget_granted")).toBe(false);
  }, 180_000);

  it("the auto approver grants within the pool, up to team.auto_grant_max, without the supervisor", async () => {
    env = makeEnv({ config: jobConfig({ budget_approver: "auto", auto_grant_max: 2 }) });
    const client = scripted(
      [() => [call("delegate", { tasks: [brief("dig", { max_requests: 3 })] })], () => [call("await_tasks", { timeout_seconds: 60 })], () => [finish()]],
      (req) => {
        const n = turns(req);
        if (n === 0) return [call("request_more_budget", { requests: 5, reason: "need five" })];
        return n >= 4 ? [submit()] : [readMe(n + 1)];
      },
    );
    sy = open(env, client, { worker: true });
    const { taskId: job } = await sy.startJob({ goal: "Dig", repositories: ["core"] });
    await sy.awaitResults([job], { timeoutSeconds: 120 });
    const dig = sy.tasks.childrenOf(job)[0]!;
    expect(new BudgetRequests(sy.db).list({ taskId: dig.row.id })[0]).toMatchObject({ approver: "auto", status: "approved", granted: 2, decidedBy: "auto" });
    const res = sy.tasks.get(dig.row.id)!.result!;
    expect(res.usage.modelRequests).toBe(5);
    expect(res.stopReason).toBe("worker_submitted");
    // The supervisor was never asked: await_tasks did not stop for it.
    expect(client.requests.filter(isSupervisor).flatMap(toolOutputs).some((o) => o.includes("budget request"))).toBe(false);
  }, 180_000);

  it("auto denies when the job's pool is empty", async () => {
    // Budget 30: the supervisor keeps 4, the task holds 25, so nothing is left to grant.
    env = makeEnv({ config: jobConfig({ budget_approver: "auto", supervisor_reserve_requests: 4 }) });
    const client = scripted(
      [() => [call("delegate", { tasks: [brief("dig", { max_requests: 25 })] })], () => [call("await_tasks", { timeout_seconds: 60 })], () => [finish()]],
      (req) => [[call("request_more_budget", { requests: 5, reason: "need five" })], [readMe()]][turns(req)] ?? [submit()],
    );
    sy = open(env, client, { worker: true });
    const { taskId: job } = await sy.startJob({ goal: "Dig", repositories: ["core"] });
    await sy.awaitResults([job], { timeoutSeconds: 120 });
    const dig = sy.tasks.childrenOf(job)[0]!;
    expect(new BudgetRequests(sy.db).list({ taskId: dig.row.id })[0]).toMatchObject({ status: "denied", granted: 0, decidedBy: "auto" });
    expect(new BudgetRequests(sy.db).list({ taskId: dig.row.id })[0]!.decisionReason).toMatch(/pool is exhausted/);
  }, 120_000);

  it("a request nobody decides expires after the wait and the worker continues; a top-level task is decided by the external supervisor", async () => {
    env = makeEnv({ config: jobConfig({ budget_request_wait_seconds: 3 }) });
    const client = new ScriptedClient((req) => {
      const s = servedFor(sy!, req);
      const n = turns(req);
      const goal = String(req.messages[1]?.content ?? "");
      if (goal.includes("expire")) return reply(null, { ...s, toolCalls: [[call("request_more_budget", { requests: 2, reason: "more" })], [readMe()]][n] ?? [submit()] });
      // The decided one: asks, then reads until it submits on its sixth request.
      if (n === 0) return reply(null, { ...s, toolCalls: [call("request_more_budget", { requests: 3, reason: "three more" })] });
      return reply(null, { ...s, toolCalls: n >= 5 ? [submit()] : [readMe(n + 1)] });
    });
    sy = open(env, client, { worker: true });
    const [expiring] = await sy.submitTasks([{ profile: "inspect", goal: "expire: look", repositoryAliases: ["core"], hints: { difficulty: "T1" }, budget: { maxModelRequests: 3 }, constraints: { acceptanceCriteria: ["x"] } }]);
    const r1 = (await sy.awaitResults([expiring!.taskId], { timeoutSeconds: 60 })).completed[0]!;
    expect(r1.stopReason).toBe("worker_submitted");
    expect(new BudgetRequests(sy.db).list({ taskId: expiring!.taskId })[0]).toMatchObject({ status: "expired", approver: "external", jobId: null });
    expect(toolOutputs(client.requests.at(-1)!)[0]).toMatch(/no decision arrived \(no decision within 3s\)\. Continue with your 2 remaining request/);

    // Decided within the wait by the external supervisor (what MCP decide_budget_request calls).
    const [decided] = await sy.submitTasks([{ profile: "inspect", goal: "decide: look", repositoryAliases: ["core"], hints: { difficulty: "T1" }, budget: { maxModelRequests: 3 }, constraints: { acceptanceCriteria: ["x"] } }]);
    let pending = budgetRequestsView(sy, { status: "pending" });
    for (let i = 0; i < 100 && !pending.length; i++) {
      await sleep(100);
      pending = budgetRequestsView(sy, { status: "pending" });
    }
    expect(pending[0]).toMatchObject({ taskId: decided!.taskId, approver: "external", pool: null });
    const d = decideBudgetRequest(sy, pending[0]!.id, { approve: true, reason: "go on", by: { kind: "external", id: "mcp:test" } });
    expect(d).toMatchObject({ status: "approved", granted: 3, decidedBy: "external:mcp:test" });
    // Deciding twice is refused.
    expect(() => decideBudgetRequest(sy!, pending[0]!.id, { approve: false, reason: "no", by: { kind: "human", id: "cli:me" } })).toThrow(/already approved/);
    const r2 = (await sy.awaitResults([decided!.taskId], { timeoutSeconds: 60 })).completed[0]!;
    expect(r2.stopReason).toBe("worker_submitted");
    expect(r2.usage.modelRequests).toBe(6);
  }, 180_000);

  it("a human approver's request needs a person; a finished task's request expires", async () => {
    env = makeEnv({ config: jobConfig({ budget_approver: "human" }) });
    sy = open(env, new ScriptedClient(() => reply("unused")), { worker: false });
    const [t] = await sy.submitTasks([{ profile: "inspect", goal: "look", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["x"] } }]);
    const store = new BudgetRequests(sy.db);
    const req = store.file({ taskId: t!.taskId, jobId: null, role: "inspector", requests: 4, reason: "more files", used: 3, cap: 4, approver: "human" });
    expect(() => decideBudgetRequest(sy!, req.id, { approve: true, reason: "ok", by: { kind: "external", id: "mcp:x" } })).toThrow(/decided by a person/);
    expect(() => decideBudgetRequest(sy!, req.id, { approve: true, reason: "ok", by: { kind: "human", id: "cli:me" } }, "another-project")).toThrow(/unknown budget request/);
    expect(decideBudgetRequest(sy, req.id, { approve: true, grant: 2, reason: "two is enough", by: { kind: "human", id: "cli:me" } })).toMatchObject({ status: "approved", granted: 2, decidedBy: "human:cli:me", decisionReason: "two is enough" });
    const before = (sy.getStatus([t!.taskId])[0] as { maxModelRequests: number }).maxModelRequests;
    const late = store.file({ taskId: t!.taskId, jobId: null, role: "inspector", requests: 1, reason: "one more", used: 3, cap: 6, approver: "human" });
    sy.cancelTasks([t!.taskId]);
    expect(() => decideBudgetRequest(sy!, late.id, { approve: true, reason: "ok", by: { kind: "human", id: "cli:me" } })).toThrow(/already cancelled; its budget request \d+ expired/);
    expect(store.get(late.id)).toMatchObject({ status: "expired", granted: 0 });
    expect((sy.getStatus([t!.taskId])[0] as { maxModelRequests: number }).maxModelRequests).toBe(before);
  });

  it("limits requests per task in code", async () => {
    env = makeEnv({ config: jobConfig({ budget_approver: "auto", max_budget_requests_per_task: 1, auto_grant_max: 1 }) });
    const client = new ScriptedClient((req) => {
      const s = servedFor(sy!, req);
      const n = turns(req);
      return reply(null, { ...s, toolCalls: n < 2 ? [call("request_more_budget", { requests: 1, reason: "one more" }, `r${n}`)] : n === 2 ? [readMe()] : [submit()] });
    });
    sy = open(env, client, { worker: true });
    const [t] = await sy.submitTasks([{ profile: "inspect", goal: "look", repositoryAliases: ["core"], hints: { difficulty: "T1" }, budget: { maxModelRequests: 3 }, constraints: { acceptanceCriteria: ["x"] } }]);
    await sy.awaitResults([t!.taskId], { timeoutSeconds: 60 });
    const outputs = toolOutputs(client.requests.at(-1)!);
    expect(outputs[0]).toMatch(/approved by auto: 1 more/);
    expect(outputs[1]).toMatch(/^error: you already asked 1 time\(s\), the most a task may/);
    expect(new BudgetRequests(sy.db).countFor(t!.taskId)).toBe(1);
    expect(sy.tasks.get(t!.taskId)!.result!.stopReason).toBe("worker_submitted");
  }, 120_000);
});

describe("supervisors delegate implementation (D7)", () => {
  it("refuses a supervisor's edit to src/ under delegate, and allows INTERFACES.md and an integration conflict fix", async () => {
    env = makeEnv({ config: jobConfig() });
    let job = "";
    const client = scripted(
      [
        () => [call("write_file", { path: "src/app.ts", content: "export const x = 1;\n" })],
        () => [call("write_file", { path: "INTERFACES.md", content: "# Interfaces\n\nadd(a, b): number\n" })],
        () => {
          // An integration of this job conflicted on src/app.ts: the supervisor may fix it now.
          sy!.db
            .prepare(
              `INSERT INTO merge_queue (id, job_id, task_id, kind, repo_alias, branch, lock_key, integration_worktree, source_base, source_head, commits_json, state, detail_json, created_at, updated_at)
               VALUES ('mq_test', ?, ?, 'task', 'core', 'b', 'k', 'w', 'abc1234', 'abc1234', '[]', 'conflict', ?, 1, 1)`,
            )
            .run(job, job, JSON.stringify({ conflict: { files: ["src/app.ts"], message: "conflict", commit: null, stage: "rebase" } }));
          return [call("replace_in_file", { path: "src/app.ts", old_text: "return a + b;", new_text: "return b + a;" })];
        },
        () => [call("finish_job", { status: "blocked", summary: "checked edit limits", verified: [], not_verified: ["nothing implemented"] })],
      ],
      readThenSubmit,
    );
    sy = open(env, client, { worker: true });
    job = (await sy.startJob({ goal: "Edit limits", repositories: ["core"] })).taskId;
    await sy.awaitResults([job], { timeoutSeconds: 90 });
    const outputs = toolOutputs(client.requests.filter(isSupervisor).at(-1)!);
    expect(outputs[0]).toMatch(/^error: src\/app\.ts: delegate it\. Supervisors do not implement \(supervisor\.implementation: delegate\).*The edit was refused\./);
    expect(outputs[1]).toBe("wrote INTERFACES.md (4 lines)");
    expect(outputs[2]).toBe("replaced 1 occurrence(s) in src/app.ts");
    const worktree = sy.sessions.forTask(job).at(-1)!.workspace!.repos[0]!.worktree;
    expect(readFileSync(path.join(worktree, "src/app.ts"), "utf8")).toContain("return b + a;");
    expect(existsSync(path.join(worktree, "INTERFACES.md"))).toBe(true);
  }, 120_000);

  it("allows files a brief names as shared, and every edit under implementation: allowed", () => {
    env = makeEnv({ config: jobConfig({}, { supervisor: { implementation: "delegate", coordination_paths: ["docs/**"] } }) });
    sy = open(env, new ScriptedClient(() => reply("unused")), { worker: false });
    const guard = coordinationGuard({ cfg: sy.cfg, db: sy.db, jobId: "t_none", alias: "core", sharedFiles: () => new Set(["src/contract.ts"]) })!;
    expect(guard("docs/a.md")).toBeNull();
    expect(guard("src/contract.ts")).toBeNull();
    expect(guard("README.md")).toMatch(/delegate it/);
    expect(guard("src/app.ts")).toMatch(/delegate it/);
    const allowed = { ...sy.cfg, supervisor: { ...sy.cfg.supervisor, implementation: "allowed" as const } };
    expect(coordinationGuard({ cfg: allowed, db: sy.db, jobId: "t_none", alias: "core", sharedFiles: () => new Set() })).toBeNull();
  });
});

describe("declared checks for implementers (run_check)", () => {
  const check = `node -e "process.exit(require('fs').readFileSync('src/app.ts','utf8').includes('subtract')?0:1)"`;

  it("runs a declared check (output returned and stored), refuses an undeclared command with the list, and stops at the run limit", async () => {
    env = makeEnv({ config: baseConfig({ coding: { runner: "native", max_check_runs_per_task: 2 } }) });
    const client = new ScriptedClient((req) => {
      const s = servedFor(sy!, req);
      const n = turns(req);
      const calls = [
        () => call("run_check", { command: check }, "k0"),
        () => call("replace_in_file", { path: "src/app.ts", old_text: "export function add", new_text: "export function subtract(a: number, b: number) {\n  return a - b;\n}\n\nexport function add" }, "e1"),
        () => call("run_check", { command: "node --test" }, "k1"),
        () => call("run_check", { command: check }, "k2"),
        () => call("replace_in_file", { path: "src/app.ts", old_text: "return a - b;", new_text: "return a - b; // verified" }, "e2"),
        () => call("run_check", { command: check }, "k3"),
        () => call("submit_result", goodOutput(1, "core:src/app.ts#L1-L3"), "s1"),
      ];
      return reply(null, { ...s, toolCalls: [calls[Math.min(n, calls.length - 1)]!()] });
    });
    sy = open(env, client, { worker: true, coding: createCodingRunner(env.cfg) });
    const [t] = await sy.submitTasks([
      { profile: "implement", label: "add-subtract", goal: "Add subtract()", repositoryAliases: ["core"], writableRepository: "core", hints: { difficulty: "T2" }, constraints: { acceptanceCriteria: ["subtract exists"], allowedPaths: ["src/**"], checks: [check] } },
    ]);
    const r = (await sy.awaitResults([t!.taskId], { timeoutSeconds: 90 })).completed[0]!;
    // The tool is offered, and the brief says to use it.
    const first = client.requests[0]!;
    expect((first.tools ?? []).map((x) => x.function.name)).toContain("run_check");
    expect(String(first.messages[0]!.content)).toMatch(/run your declared checks with run_check \(at most 2 runs\)/);
    const outputs = toolOutputs(client.requests.at(-1)!);
    expect(outputs[0]).toMatch(/^\$ node -e .*\nsource [a-f0-9]{64}\nexit 1\n/);
    expect(outputs[0]).toMatch(/\(log artifact:\S+; supervisor action wa_\S+\)/);
    expect(outputs[2]).toMatch(/^error: not a declared check; run exactly one of: "node -e/);
    expect(outputs[3]).toMatch(/\nsource [a-f0-9]{64}\nexit 0\n/);
    expect(outputs[3]).toMatch(/\(log artifact:\S+; supervisor action wa_\S+\)/);
    expect(outputs[5]).toMatch(/^error: check run limit reached \(2 of 2, coding\.max_check_runs_per_task\)/);
    // Stored like other check logs; informational only (the post-submission check decides).
    const logs = sy.db.prepare("SELECT label FROM artifacts WHERE task_id = ? AND kind = 'check_log'").all(t!.taskId) as Array<{ label: string }>;
    expect(logs.filter((l) => l.label.startsWith("supervisor check: "))).toHaveLength(2);
    expect(sy.tasks.events(t!.taskId, 200).filter((e) => e.type === "worker_check_run").map((e) => (e.data as { exitCode: number }).exitCode)).toEqual([1, 0]);
    expect(r.checks).toHaveLength(1);
    expect(r.checks[0]).toMatchObject({ command: check, exitCode: 0 });
  }, 120_000);

  it("is not offered when the task declares no checks", async () => {
    env = makeEnv({ config: baseConfig({ coding: { runner: "native" } }) });
    const client = new ScriptedClient((req) => {
      const s = servedFor(sy!, req);
      return reply(null, { ...s, toolCalls: turns(req) === 0 ? [call("write_file", { path: "src/b.ts", content: "export const b = 1;\n" })] : [call("submit_result", goodOutput(1, "core:src/b.ts#L1-L1"))] });
    });
    sy = open(env, client, { worker: true, coding: createCodingRunner(env.cfg) });
    const [t] = await sy.submitTasks([{ profile: "implement", goal: "Add b", repositoryAliases: ["core"], writableRepository: "core", hints: { difficulty: "T2" }, constraints: { acceptanceCriteria: ["b exists"], allowedPaths: ["src/**"] } }]);
    await sy.awaitResults([t!.taskId], { timeoutSeconds: 60 });
    expect((client.requests[0]!.tools ?? []).map((x) => x.function.name)).not.toContain("run_check");
  }, 60_000);
});
