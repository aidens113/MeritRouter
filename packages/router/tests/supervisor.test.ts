import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { Switchyard } from "../src/core/service.js";
import type { ChatRequest } from "../src/gateway/types.js";
import { blame } from "../src/attribution/index.js";
import { baseConfig, goodOutput, makeEnv, open, reply, ScriptedClient, servedFor, type Env } from "./helpers.js";

let env: Env | undefined;
let sy: Switchyard | undefined;
afterEach(async () => {
  await sy?.close();
  sy = undefined;
  env?.cleanup();
});

const check = `node -e "process.exit(require('fs').readFileSync('src/app.ts','utf8').includes('subtract')?0:1)"`;
const call = (name: string, args: unknown, id = name) => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
const turns = (req: ChatRequest) => req.messages.filter((m) => m.role === "assistant").length;
const isSupervisor = (req: ChatRequest) => String(req.messages[0]!.content).startsWith("# Supervisor charter");

function standaloneConfig() {
  const cfg = baseConfig({ coding: { runner: "native" }, supervisor: { max_workers_per_job: 2 } });
  (cfg.profiles as Record<string, unknown>).supervise = { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100, max_model_requests: 30, max_output_tokens: 4000, classify: "never", min_tier: "T3" };
  return cfg;
}

/** Worker script: edit src/app.ts, then submit. */
function worker(req: ChatRequest) {
  const s = servedFor(sy!, req);
  if (turns(req) === 0) {
    return reply(null, { ...s, toolCalls: [call("replace_in_file", { path: "src/app.ts", old_text: "export function add", new_text: "export function subtract(a: number, b: number) {\n  return a - b;\n}\n\nexport function add" })] });
  }
  return reply(null, { ...s, toolCalls: [call("submit_result", goodOutput(1, "core:src/app.ts#L1-L3"))] });
}

