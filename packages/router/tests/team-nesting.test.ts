import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { MeritRouter } from "../src/core/service.js";
import type { ChatRequest } from "../src/gateway/types.js";
import { blame } from "../src/attribution/index.js";
import { carvedRequests, carvesOf, childRequestBudget } from "../src/admission/admission.js";
import { FAULT_ENV, isSimulatedCrash, resetFaults, simulatedCrashCount } from "../src/core/faults.js";
import { MERGE_PICK_FAULT, MergeQueue, pickedSources, type MergeHooks, type MergeItem } from "../src/workspaces/merge-queue.js";
import { baseConfig, goodOutput, makeEnv, openWithTestSupervisor as open, reply, ScriptedClient, servedFor, summarizeTask, type Env } from "./helpers.js";

/**
 * Agent teams (T2): sub-supervisors (a job delegating a `supervise` sub-job on its own branch with
 * a carved budget) and the merge queue (serialised, attribution-preserving, crash-safe
 * integration onto a job branch).
 */

let env: Env | undefined;
let sy: MeritRouter | undefined;
beforeEach(() => resetFaults());
afterEach(async () => {
  delete process.env[FAULT_ENV];
  resetFaults();
  await sy?.close();
  sy = undefined;
  env?.cleanup();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const call = (name: string, args: unknown, id = name) => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
const turns = (req: ChatRequest) => req.messages.filter((m) => m.role === "assistant").length;
const isSupervisor = (req: ChatRequest) => String(req.messages[0]!.content).startsWith("# Supervisor charter");
const goalOf = (req: ChatRequest) => String(req.messages[1]?.content ?? "");
const toolNames = (req: ChatRequest) => (req.tools ?? []).map((t) => t.function.name);
const toolOutputs = (req: ChatRequest) => req.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
const check = `node -e "process.exit(require('fs').readFileSync('src/app.ts','utf8').includes('subtract')?0:1)"`;
const gitOut = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, stdio: "pipe" }).toString();
const count = (text: string, needle: string) => text.split(needle).length - 1;

function teamConfig(extra: Record<string, unknown> = {}) {
  // supervisor.max_concurrent_jobs stays at its default (1): a sub-job must not need a job slot.
  const cfg = baseConfig({ coding: { runner: "native" }, ...extra });
  (cfg.profiles as Record<string, unknown>).supervise = { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100, max_model_requests: 30, max_output_tokens: 4000, classify: "never", min_tier: "T3" };
  return cfg;
}

/** Worker: add subtract() (one commit per response), optionally multiply() in a second commit, then submit. */
function worker(req: ChatRequest, twoCommits = false) {
  const s = servedFor(sy!, req);
  const n = turns(req);
  if (n === 0) return reply(null, { ...s, toolCalls: [call("replace_in_file", { path: "src/app.ts", old_text: "export function add", new_text: "export function subtract(a: number, b: number) {\n  return a - b;\n}\n\nexport function add" })] });
  if (n === 1 && twoCommits) return reply(null, { ...s, toolCalls: [call("replace_in_file", { path: "src/app.ts", old_text: "export function add", new_text: "export function multiply(a: number, b: number) {\n  return a * b;\n}\n\nexport function add" })] });
  return reply(null, { ...s, toolCalls: [call("submit_result", goodOutput(1, "core:src/app.ts#L1-L3"))] });
}

const PARENT_GOAL = "Deliver subtract() through a sub-team";
const CHILD_GOAL = "Implement subtract() with your own worker";

