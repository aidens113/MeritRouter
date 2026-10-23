import { capturedLease } from "../src/storage/task-leases.js";
import { afterEach, describe, expect, it } from "vitest";
import type { MeritRouter } from "../src/core/service.js";
import type { ChatRequest } from "../src/gateway/types.js";
import { GatewayError } from "../src/core/errors.js";
import { effectiveBudget } from "../src/admission/admission.js";
import { ProviderCapacity, afterSuccess, afterThrottle, ceilingFor, readConcurrencyRecords, type ConcurrencyRecord, type ConcurrencySettings, type SlotHolder } from "../src/gateway/capacity.js";
import { ProviderHealth } from "../src/gateway/gate.js";
import { WAITING_FOR_PROVIDER_SLOT, type ClaimLimits } from "../src/storage/tasks.js";
import { PlanStore } from "../src/storage/plans.js";
import { rulebookTier } from "../src/routing/staffing.js";
import { claimTiers } from "../src/routing/claim-capacity.js";
import { baseConfig, endpoint, makeEnv, open, reply, ScriptedClient, servedFor, type Env } from "./helpers.js";

let env: Env | undefined;
let sy: MeritRouter | undefined;
afterEach(async () => {
  await sy?.close();
  sy = undefined;
  env?.cleanup();
  env = undefined;
});

const call = (name: string, args: unknown, id = name) => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
const turns = (req: ChatRequest) => req.messages.filter((m) => m.role === "assistant").length;
const isSupervisor = (req: ChatRequest) => String(req.messages[0]!.content).startsWith("# Supervisor charter");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting for a condition");
    await sleep(20);
  }
}

const SETTINGS: ConcurrencySettings = {
  provider_concurrency_enabled: true,
  provider_concurrency_start: 2,
  provider_concurrency_increase_after: 3,
  provider_concurrency_max: 4,
  provider_concurrency_limits: { tiny: 1 },
};

const LIMITS: ClaimLimits = { maxConcurrent: 20, maxWritersPerRepo: 10, leaseMs: 60_000, defaultTimeoutMs: 600_000 };

function teamConfig(team: Record<string, unknown>, execution: Record<string, unknown> = {}) {
  const cfg = baseConfig({ coding: { runner: "native" }, team, execution: { max_concurrent_tasks: 8, lease_seconds: 30, ...execution } });
  (cfg.profiles as Record<string, unknown>).supervise = { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100, max_model_requests: 30, max_output_tokens: 4000, classify: "never", min_tier: "T3" };
  return cfg;
}

const inspect = (label: string) => ({
  profile: "inspect",
  label,
  goal: `Inspect part ${label}`,
  repositoryAliases: ["core"],
  context: { fileRefs: ["core:README.md"] },
  constraints: { acceptanceCriteria: ["described"] },
});

const submitResult = (label: string) => [
  call("submit_result", { summary: `RESULT-${label}`, findings: [{ description: `finding of ${label}`, evidenceRefs: ["core:README.md"] }], criteria: [{ index: 0, status: "met", evidenceRefs: ["core:README.md"] }] }),
];

// ---------- AIMD transitions ----------

