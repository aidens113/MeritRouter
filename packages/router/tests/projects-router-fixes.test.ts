import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Switchyard } from "../src/core/service.js";
import type { ChatRequest, ChatResponse } from "../src/gateway/types.js";
import type { ResolvedConfig } from "../src/config/load.js";
import { openDatabase, type Db } from "../src/storage/db.js";
import { syntheticResult, TaskStore, WAITING_FOR_PROJECT_CAP, type ClaimLimits } from "../src/storage/tasks.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { Admission } from "../src/admission/admission.js";
import { AdmissionDenied } from "../src/core/errors.js";
import { classifyFailure } from "../src/core/disposition.js";
import { ProviderError } from "../src/providers/errors.js";
import { projectLimits } from "../src/projects/schema.js";
import { agentTimeline } from "../src/admin/job-metrics.js";
import { qualificationBoard } from "../src/admin/insights.js";
import { createCodingRunner } from "../src/runners/coding/index.js";
import { planComparison, runComparison } from "../src/qualification/comparison.js";
import { QUALIFICATION_PROJECT } from "../src/qualification/registry.js";
import { Brain } from "../src/brain/brain.js";
import { BrainAccess, type Principal } from "../src/brain/access.js";
import { ProjectRegistry } from "../src/projects/registry.js";
import { baseConfig, commitAll, goodOutput, makeEnv, openWithTestSupervisor as open, reply, ScriptedClient, servedFor, summarizeTask, type Env, type ScriptedRequest } from "./helpers.js";

// J2 router fixes for the projects layout: qualification and comparisons in a reserved project,
// a per-project brain index, the project-cap waiting reason, and distinct project denial reasons.

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

function gitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "README.md"), "# repo\n");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, stdio: "pipe" });
  commitAll(dir, "init");
}

const supervise = { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100, max_model_requests: 30, max_output_tokens: 4000, classify: "never", min_tier: "T3" };

/** Two projects and no top-level repositories (the projects shape); alpha is the primary project. */
function twoProjects(extra: Record<string, unknown> = {}, alpha: Record<string, unknown> = {}, beta: Record<string, unknown> = {}): Env {
  const base = baseConfig();
  const e = makeEnv({
    config: {
      ...base,
      repositories: {},
      routing: { escalate_on_failure: false },
      team: { provider_concurrency_enabled: false, max_agents: 8 },
      brain: { ...(base.brain as Record<string, unknown>), project: "alpha" },
      profiles: { ...(base.profiles as Record<string, unknown>), supervise },
      projects: {
        alpha: { name: "Acme Storefront", repositories: { app: { path: "alpha-app" } }, ...alpha },
        beta: { repositories: { app: { path: "beta-app" } }, ...beta },
      },
      ...extra,
    },
  });
  for (const d of ["alpha-app", "beta-app"]) gitRepo(path.join(e.dir, d));
  return e;
}

/** Aliases of runtime fixtures (qualification `q-...`, comparison `c-...`). */
const fixtureAliases = (paths: Record<string, unknown>) => Object.keys(paths).filter((a) => /^[qc]-/.test(a));
const call = (name: string, args: unknown, id = name) => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
const turns = (req: ChatRequest) => req.messages.filter((m) => m.role === "assistant").length;
const isSupervisor = (req: ChatRequest) => String(req.messages[0]!.content).startsWith("# Supervisor charter");

async function waitForRun(runId: string, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await sy!.qualifier.gradePending();
    const run = qualificationBoard(sy!).runs.find((r) => r.id === runId)!;
    if (run.status === "finished") return run;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("qualification run did not finish");
}

