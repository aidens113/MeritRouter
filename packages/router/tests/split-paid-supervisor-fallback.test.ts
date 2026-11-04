import { afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MeritRouter } from "../src/core/service.js";
import type { ProjectRuntimeHost } from "../src/core/project-runtime-host.js";
import type { GateRequest } from "../src/gateway/gate.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { capturedLease } from "../src/storage/task-leases.js";
import { ProviderError } from "../src/providers/errors.js";
import { retireProjectStoreRegistration } from "../src/projects/store-identity.js";
import { baseConfig, makeEnv, open, reply, ScriptedClient } from "./helpers.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const fn of cleanup.splice(0).reverse()) await fn(); }, 60000);
const PAID = "paid:acme/frontier-fixture", FREE = "openrouter/vendor/big-a:free";
async function fixture(options: { free?: boolean; failure?: boolean; paid?: boolean; taskCap?: number; globalCap?: number; projectCap?: number; keyCap?: number; policy?: "never" | "on_free_exhaustion"; delay?: () => Promise<void> } = {}) {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "meritrouter-paid-fallback-")));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  for (const args of [["init", "-qb", "main"], ["commit", "--allow-empty", "-qm", "initial"]]) execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: directory, stdio: "pipe" });
  const now = Date.now();
  const evidence = [FREE, PAID].map(endpointId => ({ schemaVersion: 1, endpointId, source: "synthetic explicit fixture benchmark; not production qualification", checkedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 3600000).toISOString(), classification: "frontier", confidence: .99, trials: 20, scores: { planning: .99, architecture: .99, supervision: .99, integration: .99, review: .99, product: .99, visual: .99 } }));
  const env = makeEnv({ config: baseConfig({ storage: { directory: ".meritrouter", layout: "split" }, repositories: {}, brain: { path: "brain", project: "alpha" },
    projects: { alpha: { directory, repositories: { app: { path: directory } }, ...(options.projectCap !== undefined ? { paid_budgets: { per_day_usd: options.projectCap } } : {}) } },
    supervisor: { routing: { minimum_quality: "frontier_or_qualified_supervisor", quality_evidence: evidence } },
    paid: { enabled: options.paid ?? true, budgets: { per_day_usd: options.globalCap ?? 10 }, tiers: { T1: "on_free_exhaustion", T2: "on_free_exhaustion", T3: "on_free_exhaustion" },
      providers: { acme: { kind: "openai_compatible", base_url: "https://acme.test/v1" } },
      models: [{ provider: "acme", model: "frontier-fixture", input_usd_per_million: 2, output_usd_per_million: 8, context_limit_tokens: 100000, output_limit_tokens: 8000, supports_tools: true, ignore_size_floor: true }] },
    profiles: { ...baseConfig().profiles, supervise: { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100, classify: "never", max_model_requests: 4 } } }) });
  cleanup.push(() => env.cleanup());
  const calls: string[] = [];
  const client = new ScriptedClient(async req => {
    calls.push(req.provider);
    if (req.provider === "acme") await options.delay?.();
    if (req.provider === "acme" && options.failure) throw new ProviderError("timeout", "fixture timeout", { provider: "acme", possiblyConsumed: true });
    return { ...reply("fixture answer", { model: req.model, provider: req.provider }), usage: { inputTokens: 20, outputTokens: 10, cachedInputTokens: null, reasoningTokens: null, reportedCostUsd: null, basis: "provider_reported" } };
  });
  const sy = open(env, client, { worker: false }); cleanup.push(() => sy.db.open ? sy.close() : undefined);
  const key = sy.vault.add({ provider: "acme", label: "fixture credits", secret: "fake-fixture-secret", billingClass: "paid_credits", prepaidBalanceUsd: 10, monthlyCapUsd: options.keyCap === 0 ? .000001 : options.keyCap ?? 10 });
  await sy.createSplitProject({ slug: "alpha", directory });
  const host = (sy as unknown as { host: ProjectRuntimeHost }).host;
  const local = host.bundle("alpha");
  const spec = WorkerTaskSchema.parse({ id: "supervisor", profile: "supervise", goal: "Fixture supervisor", repositoryAliases: ["app"], constraints: { acceptanceCriteria: ["fixture"] }, budget: { maxModelRequests: 4, maxPaidUsd: options.taskCap ?? 1 } });
  local.tasks.submit([spec], { project: "alpha" });
  const queue = host.bindings.forProject(local.identity), hint = queue.hint()!;
  const claimed = await queue.claimTurn({ owner: "fixture-owner" }, [hint]); expect(claimed).toHaveLength(1); expect(queue.authorizeStart(claimed)).toBe("fresh");
  const lease = capturedLease(local.tasks.get(spec.id!)!);
  const executionId = local.admission.createExecution("task", "supervise", [{ taskId: "supervisor", itemId: "supervisor" }]);
  const plan = local.router.plan("supervise", "T3", ["text"], undefined, false, options.policy ?? "on_free_exhaustion");
  plan.candidates = plan.candidates.filter(ep => ep.id === PAID || options.free && ep.id === FREE);
  const request: GateRequest = { executionId, purpose: "fixture supervisor", plan, participants: [{ taskId: "supervisor", leaseOwner: "fixture-owner", lease, budget: { maxModelRequests: 4, maxInputTokens: null, maxOutputTokens: null, maxPaidUsd: options.taskCap ?? 1 } }], chat: { messages: [{ role: "user", content: "Private synthetic supervisor fixture" }], max_tokens: 100 } };
  return { sy, host, local, request, calls, key, env };
}

