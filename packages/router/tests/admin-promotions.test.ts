import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { Switchyard } from "../src/core/service.js";
import type { Principal } from "../src/brain/access.js";
import type { PromotionReviewPort } from "../src/brain/promotion.js";
import { PROMOTION_RUBRIC_VERSION } from "../src/verification/promotion-review.js";
import type { Actor } from "../src/attribution/index.js";
import { decideGlobalPromotion, globalKnowledge, globalReverts, parseGlobalProvenance, promotionsView, revertGlobalEntry } from "../src/admin/promotions.js";
import { baseConfig, commitAll, endpoint, FakeProvider, makeEnv, open, type Env } from "./helpers.js";

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

function gitRepo(dir: string, files: Record<string, string>): void {
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, stdio: "pipe" });
  commitAll(dir, "init");
}

/** Two projects with a temp brain; `approval` turns on brain.global_requires_approval. */
function setup(approval: boolean): Switchyard {
  const cfg = {
    ...baseConfig(),
    repositories: {},
    brain: { path: "brain", project: "alpha", global_requires_approval: approval },
    projects: {
      alpha: { name: "Acme Storefront", repositories: { web: { path: "alpha-web" } } },
      beta: { repositories: { svc: { path: "beta-svc" } } },
    },
  };
  env = makeEnv({ config: cfg, endpoints: [SUPERVISOR_EP, REVIEWER_EP] });
  gitRepo(path.join(env.dir, "alpha-web"), { "src/index.ts": "export {};\n" });
  gitRepo(path.join(env.dir, "beta-svc"), { "src/index.ts": "export {};\n" });
  sy = open(env, new FakeProvider());
  return sy;
}

/** Replace the service's reviewer with one whose reviews pass (`running` keeps them running). */
function fakeReviewer(s: Switchyard, opts: { running?: boolean } = {}): void {
  let n = 0;
  const port: PromotionReviewPort = {
    async start() {
      return { kind: "started", reviewTaskId: `t_review${++n}`, reviewer: REVIEWER_EP.id };
    },
    result() {
      if (opts.running) return { kind: "running" };
      return { kind: "verdict", verdict: "pass", reasons: ["beyond_project: holds for any service"], reviewer: REVIEWER_EP.id, reviewerModel: "beta/beta-2", rubric: PROMOTION_RUBRIC_VERSION };
    },
  };
  (s as unknown as { promotionReviewer: PromotionReviewPort }).promotionReviewer = port;
}

const actorOf = (p: string): Actor => ({ agent: `supervisor:${p}-job`, role: "supervisor", model: SUPERVISOR_EP.id, job: `${p}-job` });
const supervisorOf = (s: Switchyard, project: string): Principal =>
  s.brainAccessFor(project).principalFor("supervisor", { project, effort: "job-1", task: null, repos: Object.keys(s.projects.require(project).repositoryPaths), jobId: null, tier: "T3" });

const LESSONS = [
  { title: "Retry idempotent calls with jittered backoff", body: "When a remote call is idempotent, retry transient failures with exponential backoff and jitter, and cap the attempts." },
  { title: "Pin dependency versions in lock files", body: "Commit the lock file so every machine installs the same dependency tree; upgrade deliberately, one change at a time." },
];

async function promote(s: Switchyard, project: string, lesson: { title: string; body: string }): Promise<string> {
  const brain = s.brainFor(project);
  const sup = supervisorOf(s, project);
  const source = `projects/${project}/decisions/notes-${lesson.title.length}.md`;
  await brain.write(sup, actorOf(project), source, "# Notes\n\nWhat we learned this week.\n");
  const r = await brain.promoteLesson(sup, actorOf(project), lesson.title, lesson.body, [source]);
  await brain.promotions.settle();
  return r.id!;
}