describe("sub-supervisors", () => {
  it("a parent job delegates a sub-job that runs its own worker; the parent integrates the sub-job's branch with the worker's attribution intact", async () => {
    // This fixture scripts nested team behavior, independently of provider AIMD slots.
    env = makeEnv({ config: teamConfig({ team: { provider_concurrency_enabled: false } }) });
    const parentScript = [
      () => [call("delegate", { tasks: [{ label: "sub", profile: "supervise", goal: CHILD_GOAL, acceptance_criteria: ["subtract exists"], checks: [check] }] })],
      () => [call("await_tasks", { timeout_seconds: 120 })],
      () => [call("integrate_task", { task_id: "sub" })],
      () => [call("integrate_task", { task_id: "sub", repository: "core" })],
      () => [call("finish_job", { status: "completed", summary: "subtract delivered by the sub-team", verified: [{ claim: "subtract on the job branch", evidence: "job checks after integration" }], not_verified: [] })],
    ];
    const childScript = [
      // Depth 2 is the limit (team.max_depth 2): a sub-job cannot start another sub-job.
      () => [call("delegate", { tasks: [{ label: "deeper", profile: "supervise", goal: "nested further", acceptance_criteria: ["x"] }] })],
      () => [call("delegate", { tasks: [{ label: "w1", profile: "implement", goal: "Add subtract(a, b) to src/app.ts", acceptance_criteria: ["subtract exists"], allowed_paths: ["src/**"], checks: [check], difficulty: "T2" }] })],
      () => [call("await_tasks", { timeout_seconds: 120 })],
      () => [call("integrate_task", { task_id: "w1" })],
      () => [call("brain_set_job_section", { body: "w1 integrated; subtract exists on the sub-job branch." })],
      () => [call("finish_job", { status: "completed", summary: "subtract added", verified: [{ claim: "subtract exists", evidence: "check" }], not_verified: [] })],
    ];
    const client = new ScriptedClient(async (req) => {
      if (!isSupervisor(req)) return worker(req);
      const script = goalOf(req).includes(CHILD_GOAL) ? childScript : parentScript;
      const calls = script[turns(req)]!();
      // await_tasks deliberately returns for pending operator actions. Do not advance
      // this fixed script into integration until the fixture operator finishes them.
      if (calls.some(tool => tool.function.name === "integrate_task")) {
        const jobId = /Job id: (\S+)/.exec(String(req.messages[0]!.content))![1]!;
        const label = JSON.parse(calls[0]!.function.arguments).task_id;
        const child = sy!.tasks.childrenOf(jobId).find(task => task.spec.label === label)!;
        const finished = await sy!.awaitResults([child.row.id], { timeoutSeconds: 120 });
        expect(finished.timedOut, JSON.stringify(finished.pending)).toBe(false);
      }
      return reply(null, { ...servedFor(sy!, req), toolCalls: calls });
    });
    sy = open(env, client, { worker: true });
    const job = await sy.startJob({ goal: PARENT_GOAL, repositories: ["core"], checks: [check], label: "parent" });
    const awaited = await sy.awaitResults([job.taskId], { timeoutSeconds: 170 });
    expect(awaited.timedOut, JSON.stringify({ pending: awaited.pending, states: sy.listTasks(undefined, 50).map(({ taskId, state, stateReason, goal }) => ({ taskId, state, stateReason, goal })), actions: sy.db.prepare("SELECT task_id, json_extract(value_json,'$.status') AS status FROM worker_action_requests").all(), last: client.requests.slice(-8).map(request => ({ goal: String(request.messages[1]?.content).slice(0, 100), tools: request.messages.filter(message => message.role === "tool").slice(-3) })) }, null, 2)).toBe(false);
    const r = awaited.completed[0]!;
    expect(r.stopReason).toBe("supervisor_completed");
    expect(r.acceptanceStatus).toBe("met");

    const [child] = sy.tasks.childrenOf(job.taskId);
    expect(child!.spec).toMatchObject({ profile: "supervise", label: "sub", parentTaskId: job.taskId });
    expect(child!.result).toMatchObject({ stopReason: "supervisor_completed", acceptanceStatus: "met" });
    const [w1] = sy.tasks.childrenOf(child!.row.id);
    expect(w1!.spec).toMatchObject({ profile: "implement", label: "w1", parentTaskId: child!.row.id });

    // Requests in order, per agent: the parent, the sub-job, and their tools.
    const parentReqs = client.requests.filter((q) => isSupervisor(q) && !goalOf(q).includes(CHILD_GOAL));
    const childReqs = client.requests.filter((q) => isSupervisor(q) && goalOf(q).includes(CHILD_GOAL));
    const parentLast = parentReqs.at(-1)!;
    const childLast = childReqs.at(-1)!;
    // The budget: half of what the parent had left (30 - 1 used) when it delegated.
    expect(child!.spec.budget?.maxModelRequests).toBe(14);
    expect(carvesOf(sy.db, job.taskId)).toEqual([expect.objectContaining({ childTaskId: child!.row.id, requests: 14, parentRemaining: 29, share: 0.5, depth: 2 })]);
    expect(toolOutputs(parentLast)[0]).toMatch(/sub -> t_\w+ \(queued\); sub-supervisor with 14 requests on branch meritrouter\/job-t_/);
    // A finished sub-job counts the supervisor and its workers, not its whole carve.
    const childWorkerRequests = sy!.tasks.childrenOf(child!.row.id).reduce((used, task) => used + sy!.admission.taskTotals(task.row.id).requests, 0);
    expect(carvedRequests(sy.db, job.taskId)).toBe(sy.admission.taskTotals(child!.row.id).requests + childWorkerRequests);
    expect(childReqs.length).toBe(6);

    // Depth: only the parent is offered `supervise`, and the sub-job's attempt is refused by the tool.
    const profiles = (q: ChatRequest) => ((q.tools!.find((t) => t.function.name === "delegate")!.function.parameters as { properties: { tasks: { items: { properties: { profile: { enum: string[] } } } } } }).properties.tasks.items.properties.profile.enum);
    expect(profiles(parentLast)).toContain("supervise");
    expect(profiles(childLast)).not.toContain("supervise");
    expect(toolOutputs(childLast)[0]).toMatch(/^error: deeper: sub-supervisors are limited to team.max_depth 2; this job is at depth 2/);
    // A sub-job never rewrites the parent's Current State; it has its own section tool instead.
    expect(toolNames(childLast)).toContain("brain_set_job_section");
    expect(toolNames(childLast)).not.toContain("brain_set_current_state");
    expect(toolNames(parentLast)).toContain("brain_set_current_state");
    expect(toolNames(parentLast)).not.toContain("brain_set_job_section");
    expect(String(childLast.messages[0]!.content)).toMatch(/Sub-job of job t_\w+ \(supervisor level 2 of at most 2\)/);

    // Branches: the sub-job's forks from the parent's as it was at delegation.
    const parentBranch = `meritrouter/job-${job.taskId}`;
    const childBranch = `meritrouter/job-${child!.row.id}`;
    const parentBase = sy.sessions.forTask(job.taskId).at(-1)!.workspace!.repos[0]!.baseCommit!;
    expect(child!.spec.context.baseCommits).toEqual({ core: parentBase });
    expect(gitOut(env.repo, "merge-base", childBranch, parentBranch).trim()).toBe(parentBase);

    // The worker's commit reached the parent's branch with its author and trailers; blame names the worker.
    const log = gitOut(env.repo, "log", "--format=%an%x09%(trailers:key=Agent,valueonly,separator=)%x09%(trailers:key=Task,valueonly,separator=)%x09%(trailers:key=Model,valueonly,separator=)", `${parentBase}..${parentBranch}`);
    const workerLines = log.split("\n").filter((l) => l.includes("implementer:w1"));
    expect(workerLines).toHaveLength(1);
    expect(workerLines[0]).toMatch(new RegExp(`implementer:w1\\t${w1!.row.id}\\topenrouter/vendor/big-a:free`));
    const body = gitOut(env.repo, "log", "--format=%B", "-1", "--grep=implementer", parentBranch);
    expect(count(body, "(cherry picked from commit")).toBe(2); // worker -> sub-job branch -> parent branch
    const parentWorktree = sy.sessions.forTask(job.taskId).at(-1)!.workspace!.repos[0]!.worktree;
    const sub = (await blame(parentWorktree, "src/app.ts")).find((l) => l.text.includes("return a - b"))!;
    expect(sub).toMatchObject({ agent: "implementer:w1", task: w1!.row.id, model: "openrouter/vendor/big-a:free" });

    // The merge queue: the worker onto the sub-job's branch, the sub-job onto the parent's; job checks ran after each.
    const parentQueue = new MergeQueue(sy.db, sy.tasks, "reader");
    expect(parentQueue.forJob(job.taskId)).toEqual([expect.objectContaining({ kind: "job", taskId: child!.row.id, branch: parentBranch, state: "integrated", commits: expect.any(Array) })]);
    expect(parentQueue.forJob(child!.row.id)).toEqual([expect.objectContaining({ kind: "task", taskId: w1!.row.id, branch: childBranch, state: "integrated" })]);
    expect(parentQueue.forJob(job.taskId)[0]!.detail.checks).toEqual([expect.objectContaining({ command: check, exitCode: 0 })]);
    expect(toolOutputs(parentLast)[2]).toMatch(/integrated \d+ commit\(s\) from t_\w+ onto meritrouter\/job-.*job checks after it: 1 passed/);
    // Integrating again picks nothing twice.
    expect(toolOutputs(parentLast)[3]).toMatch(/already integrated onto meritrouter\/job-.*nothing was picked again/);
    expect(sy.tasks.events(child!.row.id, 200).map((e) => e.type)).toEqual(expect.arrayContaining(["merge_queued", "merge_integrating", "merge_integrated", "merge_checks", "integrated"]));

    // Sessions link the tree: the sub-job's session's parent is the parent job's session.
    const parentSession = sy.sessions.forTask(job.taskId).at(-1)!;
    expect(sy.sessions.forTask(child!.row.id).at(-1)!.parentSessionId).toBe(parentSession.id);

    // Memory: one working document; the sub-job's section holds its brief, its worker's brief, and its status.
    await sy.close();
    sy = undefined;
    const doc = readFileSync(path.join(env.dir, `brain/projects/demo/working/job-${job.taskId}.md`), "utf8");
    const section = doc.slice(doc.indexOf("## Sub-job: sub"), doc.indexOf("## Work Ledger"));
    expect(section).toContain("### Brief: sub");
    expect(section).toContain("request budget 14 of 29 remaining");
    expect(section).toContain("### Brief: w1");
    expect(section).toMatch(/\*\*Sub-job status:\*\*\nw1 integrated/);
    expect(doc).toMatch(/Sub-job sub completed/);
    expect(doc).toMatch(/Job completed/);
  }, 240_000);
});

