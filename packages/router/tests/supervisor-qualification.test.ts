import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ModelEndpointSchema } from "../src/models/catalog.js";
import { ProviderError } from "../src/providers/errors.js";
import { MeritRouter } from "../src/core/service.js";
import { runSupervisorSandbox, SupervisorQualificationPending } from "../src/qualification/supervisor-qualification.js";
import type { RunContext } from "../src/runners/types.js";
import { runReadOnly } from "../src/runners/readonly.js";
import { SUPERVISOR_EVAL_OUTPUT_TOKENS } from "../src/qualification/registry.js";
import { gradeSupervisorDecisions, SUPERVISOR_GROUPS } from "../src/qualification/supervisor-suite.js";
import { assessSupervisorQuality } from "../src/routing/supervisor-quality.js";
import { baseConfig, endpoint, makeEnv, reply, ScriptedClient, type Env } from "./helpers.js";

let env: Env | undefined, sy: MeritRouter | undefined;
const fixtureDirectories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await sy?.close(); sy = undefined; env?.cleanup(); env = undefined; for (const dir of fixtureDirectories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const decisions = { decisions: [
  { group: "planning", tool: "plan_work", arguments: { nodes: [
    { label: "db", profile: "implement", allowed_paths: ["src/db/**"], depends_on: [] },
    { label: "api", profile: "implement", allowed_paths: ["src/api/**"], depends_on: ["db"] },
    { label: "ui", profile: "implement", allowed_paths: ["src/ui/**"], depends_on: ["api"] },
    { label: "tests", profile: "inspect", allowed_paths: [], depends_on: ["ui"] },
  ] } },
  { group: "tool_arguments", tool: "delegate", arguments: { tasks: [{ label: "profile-repair", profile: "implement", goal: "repair profile", allowed_paths: ["src/profile/**"], max_requests: 6, depends_on: [] }] } },
  { group: "dependency_repair", tool: "plan_work", arguments: { nodes: [{ label: "tests", depends_on: ["scaffold-redo"] }, { label: "review", depends_on: ["tests", "scaffold-redo"] }] } },
  { group: "integration", tool: "reject_task", arguments: { task_id: "feature", reason_code: "invalid-receipt" } },
  { group: "review", tool: "reject_task", arguments: { task_id: "worker", reason_code: "idor" } },
  { group: "final_decision", tool: "finish_job", arguments: { status: "blocked", verified: ["build", "unit_tests"], not_verified: ["wrong_password", "restart_persistence"] } },
] };
function projectDirectory() {
  const directory = mkdtempSync(path.join(tmpdir(), "meritrouter-supervisor-fixture-")); fixtureDirectories.push(directory);
  execFileSync("git", ["init", "-qb", "main"], { cwd: directory, stdio: "pipe" });
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture"], { cwd: directory, stdio: "pipe" });
  return directory;
}
const creditsConfiguration = {
  supervisor: { paid_policy: "on_free_exhaustion", routing: { minimum_quality: "ranked_capable" } },
  paid: { enabled: true, tiers: { T1: "never", T2: "never", T3: "never" }, budgets: { per_day_usd: 2 },
    providers: { acme: { kind: "openai_compatible", base_url: "https://acme.test/v1" } },
    models: [{ provider: "acme", model: "model", context_limit_tokens: 64000, output_limit_tokens: 8000, supports_tools: true, ignore_size_floor: true, input_usd_per_million: 2, output_usd_per_million: 8 }] },
};
function create(worker = false, customInspect = false, modelReply: unknown = decisions, overrides: Record<string, unknown> = {}) {
  const cfg = baseConfig();
  const profiles = cfg.profiles as Record<string, unknown>;
  if (customInspect) profiles.inspect = { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100, classify: "never" };
  profiles.supervise = { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100, classify: "never" };
  env = makeEnv({ config: { ...cfg, supervisor: { routing: { minimum_quality: "ranked_capable" } }, ...overrides } });
  const client = new ScriptedClient(req => reply(null, { model: req.model, provider: req.provider, toolCalls: [{ id: "decisions", type: "function", function: { name: "record_decisions", arguments: JSON.stringify(modelReply) } }] }));
  sy = new MeritRouter(env.cfg, { worker, providerFetch: client.fetch, pollIntervalMs: 30 });
  return client;
}
const task = { profile: "supervise", goal: "Create the requested bounded feature", repositoryAliases: ["core"], context: { inlineText: "retain exact original context" }, constraints: { acceptanceCriteria: ["feature behavior verified"] }, budget: { maxModelRequests: 8, maxPaidUsd: 0 }, idempotencyKey: "retained-intent" };
async function waitFinished(runId: string) {
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    await sy!.supervisorQualifier.gradePending();
    const row = sy!.projectStores("_qualification").db.prepare("SELECT status FROM qualification_runs WHERE id=?").get(runId) as { status: string };
    if (["finished", "failed"].includes(row.status)) return row.status;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`run did not finish: ${JSON.stringify(sy!.projectStores("_qualification").tasks.list().map(t => ({ state: t.row.state, reason: t.row.state_reason, result: t.result?.stopReason, events: sy!.projectStores("_qualification").tasks.events(t.row.id, 6) })))}`);
}