describe("provider concurrency (AIMD)", () => {
  it("adds a slot after N successes up to the ceiling, halves to a floor of 1, and honours confirmed limits", () => {
    const fresh: ConcurrencyRecord = { platform: "groq", limit: 2, successes: 0, generation: 0, lastChange: null, lastReason: null, lastChangeAt: null, cooldownResumeAt: null, updatedAt: 0 };
    expect(ceilingFor(SETTINGS, "groq")).toBe(4);
    expect(ceilingFor(SETTINGS, "tiny")).toBe(1);
    expect(ceilingFor({ ...SETTINGS, provider_concurrency_limits: { groq: 99 } }, "groq")).toBe(4);
    let r = fresh;
    r = afterSuccess(r, SETTINGS, 1);
    r = afterSuccess(r, SETTINGS, 2);
    expect(r).toMatchObject({ limit: 2, successes: 2 });
    r = afterSuccess(r, SETTINGS, 3);
    expect(r).toMatchObject({ limit: 3, successes: 0, lastChange: "increase" });
    for (let i = 0; i < 3; i++) r = afterSuccess(r, SETTINGS, 4 + i);
    expect(r.limit).toBe(4);
    for (let i = 0; i < 3; i++) r = afterSuccess(r, SETTINGS, 10 + i);
    expect(r).toMatchObject({ limit: 4, successes: 0 });
    r = afterThrottle(r, "rate_limited", 20);
    expect(r).toMatchObject({ limit: 2, generation: 1, lastChange: "decrease", lastReason: "rate_limited" });
    r = afterThrottle(afterThrottle(r, "cooldown", 21), "circuit_open", 22);
    expect(r).toMatchObject({ limit: 1, generation: 3 });
  });

  it("persists state in the store under a fake clock: generations, cooldowns, breaker openings, and a second process", async () => {
    let clock = 1_000_000;
    env = makeEnv({ config: teamConfig({ provider_concurrency_start: 2, provider_concurrency_increase_after: 3, provider_concurrency_max: 4, provider_concurrency_limits: { tiny: 1 } }) });
    sy = open(env, new ScriptedClient(() => reply("x")), { now: () => clock });
    const cap = sy.gate.health.capacity;
    expect(cap.enabled).toBe(true);
    expect(cap.limit("groq")).toBe(2);
    expect(cap.limit("tiny")).toBe(1);

    // Additive increase, up to the ceiling.
    for (let i = 0; i < 3; i++) cap.success("groq");
    expect(cap.limit("groq")).toBe(3);
    for (let i = 0; i < 9; i++) cap.success("groq");
    expect(cap.limit("groq")).toBe(4);

    // A burst of 429s from requests sent under one generation halves once.
    const gen = cap.record("groq").generation;
    expect(cap.throttle("groq", "rate_limited", gen)).toBe(true);
    expect(cap.throttle("groq", "rate_limited", gen)).toBe(false);
    expect(cap.throttle("groq", "rate_limited", gen)).toBe(false);
    expect(cap.limit("groq")).toBe(2);
    // Floor 1.
    cap.throttle("groq", "rate_limited");
    cap.throttle("groq", "rate_limited");
    expect(cap.limit("groq")).toBe(1);

    // A reported cooldown halves once per cooldown, not on every refresh.
    for (let i = 0; i < 6; i++) cap.success("mistral");
    expect(cap.limit("mistral")).toBe(4);
    cap.observeCooldown("mistral", clock + 60_000);
    cap.observeCooldown("mistral", clock + 60_000);
    expect(cap.limit("mistral")).toBe(2);
    cap.observeCooldown("mistral", clock + 90_000);
    expect(cap.limit("mistral")).toBe(1);
    cap.observeCooldown("mistral", clock - 1); // already over: nothing
    expect(cap.record("mistral").generation).toBe(2);

    // Through ProviderHealth: every key of a provider cooling down, and a breaker opening.
    const health = new ProviderHealth(() => clock, () => [{ platform: "openrouter", status: "rate_limited", keys: 1, resumeAt: clock + 30_000, requestsRemainingPct: 0, lastError: null }]);
    health.breakers.attach(sy.db, () => ({ enabled: true, failure_threshold: 2, open_seconds: 30, max_open_seconds: 900 }));
    health.capacity.attach(sy.db, () => env!.cfg.team, () => 600_000);
    for (let i = 0; i < 3; i++) health.recordOutcome("openrouter", null);
    expect(health.capacity.limit("openrouter")).toBe(3);
    await health.refresh();
    expect(health.capacity.limit("openrouter")).toBe(1);
    for (let i = 0; i < 6; i++) health.recordOutcome("openrouter", null);
    expect(health.capacity.limit("openrouter")).toBe(3);
    health.recordOutcome("openrouter", new GatewayError("server", "bad gateway", 502));
    expect(health.capacity.limit("openrouter")).toBe(3);
    health.recordOutcome("openrouter", new GatewayError("server", "bad gateway", 502));
    expect(health.breakers.get("openrouter").state).toBe("open");
    expect(health.capacity.record("openrouter")).toMatchObject({ limit: 1, lastReason: "circuit_open" });

    // A second process (or the panel) reads the same state.
    const other = new ProviderCapacity(() => clock);
    other.attach(sy.db, () => env!.cfg.team, () => 600_000);
    expect(other.limit("groq")).toBe(1);
    expect(readConcurrencyRecords(sy.db).map((r) => [r.platform, r.limit])).toEqual([
      ["groq", 1],
      ["mistral", 1],
      ["openrouter", 1],
    ]);
  });
});

// ---------- slots ----------

