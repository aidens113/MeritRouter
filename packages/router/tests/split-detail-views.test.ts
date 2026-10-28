import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MeritRouter } from "../src/core/service.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { BudgetRequests } from "../src/admission/budget-requests.js";
import { recordGrant } from "../src/admission/job-pool.js";
import * as insights from "../src/admin/insights.js";
import { baseConfig, FakeProvider, makeEnv, open, summarizeTask, type Env } from "./helpers.js";

// By-id admin views (the panel's job, task, session and request pages and their API routes) in a
// split installation: each project keeps its rows in its own store (<directory>/.MeritRouter), and
// the installation's own store is the coordination store, which holds no project rows and refuses
// private-evidence reads. Every view must read the owning project's store; naming the wrong project
// must find nothing; mutations by id must land in the owning project's store.

const services: MeritRouter[] = [], envs: Env[] = [], dirs: string[] = [];
afterEach(async () => {
  await Promise.allSettled(services.splice(0).map((s) => s.close()));
  for (const env of envs.splice(0)) env.cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 60_000);

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, stdio: "pipe" }).toString();
function repo(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "meritrouter-test-detail-")));
  dirs.push(dir);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "src", "app.ts"), "export const one = 1;\n");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

const human = { kind: "human", id: "panel" } as const;
const jobSpec = (id: string) => WorkerTaskSchema.parse({ id, profile: "supervise", label: "the-job", goal: "do it", repositoryAliases: ["app"], constraints: { acceptanceCriteria: ["done"] } });

/**
 * A split installation with projects alpha (primary) and beta. A fake-provider summarize task ran
 * in beta (a real model request, session, and artifacts in beta's store); it is then filed under a
 * supervisor job `job-1` in beta, with a grant, a budget request and a pending question.
 */
async function setup() {
  const alpha = repo(), beta = repo();
  const cfg = baseConfig({ storage: { directory: ".meritrouter", layout: "split" }, repositories: {}, brain: { path: "brain", project: "alpha" }, team: { supervisor_reserve_requests: 2 },
    projects: { alpha: { directory: alpha, repositories: { app: { path: alpha } } }, beta: { directory: beta, repositories: { app: { path: beta } } } } });
  (cfg.profiles as Record<string, unknown>).supervise = { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100, max_model_requests: 30, max_output_tokens: 4000, classify: "never", min_tier: "T3" };
  const env = makeEnv({ config: cfg });
  envs.push(env);
  const runner = open(env, new FakeProvider(), { worker: true });
  services.push(runner);
  expect(runner.layout).toBe("split");
  await runner.createSplitProject({ slug: "alpha", directory: alpha });
  await runner.createSplitProject({ slug: "beta", directory: beta });
  const [out] = await runner.submitTasks([summarizeTask({ label: "probe" })], { project: "beta" });
  const taskId = out!.taskId;
  const done = await runner.awaitResults([taskId], { timeoutSeconds: 30 });
  expect(done.completed.map((r) => r.taskId)).toEqual([taskId]);
  await runner.close();
  services.splice(services.indexOf(runner), 1);

  // The panel's instance: no worker, so the seeded job stays queued.
  const sy = open(env, new FakeProvider(), { worker: false });
  services.push(sy);
  const stores = sy.projectStores("beta");
  stores.tasks.submit([jobSpec("job-1")], { project: "beta" });
  stores.db.prepare("UPDATE tasks SET spec_json = json_set(spec_json, '$.parentTaskId', 'job-1') WHERE id = ?").run(taskId);
  recordGrant(stores.db, { taskId, jobId: "job-1", requests: 2, source: "supervisor" }, Date.now());
  const budget = new BudgetRequests(stores.db).file({ taskId, jobId: "job-1", role: "summarizer", requests: 1, reason: "one more look", used: 1, cap: 2, approver: "human" });
  const questionId = Number(stores.db.prepare("INSERT INTO job_questions (task_id, question, options_json, asked_at) VALUES ('job-1', 'Which way?', NULL, ?)").run(Date.now()).lastInsertRowid);
  const sessionId = stores.sessions!.forTask(taskId)[0]!.id;
  const requestId = insights.requestLog(sy, { project: "beta" })[0]!.id;
  const artifactId = stores.artifacts.listForTask(taskId)[0]!.id;
  return { sy, taskId, jobId: "job-1", sessionId, requestId, artifactId, budgetId: budget.id, questionId };
}

