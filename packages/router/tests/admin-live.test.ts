import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { BudgetRequests } from "../src/admission/budget-requests.js";
import { recordGrant } from "../src/admission/job-pool.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import type { Switchyard } from "../src/core/service.js";
import {
  agentDetail,
  agentsView,
  brainWrite,
  commitDetail,
  decodeLiveCursor,
  encodeLiveCursor,
  liveChanges,
  liveCursor,
  liveMatches,
  modelUsage,
  parseAgentId,
  projectCommits,
  repositoryView,
  requestDetail,
  sessionRequests,
  taskRelated,
  type LiveCursor,
} from "../src/admin/insights.js";
import { commitAs } from "../src/attribution/index.js";
import { baseConfig, commitAll, goodOutput, makeEnv, open, reply, ScriptedClient, servedFor, summarizeTask, type Env } from "./helpers.js";

// The panel's change watcher (panel-v2 U1): cursors over the store, topics for what changed, and
// project scoping. The SSE route in the panel polls liveChanges about once a second.

let env: Env | undefined;
let sy: Switchyard | undefined;
const extra: Database.Database[] = [];
afterEach(async () => {
  for (const d of extra.splice(0)) d.close();
  await sy?.close();
  sy = undefined;
  env?.cleanup();
  env = undefined;
});

function gitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "README.md"), "# repo\n");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, stdio: "pipe" });
  commitAll(dir, "init");
}

const supervise = { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100, max_model_requests: 60, max_output_tokens: 8000, classify: "never", min_tier: "T3" };

/** Two projects; alpha is the primary one. */
function twoProjects(): Env {
  const base = baseConfig();
  const e = makeEnv({
    config: {
      ...base,
      repositories: {},
      brain: { ...((base.brain as Record<string, unknown> | undefined) ?? {}), project: "alpha" },
      profiles: { ...(base.profiles as Record<string, unknown>), supervise },
      projects: {
        alpha: { name: "Alpha", repositories: { app: { path: "alpha-app" } } },
        beta: { repositories: { app: { path: "beta-app" } } },
      },
    },
  });
  for (const d of ["alpha-app", "beta-app"]) gitRepo(path.join(e.dir, d));
  return e;
}

/** Check, and return the topics and the cursor to continue from. */
function step(s: Switchyard, cursor: LiveCursor): { topics: string[]; cursor: LiveCursor } {
  const r = liveChanges(s, cursor);
  return { topics: r.topics, cursor: r.cursor };
}

