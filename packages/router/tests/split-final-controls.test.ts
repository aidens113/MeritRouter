import { afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../src/mcp/tools.js";
import { ProductDeliveries } from "../src/verification/product-delivery.js";
import { currentProductCandidate } from "../src/verification/product-candidate.js";
import { deliverySpecDigest, productDigest } from "../src/verification/product-spec.js";
import { productCandidateDigest } from "../src/verification/product-evidence.js";
import * as journey from "../src/labs/browser-journey-current.js";
import { baseConfig, FakeProvider, makeEnv, open } from "./helpers.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const fn of cleanup.splice(0).reverse()) await fn(); }, 60000);
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd, stdio: "pipe" }).toString().trim();
async function fixture() {
  const projects = Object.fromEntries(["alpha", "beta"].map(slug => {
    const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "meritrouter-final-")));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    git(directory, "init", "-qb", "main"); git(directory, "commit", "--allow-empty", "-qm", "initial");
    return [slug, { directory, repositories: { app: { path: directory } }, lab: {} }];
  }));
  const cfg = baseConfig({ storage: { directory: ".meritrouter", layout: "split" }, repositories: {}, brain: { path: "brain", project: "alpha" }, projects });
  const env = makeEnv({ config: cfg }); cleanup.push(() => env.cleanup());
  const sy = open(env, new FakeProvider(), { worker: false }); cleanup.push(() => sy.close());
  for (const [slug, project] of Object.entries(projects)) await sy.createSplitProject({ slug, directory: project.directory });
  const goal = "Observe fixture product";
  const spec = { schemaVersion: 1, id: "fixture", revision: 1, source: { ref: "fixture", digest: productDigest(goal) }, originalInstruction: goal, ownerId: "initiator", users: ["operator"], platforms: ["node"], workflows: ["observe"], dataInvariants: [], interfaceContracts: [], visualRequirements: [], failureStates: [], securityRequirements: [], exclusions: [], setupRecipeRefs: [], criteria: [{ id: "runtime", priority: "required", behavior: "Fixture works", applicability: { status: "applicable" }, requiredEvidence: ["structural"] }] };
  const seed = async (project: string, id = "same-job", lab?: string) => {
    const stores = sy.projectStores(project), dir = projects[project]!.directory;
    stores.tasks.submit([{ id, profile: "supervise", goal, repositoryAliases: ["app"], context: {}, supervisionScope: "subtask", constraints: { acceptanceCriteria: ["Fixture works"] }, ...(lab ? { lab } : {}) }], { project });
    const recorder = stores.sessions!.create({ taskId: id, role: "supervisor", agentLabel: `supervisor:${id}`, profile: "supervise" });
    recorder.setWorkspace({ repos: [{ alias: "app", worktree: dir, branch: "main", baseCommit: null, head: null }] }); recorder.end("completed", "fixture");
    const store = new ProductDeliveries(stores.db); store.saveSpec(id, project, spec);
    const candidate = await currentProductCandidate({ spec: stores.tasks.get(id)!.spec, signal: AbortSignal.timeout(10000) }, [{ alias: "app", worktree: dir }]);
    store.setCandidate(id, project, candidate);
    stores.db.prepare("UPDATE tasks SET state='completed' WHERE id=?").run(id);
    return { stores, store, dir, expected: { expectedSpecDigest: deliverySpecDigest(store.status(id, project)!.spec), expectedCandidateDigest: productCandidateDigest(candidate) } };
  };
  const alpha = await seed("alpha"), beta = await seed("beta");
  const server = buildMcpServer({ sy, cfg: env.cfg, project: "alpha" });
  const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st);
  const client = new Client({ name: "fixture-final", version: "1" }); await client.connect(ct);
  cleanup.push(async () => { await client.close(); await server.close(); });
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: { taskId: "same-job", ...args } });
  const observe = (project = "beta") => call("record_delivery_observation", { project, ...beta.expected, criterionIds: ["runtime"], kind: "structural", outcome: "pass", artifactRefs: ["fixture:independent-check"], observations: ["Independently observed fixture"] });
  const decide = (project = "beta", decision = "accept") => call("decide_delivery", { project, ...beta.expected, decision, reason: "Independent exact candidate review" });
  return { sy, alpha, beta, seed, call, observe, decide, spec };
}
const error = (result: unknown, pattern: RegExp) => { expect(result).toMatchObject({ isError: true }); expect(JSON.stringify(result)).toMatch(pattern); };

it("routes all FINAL tools to explicit project despite duplicate IDs, preserving actor and other store", async () => {
  const f = await fixture();
  const original = f.alpha.store.status("same-job", "alpha");
  vi.spyOn(f.alpha.stores.contracts, "get").mockReturnValue({ contract: { verification: { acceptance: "supervisor", strictAcceptor: "human" } } } as ReturnType<typeof f.alpha.stores.contracts.get>);
  expect((await f.call("delivery_status", { project: "beta" })).isError).toBeFalsy();
  expect((await f.observe()).isError).toBeFalsy();
  expect(f.beta.store.status("same-job", "beta")!.evidence[0]).toMatchObject({ actor: { id: "mcp:fixture-final", role: "initiator" }, basis: "observed" });
  f.beta.stores.db.prepare("UPDATE product_deliveries SET stage='handoff' WHERE task_id=?").run("same-job");
  expect((await f.decide()).isError).toBeFalsy();
  expect(f.beta.store.status("same-job", "beta")!.accepted).toBe(true);
  expect(f.alpha.store.status("same-job", "alpha")).toEqual(original);
  expect((await f.decide("beta", "reject")).isError).toBeFalsy();
  expect(f.beta.store.status("same-job", "beta")!.stage).toBe("validate");
  expect((await f.call("delivery_status")).isError).toBeFalsy();
  expect((f.sy.db.prepare("SELECT COUNT(*) AS n FROM product_deliveries").get() as { n: number }).n).toBe(0);
});

