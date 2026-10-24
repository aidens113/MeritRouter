import { afterEach, expect, it } from "vitest";
import type { MeritRouter } from "../src/core/service.js";
import { MemoryPreferences } from "../src/brain/preferences.js";
import { goodOutput, makeEnv, open, reply, ScriptedClient, type Env } from "./helpers.js";
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