// ---------- the merge queue against real git ----------

interface Fixture {
  repo: string;
  base: string;
  branchWt: string;
  jobId: string;
  taskIds: string[];
}

/** A repository with a job branch worktree and real task rows (merge_queue items reference tasks). */
async function fixture(n: number): Promise<Fixture> {
  env = makeEnv({ files: { "f.txt": "one\ntwo\nthree\nfour\nfive\n" } });
  sy = open(env, new ScriptedClient(() => reply("{}")));
  const subs = sy.tasks.submit(Array.from({ length: n + 1 }, (_, i) => ({ ...summarizeTask(), label: `t${i}` }) as never));
  const base = gitOut(env.repo, "rev-parse", "HEAD").trim();
  const branchWt = path.join(env.dir, "job-wt");
  gitOut(env.repo, "worktree", "add", "-q", "-b", "job", branchWt, base);
  return { repo: env.repo, base, branchWt, jobId: subs[0]!.taskId, taskIds: subs.slice(1).map((s) => s.taskId) };
}

/** A task's worktree (detached at the base) with one commit per edit, each with worker trailers. */
function taskWork(f: Fixture, name: string, edits: Array<(text: string) => string>): { wt: string; head: string; commits: string[] } {
  const wt = path.join(env!.dir, `wt-${name}`);
  gitOut(f.repo, "worktree", "add", "-q", "--detach", wt, f.base);
  for (const [i, edit] of edits.entries()) {
    const p = path.join(wt, "f.txt");
    writeFileSync(p, edit(readFileSync(p, "utf8")));
    gitOut(wt, "commit", "-q", "-am", `${name} edit ${i}`, "--trailer", `Agent: implementer:${name}`, "--trailer", `Task: ${name}`);
  }
  const head = gitOut(wt, "rev-parse", "HEAD").trim();
  return { wt, head, commits: gitOut(wt, "rev-list", "--reverse", `${f.base}..${head}`).split("\n").filter(Boolean) };
}

