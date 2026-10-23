import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import type { MeritRouter } from "../src/core/service.js";
import type { ChatRequest } from "../src/gateway/types.js";
import { Brain } from "../src/brain/brain.js";
import { BrainAccess, type Principal } from "../src/brain/access.js";
import type { PromotionReviewPort, PromotionReviewRequest } from "../src/brain/promotion.js";
import { PROMOTION_RUBRIC_VERSION } from "../src/verification/promotion-review.js";
import { ProjectRegistry } from "../src/projects/registry.js";
import { openDatabase, type Db } from "../src/storage/db.js";
import { parseConfig } from "../src/config/load.js";
import type { Actor } from "../src/attribution/index.js";
import { baseConfig, commitAll, endpoint, FakeProvider, goodOutput, makeEnv, open, reply, ScriptedClient, servedFor, type Env } from "./helpers.js";

let env: Env | undefined;
let sy: MeritRouter | undefined;
let db: Db | undefined;
afterEach(async () => {
  await sy?.close();
  sy = undefined;
  db?.close();
  db = undefined;
  env?.cleanup();
  env = undefined;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(get: () => T | Promise<T>, ok: (v: T) => boolean, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await get();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting; last value ${JSON.stringify(v).slice(0, 400)}`);
    await sleep(50);
  }
}

function gitRepo(dir: string, files: Record<string, string>): void {
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, stdio: "pipe" });
  commitAll(dir, "init");
}

// The supervisor's model (family "alpha") and an independent reviewer (family "beta").
const SUPERVISOR_EP = endpoint({ providerId: "openrouter", gatewayModelId: "alpha/alpha-1:free", totalParametersB: 700 });
const SUPERVISOR_EP2 = endpoint({ providerId: "groq", gatewayModelId: "alpha/alpha-2", totalParametersB: 400 });
const REVIEWER_EP = endpoint({ providerId: "groq", gatewayModelId: "beta/beta-2", totalParametersB: 400 });

/** Two projects: alpha ("Acme Storefront", repository `web`) and beta (repository `app`). */
function twoProjects(extra: Record<string, unknown> = {}, endpoints: unknown[] = [SUPERVISOR_EP, REVIEWER_EP]): Env {
  const cfg = {
    ...baseConfig(),
    repositories: {},
    routing: { escalate_on_failure: false },
    team: { provider_concurrency_enabled: false },
    projects: {
      alpha: { name: "Acme Storefront", repositories: { web: { path: "alpha-web" } } },
      beta: { repositories: { app: { path: "beta-app" } } },
    },
    ...extra,
  };
  const e = makeEnv({ config: cfg, endpoints });
  gitRepo(path.join(e.dir, "alpha-web"), { "src/payments/ledger.ts": "export const ledger = [];\n" });
  gitRepo(path.join(e.dir, "beta-app"), { "src/app.ts": "export const who = 'beta';\n" });
  return e;
}

const actorOf = (p: string, model: string | null = SUPERVISOR_EP.id): Actor => ({ agent: `supervisor:${p}-job`, role: "supervisor", model, job: `${p}-job` });
const supervisorOf = (access: BrainAccess, project: string, repos: string[]): Principal => access.principalFor("supervisor", { project, effort: "job-1", task: null, repos, jobId: null, tier: "T3" });
const workerOf = (access: BrainAccess, project: string, extraGrants: Array<{ pattern: string; mode: "read" | "append" | "write" }> = []): Principal =>
  access.principalFor("inspector", { project, effort: "job-1", task: "t_w1", repos: [], jobId: "j1", tier: "T2", briefGrants: extraGrants });

const GENERIC = {
  title: "Retry idempotent calls with jittered backoff",
  body: "When a remote call is idempotent, retry transient failures (timeouts, rate limits, server errors) with exponential backoff and jitter, and cap the attempts so an outage of a dependency cannot exhaust the request budget.",
};

async function seedSource(brain: Brain, p: Principal, project: string): Promise<string> {
  const rel = `projects/${project}/decisions/retries.md`;
  await brain.write(p, actorOf(project), rel, "# Retries\n\nThe outage on Tuesday was made worse by retries without backoff; adding jittered backoff fixed it.\n");
  return rel;
}

/** A Brain of one project over the test config, with an in-process reviewer port. */
function brainWithReviewer(e: Env, project: string, port: PromotionReviewPort | null) {
  db = openDatabase(e.cfg.storageDir);
  const ctx = new ProjectRegistry(e.cfg).require(project);
  const brain = new Brain(ctx, db, Date.now, { reviewer: port });
  const access = new BrainAccess(db, ctx);
  return { brain, access, supervisor: supervisorOf(access, project, Object.keys(ctx.repositoryPaths)) };
}

/** A fake independent reviewer: every review starts, and finishes with `verdict`. */
function fakeReviewer(verdict: "pass" | "fail") {
  const started: PromotionReviewRequest[] = [];
  const port: PromotionReviewPort = {
    async start(r) {
      started.push(r);
      return { kind: "started", reviewTaskId: `t_review${started.length}`, reviewer: REVIEWER_EP.id };
    },
    result() {
      return { kind: "verdict", verdict, reasons: verdict === "pass" ? [] : ["beyond_project: it only describes this codebase's checkout"], reviewer: REVIEWER_EP.id, reviewerModel: "beta/beta-2", rubric: PROMOTION_RUBRIC_VERSION };
    },
  };
  return { port, started };
}

function frontMatterOf(text: string): Record<string, unknown> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) throw new Error(`no front matter in ${text.slice(0, 200)}`);
  return YAML.parse(m[1]!) as Record<string, unknown>;
}

const globalLessons = (brain: Brain) => {
  const dir = path.join(brain.root, "global", "lessons");
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".md")) : [];
};

describe("project brain index", () => {
  it("links each working document relative to the index, so every link resolves to an existing file", async () => {
    env = twoProjects();
    sy = open(env, new FakeProvider());
    const a = sy.brainFor("alpha");
    const supA = supervisorOf(sy.brainAccessFor("alpha"), "alpha", ["web"]);
    await a.createWorkingDoc(supA, actorOf("alpha"), "launch", { title: "Alpha launch", statusDetail: "started", owner: "supervisor", scope: "launch alpha", currentState: "Under way." });
    await a.regenerateIndex(actorOf("alpha"));
    const index = readFileSync(path.join(a.root, "projects", "alpha", "README.md"), "utf8");
    const links = [...index.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]!);
    expect(links).toEqual(["working/launch.md"]);
    // Resolved against the index's folder, as the panel and any markdown viewer do.
    for (const l of links) expect(existsSync(path.join(a.root, "projects", "alpha", l))).toBe(true);
  });
});

describe("project brain isolation (D4)", () => {
  it("a supervisor of one project reads its project and global/, never another project's working documents", async () => {
    env = twoProjects();
    sy = open(env, new FakeProvider());
    const a = sy.brainFor("alpha");
    const b = sy.brainFor("beta");
    const supA = supervisorOf(sy.brainAccessFor("alpha"), "alpha", ["web"]);
    const supB = supervisorOf(sy.brainAccessFor("beta"), "beta", ["app"]);
    await b.createWorkingDoc(supB, actorOf("beta"), "launch", { title: "Beta launch", statusDetail: "started", owner: "supervisor", scope: "launch beta", currentState: "Zanzibar migration is half done." });
    await a.createWorkingDoc(supA, actorOf("alpha"), "launch", { title: "Alpha launch", statusDetail: "started", owner: "supervisor", scope: "launch alpha", currentState: "Zanzibar is not used here." });
    const betaDoc = "projects/beta/working/launch.md";

    // The default grants: own project (write), global/ (read), nothing else.
    expect(supA.kind === "agent" && supA.grants.map((g) => g.pattern)).toEqual(["global/**", "projects/alpha/**"]);
    expect(() => a.read(supA, betaDoc)).toThrow(/no read access to projects\/beta\/working\/launch\.md/);
    expect(a.read(supA, "projects/alpha/working/launch.md", { section: "Current State" }).content).toContain("Zanzibar is not used");
    expect(a.read(supA, "global/glossary.md").content).toContain("Glossary");
    expect(a.list(supA, "projects/beta")).toEqual([]);
    expect(a.list(supA).map((e) => e.path)).not.toContain(betaDoc);
    await expect(a.write(supA, actorOf("alpha"), "projects/beta/decisions/x.md", "# x\n")).rejects.toThrow(/no write access/);

    // Search is restricted to what the caller can read, in the query itself.
    await a.refreshIndex();
    await b.refreshIndex();
    expect(a.search(supA, "Zanzibar").map((h) => h.path)).toEqual(["projects/alpha/working/launch.md"]);
    expect(b.search(supB, "Zanzibar").map((h) => h.path)).toEqual([betaDoc]);
    // One project's index refresh leaves the other's rows alone.
    await a.refreshIndex();
    expect(b.search(supB, "Zanzibar").map((h) => h.path)).toEqual([betaDoc]);
    // A person sees both, or one project with scope "project".
    expect(a.search({ kind: "human" }, "Zanzibar").map((h) => h.path).sort()).toEqual(["projects/alpha/working/launch.md", betaDoc]);
    expect(a.search({ kind: "human" }, "Zanzibar", { scope: "project" }).map((h) => h.path)).toEqual(["projects/alpha/working/launch.md"]);

    // Cross-project reads go through the access-request flow: a granted read reaches the entry.
    const access = sy.brainAccessFor("alpha");
    const worker = workerOf(access, "alpha");
    const req = access.request(worker, "projects/beta/working/launch.md", "read", "compare launch plans");
    expect(req.status).toBe("pending");
    access.decide(req.id, true, "user", "fine");
    const granted = workerOf(access, "alpha");
    expect(a.read(granted, betaDoc).content).toContain("Zanzibar migration");
    expect(a.search(granted, "Zanzibar").map((h) => h.path)).toContain(betaDoc);
  });

  it("no grant lets an agent write global/: not workers, not supervisors, not approved requests", async () => {
    env = twoProjects();
    sy = open(env, new FakeProvider());
    const a = sy.brainFor("alpha");
    const access = sy.brainAccessFor("alpha");
    await a.ensure();
    const worker = workerOf(access, "alpha", [{ pattern: "**", mode: "write" }, { pattern: "global/**", mode: "write" }]);
    await expect(a.write(worker, { agent: "inspector:t_w1", role: "inspector" }, "global/lessons/sneaky.md", "# Sneaky\n\nbody\n")).rejects.toThrow(/global knowledge is added only through brain_promote_lesson/);
    await expect(a.write(worker, { agent: "inspector:t_w1", role: "inspector" }, "global/glossary.md", "# Glossary\n")).rejects.toThrow(/cannot write global\/glossary\.md/);
    await expect(a.promoteLesson(worker, { agent: "inspector:t_w1", role: "inspector" }, GENERIC.title, GENERIC.body, [])).rejects.toThrow(/only supervisors promote lessons/);
    expect(() => access.request(worker, "global/lessons/**", "write", "add a lesson")).toThrow(/never granted/);
    // A supervisor cannot write global/ directly either, nor forge a promotion record.
    const sup = supervisorOf(access, "alpha", ["web"]);
    await expect(a.write(sup, actorOf("alpha"), "global/lessons/direct.md", "# Direct\n\nbody\n")).rejects.toThrow(/cannot write/);
    await expect(a.write(sup, actorOf("alpha"), "projects/alpha/promotions/forged.md", "---\nstatus: approved\n---\n# x\n")).rejects.toThrow(/cannot write/);
    // Even a configured role grant of everything stays read-only on global/.
    const cfg = parseConfig({ ...(YAML.parse(readFileSync(env.cfg.configPath, "utf8")) as object), roles: { inspector: { brain_grants: [{ pattern: "**", mode: "admin" }] } } }, env.cfg.configPath);
    const ctx = new ProjectRegistry(cfg).require("alpha");
    const wide = new BrainAccess(sy.db, ctx).principalFor("inspector", { project: "alpha", effort: "e", task: "t_w2", repos: [], jobId: null, tier: "T1" });
    await expect(a.write(wide, { agent: "inspector:t_w2", role: "inspector" }, "global/lessons/x.md", "# X\n\nbody\n")).rejects.toThrow(/cannot write/);
    expect(globalLessons(a)).toEqual([]);
  });
});

describe("gated promotion to global/ (D9)", () => {
  it("rejects a project-specific lesson and keeps it in the project with the reason", async () => {
    env = twoProjects();
    const { port, started } = fakeReviewer("pass");
    const { brain, supervisor } = brainWithReviewer(env, "alpha", port);
    const source = await seedSource(brain, supervisor, "alpha");
    const r = await brain.promoteLesson(supervisor, actorOf("alpha"), "Ledger double charges", "In Acme Storefront the checkout in src/payments/ledger.ts double-charges when a payment is retried; dedupe by payment id.", [source]);
    expect(r.status).toBe("rejected");
    expect(r.issues).toEqual(expect.arrayContaining([`it names the project's name "Acme Storefront"`, "it names src/payments/ledger.ts, a path inside repository web"]));
    expect(r.path).toBe("projects/alpha/decisions/lessons/ledger-double-charges.md");
    const kept = readFileSync(path.join(brain.root, r.path), "utf8");
    expect(kept).toContain("double-charges when a payment is retried");
    expect(kept).toContain("> Not promoted to global knowledge: not global knowledge: ");
    expect(frontMatterOf(kept)).toMatchObject({ kind: "project_lesson", project: "alpha", sources: [source], proposed_by: "supervisor:alpha-job" });
    expect(globalLessons(brain)).toEqual([]);
    expect(started).toEqual([]); // the check rejects before any review is spent
    const [rec] = brain.promotions.list();
    expect(rec).toMatchObject({ status: "rejected", lesson_path: r.path, decided_by: "meritrouter (project-specificity check)" });
    expect(rec!.reason).toContain("a path inside repository web");

    // The slug, a repository alias, and a missing project source are each refused too.
    const slug = await brain.promoteLesson(supervisor, actorOf("alpha"), "Alpha deploys", "Deploy alpha on Fridays only after the web smoke test.", [source]);
    expect(slug.issues).toEqual(expect.arrayContaining([`it names the project's slug "alpha"`, `it names repository alias "web"`]));
    const unsourced = await brain.promoteLesson(supervisor, actorOf("alpha"), GENERIC.title, GENERIC.body, ["global/glossary.md"]);
    expect(unsourced.status).toBe("rejected");
    expect(unsourced.issues.join("; ")).toMatch(/cite at least one existing source in the project's brain/);
    const missing = await brain.promoteLesson(supervisor, actorOf("alpha"), GENERIC.title, GENERIC.body, ["projects/alpha/decisions/nope.md", "projects/beta/working/x.md"]);
    expect(missing.issues.join("; ")).toMatch(/nope\.md does not exist in the brain.*projects\/beta\/working\/x\.md is not in this project's brain/);
    expect(globalLessons(brain)).toEqual([]);
  });

  it("a generic lesson that passes an independent review lands in global/ with provenance", async () => {
    env = twoProjects();
    const { port, started } = fakeReviewer("pass");
    const { brain, supervisor } = brainWithReviewer(env, "alpha", port);
    const source = await seedSource(brain, supervisor, "alpha");
    const r = await brain.promoteLesson(supervisor, actorOf("alpha"), GENERIC.title, GENERIC.body, [source]);
    expect(r.status).toBe("pending_review");
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ project: "alpha", candidate: { title: GENERIC.title }, supervisor: { model: SUPERVISOR_EP.id } });
    expect(started[0]!.sources[0]).toMatchObject({ path: source });
    expect(started[0]!.sources[0]!.text).toContain("jittered backoff fixed it");
    expect(globalLessons(brain)).toEqual([]);

    expect(await brain.promotions.settle()).toBe(1);
    const rec = brain.promotions.get(r.id!)!;
    expect(rec).toMatchObject({ status: "approved", global_path: "global/lessons/retry-idempotent-calls-with-jittered-backoff.md", decided_by: "meritrouter (review passed)" });
    const text = readFileSync(path.join(brain.root, rec.global_path!), "utf8");
    expect(text).toContain(GENERIC.body);
    expect(frontMatterOf(text)).toMatchObject({
      kind: "lesson",
      promotion: r.id,
      project: "alpha",
      promoted_by: "supervisor:alpha-job",
      supervisor_model: SUPERVISOR_EP.id,
      sources: [source],
      review: { verdict: "pass", reviewer: REVIEWER_EP.id, reviewer_model: "beta/beta-2", review_task: "t_review1", rubric: PROMOTION_RUBRIC_VERSION },
      approved_by: "meritrouter (review passed)",
    });
    // Settling again changes nothing; the lesson is readable by every project's agents.
    expect(await brain.promotions.settle()).toBe(0);
    expect(brain.read(supervisor, rec.global_path!).content).toContain(GENERIC.body);

    // A failing review keeps the lesson in the project with the reviewer's reasons.
    const failing = fakeReviewer("fail");
    const second = brainWithReviewerSame(brain, failing.port);
    const r2 = await second.promoteLesson(supervisor, actorOf("alpha"), "Batch small writes", "Group many small writes into one transaction; per-write commits dominate the cost of bulk loads.", [source]);
    await second.promotions.settle();
    const rec2 = second.promotions.get(r2.id!)!;
    expect(rec2.status).toBe("rejected");
    expect(rec2.lesson_path).toBe("projects/alpha/decisions/lessons/batch-small-writes.md");
    expect(readFileSync(path.join(brain.root, rec2.lesson_path!), "utf8")).toContain("only describes this codebase's checkout");
    expect(globalLessons(brain)).toEqual(["retry-idempotent-calls-with-jittered-backoff.md"]);
  });

  it("with brain.global_requires_approval a passed promotion waits for a person", async () => {
    env = twoProjects({ brain: { path: "brain", project: "alpha", global_requires_approval: true } });
    const { port } = fakeReviewer("pass");
    const { brain, supervisor } = brainWithReviewer(env, "alpha", port);
    const source = await seedSource(brain, supervisor, "alpha");
    const r = await brain.promoteLesson(supervisor, actorOf("alpha"), GENERIC.title, GENERIC.body, [source]);
    await brain.promotions.settle();
    const held = brain.promotions.get(r.id!)!;
    expect(held).toMatchObject({ status: "pending_approval", global_path: null, review: { verdict: "pass", reviewer_model: "beta/beta-2" } });
    expect(brain.promotions.list({ status: "pending_approval" }).map((p) => p.id)).toEqual([r.id]);
    expect(globalLessons(brain)).toEqual([]);
    // Agents cannot approve; a person can.
    await expect(brain.promotions.approve(supervisor, r.id!)).rejects.toThrow(/only a person/);
    const done = await brain.promotions.approve({ kind: "human", name: "panel:aiden" }, r.id!);
    expect(done).toMatchObject({ status: "approved", decided_by: "panel:aiden" });
    expect(frontMatterOf(readFileSync(path.join(brain.root, done.global_path!), "utf8"))).toMatchObject({ approved_by: "panel:aiden", review: { verdict: "pass" }, project: "alpha" });
  });

  it("with no eligible reviewer the promotion waits as pending, never approved", async () => {
    // Every model shares the supervisor's family.
    env = twoProjects({}, [SUPERVISOR_EP, SUPERVISOR_EP2]);
    sy = open(env, new FakeProvider());
    const brain = sy.brainFor("alpha");
    const supervisor = supervisorOf(sy.brainAccessFor("alpha"), "alpha", ["web"]);
    const source = await seedSource(brain, supervisor, "alpha");
    const r = await brain.promoteLesson(supervisor, actorOf("alpha"), GENERIC.title, GENERIC.body, [source]);
    expect(r.status).toBe("pending_review");
    expect(r.reason).toMatch(/no eligible reviewer.*\(alpha\)/);
    expect(sy.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE purpose = 'promotion_review'").get()).toEqual({ n: 0 });
    expect(await sy.settlePromotions()).toBe(0);
    expect(sy.promotions({ status: "pending_review" }).map((p) => p.id)).toEqual([r.id]);
    expect(sy.promotions({ project: "beta" })).toEqual([]);
    expect(globalLessons(brain)).toEqual([]);
    // A person may still decide it.
    const done = await sy.decidePromotion("alpha", r.id!, true, "cli:aiden");
    expect(done.status).toBe("approved");
    expect(globalLessons(brain)).toEqual(["retry-idempotent-calls-with-jittered-backoff.md"]);
  });

  it("runs the review as a task through the Gate on another model family and settles it when the task finishes", async () => {
    env = twoProjects();
    const userText = (req: ChatRequest) => String(req.messages[1]?.content ?? "");
    const reviewed: string[] = [];
    sy = open(
      env,
      new ScriptedClient((req) => {
        const s = servedFor(sy!, req);
        const t = userText(req);
        if (!t.includes("Promotion review:")) throw new Error("unexpected request");
        reviewed.push(`${s.provider}/${s.model}`);
        const ids = [...t.matchAll(/^- (\S+) \[verify: /gm)].map((m) => m[1]!);
        const verdict = {
          verdict: "pass",
          examinedRevision: /examinedRevision: (\S+)/.exec(t)![1]!,
          policyVersion: /policyVersion: (\S+)/.exec(t)![1]!,
          criteria: ids.map((id) => ({ id, outcome: "pass", evidenceRefs: ["inline"] })),
          blockingFindings: [],
          missingEvidence: [],
          recommendedAction: "accept",
        };
        const output = JSON.stringify({ ...goodOutput(1, "inline"), data: verdict });
        // A completion review answers in its content; a tool-using runner would call submit_result.
        if (req.tools?.some((x) => x.function.name === "submit_result")) return reply(null, { ...s, toolCalls: [{ id: "c1", type: "function", function: { name: "submit_result", arguments: output } }] });
        return reply(output, s);
      }),
      { worker: true },
    );
    const brain = sy.brainFor("alpha");
    const supervisor = supervisorOf(sy.brainAccessFor("alpha"), "alpha", ["web"]);
    const source = await seedSource(brain, supervisor, "alpha");
    const r = await brain.promoteLesson(supervisor, actorOf("alpha"), GENERIC.title, GENERIC.body, [source]);
    expect(r.status).toBe("pending_review");
    // Approved once the global lesson is written (the record names it).
    const rec = await until(() => brain.promotions.get(r.id!)!, (x) => x.status === "rejected" || x.global_path !== null);
    expect(rec.status).toBe("approved");
    expect(reviewed).toEqual(["groq/beta/beta-2"]);
    const task = sy.tasks.get(rec.review.task_id!)!;
    expect(task.row.project_id).toBe("alpha");
    expect(task.spec).toMatchObject({ profile: "summarize", label: "promotion-review", routing: { endpointId: REVIEWER_EP.id }, budget: { maxPaidUsd: 0 } });
    expect(sy.db.prepare("SELECT purpose FROM tasks WHERE id = ?").get(task.row.id)).toEqual({ purpose: "promotion_review" });
    // The request went through the Gate and is charged to the review task.
    expect(sy.gate.admission.taskTotals(task.row.id).requests).toBeGreaterThan(0);
    const fm = frontMatterOf(readFileSync(path.join(brain.root, rec.global_path!), "utf8"));
    expect(fm).toMatchObject({ project: "alpha", review: { verdict: "pass", reviewer: REVIEWER_EP.id, reviewer_model: "beta/beta-2", review_task: task.row.id } });
  }, 90_000);
});

/** Another Brain of the same project and database, with a different reviewer port. */
function brainWithReviewerSame(brain: Brain, port: PromotionReviewPort): Brain {
  const ctx = new ProjectRegistry(env!.cfg).require(brain.project);
  return new Brain(ctx, db!, Date.now, { reviewer: port });
}