describe("bounded supervisor qualification", () => {
  it("grades observed decisions independently, rejects missing decisions and does not lexical-match arbitrary reason codes", () => {
    expect(gradeSupervisorDecisions(decisions)).toMatchObject({ coverage: 6, metrics: { role_points: 100 } });
    const synonym = structuredClone(decisions);
    (synonym.decisions.find(d => d.group === "tool_arguments")!.arguments as { tasks: Array<{ goal: string }> }).tasks[0]!.goal = "fix profile";
    expect(gradeSupervisorDecisions(synonym).metrics.role_points).toBe(gradeSupervisorDecisions(decisions).metrics.role_points);
    expect(gradeSupervisorDecisions({ ...decisions, metrics: { role_points: 100 } }).metrics.role_points).toBe(0);
    for (const group of SUPERVISOR_GROUPS) expect(gradeSupervisorDecisions({ decisions: decisions.decisions.filter(d => d.group !== group) }).metrics.role_points).toBe(0);
    const unsafe = structuredClone(decisions);
    unsafe.decisions.find(d => d.group === "final_decision")!.arguments = { status: "completed", verified: ["build", "unit_tests"], not_verified: ["wrong_password", "restart_persistence"] } as never;
    expect(gradeSupervisorDecisions(unsafe).metrics.final_decision).toBe(0);
  });

  it("fails the mandatory planning floor for an unsafe optional tests node", () => {
    const unsafe = structuredClone(decisions);
    const node = unsafe.decisions[0]!.arguments as { nodes: Array<{ label: string; profile: string; allowed_paths: string[]; depends_on: string[] }> };
    Object.assign(node.nodes.find(n => n.label === "tests")!, { profile: "implement", allowed_paths: ["**"], depends_on: [] });
    expect(gradeSupervisorDecisions(unsafe).metrics.planning).toBe(0);
  });

  it("distinguishes five queued candidates with post-queue plan refusals from invalid sandbox bindings", async () => {
    const cfg = baseConfig();
    env = makeEnv({ config: cfg, endpoints: Array.from({ length: 5 }, (_, index) => endpoint({ gatewayModelId: `vendor/evaluation-${index}:free` })) });
    sy = new MeritRouter(env.cfg, { worker: false });
    const runs = [];
    for (let index = 0; index < 5; index++) runs.push(await sy.supervisorQualifier.start(`openrouter/vendor/evaluation-${index}:free`));
    const credential = sy.providers.credentials().list("openrouter")[0]!;
    for (let index = 2; index < 5; index++) sy.providers.keys.recordFailure(credential, new ProviderError("not_in_plan", "fixture account does not include this model", { provider: "openrouter", possiblyConsumed: false }), `vendor/evaluation-${index}:free`);
    await sy.close();
    const client = new ScriptedClient(req => reply(null, { model: req.model, provider: req.provider, toolCalls: [{ id: "decision", type: "function", function: { name: "record_decisions", arguments: JSON.stringify(decisions) } }] }));
    sy = new MeritRouter(env.cfg, { worker: true, pollIntervalMs: 30, providerFetch: client.fetch });
    for (const run of runs) await waitFinished(run.runId);
    expect(client.requests).toHaveLength(2);
    const q = sy.projectStores("_qualification");
    for (const run of runs.slice(2)) {
      const detail = JSON.parse((q.db.prepare("SELECT detail_json FROM qualification_runs WHERE id=?").get(run.runId) as { detail_json: string }).detail_json);
      const task = q.tasks.get(detail.taskId)!;
      expect(task.result!.stopReason).toContain("supervisor_qualification_access_unavailable");
      expect(task.result!.stopReason).not.toContain("binding");
      expect(task.result!.usage.modelRequests).toBe(0);
      expect(sy.db.prepare("SELECT value FROM meta WHERE key=?").get(`supervisor-evidence:${run.runId}`)).toBeUndefined();
    }
  }, 30000);

  it("refuses a currently known model-plan exclusion before creating a qualification run", async () => {
    create();
    const credential = sy!.providers.credentials().list("openrouter")[0]!;
    sy!.providers.keys.recordFailure(credential, new ProviderError("not_in_plan", "fixture not included", { provider: "openrouter", possiblyConsumed: false }), "vendor/big-a:free");
    await expect(sy!.supervisorQualifier.start("openrouter/vendor/big-a:free")).rejects.toMatchObject({ code: "supervisor_qualification_access_unavailable" });
    expect(sy!.projectStores("_qualification").db.prepare("SELECT COUNT(*) n FROM qualification_runs").get()).toEqual({ n: 0 });
  });

  it("records an output-truncated response as inconclusive without inventing six failed decisions", async () => {
    create();
    await sy!.close();
    const client = new ScriptedClient(req => ({ ...reply(null, { model: req.model, provider: req.provider, usage: { outputTokens: req.max_tokens, reasoningTokens: req.max_tokens } }), finishReason: "length" }));
    sy = new MeritRouter(env!.cfg, { worker: true, pollIntervalMs: 30, providerFetch: client.fetch });
    const run = await sy.supervisorQualifier.start("openrouter/vendor/big-a:free");
    expect(await waitFinished(run.runId)).toBe("failed");
    expect(sy.projectStores("_qualification").db.prepare("SELECT outcome FROM qualification_results WHERE run_id=?").get(run.runId)).toEqual({ outcome: "infra_error" });
    expect(sy.db.prepare("SELECT value FROM meta WHERE key=?").get(`supervisor-evidence:${run.runId}`)).toBeUndefined();
    expect(sy.projectStores("_qualification").tasks.list()[0]!.result!.artifactRefs).toHaveLength(1);
    expect(client.requests[0]!.max_tokens).toBe(SUPERVISOR_EVAL_OUTPUT_TOKENS);
  }, 30000);

  it("does not let a queued old-suite evaluation fall through to ordinary read-only tools", async () => {
    create();
    const run = await sy!.supervisorQualifier.start("openrouter/vendor/big-a:free");
    const store = sy!.projectStores("_qualification"), raw = store.db.prepare("SELECT detail_json FROM qualification_runs WHERE id=?").get(run.runId) as { detail_json: string };
    const detail = JSON.parse(raw.detail_json), staleVersion = "supervisor-decisions-v2:retained-old-suite";
    detail.version = staleVersion;
    store.db.prepare("UPDATE qualification_runs SET suite_version=?,detail_json=? WHERE id=?").run(staleVersion, JSON.stringify(detail), run.runId);
    const task = store.tasks.get(detail.taskId)!;
    await expect(runReadOnly({ tasks: store.tasks, taskId: task.row.id, spec: task.spec, taskProject: "_qualification", cfg: sy!.projects.qualification } as unknown as RunContext)).rejects.toMatchObject({ code: "supervisor_qualification_suite_stale" });
    await sy!.supervisorQualifier.gradePending();
    expect(store.db.prepare("SELECT status FROM qualification_runs WHERE id=?").get(run.runId)).toEqual({ status: "failed" });
    expect(store.db.prepare("SELECT outcome FROM qualification_results WHERE run_id=?").get(run.runId)).toEqual({ outcome: "infra_error" });
    expect(sy!.db.prepare("SELECT value FROM meta WHERE key=?").get(`supervisor-evidence:${run.runId}`)).toBeUndefined();
  });

  it("quarantines malformed historical run detail without blocking a valid current result or inferring a task to cancel", async () => {
    create();
    const run = await sy!.supervisorQualifier.start("openrouter/vendor/big-a:free");
    const broken = '{"kind":"supervisor_decisions","taskId":';
    sy!.projectStores("_qualification").db.prepare("INSERT INTO qualification_runs(id,endpoint_id,suite_version,status,started_at,detail_json) VALUES(?,?,?,'running',?,?)")
      .run("q_corrupt_history", "openrouter/vendor/big-a:free", "supervisor-decisions-v2:retained-malformed", Date.now(), broken);
    await sy!.close();
    const client = new ScriptedClient(req => reply(null, { model: req.model, provider: req.provider, toolCalls: [{ id: "decision", type: "function", function: { name: "record_decisions", arguments: JSON.stringify(decisions) } }] }));
    sy = new MeritRouter(env!.cfg, { worker: true, pollIntervalMs: 30, providerFetch: client.fetch });
    expect(await waitFinished(run.runId)).toBe("finished");
    const q = sy.projectStores("_qualification");
    expect(q.db.prepare("SELECT status,detail_json FROM qualification_runs WHERE id='q_corrupt_history'").get()).toEqual({ status: "failed", detail_json: broken });
    const diagnostic = q.db.prepare("SELECT outcome,task_id,detail_json FROM qualification_results WHERE run_id='q_corrupt_history'").get() as { outcome: string; task_id: string | null; detail_json: string };
    expect(diagnostic).toMatchObject({ outcome: "infra_error", task_id: null });
    expect(JSON.parse(diagnostic.detail_json).detail).toContain("historical");
    expect(sy.db.prepare("SELECT value FROM meta WHERE key='supervisor-evidence:q_corrupt_history'").get()).toBeUndefined();
    expect(client.requests).toHaveLength(1);
  }, 30000);

  it("retains original request and paid holds when a pending submission crosses a suite version", async () => {
    create(false, false, decisions, creditsConfiguration);
    sy!.catalog.setOverride("openrouter/vendor/big-a:free", { forceStatus: "disabled" });
    sy!.vault.add({ provider: "acme", secret: "fake-test-key", label: "credits", billingClass: "paid_credits", prepaidBalanceUsd: 10 });
    const input = { ...task, budget: { maxModelRequests: 8, maxPaidUsd: 1 } };
    let pending: SupervisorQualificationPending | undefined;
    try { await sy!.submitTasks([input]); } catch (error) { pending = error as SupervisorQualificationPending; }
    expect(pending).toBeInstanceOf(SupervisorQualificationPending);
    const store = sy!.projectStores("_qualification"), runId = pending!.runIds[0]!;
    const detail = JSON.parse((store.db.prepare("SELECT detail_json FROM qualification_runs WHERE id=?").get(runId) as { detail_json: string }).detail_json);
    detail.version = "supervisor-decisions-v2:retained-old-suite";
    store.db.prepare("UPDATE qualification_runs SET suite_version=?,detail_json=? WHERE id=?").run(detail.version, JSON.stringify(detail), runId);
    await sy!.supervisorQualifier.gradePending();
    await sy!.close();
    sy = new MeritRouter(env!.cfg, { worker: true, pollIntervalMs: 30, providerFetch: new ScriptedClient(req => reply(null, { model: req.model, provider: req.provider, toolCalls: [{ id: "decision", type: "function", function: { name: "record_decisions", arguments: JSON.stringify(decisions) } }] })).fetch });
    let submitted;
    try { submitted = await sy.resumeSupervisorSubmission(pending!.submissionRef, "demo"); } catch (error) {
      expect(error).toBeInstanceOf(SupervisorQualificationPending);
      for (const id of (error as SupervisorQualificationPending).runIds) await waitFinished(id);
      submitted = await sy.resumeSupervisorSubmission(pending!.submissionRef, "demo");
    }
    expect(sy.tasks.get(submitted![0]!.taskId)!.spec.budget).toMatchObject({ maxModelRequests: 6, maxPaidUsd: .25 });
    expect(sy.projectStores("_qualification").db.prepare("SELECT COUNT(*) n FROM qualification_runs").get()).toEqual({ n: 2 });
  }, 30000);

  it("runs an unranked model only in the fixed sandbox, persists measured aggregate and isolates a custom inspect supervisor", async () => {
    const client = create(true, true);
    expect(env!.cfg.profiles.inspect!.mode).toBe("supervisor");
    const run = await sy!.supervisorQualifier.start("openrouter/vendor/big-a:free");
    expect(await waitFinished(run.runId)).toBe("finished");
    expect(client.requests).toHaveLength(1);
    expect(client.requests[0]!.tools!.map(t => t.function.name)).toEqual(["record_decisions"]);
    expect(JSON.stringify(client.requests[0]!.messages)).not.toContain("retain exact original context");
    expect(assessSupervisorQuality("openrouter/vendor/big-a:free", env!.cfg.supervisor.routing, new Date(), false, { provider: "openrouter", model: "vendor/big-a:free" })).toMatchObject({ eligible: true, score: 100 });
    const aggregate = sy!.db.prepare("SELECT value FROM meta WHERE key LIKE 'supervisor-evidence:%'").get() as { value: string };
    expect(aggregate.value).not.toContain('"decisions"');
    expect(aggregate.value).toContain("one trial");
  }, 30000);

  it("returns durable pending instead of a job without a worker; identical retry deduplicates and preserves intent across restart", async () => {
    create();
    let pending: SupervisorQualificationPending | undefined;
    try { await sy!.submitTasks([task]); } catch (error) { pending = error as SupervisorQualificationPending; }
    expect(pending).toBeInstanceOf(SupervisorQualificationPending);
    expect(sy!.listTasks(undefined, 20, "demo")).toHaveLength(0);
    const original = sy!.projectStores("demo").artifacts.read(pending!.submissionRef)!;
    expect(JSON.parse(original.content.toString()).specs[0]).toMatchObject(task);
    await expect(sy!.submitTasks([task])).rejects.toMatchObject({ code: "supervisor_qualification_pending", runIds: pending!.runIds, submissionRef: pending!.submissionRef });
    expect(sy!.projectStores("_qualification").db.prepare("SELECT COUNT(*) n FROM qualification_runs").get()).toEqual({ n: 1 });
    await sy!.close();
    sy = new MeritRouter(env!.cfg, { worker: true, pollIntervalMs: 30, providerFetch: new ScriptedClient(() => reply(null, { toolCalls: [{ id: "decision", type: "function", function: { name: "record_decisions", arguments: JSON.stringify(decisions) } }] })).fetch });
    await waitFinished(pending!.runIds[0]!);
    const [submitted] = await sy!.resumeSupervisorSubmission(pending!.submissionRef, "demo");
    expect(submitted!.deduplicated).toBe(false);
    const stored = sy!.tasks.get(submitted!.taskId)!;
    expect(stored.spec).toMatchObject({ goal: task.goal, context: task.context, idempotencyKey: task.idempotencyKey, budget: { maxModelRequests: 7, maxPaidUsd: 0 } });
    const [retry] = await sy!.submitTasks([task]);
    expect(retry).toMatchObject({ taskId: submitted!.taskId, deduplicated: true });
  }, 30000);

  it("resumes a saved no-key submission exactly once without changing the caller's explicit key semantics", async () => {
    create();
    const { idempotencyKey: _omitted, ...input } = task;
    let pending: SupervisorQualificationPending | undefined;
    try { await sy!.submitTasks([input]); } catch (error) { pending = error as SupervisorQualificationPending; }
    expect(pending).toBeInstanceOf(SupervisorQualificationPending);
    await sy!.close();
    sy = new MeritRouter(env!.cfg, { worker: true, pollIntervalMs: 30, providerFetch: new ScriptedClient(req => reply(null, { model: req.model, provider: req.provider, toolCalls: [{ id: "decision", type: "function", function: { name: "record_decisions", arguments: JSON.stringify(decisions) } }] })).fetch });
    await waitFinished(pending!.runIds[0]!);
    const [first] = await sy!.resumeSupervisorSubmission(pending!.submissionRef, "demo");
    const [second] = await sy!.resumeSupervisorSubmission(pending!.submissionRef, "demo");
    expect(second).toMatchObject({ taskId: first!.taskId, deduplicated: true });
    expect(sy!.listTasks(undefined, 20, "demo")).toHaveLength(1);
    expect(sy!.tasks.get(first!.taskId)!.spec.budget!.maxModelRequests).toBe(7);
  }, 30000);

  it.each(["legacy", "split"])("preserves the ordinary generic inspect read-then-submit qualification harness: %s", async layout => {
    const directory = layout === "split" ? projectDirectory() : undefined;
    const cfg = baseConfig(directory ? { storage: { directory: ".meritrouter", layout }, repositories: {}, projects: { demo: { directory, repositories: { core: { path: directory } } } } } : {});
    env = makeEnv({ config: cfg });
    const client = new ScriptedClient(req => {
      const alias = JSON.stringify(req.messages).match(/q-[a-z0-9]+-locate-validator-1/)?.[0];
      const first = !req.messages.some(message => message.role === "tool");
      return reply(null, { model: req.model, provider: req.provider, toolCalls: [{ id: first ? "read" : "submit", type: "function", function: {
        name: first ? "read_file" : "submit_result", arguments: JSON.stringify(first ? { alias, path: "src/validation/address.js" } : {
          summary: "checkAddress validates emails", findings: [{ description: "checkAddress validates emails", evidenceRefs: [`${alias}:src/validation/address.js#L5-L9`] }], criteria: [0, 1].map(index => ({ index, status: "met", evidenceRefs: [`${alias}:src/validation/address.js#L5-L9`] })),
        }),
      } }] });
    });
    sy = new MeritRouter(env.cfg, { worker: true, pollIntervalMs: 30, providerFetch: client.fetch });
    if (directory) await sy.createSplitProject({ slug: "demo", directory });
    const run = await sy.qualifier.start("openrouter/vendor/big-a:free", { evalIds: ["locate-validator"], trials: 1 });
    const until = Date.now() + 15000;
    while (Date.now() < until) {
      await sy.qualifier.gradePending();
      if (sy.projectStores("_qualification").db.prepare("SELECT 1 FROM qualification_results WHERE run_id=?").get(run.runId)) break;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    expect(sy.projectStores("_qualification").db.prepare("SELECT outcome FROM qualification_results WHERE run_id=?").get(run.runId)).toEqual({ outcome: "pass" });
    expect(client.requests).toHaveLength(2);
  }, 30000);

  it("does not deduct requests again when a later submission reuses current finished qualification", async () => {
    create(true);
    const run = await sy!.supervisorQualifier.start("openrouter/vendor/big-a:free");
    await waitFinished(run.runId);
    const [submitted] = await sy!.submitTasks([task]);
    expect(sy!.tasks.get(submitted!.taskId)!.spec.budget!.maxModelRequests).toBe(8);
  }, 30000);

  it("refuses unauthorized project final supervision before qualification quota or tasks", async () => {
    const client = create(true);
    await expect(sy!.submitTasks([{ ...task, supervisionScope: "project" }])).rejects.toThrow("Dispatching a final project supervisor is disabled");
    expect(client.requests).toHaveLength(0);
    expect(sy!.db.prepare("SELECT COUNT(*) n FROM meta WHERE key LIKE 'supervisor-submission:%'").get()).toEqual({ n: 0 });
  });

  it("does not accept model-supplied scores or ordinary read-only output as qualification", async () => {
    create(true, false, { metrics: { role_points: 100 }, decisions: [] });
    const run = await sy!.supervisorQualifier.start("openrouter/vendor/big-a:free");
    await waitFinished(run.runId);
    expect(assessSupervisorQuality("openrouter/vendor/big-a:free", env!.cfg.supervisor.routing, new Date(), false, { provider: "openrouter", model: "vendor/big-a:free" }).eligible).toBe(false);
  }, 30000);

  it("holds daily request allocation durably before any transport and refuses paid candidates without caller authority", async () => {
    create();
    env!.cfg.qualification.max_requests_per_day = 1;
    await sy!.supervisorQualifier.start("openrouter/vendor/big-a:free");
    sy!.catalog.saveProviderDiscovery([ModelEndpointSchema.parse(endpoint({ gatewayModelId: "vendor/other:free" }))], ["openrouter/vendor/other:free"]);
    await expect(sy!.supervisorQualifier.start("openrouter/vendor/other:free")).rejects.toMatchObject({ code: "supervisor_qualification_budget_unavailable" });
  });

  it("records the default500 job ceiling with paid disabled, preserves explicit0 and an existing task ceiling", async () => {
    create(false, false, decisions, { paid: { enabled: false }, supervisor: { routing: { minimum_quality: "best_available" } } });
    const omitted = { ...task, budget: { maxModelRequests: 8 }, idempotencyKey: "default-cap" };
    const [first] = await sy!.submitTasks([omitted]);
    expect(sy!.tasks.get(first!.taskId)!.spec.budget!.maxPaidUsd).toBe(500);
    expect(sy!.cfg.paid.enabled).toBe(false);
    const [zero] = await sy!.submitTasks([{ ...task, idempotencyKey: "explicit-zero" }]);
    expect(sy!.tasks.get(zero!.taskId)!.spec.budget!.maxPaidUsd).toBe(0);
    sy!.cfg.supervisor.default_max_paid_usd = 700;
    const [same] = await sy!.submitTasks([omitted]);
    expect(same).toMatchObject({ taskId: first!.taskId, deduplicated: true });
    expect(sy!.tasks.get(same!.taskId)!.spec.budget!.maxPaidUsd).toBe(500);
    const started = await sy!.startJob({ goal: "bounded new job", repositories: ["core"], maxModelRequests: 8 });
    expect(sy!.tasks.get(started.taskId)!.spec.budget!.maxPaidUsd).toBe(700);
  });

  it("runs qualification in its own split store with a fixed inspect profile and publishes only aggregate evidence", async () => {
    const directory = projectDirectory();
    const client = create(true, true, decisions, { storage: { directory: ".meritrouter", layout: "split" }, repositories: {}, projects: { demo: { directory, repositories: { core: { path: directory } } } } });
    await sy!.createSplitProject({ slug: "demo", directory });
    const run = await sy!.supervisorQualifier.start("openrouter/vendor/big-a:free");
    expect(await waitFinished(run.runId)).toBe("finished");
    expect(client.requests).toHaveLength(1);
    expect(sy!.db.prepare("SELECT COUNT(*) n FROM tasks").get()).toEqual({ n: 0 });
    expect(sy!.projectStores("demo").db.prepare("SELECT COUNT(*) n FROM qualification_runs").get()).toEqual({ n: 0 });
    const privateRun = sy!.projectStores("_qualification").db.prepare("SELECT detail_json FROM qualification_runs WHERE id=?").get(run.runId) as { detail_json: string };
    expect(JSON.parse(privateRun.detail_json).fixture.startsWith(path.dirname(sy!.projectStores("_qualification").artifacts.root) + path.sep)).toBe(true);
    const [submitted] = await sy!.submitTasks([task]);
    expect(sy!.projectStores("demo").tasks.get(submitted!.taskId)!.spec.budget!.maxModelRequests).toBe(8);
  }, 30000);

  it("rejects forged sandbox authority before transport and recovers an interrupted task-binding publication", async () => {
    const client = create();
    const run = await sy!.supervisorQualifier.start("openrouter/vendor/big-a:free");
    const store = sy!.projectStores("_qualification"), saved = store.db.prepare("SELECT detail_json FROM qualification_runs WHERE id=?").get(run.runId) as { detail_json: string };
    const detail = JSON.parse(saved.detail_json), stored = store.tasks.get(detail.taskId)!;
    const context = { tasks: store.tasks, taskId: stored.row.id, cfg: sy!.projects.qualification, profile: sy!.projects.qualification.profiles.inspect!, spec: { ...stored.spec, goal: "forged" }, taskProject: "_qualification" } as unknown as RunContext;
    await expect(runSupervisorSandbox(context)).rejects.toMatchObject({ code: "supervisor_qualification_binding_invalid" });
    expect(client.requests).toHaveLength(0);
    store.db.prepare("DELETE FROM qualification_tasks WHERE run_id=?").run(run.runId);
    detail.preparingUntil = Date.now() - 1;
    store.db.prepare("UPDATE qualification_runs SET status='preparing',detail_json=? WHERE id=?").run(JSON.stringify(detail), run.runId);
    expect((await sy!.supervisorQualifier.start("openrouter/vendor/big-a:free")).runId).toBe(run.runId);
    expect(store.db.prepare("SELECT task_id FROM qualification_tasks WHERE run_id=?").get(run.runId)).toEqual({ task_id: stored.row.id });
  });

  it("uses explicit bounded paid authority in the internal lane while ordinary worker tiers remain never", async () => {
    const client = create(true, true, decisions, { paid: { enabled: true, tiers: { T1: "never", T2: "never", T3: "never" }, budgets: { per_day_usd: 2 },
      providers: { acme: { kind: "openai_compatible", base_url: "https://acme.test/v1" } },
      models: [{ provider: "acme", model: "model", context_limit_tokens: 64000, output_limit_tokens: 8000, supports_tools: true, ignore_size_floor: true, input_usd_per_million: 2, output_usd_per_million: 8 }] } });
    sy!.vault.add({ provider: "acme", secret: "fake-test-key", label: "credits", billingClass: "paid_credits", prepaidBalanceUsd: 10 });
    await expect(sy!.supervisorQualifier.start("paid:acme/model", 0)).rejects.toMatchObject({ code: "supervisor_qualification_budget_unavailable" });
    const run = await sy!.supervisorQualifier.start("paid:acme/model", .1);
    expect(await waitFinished(run.runId)).toBe("finished");
    expect(client.requests).toHaveLength(1);
    expect(client.requests[0]!.provider).toBe("acme");
    expect(sy!.cfg.paid.tiers.T1).toBe("never");
    const privateTask = sy!.projectStores("_qualification").tasks.list()[0]!;
    expect(privateTask.spec.budget).toMatchObject({ maxModelRequests: 1, maxPaidUsd: .1 });
  }, 30000);

  it("resumes an implicit default500 pending submission with paid disabled and preserves that default across config changes", async () => {
    create(false, false, decisions, { paid: { enabled: false } });
    const input = { ...task, budget: { maxModelRequests: 8 }, idempotencyKey: "pending-default" };
    let pending: SupervisorQualificationPending | undefined;
    try { await sy!.submitTasks([input]); } catch (error) { pending = error as SupervisorQualificationPending; }
    expect(pending).toBeInstanceOf(SupervisorQualificationPending);
    await sy!.close();
    sy = new MeritRouter(env!.cfg, { worker: true, pollIntervalMs: 30, providerFetch: new ScriptedClient(req => reply(null, { model: req.model, provider: req.provider, toolCalls: [{ id: "decision", type: "function", function: { name: "record_decisions", arguments: JSON.stringify(decisions) } }] })).fetch });
    await waitFinished(pending!.runIds[0]!);
    sy!.cfg.supervisor.default_max_paid_usd = 700;
    const [submitted] = await sy!.resumeSupervisorSubmission(pending!.submissionRef, "demo");
    expect(sy!.tasks.get(submitted!.taskId)!.spec.budget).toMatchObject({ maxPaidUsd: 500, maxModelRequests: 7 });
    await expect(sy!.submitTasks([{ ...task, idempotencyKey: "explicit-paid-disabled", budget: { maxModelRequests: 8, maxPaidUsd: 500 } }])).rejects.toThrow("paid routing is disabled");
  }, 30000);

  it("accounts queued generic qualification allocation in the same daily request ceiling", async () => {
    create();
    sy!.cfg.qualification.max_requests_per_day = 6;
    await sy!.qualifier.start("openrouter/vendor/big-a:free", { evalIds: ["locate-validator"], trials: 1 });
    await expect(sy!.supervisorQualifier.start("openrouter/vendor/big-a:free")).rejects.toMatchObject({ code: "supervisor_qualification_budget_unavailable" });
  });

  it("does not publish invented zero scores for a cancelled infrastructure run and supports a bounded retry", async () => {
    const client = create();
    const run = await sy!.supervisorQualifier.start("openrouter/vendor/big-a:free");
    const store = sy!.projectStores("_qualification"), task = store.tasks.list()[0]!;
    sy!.cancelTasks([task.row.id], "_qualification");
    await sy!.supervisorQualifier.gradePending();
    expect(store.db.prepare("SELECT status FROM qualification_runs WHERE id=?").get(run.runId)).toEqual({ status: "failed" });
    expect(store.db.prepare("SELECT outcome FROM qualification_results WHERE run_id=?").get(run.runId)).toEqual({ outcome: "infra_error" });
    expect(sy!.db.prepare("SELECT COUNT(*) n FROM meta WHERE key LIKE 'supervisor-evidence:%'").get()).toEqual({ n: 0 });
    expect((await sy!.supervisorQualifier.retryFailed("openrouter/vendor/big-a:free")).runId).not.toBe(run.runId);
    expect(client.requests).toHaveLength(0);
  });

  it.each(["legacy", "split"])("drains active fixture preparation before closing the database: %s", async layout => {
    const directory = layout === "split" ? projectDirectory() : undefined;
    create(false, false, decisions, directory ? { storage: { directory: ".meritrouter", layout }, repositories: {}, projects: { demo: { directory, repositories: { core: { path: directory } } } } } : {});
    if (directory) await sy!.createSplitProject({ slug: "demo", directory });
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(sy!, "submitTasks").mockImplementation(async () => { entered(); await barrier; throw new Error("fixture submission interrupted during drain"); });
    const preparing = sy!.supervisorQualifier.start("openrouter/vendor/big-a:free").catch(error => error);
    await reached;
    const privateDb = sy!.projectStores("_qualification").db;
    const current = sy!, closing = current.close();
    let closed = false; void closing.then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(closed).toBe(false); expect(current.db.open).toBe(true); expect(privateDb.open).toBe(true);
    release();
    expect(await preparing).toBeInstanceOf(Error);
    await closing; expect(current.db.open).toBe(false); sy = undefined;
  });

  it.each(["not_in_plan", "auth_invalid", "quota"] as const)("qualifies paid fallback after a previously qualified free key is unavailable: %s", async reason => {
    const client = create(true, false, decisions, creditsConfiguration);
    sy!.vault.add({ provider: "acme", secret: "fake-test-key", label: "credits", billingClass: "paid_credits", prepaidBalanceUsd: 10 });
    const free = await sy!.supervisorQualifier.start("openrouter/vendor/big-a:free"); await waitFinished(free.runId);
    const credential = sy!.providers.credentials().list("openrouter")[0]!;
    if (reason === "quota") sy!.providers.keys.recordQuota(credential, { limit: 1, used: 1, remaining: 0, resetAt: Date.now() + 3600000, checkedAt: Date.now() });
    else sy!.providers.keys.recordFailure(credential, new ProviderError(reason, "fixture availability refusal", { provider: "openrouter", possiblyConsumed: false }), "vendor/big-a:free");
    const input = { ...task, budget: { maxModelRequests: 8, maxPaidUsd: 1 } };
    let outcome;
    try { outcome = await sy!.submitTasks([input]); } catch (error) {
      expect(error).toBeInstanceOf(SupervisorQualificationPending);
      const pending = error as SupervisorQualificationPending;
      for (const id of pending.runIds) await waitFinished(id);
      outcome = await sy!.resumeSupervisorSubmission(pending.submissionRef, "demo");
    }
    expect(outcome![0]!.taskId).toBeTruthy();
    expect(client.requests.some(request => request.provider === "acme" && request.tools?.some(tool => tool.function.name === "record_decisions"))).toBe(true);
  }, 30000);

  it("does not let a disabled free entry in a retained intent abort paid qualification", async () => {
    create(false, false, decisions, creditsConfiguration);
    sy!.vault.add({ provider: "acme", secret: "fake-test-key", label: "credits", billingClass: "paid_credits", prepaidBalanceUsd: 10 });
    let pending: SupervisorQualificationPending | undefined;
    try { await sy!.submitTasks([{ ...task, budget: { maxModelRequests: 8, maxPaidUsd: 1 } }]); } catch (error) { pending = error as SupervisorQualificationPending; }
    expect(pending).toBeInstanceOf(SupervisorQualificationPending);
    sy!.catalog.setOverride("openrouter/vendor/big-a:free", { forceStatus: "disabled" });
    await sy!.close();
    const client = new ScriptedClient(req => reply(null, { model: req.model, provider: req.provider, toolCalls: [{ id: "decision", type: "function", function: { name: "record_decisions", arguments: JSON.stringify(decisions) } }] }));
    sy = new MeritRouter(env!.cfg, { worker: true, pollIntervalMs: 30, providerFetch: client.fetch });
    let outcome;
    try { outcome = await sy.resumeSupervisorSubmission(pending!.submissionRef, "demo"); } catch (error) {
      expect(error).toBeInstanceOf(SupervisorQualificationPending);
      for (const id of (error as SupervisorQualificationPending).runIds) await waitFinished(id);
      outcome = await sy.resumeSupervisorSubmission(pending!.submissionRef, "demo");
    }
    expect(outcome![0]!.taskId).toBeTruthy(); expect(client.requests.some(request => request.provider === "acme")).toBe(true);
  }, 30000);

  it("fails an abandoned preparing run whose model was disabled, then continues grading later runs", async () => {
    create();
    const first = await sy!.supervisorQualifier.start("openrouter/vendor/big-a:free");
    const store = sy!.projectStores("_qualification"), raw = store.db.prepare("SELECT detail_json FROM qualification_runs WHERE id=?").get(first.runId) as { detail_json: string };
    const detail = JSON.parse(raw.detail_json); sy!.cancelTasks([detail.taskId], "_qualification");
    store.db.prepare("DELETE FROM qualification_tasks WHERE run_id=?").run(first.runId);
    detail.taskId = "t_abandoned_preparing"; detail.preparingUntil = Date.now() - 1;
    store.db.prepare("UPDATE qualification_runs SET status='preparing',started_at=?,detail_json=? WHERE id=?").run(Date.now() + 100, JSON.stringify(detail), first.runId);
    sy!.catalog.saveProviderDiscovery([ModelEndpointSchema.parse(endpoint({ gatewayModelId: "vendor/second:free" }))], ["openrouter/vendor/second:free"]);
    const second = await sy!.supervisorQualifier.start("openrouter/vendor/second:free");
    sy!.catalog.setOverride("openrouter/vendor/big-a:free", { forceStatus: "disabled" });
    await sy!.close();
    sy = new MeritRouter(env!.cfg, { worker: true, pollIntervalMs: 30, providerFetch: new ScriptedClient(req => reply(null, { model: req.model, provider: req.provider, toolCalls: [{ id: "decision", type: "function", function: { name: "record_decisions", arguments: JSON.stringify(decisions) } }] })).fetch });
    expect(await waitFinished(second.runId)).toBe("finished");
    expect(sy.projectStores("_qualification").db.prepare("SELECT status FROM qualification_runs WHERE id=?").get(first.runId)).toEqual({ status: "failed" });
    expect(sy.db.prepare("SELECT value FROM meta WHERE key=?").get(`supervisor-evidence:${first.runId}`)).toBeUndefined();
    expect(sy.db.prepare("SELECT value FROM meta WHERE key=?").get(`supervisor-evidence:${second.runId}`)).toBeTruthy();
  }, 30000);

  it("does not spend paid evaluation authority when a capable free candidate is available", async () => {
    const client = create(true, false, decisions, { supervisor: { paid_policy: "on_free_exhaustion", routing: { minimum_quality: "ranked_capable" } },
      paid: { enabled: true, tiers: { T1: "never", T2: "never", T3: "never" }, budgets: { per_day_usd: 2 },
        providers: { acme: { kind: "openai_compatible", base_url: "https://acme.test/v1" } },
        models: [{ provider: "acme", model: "model", context_limit_tokens: 64000, output_limit_tokens: 8000, supports_tools: true, ignore_size_floor: true, input_usd_per_million: 2, output_usd_per_million: 8 }] } });
    sy!.vault.add({ provider: "acme", secret: "fake-test-key", label: "credits", billingClass: "paid_credits", prepaidBalanceUsd: 10 });
    await sy!.submitTasks([{ ...task, budget: { maxModelRequests: 8, maxPaidUsd: 1 } }]);
    expect(client.requests.filter(request => request.provider === "acme")).toHaveLength(0);
    expect(sy!.projectStores("_qualification").db.prepare("SELECT COUNT(*) n FROM qualification_runs WHERE endpoint_id='paid:acme/model'").get()).toEqual({ n: 0 });
  }, 30000);
});