/** The job branch's file, line endings normalised (checkouts may be CRLF under core.autocrlf). */
const fileText = (f: Fixture) => readFileSync(path.join(f.branchWt, "f.txt"), "utf8").replace(/\r\n/g, "\n");

const line = (n: number, v: string) => (t: string) => t.split("\n").map((l, i) => (i === n - 1 ? (l.endsWith("\r") ? `${v}\r` : v) : l)).join("\n");

function enqueue(q: MergeQueue, f: Fixture, taskId: string, w: { wt: string; head: string; commits: string[] }): MergeItem {
  return q.enqueue({ jobId: f.jobId, taskId, kind: "task", repo: "core", branch: "job", integrationWorktree: f.branchWt, sourceWorktree: w.wt, sourceBase: f.base, sourceHead: w.head, commits: w.commits, acceptance: null });
}

function hooks(o: { integrated?: string[]; redelegated?: string[]; redelegateTo?: string; checksMs?: number; active?: { now: number; max: number } } = {}): MergeHooks {
  return {
    committer: { name: "supervisor:test", email: "supervisor@meritrouter.local" },
    integrated: (item) => o.integrated?.push(item.taskId),
    checks: async () => {
      if (o.active) o.active.max = Math.max(o.active.max, ++o.active.now);
      await sleep(o.checksMs ?? 0);
      if (o.active) o.active.now--;
      return [];
    },
    redelegate: async (item) => {
      o.redelegated?.push(item.taskId);
      return o.redelegateTo ?? null;
    },
  };
}

