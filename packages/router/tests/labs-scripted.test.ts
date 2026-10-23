import { afterEach, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { Switchyard } from "../src/core/service.js";
import { LabManager } from "../src/labs/lab.js";
import { baseConfig, goodOutput, makeEnv, openWithTestSupervisor, reply, ScriptedClient, servedFor, type Env } from "./helpers.js";
let env: Env | undefined;
let sy: Switchyard | undefined;
let owner: LabManager | undefined;
afterEach(async () => {
  await owner?.close();
  owner = undefined;
  await sy?.close();
  sy = undefined;
  env?.cleanup();
  env = undefined;
});
const call = (name: string, args: unknown) => ({ id: name, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
it("runs a scripted bound team, scoped tools, integration restart and revision check on the lab branch", async () => {
  const node = JSON.stringify(process.execPath);
  const config = baseConfig({ security: { outside_repository: "supervisor" }, coding: { runner: "native" }, repositories: {}, brain: { path: "brain", project: "alpha" }, labs: { port_range: [56000, 56500] }, projects: { alpha: { repositories: { app: { path: "repo" } }, lab: { ports: ["web"], env: { PORT: "{port.web}" }, services: { web: { repo: "app", command: `${node} server.cjs`, ready: { http: "http://127.0.0.1:{port.web}/" } } }, checks: { verify: { repo: "app", command: `${node} check.cjs`, on_integrate: true } } } } } });
  (config.profiles as Record<string, unknown>).supervise = { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100, max_model_requests: 30, max_output_tokens: 4000, classify: "never", min_tier: "T3" };
  env = makeEnv({ config, files: { "src/app.ts": "export function add(a: number, b: number) { return a + b; }\n", "server.cjs": "require('node:http').createServer((_q,r)=>r.end('fixture')).listen(Number(process.env.PORT),'127.0.0.1');", "check.cjs": "process.exit(require('fs').readFileSync('src/app.ts','utf8').includes('subtract')?0:1)" } });
  const script = [
    () => [call("lab_status", {})],
    () => [call("delegate", { tasks: [{ label: "subtract", profile: "implement", goal: "Add subtract to src/app.ts", acceptance_criteria: ["subtract exists"], allowed_paths: ["src/**"], checks: [`${node} check.cjs`], difficulty: "T2" }] })],
    () => [call("await_tasks", { timeout_seconds: 60 })],
    () => [call("integrate_task", { task_id: "subtract" })],
    () => [call("lab_check", { name: "verify" })],
    () => [call("finish_job", { status: "completed", summary: "Integrated subtract into the lab", verified: [{ claim: "subtract verified", evidence: "lab_check verify exit 0" }], not_verified: [] })],
  ];
  const client = new ScriptedClient(req => {
    const turns = req.messages.filter(m => m.role === "assistant").length;
    if (String(req.messages[0]!.content).startsWith("# Supervisor charter"))
      return reply(null, { ...servedFor(sy!, req), toolCalls: script[turns]!() });
    if (turns === 0)
      return reply(null, { ...servedFor(sy!, req), toolCalls: [call("replace_in_file", { path: "src/app.ts", old_text: "export function add", new_text: "export function subtract(a: number, b: number) { return a - b; }\n\nexport function add" })] });
    return reply(null, { ...servedFor(sy!, req), toolCalls: [call("submit_result", goodOutput(1, "app:src/app.ts#L1-L1"))] });
  });
  sy = openWithTestSupervisor(env, client, { worker: true });
  owner = new LabManager({ ...sy.labs.options, monitor: true });
  const created = await owner.create("alpha", "scripted");
  await owner.start("alpha", "scripted");
  const initialPid = owner.status("alpha", "scripted").services[0]!.pid;
  const job = await sy.startJob({ project: "alpha", lab: "scripted", goal: "Add subtract", repositories: ["app"], label: "lab-team" });
  const outcome = await sy.awaitResults([job.taskId], { timeoutSeconds: 60 });
  expect(outcome.pending, JSON.stringify(outcome.pending)).toHaveLength(0);
  const result = outcome.completed[0]!;
  expect(result.stopReason).toBe("supervisor_completed");
  const diagnostic = client.requests.filter(req => String(req.messages[0]!.content).startsWith("# Supervisor charter")).at(-1)!.messages.filter(m => m.role === "tool").map(m => String(m.content));
  expect(diagnostic.filter(text => text.startsWith("error:"))).toEqual([]);
  const status = owner.status("alpha", "scripted");
  expect(status.heads.app).not.toBe(created.heads.app);
  expect(status.services[0]!.pid).not.toBe(initialPid);
  expect(status.checks.filter(c => c.exitCode === 0 && c.revision === status.heads.app).length).toBeGreaterThanOrEqual(2);
  const child = sy.tasks.childrenOf(job.taskId)[0]!;
  expect(child.spec.lab).toBe("scripted");
  const session = sy.sessions.forTask(job.taskId).at(-1)!;
  expect(session.workspace!.repos[0]!.branch).toBe(created.lab.repositories[0]!.branch);
  expect(readFileSync(path.join(env.repo, "src/app.ts"), "utf8")).not.toContain("subtract");
  expect(execFileSync("git", ["show", `${status.heads.app}:src/app.ts`], { cwd: env.repo, encoding: "utf8" })).toContain("subtract");
  expect(readFileSync(path.join(env.dir, "brain/projects/alpha/labs/scripted.md"), "utf8")).toContain("Job completed");
  const outputs = client.requests.filter(req => String(req.messages[0]!.content).startsWith("# Supervisor charter")).at(-1)!.messages.filter(m => m.role === "tool").map(m => String(m.content));
  expect(outputs.filter(text => text.startsWith("error:"))).toEqual([]);
}, 180000);
