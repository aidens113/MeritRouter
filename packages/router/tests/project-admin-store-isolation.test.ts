import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { baseConfig, makeEnv, open, reply, ScriptedClient, type Env } from "./helpers.js";
import type { MeritRouter } from "../src/core/service.js";
import { openDatabase, type Db } from "../src/storage/db.js";
import { TaskStore } from "../src/storage/tasks.js";
import { ArtifactStore } from "../src/storage/artifacts.js";
import { SessionStore } from "../src/sessions/store.js";
import { ContractStore } from "../src/verification/contract.js";
import { createProjectRuntimeStore, type ProjectRuntimeStore } from "../src/projects/runtime-store.js";
import { MeritRouterError } from "../src/core/errors.js";
import { scopedSessionTimeline } from "../src/admin/session-project-scope.js";
import { requestEvidence } from "../src/admin/request-evidence.js";
import { budgetRequestsView } from "../src/admin/budget.js";
import { jobsView } from "../src/admin/jobs.js";
import { teamMetrics } from "../src/admin/job-metrics.js";
import { activeJobs, tasksByState } from "../src/admin/dashboards.js";
import { taskRelated } from "../src/admin/entities.js";
import { modelsView, overview, qualificationBoard, requestLog, requestLogCount, tierDistribution, timeseries } from "../src/admin/insights.js";
import { sessionsView } from "../src/admin/sessions.js";
import { labsListView } from "../src/admin/labs.js";

/**
 * Proves the admin views converted in gate 1 wave A (S7) read a project's own store
 * (`sy.projectStores(slug)`), never the installation database directly and never another
 * project's rows, by giving each configured project a genuinely SEPARATE physical sqlite
 * database (not today's same-handle transitional wrapper) and replacing `sy.projectStores` on
 * the test instance to route to them. A canary row lives only in its project's own shadow store;
 * an installation decoy with the same id/project lives only in `sy.db`. A view that reads the
 * right store returns the canary and never the decoy; a view that (bug) fell through to `sy.db`
 * would return the decoy, or nothing at all for an id/project that genuinely only exists in the
 * shadow. `broken`, a third configured project, throws from `projectStores` to exercise the
 * "unavailable project" reporting path.
 *
 * Structure: one shared fixture builder (`buildFixture`) below, then one `describe` per admin
 * module, so a later worker can append `insights.ts` cases as another `describe` block without
 * touching the fixture.
 */

interface Shadow {
  project: string;
  db: Db;
  stores: ProjectRuntimeStore;
}

const dirs: string[] = [];
const dbs: Db[] = [];

function tempDir(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `meritrouter-shadow-${label}-`));
  dirs.push(dir);
  return dir;
}

/** A project's own, genuinely separate store: its own `openDatabase`, wrapped exactly as `runtime-store.ts`'s transitional `createProjectRuntimeStore` wraps the installation's same-DB handle. */
function openShadow(project: string, storageDir: string): Shadow {
  const db = openDatabase(tempDir(project));
  dbs.push(db);
  const now = () => Date.now();
  const stores = createProjectRuntimeStore(project, {
    db,
    tasks: new TaskStore(db, now),
    artifacts: new ArtifactStore(db, storageDir, now),
    sessions: new SessionStore(db, storageDir, now),
    contracts: new ContractStore(db),
  });
  return { project, db, stores };
}

interface Fixture {
  env: Env;
  sy: MeritRouter;
  alpha: Shadow;
  beta: Shadow;
  cleanup: () => Promise<void>;
}

/**
 * A MeritRouter configured with three projects (alpha, beta, broken). alpha and beta each get a
 * real separate shadow store; `broken`'s `projectStores` throws. Session logs still share the
 * installation's own `storageDir` (file-level project isolation is not this wave's scope; only
 * the SQL tables this brief converts are split here), so a shadow's `SessionStore` is built
 * against that same directory while reading and writing its own, separate database.
 */
