import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { GatewayError } from "../src/core/errors.js";
import type { MeritRouter } from "../src/core/service.js";
import type { ProjectRuntimeBundle } from "../src/projects/runtime-registry.js";
import { ProjectRequestStore } from "../src/admission/project-request-store.js";
import { requestAttemptId } from "../src/admission/request-ledger.js";
import { capturedLease } from "../src/storage/task-leases.js";
import { baseConfig, endpoint, goodOutput, makeEnv, open, reply, ScriptedClient, summarizeTask, testProviders, type Env } from "./helpers.js";

const services: MeritRouter[] = [], envs: Env[] = [], dirs: string[] = [];
afterEach(async () => {
  await Promise.allSettled(services.splice(0).map(sy => sy.close()));
  for (const env of envs.splice(0)) env.cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 60_000);

function projectRepo(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "meritrouter-test-project-"))); dirs.push(dir);
  writeFileSync(path.join(dir, "README.md"), "# fixture\n");
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "init"]]) execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd: dir, stdio: "pipe" });
  return dir;
}

/** A split installation with one project and a one-slot provider limit, served through the real Gate. */
async function split(client: ScriptedClient, providers?: Record<string, unknown>) {
  const repo = projectRepo();
  const env = makeEnv({ config: baseConfig({ storage: { directory: ".meritrouter", layout: "split" }, repositories: {}, brain: { path: "brain", project: "alpha" },
    ...(providers ? { providers } : {}), team: { provider_concurrency_start: 1, provider_concurrency_max: 1 }, projects: { alpha: { directory: repo, repositories: { app: { path: repo } } } } }) }); envs.push(env);
  const sy = open(env, client, { worker: true }); services.push(sy);
  expect(sy.layout).toBe("split");
  await sy.createSplitProject({ slug: "alpha", directory: repo });
  return sy;
}
const requestSlots = (sy: MeritRouter) => sy.db.prepare("SELECT COUNT(*) FROM provider_slots WHERE kind='request'").pluck().get() as number;
const answer = (req: { model: string; provider: string }) => reply(JSON.stringify(goodOutput()), { model: req.model, provider: req.provider });
async function until(check: () => boolean, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error("condition not reached"); await new Promise(resolve => setTimeout(resolve, 50)); }
}
const physical = (sy: MeritRouter) => sy.db.prepare("SELECT status,outcome,error_code FROM physical_requests ORDER BY reserved_at,id").all() as Array<{ status: string; outcome: string | null; error_code: string | null }>;

it.each([
  // Possibly-consumed failures settle uncertain (no refund); a definite 4xx refusal settles failed.
  ["timeout", () => new GatewayError("timeout", "fixture provider timed out", 408), "uncertain"],
  ["provider error", () => new GatewayError("server", "fixture provider unavailable", 502), "uncertain"],
  ["client error", () => new GatewayError("bad_request", "fixture provider rejected the request", 400), "failed"],
] as const)("a live owner releases its split slot after a %s and a later request still gets capacity", async (_label, failure, outcome) => {
  let failing = true;
  const client = new ScriptedClient(req => { if (failing) throw failure(); return answer(req); });
  const sy = await split(client);
  const [first] = await sy.submitTasks([summarizeTask({ goal: "Summarise the fixture" })], { project: "alpha" });
  // The first physical request reaches a terminal non-success receipt.
  await until(() => physical(sy).some(row => row.status === "settled"));
  expect(physical(sy).every(row => row.status === "settled" && row.outcome !== "succeeded")).toBe(true);
  // Its live owner frees the slot as part of normal settlement: nothing leaks.
  await until(() => requestSlots(sy) === 0, 10_000);
  failing = false;
  // With one slot per provider, a later request is served only if no hold leaked.
  const [second] = await sy.submitTasks([summarizeTask({ goal: "Summarise the fixture again" })], { project: "alpha" });
  const later = await sy.awaitResults([second!.taskId], { timeoutSeconds: 90 });
  expect(later.completed).toHaveLength(1);
  expect(sy.getStatus([second!.taskId], "alpha")[0]).toMatchObject({ state: "completed" });
  await sy.awaitResults([first!.taskId], { timeoutSeconds: 90 });
  expect(requestSlots(sy)).toBe(0);
  // Accounting is unchanged by the release: every non-success receipt keeps its terminal outcome.
  expect(physical(sy).filter(row => row.outcome !== "succeeded").every(row => row.status === "settled" && row.outcome === outcome)).toBe(true);
}, 150_000);

it("a key-level refusal retries on the next key with its own split slot and leaks nothing", async () => {
  const client = new ScriptedClient((req, n) => { if (n === 1) throw new GatewayError("rate_limited", "fixture key rate limited", 429); return answer(req); });
  const sy = await split(client, { ...testProviders(), openrouter: { keys: [1, 2].map(k => ({ label: `openrouter key ${k}`, api_key: `test-openrouter-key-${k}`, billing_class: "free_tier" })) } });
  const [task] = await sy.submitTasks([summarizeTask({ goal: "Summarise the fixture" })], { project: "alpha" });
  const done = await sy.awaitResults([task!.taskId], { timeoutSeconds: 60 });
  expect(done.completed).toHaveLength(1);
  expect(sy.getStatus([task!.taskId], "alpha")[0]).toMatchObject({ state: "completed" });
  expect(client.requests.slice(0, 2).map(req => req.key)).toEqual(["test-openrouter-key-1", "test-openrouter-key-2"]);
  expect(physical(sy).map(row => row.outcome)).toEqual(["failed", ...physical(sy).slice(1).map(() => "succeeded")]);
  expect(physical(sy)[0]).toMatchObject({ status: "settled", error_code: "rate_limited" });
  expect(requestSlots(sy)).toBe(0);
}, 120_000);