describe("qualification and comparisons in the projects layout", () => {
  it("a qualification run grades, in the reserved qualification project; no user project sees its fixtures", async () => {
    env = twoProjects({ coding: { runner: "native" } });
    const client = new ScriptedClient((req) => {
      if (req.tools?.length) {
        const rangeAlias = JSON.stringify(req.messages).match(/q-[a-z0-9]+-fix-range-1/)?.[0];
        if (rangeAlias) {
          if (turns(req) === 0) return reply(null, { ...servedFor(sy!, req), toolCalls: [call("replace_in_file", { path: "src/range.js", old_text: "i <= end", new_text: "i < end" })] });
          return reply(null, { ...servedFor(sy!, req), toolCalls: [call("submit_result", goodOutput(1, `${rangeAlias}:src/range.js#L1-L3`))] });
        }
        const alias = JSON.stringify(req.messages).match(/q-[a-z0-9]+-locate-validator-1/)?.[0];
        // Read the file it cites, then submit.
        if (turns(req) === 0) return reply(null, { ...servedFor(sy!, req), toolCalls: [call("read_file", { alias, path: "src/validation/address.js" })] });
        return reply(null, {
          ...servedFor(sy!, req),
          toolCalls: [call("submit_result", { summary: "checkAddress in src/validation/address.js decides it", findings: [{ description: "checkAddress validates emails", evidenceRefs: [`${alias}:src/validation/address.js#L5-L9`] }], criteria: [0, 1].map((index) => ({ index, status: "met", evidenceRefs: [`${alias}:src/validation/address.js#L5-L9`] })) }, "1")],
        });
      }
      return reply(JSON.stringify(goodOutput()), servedFor(sy!, req));
    });
    sy = open(env, client, { worker: true, coding: createCodingRunner(env.cfg) });
    expect(sy.projects.slugs()).toEqual(["alpha", "beta"]);

    const run = await sy.qualifier.start("openrouter/vendor/big-a:free", { evalIds: ["fix-range", "locate-validator"], trials: 1 });
    expect(run.tasks).toBe(2);
    const finished = await waitForRun(run.runId);
    expect(finished.graded).toBe(2);
    const board = qualificationBoard(sy);
    expect(board.results.find((r) => r.evalId === "fix-range")!.outcome, JSON.stringify(board.results)).toBe("pass");
    expect(board.results.find((r) => r.evalId === "locate-validator")!.outcome, JSON.stringify(board.results)).toBe("pass");

    // The run's tasks are the qualification project's, not the primary project's.
    const ids = (sy.db.prepare("SELECT task_id FROM qualification_tasks WHERE run_id = ?").all(run.runId) as Array<{ task_id: string }>).map((r) => r.task_id);
    expect(ids.map((id) => sy!.tasks.projectOf(id))).toEqual([QUALIFICATION_PROJECT, QUALIFICATION_PROJECT]);
    expect(sy.listTasks(undefined, 50, "alpha")).toEqual([]);
    expect(sy.listTasks(undefined, 50, "beta")).toEqual([]);
    // Its fixtures live only in its context: never in a user project's, nor the global config.
    expect(fixtureAliases(sy.projects.qualification.repositoryPaths)).toHaveLength(2);
    expect(fixtureAliases(sy.projectContext("alpha").repositoryPaths)).toEqual([]);
    expect(fixtureAliases(sy.projectContext("beta").repositoryPaths)).toEqual([]);
    expect(fixtureAliases(sy.cfg.repositoryPaths)).toEqual([]);
    expect(sy.projects.slugs()).toEqual(["alpha", "beta"]);
    // Nobody may submit work into it by name.
    await expect(sy.submitTasks([summarizeTask()], { project: QUALIFICATION_PROJECT })).rejects.toThrow(/unknown project _qualification/);
  }, 120_000);

  it("a comparison plans and runs an eval goal in the qualification project", async () => {
    env = twoProjects();
    const aliasIn = (req: ChatRequest) => JSON.stringify(req.messages).match(/c-[a-z0-9]+-locate-validator-(team|single)/)?.[0];
    const client = new ScriptedClient((req) => {
      const s = servedFor(sy!, req);
      const alias = aliasIn(req);
      if (isSupervisor(req)) {
        const script = [
          () => [call("delegate", { tasks: [{ label: "find-check", profile: "inspect", goal: "Find the email validator.", acceptance_criteria: ["cites it"], file_refs: [`${alias}:src/validation/address.js`] }] })],
          () => [call("await_tasks", { timeout_seconds: 30 })],
          () => [call("finish_job", { status: "completed", summary: "checkAddress validates emails.", verified: [{ claim: "checkAddress is in src/validation/address.js", evidence: "worker citation" }], not_verified: [] })],
        ];
        return reply(null, { ...s, toolCalls: script[Math.min(turns(req), 2)]!() });
      }
      if (turns(req) === 0) return reply(null, { ...s, toolCalls: [call("read_file", { alias, path: "src/validation/address.js" })] });
      return reply(null, { ...s, toolCalls: [call("submit_result", goodOutput(alias?.endsWith("-single") ? 2 : 1, `${alias}:src/validation/address.js#L5-L9`))] });
    });
    sy = open(env, client, { worker: true });
    const plan = planComparison(sy, { evalIds: ["locate-validator"] });
    expect(plan.goals).toMatchObject([{ id: "locate-validator", source: "eval", repository: null }]);
    expect(plan.fits).toBe(true);

    const c = await runComparison(sy, plan, { timeoutSeconds: 60 });
    expect(c.status).toBe("finished");
    const r = c.results[0]!;
    expect(r.team.metrics.state, JSON.stringify(r.team)).toBe("completed");
    expect(r.single.metrics.state, JSON.stringify(r.single)).toBe("completed");
    // Both runs, and the worker the team delegated, are in the qualification project.
    const team = sy.tasks.get(r.team.taskId)!;
    const child = (sy.db.prepare("SELECT id FROM tasks WHERE json_extract(spec_json, '$.parentTaskId') = ?").all(r.team.taskId) as Array<{ id: string }>).map((x) => x.id);
    expect(child).toHaveLength(1);
    for (const id of [r.team.taskId, r.single.taskId, ...child]) expect(sy.tasks.projectOf(id)).toBe(QUALIFICATION_PROJECT);
    expect(team.spec.profile).toBe("supervise");
    expect(fixtureAliases(sy.projectContext("alpha").repositoryPaths)).toEqual([]);
    expect(fixtureAliases(sy.projects.qualification.repositoryPaths)).toHaveLength(2);
  }, 120_000);
});