const git = (repo: string, ...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

describe("admin promotions: global knowledge for people (D9)", () => {
  it("lists promotions awaiting a person and lets a person approve (into global/ with provenance) or reject (reason required)", async () => {
    const s = setup(true);
    fakeReviewer(s);
    const a = await promote(s, "alpha", LESSONS[0]!);
    const b = await promote(s, "beta", LESSONS[1]!);

    const waiting = promotionsView(s, { status: "awaiting_person" });
    expect(waiting.map((p) => [p.project, p.status, p.awaitingPerson]).sort()).toEqual([
      ["alpha", "pending_approval", true],
      ["beta", "pending_approval", true],
    ]);
    expect(promotionsView(s, { project: "beta" }).map((p) => p.id)).toEqual([b]);
    expect((await globalKnowledge(s)).lessons).toEqual([]);
    expect((await globalKnowledge(s)).requiresApproval).toBe(true);

    // Validation: project, id, reason.
    await expect(decideGlobalPromotion(s, "nope", a, true, "panel")).rejects.toMatchObject({ code: "not_found" });
    expect(() => promotionsView(s, { project: "nope" })).toThrow(/unknown project/);
    await expect(decideGlobalPromotion(s, "alpha", "../x", true, "panel")).rejects.toMatchObject({ code: "task_invalid" });
    await expect(decideGlobalPromotion(s, "beta", a, true, "panel")).rejects.toMatchObject({ code: "not_found" });
    await expect(decideGlobalPromotion(s, "beta", b, false, "panel", "  ")).rejects.toMatchObject({ code: "reason_required" });

    const approved = await decideGlobalPromotion(s, "alpha", a, true, "panel");
    expect(approved).toMatchObject({ status: "approved", decided_by: "panel", awaitingPerson: false });
    await expect(decideGlobalPromotion(s, "alpha", a, false, "panel", "late")).rejects.toMatchObject({ code: "usage" });

    const rejected = await decideGlobalPromotion(s, "beta", b, false, "panel", "Only true for our build setup");
    expect(rejected).toMatchObject({ status: "rejected", decided_by: "panel" });
    expect(rejected.reason).toMatch(/Only true for our build setup/);
    expect(existsSync(path.join(s.brain.root, rejected.lesson_path!))).toBe(true);

    const k = await globalKnowledge(s);
    expect(k.lessons).toHaveLength(1);
    const lesson = k.lessons[0]!;
    expect(lesson).toMatchObject({ path: approved.global_path, title: LESSONS[0]!.title, kind: "lesson", revertable: true });
    expect(lesson.body).toContain("exponential backoff");
    expect(lesson.provenance).toMatchObject({
      project: "alpha",
      promotion: a,
      promotedBy: "supervisor:alpha-job",
      supervisorModel: SUPERVISOR_EP.id,
      approvedBy: "panel",
      review: { verdict: "pass", reviewer: REVIEWER_EP.id, reviewerModel: "beta/beta-2", rubric: PROMOTION_RUBRIC_VERSION },
    });
    expect(lesson.provenance!.sources[0]).toMatch(/^projects\/alpha\/decisions\//);
    expect(k.glossary).toMatchObject({ path: "global/glossary.md", kind: "glossary", revertable: false });
    expect(promotionsView(s, { status: "awaiting_person" })).toEqual([]);
  });

  it("a promotion under review cannot be decided; one with no review running (no reviewer) can", async () => {
    const s = setup(false);
    fakeReviewer(s, { running: true });
    const a = await promote(s, "alpha", LESSONS[0]!);
    const view = promotionsView(s, { project: "alpha" })[0]!;
    expect(view).toMatchObject({ id: a, status: "pending_review", awaitingPerson: false });
    await expect(decideGlobalPromotion(s, "alpha", a, true, "panel")).rejects.toThrow(/under review/);

    // Without a reviewer the next one waits for a person, who may decide it.
    (s as unknown as { promotionReviewer: null }).promotionReviewer = null;
    const b = await promote(s, "alpha", LESSONS[1]!);
    expect(promotionsView(s, { status: "awaiting_person" }).map((p) => p.id)).toEqual([b]);
    const done = await decideGlobalPromotion(s, "alpha", b, true, "panel", "Generic advice");
    expect(done.status).toBe("approved");
    expect(existsSync(path.join(s.brain.root, done.global_path!))).toBe(true);
  });

  it("reverts a global entry with one recorded commit, keeps its history, and never resurrects it", async () => {
    const s = setup(false);
    fakeReviewer(s);
    const a = await promote(s, "alpha", LESSONS[0]!);
    const record = s.brainFor("alpha").promotions.get(a)!;
    expect(record.status).toBe("approved");
    const rel = record.global_path!;
    const root = s.brain.root;
    await s.brain.refreshIndex();
    expect(s.brain.search({ kind: "human" }, "jittered backoff").map((h) => h.path)).toContain(rel);

    // Validation.
    await expect(revertGlobalEntry(s, rel, "panel", "   ")).rejects.toMatchObject({ code: "reason_required" });
    await expect(revertGlobalEntry(s, "global/glossary.md", "panel", "x")).rejects.toMatchObject({ code: "task_invalid" });
    await expect(revertGlobalEntry(s, "projects/alpha/decisions/x.md", "panel", "x")).rejects.toMatchObject({ code: "task_invalid" });
    await expect(revertGlobalEntry(s, "global/../projects/alpha/x.md", "panel", "x")).rejects.toMatchObject({ code: "task_invalid" });
    await expect(revertGlobalEntry(s, "../outside.md", "panel", "x")).rejects.toMatchObject({ code: "task_invalid" });
    await expect(revertGlobalEntry(s, "global/lessons/missing.md", "panel", "x")).rejects.toMatchObject({ code: "not_found" });

    const out = await revertGlobalEntry(s, rel, "panel", "Too broad:\nit is wrong for batch jobs");
    expect(out).toMatchObject({ path: rel, revertedBy: "panel", reason: "Too broad: it is wrong for batch jobs", title: LESSONS[0]!.title, promotion: a, project: "alpha" });
    expect(existsSync(path.join(root, rel))).toBe(false);
    expect(existsSync(path.join(root, ".switchyard-brain.lock"))).toBe(false);

    // One commit, made as a person, removing only that file, with who and why in its trailers.
    // The revert commit, then the promotion record's update to `reverted` (projects-followups.test.ts covers that).
    expect(git(root, "rev-parse", "HEAD~1").trim()).toBe(out.commit);
    expect(git(root, "show", "--name-status", "--format=", out.commit).trim()).toBe(`D\t${rel}`);
    const msg = git(root, "log", "-1", "--format=%an%n%B", out.commit);
    expect(msg).toMatch(/^human\n/);
    expect(msg).toContain(`Revert global entry ${rel}`);
    expect(msg).toContain("Reverted-By: panel");
    expect(msg).toContain("Revert-Reason: Too broad: it is wrong for batch jobs");
    expect(msg).toContain(`Promotion: ${a}`);
    // The removed text is still in the history.
    expect(git(root, "show", `${out.commit}^:${rel}`)).toContain("exponential backoff");

    const reverts = await globalReverts(s);
    expect(reverts[0]).toMatchObject({ commit: out.commit, paths: [rel], revertedBy: "panel", reason: "Too broad: it is wrong for batch jobs", title: LESSONS[0]!.title, promotion: a, project: "alpha" });
    const k = await globalKnowledge(s);
    expect(k.lessons).toEqual([]);
    expect(k.reverts.map((r) => r.commit)).toEqual([out.commit]);
    // Out of the search index too, and a settle does not write it back (the record still names where it went).
    expect(s.brain.search({ kind: "human" }, "jittered backoff").map((h) => h.path)).not.toContain(rel);
    await s.settlePromotions();
    expect(existsSync(path.join(root, rel))).toBe(false);
    expect(s.brainFor("alpha").promotions.get(a)).toMatchObject({ status: "reverted", global_path: rel });
    await expect(revertGlobalEntry(s, rel, "panel", "again")).rejects.toMatchObject({ code: "not_found" });
  });

  it("reverts an entry a person added outside SwitchYard (never committed) and reads hand-written entries without provenance", async () => {
    const s = setup(false);
    await s.brain.ensure();
    const rel = "global/facts/timezones.md";
    mkdirSync(path.join(s.brain.root, "global/facts"), { recursive: true });
    writeFileSync(path.join(s.brain.root, rel), "# Store times in UTC\n\nConvert at the edges.\n");
    const k = await globalKnowledge(s);
    expect(k.other).toMatchObject([{ path: rel, title: "Store times in UTC", kind: "other", provenance: null, revertable: true }]);
    const out = await revertGlobalEntry(s, rel, "panel", "Duplicate of a lesson");
    expect(git(s.brain.root, "show", `${out.commit}^:${rel}`)).toContain("Convert at the edges");
    expect(out).toMatchObject({ promotion: null, project: null });
    expect((await globalKnowledge(s)).other).toEqual([]);
  });

  it("parses provenance defensively", () => {
    expect(parseGlobalProvenance("# Plain\n\nText\n")).toEqual({ provenance: null, body: "Text", title: "Plain" });
    expect(parseGlobalProvenance("---\n: [bad\n---\n\n# T\n\nB\n").provenance).toBeNull();
    const p = parseGlobalProvenance("---\nkind: lesson\nproject: alpha\nsources: nope\nreview: 7\npromoted_at: 2026-10-20T00:00:00.000Z\n---\n\n# T\n\nB\n");
    expect(p.provenance).toMatchObject({ project: "alpha", sources: [], review: null, promotedBy: null });
    expect(p.provenance!.promotedAt).toMatch(/^2026-10-20/);
  });
});
