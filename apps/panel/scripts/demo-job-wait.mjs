import { z } from "zod";
import { realpathSync } from "node:fs";
import path from "node:path";

const Result = z.object({ taskId: z.string().min(1), executionStatus: z.enum(["completed", "failed", "cancelled", "interrupted", "budget_exhausted"]), stopReason: z.string().optional() }).passthrough();
const AwaitedResults = z.object({ completed: z.array(Result), pending: z.array(z.unknown()), timedOut: z.boolean() }).passthrough();
const Expected = z.object({ states: z.array(Result.shape.executionStatus).min(1), stopReason: z.string().optional() }).strict();
const Question = z.object({ id: z.number().int().positive(), taskId: z.string().min(1), question: z.string().min(1), answer: z.null(), answeredAt: z.null() }).passthrough();

/** A historical fixture may change its clock only after this settles successfully.
 * Failure awaits the real SDK drain while the original clock/lease authority is intact.
 */
async function checkedWait(sy, label, wait, validate) {
  try {
    const result = await wait();
    validate(result);
    return result;
  } catch (cause) {
    try { await sy.close(); }
    catch (drainFailure) { throw new AggregateError([cause, drainFailure], `${label}: fixture failed and SDK drain failed; do not advance historical time`); }
    throw new Error(`${label}: fixture did not reach its expected state; SDK drained before any historical clock change: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}

export async function awaitDemoTaskResults(sy, ids, { label, timeoutSeconds, expected = { states: ["completed", "failed"] } }) {
  return checkedWait(sy, label, async () => {
    z.array(z.string().min(1)).min(1).refine(values => new Set(values).size === values.length).parse(ids);
    z.number().finite().positive().parse(timeoutSeconds);
    Expected.parse(expected);
    return sy.awaitResults(ids, { timeoutSeconds });
  }, raw => {
    const result = AwaitedResults.parse(raw);
    if (result.timedOut || result.pending.length) throw new Error(`unfinished tasks: ${JSON.stringify(result.pending)}`);
    const returned = new Set(result.completed.map(task => task.taskId));
    if (returned.size !== ids.length || result.completed.length !== ids.length || ids.some(id => !returned.has(id))) throw new Error("missing, duplicate or foreign terminal task result");
    for (const task of result.completed) {
      if (!expected.states.includes(task.executionStatus) || expected.stopReason && task.stopReason !== expected.stopReason)
        throw new Error(`${task.taskId}: ${task.executionStatus}/${task.stopReason ?? "no stop reason"}; expected ${expected.states.join("|")}${expected.stopReason ? `/${expected.stopReason}` : ""}`);
    }
  });
}

const ComparisonRun = z.object({ timedOut: z.literal(false), stoppedAtCap: z.literal(false), metrics: z.object({ state: z.literal("completed") }).passthrough() }).passthrough();
const Comparison = z.object({ status: z.literal("finished"), reason: z.null(), results: z.array(z.object({ goalId: z.string().min(1), team: ComparisonRun, single: ComparisonRun }).passthrough()) }).passthrough();
export async function awaitDemoComparison(sy, goalIds, run) {
  return checkedWait(sy, "team versus single comparison", run, raw => {
    z.array(z.string().min(1)).min(1).refine(values => new Set(values).size === values.length).parse(goalIds);
    const comparison = Comparison.parse(raw), returned = new Set(comparison.results.map(result => result.goalId));
    if (comparison.results.length !== goalIds.length || returned.size !== goalIds.length || goalIds.some(id => !returned.has(id))) throw new Error("missing, duplicate or foreign comparison result");
  });
}

export async function awaitDemoQuestion(sy, taskId, wait) {
  return checkedWait(sy, "pending user question", wait, raw => {
    const questions = z.array(Question).min(1).parse(raw);
    if (questions.some(question => question.taskId !== taskId)) throw new Error("question belongs to another job");
  });
}

export async function requireDemoPausedJob(sy, taskId) {
  return checkedWait(sy, "paused question job after shutdown", async () => ({ task: sy.tasks.get(taskId), questions: sy.questions({ taskId }) }), raw => {
    const row = z.object({ task: z.object({ row: z.object({ id: z.literal(taskId), state: z.literal("interrupted") }).passthrough() }).passthrough(), questions: z.array(Question).min(1) }).parse(raw);
    if (row.questions.some(question => question.taskId !== taskId)) throw new Error("retained question belongs to another job");
  });
}

/** Terminal rows are not a host-publication barrier. Drain the previous service while its
 * injected clock is still valid, then open the next phase against the same persisted fixture.
 * This never resumes an interrupted task or treats shutdown as successful task completion.
 */
export async function reopenDemoPhase(current, { hoursAgo, scenario, setPhase, open }) {
  z.number().finite().nonnegative().parse(hoursAgo);
  z.string().min(1).parse(scenario);
  if (current) await current.close();
  setPhase({ offset: Math.round(hoursAgo * 3600000), scenario });
  return open();
}

/** Bind one exact fixture operator to one SDK/database generation, never a mutable outer SDK.
 * The counter belongs to the entire seed, so reopening cannot reset the existing256-run cap.
 */
export function bindDemoCheckOperator(sdk, { actions, config, fixtureRoot, approvalCount }) {
  const root = realpathSync(z.string().min(1).parse(fixtureRoot));
  z.object({ value: z.number().int().nonnegative() }).strict().parse(approvalCount);
  let stopped = false, timer, closing;
  let active = Promise.resolve();
  const failures = [];
  const originalClose = sdk.close.bind(sdk);
  const approve = async () => {
    const projects = sdk.db.prepare("SELECT DISTINCT project_id FROM worker_action_requests").all();
    for (const { project_id: project } of projects) for (const request of actions.list({ project, status: "pending" })) {
      if (stopped) return;
      const task = sdk.tasks.get(request.taskId), relative = path.relative(root, realpathSync(request.action.cwd));
      const contained = relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
      const declared = task?.row.project_id === project && task.spec.constraints.checks?.includes(request.action.command);
      const allowed = contained && declared && !request.action.operation && ++approvalCount.value <= 256;
      await actions.decide({ project, id: request.id, decision: allowed ? "approve" : "deny",
        reason: allowed ? "Explicit offline demo operator approves this exact task-declared fixture check" : "Demo operator refuses generic, undeclared, out-of-fixture or over-limit action",
        actor: { kind: "operator" }, config });
    }
  };
  const schedule = () => {
    if (!stopped) timer = setTimeout(() => {
      active = approve().catch(error => { failures.push(error); stopped = true; }).finally(schedule);
    }, 10);
  };
  sdk.close = () => closing ??= (async () => {
    stopped = true;
    clearTimeout(timer);
    try { await active; } catch (error) { failures.push(error); }
    try { await originalClose(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "Offline demo fixture operator or SDK drain failed");
  })();
  schedule();
  return sdk;
}

/** The graph fixture intentionally retains a real same-file integration conflict for follow-up.
 * React to actual host tool results, settle its dependent join, then report blocked truthfully.
 */
export function demoModuloConflictStep(rawMessages) {
  const messages = z.array(z.object({ role: z.string(), content: z.unknown().optional(), tool_call_id: z.string().optional(),
    tool_calls: z.array(z.object({ id: z.string(), function: z.object({ name: z.string(), arguments: z.string() }).passthrough() }).passthrough()).optional() }).passthrough()).parse(rawMessages);
  const calls = new Map();
  const results = [];
  for (const [index, message] of messages.entries()) {
    if (message.role === "assistant") for (const call of message.tool_calls ?? []) calls.set(call.id, call.function);
    if (message.role !== "tool" || typeof message.content !== "string") continue;
    const call = calls.get(message.tool_call_id);
    if (!call) continue;
    let args;
    try { args = JSON.parse(call.arguments); } catch { continue; }
    results.push({ index, name: call.name, args, output: message.content });
  }
  const plan = results.filter(result => result.name === "plan_work").at(-1);
  const idFor = label => new RegExp(`^${label} -> (t_[a-z0-9]+)\\b`, "m").exec(plan?.output ?? "")?.[1];
  const modulo = idFor("modulo"), join = idFor("check-exports"), divide = idFor("divide");
  if (!modulo || !join) return null;
  const conflict = results.find(result => result.index > plan.index && ["await_tasks", "integrate_task"].includes(result.name)
    && new RegExp(`^(?:auto-integration: )?conflict integrating ${modulo}\\b`, "m").test(result.output));
  if (!conflict) return null;
  const namesJoin = result => Array.isArray(result.args?.task_ids) && result.args.task_ids.some(id => id === "check-exports" || id === join);
  const cancellation = results.find(result => result.index > conflict.index && result.name === "cancel_tasks" && namesJoin(result) && result.output === "cancellation requested");
  if (!cancellation) {
    const last = results.at(-1);
    if (last?.name === "cancel_tasks" && namesJoin(last)) return { name: "await_tasks", args: { task_ids: ["check-exports"], timeout_seconds: 60 }, text: "The join's cancellation was refused; await its protected work rather than bypassing authority." };
    return { name: "cancel_tasks", args: { task_ids: ["check-exports"] }, text: "Modulo's actual integration conflicted. Cancel its dependent join and retain the source for follow-up." };
  }
  const joined = results.some(result => result.index > cancellation.index && result.name === "await_tasks" && namesJoin(result)
    && new RegExp(`^${join} \\(check-exports\\): (?:completed|failed|cancelled|budget_exhausted)\\b`, "m").test(result.output));
  if (!joined) return { name: "await_tasks", args: { task_ids: ["check-exports"], timeout_seconds: 60 }, text: "Await the dependent join's actual terminal result before returning the blocked graph." };
  const integratedDivide = divide && results.some(result => result.name === "await_tasks" && new RegExp(`^auto-integration: integrated \\d+ commit\\(s\\) from ${divide}\\b`, "m").test(result.output));
  return { name: "finish_job", args: { status: "blocked", summary: `${integratedDivide ? "divide(a, b) is integrated. " : ""}modulo(a, b) remains unintegrated after a src/app.ts conflict; the dependent join has settled. An explicit follow-up repair is required.`,
    verified: integratedDivide ? [{ claim: "divide is integrated onto the job branch", evidence: "await_tasks host auto-integration result" }] : [],
    not_verified: ["modulo is not integrated onto the job branch", "combined integrated divide/modulo behavior is not verified"], follow_up: "Repair modulo against the current job branch, integrate it, then rerun the combined export validation." },
    text: "Report the observed integration conflict as blocked; do not claim the missing helper was delivered." };
}