describe("provider slots", () => {
  it("counts in-flight requests across processes, queues by priority, and expires holds with the task lease", async () => {
    let clock = 5_000_000;
    env = makeEnv({ config: teamConfig({ provider_concurrency_start: 2 }) });
    sy = open(env, new ScriptedClient(() => reply("x")), { now: () => clock });
    const out = await sy.submitTasks([inspect("a"), inspect("b"), inspect("c"), inspect("d")]);
    const claimed = sy.tasks.claim("w1", LIMITS);
    expect(claimed).toHaveLength(4);
    const [a, b, c, d] = out.map((o) => o.taskId);
    const holder = (id: string, task: string, priority: 0 | 1 = 0): SlotHolder => ({ id, taskIds: [task], leaseOwner: "w1", priority, since: null });
    const cap = sy.gate.health.capacity;
    const other = new ProviderCapacity(() => clock);
    other.attach(sy.db, () => env!.cfg.team, () => 600_000);

    const ha = cap.tryAcquire(holder("ha", a!), "groq");
    const hb = other.tryAcquire(holder("hb", b!), "groq");
    expect("full" in ha || "full" in hb).toBe(false);
    const hc = holder("hc", c!);
    expect(cap.tryAcquire(hc, "groq")).toMatchObject({ full: true, held: 2, limit: 2 });
    expect(other.usage("groq")).toMatchObject({ requests: 2, limit: 2 });

    // A worker waits first; a supervisor request arriving later is still served first.
    cap.wait(hc, ["groq"]);
    clock += 10;
    const sup = holder("hs", d!, 1);
    cap.wait(sup, ["groq"]);
    cap.release(ha as never);
    expect(cap.tryAcquire(hc, "groq")).toMatchObject({ full: true, ahead: 1 });
    const hs = cap.tryAcquire(sup, "groq");
    expect("full" in hs).toBe(false);
    other.release(hb as never);
    const hc2 = cap.tryAcquire(hc, "groq");
    expect("full" in hc2).toBe(false);
    expect(cap.usage("groq")).toMatchObject({ requests: 2, waiting: 0 });

    // Scheduler claims count until the task's first request.
    expect(cap.admissible(["groq", "mistral"]).platform).toBe("mistral");
    cap.recordClaim(a!, "w1", "mistral");
    cap.recordClaim(b!, "w1", "mistral");
    expect(cap.admissible(["groq", "mistral"]).platform).toBeNull();
    const fromClaim = cap.tryAcquire(holder("ha2", a!), "mistral");
    expect("full" in fromClaim).toBe(false);
    expect(cap.usage("mistral")).toMatchObject({ requests: 1, claims: 1 });

    // A dead process: its task leases expire, and its holds stop counting and are purged.
    clock += 61_000;
    expect(cap.usage("groq")).toMatchObject({ requests: 0, claims: 0, waiting: 0 });
    expect(cap.admissible(["groq"]).platform).toBe("groq");
    expect((sy.db.prepare("SELECT COUNT(*) AS n FROM provider_slots").get() as { n: number }).n).toBe(0);
  });
});

// ---------- the scheduler ----------

