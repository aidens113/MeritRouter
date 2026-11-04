import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Computed file URL exercises the real concern-owned panel fixture module without copying it.
const moduleUrl = new URL("../../../apps/panel/scripts/demo-job-wait.mjs", import.meta.url).href;
const { awaitDemoTaskResults, awaitDemoComparison, awaitDemoQuestion, requireDemoPausedJob, reopenDemoPhase, bindDemoCheckOperator, demoModuloConflictStep } = await import(moduleUrl);
const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith("meritrouter-demo-phase-")) throw new Error("Refusing non-fixture cleanup");
    rmSync(root, { recursive: true, force: true });
  }
});
function fixtureRoot() { const root = mkdtempSync(path.join(tmpdir(), "meritrouter-demo-phase-")); roots.push(root); return root; }
const terminal = (stopReason = "supervisor_completed", executionStatus = "completed") => ({ completed: [{ taskId: "job", executionStatus, stopReason }], pending: [], timedOut: false });
const options = { label: "job fixture", timeoutSeconds: 180, expected: { states: ["completed"], stopReason: "supervisor_completed" } };
function sdkFor(result: unknown) { return { awaitResults: vi.fn(async () => result), close: vi.fn(async () => {}) }; }

it("retains the declared timeout and advances only after the actual expected terminal result", async () => {
  const result = terminal(), sdk = sdkFor(result);
  let offset = 2;
  expect(await awaitDemoTaskResults(sdk, ["job"], options)).toBe(result);
  offset = 1.9;
  expect(offset).toBe(1.9);
  expect(sdk.awaitResults).toHaveBeenCalledExactlyOnceWith(["job"], { timeoutSeconds: 180 });
  expect(sdk.close).not.toHaveBeenCalled();
});

it.each([
  { name: "pending", result: { ...terminal(), pending: [{ taskId: "job" }] } },
  { name: "timeout even with a result", result: { ...terminal(), timedOut: true } },
  { name: "missing result", result: { ...terminal(), completed: [] } },
  { name: "duplicate result", result: { ...terminal(), completed: [...terminal().completed, ...terminal().completed] } },
  { name: "foreign result", result: { ...terminal(), completed: [{ ...terminal().completed[0], taskId: "other" }] } },
  { name: "failed state", result: terminal("internal_error", "failed") },
  { name: "blocked instead of completed", result: terminal("supervisor_blocked") },
  { name: "malformed result", result: { completed: [], timedOut: false } },
])("awaits SDK drain before rejecting $name; the historical clock never advances", async ({ result }) => {
  let release!: () => void, settled = false, offset = 2;
  const gate = new Promise<void>(resolve => { release = resolve; }), events: string[] = [];
  const sdk = { awaitResults: vi.fn(async () => result), close: vi.fn(async () => { events.push("drain-start"); await gate; events.push("drain-end"); }) };
  const running = (async () => { await awaitDemoTaskResults(sdk, ["job"], options); offset = 1.9; })().then(() => null, error => error).finally(() => { settled = true; });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(events).toEqual(["drain-start"]);
  expect(offset).toBe(2);
  expect(settled).toBe(false);
  release();
  expect(await running).toBeInstanceOf(Error);
  expect(events).toEqual(["drain-start", "drain-end"]);
  expect(offset).toBe(2);
  expect(sdk.close).toHaveBeenCalledTimes(1);
});

it("accepts the deliberately blocked undo job only with its actual blocked stop reason", async () => {
  const sdk = sdkFor(terminal("supervisor_blocked"));
  await expect(awaitDemoTaskResults(sdk, ["job"], { ...options, expected: { states: ["completed"], stopReason: "supervisor_blocked" } })).resolves.toMatchObject({ completed: [{ stopReason: "supervisor_blocked" }] });
  expect(sdk.close).not.toHaveBeenCalled();
});

it("drains after a rejected wait and reports a drain failure without claiming quiescence", async () => {
  const waitFailure = new Error("wait failed"), drainFailure = new Error("drain failed");
  const sdk = { awaitResults: vi.fn(async () => { throw waitFailure; }), close: vi.fn(async () => { throw drainFailure; }) };
  const error = await awaitDemoTaskResults(sdk, ["job"], options).then(() => null, (error: unknown) => error);
  expect(error).toBeInstanceOf(AggregateError);
  expect((error as AggregateError).errors).toEqual([waitFailure, drainFailure]);
  expect(sdk.close).toHaveBeenCalledTimes(1);
});

