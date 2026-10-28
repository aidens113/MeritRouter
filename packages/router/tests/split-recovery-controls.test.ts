import { afterEach, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MeritRouter } from "../src/core/service.js";
import type { ProjectRuntimeHost } from "../src/core/project-runtime-host.js";
import { readStoreIdentity } from "../src/projects/store-identity.js";
import { SqliteTaskLeases } from "../src/storage/sqlite-task-leases.js";
import { capturedLease } from "../src/storage/task-leases.js";
import { baseConfig, goodOutput, makeEnv, open, reply, ScriptedClient, type Env } from "./helpers.js";

const services: MeritRouter[] = [], environments: Env[] = [], directories: string[] = [];
const releases: Array<() => void> = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.allSettled(services.splice(0).map(service => service.close()));
  vi.restoreAllMocks();
  for (const environment of environments.splice(0)) environment.cleanup();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
}, 60_000);
const track = (service: MeritRouter) => { services.push(service); return service; };
const hostOf = (service: MeritRouter) => (service as unknown as { host: ProjectRuntimeHost }).host;
const schedulerOf = (service: MeritRouter) => hostOf(service).scheduler;
async function close(service: MeritRouter) { services.splice(services.indexOf(service), 1); await service.close(); }
async function fixture(slugs = ["alpha", "beta"]) {
  const projects = Object.fromEntries(slugs.map(slug => {
    const directory = realpathSync(mkdtempSync(path.join(tmpdir(), `meritrouter-recovery-${slug}-`)));
    directories.push(directory);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: directory, stdio: "pipe" });
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "init"], { cwd: directory, stdio: "pipe" });
    return [slug, { directory, repositories: { app: { path: directory } } }];
  }));
  const env = makeEnv({ config: baseConfig({ storage: { directory: ".meritrouter", layout: "split" }, repositories: {}, brain: { path: "brain", project: "alpha" }, projects }) });
  environments.push(env);
  const sy = track(open(env, new ScriptedClient(() => reply("unused"))));
  for (const [slug, project] of Object.entries(projects)) await sy.createSplitProject({ slug, directory: project.directory });
  return { env, sy };
}
async function seed(sy: MeritRouter, project: string, id: string, expired: boolean, interruptedSession = true) {
  await sy.submitTasks([{ id, profile: "inspect", goal: "Report the supplied fixture", repositoryAliases: ["app"], context: { inlineText: "fixture input" }, constraints: { acceptanceCriteria: ["reports input"] } }], { project });
  const local = sy.projectStores(project), now = Date.now();
  const identity = readStoreIdentity(local.db);
  if (identity?.role !== "project") throw new Error("Fixture requires an explicit project store");
  const queue = hostOf(sy).bindings.forProject(identity), hint = queue.hint();
  if (!hint) throw new Error("Fixture task has no fair claim hint");
  const claimed = await queue.claimTurn({ owner: `fixture-owner-${project}` }, [hint]);
  expect(claimed).toHaveLength(1);
  expect(queue.authorizeStart(claimed)).toBe("fresh");
  const task = local.tasks.get(id)!;
  const grantId = queue.refsForRequest([capturedLease(task)])[0]!.grantId;
  expect(hostOf(sy).grants.read(grantId)!.state).toBe("active");
  const rec = local.sessions!.create({ taskId: id, role: "inspector", agentLabel: `inspector:${id}`, profile: "inspect", tier: "T1" });
  rec.syncMessages([{ role: "system", content: "Fixture inspector" }, { role: "user", content: "Report fixture input" }]);
  rec.note("retained before restart");
  if (interruptedSession) rec.end("interrupted", "lease lost");
  // Durable prior usage must survive recovery; no provider transport was used to seed it.
  const execution = `old-execution-${id}`, request = `old-request-${id}`;
  local.db.prepare("INSERT INTO executions(id,kind,profile,status,created_at) VALUES (?,'task','inspect','completed',?)").run(execution, now);
  local.db.prepare("INSERT INTO execution_members(execution_id,task_id,item_id) VALUES (?,?,?)").run(execution, id, id);
  local.db.prepare("INSERT INTO model_requests(id,execution_id,purpose,gateway_model,status,reserved_at,est_input_tokens,reserved_output_tokens,project_id) VALUES (?,?,'runner','openrouter/vendor/big-a:free','succeeded',?,1,1,?)").run(request, execution, now, project);
  local.db.prepare("INSERT INTO request_charges(request_id,task_id,input_tokens,output_tokens) VALUES (?,?,1,1)").run(request, id);
  if (expired) local.db.prepare("UPDATE tasks SET lease_expires_at=? WHERE id=?").run(now - 1, id);
  return { id, sessionId: rec.id, deadline: task.row.deadline_at, incarnation: task.row.lease_incarnation, request, grantId };
}
function cli(env: Env, id: string, project = "alpha") {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|MERITROUTER/i.test(key)));
  return spawnSync(process.execPath, [path.resolve("dist/cli.js"), "resume", id, "--project", project, "--config", env.cfg.configPath, "--json"], { encoding: "utf8", env: clean, timeout: 30_000, windowsHide: true });
}