function buildFixture(): Fixture {
  const env = makeEnv({
    config: baseConfig({
      repositories: {},
      brain: { project: "alpha", path: "brain" },
      projects: {
        alpha: { repositories: { core: { path: "repo" } } },
        beta: { repositories: { core: { path: "repo" } } },
        broken: { repositories: { core: { path: "repo" } } },
      },
    }),
  });
  const sy = open(env, new ScriptedClient(() => reply("{}")));
  const alpha = openShadow("alpha", env.cfg.storageDir);
  const beta = openShadow("beta", env.cfg.storageDir);
  const original = sy.projectStores.bind(sy);
  sy.projectStores = (project: string): ProjectRuntimeStore => {
    if (project === "alpha") return alpha.stores;
    if (project === "beta") return beta.stores;
    if (project === "broken") throw new MeritRouterError("store_unavailable", "shadow store deliberately unavailable for this test");
    return original(project);
  };
  const cleanup = async () => {
    await sy.close();
    alpha.db.close();
    beta.db.close();
    env.cleanup();
  };
  return { env, sy, alpha, beta, cleanup };
}

/** A minimal, valid task row directly in `shadow`'s own db (never `sy.db`). */
function canaryTask(shadow: Shadow, opts: { id: string; profile?: string; label: string; goal: string }): string {
  const outcome = shadow.stores.tasks.submit(
    [{ id: opts.id, profile: opts.profile ?? "summarize", label: opts.label, goal: opts.goal, context: { inlineText: "canary" }, constraints: {} } as never],
    { project: shadow.project },
  );
  return outcome[0]!.taskId;
}

let fixtures: Fixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.cleanup();
  for (const db of dbs.splice(0)) try { db.close(); } catch { /* already closed */ }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(): Fixture {
  const f = buildFixture();
  fixtures.push(f);
  return f;
}

describe("project store isolation: session-project-scope (A4a)", () => {
  it("reads a session that exists only in its project's own store, not sy.db", () => {
    const f = fixture();
    const taskId = canaryTask(f.alpha, { id: "task-alpha-session", label: "alpha", goal: "alpha canary session owner" });
    const rec = f.alpha.stores.sessions!.create({ taskId, role: "implementer", agentLabel: "canary:alpha" });
    f.alpha.db.prepare("UPDATE sessions SET project_id = ? WHERE id = ?").run("alpha", rec.id);
    // Confirm the canary session, and its decoy, are each where this test put them and nowhere else.
    expect(f.sy.db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(rec.id)).toBeUndefined();
    expect(f.beta.db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(rec.id)).toBeUndefined();
    const events = scopedSessionTimeline(f.sy, rec.id, "alpha");
    expect(events).not.toBeNull();
    expect(events!.length).toBeGreaterThan(0);
    // The same session id asked under the wrong project (never looked up in sy.db) is refused.
    expect(scopedSessionTimeline(f.sy, rec.id, "beta")).toBeNull();
  });

  it("reports a session unavailable (not a crash) when its project's store cannot be opened", () => {
    const f = fixture();
    expect(scopedSessionTimeline(f.sy, "whatever", "broken")).toBeNull();
  });
});

describe("project store isolation: request-evidence (A4a)", () => {
  function insertRequest(shadow: Shadow, id: string, taskId: string) {
    shadow.db
      .prepare(
        "INSERT INTO executions(id,kind,profile,status,created_at) VALUES (?, 'task','summarize','completed',1)",
      )
      .run(`exec-${id}`);
    shadow.db
      .prepare(
        `INSERT INTO model_requests(id,execution_id,purpose,gateway_model,status,reserved_at,est_input_tokens,reserved_output_tokens,project_id)
         VALUES (?, ?, 'classification', 'fake/model', 'succeeded', 1, 10, 10, ?)`,
      )
      .run(id, `exec-${id}`, shadow.project);
    shadow.db.prepare("INSERT INTO request_charges(request_id,task_id,input_tokens,output_tokens) VALUES (?,?,1,1)").run(id, taskId);
  }

  it("finds a request only in its own project's store, by the same id in two different projects, each with its own related task", () => {
    const f = fixture();
    const alphaTask = canaryTask(f.alpha, { id: "req-evidence-alpha-task", label: "a", goal: "a" });
    const betaTask = canaryTask(f.beta, { id: "req-evidence-beta-task", label: "b", goal: "b" });
    insertRequest(f.alpha, "req-shared-canary", alphaTask);
    insertRequest(f.beta, "req-shared-canary", betaTask);
    const a = requestEvidence(f.sy, "alpha", "req-shared-canary");
    const b = requestEvidence(f.sy, "beta", "req-shared-canary");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.relatedTasks.map((t) => t.taskId)).toEqual(["req-evidence-alpha-task"]);
    expect(b!.relatedTasks.map((t) => t.taskId)).toEqual(["req-evidence-beta-task"]);
    // Neither project's answer carries the other project's related task.
    expect(a!.relatedTasks.map((t) => t.taskId)).not.toContain("req-evidence-beta-task");
  });

  it("never shows a row that exists only in sy.db under the same id", () => {
    const f = fixture();
    f.sy.db
      .prepare("INSERT INTO executions(id,kind,profile,status,created_at) VALUES ('exec-decoy','task','summarize','completed',1)")
      .run();
    f.sy.db
      .prepare(
        `INSERT INTO model_requests(id,execution_id,purpose,gateway_model,status,reserved_at,est_input_tokens,reserved_output_tokens,project_id)
         VALUES ('req-installation-decoy','exec-decoy','classification','fake/model','succeeded',1,10,10,'alpha')`,
      )
      .run();
    // The id exists, charged to 'alpha', in sy.db; it must never surface through alpha's own store.
    expect(requestEvidence(f.sy, "alpha", "req-installation-decoy")).toBeNull();
  });
});