const comparison = () => ({ status: "finished", reason: null, results: [{ goalId: "goal", team: { timedOut: false, stoppedAtCap: false, metrics: { state: "completed" } }, single: { timedOut: false, stoppedAtCap: false, metrics: { state: "completed" } } }] });
it.each(["aborted", "reason", "timed-out", "cap", "still-running", "missing", "duplicate", "foreign"])("rejects %s comparison records even when their outer status claims finished", async condition => {
  const result = comparison();
  if (condition === "aborted") result.status = "aborted";
  if (condition === "reason") (result as { reason: string | null }).reason = "failed";
  if (condition === "timed-out") result.results[0]!.team.timedOut = true;
  if (condition === "cap") result.results[0]!.single.stoppedAtCap = true;
  if (condition === "still-running") result.results[0]!.team.metrics.state = "running";
  if (condition === "missing") result.results = [];
  if (condition === "duplicate") result.results.push(structuredClone(result.results[0]!));
  if (condition === "foreign") result.results[0]!.goalId = "foreign";
  const sdk = sdkFor(null);
  await expect(awaitDemoComparison(sdk, ["goal"], async () => result)).rejects.toThrow("SDK drained");
  expect(sdk.close).toHaveBeenCalledTimes(1);
});

it("accepts a comparison only when every expected goal and both runs actually completed", async () => {
  const result = comparison(), sdk = sdkFor(null);
  expect(await awaitDemoComparison(sdk, ["goal"], async () => result)).toBe(result);
  expect(sdk.close).not.toHaveBeenCalled();
});

const question = () => ({ id: 1, taskId: "job", question: "Which interface?", answer: null, answeredAt: null });
it("requires an actual unanswered job question and a retained interrupted job after shutdown", async () => {
  const sdk = { ...sdkFor(null), tasks: { get: () => ({ row: { id: "job", state: "interrupted" } }) }, questions: () => [question()] };
  await expect(awaitDemoQuestion(sdk, "job", async () => [question()])).resolves.toHaveLength(1);
  await expect(requireDemoPausedJob(sdk, "job")).resolves.toMatchObject({ task: { row: { state: "interrupted" } } });
  expect(sdk.close).not.toHaveBeenCalled();
});

it.each(["missing", "answered", "foreign"])("drains rather than pretending a %s question fixture paused correctly", async condition => {
  const questions: Array<Record<string, unknown>> = condition === "missing" ? [] : [{ ...question(), ...(condition === "answered" ? { answer: "already answered" } : { taskId: "other" }) }];
  const sdk = sdkFor(null);
  await expect(awaitDemoQuestion(sdk, "job", async () => questions)).rejects.toThrow("SDK drained");
  expect(sdk.close).toHaveBeenCalledTimes(1);
});

it.each(["running", "cancelled", "missing"])("rejects a %s question job after shutdown", async state => {
  const sdk = { ...sdkFor(null), tasks: { get: () => state === "missing" ? undefined : { row: { id: "job", state } } }, questions: () => [question()] };
  await expect(requireDemoPausedJob(sdk, "job")).rejects.toThrow("SDK drained");
  expect(sdk.close).toHaveBeenCalledTimes(1);
});

it("keeps the old clock until public close drains reports, then opens the next phase without resuming tasks", async () => {
  let release!: () => void, offset = 7200000;
  const report = new Promise<void>(resolve => { release = resolve; }), events: string[] = [];
  const previous = { close: vi.fn(async () => { events.push("drain-old-reports"); await report; events.push("old-closed"); }) };
  const next = { resumeSession: vi.fn(), startWorker: vi.fn() };
  const open = vi.fn(() => { events.push("open-new"); return next; });
  const running = reopenDemoPhase(previous, { hoursAgo: 1.9, scenario: "ok", setPhase: (phase: { offset: number }) => { events.push("move-clock"); offset = phase.offset; }, open });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  expect(offset).toBe(7200000);
  expect(open).not.toHaveBeenCalled();
  expect(events).toEqual(["drain-old-reports"]);
  release();
  expect(await running).toBe(next);
  expect(offset).toBe(6840000);
  expect(events).toEqual(["drain-old-reports", "old-closed", "move-clock", "open-new"]);
  expect(next.resumeSession).not.toHaveBeenCalled();
  expect(next.startWorker).not.toHaveBeenCalled();
});

