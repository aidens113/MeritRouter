import { afterEach, describe, expect, it } from "vitest";
import type { MeritRouter } from "../src/core/service.js";
import { createCodingRunner } from "../src/runners/coding/index.js";
import type { ChatRequest } from "../src/gateway/types.js";
import { baseConfig, goodOutput, makeEnv, openWithTestSupervisor as open, reply, ScriptedClient, servedFor, type Env } from "./helpers.js";

let env: Env | undefined;
let sy: MeritRouter | undefined;
afterEach(async () => {
  await sy?.close();
  sy = undefined;
  env?.cleanup();
});

const task = (difficulty: "T1" | "T2" | "T3", o: Record<string, unknown> = {}) => ({
  profile: "implement",
  label: "add-subtract",
  goal: "Add subtract() to src/app.ts",
  repositoryAliases: ["core"],
  writableRepository: "core",
  hints: { difficulty },
  constraints: { acceptanceCriteria: ["subtract exists"], allowedPaths: ["src/**"] },
  ...o,
});
const call = (name: string, args: unknown, id = "c1") => [{ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }];
const submit = () => call("submit_result", goodOutput(1, "core:src/app.ts#L1-L3"), "s1");

describe("native coding worker: tier-gated tool surface and prompt (supervisor-offload lane C)", () => {
  it("gives a capable tier the full harness-v2 tool surface and its dense startup guidance", async () => {
    env = makeEnv({ config: baseConfig({ coding: { runner: "native" } }) });
    let firstReq: ChatRequest | undefined;
    const client = new ScriptedClient((req) => {
      firstReq ??= req;
      return reply(null, { ...servedFor(sy!, req), toolCalls: submit() });
    });
    sy = open(env, client, { worker: true, coding: createCodingRunner(env.cfg) });
    const [sub] = await sy.submitTasks([task("T3")]);
    await sy.awaitResults([sub!.taskId], { timeoutSeconds: 60 });
    const system = String(firstReq!.messages.find((m) => m.role === "system")!.content);
    expect(system).toContain("Harness v2:");
    expect(firstReq!.tools?.some((t) => t.function.name === "batch")).toBe(true);
    expect(firstReq!.tools?.some((t) => t.function.name === "apply_edits")).toBe(true);
    // The supervisor-channel tools (ask_supervisor etc.) are gated on ctx.channel, which the
    // executor wires onto every run (core/channel-service.ts RunChannel): they are always-on.
    expect(firstReq!.tools?.some((t) => t.function.name === "ask_supervisor")).toBe(true);
  }, 90_000);

  it("gives a T1 (free/small) tier the legacy edit tools and a lite numbered prompt, never the dense harness-v2 guidance", async () => {
    env = makeEnv({ config: baseConfig({ coding: { runner: "native" } }) });
    let firstReq: ChatRequest | undefined;
    const client = new ScriptedClient((req) => {
      firstReq ??= req;
      return reply(null, { ...servedFor(sy!, req), toolCalls: submit() });
    });
    sy = open(env, client, { worker: true, coding: createCodingRunner(env.cfg) });
    const [sub] = await sy.submitTasks([task("T1")]);
    const result = (await sy.awaitResults([sub!.taskId], { timeoutSeconds: 60 })).completed[0]!;
    expect(result.executionStatus).toBe("completed");
    const system = String(firstReq!.messages.find((m) => m.role === "system")!.content);
    expect(system).not.toContain("Harness v2:");
    expect(system).toContain("How to use your tools");
    expect(system).toContain("write_file");
    expect(firstReq!.tools?.some((t) => t.function.name === "batch")).toBe(false);
    expect(firstReq!.tools?.some((t) => t.function.name === "apply_edits")).toBe(false);
    expect(firstReq!.tools?.some((t) => t.function.name === "write_file")).toBe(true);
  }, 90_000);
});
