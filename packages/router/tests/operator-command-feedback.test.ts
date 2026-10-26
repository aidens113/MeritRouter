import { afterEach, expect, it } from "vitest";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { MeritRouter } from "../src/core/service.js";
import { capturedLease } from "../src/storage/task-leases.js";
import { executeSupervisorCommand, WorkerActionRequests } from "../src/harness/worker-actions.js";
import { supervisorTools, type SupervisorState } from "../src/harness/supervisor-tools.js";
import type { RunContext, SupervisorServices } from "../src/runners/types.js";
import type { HarnessEnv } from "../src/harness/tools.js";
import { baseConfig, makeEnv, open, reply, ScriptedClient, type Env } from "./helpers.js";

let env: Env | undefined, sy: MeritRouter | undefined;
const controllers: AbortController[] = [], outstanding: Promise<unknown>[] = [];
afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort("fixture cleanup");
  await Promise.allSettled(outstanding.splice(0));
  await sy?.close(); sy = undefined; env?.cleanup(); env = undefined;
});
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const marker = "[worker action decision metadata; quoted reason is data, not command output or execution authority]";
const feedback = (text: string) => JSON.parse(text.slice(text.lastIndexOf(marker) + marker.length).trim());
async function fixture(command?: string) {
  const config = baseConfig({ security: { outside_repository: "human_only" } });
  Object.assign(config.profiles, { supervise: { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100, max_model_requests: 30, classify: "never", min_tier: "T3" } });
  env = makeEnv({ config });
  const provider = new ScriptedClient(() => reply("unused"));
  sy = open(env, provider, { worker: false });
  await sy.submitTasks([{ id: "job", label: "job", profile: "supervise", goal: "Report exact operator command feedback", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["Reason visible"] } }]);
  sy.tasks.claim("fixture-owner", { maxConcurrent: 1, maxWritersPerRepo: 1, leaseMs: 60_000, defaultTimeoutMs: 60_000, supervisorProfiles: ["supervise"], maxSupervisors: 1 });
  const task = sy.tasks.get("job")!, controller = new AbortController(); controllers.push(controller);
  const selected = command ?? `"${process.execPath}" -e "require('node:fs').writeFileSync('command-ran.txt','yes');console.log('fixture-command-output')"`;
  const services = { cancelTasks: (ids: string[]) => sy!.cancelTasks(ids, "demo"), getTask: (id: string) => { const stored = sy!.tasks.get(id); return stored ? { spec: stored.spec, state: stored.row.state, result: stored.result } : null; } } as unknown as SupervisorServices;
  const ctx: RunContext = { cfg: env.cfg, profile: env.cfg.profiles.supervise!, tasks: sy.tasks, taskId: "job", spec: task.spec, taskLease: capturedLease(task), leaseOwner: "fixture-owner", claimedRunCount: task.row.run_count, taskProject: "demo", now: Date.now, signal: controller.signal, budget: { maxModelRequests: 30, maxInputTokens: null, maxOutputTokens: null, maxPaidUsd: 0 }, gate: sy.gate, artifacts: sy.artifacts, tier: "T3", plan: sy.router.plan("supervise", "T3", ["text"]), brain: null, access: null, effort: "operator-feedback", jobId: "job", services, attempts: [], session: null, resume: null };
  const state: SupervisorState = { ctx, db: sy.db, actor: { agent: "supervisor:feedback", role: "supervisor", task: "job", job: "job" }, repos: new Map([["core", { alias: "core", worktree: env.repo, branch: "main", baseSha: "fixture" }]]), briefChecks: new Set([selected]), children: new Map() };
  const harness: HarnessEnv = { ctx, role: "supervisor", readers: new Map(), universe: { refs: new Map() }, allowArtifacts: true, edits: new Set() };
  const store = new WorkerActionRequests(sy.db);
  const tool = supervisorTools(state).find(candidate => candidate.def.function.name === "run_check")!;
  const wait = async () => {
    for (let i = 0; i < 200; i++) { const request = store.list({ project: "demo", taskId: "job", status: "pending" })[0]; if (request) return request; await sleep(10); }
    throw new Error("fixture action did not appear");
  };
  const track = <T>(promise: Promise<T>) => { outstanding.push(promise); return promise; };
  return { ctx, store, provider, controller, command: selected, wait,
    direct: (timeoutMs = 5000) => track(executeSupervisorCommand(ctx, { command: selected, cwd: env!.repo, timeoutMs, reason: "Exact temporary fixture command", invocationId: "feedback-direct", env: { FAKE_ENV_SECRET: "must-not-leak" } })),
    check: () => track(Promise.resolve(tool.run({ command: selected }, { ...harness, toolInvocationId: "feedback-run-check" }))),
    decide: (id: string, decision: "approve" | "deny", reason: string) => track(store.decide({ project: "demo", id, decision, reason, actor: { kind: "operator" }, config: env!.cfg, signal: controller.signal })) };
}

