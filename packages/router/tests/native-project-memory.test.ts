import { afterEach, expect, it } from "vitest";
import { Brain } from "../src/brain/brain.js";
import { BrainAccess, type Principal } from "../src/brain/access.js";
import { parseMemoryRecord } from "../src/brain/memory-record.js";
import { projectMemoryTool } from "../src/harness/memory-tools.js";
import type { HarnessEnv } from "../src/harness/tools.js";
import { openDatabase } from "../src/storage/db.js";
import type { MeritRouter } from "../src/core/service.js";
import { baseConfig, makeEnv, open, reply, ScriptedClient, servedFor, type Env } from "./helpers.js";

let env: Env | undefined, db: ReturnType<typeof openDatabase> | undefined, sy: MeritRouter | undefined;
afterEach(async () => { await sy?.close(); sy = undefined; db?.close(); db = undefined; env?.cleanup(); env = undefined; });
const args = { id: "setup", kind: "project_fact", body: "Use the declared setup recipe before dispatching workers.", sourceRef: "artifact:observed-setup", expectedDigest: null };
function setup() {
  env = makeEnv(); db = openDatabase(env.cfg.storageDir);
  const brain = new Brain(env.cfg, db), access = new BrainAccess(db, env.cfg);
  const principal = access.principalFor("supervisor", { project: "demo", effort: "job", task: "job", repos: ["core"], jobId: "job", tier: "T3" });
  const harness = (p = principal, role = "supervisor") => ({ role, brain: { brain, access, principal: () => p, actor: { agent: "supervisor:job", role: "supervisor", task: "job" }, workingDoc: "projects/demo/working/job.md" }, ctx: { now: Date.now, signal: new AbortController().signal } }) as unknown as HarnessEnv;
  return { brain, access, harness };
}
it("writes versioned memory using the native supervisor's actual scoped principal and CAS", async () => {
  const { brain, harness } = setup(), tool = projectMemoryTool();
  expect(tool.available?.(harness())).toBe(true);
  const first = JSON.parse(await tool.run(args, harness()));
  expect(first).toMatchObject({ path: "projects/demo/memory/setup.md", scope: { kind: "project", project: "demo" } });
  const record = parseMemoryRecord(brain.read({ kind: "human" }, first.path).content);
  expect(record).toMatchObject({ author: { id: "supervisor:job", role: "supervisor" }, revision: 1, body: args.body });
  await expect(tool.run(args, harness())).rejects.toThrow(/changed since/);
  const updated = JSON.parse(await tool.run({ ...args, expectedDigest: first.digest, body: "Setup verified for this project." }, harness()));
  expect(parseMemoryRecord(brain.read({ kind: "human" }, updated.path).content)?.revision).toBe(2);
});
it("refuses workers, borrowed worker principals, foreign grants and raw preference/global fields", async () => {
  const { brain, harness } = setup(), tool = projectMemoryTool();
  const foreign: Principal = { kind: "agent", role: "supervisor", taskId: "job", jobId: "job", tier: "T3", grants: [{ pattern: "projects/foreign/**", mode: "write" }] };
  expect(tool.available?.(harness(foreign, "implementer"))).toBe(false);
  await expect(tool.run(args, harness(foreign, "implementer"))).rejects.toThrow(/authenticated supervisor/);
  await expect(tool.run(args, harness({ ...foreign, role: "implementer" }))).rejects.toThrow(/Workers propose/);
  await expect(tool.run(args, harness(foreign))).rejects.toThrow(/lacks scoped/);
  await expect(tool.run({ ...args, project: "foreign" }, harness())).rejects.toThrow();
  await expect(tool.run({ ...args, kind: "user_preference" }, harness())).rejects.toThrow();
  expect(brain.exists("projects/demo/memory/setup.md")).toBe(false);
  expect(brain.exists("global/preferences/setup.md")).toBe(false);
});

it("advertises and executes typed project memory in an actual dispatched supervisor loop", async () => {
  const config = baseConfig();
  (config.profiles as Record<string, unknown>).supervise = { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100, max_model_requests: 12, classify: "never" };
  env = makeEnv({ config });
  const client = new ScriptedClient(req => {
    const served = servedFor(sy!, req);
    expect(req.tools?.some(tool => tool.function.name === "write_project_memory")).toBe(true);
    const wrote = req.messages.some(message => message.role === "tool" && message.tool_call_id === "memory");
    return reply(null, { ...served, toolCalls: [wrote ? { id: "finish", type: "function", function: { name: "finish_job", arguments: JSON.stringify({ status: "completed", summary: "Recorded project setup memory", verified: [{ claim: "Memory write succeeded", evidence: "write_project_memory result" }], not_verified: [], follow_up: "None" }) } } : { id: "memory", type: "function", function: { name: "write_project_memory", arguments: JSON.stringify(args) } }] });
  });
  sy = open(env, client, { worker: true });
  const [task] = await sy.submitTasks([{ profile: "supervise", goal: "Record verified setup knowledge in project memory", repositoryAliases: ["core"], supervisionScope: "subtask", constraints: { acceptanceCriteria: ["Memory is persisted"] } }]);
  const done = await sy.awaitResults([task!.taskId], { timeoutSeconds: 30 });
  expect(done.pending).toHaveLength(0);
  expect(done.completed[0]?.executionStatus).toBe("completed");
  const memory = parseMemoryRecord(sy.brain.read({ kind: "human" }, "projects/demo/memory/setup.md").content);
  expect(memory?.body).toBe(args.body);
  expect(memory?.author.role).toBe("supervisor");
  expect(memory?.author.taskId).toBe(task!.taskId);
}, 60_000);