describe("scheduler admission", () => {
  it("holds tasks beyond a provider's slots and releases them as slots free", async () => {
    env = makeEnv({ config: teamConfig({ provider_concurrency_start: 2, provider_concurrency_increase_after: 100 }) });
    let inflight = 0;
    let maxInflight = 0;
    const gates: Array<() => void> = [];
    const client = new ScriptedClient(async (req) => {
      const s = servedFor(sy!, req);
      const label = /Inspect part (\w)/.exec(String(req.messages.find((m) => m.role === "user")!.content))![1]!;
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise<void>((r) => gates.push(r));
      inflight--;
      return reply(null, { ...s, toolCalls: submitResult(label) });
    });
    sy = open(env, client, { worker: true });
    const ids = (await sy.submitTasks(["a", "b", "c", "d", "e"].map(inspect))).map((o) => o.taskId);
    await until(() => inflight === 2);
    await sleep(300);
    expect(inflight).toBe(2);
    const states = () => ids.map((id) => sy!.tasks.get(id)!.row);
    const waiting = () => states().filter((r) => r.state === "queued" && r.state_reason?.startsWith(`${WAITING_FOR_PROVIDER_SLOT}:`));
    expect(states().filter((r) => r.state === "running")).toHaveLength(2);
    expect(waiting()).toHaveLength(3);
    expect(waiting()[0]!.state_reason).toBe(`${WAITING_FOR_PROVIDER_SLOT}:openrouter`);
    const ev = sy.tasks.events(waiting()[0]!.id).find((e) => e.type === WAITING_FOR_PROVIDER_SLOT)!;
    expect(ev.data).toMatchObject({ platforms: [{ platform: "openrouter", limit: 2 }] });

    // Each finished request frees a slot, and one more task starts.
    gates.shift()!();
    await until(() => waiting().length === 2 && inflight === 2);
    gates.shift()!();
    await until(() => waiting().length === 1 && inflight === 2);
    while (sy.tasks.list({ states: ["completed"], limit: 10 }).length < 5) {
      gates.shift()?.();
      await sleep(30);
    }
    expect(maxInflight).toBe(2);
    expect((sy.db.prepare("SELECT COUNT(*) AS n FROM provider_slots WHERE kind = 'request'").get() as { n: number }).n).toBe(0);
  }, 30_000);

  it("never holds a supervisor back, and a job whose workers fill every slot still completes", async () => {
    env = makeEnv({ config: teamConfig({ max_agents: 8, provider_concurrency_start: 1, provider_concurrency_max: 1 }) });
    let inflight = 0;
    let maxInflight = 0;
    const script = [
      () => [call("plan_work", { nodes: ["a", "b", "c", "d"].map((l) => ({ label: l, profile: "inspect", goal: `Inspect part ${l}`, acceptance_criteria: ["described"], file_refs: ["core:README.md"] })) })],
      () => [call("await_tasks", { timeout_seconds: 120 })],
      () => [call("finish_job", { status: "completed", summary: "all parts inspected", verified: [{ claim: "every node finished", evidence: "await_tasks" }], not_verified: [] })],
    ];
    const client = new ScriptedClient(async (req) => {
      const s = servedFor(sy!, req);
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      try {
        if (isSupervisor(req)) {
          await sleep(50);
          return reply(null, { ...s, toolCalls: script[turns(req)]!() });
        }
        const label = /Inspect part (\w)/.exec(String(req.messages.find((m) => m.role === "user")!.content))![1]!;
        // Two turns per worker so workers keep coming back for the single slot.
        await sleep(150);
        if (turns(req) === 0) return reply(null, { ...s, toolCalls: [call("read_file", { alias: "core", path: "README.md" })] });
        return reply(null, { ...s, toolCalls: submitResult(label) });
      } finally {
        inflight--;
      }
    });
    sy = open(env, client, { worker: true });
    const job = await sy.startJob({ goal: "Inspect every part", repositories: ["core"], label: "slot-job" });
    const r = (await sy.awaitResults([job.taskId], { timeoutSeconds: 60 })).completed[0]!;
    expect(r.stopReason).toBe("supervisor_completed");
    expect(maxInflight).toBe(1);
    const children = sy.tasks.childrenOf(job.taskId);
    expect(children).toHaveLength(4);
    expect(children.every((c) => c.row.state === "completed")).toBe(true);
    // Workers waited for the slot at claim; the supervisor never did.
    expect(children.some((c) => sy!.tasks.events(c.row.id).some((e) => e.type === WAITING_FOR_PROVIDER_SLOT))).toBe(true);
    expect(sy.tasks.events(job.taskId).some((e) => e.type === WAITING_FOR_PROVIDER_SLOT)).toBe(false);

    // Staffing: nodes without a difficulty are planned at the rulebook's tier; the tasks carry no
    // difficulty hint, so they are still classified (tags can raise the tier and set importance).
    const sup = client.requests.filter(isSupervisor).at(-1)!;
    const planOut = String(sup.messages.find((m) => m.role === "tool")!.content);
    expect(planOut).toMatch(/tiers from the rulebook \(nodes without difficulty\): a T\d \(score \d+\); b T\d/);
    expect(planOut).toMatch(/provider slots/);
    const plan = new PlanStore(sy.db).latest(job.taskId)!;
    for (const c of children) {
      expect(c.spec.hints?.difficulty).toBeUndefined();
      expect(plan.nodes.find((n) => n.label === c.spec.label)!.difficulty).toMatch(/^T[123]$/);
    }
  }, 60_000);
});

// ---------- the gate under a 429 burst ----------