describe("merge queue", () => {
  it("serialises integrations on one branch; the second, whose first commit the branch already has, is rebased in its worktree and integrated", async () => {
    const f = await fixture(2);
    const [a, b] = f.taskIds;
    const wa = taskWork(f, "a", [line(1, "ONE")]);
    // b repeats a's change, then edits line 5: its first pick becomes empty on the branch.
    const wb = taskWork(f, "b", [line(1, "ONE"), line(5, "FIVE")]);
    const q = new MergeQueue(sy!.db, sy!.tasks, "run-1");
    const ia = enqueue(q, f, a!, wa);
    const ib = enqueue(q, f, b!, wb);
    const order: string[] = [];
    const active = { now: 0, max: 0 };
    // Started together: the second waits for the first (checks hold each integration open).
    const [ra, rb] = await Promise.all([q.run(ia.id, hooks({ integrated: order, active, checksMs: 300 })), q.run(ib.id, hooks({ integrated: order, active, checksMs: 300 }))]);
    expect(active.max).toBe(1);
    expect(order).toEqual([a, b]);
    expect(ra).toMatchObject({ state: "integrated", rebased: false, attempts: 1 });
    expect(rb).toMatchObject({ state: "integrated", rebased: true });
    expect(rb.commits).toHaveLength(1); // the duplicate change was dropped by the rebase
    expect(sy!.tasks.events(b!).find((e) => e.type === "merge_rebased")?.data).toMatchObject({ dropped: 1, commits: 1, conflict: { stage: "pick" } });
    expect(sy!.tasks.events(b!).find((e) => e.type === "merge_queued")?.data).toMatchObject({ ahead: 1 });
    expect(fileText(f)).toBe("ONE\ntwo\nthree\nfour\nFIVE\n");
    // Attribution survives the rebase and the pick: author and trailers are b's.
    const log = gitOut(f.branchWt, "log", "--format=%s%x09%(trailers:key=Agent,valueonly,separator=)", `${f.base}..HEAD`).trim().split("\n");
    expect(log).toEqual(["b edit 1\timplementer:b", "a edit 0\timplementer:a"]);
  }, 60_000);

  it("a real conflict is re-delegated once; integrating the original again conflicts without a second re-delegation", async () => {
    const f = await fixture(2);
    const [a, c] = f.taskIds;
    const q = new MergeQueue(sy!.db, sy!.tasks, "run-1");
    await q.run(enqueue(q, f, a!, taskWork(f, "a", [line(1, "ONE")])).id, hooks());
    const head = gitOut(f.branchWt, "rev-parse", "HEAD").trim();
    const redelegated: string[] = [];
    const wc = taskWork(f, "c", [line(1, "uno")]);
    const r1 = await q.run(enqueue(q, f, c!, wc).id, hooks({ redelegated, redelegateTo: a! }));
    expect(r1).toMatchObject({ state: "redelegated", redelegatedTo: a });
    expect(r1.detail.conflict).toMatchObject({ files: ["f.txt"], stage: "rebase" });
    expect(gitOut(f.branchWt, "rev-parse", "HEAD").trim()).toBe(head); // nothing changed
    expect(gitOut(wc.wt, "rev-parse", "HEAD").trim()).toBe(wc.head); // the failed rebase was undone
    const r2 = await q.run(enqueue(q, f, c!, wc).id, hooks({ redelegated, redelegateTo: a! }));
    expect(r2).toMatchObject({ state: "conflict" });
    expect(redelegated).toEqual([c]);
    expect(sy!.tasks.events(c!).map((e) => e.type)).toEqual(expect.arrayContaining(["merge_redelegated", "merge_conflict"]));
    // The task a re-delegation created is never re-delegated itself.
    expect(q.mayRedelegate(a!)).toBe(false);
    expect(gitOut(f.branchWt, "status", "--porcelain").trim()).toBe("");
  }, 60_000);

  it("a crash mid-integration resumes without a double cherry-pick: present commits are kept, the rest picked once", async () => {
    const f = await fixture(1);
    const [d] = f.taskIds;
    const wd = taskWork(f, "d", [line(1, "ONE"), line(3, "THREE"), line(5, "FIVE")]);
    const q1 = new MergeQueue(sy!.db, sy!.tasks, "run-1");
    const item = enqueue(q1, f, d!, wd);
    process.env[FAULT_ENV] = `after_tool_run:2:${MERGE_PICK_FAULT}`;
    const crashes = simulatedCrashCount();
    const err = await q1.run(item.id, hooks()).catch((e: unknown) => e);
    delete process.env[FAULT_ENV];
    expect(isSimulatedCrash(err)).toBe(true);
    expect(simulatedCrashCount()).toBe(crashes + 1);
    expect(q1.get(item.id)).toMatchObject({ state: "integrating", attempts: 1, owner: "run-1" });
    expect((await pickedSources(f.branchWt, f.base)).size).toBe(2);
    // The dead run also left a cherry-pick in progress (as a process killed mid-pick would).
    const stray = taskWork(f, "stray", [line(1, "other")]).head;
    expect(() => gitOut(f.branchWt, "cherry-pick", stray)).toThrow();

    const integrated: string[] = [];
    const recovered = await new MergeQueue(sy!.db, sy!.tasks, "run-2").recover(f.jobId, hooks({ integrated }));
    expect(recovered).toEqual([expect.objectContaining({ id: item.id, state: "integrated", attempts: 2, owner: "run-2" })]);
    expect(integrated).toEqual([d]);
    expect(sy!.tasks.events(d!).find((e) => e.type === "merge_recovered")?.data).toMatchObject({ outcome: "retried", present: 2, missing: 1, aborted: ["cherry-pick"] });
    const bodies = gitOut(f.branchWt, "log", "--format=%B", `${f.base}..HEAD`);
    for (const c of wd.commits) expect(count(bodies, `(cherry picked from commit ${c})`)).toBe(1);
    expect(fileText(f)).toBe("ONE\ntwo\nTHREE\nfour\nFIVE\n");
  }, 60_000);

  it("a crash after the last pick completes from the branch alone; a second crash mid-integration fails the item and restores the branch", async () => {
    const f = await fixture(2);
    const [d, e] = f.taskIds;
    const wd = taskWork(f, "d", [line(1, "ONE"), line(3, "THREE")]);
    const q1 = new MergeQueue(sy!.db, sy!.tasks, "run-1");
    const item = enqueue(q1, f, d!, wd);
    process.env[FAULT_ENV] = `after_tool_run:2:${MERGE_PICK_FAULT}`;
    expect(isSimulatedCrash(await q1.run(item.id, hooks()).catch((x: unknown) => x))).toBe(true);
    delete process.env[FAULT_ENV];
    const head = gitOut(f.branchWt, "rev-parse", "HEAD").trim();
    const [done] = await new MergeQueue(sy!.db, sy!.tasks, "run-2").recover(f.jobId, hooks());
    expect(done).toMatchObject({ state: "integrated", attempts: 1, afterHead: head });
    expect(gitOut(f.branchWt, "rev-parse", "HEAD").trim()).toBe(head); // nothing picked again
    expect(sy!.tasks.events(d!).find((x) => x.type === "merge_recovered")?.data).toMatchObject({ outcome: "completed", from: "integrating" });

    // e (three commits) crashes after its first pick, and its retry after the second: the retry is
    // spent with a commit still missing, so the item fails and its picks are undone.
    // Line 5 only: its edits never touch lines next to d's (an adjacent edit is a merge conflict).
    const we = taskWork(f, "e", [line(5, "FIVE"), line(5, "V"), line(5, "VV")]);
    const ie = enqueue(q1, f, e!, we);
    process.env[FAULT_ENV] = `after_tool_run:1:${MERGE_PICK_FAULT}`;
    expect(isSimulatedCrash(await new MergeQueue(sy!.db, sy!.tasks, "run-3").run(ie.id, hooks()).catch((x: unknown) => x))).toBe(true);
    resetFaults();
    expect(isSimulatedCrash(await new MergeQueue(sy!.db, sy!.tasks, "run-4").recover(f.jobId, hooks()).catch((x: unknown) => x))).toBe(true);
    delete process.env[FAULT_ENV];
    const [failed] = await new MergeQueue(sy!.db, sy!.tasks, "run-5").recover(f.jobId, hooks());
    expect(failed).toMatchObject({ id: ie.id, state: "failed", attempts: 2 });
    expect(gitOut(f.branchWt, "rev-parse", "HEAD").trim()).toBe(head);
  }, 60_000);

  it("budget carving: a share of what the parent has left, refused below the minimum", () => {
    expect(childRequestBudget({ parentCap: 30, parentUsed: 1, carved: 0, share: 0.5, min: 3 })).toEqual({ requests: 14, remaining: 29 });
    expect(childRequestBudget({ parentCap: 30, parentUsed: 1, carved: 14, share: 0.5, min: 3 })).toEqual({ requests: 7, remaining: 15 });
    expect(childRequestBudget({ parentCap: 10, parentUsed: 4, carved: 1, share: 0.5, min: 3 })).toBeNull();
  });
});