it("refuses to advance historical time or open another phase when the old SDK drain fails", async () => {
  const setPhase = vi.fn(), open = vi.fn(), failure = new Error("report publication drain failed");
  await expect(reopenDemoPhase({ close: async () => { throw failure; } }, { hoursAgo: 1, scenario: "ok", setPhase, open })).rejects.toBe(failure);
  expect(setPhase).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
});

function operatorFixture(root: string, label: string) {
  const request = { id: `action-${label}`, taskId: `task-${label}`, action: { cwd: root, command: "declared-check", operation: undefined as unknown } };
  let pending = [request];
  const sdk = { db: { prepare: vi.fn(() => ({ all: () => [{ project_id: "demo" }] })) }, tasks: { get: vi.fn(() => ({ row: { project_id: "demo" }, spec: { constraints: { checks: ["declared-check"] } } })) }, close: vi.fn(async () => {}) };
  const actions = { list: vi.fn(() => pending), decide: vi.fn(async (_input: unknown) => { pending = []; }) };
  return { sdk, actions, request };
}

it("binds each reopened operator to its own SDK/actions and preserves the global256 approval ceiling", async () => {
  const root = fixtureRoot(), approvalCount = { value: 255 }, old = operatorFixture(root, "old"), fresh = operatorFixture(root, "new");
  vi.useFakeTimers();
  bindDemoCheckOperator(old.sdk, { actions: old.actions, config: {}, fixtureRoot: root, approvalCount });
  let next: typeof fresh.sdk | undefined;
  try {
    await vi.advanceTimersByTimeAsync(10);
    expect(old.actions.decide).toHaveBeenCalledWith(expect.objectContaining({ id: "action-old", decision: "approve" }));
    expect(approvalCount.value).toBe(256);
    next = await reopenDemoPhase(old.sdk, { hoursAgo: 1, scenario: "ok", setPhase: () => {}, open: () => bindDemoCheckOperator(fresh.sdk, { actions: fresh.actions, config: {}, fixtureRoot: root, approvalCount }) });
    const oldPolls = old.sdk.db.prepare.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20);
    expect(old.sdk.db.prepare).toHaveBeenCalledTimes(oldPolls);
    expect(fresh.actions.decide).toHaveBeenCalledWith(expect.objectContaining({ id: "action-new", decision: "deny" }));
    expect(fresh.sdk.tasks.get).toHaveBeenCalledWith("task-new");
    expect(old.sdk.tasks.get).not.toHaveBeenCalledWith("task-new");
    expect(approvalCount.value).toBe(257);
  } finally { await old.sdk.close(); await next?.close(); }
});

it("waits for the old operator's in-flight decision before closing its own SDK", async () => {
  const root = fixtureRoot(), f = operatorFixture(root, "slow"), order: string[] = [];
  let release!: () => void;
  const active = new Promise<void>(resolve => { release = resolve; });
  f.actions.decide = vi.fn(async (_input: unknown) => { order.push("deciding"); await active; order.push("decision-settled"); });
  f.sdk.close = vi.fn(async () => { order.push("sdk-closed"); });
  vi.useFakeTimers();
  bindDemoCheckOperator(f.sdk, { actions: f.actions, config: {}, fixtureRoot: root, approvalCount: { value: 0 } });
  await vi.advanceTimersByTimeAsync(10);
  const closed = f.sdk.close();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  expect(order).toEqual(["deciding"]);
  release(); await closed;
  expect(order).toEqual(["deciding", "decision-settled", "sdk-closed"]);
});

it.each(["outside", "undeclared", "foreign-project", "operation"])("keeps the fixture operator's %s request refusal across phase generations", async condition => {
  const root = fixtureRoot(), f = operatorFixture(root, "denied");
  if (condition === "outside") f.request.action.cwd = fixtureRoot();
  if (condition === "undeclared") f.request.action.command = "arbitrary-shell";
  if (condition === "foreign-project") f.sdk.tasks.get = vi.fn(() => ({ row: { project_id: "other" }, spec: { constraints: { checks: ["declared-check"] } } }));
  if (condition === "operation") f.request.action.operation = { name: "lab_restart" };
  vi.useFakeTimers();
  bindDemoCheckOperator(f.sdk, { actions: f.actions, config: {}, fixtureRoot: root, approvalCount: { value: 0 } });
  try {
    await vi.advanceTimersByTimeAsync(10);
    expect(f.actions.decide).toHaveBeenCalledWith(expect.objectContaining({ decision: "deny" }));
  } finally { await f.sdk.close(); }
});