describe("project store isolation: budget (A4a)", () => {
  function insertBudgetRequest(shadow: Shadow, taskId: string, reason: string) {
    shadow.db
      .prepare(
        `INSERT INTO budget_requests(task_id,job_id,project_id,role,requests,reason,used,cap,approver,status,granted,created_at)
         VALUES (?, NULL, ?, 'implementer', 5, ?, 0, 5, 'supervisor', 'pending', 0, 1)`,
      )
      .run(taskId, shadow.project, reason);
  }

  it("lists a project's own budget requests, with the task label read from that project's own store", () => {
    const f = fixture();
    const alphaTask = canaryTask(f.alpha, { id: "task-alpha-budget", label: "alpha-budget-task", goal: "alpha" });
    const betaTask = canaryTask(f.beta, { id: "task-beta-budget", label: "beta-budget-task", goal: "beta" });
    insertBudgetRequest(f.alpha, alphaTask, "ALPHA CANARY BUDGET REASON");
    insertBudgetRequest(f.beta, betaTask, "BETA CANARY BUDGET REASON");
    // An installation decoy charged to 'alpha' that must never be shown by the project-scoped view.
    f.sy.db
      .prepare(
        `INSERT INTO budget_requests(task_id,job_id,project_id,role,requests,reason,used,cap,approver,status,granted,created_at)
         VALUES (?, NULL, 'alpha', 'implementer', 5, 'INSTALLATION DECOY - should never appear', 0, 5, 'supervisor', 'pending', 0, 1)`,
      )
      .run(alphaTask);

    const alphaView = budgetRequestsView(f.sy, { project: "alpha" });
    expect(alphaView.map((r) => r.reason)).toEqual(["ALPHA CANARY BUDGET REASON"]);
    expect(alphaView[0]!.label).toBe("alpha-budget-task");
    expect(alphaView.map((r) => r.reason)).not.toContain("BETA CANARY BUDGET REASON");
    expect(alphaView.map((r) => r.reason)).not.toContain("INSTALLATION DECOY - should never appear");

    const betaView = budgetRequestsView(f.sy, { project: "beta" });
    expect(betaView.map((r) => r.reason)).toEqual(["BETA CANARY BUDGET REASON"]);
  });

  it("merges every project when none is given, and reports 'broken' unavailable without failing", () => {
    const f = fixture();
    const alphaTask = canaryTask(f.alpha, { id: "task-alpha-budget-all", label: "a", goal: "a" });
    const betaTask = canaryTask(f.beta, { id: "task-beta-budget-all", label: "b", goal: "b" });
    insertBudgetRequest(f.alpha, alphaTask, "ALPHA ALL-SCOPE CANARY");
    insertBudgetRequest(f.beta, betaTask, "BETA ALL-SCOPE CANARY");
    const all = budgetRequestsView(f.sy);
    expect(all.map((r) => r.reason)).toEqual(expect.arrayContaining(["ALPHA ALL-SCOPE CANARY", "BETA ALL-SCOPE CANARY"]));
    expect(all.unavailable).toEqual(expect.arrayContaining([expect.objectContaining({ project: "broken" })]));
  });
});