describe("live change watcher", () => {
  it("watches scoped budget requests, same-timestamp decisions and released grants", () => {
    env = twoProjects();
    sy = open(env, new ScriptedClient(() => reply("{}")), { worker: false });
    sy.tasks.submit([WorkerTaskSchema.parse({ id: "budget_a", profile: "inspect", goal: "inspect", repositoryAliases: ["app"], constraints: { acceptanceCriteria: ["done"] } })], { project: "alpha" });
    let alpha = liveCursor(sy, "alpha");
    const beta = liveCursor(sy, "beta");
    const store = new BudgetRequests(sy.db, () => 100);
    const r = store.file({ taskId: "budget_a", jobId: null, role: "inspector", requests: 2, reason: "more files", used: 1, cap: 2, approver: "human" });
    let result = liveChanges(sy, alpha);
    expect(result.topics).toContain("budget");
    expect(result.topics).toContain("tasks:*");
    expect(liveChanges(sy, beta).topics).not.toContain("budget");
    alpha = result.cursor;
    // An older row decision without advancing any timestamp still refreshes budget views.
    sy.db.prepare("UPDATE budget_requests SET status = 'denied', decided_at = 100 WHERE id = ?").run(r.id);
    result = liveChanges(sy, alpha);
    expect(result.topics).toContain("budget");
    alpha = result.cursor;
    recordGrant(sy.db, { taskId: "budget_a", jobId: "unstarted-job", requests: 4, source: "supervisor" }, 100);
    result = liveChanges(sy, alpha);
    expect(result.topics).toContain("budget");
    alpha = result.cursor;
    sy.cancelTasks(["budget_a"]);
    result = liveChanges(sy, alpha);
    expect(result.topics).toContain("budget");
    expect(liveChanges(sy, result.cursor).topics).toEqual([]);
  });

  it("detects mutable settings updates that preserve counts, timestamps and key lengths", () => {
    env = twoProjects();
    sy = open(env, new ScriptedClient(() => reply("{}")));
    const key = sy.db.prepare("INSERT INTO paid_keys (provider, billing_class, enc, iv, tag, created_at) VALUES ('fake', 'paid', 'fake-a', 'fake', 'fake', 1)").run().lastInsertRowid;
    sy.db.prepare("INSERT INTO endpoint_overrides (endpoint_id, data_json, updated_at) VALUES ('fake-endpoint', '{}', 1)").run();
    let c = liveCursor(sy, "all");
    sy.db.prepare("UPDATE paid_keys SET enc = 'fake-b' WHERE id = ?").run(key);
    let check = step(sy, c);
    expect(check.topics).toContain("keys");
    c = check.cursor;
    sy.db.prepare("UPDATE projects SET name = 'Renamed' WHERE id = 'alpha'").run();
    check = step(sy, c);
    expect(check.topics).toContain("projects");
    c = check.cursor;
    sy.db.prepare("UPDATE endpoint_overrides SET data_json = '{\"blocked\":true}' WHERE endpoint_id = 'fake-endpoint'").run();
    check = step(sy, c);
    expect(check.topics).toContain("models");
    expect(step(sy, check.cursor).topics).toEqual([]);
  });

  it("watches the install brain even when project brain roots differ", () => {
    env = twoProjects();
    sy = open(env, new ScriptedClient(() => reply("{}")));
    const root = path.join(env.dir, "separate-install-brain");
    gitRepo(root);
    // Model an install root distinct from each configured project's brain root.
    Object.defineProperty(sy, "brain", { configurable: true, value: { root } });
    try {
      const c = liveCursor(sy, "all");
      writeFileSync(path.join(root, "README.md"), "# Changed install brain\n");
      commitAll(root, "install brain update");
      expect(step(sy, c).topics).toContain("brain");
    } finally {
      Reflect.deleteProperty(sy, "brain");
    }
  });

  it("detects task edits with an unchanged timestamp and older-row edits", async () => {
    env = makeEnv();
    sy = open(env, new ScriptedClient(() => reply("{}")));
    const [first, second] = await sy.submitTasks([summarizeTask(), summarizeTask()]);
    sy.db.prepare("UPDATE tasks SET updated_at = CASE WHEN id = ? THEN 100 ELSE 200 END").run(first!.taskId);
    let c = liveCursor(sy, "all");
    sy.db.prepare("UPDATE tasks SET state_reason = 'same millisecond' WHERE id = ?").run(second!.taskId);
    let check = step(sy, c);
    expect(liveMatches(`tasks:${second!.taskId}`, check.topics)).toBe(true);
    c = check.cursor;
    sy.db.prepare("UPDATE tasks SET state_reason = 'older row' WHERE id = ?").run(first!.taskId);
    check = step(sy, c);
    expect(liveMatches(`tasks:${first!.taskId}`, check.topics)).toBe(true);
    expect(step(sy, check.cursor).topics).toEqual([]);
  });

  it("can resume with many workers without exceeding the cursor string limit", () => {
    env = makeEnv();
    sy = open(env, new ScriptedClient(() => reply("{}")));
    const insert = sy.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
    for (let i = 0; i < 30; i++) insert.run(`worker:long-worker-identity-${i}`, String(Date.now()));
    const c = liveCursor(sy, "all");
    expect(decodeLiveCursor(encodeLiveCursor(c), "all")?.marks).toEqual(c.marks);
  });

  it("reports nothing when nothing changed, and does not query the store when it was not written", () => {
    env = makeEnv();
    sy = open(env, new ScriptedClient(() => reply("{}")));
    const c0 = liveCursor(sy, "all");
    const a = step(sy, c0);
    expect(a.topics).toEqual([]);
    // Quiet store: only the file and worker sources read anything (one meta query for workers).
    const prepared: string[] = [];
    const original = sy.db.prepare.bind(sy.db);
    (sy.db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      prepared.push(sql);
      return original(sql);
    };
    try {
      expect(step(sy, a.cursor).topics).toEqual([]);
    } finally {
      (sy.db as unknown as { prepare: unknown }).prepare = original;
    }
    expect(prepared.filter((q) => !/total_changes|FROM meta/.test(q))).toEqual([]);
  });

  it("names a submitted task and its state changes", async () => {
    env = makeEnv();
    sy = open(env, new ScriptedClient(() => reply("{}")));
    let c = liveCursor(sy, "all");
    const [sub] = await sy.submitTasks([summarizeTask()]);
    const a = step(sy, c);
    expect(a.topics).toEqual(expect.arrayContaining(["tasks", `tasks:${sub!.taskId}`, "events"]));
    c = a.cursor;
    expect(step(sy, c).topics).toEqual([]);
    sy.cancelTasks([sub!.taskId]);
    const b = step(sy, c);
    expect(b.topics).toContain(`tasks:${sub!.taskId}`);
  });

  it("sees a run's requests and sessions, written by the worker", async () => {
    env = makeEnv();
    let me: Switchyard | undefined;
    const client = new ScriptedClient((req) => reply(JSON.stringify(goodOutput()), servedFor(me!, req)));
    sy = me = open(env, client, { worker: true });
    const c = liveCursor(sy, "all");
    const [sub] = await sy.submitTasks([summarizeTask()]);
    const out = await sy.awaitResults([sub!.taskId], { timeoutSeconds: 10 });
    expect(out.timedOut).toBe(false);
    const r = step(sy, c);
    expect(r.topics).toEqual(expect.arrayContaining(["requests", "sessions", "tasks", `tasks:${sub!.taskId}`]));
    expect(r.topics.some((t) => t.startsWith("sessions:s_"))).toBe(true);
  });

  it("sees writes from another process (another connection to the same database)", async () => {
    env = makeEnv();
    sy = open(env, new ScriptedClient(() => reply("{}")));
    const [sub] = await sy.submitTasks([summarizeTask()]);
    const c = liveCursor(sy, "all");
    const other = new Database(sy.db.name);
    extra.push(other);
    other.prepare("UPDATE tasks SET state_reason = 'other process', updated_at = ? WHERE id = ?").run(Date.now() + 5, sub!.taskId);
    expect(step(sy, c).topics).toEqual(expect.arrayContaining(["tasks", `tasks:${sub!.taskId}`]));
  });

  it("keeps projects apart: a change in one project is not reported to another's cursor", async () => {
    env = twoProjects();
    sy = open(env, new ScriptedClient(() => reply("{}")));
    const alpha = liveCursor(sy, "alpha");
    const beta = liveCursor(sy, "beta");
    const all = liveCursor(sy, "all");
    const job = await sy.startJob({ goal: "Beta job", repositories: ["app"], project: "beta" });
    expect(step(sy, alpha).topics.filter((t) => t.startsWith("tasks") || t.startsWith("jobs"))).toEqual([]);
    const b = step(sy, beta).topics;
    expect(b).toEqual(expect.arrayContaining(["tasks", `tasks:${job.taskId}`, `jobs:${job.taskId}`]));
    expect(step(sy, all).topics).toContain(`tasks:${job.taskId}`);
  });

  it("attributes a supervisor's question and a sub-task's change to the job", async () => {
    env = twoProjects();
    sy = open(env, new ScriptedClient(() => reply("{}")));
    const job = await sy.startJob({ goal: "Alpha job", repositories: ["app"], project: "alpha" });
    let c = liveCursor(sy, "alpha");
    sy.db.prepare("INSERT INTO job_questions (task_id, question, asked_at) VALUES (?, ?, ?)").run(job.taskId, "Which way?", Date.now());
    let r = step(sy, c);
    expect(r.topics).toEqual(expect.arrayContaining(["jobs", `jobs:${job.taskId}`]));
    c = r.cursor;
    const [child] = await sy.submitTasks([summarizeTask({ parentTaskId: job.taskId })], { project: "alpha" });
    r = step(sy, c);
    expect(r.topics).toEqual(expect.arrayContaining([`tasks:${child!.taskId}`, `jobs:${job.taskId}`]));
  });

  it("reports brain commits, worker arrivals, config edits, and model overrides", async () => {
    env = makeEnv();
    sy = open(env, new ScriptedClient(() => reply("{}")));
    await sy.brain.ensure();
    let c = liveCursor(sy, "all");
    await brainWrite(sy, "projects/demo/notes/live.md", "# Live\n\nA note.\n");
    let r = step(sy, c);
    expect(r.topics).toContain("brain");
    c = r.cursor;

    sy.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run("worker:test-owner", String(Date.now()));
    r = step(sy, c);
    expect(r.topics).toContain("workers");
    c = r.cursor;
    // A heartbeat from the same worker is not a change.
    sy.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run("worker:test-owner", String(Date.now() + 1));
    r = step(sy, c);
    expect(r.topics).not.toContain("workers");
    c = r.cursor;

    const later = new Date(Date.now() + 60_000);
    utimesSync(sy.cfg.configPath, later, later);
    r = step(sy, c);
    expect(r.topics).toEqual(expect.arrayContaining(["config", "projects", "models"]));
    c = r.cursor;

    sy.db.prepare("INSERT INTO routing_overrides (kind, endpoint_id, created_at) VALUES ('block', 'openrouter/vendor/big-a:free', ?)").run(Date.now());
    expect(step(sy, c).topics).toContain("models");
  });

  it("encodes cursors for resuming and refuses a malformed one or another scope's", () => {
    env = makeEnv();
    sy = open(env, new ScriptedClient(() => reply("{}")));
    const c = liveCursor(sy, "demo");
    const text = encodeLiveCursor(c);
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    const back = decodeLiveCursor(text, "demo");
    expect(back?.marks).toEqual(c.marks);
    // The data_version pair belongs to the connection that read it; a resumed cursor compares marks.
    expect(back?.dv).toBeUndefined();
    expect(liveChanges(sy, back!).topics).toEqual([]);
    expect(decodeLiveCursor(text, "all")).toBeNull();
    expect(decodeLiveCursor("not-a-cursor", "demo")).toBeNull();
    expect(decodeLiveCursor(Buffer.from(JSON.stringify({ v: 2, scope: "demo", marks: {} })).toString("base64url"), "demo")).toBeNull();
  });

  it("matches subscriptions to changed topics", () => {
    expect(liveMatches("tasks", ["tasks", "tasks:a"])).toBe(true);
    expect(liveMatches("tasks:a", ["tasks", "tasks:a"])).toBe(true);
    expect(liveMatches("tasks:b", ["tasks", "tasks:a"])).toBe(false);
    expect(liveMatches("tasks:b", ["tasks", "tasks:*"])).toBe(true);
    expect(liveMatches("requests", ["tasks"])).toBe(false);
  });
});