it("activates split credit authority with exactly one dispatch and isolated settlement", async () => {
  const f = await fixture();
  const result = await f.local.gate.request(f.request);
  expect(f.calls).toEqual(["acme"]);
  expect(f.host.broker.readReceipt(result.requestId)).toMatchObject({ state: "settled", outcome: "succeeded", actualUsd: .00012 });
  expect(f.sy.db.prepare("SELECT COUNT(*) FROM broker_paid_spend").pluck().get()).toBe(1);
  expect(f.sy.db.prepare("SELECT COUNT(*) FROM tasks").pluck().get()).toBe(0);
  expect(f.local.admission.taskTotals("supervisor").requests).toBe(1);
  expect(f.local.db.prepare("SELECT COUNT(*) FROM project_request_spend").pluck().get()).toBe(1);
  expect(f.sy.db.prepare("SELECT COUNT(*) FROM paid_spend").pluck().get()).toBe(0);
  await f.local.ledger.recover(result.requestId); await f.local.ledger.recover(result.requestId);
  expect(f.calls).toEqual(["acme"]); expect(f.local.admission.taskTotals("supervisor").requests).toBe(1);
});

it.each(["disabled", "revoked", "provider_revoked", "balance_exhausted", "generation_retired", "unknown_search_price", "unknown_price", "increased_price"] as const)("rechecks live authority before dispatch: %s", async change => {
  const f = await fixture();
  if (change === "disabled") f.sy.vault.update(f.key.id, { enabled: false });
  else {
    const reserve = f.host.broker.reserveGlobal.bind(f.host.broker);
    vi.spyOn(f.host.broker, "reserveGlobal").mockImplementation(input => {
      const result = reserve(input);
      if (change === "revoked") f.sy.vault.remove(f.key.id);
      else if (change === "provider_revoked") f.sy.providers.keys.recordFailure(input.keyRef!, new ProviderError("auth_invalid", "fixture key revoked", { provider: "acme" }));
      else if (change === "balance_exhausted") f.sy.vault.update(f.key.id, { prepaidBalanceUsd: 0 });
      else if (change === "generation_retired") retireProjectStoreRegistration(f.sy.db, f.local.identity);
      else if (change === "unknown_search_price") f.sy.catalog.setOverride(PAID, { nativeWebSearch: { via: "always_on", usdPerSearch: null } });
      else {
        const get = f.sy.catalog.get.bind(f.sy.catalog);
        vi.spyOn(f.sy.catalog, "get").mockImplementation(id => {
          const ep = get(id); return ep && id === PAID ? { ...ep, pricing: { ...ep.pricing, inputUsdPerMillion: change === "unknown_price" ? null : 2000 } } : ep;
        });
      }
      return result;
    });
  }
  try { await expect(f.local.gate.request(f.request)).rejects.toThrow(); }
  finally {
    // Restore only the deliberately retired temporary fixture registration so service drain
    // can project its definitely-unsent receipt and close its database normally.
    if (change === "generation_retired") f.sy.db.prepare("UPDATE project_store_registrations SET state='registered',retired_at=NULL WHERE project_uuid=?").run(f.local.identity.projectId);
  }
  expect(f.calls).toEqual([]);
  expect(f.sy.db.prepare("SELECT COUNT(*) FROM physical_requests WHERE dispatch_id IS NOT NULL").pluck().get()).toBe(0);
});

