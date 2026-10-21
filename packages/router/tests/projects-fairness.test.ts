import { afterEach, describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Switchyard } from "../src/core/service.js";
import { parseConfig, type ResolvedConfig } from "../src/config/load.js";
import { openDatabase, type Db } from "../src/storage/db.js";
import { syntheticResult, TaskStore, type ClaimLimits } from "../src/storage/tasks.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { Admission } from "../src/admission/admission.js";
import { AdmissionDenied } from "../src/core/errors.js";
import { projectLimits } from "../src/projects/schema.js";
import type { ChatResponse } from "../src/gateway/types.js";
import { baseConfig, goodOutput, makeEnv, open, reply, ScriptedClient, servedFor, summarizeTask, type Env, type ScriptedRequest } from "./helpers.js";

let env: Env | undefined;
let sy: Switchyard | undefined;
let db: Db | undefined;
afterEach(async () => {
  await sy?.close();
  sy = undefined;
  db?.close();
  db = undefined;
  env?.cleanup();
  env = undefined;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Two projects without repositories (summarize tasks need none); `alpha` and `beta` take extra fields. */
function projectsConfig(alpha: Record<string, unknown> = {}, beta: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    ...baseConfig(),
    repositories: {},
    routing: { escalate_on_failure: false },
    team: { provider_concurrency_enabled: false },
    projects: { alpha, beta },
    ...extra,
  };
}

const task = (goal: string, extra: Record<string, unknown> = {}) => WorkerTaskSchema.parse({ ...summarizeTask({ goal }), ...extra });

/** A store over a fresh database, with a settable clock, claiming under the config's project limits. */
function storeFor(cfg: ResolvedConfig) {
  const clock = { t: 1_000_000 };
  db = openDatabase(cfg.storageDir);
  const store = new TaskStore(db, () => clock.t);
  const limits = (maxConcurrent: number): ClaimLimits => ({
    maxConcurrent,
    maxWritersPerRepo: 1,
    leaseMs: 60_000,
    defaultTimeoutMs: 60_000,
    projectLimits: (slug) => {
      const l = projectLimits(cfg, slug);
      return { priority: l.priority, maxConcurrent: l.max_concurrent_tasks };
    },
  });
  const submit = (project: string, n: number, prefix = project) => {
    clock.t += 1;
    return store.submit(Array.from({ length: n }, (_, i) => task(`${prefix}-${i}`)), { project }).map((o) => o.taskId);
  };
  const finish = (id: string) => store.finish(id, "w", syntheticResult(id, "completed", "done"), "completed");
  /** Claim one task at a time and finish it, `n` times; returns the claimed tasks' projects in order. */
  const serve = (n: number) => {
    const order: string[] = [];
    for (let i = 0; i < n; i++) {
      clock.t += 1;
      const [t] = store.claim("w", limits(1));
      if (!t) break;
      order.push(t.row.project_id);
      finish(t.row.id);
    }
    return order;
  };
  return { clock, store, limits, submit, finish, serve };
}

describe("project limits configuration", () => {
  it("reads priority, max_concurrent_tasks, paid budgets, and request share, and refuses bad values", () => {
    const at = path.join(tmpdir(), "sy.yaml");
    const cfg = parseConfig(projectsConfig({ priority: 3, max_concurrent_tasks: 2, paid_budgets: { per_week_usd: 1 }, request_share: 0.25 }), at);
    expect(projectLimits(cfg, "alpha")).toEqual({ priority: 3, max_concurrent_tasks: 2, paid_budgets: { per_week_usd: 1 }, request_share: 0.25 });
    // Unset: priority 1 and no per-project limit; an unknown or legacy project likewise.
    expect(projectLimits(cfg, "beta")).toEqual({ priority: 1 });
    expect(projectLimits(cfg, "gone")).toEqual({ priority: 1 });
    expect(projectLimits(parseConfig(baseConfig(), at), "demo")).toEqual({ priority: 1 });
    expect(() => parseConfig(projectsConfig({ priority: 0 }), at)).toThrow(/projects\.alpha\.priority/);
    expect(() => parseConfig(projectsConfig({ request_share: 1.5 }), at)).toThrow(/projects\.alpha\.request_share/);
    expect(() => parseConfig(projectsConfig({ max_concurrent_tasks: 0 }), at)).toThrow(/projects\.alpha\.max_concurrent_tasks/);
    expect(() => parseConfig(projectsConfig({ paid_budgets: { per_year_usd: 1 } }), at)).toThrow(/projects\.alpha\.paid_budgets/);
  });
});

describe("fair claiming across projects", () => {
  it("a 50-task backlog in project A does not starve project B's single task", () => {
    env = makeEnv({ config: projectsConfig() });
    const s = storeFor(env.cfg);
    s.submit("alpha", 50);
    const [b] = s.submit("beta", 1);
    // B's task is claimed second, not 51st: the rotation alternates while both have ready tasks.
    expect(s.serve(3)).toEqual(["alpha", "beta", "alpha"]);
    expect(s.store.get(b!)!.row.state).toBe("completed");

    // A project that arrives after A has been served for a while joins at the front of the rotation
    // (without banked credit), and the rotation survives a new store (restart): it lives in the database.
    s.serve(10);
    const [late] = s.submit("beta", 2, "late");
    const restarted = new TaskStore(db!, () => s.clock.t);
    const [next] = restarted.claim("w", s.limits(1));
    expect(next!.row.id).toBe(late);
    s.finish(next!.row.id);
    expect(s.serve(3)).toEqual(["alpha", "beta", "alpha"]);
  });

  it("is oldest first within a project and FIFO when there is one project", () => {
    env = makeEnv({ config: projectsConfig() });
    const s = storeFor(env.cfg);
    const first = s.submit("alpha", 1, "first");
    const second = s.submit("alpha", 1, "second");
    const claimed = s.store.claim("w", s.limits(4)).map((t) => t.row.id);
    expect(claimed).toEqual([...first, ...second]);
  });

  it("the priority weight changes the ratio", () => {
    env = makeEnv({ config: projectsConfig({ priority: 3 }) });
    const s = storeFor(env.cfg);
    s.submit("alpha", 40);
    s.submit("beta", 40);
    const order = s.serve(20);
    expect(order.filter((p) => p === "alpha")).toHaveLength(15);
    expect(order.filter((p) => p === "beta")).toHaveLength(5);
    // Within one claim the same weights split the free slots.
    const batch = s.store.claim("w", s.limits(8));
    expect(batch.filter((t) => t.row.project_id === "alpha")).toHaveLength(6);
    expect(batch.filter((t) => t.row.project_id === "beta")).toHaveLength(2);
  });

  it("equal priorities split one claim's slots evenly", () => {
    env = makeEnv({ config: projectsConfig() });
    const s = storeFor(env.cfg);
    s.submit("alpha", 20);
    s.submit("beta", 20);
    const batch = s.store.claim("w", s.limits(8));
    expect(batch.map((t) => t.row.project_id)).toEqual(["alpha", "beta", "alpha", "beta", "alpha", "beta", "alpha", "beta"]);
  });

  it("the per-project concurrency cap holds under the global cap", () => {
    env = makeEnv({ config: projectsConfig({ max_concurrent_tasks: 2 }) });
    const s = storeFor(env.cfg);
    s.submit("alpha", 10);
    s.submit("beta", 5);
    const first = s.store.claim("w", s.limits(8));
    expect(first.filter((t) => t.row.project_id === "alpha")).toHaveLength(2);
    expect(first.filter((t) => t.row.project_id === "beta")).toHaveLength(5);
    // Global slots are free, but alpha is at its cap.
    expect(s.store.claim("w", s.limits(8))).toEqual([]);
    s.finish(first.find((t) => t.row.project_id === "alpha")!.row.id);
    const after = s.store.claim("w", s.limits(8));
    expect(after.map((t) => t.row.project_id)).toEqual(["alpha"]);
    // Seven run: alpha at its cap of two, and all five of beta.
    const running = s.store.list({ states: ["running"], limit: 100 }).length;
    expect(running).toBe(7);
  });

  it("a worker with a capped project serves at most that many of its tasks at once", async () => {
    env = makeEnv({ config: projectsConfig({ max_concurrent_tasks: 1 }) });
    const release: Array<() => void> = [];
    let peakAlpha = 0;
    const client = new ScriptedClient(async (req) => {
      peakAlpha = Math.max(peakAlpha, sy!.listTasks(["running"], 50, "alpha").length);
      await new Promise<void>((r) => release.push(r));
      return reply(JSON.stringify(goodOutput()), servedFor(sy!, req));
    });
    sy = open(env, client, { worker: true });
    // An explicit output cap keeps them out of prompt batches, so each is its own execution.
    const alpha = await sy.submitTasks([0, 1, 2].map((i) => summarizeTask({ goal: `a${i}`, budget: { maxOutputTokens: 1500 } })), { project: "alpha" });
    const beta = await sy.submitTasks([0, 1].map((i) => summarizeTask({ goal: `b${i}`, budget: { maxOutputTokens: 1500 } })), { project: "beta" });
    const end = Date.now() + 25_000;
    while (release.length < 3 && Date.now() < end) await sleep(25);
    await sleep(200);
    // One alpha task and both beta tasks are in flight; the other alpha tasks wait.
    expect(release).toHaveLength(3);
    expect(sy.listTasks(["running"], 50, "alpha")).toHaveLength(1);
    expect(sy.listTasks(["running"], 50, "beta")).toHaveLength(2);
    const ids = [...alpha, ...beta].map((s) => s.taskId);
    const drain = setInterval(() => release.splice(0).forEach((r) => r()), 20);
    try {
      const out = await sy.awaitResults(ids, { timeoutSeconds: 30 });
      expect(out.completed.map((r) => r.executionStatus)).toEqual(ids.map(() => "completed"));
    } finally {
      clearInterval(drain);
    }
    expect(peakAlpha).toBe(1);
  }, 90_000);
});

describe("prompt batching", () => {
  it("never mixes projects", async () => {
    env = makeEnv({ config: projectsConfig({}, {}, { execution: { max_concurrent_tasks: 4, lease_seconds: 30 } }) });
    const client = new ScriptedClient((req) => {
      const ids = [...String((req.messages[1] as { content: string }).content).matchAll(/<item id="(i\d+)">/g)].map((m) => m[1]!);
      return reply(JSON.stringify({ items: ids.map((id) => ({ id, result: goodOutput() })) }), servedFor(sy!, req));
    });
    sy = open(env, client);
    const a = await sy.submitTasks([summarizeTask({ goal: "alpha one" }), summarizeTask({ goal: "alpha two" })], { project: "alpha" });
    const b = await sy.submitTasks([summarizeTask({ goal: "beta one" }), summarizeTask({ goal: "beta two" })], { project: "beta" });
    sy.recover();
    // Start the worker only once all four are queued: one claim takes them all.
    (sy as unknown as { startWorker: (n: number) => void }).startWorker(50);
    const ids = [...a, ...b].map((s) => s.taskId);
    const out = await sy.awaitResults(ids, { timeoutSeconds: 10 });
    expect(out.completed.map((r) => r.executionStatus)).toEqual(["completed", "completed", "completed", "completed"]);
    // Two batches of two, each from one project (one project-blind batch would have held all four).
    expect(client.requests).toHaveLength(2);
    for (const req of client.requests) {
      const content = String((req.messages[1] as { content: string }).content);
      expect([...content.matchAll(/<item id=/g)]).toHaveLength(2);
      expect(content.includes("alpha") && content.includes("beta")).toBe(false);
    }
    const batchOf = (r: (typeof out.completed)[number]) => r.usage.batchId;
    const byId = new Map(out.completed.map((r) => [r.taskId, batchOf(r)]));
    expect(byId.get(a[0]!.taskId)).toBe(byId.get(a[1]!.taskId));
    expect(byId.get(b[0]!.taskId)).toBe(byId.get(b[1]!.taskId));
    expect(byId.get(a[0]!.taskId)).not.toBe(byId.get(b[0]!.taskId));
  });
});

describe("per-project budgets (D7)", () => {
  const paid = {
    enabled: true,
    budgets: { per_week_usd: 5 },
    tiers: { T1: "preferred" },
    providers: { acme: { kind: "openai_compatible", base_url: "https://api.acme.test/v1" } },
    models: [{ provider: "acme", model: "acme-large", input_usd_per_million: 2, output_usd_per_million: 8, context_limit_tokens: 100000, output_limit_tokens: 8000, ignore_size_floor: true }],
  };

  it("the per-project paid cap blocks paid routing for that project only", async () => {
    env = makeEnv({ config: projectsConfig({ paid_budgets: { per_week_usd: 0.001 } }, {}, { paid }) });
    const paidCalls: ScriptedRequest[] = [];
    const client = new ScriptedClient((req): ChatResponse => {
      if (req.provider !== "acme") return reply(JSON.stringify(goodOutput()), servedFor(sy!, req));
      paidCalls.push(req);
      return { ...reply(JSON.stringify(goodOutput()), { model: req.model }), usage: { inputTokens: 1000, outputTokens: 500, cachedInputTokens: null, reasoningTokens: null, reportedCostUsd: null, basis: "provider_reported" } };
    });
    sy = open(env, client, { worker: true });
    sy.vault.add({ provider: "acme", secret: "sk-acme-0000-1111" });
    const [a] = await sy.submitTasks([summarizeTask()], { project: "alpha" });
    const ra = (await sy.awaitResults([a!.taskId], { timeoutSeconds: 10 })).completed[0]!;
    // Alpha: max_output_tokens 2000 x $8/M = $0.016 worst case > its $0.001 weekly cap; free serves it.
    expect(paidCalls).toHaveLength(0);
    expect(ra.executionStatus).toBe("completed");
    expect(ra.servedEndpoints).toEqual(["openrouter/vendor/big-a:free"]);
    expect(ra.routing!.attempts[0]!.outcome).toMatch(/skipped \(paid budget\).*project alpha weekly paid budget/);
    // Beta has no cap of its own: paid (preferred) serves it, within the global budget.
    const [b] = await sy.submitTasks([summarizeTask()], { project: "beta" });
    const rb = (await sy.awaitResults([b!.taskId], { timeoutSeconds: 10 })).completed[0]!;
    expect(paidCalls).toHaveLength(1);
    expect(rb.servedEndpoints).toEqual(["paid:acme/acme-large"]);
    // Spend is attributed by project.
    expect(sy.spend.projectSpendSince("beta", 0)).toBeCloseTo(0.006, 6);
    expect(sy.spend.projectSpendSince("alpha", 0)).toBe(0);
  });

  it("a request share limits one project's use of the package allocation", () => {
    env = makeEnv({ config: projectsConfig({ request_share: 0.5 }, {}, { allocation: { max_model_requests_per_hour: 4 } }) });
    const s = storeFor(env.cfg);
    s.submit("alpha", 1);
    s.submit("beta", 1);
    const running = s.store.claim("w", s.limits(4));
    const admission = new Admission(db!, s.store, env.cfg, () => s.clock.t);
    const reserve = (taskId: string) => {
      const exec = admission.createExecution("task", "summarize", [{ taskId, itemId: taskId }]);
      return admission.reserve({
        executionId: exec,
        profile: "summarize",
        purpose: "execution",
        gatewayModel: "auto:x",
        endpointId: null,
        tier: "T1",
        estInputTokens: 10,
        reservedOutputTokens: 10,
        participants: [{ taskId, leaseOwner: "w", budget: { maxModelRequests: 10, maxInputTokens: null, maxOutputTokens: null, maxPaidUsd: 0 }, estInputTokens: 10, reservedOutputTokens: 10 }],
      });
    };
    const alpha = running.find((t) => t.row.project_id === "alpha")!.row.id;
    const beta = running.find((t) => t.row.project_id === "beta")!.row.id;
    reserve(alpha);
    reserve(alpha);
    // Alpha's share is 2 of 4 requests/hour; a third is denied with the project's own reason and a retry time.
    let denied: unknown;
    try {
      reserve(alpha);
    } catch (err) {
      denied = err;
    }
    expect(denied).toBeInstanceOf(AdmissionDenied);
    expect((denied as AdmissionDenied).reason).toBe("project_allocation_exhausted");
    expect((denied as AdmissionDenied).message).toMatch(/project alpha share of the package allocation \(2 of 4 requests\/hour\)/);
    expect((denied as AdmissionDenied).retryAt).toBeGreaterThan(s.clock.t);
    // Beta has no share: it may use the rest of the package allocation.
    reserve(beta);
    reserve(beta);
    expect(() => reserve(beta)).toThrow(/package allocation of 4 requests\/hour reached/);
  });
});