it("recovers an expired running split task with an interrupted session even when no project has queued work", async () => {
  const { env, sy: initial } = await fixture();
  const expired = await seed(initial, "alpha", "t_expired", true);
  const live = await seed(initial, "beta", "t_live", false, false);
  expect(() => initial.resumeSession(expired.sessionId, "alpha")).toThrow(/start a worker to reconcile/);
  expect(initial.projectStores("alpha").tasks.get(expired.id)!.row.state).toBe("running");
  await close(initial);
  const reopened = track(open(env, new ScriptedClient(() => reply("unused"))));
  expect(hostOf(reopened).grants.read(expired.grantId)!.state).toBe("active");
  expect(reopened.projectStores("alpha").tasks.get(expired.id)!.row.state).toBe("running");
  await close(reopened);
  const client = new ScriptedClient(() => reply(null, { toolCalls: [{ id: "submit", type: "function", function: { name: "submit_result", arguments: JSON.stringify(goodOutput(1, "inline")) } }] }));
  const worker = track(open(env, client, { worker: true, pollIntervalMs: 25 }));
  const done = await worker.awaitResults([expired.id], { timeoutSeconds: 12, project: "alpha" });
  expect(done.timedOut, JSON.stringify(worker.getStatus([expired.id], "alpha"))).toBe(false);
  expect(done.completed).toHaveLength(1);
  expect(client.requests).toHaveLength(1);
  const alpha = worker.projectStores("alpha"), beta = worker.projectStores("beta");
  expect(alpha.sessions!.forTask(expired.id).map(session => session.id)).toEqual([expired.sessionId]);
  expect(alpha.sessions!.get(expired.sessionId)!.status).toBe("completed");
  expect(alpha.tasks.get(expired.id)!.row.deadline_at).toBe(expired.deadline);
  expect(alpha.tasks.get(expired.id)!.row.lease_incarnation).toBe(expired.incarnation);
  expect(alpha.tasks.get(expired.id)!.row.run_count).toBe(2);
  expect(hostOf(worker).bundle("alpha").admission.taskTotals(expired.id).requests).toBe(2);
  expect(alpha.db.prepare("SELECT status FROM model_requests WHERE id=?").get(expired.request)).toEqual({ status: "succeeded" });
  expect(hostOf(worker).grants.read(expired.grantId)!.state).toBe("revoked");
  expect(alpha.db.prepare("SELECT phase,terminal_state FROM project_execution_claims WHERE grant_id=?").get(expired.grantId)).toEqual({ phase: "terminal", terminal_state: "revoked" });
  expect(beta.tasks.get(live.id)!.row).toMatchObject({ state: "running", run_count: 1, lease_owner: "fixture-owner-beta" });
  expect(beta.sessions!.get(live.sessionId)!.status).toBe("running");
  expect(hostOf(worker).grants.read(live.grantId)!.state).toBe("active");
  expect(worker.db.prepare("SELECT COUNT(*) n FROM tasks").get()).toEqual({ n: 0 });
}, 60_000);

it("retries startup lease recovery before any fair claim or provider transport", async () => {
  const { env, sy: initial } = await fixture(["alpha"]);
  const expired = await seed(initial, "alpha", "t_recovery_retry", true);
  await close(initial);
  const original = SqliteTaskLeases.prototype.recover;
  const observations: string[] = [];
  let failures = 2;
  vi.spyOn(SqliteTaskLeases.prototype, "recover").mockImplementation(function (this: SqliteTaskLeases, input) {
    if (failures-- > 0) { observations.push("recovery refused"); return Promise.reject(new Error("fixture recovery unavailable")); }
    observations.push(`recovery ${input.mode}`);
    return original.call(this, input);
  });
  const client = new ScriptedClient(() => {
    observations.push("transport");
    return reply(null, { toolCalls: [{ id: "submit", type: "function", function: { name: "submit_result", arguments: JSON.stringify(goodOutput(1, "inline")) } }] });
  });
  const worker = track(open(env, client, { worker: true, pollIntervalMs: 25 }));
  const done = await worker.awaitResults([expired.id], { timeoutSeconds: 15, project: "alpha" });
  expect(done.timedOut, JSON.stringify(observations)).toBe(false);
  expect(client.requests).toHaveLength(1);
  expect(observations.slice(0, 3)).toEqual(["recovery refused", "recovery refused", "recovery startup"]);
  expect(observations.indexOf("transport")).toBeGreaterThan(observations.indexOf("recovery startup"));
  expect(worker.projectStores("alpha").tasks.get(expired.id)!.row.run_count).toBe(2);
}, 60_000);

