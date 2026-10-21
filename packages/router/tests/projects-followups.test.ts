import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Switchyard } from "../src/core/service.js";
import type { Principal } from "../src/brain/access.js";
import type { PromotionReviewPort } from "../src/brain/promotion.js";
import type { Actor } from "../src/attribution/index.js";
import { PROMOTION_RUBRIC_VERSION } from "../src/verification/promotion-review.js";
import { QUALIFICATION_PROJECT } from "../src/qualification/registry.js";
import { COMPARISON_FINISHED, COMPARISON_RUN, COMPARISON_STARTED } from "../src/qualification/comparison.js";
import {
  contextOfTask,
  globalDashboard,
  isQualificationTask,
  projectList,
  projectsGrid,
  promotionsView,
  qualificationComparisons,
  qualificationTasks,
  revertGlobalEntry,
  saveProjectRepositories,
  saveProjectSettings,
} from "../src/admin/insights.js";
import { baseConfig, commitAll, endpoint, makeEnv, open, reply, ScriptedClient, summarizeTask, type Env } from "./helpers.js";

// J2 follow-ups (router side): the reserved `_qualification` project stays out of project views
// and has its own; Brain.remove and the `reverted` promotion status; a repository in use cannot
// be removed; brain mount folders must exist when saved.

let env: Env | undefined;
let sy: Switchyard | undefined;
afterEach(async () => {
  await sy?.close();
  sy = undefined;
  env?.cleanup();
  env = undefined;
});

const SUPERVISOR_EP = endpoint({ providerId: "openrouter", gatewayModelId: "alpha/alpha-1:free", totalParametersB: 700 });
const REVIEWER_EP = endpoint({ providerId: "groq", gatewayModelId: "beta/beta-2", totalParametersB: 400 });

function gitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "README.md"), "# repo\n");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, stdio: "pipe" });
  commitAll(dir, "init");
}

/** Two projects, each with `app` and `docs` repositories, a temp brain, and no worker. */
function setup(): Switchyard {
  const base = baseConfig();
  env = makeEnv({
    config: {
      ...base,
      repositories: {},
      brain: { ...(base.brain as Record<string, unknown>), path: "brain", project: "alpha", global_requires_approval: false },
      projects: {
        alpha: { name: "Acme Storefront", repositories: { app: { path: "alpha-app" }, docs: { path: "alpha-docs" } } },
        beta: { repositories: { app: { path: "beta-app" }, docs: { path: "beta-docs" } } },
      },
    },
    endpoints: [SUPERVISOR_EP, REVIEWER_EP],
  });
  for (const d of ["alpha-app", "alpha-docs", "beta-app", "beta-docs"]) gitRepo(path.join(env.dir, d));
  sy = open(env, new ScriptedClient(() => reply("{}")));
  return sy;
}

