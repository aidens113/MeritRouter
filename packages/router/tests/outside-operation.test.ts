import { afterEach, expect, it, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import YAML from "yaml";
import type { MeritRouter } from "../src/core/service.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { capturedLease } from "../src/storage/task-leases.js";
import { mediateOutsideOperation, withOutsideAuthority } from "../src/harness/outside-operation.js";
import { WorkerActionRequests } from "../src/harness/worker-actions.js";
import { webTools } from "../src/harness/web-tools.js";
import type { HarnessEnv } from "../src/harness/tools.js";
import { baseConfig, makeEnv, open, reply, ScriptedClient, type Env } from "./helpers.js";

let fixture: Env | undefined, sy: MeritRouter | undefined;
afterEach(async () => { await sy?.close(); sy = undefined; fixture?.cleanup(); fixture = undefined; });

function setup(policy: "disabled" | "human_only" | "supervisor", supervisor = false) {
  fixture = makeEnv({ config: baseConfig({ security: { outside_repository: policy }, profiles: { ...baseConfig().profiles, supervise: { mode: "supervisor", tools: "supervisor", max_model_requests: 10 } } }) });
  sy = open(fixture, new ScriptedClient(() => reply("unused")), { worker: false });
  sy.tasks.submit([WorkerTaskSchema.parse({ id: "outside-agent", profile: supervisor ? "supervise" : "inspect", goal: "Investigate", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["Cite observed data"] } })], { project: "demo" });
  const task = sy.tasks.claim("outside-owner", { maxConcurrent: 1, maxWritersPerRepo: 1, leaseMs: 30000, defaultTimeoutMs: 60000 })[0]!;
  const fetch = vi.fn();
  const env = { role: "supervisor", ctx: { cfg: sy.cfg, tasks: sy.tasks, taskId: task.row.id, taskLease: capturedLease(task), spec: task.spec, now: Date.now, signal: new AbortController().signal, web: { enabledFor: () => true, fetch } } } as unknown as HarnessEnv;
  return { env, fetch, store: new WorkerActionRequests(sy.db) };
}

it("worker web access files a request even when role text says supervisor and policy allows supervisors", async () => {
  const { env, fetch, store } = setup("supervisor");
  const tool = webTools().find(t => t.def.function.name === "web_fetch")!;
  const output = JSON.parse(await tool.run({ url: "https://example.com/evidence" }, env));
  expect(output).toMatchObject({ status: "pending", operation: "web_fetch" });
  expect(fetch).not.toHaveBeenCalled();
  expect(store.get("demo", output.id)?.action.operation).toEqual({ name: "web_fetch", args: { url: "https://example.com/evidence" } });
});

it("disabled mode refuses network actions for both workers and supervisors before contact", async () => {
  const { env, fetch } = setup("disabled", true);
  await expect(webTools().find(t => t.def.function.name === "web_fetch")!.run({ url: "https://example.com" }, env)).rejects.toThrow(/disabled/);
  expect(fetch).not.toHaveBeenCalled();
});

it("human-only supervisors request operator handling rather than performing actions", async () => {
  const { env } = setup("human_only", true);
  expect(JSON.parse((await mediateOutsideOperation(env, "web_search", { query: "evidence" }))!)).toMatchObject({ status: "pending" });
});

it("only an authoritative supervisor in supervisor mode can execute an outside operation directly", async () => {
  const { env } = setup("supervisor", true);
  expect(await mediateOutsideOperation(env, "web_search", { query: "evidence" })).toBeNull();
});

it("operator responses are labelled as supplied responses and never execute the worker request", async () => {
  const { env, fetch, store } = setup("human_only");
  const args = { url: "https://example.com" };
  const first = JSON.parse((await mediateOutsideOperation(env, "web_fetch", args))!);
  await store.decide({ project: "demo", id: first.id, decision: "approve", reason: "Operator inspected the page separately", actor: { kind: "operator" }, config: env.ctx.cfg, response: "The operator observed a page." });
  const result = JSON.parse((await mediateOutsideOperation(env, "web_fetch", args))!);
  expect(result).toMatchObject({ status: "completed", provenance: "supervisor_response" });
  expect(result.response).toContain("Supervisor-provided response");
  expect(fetch).not.toHaveBeenCalled();
});

it("new journal invocations request fresh observations instead of reusing an old supervisor response", async () => {
  const { env, store } = setup("human_only");
  env.toolInvocationId = "session:first";
  const first = JSON.parse((await mediateOutsideOperation(env, "web_fetch", { url: "https://example.com" }))!);
  await store.decide({ project: "demo", id: first.id, decision: "approve", reason: "Operator observed initial state", actor: { kind: "operator" }, config: env.ctx.cfg, response: "initial state" });
  env.toolInvocationId = "session:second";
  const second = JSON.parse((await mediateOutsideOperation(env, "web_fetch", { url: "https://example.com" }))!);
  expect(second.id).not.toBe(first.id);
  expect(second.status).toBe("pending");
});

it("revoking supervisor outside authority aborts in-flight network work before a later effect", async () => {
  const { env } = setup("supervisor", true);
  let laterEffect = false;
  const timer = setTimeout(() => {
    const config = YAML.parse(readFileSync(env.ctx.cfg.configPath, "utf8"));
    config.security.outside_repository = "disabled";
    writeFileSync(env.ctx.cfg.configPath, YAML.stringify(config));
  }, 20);
  try {
    await expect(withOutsideAuthority(env, async signal => {
      await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      laterEffect = true;
    })).rejects.toThrow(/revoked/);
    expect(laterEffect).toBe(false);
  } finally { clearTimeout(timer); }
});
it("honors a configured custom supervisor from persisted task state, independently of role text", async () => {
  const { env } = setup("supervisor");
  const config = YAML.parse(readFileSync(env.ctx.cfg.configPath, "utf8"));
  config.profiles.inspect.mode = "supervisor"; config.profiles.inspect.tools = "supervisor";
  writeFileSync(env.ctx.cfg.configPath, YAML.stringify(config));
  env.role = "inspector";
  expect(await mediateOutsideOperation(env, "web_search", { query: "configured supervisor" })).toBeNull();
});
it("forging context profile and role text cannot elevate the persisted worker", async () => {
  const { env, fetch } = setup("supervisor");
  env.ctx.spec = WorkerTaskSchema.parse({ ...env.ctx.spec, profile: "supervise" });
  const output = JSON.parse((await mediateOutsideOperation(env, "web_fetch", { url: "https://example.com" }))!);
  expect(output.status).toBe("pending");
  await expect(withOutsideAuthority(env, async () => fetch())).rejects.toThrow(/revoked/);
  expect(fetch).not.toHaveBeenCalled();
});
it("revoking a custom supervisor profile mode aborts in-flight effects despite stale context configuration", async () => {
  const { env } = setup("supervisor");
  const config = YAML.parse(readFileSync(env.ctx.cfg.configPath, "utf8"));
  config.profiles.inspect.mode = "supervisor"; config.profiles.inspect.tools = "supervisor";
  writeFileSync(env.ctx.cfg.configPath, YAML.stringify(config));
  const timer = setTimeout(() => {
    config.profiles.inspect.mode = "read_only"; config.profiles.inspect.tools = "repository_read";
    writeFileSync(env.ctx.cfg.configPath, YAML.stringify(config));
  }, 20);
  let effect = false;
  try { await expect(withOutsideAuthority(env, async signal => {
    await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    effect = true;
  })).rejects.toThrow(/revoked/); expect(effect).toBe(false); }
  finally { clearTimeout(timer); }
});