describe("project store isolation: jobs (A4a)", () => {
  it("lists a supervise task only from its own project's store", () => {
    const f = fixture();
    canaryTask(f.alpha, { id: "job-alpha-canary", profile: "supervise", label: "alpha-job", goal: "ALPHA CANARY JOB" });
    canaryTask(f.beta, { id: "job-beta-canary", profile: "supervise", label: "beta-job", goal: "BETA CANARY JOB" });
    // An installation decoy supervise task that must never be shown as 'alpha's.
    f.sy.db
      .prepare(
        `INSERT INTO tasks(id,spec_hash,profile,spec_json,state,created_at,updated_at,project_id)
         VALUES ('job-installation-decoy','h','supervise',?,'queued',1,1,'alpha')`,
      )
      .run(JSON.stringify({ profile: "supervise", label: "decoy", goal: "INSTALLATION DECOY - should never appear" }));

    const alphaJobs = jobsView(f.sy, 50, "alpha");
    expect(alphaJobs.map((j) => j.goal)).toEqual(["ALPHA CANARY JOB"]);
    expect(alphaJobs.map((j) => j.goal)).not.toContain("INSTALLATION DECOY - should never appear");

    const all = jobsView(f.sy, 50);
    expect(all.map((j) => j.goal)).toEqual(expect.arrayContaining(["ALPHA CANARY JOB", "BETA CANARY JOB"]));
    expect(all.unavailable).toEqual(expect.arrayContaining([expect.objectContaining({ project: "broken" })]));
  });
});

describe("project store isolation: dashboards (owned)", () => {
  it("activeJobs reads a project's own supervise tasks, never sy.db's, and merges across projects", () => {
    const f = fixture();
    canaryTask(f.alpha, { id: "active-alpha", profile: "supervise", label: "a", goal: "ALPHA ACTIVE CANARY" });
    canaryTask(f.beta, { id: "active-beta", profile: "supervise", label: "b", goal: "BETA ACTIVE CANARY" });
    f.alpha.db.prepare("UPDATE tasks SET state = 'running' WHERE id = ?").run("active-alpha");
    f.beta.db.prepare("UPDATE tasks SET state = 'running' WHERE id = ?").run("active-beta");
    f.sy.db
      .prepare(
        `INSERT INTO tasks(id,spec_hash,profile,spec_json,state,created_at,updated_at,project_id)
         VALUES ('active-installation-decoy','h','supervise',?,'running',1,1,'alpha')`,
      )
      .run(JSON.stringify({ profile: "supervise", goal: "INSTALLATION DECOY - should never appear" }));

    const alphaOnly = activeJobs(f.sy, "alpha");
    expect(alphaOnly.map((j) => j.goal)).toEqual(["ALPHA ACTIVE CANARY"]);

    const all = activeJobs(f.sy);
    expect(all.map((j) => j.goal)).toEqual(expect.arrayContaining(["ALPHA ACTIVE CANARY", "BETA ACTIVE CANARY"]));
    expect(all.map((j) => j.goal)).not.toContain("INSTALLATION DECOY - should never appear");
  });

  it("tasksByState counts a project's own store only, and sums correctly without one when it can", () => {
    const f = fixture();
    canaryTask(f.alpha, { id: "state-alpha-1", label: "a1", goal: "a1" });
    canaryTask(f.alpha, { id: "state-alpha-2", label: "a2", goal: "a2" });
    canaryTask(f.beta, { id: "state-beta-1", label: "b1", goal: "b1" });
    f.sy.db
      .prepare(
        `INSERT INTO tasks(id,spec_hash,profile,spec_json,state,created_at,updated_at,project_id)
         VALUES ('state-installation-decoy','h','summarize','{}','queued',1,1,'alpha')`,
      )
      .run();
    expect(tasksByState(f.sy, "alpha")).toEqual({ queued: 2 });
    expect(tasksByState(f.sy, "beta")).toEqual({ queued: 1 });
  });
});