// Entity queries behind the panel's entity pages (panel-v2 D6/U3): agents, requests, commits,
// repositories, and what a task connects to.
describe("entity queries", () => {
  it("parses agent ids from untrusted input", () => {
    expect(parseAgentId("implementer:posts")).toEqual({ id: "implementer:posts", role: "implementer", label: "posts" });
    expect(parseAgentId("supervisor:t_abc")).toMatchObject({ role: "supervisor", label: "t_abc" });
    expect(parseAgentId("wizard:posts")).toBeNull();
    expect(parseAgentId("implementer:")).toBeNull();
    expect(parseAgentId("implementer:a b")).toBeNull();
    expect(parseAgentId("posts")).toBeNull();
  });

  it("an agent's page lists its tasks, sessions, models, and requests (from its own session logs)", async () => {
    env = makeEnv();
    let me: Switchyard | undefined;
    const client = new ScriptedClient((req) => reply(JSON.stringify(goodOutput()), servedFor(me!, req)));
    sy = me = open(env, client, { worker: true });
    const [sub] = await sy.submitTasks([summarizeTask({ label: "notes" })]);
    const out = await sy.awaitResults([sub!.taskId], { timeoutSeconds: 10 });
    expect(out.timedOut).toBe(false);

    const rows = agentsView(sy, { project: "demo" });
    expect(rows.map((r) => r.id)).toContain("summarizer:notes");
    const a = await agentDetail(sy, "demo", "summarizer:notes");
    expect(a).not.toBeNull();
    expect(a!.tasks.map((t) => t.taskId)).toEqual([sub!.taskId]);
    expect(a!.sessions.length).toBe(1);
    expect(a!.requests.length).toBe(1);
    expect(a!.requests[0]!.sessionId).toBe(a!.sessions[0]!.id);
    expect(a!.models).toEqual([expect.objectContaining({ endpointId: "openrouter/vendor/big-a:free", requests: 1 })]);
    expect(a!.totals).toMatchObject({ tasks: 1, sessions: 1, requests: 1 });
    // Another project's view of the same agent, and an unknown agent, are not found.
    expect(await agentDetail(sy, "other", "summarizer:notes")).toBeNull();
    expect(await agentDetail(sy, "demo", "summarizer:nobody")).toBeNull();

    const r = requestDetail(sy, a!.requests[0]!.id)!;
    expect(r.tasks.map((t) => t.taskId)).toEqual([sub!.taskId]);
    expect(r.sessions).toEqual([{ sessionId: a!.sessions[0]!.id, agent: "summarizer:notes", role: "summarizer" }]);
    expect(requestDetail(sy, "r_nope")).toBeNull();
    const citations = [{ url: "https://example.test/source", title: "Source", text: "Evidence" }];
    sy.db.prepare("UPDATE model_requests SET web_citations_json = ? WHERE id = ?").run(JSON.stringify(citations), r.id);
    expect(requestDetail(sy, r.id)!.webCitations).toEqual(citations);
    sy.db.prepare("UPDATE model_requests SET web_citations_json = ? WHERE id = ?").run('{"bad":true}', r.id);
    expect(requestDetail(sy, r.id)!.webCitations).toEqual([]);
    expect(sessionRequests(sy, a!.sessions[0]!.id).map((x) => x.id)).toEqual([r.id]);

    const rel = (await taskRelated(sy, sub!.taskId))!;
    expect(rel.agents).toEqual([{ id: "summarizer:notes", role: "summarizer", sessions: 1 }]);
    expect(rel.requests).toBe(1);
    expect(rel.job).toBeNull();

    const usage = modelUsage(sy, "openrouter/vendor/big-a:free");
    expect(usage.tasks.map((t) => t.taskId)).toContain(sub!.taskId);
    expect(usage.agents).toEqual([expect.objectContaining({ id: "summarizer:notes", requests: 1 })]);
  });

  it("finds an agent's commits with their lines, a commit's detail, and the repository view", async () => {
    env = makeEnv();
    sy = open(env, new ScriptedClient(() => reply("{}")));
    writeFileSync(path.join(env.repo, "src", "extra.ts"), "export const a = 1;\nexport const b = 2;\n");
    const sha = await commitAs(env.repo, { agent: "implementer:extra", role: "implementer", model: "openrouter/vendor/big-a:free", task: "t_extra", job: "t_job" }, "implementer: add extra");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);

    const { commits } = await projectCommits(sy, "demo", { agent: "implementer:extra" });
    expect(commits).toEqual([expect.objectContaining({ repository: "core", commit: sha, agent: "implementer:extra", task: "t_extra", job: "t_job", added: 2, removed: 0, files: 1 })]);
    expect((await projectCommits(sy, "demo", { task: "t_other" })).commits).toEqual([]);

    const c = (await commitDetail(sy, "demo", "core", sha!))!;
    expect(c).toMatchObject({ subject: "implementer: add extra", agent: "implementer:extra", model: "openrouter/vendor/big-a:free", branches: ["main"] });
    expect(c.fileStats).toEqual([{ path: "src/extra.ts", added: 2, removed: 0 }]);
    expect(c.diff).toContain("+export const b = 2;");
    expect(await commitDetail(sy, "demo", "core", "not-a-sha")).toBeNull();
    expect(await commitDetail(sy, "demo", "nope", sha!)).toBeNull();

    const repo = (await repositoryView(sy, "demo", "core"))!;
    expect(repo).toMatchObject({ alias: "core", exists: true, branch: "main", head: sha });
    expect(repo.commits.map((x) => x.commit)).toEqual([sha, expect.any(String)]);
    expect(await repositoryView(sy, "demo", "nope")).toBeNull();
    for (const alias of ["__proto__", "constructor", "toString"]) {
      expect(await repositoryView(sy, "demo", alias)).toBeNull();
      expect(await commitDetail(sy, "demo", alias, sha!)).toBeNull();
    }
  });
});