describe("standalone supervisor", () => {
  it("plans, delegates, integrates worker commits onto a job branch, verifies, and records memory", async () => {
    env = makeEnv({ config: standaloneConfig() });
    const script = [
      () => [call("brain_set_current_state", { body: "**Plan:** delegate subtract() to an implementer, integrate, run the check." }), call("delegate", { tasks: [{ label: "subtract", profile: "implement", goal: "Add subtract(a, b) to src/app.ts", acceptance_criteria: ["subtract exists"], allowed_paths: ["src/**"], checks: [check], difficulty: "T2" }] })],
      () => [call("await_tasks", { timeout_seconds: 60 })],
      () => [call("integrate_task", { task_id: "subtract" })],
      () => [call("run_check", { command: check })],
      () => [call("brain_append_ledger", { title: "Integrated subtract", changed: "src/app.ts", why: "goal", validation: `\`${check}\` -> exit 0`, outcome: "Accepted", follow_up: "none" })],
      () => [call("finish_job", { status: "completed", summary: "subtract() added and integrated", verified: [{ claim: "subtract exists on the job branch", evidence: "run_check exit 0" }], not_verified: [] })],
    ];
    const client = new ScriptedClient((req) => {
      if (!isSupervisor(req)) return worker(req);
      return reply(null, { ...servedFor(sy!, req), toolCalls: script[turns(req)]!() });
    });
    sy = open(env, client, { worker: true });
    const job = await sy.startJob({ goal: "Add subtract() to the app", repositories: ["core"], checks: [check], label: "subtract-job" });
    const r = (await sy.awaitResults([job.taskId], { timeoutSeconds: 120 })).completed[0]!;
    expect(r.stopReason).toBe("supervisor_completed");
    expect(r.acceptanceStatus).toBe("met");
    expect(r.checks[0]!.exitCode).toBe(0);
    expect(r.summary).toMatch(/git merge --no-ff switchyard\/job-/);

    // Every tool result the supervisor saw was a success (no "error:" outputs).
    const sup = client.requests.filter(isSupervisor).at(-1)!;
    const toolOutputs = sup.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
    expect(toolOutputs.filter((o) => o.startsWith("error:"))).toEqual([]);

    // The job branch exists in the source repository and the subtract lines are attributed to the worker.
    const branch = `switchyard/job-${job.taskId}`;
    const wt = (sy.db.prepare("SELECT detail_json FROM job_state WHERE task_id = ?").get(job.taskId) as { detail_json: string }).detail_json;
    const integration = JSON.parse(wt).repos[0].worktree as string;
    expect(execFileSync("git", ["branch", "--list", branch], { cwd: env.repo }).toString()).toContain(branch);
    const lines = await blame(integration, "src/app.ts");
    const sub = lines.find((l) => l.text.includes("return a - b"))!;
    expect(sub.agent).toBe("implementer:subtract");
    expect(sub.model).toBe("openrouter/vendor/big-a:free");
    // The user's own checkout is untouched.
    expect(readFileSync(path.join(env.repo, "src/app.ts"), "utf8")).not.toContain("subtract");

    // Memory: brief, ledger entries, Current State, and the worker's report.
    await sy.close();
    sy = undefined;
    const doc = readFileSync(path.join(env.dir, `brain/projects/demo/working/job-${job.taskId}.md`), "utf8");
    expect(doc).toContain("### Brief: subtract");
    expect(doc).toContain("**Plan:** delegate subtract()");
    expect(doc).toContain("### ");
    expect(doc).toMatch(/Integrated subtract/);
    expect(doc).toMatch(/Job completed/);
    expect(readFileSync(path.join(env.dir, `brain/projects/demo/working/job-${job.taskId}/reports/subtract.md`), "utf8")).toMatch(/^# Report: subtract/);
    const brainLog = execFileSync("git", ["log", "--format=%(trailers:key=Agent,valueonly)%x09%(trailers:key=Model,valueonly)%x09%s", "-8"], { cwd: path.join(env.dir, "brain") }).toString();
    expect(brainLog).toMatch(/supervisor:subtract-job\s*\topenrouter\/vendor\/big-a:free\s*\tUpdate Current State/);
  }, 180_000);

  it("refuses overlapping concurrent coding briefs and asks the user when needed", async () => {
    env = makeEnv({ config: standaloneConfig() });
    const overlap = [
      { label: "a", profile: "implement", goal: "edit app", acceptance_criteria: ["x"], allowed_paths: ["src/**"], difficulty: "T2" },
      { label: "b", profile: "implement", goal: "edit app too", acceptance_criteria: ["x"], allowed_paths: ["src/app.ts"], difficulty: "T2" },
    ];
    const script = [
      () => [call("delegate", { tasks: overlap })],
      () => [call("ask_user", { question: "Should subtract round?", options: ["yes", "no"] })],
      () => [call("finish_job", { status: "blocked", summary: "waiting on design", verified: [], not_verified: ["everything"] })],
    ];
    const client = new ScriptedClient((req) => (isSupervisor(req) ? reply(null, { ...servedFor(sy!, req), toolCalls: script[turns(req)]!() }) : worker(req)));
    sy = open(env, client, { worker: true });
    const job = await sy.startJob({ goal: "Two overlapping edits", repositories: ["core"] });
    let q: ReturnType<Switchyard["questions"]> = [];
    for (let i = 0; i < 100 && !q.length; i++) {
      await new Promise((res) => setTimeout(res, 100));
      q = sy.questions();
    }
    expect(q[0]).toMatchObject({ question: "Should subtract round?", options: ["yes", "no"] });
    sy.answerQuestion(q[0]!.id, "no");
    const r = (await sy.awaitResults([job.taskId], { timeoutSeconds: 60 })).completed[0]!;
    expect(r.stopReason).toBe("supervisor_blocked");
    const sup = client.requests.filter(isSupervisor).at(-1)!;
    const outputs = sup.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
    expect(outputs[0]).toMatch(/overlaps a in core/);
    expect(outputs[1]).toBe("answer from user: no");
  }, 120_000);
});