const coordinationRows = (sy: MeritRouter) => (sy.db.prepare("SELECT (SELECT COUNT(*) FROM tasks) + (SELECT COUNT(*) FROM sessions) + (SELECT COUNT(*) FROM model_requests) + (SELECT COUNT(*) FROM budget_requests) + (SELECT COUNT(*) FROM job_questions) AS n").get() as { n: number }).n;

describe("split installation: by-id detail views", () => {
  it("resolve a job, its task, session, request and artifact from the owning project's store", async () => {
    const { sy, taskId, jobId, sessionId, requestId, artifactId } = await setup();
    expect(coordinationRows(sy)).toBe(0);

    // Ownership, as the panel's requireTaskIn / requireSessionIn and legacy redirects resolve it.
    expect(insights.taskOwner(sy, jobId)).toBe("beta");
    expect(insights.taskOwner(sy, jobId, "beta")).toBe("beta");
    expect(insights.sessionOwner(sy, sessionId)).toBe("beta");
    expect(insights.contextOfTask(sy, taskId).project.slug).toBe("beta");
    expect(insights.contextOfTask(sy, jobId, "beta").project.slug).toBe("beta");

    // The job page.
    const job = insights.jobDetail(sy, jobId, { project: "beta" });
    expect(job).toMatchObject({ taskId: jobId, project: "beta", label: "the-job", pendingQuestions: 1 });
    expect(job!.children.map((c) => c.taskId)).toEqual([taskId]);
    expect(insights.jobDetail(sy, jobId)?.taskId).toBe(jobId);
    expect(insights.jobPlan(sy, jobId, { project: "beta" })?.otherTasks.map((t) => t.taskId)).toEqual([taskId]);
    expect(insights.jobTeam(sy, jobId, { project: "beta" })?.tree.children.map((c) => c.taskId)).toEqual([taskId]);
    expect(insights.jobMetrics(sy, jobId, { project: "beta" })).not.toBeNull();
    expect(insights.jobChannel(sy, jobId, { project: "beta" })?.posts.length).toBeGreaterThan(0); // the budget request's blocker post
    const budget = insights.jobBudget(sy, jobId, "beta");
    expect(budget?.pool.jobId).toBe(jobId);
    expect(budget?.tasks).toMatchObject([{ taskId, label: "probe", granted: 2, used: 1 }]);
    expect(insights.taskBudget(sy, taskId, "beta")).toMatchObject({ granted: 2, jobId });
    expect(insights.budgetRequestsView(sy, { jobId, project: "beta" }).map((r) => r.label)).toEqual(["probe"]);
    expect(() => insights.deliveryView(sy, jobId, "beta")).not.toThrow();
    await expect(insights.planRecovery(sy, jobId, "beta")).resolves.toMatchObject({ errors: [] });
    const jobRelated = await insights.taskRelated(sy, jobId, "beta");
    expect(jobRelated?.children.map((c) => c.taskId)).toEqual([taskId]);

    // The job's Requests tab, the project's request list, and their task links.
    const requests = insights.requestLog(sy, { jobId, project: "beta", limit: 100 });
    expect(requests.map((r) => r.id)).toEqual([requestId]);
    expect(requests[0]!.taskRefs).toEqual([{ id: taskId, label: "probe", job: false }]);
    expect(insights.requestLogCount(sy, { jobId, project: "beta" })).toBe(1);
    expect(insights.requestLog(sy, { project: "beta" }).map((r) => r.id)).toEqual([requestId]);
    expect(insights.requestLog(sy, {}).map((r) => r.id)).toEqual([requestId]);

    // The task page.
    const task = insights.taskDetail(sy, taskId, "beta");
    expect(task?.status).toMatchObject({ taskId, project: "beta", state: "completed" });
    expect(task?.artifacts.length).toBeGreaterThan(0);
    expect(task?.requests.map((r) => r.id)).toEqual([requestId]);
    expect(task?.contract).not.toBeNull();
    expect(task?.trail.requestsByPurpose).toBeDefined();
    const related = await insights.taskRelated(sy, taskId, "beta");
    expect(related).toMatchObject({ job: { jobId, label: "the-job" }, sessions: 1, requests: 1 });
    expect(insights.taskWebRequests(sy, taskId, "beta")).toEqual([]);

    // Artifacts (the task page's viewer), with and without the page's project.
    expect(insights.artifactText(sy, `artifact:${artifactId}`, undefined, "beta")?.row.id).toBe(artifactId);
    expect(insights.artifactText(sy, artifactId)?.row.id).toBe(artifactId);

    // The session page's request list.
    expect(insights.sessionRequests(sy, sessionId, "beta").map((r) => r.id)).toEqual([requestId]);
    expect(insights.sessionRequests(sy, sessionId).map((r) => r.id)).toEqual([requestId]);

    // The request page: its detail, capture and evidence (the exchange from the project's own session log).
    const detail = insights.requestDetail(sy, requestId, "beta");
    expect(detail).toMatchObject({ id: requestId, project: "beta", taskIds: [taskId] });
    expect(detail?.tasks.map((t) => t.taskId)).toEqual([taskId]);
    expect(detail?.capture).not.toBeNull();
    expect(detail?.evidence?.exchanges.length).toBe(1);
    expect(detail?.sessions.map((s) => s.sessionId)).toEqual([sessionId]);
    expect(insights.requestDetail(sy, requestId)?.project).toBe("beta");
    expect(insights.requestEvidence(sy, "beta", requestId)?.state).not.toBe("unavailable");
    expect(insights.requestCapture(sy, requestId, { project: "beta" })).not.toBeNull();
  }, 90_000);

  it("finds nothing when the page names another project", async () => {
    const { sy, taskId, jobId, sessionId, requestId, artifactId } = await setup();
    expect(insights.taskOwner(sy, jobId, "alpha")).toBeNull();
    expect(insights.sessionOwner(sy, sessionId, "alpha")).toBeNull();
    expect(insights.jobDetail(sy, jobId, { project: "alpha" })).toBeNull();
    expect(insights.jobPlan(sy, jobId, { project: "alpha" })).toBeNull();
    expect(insights.jobTeam(sy, jobId, { project: "alpha" })).toBeNull();
    expect(insights.jobMetrics(sy, jobId, { project: "alpha" })).toBeNull();
    expect(insights.jobBudget(sy, jobId, "alpha")).toBeNull();
    expect(insights.taskBudget(sy, taskId, "alpha")).toBeNull();
    expect(insights.deliveryView(sy, jobId, "alpha")).toBeNull();
    expect(await insights.taskRelated(sy, taskId, "alpha")).toBeNull();
    expect(insights.taskDetail(sy, taskId, "alpha")).toBeNull();
    expect(insights.taskWebRequests(sy, taskId, "alpha")).toEqual([]);
    expect(insights.requestLog(sy, { jobId, project: "alpha" })).toEqual([]);
    expect(insights.budgetRequestsView(sy, { jobId, project: "alpha" })).toEqual([]);
    expect(insights.requestDetail(sy, requestId, "alpha")).toBeNull();
    expect(insights.sessionRequests(sy, sessionId, "alpha")).toEqual([]);
    expect(insights.artifactText(sy, artifactId, undefined, "alpha")).toBeNull();
    expect(sy.getStatus([jobId], "alpha")).toEqual([{ taskId: jobId, state: "unknown" }]);
  }, 90_000);

  it("sends mutations by id to the owning project's store and refuses another project", async () => {
    const { sy, taskId, jobId, budgetId, questionId } = await setup();
    const beta = sy.projectStores("beta");

    // Accept/reject.
    expect(() => insights.decideTaskAcceptance(sy, taskId, "reject", human, "not this", "alpha")).toThrow(/unknown task/);
    insights.decideTaskAcceptance(sy, taskId, "reject", human, "not this", "beta");
    expect(beta.tasks.get(taskId)?.result?.acceptanceStatus).toBe("unmet");

    // Budget decisions.
    expect(() => insights.decideBudgetRequest(sy, budgetId, { approve: false, reason: "no", by: human }, "alpha")).toThrow(/unknown budget request/);
    // The task already finished, so the decision expires the request: in beta's own store.
    expect(() => insights.decideBudgetRequest(sy, budgetId, { approve: true, reason: "Go ahead", by: human }, "beta")).toThrow(/already completed/);
    expect(new BudgetRequests(beta.db).get(budgetId)?.status).toBe("expired");

    // Answers.
    expect(() => sy.answerQuestion(questionId, "left", "user", "alpha")).toThrow();
    sy.answerQuestion(questionId, "left", "user", "beta");
    expect(beta.db.prepare("SELECT answer FROM job_questions WHERE id = ?").get(questionId)).toEqual({ answer: "left" });
    expect(insights.jobDetail(sy, jobId, { project: "beta" })?.questions.map((q) => q.answer)).toEqual(["left"]);

    // Cancel.
    expect(sy.cancelTasks([jobId], "alpha")).toEqual([{ taskId: jobId, state: "unknown" }]);
    expect(beta.tasks.get(jobId)?.row.state).toBe("queued");
    sy.cancelTasks([jobId], "beta");
    expect(beta.tasks.get(jobId)?.row.state).toBe("cancelled");

    // Worker actions are read from the project's own store, under its own configuration.
    const scope = insights.workerActionScope(sy, "beta");
    expect(scope.db).toBe(beta.db);
    expect(scope.config.brain.project).toBe("beta");
    expect(insights.listWorkerActions(scope.db, { project: "beta", jobId })).toEqual([]);

    // Nothing was written to the coordination store.
    expect(coordinationRows(sy)).toBe(0);
  }, 90_000);

  it("refuses an id held by two projects unless the project is named", async () => {
    const { sy, jobId } = await setup();
    sy.projectStores("alpha").tasks.submit([jobSpec(jobId)], { project: "alpha" });
    expect(() => insights.jobDetail(sy, jobId)).toThrow(/several projects/);
    expect(() => insights.taskOwner(sy, jobId)).toThrow(/several projects/);
    expect(insights.jobDetail(sy, jobId, { project: "beta" })?.children).toHaveLength(1);
    expect(insights.jobDetail(sy, jobId, { project: "alpha" })?.children).toHaveLength(0);
    expect(insights.taskOwner(sy, jobId, "alpha")).toBe("alpha");
  }, 90_000);

  it("shows the request in installation and project dashboards", async () => {
    const { sy, taskId, requestId } = await setup();
    const endpoint = insights.requestDetail(sy, requestId, "beta")!.endpointId!;
    expect(insights.modelUsage(sy, endpoint).tasks.map((t) => t.taskId)).toEqual([taskId]);
    expect(insights.timeseries(sy, { hours: 24, project: "beta" }).reduce((n, p) => n + p.requests, 0)).toBe(1);
    expect(insights.projectOverview(sy, "beta").usage24h.modelRequests).toBe(1);
    const dashboard = await insights.globalDashboard(sy);
    expect(dashboard.totals.usage24h.requests).toBe(1);
    expect(dashboard.projects.find((p) => p.slug === "beta")?.usage24h.requests).toBe(1);
  }, 90_000);
});