const git = (repo: string, ...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

describe("the reserved _qualification project in views", () => {
  /** A comparison's run record (only the fields the record schema requires). */
  const run = (taskId: string) => ({
    taskId,
    acceptance: "met",
    stopReason: "completed",
    stoppedAtCap: false,
    timedOut: false,
    requestCap: 10,
    endpoints: [],
    metrics: { state: "completed", wallClockMs: 1000, peakParallelism: 1, meanParallelism: 1, requests: 2, costUsd: 0, completedTasks: 1, requestsPerCompletedTask: 2, verificationShare: null, waitingMs: 0, agents: 1, agentMs: 1000, criticalPathMs: 1000, criticalPathLabels: [], waitingByReason: {} },
  });

  it("is never listed as a project, but its tasks resolve to it and are listed for the Qualification page", async () => {
    const s = setup();
    const [q] = await s.submitTasks([summarizeTask({ goal: "an eval trial" })], { purpose: "qualification" });
    const [c] = await s.submitTasks([summarizeTask({ goal: "a comparison run" })], { purpose: "comparison" });
    const [a] = await s.submitTasks([summarizeTask({ goal: "user work" })], { project: "alpha" });
    expect([q, c].map((x) => s.tasks.projectOf(x!.taskId))).toEqual([QUALIFICATION_PROJECT, QUALIFICATION_PROJECT]);

    // A task's views resolve to its own project: the qualification one, not the primary project.
    expect(contextOfTask(s, q!.taskId).project.slug).toBe(QUALIFICATION_PROJECT);
    expect(contextOfTask(s, a!.taskId).project.slug).toBe("alpha");
    expect(isQualificationTask(s, q!.taskId)).toBe(true);
    expect(isQualificationTask(s, a!.taskId)).toBe(false);

    // Never a project: not in the list, the grid (the switcher's source), or the dashboard's projects and jobs.
    expect(projectList(s, { includeArchived: true }).map((p) => p.slug)).toEqual(["alpha", "beta"]);
    expect(projectsGrid(s, { includeArchived: true }).map((p) => p.slug)).toEqual(["alpha", "beta"]);
    const d = await globalDashboard(s, { includeArchived: true });
    expect(d.projects.map((p) => p.slug)).toEqual(["alpha", "beta"]);
    expect(d.jobs.every((j) => j.project !== QUALIFICATION_PROJECT)).toBe(true);
    // Its usage is its own row, and counts in the totals.
    expect(d.qualification.usage24h.tasksSubmitted).toBe(2);
    expect(d.totals.usage24h.tasksSubmitted).toBe(3);

    // The Qualification page lists its tasks, newest first, by kind.
    expect(qualificationTasks(s).map((t) => [t.taskId, t.purpose])).toEqual([
      [c!.taskId, "comparison"],
      [q!.taskId, "qualification"],
    ]);
    expect(qualificationTasks(s, { purpose: "qualification" }).map((t) => t.taskId)).toEqual([q!.taskId]);
  });

  it("lists comparisons on eval goals (finished or not started), not those of supplied goals", async () => {
    const s = setup();
    const [qt, qs] = await s.submitTasks([summarizeTask({ goal: "team" }), summarizeTask({ goal: "single" })], { purpose: "comparison" });
    const [at, as] = await s.submitTasks([summarizeTask({ goal: "team" }), summarizeTask({ goal: "single" })], { project: "alpha" });
    const goal = (source: string) => ({ id: "g1", goal: "Find the validator", source, singleRequests: 5, teamRequests: 10 });
    const ev = (type: string, data: unknown) => s.tasks.event(null, type, data);
    ev(COMPARISON_STARTED, { id: "cmp-eval", plannedRequests: 15, goals: [goal("eval")] });
    ev(COMPARISON_RUN, { id: "cmp-eval", goalId: "g1", team: run(qt!.taskId), single: run(qs!.taskId) });
    ev(COMPARISON_FINISHED, { id: "cmp-eval", status: "finished", reason: null });
    ev(COMPARISON_STARTED, { id: "cmp-supplied", plannedRequests: 15, goals: [goal("supplied")] });
    ev(COMPARISON_RUN, { id: "cmp-supplied", goalId: "g1", team: run(at!.taskId), single: run(as!.taskId) });
    ev(COMPARISON_FINISHED, { id: "cmp-supplied", status: "finished", reason: null });
    ev(COMPARISON_STARTED, { id: "cmp-eval-new", plannedRequests: 15, goals: [goal("eval")] });

    const list = qualificationComparisons(s);
    expect(list.map((x) => [x.id, x.status])).toEqual([
      ["cmp-eval-new", "running"],
      ["cmp-eval", "finished"],
    ]);
    expect(list[1]!.results[0]!.team.taskId).toBe(qt!.taskId);
  });
});

describe("Brain.remove and reverted promotions", () => {
  /** Replace the service's reviewer with one whose reviews pass. */
  function passingReviewer(s: Switchyard): void {
    let n = 0;
    const port: PromotionReviewPort = {
      async start() {
        return { kind: "started", reviewTaskId: `t_review${++n}`, reviewer: REVIEWER_EP.id };
      },
      result() {
        return { kind: "verdict", verdict: "pass", reasons: ["beyond_project: holds anywhere"], reviewer: REVIEWER_EP.id, reviewerModel: "beta/beta-2", rubric: PROMOTION_RUBRIC_VERSION };
      },
    };
    (s as unknown as { promotionReviewer: PromotionReviewPort }).promotionReviewer = port;
  }
  const actor: Actor = { agent: "supervisor:alpha-job", role: "supervisor", model: SUPERVISOR_EP.id, job: "alpha-job" };
  const supervisor = (s: Switchyard): Principal =>
    s.brainAccessFor("alpha").principalFor("supervisor", { project: "alpha", effort: "job-1", task: null, repos: ["app", "docs"], jobId: null, tier: "T3" });

  async function promoteApproved(s: Switchyard): Promise<{ id: string; rel: string }> {
    passingReviewer(s);
    const brain = s.brainFor("alpha");
    await brain.write(supervisor(s), actor, "projects/alpha/decisions/notes.md", "# Notes\n\nWhat we learned.\n");
    const r = await brain.promoteLesson(supervisor(s), actor, "Retry idempotent calls with jittered backoff", "Retry transient failures of idempotent calls with exponential backoff and jitter.", ["projects/alpha/decisions/notes.md"]);
    await brain.promotions.settle();
    const rec = brain.promotions.get(r.id!)!;
    expect(rec.status).toBe("approved");
    return { id: r.id!, rel: rec.global_path! };
  }

  it("removes with a recorded reason under the brain's rules: only people remove global/, never an index", async () => {
    const s = setup();
    const brain = s.brainFor("alpha");
    const sup = supervisor(s);
    await brain.write(sup, actor, "projects/alpha/decisions/old.md", "# Old\n\nSuperseded.\n");
    await brain.write({ kind: "human", name: "you" }, { agent: "human", role: "human" }, "global/facts/tz.md", "# UTC\n\nStore UTC.\n");

    await expect(brain.remove(sup, actor, "global/facts/tz.md", "wrong")).rejects.toThrow(/only a person removes global knowledge/);
    await expect(brain.remove(sup, actor, "projects/alpha/README.md", "x")).rejects.toThrow(/generated by SwitchYard/);
    await expect(brain.remove(sup, actor, "projects/beta/decisions/x.md", "x")).rejects.toThrow(/no write access/);
    await expect(brain.remove(sup, actor, "projects/alpha/decisions/old.md", "  ")).rejects.toThrow(/say why/);
    await expect(brain.remove(sup, actor, "projects/alpha/decisions/missing.md", "x")).rejects.toThrow(/does not exist/);

    const out = await brain.remove(sup, actor, "projects/alpha/decisions/old.md", "Superseded by\nthe new note");
    expect(out.text).toContain("Superseded.");
    expect(existsSync(path.join(brain.root, "projects/alpha/decisions/old.md"))).toBe(false);
    const msg = git(brain.root, "log", "-1", "--format=%an%n%B", out.commit!);
    expect(msg).toMatch(/^supervisor alpha-job /);
    expect(msg).toContain("Agent: supervisor:alpha-job");
    expect(msg).toContain("Remove projects/alpha/decisions/old.md");
    expect(msg).toContain("Removed-By: supervisor:alpha-job");
    expect(msg).toContain("Remove-Reason: Superseded by the new note");
    const human = await brain.remove({ kind: "human", name: "you" }, { agent: "human", role: "human" }, "global/facts/tz.md", "Not true for every team");
    expect(git(brain.root, "log", "-1", "--format=%B", human.commit!)).toContain("Removed-By: you");
  });

  it("a revert goes through the brain's lock, marks the promotion reverted with who and why, and a settle never rewrites it", async () => {
    const s = setup();
    const { id, rel } = await promoteApproved(s);
    const root = s.brain.root;

    // The revert waits for the brain's cross-process lock (held here by "another process").
    const lock = path.join(root, ".switchyard-brain.lock");
    writeFileSync(lock, "");
    const pending = revertGlobalEntry(s, rel, "panel", "Too broad for batch jobs");
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(path.join(root, rel))).toBe(true);
    rmSync(lock);
    const out = await pending;
    expect(out).toMatchObject({ path: rel, promotion: id, project: "alpha", promotionStatus: "reverted" });
    expect(existsSync(path.join(root, rel))).toBe(false);
    expect(existsSync(lock)).toBe(false);
    const msg = git(root, "log", "-1", "--format=%an%n%B", out.commit);
    expect(msg).toMatch(/^human\n/);
    expect(msg).toContain("Reverted-By: panel");
    expect(msg).toContain("Revert-Reason: Too broad for batch jobs");

    const rec = s.brainFor("alpha").promotions.get(id)!;
    expect(rec).toMatchObject({ status: "reverted", reverted_by: "panel", revert_reason: "Too broad for batch jobs", global_path: rel });
    expect(rec.reverted_at).toMatch(/^\d{4}-/);
    expect(promotionsView(s, { project: "alpha", status: "reverted" }).map((p) => p.id)).toEqual([id]);

    // Never written again, nor decided again.
    await s.settlePromotions();
    expect(existsSync(path.join(root, rel))).toBe(false);
    expect(s.brainFor("alpha").promotions.get(id)!.status).toBe("reverted");
    await expect(s.decidePromotion("alpha", id, true, "you")).rejects.toThrow(/is reverted/);
  });
});