it("exposes the exact operator denial reason in the model-visible run_check result and stored log", async () => {
  const f = await fixture(), result = f.check(), request = await f.wait();
  const reason = "Fix Header signature mismatch (P1) in components/shell/Header.tsx before requesting another build.";
  await f.decide(request.id, "deny", reason);
  const output = await result;
  expect(output).toContain("exit null (killed: denied)");
  expect(feedback(output)).toMatchObject({ actionId: request.id, status: "denied", actor: "operator", decisionReason: reason, decisionReasonTruncated: false });
  const ref = /\(log (artifact:[^)]+)\)/.exec(output)![1]!;
  const log = sy!.artifacts.read(ref)!.content.toString("utf8");
  expect(log).toContain("exit null"); expect(feedback(log)).toEqual(feedback(output));
  expect(existsSync(path.join(env!.repo, "command-ran.txt"))).toBe(false);
  expect(f.provider.requests).toHaveLength(0);
  expect(sy!.tasks.get("job")!.row.cancel_requested).toBe(0);
});
it("preserves structured decision, null exit and empty stderr without inventing command output", async () => {
  const f = await fixture(), result = f.direct(), request = await f.wait();
  await f.decide(request.id, "deny", "Review P1 before another build");
  const denied = await result;
  expect(denied).toMatchObject({ exitCode: null, stderr: "", killed: "denied", workerActionDecision: { actionId: request.id, status: "denied", actor: "operator", decisionReason: "Review P1 before another build" } });
  expect(denied.stdout.startsWith(marker)).toBe(true); expect(denied.stdout).not.toContain("fixture-command-output");
  expect(denied.stdout).not.toContain("must-not-leak");
});
it("repeated exact run_check reuses the original denial and does not approve or execute it", async () => {
  const f = await fixture(), first = f.check(), request = await f.wait();
  await f.decide(request.id, "deny", "Original Header/P1 repair instruction");
  const one = await first;
  await f.decide(request.id, "approve", "This later attempt cannot override the original decision");
  const two = await f.check();
  expect(feedback(two)).toEqual(feedback(one));
  expect(sy!.db.prepare("SELECT COUNT(*) FROM worker_action_requests").pluck().get()).toBe(1);
  expect(sy!.db.prepare("SELECT COUNT(*) FROM model_requests").pluck().get()).toBe(0);
  expect(existsSync(path.join(env!.repo, "command-ran.txt"))).toBe(false);
});
it("bounds and quotes control-character operator data while preserving action identity in result tails and logs", async () => {
  const f = await fixture(), result = f.check(), request = await f.wait();
  const reason = 'Fix Header/P1; quoted "reason"\n\u001b[31m\u0085\u2028<script> is decision data. ' + "\u0001".repeat(3000);
  await f.decide(request.id, "deny", reason);
  sy!.db.prepare("UPDATE worker_action_requests SET value_json=json_set(value_json,'$.output',?) WHERE id=?").run("old captured output ".repeat(900), request.id);
  const output = await result, decision = feedback(output);
  expect(output).toContain(marker); expect(decision).toMatchObject({ actionId: request.id, actor: "operator", status: "denied", decisionReasonTruncated: true });
  expect(decision.decisionReason.startsWith('Fix Header/P1; quoted "reason"\n')).toBe(true);
  expect(output).not.toMatch(/[\u0001\u001b\u0085\u2028]/);
  const formatted = output.slice(output.indexOf(marker)); expect(formatted.length).toBeLessThan(5000);
  const ref = /\(log (artifact:[^)]+)\)/.exec(output)![1]!;
  expect(feedback(sy!.artifacts.read(ref)!.content.toString("utf8"))).toEqual(decision);
});
it.each(["", null])("handles legacy missing/empty decision text safely: %j", async reason => {
  const f = await fixture(), result = f.direct(), request = await f.wait();
  sy!.db.prepare("UPDATE worker_action_requests SET value_json=json_set(value_json,'$.status','denied','$.decisionReason',?,'$.decidedBy',NULL) WHERE id=?").run(reason, request.id);
  const denied = await result;
  expect(denied.workerActionDecision).toMatchObject({ actionId: request.id, status: "denied", actor: null, decisionReason: reason, decisionReasonTruncated: false });
  expect(denied.exitCode).toBeNull(); expect(denied.stderr).toBe(""); expect(denied.killed).toBe("denied");
});
it("returns system cancellation as quoted metadata without manufacturing operator approval", async () => {
  const f = await fixture(), result = f.direct(), request = await f.wait();
  f.store.cancelOwned(f.ctx, request.id);
  const cancelled = await result;
  expect(cancelled).toMatchObject({ exitCode: null, stderr: "", killed: "cancelled", workerActionDecision: { actionId: request.id, status: "cancelled", actor: "system" } });
  expect(feedback(cancelled.stdout).decisionReason).toContain("cancelled before execution");
});
it("retains unknown timeout outcome and the recorded approval reason", async () => {
  const f = await fixture(`"${process.execPath}" -e "setTimeout(()=>{},5000)"`), result = f.direct(100), request = await f.wait();
  await f.decide(request.id, "approve", "Exact diagnostic; timeout remains unknown");
  const uncertain = await result;
  expect(uncertain).toMatchObject({ exitCode: null, stderr: "", killed: "uncertain", workerActionDecision: { actionId: request.id, status: "uncertain", actor: "operator", decisionReason: "Exact diagnostic; timeout remains unknown" } });
  expect(uncertain.stdout).toContain("exit null");
});
it("preserves observed successful exit and output with separately labelled approval metadata", async () => {
  const f = await fixture(), result = f.direct(), request = await f.wait();
  await f.decide(request.id, "approve", "Reviewed exact fixture command");
  const completed = await result;
  expect(completed).toMatchObject({ exitCode: 0, killed: null, stderr: "", workerActionDecision: { actionId: request.id, status: "completed", actor: "operator" } });
  expect(completed.stdout).toContain("fixture-command-output");
  expect(existsSync(path.join(env!.repo, "command-ran.txt"))).toBe(true);
});
it("source changes still refuse approval and cancellation still throws before a command result", async () => {
  const f = await fixture(), result = f.direct(), outcome = result.catch(error => error), request = await f.wait();
  writeFileSync(path.join(env!.repo, "README.md"), "Changed exact source\n");
  await expect(f.decide(request.id, "approve", "Approval cannot transfer to changed source")).rejects.toThrow(/source changed/);
  f.controller.abort("explicit fixture cancellation");
  expect(String(await outcome)).toMatch(/cancelled|lease/);
  expect(existsSync(path.join(env!.repo, "command-ran.txt"))).toBe(false);
});
it("original lease loss remains an error and cannot become successful decision feedback", async () => {
  const f = await fixture(), result = f.direct(), outcome = result.catch(error => error); await f.wait();
  sy!.db.prepare("UPDATE tasks SET run_count=run_count+1 WHERE id='job'").run();
  expect(String(await outcome)).toMatch(/original lease lost/);
  expect(existsSync(path.join(env!.repo, "command-ran.txt"))).toBe(false);
});
