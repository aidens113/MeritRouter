import { afterEach, expect, it } from "vitest";
import type { MeritRouter } from "../src/core/service.js";
import { MemoryPreferences } from "../src/brain/preferences.js";
import { baseConfig, goodOutput, makeEnv, open, reply, ScriptedClient, type Env } from "./helpers.js";

let env: Env | undefined, sy: MeritRouter | undefined;
afterEach(async () => { await sy?.close(); sy = undefined; env?.cleanup(); env = undefined; });

it("routes install preferences into a distinct project Brain, supports scoped reads, and removes revoked prose", async () => {
  env = makeEnv({ config: { ...baseConfig(), repositories: {}, projects: { demo: { repositories: { core: { path: "repo" } } }, other: { repositories: { core: { path: "repo" } } } } } });
  let turn = 0;
  const client = new ScriptedClient(() => {
    const names = ["brain_read", "brain_list", "brain_search"];
    if (turn < 3) {
      const name = names[turn++]!;
      return reply(null, { toolCalls: [{ id: name, type: "function", function: { name, arguments: JSON.stringify(name === "brain_read" ? { path: "global/preferences/keyboard.md" } : { prefix: "global/preferences", query: "keyboard" }) } }] });
    }
    return reply(null, { toolCalls: [{ id: `done-${turn++}`, type: "function", function: { name: "submit_result", arguments: JSON.stringify(goodOutput(1, "inline")) } }] });
  });
  sy = open(env, client, { worker: true });
  // Trusted runtime binding; authored project schema deliberately disallows path.
  const context = sy.projectContext("other");
  context.brain = { ...context.brain, path: `${env.dir}/other-brain` };
  expect(sy.brainFor("other")).not.toBe(sy.brain);
  const body = "Preserve keyboard navigation throughout all products.";
  let operation: "write" | "revoke" = "write";
  const store = new MemoryPreferences(sy.brain, () => ({ actor: { agent: "initiator:test", role: "final_supervisor" }, originalInstruction: body, sourceRef: "literal-user-message", scope: "global", project: sy!.brain.project, expiresAt: Date.now() + 60_000, operation, id: "keyboard" }));
  const saved = await store.writePreference("trusted", { id: "keyboard", body }, null);
  await new MemoryPreferences(sy.brain, () => null).writeProject({ kind: "human" }, { agent: "human", role: "human" }, { id: "private", kind: "project_fact", body: "Private install project keyboard topology", source: { kind: "observation", ref: "artifact:test" } }, null);
  const task = { profile: "inspect", goal: "Inspect keyboard navigation", context: { inlineText: "fixture" }, repositoryAliases: ["core"], hints: { difficulty: "T1" }, constraints: { acceptanceCriteria: ["report"] } };
  const [first] = await sy.submitTasks([task], { project: "other" });
  expect((await sy.awaitResults([first!.taskId], { timeoutSeconds: 30 })).pending).toHaveLength(0);
  expect(client.requests).toHaveLength(4);
  expect(JSON.stringify(client.requests[0]!.messages)).toContain(body);
  const last = JSON.stringify(client.requests[3]!.messages);
  expect(last).toContain("brain:global/preferences/keyboard.md");
  expect(last).toContain(body);
  expect(last).not.toContain("Private install project");
  expect(sy.brainFor("other").exists("global/preferences/keyboard.md")).toBe(false);
  operation = "revoke";
  await store.revokePreference("trusted", "keyboard", saved.digest);
  const [second] = await sy.submitTasks([task], { project: "other" });
  expect((await sy.awaitResults([second!.taskId], { timeoutSeconds: 30 })).pending).toHaveLength(0);
  expect(JSON.stringify(client.requests.at(-1)!.messages)).not.toContain(body);
}, 60_000);