describe("project store isolation: sessions (split-admin-reads)", () => {
  it("sessionsView reads each project's own sessions store, never sy.db's decoy, and merges with 'broken' unavailable", () => {
    const f = fixture();
    const alphaTask = canaryTask(f.alpha, { id: "sess-alpha-task", label: "a", goal: "a" });
    const betaTask = canaryTask(f.beta, { id: "sess-beta-task", label: "b", goal: "b" });
    const alphaRec = f.alpha.stores.sessions!.create({ taskId: alphaTask, role: "implementer", agentLabel: "canary:alpha" });
    f.alpha.db.prepare("UPDATE sessions SET project_id = ? WHERE id = ?").run("alpha", alphaRec.id);
    const betaRec = f.beta.stores.sessions!.create({ taskId: betaTask, role: "implementer", agentLabel: "canary:beta" });
    f.beta.db.prepare("UPDATE sessions SET project_id = ? WHERE id = ?").run("beta", betaRec.id);
    // An installation decoy, charged to 'alpha' in sy.db, that must never surface through alpha's view.
    const decoy = f.sy.sessions.create({ taskId: null, role: "implementer", agentLabel: "decoy" });
    f.sy.db.prepare("UPDATE sessions SET project_id = ? WHERE id = ?").run("alpha", decoy.id);

    const alphaView = sessionsView(f.sy, { project: "alpha" });
    expect(alphaView.map((s) => s.id)).toContain(alphaRec.id);
    expect(alphaView.map((s) => s.id)).not.toContain(decoy.id);
    expect(alphaView.map((s) => s.id)).not.toContain(betaRec.id);
    expect(alphaView.unavailable).toEqual([]);

    const all = sessionsView(f.sy);
    expect(all.map((s) => s.id)).toEqual(expect.arrayContaining([alphaRec.id, betaRec.id]));
    expect(all.map((s) => s.id)).not.toContain(decoy.id);
    expect(all.unavailable).toEqual(expect.arrayContaining([expect.objectContaining({ project: "broken" })]));
  });
});

describe("project store isolation: labs (split-admin-reads)", () => {
  it("labsListView reports 'broken' unavailable with a marker instead of throwing", () => {
    const f = fixture();
    const view = labsListView(f.sy, "broken");
    expect(view.labs).toEqual([]);
    expect(view.unavailableProjects).toEqual(expect.arrayContaining([expect.objectContaining({ project: "broken" })]));
  });
});

describe("project store isolation: entities (owned)", () => {
  it("taskRelated finds a task that exists only in its project's own store", async () => {
    const f = fixture();
    const taskId = canaryTask(f.alpha, { id: "related-alpha-canary", label: "alpha-related", goal: "ALPHA RELATED CANARY" });
    const related = await taskRelated(f.sy, taskId);
    expect(related).not.toBeNull();
    expect(related!.sessions).toBe(0);
    // Nothing of this id exists in sy.db at all; a bug that fell through to it would find nothing.
    expect(f.sy.db.prepare("SELECT 1 FROM tasks WHERE id = ?").get(taskId)).toBeUndefined();
  });
});