type FixtureMessage = { role: string; content?: string; tool_call_id?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
function exchange(messages: FixtureMessage[], name: string, args: unknown, output: string) {
  const id = `fixture-call-${messages.length}`;
  messages.push({ role: "assistant", tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }] }, { role: "tool", tool_call_id: id, content: output });
}
function graphConflict() {
  const messages: FixtureMessage[] = [];
  exchange(messages, "plan_work", {}, "divide -> t_divide (queued)\nmodulo -> t_modulo (queued)\ncheck-exports -> t_join (queued)");
  exchange(messages, "await_tasks", {}, "auto-integration: integrated 1 commit(s) from t_divide onto job branch\nauto-integration: conflict integrating t_modulo; nothing was changed and no acceptance was recorded. Conflicting files: src/app.ts.\nt_join (check-exports): still waiting_for_dependencies");
  return messages;
}

it("reacts immediately to the actual modulo integration conflict and settles the join before reporting blocked", () => {
  const messages = graphConflict();
  expect(demoModuloConflictStep(messages)).toMatchObject({ name: "cancel_tasks", args: { task_ids: ["check-exports"] } });
  exchange(messages, "cancel_tasks", { task_ids: ["check-exports"] }, "cancellation requested");
  expect(demoModuloConflictStep(messages)).toMatchObject({ name: "await_tasks", args: { task_ids: ["check-exports"], timeout_seconds: 60 } });
  exchange(messages, "await_tasks", { task_ids: ["check-exports"] }, "t_join (check-exports): cancelled, acceptance not_verified");
  const step = demoModuloConflictStep(messages);
  expect(step).toMatchObject({ name: "finish_job", args: { status: "blocked", verified: [{ claim: "divide is integrated onto the job branch" }] } });
  expect(step.args.not_verified).toContain("modulo is not integrated onto the job branch");
  expect(step.args.follow_up).toContain("Repair modulo");
});

it.each(["still-running", "foreign-id", "wrong-tool"])("does not finish after %s join evidence", condition => {
  const messages = graphConflict();
  exchange(messages, "cancel_tasks", { task_ids: ["check-exports"] }, "cancellation requested");
  exchange(messages, condition === "wrong-tool" ? "read_file" : "await_tasks", { task_ids: ["check-exports"] }, condition === "still-running" ? "t_join (check-exports): still running" : condition === "foreign-id" ? "t_other (check-exports): cancelled" : "t_join (check-exports): cancelled");
  expect(demoModuloConflictStep(messages)).toMatchObject({ name: "await_tasks" });
});

it("awaits a refused protected cancellation rather than fabricating authority or finishing", () => {
  const messages = graphConflict();
  exchange(messages, "cancel_tasks", { task_ids: ["check-exports"] }, "error: cannot cancel an operator-approved running action; continue await_tasks");
  expect(demoModuloConflictStep(messages)).toMatchObject({ name: "await_tasks" });
});

it.each(["user-text", "unrelated-tool", "foreign-conflict"])("does not invent a modulo conflict from %s", condition => {
  const messages: FixtureMessage[] = [];
  exchange(messages, "plan_work", {}, "modulo -> t_modulo (queued)\ncheck-exports -> t_join (queued)");
  const conflict = "auto-integration: conflict integrating t_modulo";
  if (condition === "user-text") messages.push({ role: "user", content: conflict });
  else exchange(messages, condition === "unrelated-tool" ? "read_file" : "await_tasks", {}, condition === "foreign-conflict" ? "auto-integration: conflict integrating t_other" : conflict);
  expect(demoModuloConflictStep(messages)).toBeNull();
});

it("does not claim divide integration without its observed host receipt and preserves an already-completed join", () => {
  const messages = graphConflict();
  messages[3]!.content = messages[3]!.content!.replace("auto-integration: integrated 1 commit(s) from t_divide onto job branch\n", "");
  exchange(messages, "cancel_tasks", { task_ids: ["check-exports"] }, "cancellation requested");
  exchange(messages, "await_tasks", { task_ids: ["check-exports"] }, "t_join (check-exports): completed, acceptance not_verified");
  const step = demoModuloConflictStep(messages);
  expect(step).toMatchObject({ name: "finish_job", args: { status: "blocked", verified: [] } });
  expect(step.args.summary).not.toContain("divide(a, b) is integrated");
  expect(step.args.summary).not.toContain("join cancelled");
});