describe("per-project brain index", () => {
  it("a supervisor of A reads A's index, which never lists B's documents; the root names projects only", async () => {
    env = twoProjects();
    db = openDatabase(env.cfg.storageDir);
    const reg = new ProjectRegistry(env.cfg);
    const brainOf = (p: string) => new Brain(reg.require(p), db!, Date.now);
    const accessOf = (p: string) => new BrainAccess(db!, reg.require(p), Date.now);
    const supervisorOf = (p: string): Principal => accessOf(p).principalFor("supervisor", { project: p, effort: "job-1", task: null, repos: ["app"], jobId: null, tier: "T3" });
    const actor = (p: string) => ({ agent: `supervisor:${p}`, role: "supervisor", model: "x" });
    const alpha = brainOf("alpha");
    const beta = brainOf("beta");
    const doc = (title: string) => ({ title, statusDetail: "started", owner: "supervisor", scope: "s", currentState: "Nothing done yet." });

    await alpha.createWorkingDoc(supervisorOf("alpha"), actor("alpha"), "alpha-first", doc("Alpha first"));
    await beta.createWorkingDoc(supervisorOf("beta"), actor("beta"), "beta-secret", doc("Beta secret plan"));
    await alpha.createWorkingDoc(supervisorOf("alpha"), actor("alpha"), "alpha-second", doc("Alpha second"));

    const index = alpha.read(supervisorOf("alpha"), "projects/alpha/README.md").content;
    expect(index).toContain("projects/alpha/working/alpha-first.md");
    expect(index).toContain("projects/alpha/working/alpha-second.md");
    expect(index).not.toMatch(/beta/i);
    expect(beta.read(supervisorOf("beta"), "projects/beta/README.md").content).toContain("projects/beta/working/beta-secret.md");
    // A cannot read B's index, nor the root, nor write its own (generated) index.
    expect(() => alpha.read(supervisorOf("alpha"), "projects/beta/README.md")).toThrow(/no read access/);
    expect(() => alpha.read(supervisorOf("alpha"), "README.md")).toThrow(/no read access/);
    await expect(alpha.write(supervisorOf("alpha"), actor("alpha"), "projects/alpha/README.md", "# mine\n")).rejects.toThrow(/generated by SwitchYard/);
    // The root lists global/ and the projects by name, no project's documents.
    const root = readFileSync(path.join(alpha.root, "README.md"), "utf8");
    expect(root).toContain("global/glossary.md");
    expect(root).toContain("[Acme Storefront](projects/alpha/README.md)");
    expect(root).toContain("[beta](projects/beta/README.md)");
    expect(root).not.toMatch(/working\//);
  });
});

describe("waiting reason for a project's max_concurrent_tasks", () => {
  function storeFor(cfg: ResolvedConfig) {
    const clock = { t: 1_000_000 };
    db = openDatabase(cfg.storageDir);
    const store = new TaskStore(db, () => clock.t);
    const limits: ClaimLimits = {
      maxConcurrent: 8,
      maxWritersPerRepo: 1,
      leaseMs: 60_000,
      defaultTimeoutMs: 60_000,
      projectLimits: (slug) => {
        const l = projectLimits(cfg, slug);
        return { priority: l.priority, maxConcurrent: l.max_concurrent_tasks };
      },
    };
    return { clock, store, limits };
  }

  it("a task held by its project's cap says so in its state reason, an event, and the wait timeline", () => {
    env = twoProjects({}, { max_concurrent_tasks: 2 });
    const { clock, store, limits } = storeFor(env.cfg);
    const ids = store.submit([1, 2, 3].map((i) => WorkerTaskSchema.parse(summarizeTask({ goal: `alpha-${i}` }))), { project: "alpha" }).map((o) => o.taskId);
    clock.t += 1000;
    expect(store.claim("w", limits).map((t) => t.row.id)).toEqual(ids.slice(0, 2));
    const held = store.get(ids[2]!)!;
    expect(held.row.state).toBe("queued");
    expect(held.row.state_reason).toBe(`${WAITING_FOR_PROJECT_CAP}: project alpha is at its limit of 2 running tasks`);
    // Recorded once while the reason holds (a later tick does not repeat it).
    clock.t += 1000;
    expect(store.claim("w", limits)).toEqual([]);
    const events = () => db!.prepare("SELECT ts, type, data_json AS data FROM events WHERE task_id = ? ORDER BY id").all(ids[2]!) as Array<{ ts: number; type: string; data: string | null }>;
    expect(events().filter((e) => e.type === WAITING_FOR_PROJECT_CAP).map((e) => JSON.parse(e.data!))).toEqual([{ project: "alpha", limit: 2, running: 2 }]);
    // The panel's wait timeline attributes the wait to the project cap.
    clock.t += 3000;
    const tl = agentTimeline(store.get(ids[2]!)!, events(), clock.t);
    expect(tl.waits.map((w) => w.reason)).toContain("project_cap");
    // Once a slot frees, the task is claimed and the reason cleared.
    store.finish(ids[0]!, "w", syntheticResult(ids[0]!, "completed", "done"), "completed");
    clock.t += 1000;
    expect(store.claim("w", limits).map((t) => t.row.id)).toEqual([ids[2]]);
    expect(store.get(ids[2]!)!.row.state_reason).toBeNull();
  });
});

describe("distinct denial reasons for a project's own limits", () => {
  const paid = {
    enabled: true,
    budgets: { per_week_usd: 5 },
    tiers: { T1: "preferred" },
    providers: { acme: { kind: "openai_compatible", base_url: "https://api.acme.test/v1" } },
    models: [{ provider: "acme", model: "acme-large", input_usd_per_million: 2, output_usd_per_million: 8, context_limit_tokens: 100000, output_limit_tokens: 8000, ignore_size_floor: true }],
  };

  it("a project's request share is project_allocation_exhausted, and the task waits for the window", () => {
    env = twoProjects({ allocation: { max_model_requests_per_hour: 4 } }, { request_share: 0.5 });
    const clock = { t: 1_000_000 };
    db = openDatabase(env.cfg.storageDir);
    const store = new TaskStore(db, () => clock.t);
    const [id] = store.submit([WorkerTaskSchema.parse(summarizeTask())], { project: "alpha" }).map((o) => o.taskId);
    store.claim("w", { maxConcurrent: 4, maxWritersPerRepo: 1, leaseMs: 60_000, defaultTimeoutMs: 60_000 });
    const admission = new Admission(db, store, env.cfg, () => clock.t);
    const reserve = () =>
      admission.reserve({
        executionId: admission.createExecution("task", "summarize", [{ taskId: id!, itemId: id! }]),
        profile: "summarize",
        purpose: "execution",
        gatewayModel: "auto:x",
        endpointId: null,
        tier: "T1",
        estInputTokens: 10,
        reservedOutputTokens: 10,
        participants: [{ taskId: id!, leaseOwner: "w", budget: { maxModelRequests: 10, maxInputTokens: null, maxOutputTokens: null, maxPaidUsd: 0 }, estInputTokens: 10, reservedOutputTokens: 10 }],
      });
    reserve();
    reserve();
    let denied: AdmissionDenied | undefined;
    try {
      reserve();
    } catch (err) {
      denied = err as AdmissionDenied;
    }
    expect(denied).toBeInstanceOf(AdmissionDenied);
    expect(denied!.reason).toBe("project_allocation_exhausted");
    expect(denied!.retryAt).toBeGreaterThan(clock.t);
    // Same disposition as a package allocation denial: deferred until the window reopens.
    const d = classifyFailure(denied, new AbortController().signal, { cfg: env.cfg, now: () => clock.t, deadline: () => Infinity });
    expect(d).toEqual({ kind: "defer", at: denied!.retryAt, reason: denied!.message });
    const pkg = classifyFailure(new AdmissionDenied("package_hourly_allocation_exhausted", "m", denied!.retryAt), new AbortController().signal, { cfg: env.cfg, now: () => clock.t, deadline: () => Infinity });
    expect(pkg.kind).toBe("defer");
  });

  it("a project's paid cap is project_paid_budget_exhausted: free routes serve it, and a paid-only task fails with that reason", async () => {
    env = twoProjects({ paid }, { paid_budgets: { per_week_usd: 0.001 } });
    const paidCalls: ScriptedRequest[] = [];
    const client = new ScriptedClient((req): ChatResponse => {
      if (req.provider !== "acme") return reply(JSON.stringify(goodOutput()), servedFor(sy!, req));
      paidCalls.push(req);
      return { ...reply(JSON.stringify(goodOutput()), { model: req.model }), usage: { inputTokens: 1000, outputTokens: 500, cachedInputTokens: null, reasoningTokens: null, reportedCostUsd: null, basis: "provider_reported" } };
    });
    sy = open(env, client, { worker: true });
    sy.vault.add({ provider: "acme", secret: "sk-acme-0000-1111" });
    // Paid is preferred, but alpha's own cap skips it and a free model serves the task.
    const [a] = await sy.submitTasks([summarizeTask()], { project: "alpha" });
    const ra = (await sy.awaitResults([a!.taskId], { timeoutSeconds: 15 })).completed[0]!;
    expect(ra.executionStatus).toBe("completed");
    expect(ra.servedEndpoints).toEqual(["openrouter/vendor/big-a:free"]);
    expect(ra.routing!.attempts[0]!.outcome).toMatch(/skipped \(paid budget\).*project alpha weekly paid budget/);
    expect(paidCalls).toHaveLength(0);
    // Pinned to the paid model, nothing else may serve it: it fails with the project's reason.
    const [p] = await sy.submitTasks([summarizeTask({ routing: { endpointId: "paid:acme/acme-large" } })], { project: "alpha" });
    const rp = (await sy.awaitResults([p!.taskId], { timeoutSeconds: 15 })).completed[0]!;
    expect(rp.executionStatus).toBe("failed");
    expect(rp.stopReason).toMatch(/^project_paid_budget_exhausted: /);
    // Beta has no cap of its own: the same pinned task is served by the paid model.
    const [b] = await sy.submitTasks([summarizeTask({ routing: { endpointId: "paid:acme/acme-large" } })], { project: "beta" });
    const rb = (await sy.awaitResults([b!.taskId], { timeoutSeconds: 15 })).completed[0]!;
    expect(rb.servedEndpoints).toEqual(["paid:acme/acme-large"]);
    expect(paidCalls).toHaveLength(1);
  }, 60_000);

  it("the global paid budget keeps its own reason", () => {
    env = twoProjects();
    const d = classifyFailure(new AdmissionDenied("paid_budget_exhausted", "weekly paid budget"), new AbortController().signal, { cfg: env.cfg, now: () => 0, deadline: () => Infinity });
    expect(d).toEqual({ kind: "final", state: "failed", stopReason: "paid_budget_exhausted: weekly paid budget" });
  });

  it("does not defer a model-plan refusal as temporary provider capacity", () => {
    env = twoProjects();
    const refusal = new ProviderError("not_in_plan", "ollama-cloud HTTP 402: model not available on free plan", {
      provider: "ollama-cloud",
      status: 402,
      possiblyConsumed: false,
    });
    const d = classifyFailure(refusal, new AbortController().signal, {
      cfg: env.cfg,
      now: () => 0,
      deadline: () => Infinity,
    });
    expect(d).toEqual({
      kind: "final",
      state: "failed",
      stopReason: "gateway_not_in_plan: ollama-cloud HTTP 402: model not available on free plan",
    });
  });
});