describe("gate", () => {
  it("halves concurrency on a 429 burst once and grows it back on success", async () => {
    env = makeEnv({ config: teamConfig({ provider_concurrency_start: 4, provider_concurrency_increase_after: 2, provider_concurrency_max: 4 }), endpoints: [endpoint({ providerId: "groq", gatewayModelId: "vendor/big-a:free" })] });
    let mode: "burst" | "ok" = "burst";
    const arrived: Array<() => void> = [];
    const client = new ScriptedClient(async (req) => {
      const s = servedFor(sy!, req);
      if (mode === "ok") return reply("fine", s);
      await new Promise<void>((r) => {
        arrived.push(r);
        if (arrived.length === 4) for (const go of arrived) go();
      });
      throw new GatewayError("rate_limited", "429 Too Many Requests", 429, 100, false);
    });
    sy = open(env, client);
    const out = await sy.submitTasks(["a", "b", "c", "d"].map(inspect));
    const claimed = sy.tasks.claim("w1", LIMITS);
    expect(claimed).toHaveLength(4);
    const plan = sy.router.plan("inspect", "T1", ["text"]);
    expect(plan.candidates.map((e) => e.providerId)).toEqual(["groq"]);
    const ask = (taskId: string) => {
      const t = sy!.tasks.get(taskId)!;
      const executionId = sy!.gate.admission.createExecution("task", "inspect", [{ taskId, itemId: "1" }]);
      return sy!.gate.request({
        plan,
        executionId,
        purpose: "tool_loop",
        participants: [{ taskId, lease: capturedLease(sy!.tasks.get(taskId)!), leaseOwner: "w1", budget: effectiveBudget(env!.cfg, t.spec) }],
        chat: { messages: [{ role: "user", content: "hello" }], max_tokens: 100 },
      });
    };
    const cap = sy.gate.health.capacity;
    expect(cap.limit("groq")).toBe(4);
    const burst = await Promise.allSettled(out.map((o) => ask(o.taskId)));
    expect(burst.every((b) => b.status === "rejected" && (b.reason as GatewayError).kind === "rate_limited")).toBe(true);
    // Four 429s from one generation: halved once (4 -> 2), not to the floor.
    expect(cap.record("groq")).toMatchObject({ limit: 2, generation: 1, lastReason: "rate_limited" });
    expect(cap.usage("groq").requests).toBe(0);

    // The 429s cooled groq's only key for their retry-after (0.1 s).
    await new Promise((r) => setTimeout(r, 150));
    mode = "ok";
    await ask(out[0]!.taskId);
    await ask(out[1]!.taskId);
    expect(cap.limit("groq")).toBe(3);
    await ask(out[2]!.taskId);
    await ask(out[3]!.taskId);
    expect(cap.limit("groq")).toBe(4);
  });

  it("waits for a slot instead of failing, and a waiting request takes the next free one", async () => {
    env = makeEnv({ config: teamConfig({ provider_concurrency_start: 1, provider_concurrency_max: 1 }) });
    const release: Array<() => void> = [];
    const client = new ScriptedClient(async (req) => {
      const s = servedFor(sy!, req);
      await new Promise<void>((r) => release.push(r));
      return reply("ok", s);
    });
    sy = open(env, client);
    const out = await sy.submitTasks(["a", "b"].map(inspect));
    sy.tasks.claim("w1", LIMITS);
    const plan = sy.router.plan("inspect", "T1", ["text"]);
    const ask = (taskId: string) =>
      sy!.gate.request({
        plan,
        executionId: sy!.gate.admission.createExecution("task", "inspect", [{ taskId, itemId: "1" }]),
        purpose: "tool_loop",
        participants: [{ taskId, lease: capturedLease(sy!.tasks.get(taskId)!), leaseOwner: "w1", budget: effectiveBudget(env!.cfg, sy!.tasks.get(taskId)!.spec) }],
        chat: { messages: [{ role: "user", content: "hello" }], max_tokens: 100 },
      });
    const first = ask(out[0]!.taskId);
    await until(() => release.length === 1);
    const second = ask(out[1]!.taskId);
    await sleep(400);
    expect(release).toHaveLength(1);
    expect(sy.gate.health.capacity.usage("openrouter")).toMatchObject({ requests: 1, waiting: 1 });
    release.shift()!();
    await first;
    await until(() => release.length === 1);
    release.shift()!();
    const r = await second;
    expect(r.response.message.content).toBe("ok");
    expect(sy.gate.health.capacity.usage("openrouter")).toMatchObject({ requests: 0, waiting: 0 });
  });
});

// ---------- staffing ----------

describe("cost-aware staffing", () => {
  it("scores a brief with the rulebook alone, never below its task type's minimum tier", async () => {
    env = makeEnv({ config: teamConfig({}) });
    sy = open(env, new ScriptedClient(() => reply("x")));
    const small = await rulebookTier(env.cfg, { ...inspect("a") } as never, sy.artifacts);
    expect(small).toMatchObject({ tier: "T1" });
    const analyze = await rulebookTier(env.cfg, { ...inspect("b"), profile: "analyze" } as never, sy.artifacts);
    expect(analyze!.tier).toBe("T2");
    expect(await rulebookTier(env.cfg, { profile: "inspect" } as never, sy.artifacts)).toBeNull();
    // The scheduler's tiers for a queued task: its hint, else every tier from the minimum.
    const row = { tier: null } as never;
    expect(claimTiers(env.cfg, row, { ...inspect("c"), hints: { difficulty: "T2" } } as never)).toEqual(["T2"]);
    expect(claimTiers(env.cfg, row, { ...inspect("c"), profile: "analyze" } as never)).toEqual(["T2", "T3"]);
  });
});