it("preserves one union liability across newer balance snapshots, then counts settlement and replay once", async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture({ delay: () => pending });
  const first = f.local.gate.request(f.request);
  try {
    const until = Date.now() + 10000;
    while (!f.calls.length && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
    expect(f.calls).toEqual(["acme"]);
    const held = f.sy.db.prepare("SELECT request_id,reserved_usd FROM broker_paid_spend").get() as { request_id: string; reserved_usd: number };
    await new Promise(resolve => setTimeout(resolve, 5));
    f.sy.vault.update(f.key.id, { prepaidBalanceUsd: .001 });
    const credential = f.sy.providers.credentials().get(`vault:${f.key.id}`)!;
    const key = () => f.sy.spend.spendKey(credential)!;
    expect(f.sy.spend.keyHeadroom(key())).toBeCloseTo(.001 - held.reserved_usd, 8);
    // A legacy projection of that same physical request cannot double the exposure.
    f.sy.db.prepare("INSERT INTO executions(id,kind,profile,status,created_at) VALUES('imported-fixture','task','supervise','running',?)").run(Date.now());
    f.sy.db.prepare("INSERT INTO model_requests(id,execution_id,purpose,gateway_model,status,reserved_at,est_input_tokens,reserved_output_tokens,project_id) VALUES(?,'imported-fixture','imported-fixture','frontier-fixture','reserved',?,18,100,'alpha')").run(held.request_id, Date.now());
    f.sy.spend.record(held.request_id, credential.ref, "acme", PAID, held.reserved_usd);
    expect(f.sy.spend.keyHeadroom(key())).toBeCloseTo(.001 - held.reserved_usd, 8);
    f.sy.vault.update(f.key.id, { prepaidBalanceUsd: .0001 });
    expect(f.sy.spend.keyHeadroom(key())).toBeLessThan(0);
    f.sy.vault.update(f.key.id, { prepaidBalanceUsd: .001 });
  } finally { release(); }
  const result = await first;
  // Settle the fixture's intentional legacy projection with the exact same outcome.
  f.sy.spend.settle(result.requestId, .00012, "computed");
  const credential = f.sy.providers.credentials().get(`vault:${f.key.id}`)!;
  expect(f.sy.spend.keyHeadroom(f.sy.spend.spendKey(credential)!)).toBeCloseTo(.001 - .00012, 8);
  await f.local.ledger.recover(result.requestId); await f.local.ledger.recover(result.requestId);
  expect(f.sy.spend.keyHeadroom(f.sy.spend.spendKey(credential)!)).toBeCloseTo(.001 - .00012, 8);
  await new Promise(resolve => setTimeout(resolve, 5));
  f.sy.vault.update(f.key.id, { prepaidBalanceUsd: .002 });
  expect(f.sy.spend.keyHeadroom(f.sy.spend.spendKey(credential)!)).toBeCloseTo(.002, 8);
});

it("retains uncertain paid liability and settlement across replay and service reopen", async () => {
  const f = await fixture({ failure: true });
  await expect(f.local.gate.request(f.request)).rejects.toThrow();
  expect(f.calls).toEqual(["acme"]);
  const before = f.sy.db.prepare("SELECT * FROM broker_paid_spend").all();
  expect(before).toHaveLength(1);
  expect(before[0]).toMatchObject({ actual_usd: null, cost_basis: "uncertain" });
  const requestId = f.sy.db.prepare("SELECT id FROM physical_requests").pluck().get() as string;
  expect(f.host.broker.readReceipt(requestId)).toMatchObject({ state: "settled", outcome: "uncertain" });
  await f.local.ledger.recover(requestId); await f.local.ledger.recover(requestId);
  await f.sy.close();
  const reopened = open(f.env, new ScriptedClient(() => { throw new Error("reopen must not dispatch"); }), { worker: false }); cleanup.push(() => reopened.close());
  const host = (reopened as unknown as { host: ProjectRuntimeHost }).host;
  await host.recoverSettlements();
  expect(reopened.db.prepare("SELECT * FROM broker_paid_spend").all()).toEqual(before);
  expect(host.broker.readReceipt(requestId)).toMatchObject({ outcome: "uncertain", state: "settled" });
});

it("serializes the last key budget across competing physical reservations", async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture({ keyCap: .001, delay: () => pending });
  const first = f.local.gate.request(f.request);
  try {
    const until = Date.now() + 10000;
    while (!f.calls.length && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
    expect(f.calls).toEqual(["acme"]);
    await expect(f.local.gate.request(f.request)).rejects.toThrow(); expect(f.calls).toHaveLength(1);
  } finally { release(); await first; }
  expect(f.sy.db.prepare("SELECT COUNT(*) FROM broker_paid_spend").pluck().get()).toBe(1);
});

it("serves capable free without paid transport and falls back when free is explicitly unavailable", async () => {
  const f = await fixture({ free: true });
  await f.local.gate.request(f.request); expect(f.calls).toEqual(["openrouter"]);
  const credential = f.sy.providers.credentials().list("openrouter")[0]!;
  f.sy.providers.keys.recordFailure(credential, new ProviderError("not_in_plan", "fixture free model unavailable on key", { provider: "openrouter" }), "vendor/big-a:free");
  await f.local.gate.request(f.request); expect(f.calls).toEqual(["openrouter", "acme"]);
});

it.each([{ paid: false }, { policy: "never" as const }, { taskCap: 0 }, { globalCap: 0 }, { projectCap: 0 }, { keyCap: 0 }])("refuses forbidden or exhausted credit routing without transport %j", async options => {
  const f = await fixture(options);
  await expect(f.local.gate.request(f.request)).rejects.toThrow(); expect(f.calls).toEqual([]);
});