describe("project settings guards", () => {
  it("refuses to remove a repository that unfinished tasks use, naming them", async () => {
    const s = setup();
    const [t1] = await s.submitTasks([summarizeTask({ repositoryAliases: ["docs"] })], { project: "alpha" });
    const rows = [{ alias: "app", path: "alpha-app", writable: true }];

    const r = saveProjectRepositories(s, "alpha", rows);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.fieldErrors.form).toEqual([`repository docs is used by 1 unfinished task (${t1!.taskId}); cancel them or let them finish before removing it`]);
    // The generic settings patch refuses too, keyed by the repository.
    const p = saveProjectSettings(s, "alpha", [{ path: ["repositories", "docs"], value: null }]);
    expect(!p.ok && p.fieldErrors["repositories.docs"]?.[0]).toMatch(new RegExp(`used by 1 unfinished task \\(${t1!.taskId}\\)`));
    const whole = saveProjectSettings(s, "alpha", [{ path: ["repositories"], value: { app: { path: "alpha-app" } } }]);
    expect(whole.ok).toBe(false);
    // Another project's alias of the same name, and an unused repository, are free to go.
    expect(saveProjectRepositories(s, "beta", [{ alias: "app", path: "beta-app", writable: true }])).toEqual({ ok: true });
    expect(saveProjectRepositories(s, "alpha", [{ alias: "docs", path: "alpha-docs", writable: true }])).toEqual({ ok: true });

    // Many tasks: the message names three and counts the rest.
    const more = await s.submitTasks(Array.from({ length: 6 }, (_, i) => summarizeTask({ goal: `g${i}`, repositoryAliases: ["docs"] })), { project: "alpha" });
    const many = saveProjectRepositories(s, "alpha", []);
    expect(!many.ok && many.fieldErrors.form?.[0]).toMatch(/^repository docs is used by 7 unfinished tasks \([^)]+ and 4 more\)/);

    // An interrupted task can be resumed, so it still holds the repository.
    const ids = [t1!, ...more].map((m) => m.taskId);
    s.db.prepare("UPDATE tasks SET state = 'cancelled' WHERE id IN (" + ids.slice(1).map(() => "?").join(",") + ")").run(...ids.slice(1));
    s.db.prepare("UPDATE tasks SET state = 'interrupted' WHERE id = ?").run(ids[0]);
    const interrupted = saveProjectRepositories(s, "alpha", []);
    expect(!interrupted.ok && interrupted.fieldErrors.form?.[0]).toContain(`used by 1 unfinished task (${ids[0]})`);

    // Once they are done, it can be removed.
    s.db.prepare("UPDATE tasks SET state = 'cancelled' WHERE id IN (" + [t1!, ...more].map(() => "?").join(",") + ")").run(t1!.taskId, ...more.map((m) => m.taskId));
    expect(saveProjectRepositories(s, "alpha", [])).toEqual({ ok: true });
  });

  it("refuses brain mounts whose folder does not exist, keyed by the mount's field", () => {
    const s = setup();
    mkdirSync(path.join(env!.dir, "notes"));
    writeFileSync(path.join(env!.dir, "a-file"), "x");
    const missing = saveProjectSettings(s, "alpha", [{ path: ["brain", "mounts"], value: [{ prefix: "projects/alpha/notes", path: "notes" }, { prefix: "projects/alpha/gone", path: "gone" }] }]);
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.fieldErrors["brain.mounts.1.path"]?.[0]).toBe(`${path.join(env!.dir, "gone")} does not exist or is not a folder; create it first`);
    expect(missing.fieldErrors["brain.mounts.0.path"]).toBeUndefined();
    const file = saveProjectSettings(s, "alpha", [{ path: ["brain"], value: { mounts: [{ prefix: "projects/alpha/f", path: "a-file" }] } }]);
    expect(!file.ok && Object.keys(file.fieldErrors)).toEqual(["brain.mounts.0.path"]);
    const one = saveProjectSettings(s, "alpha", [{ path: ["brain", "mounts", 0, "path"], value: "gone" }]);
    expect(!one.ok && Object.keys(one.fieldErrors)).toEqual(["brain.mounts.0.path"]);
    expect(saveProjectSettings(s, "alpha", [{ path: ["brain", "mounts"], value: [{ prefix: "projects/alpha/notes", path: "notes" }] }])).toEqual({ ok: true });
  });
});