describe("project store isolation: insights (A4b)", () => {
  let execN = 0;
  function insertModelRequest(db: Db, opts: { id: string; endpointId: string; reservedAt: number; finishedAt: number | null; inputTokens: number; outputTokens: number; project: string }) {
    const execId = `exec-${opts.id}-${execN++}`;
    db.prepare("INSERT INTO executions(id,kind,profile,status,created_at) VALUES (?, 'task','summarize','completed',1)").run(execId);
    db.prepare(
      `INSERT INTO model_requests(id,execution_id,purpose,gateway_model,status,reserved_at,finished_at,est_input_tokens,reserved_output_tokens,endpoint_id,input_tokens,output_tokens,project_id)
       VALUES (?,?,'execution','auto:x','succeeded',?,?,10,10,?,?,?,?)`,
    ).run(opts.id, execId, opts.reservedAt, opts.finishedAt, opts.endpointId, opts.inputTokens, opts.outputTokens, opts.project);
  }
  const ENDPOINT = "openrouter/vendor/big-a:free";

  it("overview's tasksByState sums each project's own store, never sy.db's decoy", async () => {
    const f = fixture();
    canaryTask(f.alpha, { id: "ov-alpha-1", label: "a1", goal: "a1" });
    canaryTask(f.alpha, { id: "ov-alpha-2", label: "a2", goal: "a2" });
    canaryTask(f.beta, { id: "ov-beta-1", label: "b1", goal: "b1" });
    // An installation decoy charged to 'alpha' with a state that must never be counted.
    f.sy.db
      .prepare(
        `INSERT INTO tasks(id,spec_hash,profile,spec_json,state,created_at,updated_at,project_id)
         VALUES ('ov-installation-decoy','h','summarize','{}','completed',1,1,'alpha')`,
      )
      .run();
    const ov = await overview(f.sy);
    expect(ov.tasksByState.queued).toBe(3);
    expect(ov.tasksByState.completed).toBeUndefined();
  });

  it("modelsView's endpoint stats merge each project's own requests, recomputing the average latency from the merged sum (never averaging averages), excluding sy.db's decoy", async () => {
    const f = fixture();
    // endpointStats filters to the last 7 days; use timestamps relative to now, not the epoch.
    const now = Date.now();
    insertModelRequest(f.alpha.db, { id: "stat-alpha", endpointId: ENDPOINT, reservedAt: now - 10_000, finishedAt: now - 9_995, inputTokens: 10, outputTokens: 20, project: "alpha" });
    insertModelRequest(f.beta.db, { id: "stat-beta", endpointId: ENDPOINT, reservedAt: now - 5_000, finishedAt: now - 4_985, inputTokens: 5, outputTokens: 5, project: "beta" });
    // An installation decoy charged to 'alpha' with a wildly different latency and token count.
    insertModelRequest(f.sy.db, { id: "stat-installation-decoy", endpointId: ENDPOINT, reservedAt: now - 20_000, finishedAt: now + 80_000, inputTokens: 999, outputTokens: 999, project: "alpha" });
    const view = modelsView(f.sy).find((v) => v.endpoint.id === ENDPOINT)!;
    expect(view).toBeDefined();
    expect(view.stats7d).toMatchObject({ requests: 2, inputTokens: 15, outputTokens: 25, avgLatencyMs: 10, lastUsedAt: now - 5_000 });
  });

  it("requestLog/requestLogCount merge and re-paginate newest-first across two separate project stores, excluding sy.db's decoy", () => {
    const f = fixture();
    insertModelRequest(f.alpha.db, { id: "rl-alpha-1", endpointId: ENDPOINT, reservedAt: 100, finishedAt: null, inputTokens: 1, outputTokens: 1, project: "alpha" });
    insertModelRequest(f.alpha.db, { id: "rl-alpha-2", endpointId: ENDPOINT, reservedAt: 300, finishedAt: null, inputTokens: 1, outputTokens: 1, project: "alpha" });
    insertModelRequest(f.beta.db, { id: "rl-beta-1", endpointId: ENDPOINT, reservedAt: 200, finishedAt: null, inputTokens: 1, outputTokens: 1, project: "beta" });
    insertModelRequest(f.beta.db, { id: "rl-beta-2", endpointId: ENDPOINT, reservedAt: 400, finishedAt: null, inputTokens: 1, outputTokens: 1, project: "beta" });
    insertModelRequest(f.sy.db, { id: "rl-installation-decoy", endpointId: ENDPOINT, reservedAt: 9999, finishedAt: null, inputTokens: 1, outputTokens: 1, project: "alpha" });
    expect(requestLogCount(f.sy)).toBe(4);
    expect(requestLog(f.sy, { limit: 2 }).map((r) => r.id)).toEqual(["rl-beta-2", "rl-alpha-2"]);
    expect(requestLog(f.sy, { limit: 2, offset: 2 }).map((r) => r.id)).toEqual(["rl-beta-1", "rl-alpha-1"]);
  });

  it("timeseries merges each project's own bucket, excluding sy.db's decoy", () => {
    const f = fixture();
    const anchor = Math.floor(Date.now() / 3_600_000) * 3_600_000 + 1000;
    insertModelRequest(f.alpha.db, { id: "ts-alpha", endpointId: ENDPOINT, reservedAt: anchor, finishedAt: null, inputTokens: 10, outputTokens: 10, project: "alpha" });
    insertModelRequest(f.beta.db, { id: "ts-beta", endpointId: ENDPOINT, reservedAt: anchor + 500, finishedAt: null, inputTokens: 20, outputTokens: 20, project: "beta" });
    insertModelRequest(f.sy.db, { id: "ts-installation-decoy", endpointId: ENDPOINT, reservedAt: anchor + 100, finishedAt: null, inputTokens: 999, outputTokens: 999, project: "alpha" });
    const points = timeseries(f.sy, { hours: 24 }).filter((p) => p.endpointId === ENDPOINT);
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ requests: 2, inputTokens: 30, outputTokens: 30 });
  });

  it("tierDistribution sums each project's own tasks, excluding sy.db's decoy", () => {
    const f = fixture();
    const alphaTask = canaryTask(f.alpha, { id: "tier-alpha", label: "a", goal: "a" });
    const betaTask = canaryTask(f.beta, { id: "tier-beta", label: "b", goal: "b" });
    f.alpha.db.prepare("UPDATE tasks SET tier = 'T1' WHERE id = ?").run(alphaTask);
    f.beta.db.prepare("UPDATE tasks SET tier = 'T1' WHERE id = ?").run(betaTask);
    f.sy.db
      .prepare(
        `INSERT INTO tasks(id,spec_hash,profile,spec_json,state,created_at,updated_at,project_id,tier)
         VALUES ('tier-installation-decoy','h','summarize','{}','queued',1,1,'alpha','T1')`,
      )
      .run();
    const dist = tierDistribution(f.sy, 0).find((d) => d.tier === "T1");
    expect(dist).toMatchObject({ tasks: 2, completed: 0 });
  });

  it("qualificationBoard reads only the qualification project's own store, never a user project's (contamination)", () => {
    const f = fixture();
    // 'alpha's shadow store is not the qualification project's store; a row there is contamination,
    // not qualification data, and must never surface. (The qualification project is not shadowed
    // by this fixture, so it still resolves to sy.db, the real store under today's same-handle state.)
    f.alpha.db
      .prepare("INSERT INTO qualification_runs(id,endpoint_id,suite_version,status,started_at) VALUES ('run-alpha-contamination','ep','v1','finished',1)")
      .run();
    f.sy.db.prepare("INSERT INTO qualification_runs(id,endpoint_id,suite_version,status,started_at) VALUES ('run-real','ep','v1','finished',1)").run();
    const board = qualificationBoard(f.sy);
    expect(board.runs.map((r) => r.id)).toContain("run-real");
    expect(board.runs.map((r) => r.id)).not.toContain("run-alpha-contamination");
  });

  it("jobsView and teamMetrics list a project_id='' job stored in the primary project's (alpha's) own store", () => {
    const f = fixture();
    // A job whose row carries no project (project_id=''), stored directly in the primary project's
    // (alpha's) own shadow store, exactly as `ownedBy`'s convention expects a '' row to live there.
    f.alpha.db
      .prepare(
        `INSERT INTO tasks(id,spec_hash,profile,spec_json,state,created_at,updated_at,project_id)
         VALUES ('unassigned-job','h','supervise',?,'queued',1,1,'')`,
      )
      .run(JSON.stringify({ profile: "supervise", label: "unassigned", goal: "UNASSIGNED PRIMARY JOB" }));

    const alphaJobs = jobsView(f.sy, 50, "alpha");
    expect(alphaJobs.map((j) => j.taskId)).toContain("unassigned-job");
    // beta's own store has no such row: the fix must not leak it into every project's listing.
    expect(jobsView(f.sy, 50, "beta").map((j) => j.taskId)).not.toContain("unassigned-job");
    expect(jobsView(f.sy, 50).map((j) => j.taskId)).toContain("unassigned-job");

    const alphaMetrics = teamMetrics(f.sy, { project: "alpha" });
    expect(alphaMetrics.map((m) => m.jobId)).toContain("unassigned-job");
    expect(teamMetrics(f.sy, { project: "beta" }).map((m) => m.jobId)).not.toContain("unassigned-job");
    expect(teamMetrics(f.sy).map((m) => m.jobId)).toContain("unassigned-job");
  });
});