it.each(["session", "task-prefix"])("CLI resumes a split %s from its owning store without installation private reads", async form => {
  const { env, sy } = await fixture();
  const target = await seed(sy, "alpha", form === "task-prefix" ? "s_task_identifier" : "t_cli", false);
  const local = sy.projectStores("alpha");
  local.tasks.interrupt(target.id, "fixture-owner-alpha", "fixture interrupted");
  const before = local.tasks.get(target.id)!;
  const result = cli(env, form === "session" ? target.sessionId : target.id);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ taskId: target.id, state: "queued", ...(form === "session" ? { sessionId: target.sessionId } : {}) });
  expect(local.tasks.get(target.id)!.row).toMatchObject({ state: "queued", deadline_at: before.row.deadline_at, run_count: before.row.run_count, lease_incarnation: before.row.lease_incarnation });
  expect(hostOf(sy).bundle("alpha").admission.taskTotals(target.id).requests).toBe(1);
  expect(local.sessions!.get(target.sessionId)!.status).toBe("interrupted");
  const foreign = cli(env, form === "session" ? target.sessionId : target.id, "beta");
  expect(foreign.status).toBe(1);
  expect(foreign.stderr).toMatch(/unknown (session|task)/);
  expect(foreign.stderr).not.toMatch(/explicit project store/);
}, 60_000);

it("requires project selection for a session/task ID shared across split projects", async () => {
  const { sy } = await fixture();
  const alpha = await seed(sy, "alpha", "t_collision", false);
  const beta = await seed(sy, "beta", alpha.sessionId, false);
  sy.projectStores("alpha").tasks.interrupt(alpha.id, "fixture-owner-alpha", "fixture interrupted");
  sy.projectStores("beta").tasks.interrupt(beta.id, "fixture-owner-beta", "fixture interrupted");
  expect(() => sy.resumeTarget(alpha.sessionId)).toThrow(/exists in several projects/);
  expect(sy.projectStores("alpha").tasks.get(alpha.id)!.row.state).toBe("interrupted");
  expect(sy.projectStores("beta").tasks.get(beta.id)!.row.state).toBe("interrupted");
  expect(sy.resumeTarget(alpha.sessionId, "beta")).toEqual({ taskId: beta.id, state: "queued" });
  expect(sy.resumeTarget(alpha.sessionId, "alpha")).toEqual({ taskId: alpha.id, sessionId: alpha.sessionId, state: "queued" });
});

it("does not initialize another project when stopped during awaited first-project startup", async () => {
  const { sy } = await fixture();
  const original = SqliteTaskLeases.prototype.recover;
  let entered!: () => void, release!: () => void, calls = 0;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  releases.push(release);
  vi.spyOn(SqliteTaskLeases.prototype, "recover").mockImplementation(function (this: SqliteTaskLeases, input) {
    calls++;
    if (calls !== 1) return original.call(this, input);
    entered();
    return blocked.then(() => original.call(this, input));
  });
  const scheduler = schedulerOf(sy);
  scheduler.start(25);
  await started;
  const stopping = scheduler.stop();
  release();
  await stopping;
  expect(calls).toBe(1);
  expect(scheduler.busy).toBe(0);
});

it("initializes project recovery again after stop and start on the same scheduler", async () => {
  const { sy } = await fixture(["alpha"]);
  const original = SqliteTaskLeases.prototype.recover;
  let startups = 0;
  vi.spyOn(SqliteTaskLeases.prototype, "recover").mockImplementation(function (this: SqliteTaskLeases, input) {
    if (input.mode === "startup") startups++;
    return original.call(this, input);
  });
  const scheduler = schedulerOf(sy);
  scheduler.start(25);
  await scheduler.tick();
  await scheduler.stop();
  expect(startups).toBe(1);
  scheduler.start(25);
  await scheduler.tick();
  await scheduler.stop();
  expect(startups).toBe(2);
});