it("refuses stale source/spec observations and decisions and dirty or absent workspace", async () => {
  const f = await fixture();
  git(f.beta.dir, "commit", "--allow-empty", "-qm", "new candidate");
  error(await f.observe(), /delivery_candidate_conflict/); error(await f.decide(), /delivery_candidate_conflict/);
  const state = f.beta.store.status("same-job", "beta")!;
  f.beta.expected.expectedCandidateDigest = productCandidateDigest(state.candidate!);
  f.beta.store.saveSpec("same-job", "beta", { ...f.spec, revision: 2 }, f.beta.expected.expectedSpecDigest);
  f.beta.store.setCandidate("same-job", "beta", state.candidate!);
  error(await f.observe(), /delivery_candidate_conflict/); error(await f.decide(), /delivery_candidate_conflict/);
  writeFileSync(path.join(f.beta.dir, "dirty.txt"), "unreviewed");
  error(await f.call("delivery_status", { project: "beta" }), /clean committed/);
  rmSync(path.join(f.beta.dir, "dirty.txt"));
  f.beta.stores.db.prepare("UPDATE sessions SET workspace_json=NULL WHERE task_id=?").run("same-job");
  error(await f.call("delivery_status", { project: "beta" }), /current integration workspace/);
  expect(f.beta.store.status("same-job", "beta")!.evidence).toHaveLength(0);
});

it("preserves evidence, handoff, terminal descendants and human-only acceptance gates", async () => {
  const f = await fixture();
  error(await f.decide(), /unresolved evidence/);
  expect((await f.observe()).isError).toBeFalsy();
  error(await f.decide(), /completed delivery at handoff/);
  f.beta.stores.db.prepare("UPDATE product_deliveries SET stage='handoff' WHERE task_id=?").run("same-job");
  f.beta.stores.tasks.submit([{ id: "active-child", profile: "inspect", parentTaskId: "same-job", goal: "Inspect fixture", repositoryAliases: ["app"], context: {}, constraints: { acceptanceCriteria: ["reports fixture"] } }], { project: "beta" });
  error(await f.decide(), /delegated work to be terminal/);
  f.beta.stores.db.prepare("UPDATE tasks SET state='completed' WHERE id='active-child'").run();
  const get = vi.spyOn(f.beta.stores.contracts, "get").mockReturnValue({ contract: { verification: { acceptance: "supervisor", strictAcceptor: "human" } } } as ReturnType<typeof f.beta.stores.contracts.get>);
  error(await f.decide(), /human_acceptance_required/); expect(get).toHaveBeenCalledWith("same-job");
  expect(f.beta.store.status("same-job", "beta")!.finalDecision).toBeNull();
});

it("fails closed for unknown, foreign and unavailable stores without installation fallback", async () => {
  const f = await fixture();
  await f.seed("alpha", "only-alpha");
  error(await f.call("delivery_status", { project: "unknown" }), /unknown|Unknown/);
  const original = f.sy.projectStores.bind(f.sy);
  for (const name of ["delivery_status", "record_delivery_observation", "decide_delivery"]) {
    const args = name === "record_delivery_observation" ? { criterionIds: ["runtime"], kind: "structural", outcome: "pass", artifactRefs: ["fixture"], observations: ["fixture"] } : name === "decide_delivery" ? { decision: "accept", reason: "fixture" } : {};
    error(await f.call(name, { project: "beta", taskId: "only-alpha", ...f.beta.expected, ...args }), /unknown delivery/);
  }
  vi.spyOn(f.sy, "projectStores").mockImplementation(project => { if (project === "beta") throw new Error("fixture project unavailable"); return original(project); });
  for (const name of ["delivery_status", "record_delivery_observation", "decide_delivery"]) {
    const args = name === "record_delivery_observation" ? { criterionIds: ["runtime"], kind: "structural", outcome: "pass", artifactRefs: ["fixture"], observations: ["fixture"] } : name === "decide_delivery" ? { decision: "accept", reason: "fixture" } : {};
    error(await f.call(name, { project: "beta", ...f.beta.expected, ...args }), /fixture project unavailable/);
  }
});

it("refreshes all three tools through the real project-local Lab manager and current journey resolver", async () => {
  const f = await fixture();
  const manager = f.sy.labsFor("beta");
  expect(manager).not.toBe(f.sy.labs);
  await manager.create("beta", "fixture");
  f.beta.stores.db.prepare("UPDATE tasks SET spec_json=json_set(spec_json,'$.lab','fixture') WHERE id=?").run("same-job");
  const refresh = vi.spyOn(journey, "resolveCurrentJourneyCandidate");
  const installationStatus = vi.spyOn(f.sy.labs, "status").mockImplementation(() => { throw new Error("installation Lab access forbidden"); });
  expect((await f.call("delivery_status", { project: "beta" })).isError).toBeFalsy();
  expect((await f.observe()).isError).toBeFalsy();
  expect((await f.decide("beta", "reject")).isError).toBeFalsy();
  expect(refresh).toHaveBeenCalledTimes(3);
  for (const [actualManager, lab, digest] of refresh.mock.calls) {
    expect(actualManager).toBe(manager); expect(lab).toMatchObject({ project: "beta", name: "fixture" });
    expect(digest).toBe(f.beta.expected.expectedSpecDigest);
  }
  expect(installationStatus).not.toHaveBeenCalled();
});