it("a restarted worker settles a durable local outcome left before broker settlement exactly once and frees its slot", async () => {
  const repo = projectRepo();
  const env = makeEnv({ endpoints: [endpoint()], config: baseConfig({ storage: { directory: ".meritrouter", layout: "split" }, repositories: {}, brain: { path: "brain", project: "alpha" },
    team: { provider_concurrency_start: 1, provider_concurrency_max: 1 }, execution: { max_concurrent_tasks: 4, lease_seconds: 10 }, projects: { alpha: { directory: repo, repositories: { app: { path: repo } } } } }) }); envs.push(env);
  const client = new ScriptedClient(req => answer(req));
  const crashed = open(env, client, { worker: false });
  await crashed.createSplitProject({ slug: "alpha", directory: repo });
  const bundle = crashed.projectStores("alpha") as ProjectRuntimeBundle, owner = `${hostname()}:2147483000:abcdef`, now = Date.now();
  const [task] = await crashed.submitTasks([summarizeTask()], { project: "alpha" }), id = task!.taskId;
  bundle.db.prepare("UPDATE tasks SET state='running',lease_owner=?,lease_expires_at=?,deadline_at=?,run_count=1 WHERE id=?").run(owner, now + 600000, now + 600000, id);
  const lease = capturedLease(bundle.tasks.get(id)!), executionId = bundle.admission.createExecution("task", "summarize", [{ taskId: id, itemId: "1" }]);
  crashed.db.prepare("INSERT INTO provider_slots(id,platform,kind,holder,task_id,lease_owner,priority,since,seen_at,lease_json,nonce,project_uuid,store_uuid,store_generation,execution_grants_json) VALUES('crash-slot','openrouter','request','split_holder',?,?,0,?,?,?,'crash-nonce',?,?,?,?)")
    .run(id, owner, now, now, JSON.stringify([lease]), bundle.identity.projectId, bundle.identity.storeId, bundle.identity.generation, JSON.stringify([{ grantId: "33333333-3333-4333-8333-333333333333", nonce: "44444444-4444-4444-8444-444444444444" }]));
  const reservation = await bundle.ledger.reserve({ requestId: requestAttemptId(), payloadDigest: "a".repeat(64), keyRef: "", providerReservationId: null, executionId, profile: "summarize", purpose: "test", gatewayModel: `direct:${endpoint().id}`, endpointId: endpoint().id, tier: "T1", estInputTokens: 100, reservedOutputTokens: 30, slot: { id: "crash-slot", nonce: "crash-nonce" },
    participants: [{ taskId: id, leaseOwner: owner, lease, budget: { maxModelRequests: 4, maxInputTokens: null, maxOutputTokens: null, maxPaidUsd: null }, estInputTokens: 100, reservedOutputTokens: 30 }] });
  await bundle.ledger.beginDispatch(reservation, "crash-dispatch"); bundle.ledger.assertDispatch(reservation, "crash-dispatch");
  // The provider answered and the outcome became durable locally; the process died before the broker settlement.
  const store = new ProjectRequestStore(bundle.db, bundle.identity, () => Date.now());
  store.transaction(() => store.saveOutcome(store.bound(reservation), { kind: "succeeded", servedEndpointId: endpoint().id, response: reply("durable outcome", { usage: { inputTokens: 80, outputTokens: 20 } }) }));
  bundle.db.prepare("UPDATE tasks SET lease_expires_at=? WHERE id=?").run(now - 1, id);
  expect(crashed.db.prepare("SELECT status FROM physical_requests WHERE id=?").pluck().get(reservation.requestId)).toBe("dispatch_intent");
  await crashed.close(); services.splice(services.indexOf(crashed), 1);

  const restarted = open(env, client, { worker: true }); services.push(restarted);
  await until(() => restarted.db.prepare("SELECT status FROM physical_requests WHERE id=?").pluck().get(reservation.requestId) === "settled", 30_000);
  const local = restarted.projectStores("alpha");
  await until(() => local.db.prepare("SELECT phase FROM project_request_protocol WHERE request_id=?").pluck().get(reservation.requestId) === "settled", 15_000);
  await until(() => restarted.db.prepare("SELECT COUNT(*) FROM provider_slots WHERE id='crash-slot'").pluck().get() === 0, 15_000);
  const evidence = () => ({
    physical: restarted.db.prepare("SELECT status,outcome,input_tokens,output_tokens,outcome_digest,accounting_outcome_sha256,finished_at FROM physical_requests WHERE id=?").get(reservation.requestId),
    model: local.db.prepare("SELECT status,input_tokens,output_tokens,finished_at FROM model_requests WHERE id=?").get(reservation.requestId),
    charges: local.db.prepare("SELECT task_id,input_tokens,output_tokens,tokens_exact FROM request_charges WHERE request_id=?").all(reservation.requestId),
    protocol: local.db.prepare("SELECT phase,outcome_digest,global_receipt_json FROM project_request_protocol WHERE request_id=?").get(reservation.requestId),
  });
  const first = evidence();
  expect(first.physical).toMatchObject({ status: "settled", outcome: "succeeded", input_tokens: 80, output_tokens: 20 });
  expect(first.model).toMatchObject({ status: "succeeded", input_tokens: 80, output_tokens: 20 });
  expect(first.charges).toEqual([{ task_id: id, input_tokens: 80, output_tokens: 20, tokens_exact: 1 }]);
  // Exactly once: a further recovery pass changes nothing.
  await (restarted as unknown as { host: { recoverSettlements(): Promise<string[]> } }).host.recoverSettlements();
  expect(evidence()).toEqual(first);
  expect(restarted.db.prepare("SELECT COUNT(*) FROM physical_requests WHERE id=?").pluck().get(reservation.requestId)).toBe(1);
}, 120_000);
