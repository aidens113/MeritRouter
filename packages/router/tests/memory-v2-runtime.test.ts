import { afterEach, expect, it } from "vitest";
import type { MeritRouter } from "../src/core/service.js";
import { MemoryPreferences } from "../src/brain/preferences.js";
import { baseConfig, goodOutput, makeEnv, open, reply, ScriptedClient, type Env } from "./helpers.js";
let env: Env | undefined, sy: MeritRouter | undefined;
afterEach(async () => { await sy?.close(); sy = undefined; env?.cleanup(); env = undefined; });

it("automatically injects authorized memory into an actual read-only worker request and persists its manifest", async () => {
  env = makeEnv();
  const client = new ScriptedClient(() => reply(null, { toolCalls: [{ id: "done", type: "function", function: { name: "submit_result", arguments: JSON.stringify(goodOutput(1, "inline")) } }] }));
  sy = open(env, client, { worker: true });
  const body = "Keep accessible keyboard navigation in every project.";
  const store = new MemoryPreferences(sy.brain, ref => ref === "trusted" ? { actor: { agent: "initiator:test", role: "final_supervisor" }, originalInstruction: body, sourceRef: "literal-user-message", scope: "global", project: "demo", expiresAt: Date.now() + 60_000, operation: "write", id: "keyboard" } : null);
  await store.writePreference("trusted", { id: "keyboard", body }, null);
  const [task] = await sy.submitTasks([{ profile: "inspect", goal: "Inspect context", context: { inlineText: "runtime memory validation" }, repositoryAliases: ["core"], hints: { difficulty: "T1" }, constraints: { acceptanceCriteria: ["report"] } }]);
  const result = await sy.awaitResults([task!.taskId], { timeoutSeconds: 30 });
  expect(result.pending).toHaveLength(0);
  expect(JSON.stringify(client.requests[0]!.messages)).toContain(body);
  expect(JSON.stringify(client.requests[0]!.messages)).toContain("memory-context:start");
  const manifest = sy.db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE task_id=? AND kind='memory_manifest'").get(task!.taskId) as { n: number };
  expect(manifest.n).toBeGreaterThan(0);
}, 60_000);

it("automatically injects authorized role-scoped memory into an actual one-shot summarizer", async () => {
  env = makeEnv(); const client = new ScriptedClient(() => reply(JSON.stringify(goodOutput(1, "inline"))));
  sy = open(env, client, { worker: true });
  const body = "Use concise summaries in all projects.";
  const store = new MemoryPreferences(sy.brain, () => ({ actor: { agent: "initiator:test", role: "final_supervisor" }, originalInstruction: body, sourceRef: "literal-user-message", scope: "global", project: "demo", expiresAt: Date.now() + 60_000, operation: "write", id: "summaries" }));
  await store.writePreference("trusted", { id: "summaries", body }, null);
  const [task] = await sy.submitTasks([{ profile: "summarize", goal: "Summarize fixture", context: { inlineText: "fixture" }, repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["summary"] } }]);
  expect((await sy.awaitResults([task!.taskId], { timeoutSeconds: 30 })).pending).toHaveLength(0);
  expect(JSON.stringify(client.requests[0]!.messages)).toContain(body);
  const record = sy.db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE task_id=? AND kind='memory_manifest'").get(task!.taskId) as { n: number };
  expect(record.n).toBeGreaterThan(0);
}, 60_000);

it("splits batched requests when one item's memory is forbidden to another", async () => {
  env = makeEnv({ config: baseConfig({ roles: { summarizer: { brain_grants: [{ pattern: "global/preferences/**", mode: "read" }] } } }) });
  const client = new ScriptedClient(req => {
    const ids = [...String(req.messages[1]!.content).matchAll(/<item id="(i\d+)">/g)].map(m => m[1]!);
    return reply(JSON.stringify(ids.length ? { items: ids.map(id => ({ id, result: goodOutput(1, "inline") })) } : goodOutput(1, "inline")));
  });
  sy = open(env, client, { worker: true });
  const store = new MemoryPreferences(sy.brain, () => null);
  await store.writeProject({ kind: "human" }, { agent: "human:test", role: "human" }, { id: "private", kind: "project_fact", body: "Redis private cluster topology is confidential.", source: { kind: "observation", ref: "artifact:redis" } }, null);
  const task = (grant: boolean) => ({ profile: "summarize", goal: "Summarize Redis topology", context: { inlineText: "fixture" }, repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["summary"] }, ...(grant ? { brain: { grants: [{ pattern: "projects/demo/memory/private.md", mode: "read" }] } } : {}) });
  const tasks = await sy.submitTasks([task(true), task(false)]);
  expect((await sy.awaitResults(tasks.map(t => t.taskId), { timeoutSeconds: 30 })).pending).toHaveLength(0);
  expect(client.requests).toHaveLength(2);
  expect(client.requests.filter(req => JSON.stringify(req.messages).includes("Redis private cluster topology"))).toHaveLength(1);
}, 60_000);