describe("merge queue under supervisor resume", () => {
  it("a supervisor that dies mid-integration resumes: the queue finishes the integration and integrate_task picks nothing twice", async () => {
    env = makeEnv({ config: teamConfig() });
    const script = [
      () => [call("delegate", { tasks: [{ label: "w", profile: "implement", goal: "Add subtract and multiply", acceptance_criteria: ["subtract exists"], allowed_paths: ["src/**"], checks: [check], difficulty: "T2" }] })],
      () => [call("await_tasks", { timeout_seconds: 120 })],
      () => [call("integrate_task", { task_id: "w" })], // dies after the first of two picks
      () => [call("ask_user", { question: "Hold here until the restart" })],
      () => [call("integrate_task", { task_id: "w" })],
      () => [call("finish_job", { status: "completed", summary: "integrated", verified: [{ claim: "subtract on the branch", evidence: "check" }], not_verified: [] })],
    ];
    const notices: string[] = [];
    const client = new ScriptedClient(async (req) => {
      if (!isSupervisor(req)) return worker(req, true);
      const last = req.messages.at(-1)!;
      if (typeof last.content === "string" && last.content.includes("Merge queue after the interruption")) notices.push(last.content);
      const calls = script[turns(req)]!();
      // await_tasks may return for pending operator approval. The fixture operator
      // must finish the worker's real check before this fixed script integrates it.
      if (calls.some(tool => tool.function.name === "integrate_task")) {
        const jobId = /Job id: (\S+)/.exec(String(req.messages[0]!.content))![1]!;
        const child = sy!.tasks.childrenOf(jobId).find(task => task.spec.label === "w")!;
        const finished = await sy!.awaitResults([child.row.id], { timeoutSeconds: 120 });
        expect(finished.timedOut, JSON.stringify({ pending: finished.pending, events: sy!.tasks.events(child.row.id, 100) })).toBe(false);
      }
      return reply(null, { ...servedFor(sy!, req), toolCalls: calls });
    });
    sy = open(env, client, { worker: true });
    process.env[FAULT_ENV] = `after_tool_run:1:${MERGE_PICK_FAULT}`;
    const crashes = simulatedCrashCount();
    const job = await sy.startJob({ goal: "Integrate through a crash", repositories: ["core"], label: "crashy" });
    for (let i = 0; i < 1500 && simulatedCrashCount() === crashes; i++) await sleep(20);
    expect(simulatedCrashCount(), JSON.stringify({
      tasks: sy.listTasks(undefined, 50).map(task => ({ task, result: sy!.tasks.get(task.taskId)?.result, events: sy!.tasks.events(task.taskId, 100) })),
      requests: client.requests.slice(-8).map(req => ({ supervisor: isSupervisor(req), tools: req.messages.filter(message => message.role === "tool").slice(-5) })),
      actions: sy.db.prepare("SELECT task_id,value_json FROM worker_action_requests").all(),
    }, null, 2)).toBe(crashes + 1);
    delete process.env[FAULT_ENV];
    for (let i = 0; i < 300 && !sy.questions().length; i++) await sleep(20);
    const [w] = sy.tasks.childrenOf(job.taskId);
    const q = new MergeQueue(sy.db, sy.tasks, "reader");
    expect(q.forJob(job.taskId)).toEqual([expect.objectContaining({ taskId: w!.row.id, state: "integrating", attempts: 1 })]);
    expect(q.forJob(job.taskId)[0]!.commits).toHaveLength(2);
    await sy.close();

    sy = open(env, client, { worker: true });
    const r = (await sy.awaitResults([job.taskId], { timeoutSeconds: 120 })).completed[0]!;
    expect(r.stopReason).toBe("supervisor_completed");
    const item = new MergeQueue(sy.db, sy.tasks, "reader").forJob(job.taskId)[0]!;
    expect(item).toMatchObject({ state: "integrated", attempts: 2 });
    expect(sy.tasks.events(w!.row.id, 200).find((e) => e.type === "merge_recovered")?.data).toMatchObject({ outcome: "retried", present: 1, missing: 1 });
    expect(notices.join("\n")).toMatch(new RegExp(`- ${w!.row.id} onto meritrouter/job-${job.taskId}: integrated \\(2 commit\\(s\\)`));
    const sup = client.requests.filter(isSupervisor).at(-1)!;
    expect(toolOutputs(sup).at(-1)).toMatch(/already integrated onto .*nothing was picked again/);
    // Each worker commit is on the job branch exactly once.
    const worktree = sy.sessions.forTask(job.taskId).at(-1)!.workspace!.repos[0]!.worktree;
    const bodies = gitOut(worktree, "log", "--format=%B", `${item.beforeHead}..HEAD`);
    for (const c of item.commits) expect(count(bodies, `(cherry picked from commit ${c})`)).toBe(1);
    const app = readFileSync(path.join(worktree, "src/app.ts"), "utf8");
    expect(count(app, "export function subtract")).toBe(1);
    expect(count(app, "export function multiply")).toBe(1);
  }, 240_000);
});
