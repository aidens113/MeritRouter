import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { globalKnowledge, globalReverts, revertGlobalEntry, decideGlobalPromotion, promotionsView } from "../src/admin/promotions.js";
import type { ProjectRuntimeBundle } from "../src/projects/runtime-registry.js";
import { capturedLease } from "../src/storage/task-leases.js";
import { baseConfig, commitAll, FakeProvider, makeEnv, open } from "./helpers.js";

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
function file(root: string, relative: string, content: string) { const target = path.join(root, relative); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, content); }
function repository(root: string, files: Record<string, string>) {
  mkdirSync(root, { recursive: true }); for (const [relative, text] of Object.entries(files)) file(root, relative, text);
  git(root, "init", "-q", "-b", "main"); commitAll(root, "Public knowledge fixture");
}
const lesson = "---\nkind: lesson\nproject: alpha\npromotion: historical-lesson\napproved_by: fixture-human\nsources: [projects/alpha/decisions/source.md]\npromoted_at: '2026-10-30T00:00:00.000Z'\n---\n\n# Bound retries\n\nUse bounded attempts for idempotent operations.\n";

async function fixture(projects = false, mount = false, supervisor = false) {
  const directories = projects ? ["alpha", "beta"].map(slug => ({ slug, directory: mkdtempSync(path.join(tmpdir(), `mr-knowledge-${slug}-`)) })) : [];
  for (const value of directories) cleanup.push(() => rmSync(value.directory, { recursive: true, force: true }));
  const env = makeEnv({ config: baseConfig({ storage: { layout: "split", directory: "coordination" }, repositories: {},
    brain: { path: "public-brain", project: "alpha", global_requires_approval: true, ...(mount ? { mounts: [{ prefix: "global", path: "public-mount", commit: true }] } : {}) },
    ...(supervisor ? { profiles: { ...baseConfig().profiles, supervise: { mode: "supervisor", tools: "supervisor", max_model_requests: 24, max_output_tokens: 2000, classify: "never", min_tier: "T3" } } } : {}),
    projects: Object.fromEntries(directories.map(value => [value.slug, { directory: value.directory, repositories: { core: { path: value.directory } } }])) }) });
  cleanup.push(() => env.cleanup());
  for (const value of directories) cpSync(env.repo, value.directory, { recursive: true });
  const client = new FakeProvider(), sy = open(env, client, { worker: false, panelLifecycle: "passive", labsMonitor: false }); cleanup.push(() => sy.close());
  for (const value of directories) await sy.createSplitProject(value);
  return { env, sy, client, root: path.join(env.dir, mount ? "public-mount" : "public-brain"), directories };
}

it("returns a truthful empty Knowledge page before any split project/global root exists without bootstrapping", async () => {
  const f = await fixture();
  expect(f.sy.projects.slugs()).toEqual([]); expect(existsSync(f.root)).toBe(false);
  expect(await globalKnowledge(f.sy)).toMatchObject({ requiresApproval: true, lessons: [], glossary: null, other: [], reverts: [] });
  expect(existsSync(f.root)).toBe(false);
  for (const table of ["tasks", "brain_files", "brain_fts", "model_requests"]) expect(f.sy.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()).toEqual({ n: 0 });
  expect(f.client.calls).toHaveLength(0);
});

it("reads and human-reverts configured public mounted knowledge, glossary and history even with no project", async () => {
  const f = await fixture(false, true);
  repository(f.root, { "lessons/retries.md": lesson, "glossary.md": "# Glossary\n\nA bounded operation has a finite limit.\n" });
  const before = git(f.root, "rev-parse", "HEAD");
  const page = await globalKnowledge(f.sy);
  expect(page.lessons).toMatchObject([{ path: "global/lessons/retries.md", title: "Bound retries", provenance: { project: "alpha", approvedBy: "fixture-human" } }]);
  expect(page.glossary).toMatchObject({ path: "global/glossary.md", revertable: false });
  expect(git(f.root, "rev-parse", "HEAD")).toBe(before); expect(existsSync(path.join(f.env.dir, "public-brain"))).toBe(false);
  await expect(revertGlobalEntry(f.sy, "global/glossary.md", "fixture-human", "shared file")).rejects.toMatchObject({ code: "task_invalid" });
  await expect(revertGlobalEntry(f.sy, "global/lessons/retries.md", "fixture-human", "  ")).rejects.toMatchObject({ code: "reason_required" });
  const reverted = await revertGlobalEntry(f.sy, "global/lessons/retries.md", "fixture-human", "Superseded by current guidance");
  expect(reverted).toMatchObject({ project: "alpha", promotion: "historical-lesson", promotionStatus: null, revertedBy: "fixture-human" });
  expect(git(f.root, "show", "--name-status", "--format=", reverted.commit)).toBe("D\tlessons/retries.md");
  expect(git(f.root, "show", `${reverted.commit}^:lessons/retries.md`)).toContain("bounded attempts");
  expect(await globalReverts(f.sy)).toMatchObject([{ commit: reverted.commit, paths: ["global/lessons/retries.md"], revertedBy: "fixture-human", reason: "Superseded by current guidance" }]);
  expect((await globalKnowledge(f.sy)).lessons).toEqual([]); expect(f.client.calls).toHaveLength(0);
});

it("shares only explicit public global entries with real split Brains, preserving project namespace/index/approval boundaries", async () => {
  const f = await fixture(true, false, true), a = f.sy.projectStores("alpha") as ProjectRuntimeBundle, b = f.sy.projectStores("beta") as ProjectRuntimeBundle;
  repository(f.root, { "global/lessons/retries.md": lesson, "global/glossary.md": "# Glossary\n\nFinite attempts.\n", "global/facts/time.md": "# Time\n\nUse UTC.\n",
    "projects/alpha/private.md": "private-global-adjacent-canary", "adjacent/private.md": "private-adjacent-canary" });
  await a.brain!.write({ kind: "human" }, { agent: "fixture", role: "human" }, "projects/alpha/decisions/source.md", "# Source\n\nprivate-alpha-canary\n");
  await b.brain!.write({ kind: "human" }, { agent: "fixture", role: "human" }, "projects/beta/decisions/source.md", "# Source\n\nprivate-beta-canary\n");
  const before = git(f.root, "rev-parse", "HEAD"), page = await globalKnowledge(f.sy);
  expect(page.lessons).toHaveLength(1); expect(page.other.map(entry => entry.path)).toEqual(["global/facts/time.md"]);
  expect(JSON.stringify(page)).not.toMatch(/private-global-adjacent-canary|private-adjacent-canary|private-alpha-canary|private-beta-canary/);
  expect(a.brain!.read({ kind: "human" }, "global/lessons/retries.md").content).toBe(lesson);
  expect(a.brain!.list({ kind: "human" }, "global").map(entry => entry.path)).toEqual(["global/facts/time.md", "global/glossary.md", "global/lessons/retries.md"]);
  expect(a.brain!.search({ kind: "human" }, "bounded", { prefix: "global" }).map(entry => entry.path)).toContain("global/lessons/retries.md");
  expect(() => a.brain!.resolve("global/lessons/retries.md")).toThrow(/namespace/);
  await expect(a.brain!.write({ kind: "human" }, { agent: "fixture", role: "human" }, "global/lessons/unreviewed.md", "unreviewed")).rejects.toThrow(/namespace/);
  expect(() => f.sy.globalKnowledge.read("global/../projects/beta/private.md")).toThrow(/only global/);
  expect(f.sy.globalKnowledge.shared.publishApprovedLesson).toBeUndefined();
  expect(f.sy.db.prepare("SELECT COUNT(*) n FROM brain_files").get()).toEqual({ n: 0 });
  expect(a.db.prepare("SELECT COUNT(*) n FROM brain_files WHERE path LIKE 'global/%'").get()).toEqual({ n: 0 });
  (f.sy as unknown as { promotionReviewer: null }).promotionReviewer = null;
  const [created] = await f.sy.submitTasks([{ profile: "supervise", goal: "Propose bounded public guidance", repositoryAliases: ["core"],
    constraints: { acceptanceCriteria: ["guidance remains pending human review"] }, budget: { maxModelRequests: 24, timeoutSeconds: 60 } }], { project: "alpha" });
  const [claimed] = a.tasks.claim(f.sy.owner, { maxConcurrent: 1, maxWritersPerRepo: 1, maxSupervisors: 1, supervisorProfiles: ["supervise"], leaseMs: 60000, defaultTimeoutMs: 60000, supervisorTimeoutMs: 60000 }, { project: a.identity, order: "project_fifo" });
  expect(claimed!.row.id).toBe(created!.taskId);
  const principal = a.access!.principalFor("supervisor", { project: "alpha", effort: `job-${claimed!.row.id}`, task: null, repos: ["core"], jobId: claimed!.row.id, tier: "T3", lease: capturedLease(claimed!) });
  const candidate = await a.brain!.promoteLesson(principal, { agent: "supervisor:fixture", role: "supervisor", task: claimed!.row.id }, "Finite attempts", "Bound idempotent retries explicitly.", ["projects/alpha/decisions/source.md"]);
  expect(promotionsView(f.sy, { project: "alpha", status: "awaiting_person" }).map(value => value.id)).toContain(candidate.id);
  await expect(decideGlobalPromotion(f.sy, "alpha", candidate.id!, false, "fixture", " ")).rejects.toMatchObject({ code: "reason_required" });
  expect((await decideGlobalPromotion(f.sy, "alpha", candidate.id!, false, "fixture", "Needs a broader independent review")).status).toBe("rejected");
  expect(git(f.root, "rev-parse", "HEAD")).toBe(before); expect(f.client.calls).toHaveLength(0);
});

it.each(["retired", "foreign_identity"] as const)("retains the captured split runtime checks on shared public reads: %s", async kind => {
  const f = await fixture(true), bundle = f.sy.projectStores("alpha") as ProjectRuntimeBundle;
  repository(f.root, { "global/lessons/retries.md": lesson });
  const original = bundle.db.prepare("SELECT manifest_json FROM store_identity WHERE singleton=1").get() as { manifest_json: string };
  try {
    if (kind === "retired") f.sy.db.prepare("UPDATE project_store_registrations SET state='retired',retired_at=? WHERE slug='alpha'").run(Date.now());
    else bundle.db.prepare("UPDATE store_identity SET manifest_json=? WHERE singleton=1").run(JSON.stringify({ ...JSON.parse(original.manifest_json), projectId: randomUUID() }));
    expect(() => bundle.brain!.read({ kind: "human" }, "global/lessons/retries.md")).toThrow();
  } finally {
    f.sy.db.prepare("UPDATE project_store_registrations SET state='registered',retired_at=NULL WHERE slug='alpha'").run();
    bundle.db.prepare("UPDATE store_identity SET manifest_json=? WHERE singleton=1").run(original.manifest_json);
  }
  expect(f.client.calls).toHaveLength(0);
});

it("refuses redirected public paths and explicit mounts into private runtime storage", async () => {
  const f = await fixture(true), project = f.sy.projectStores("beta") as ProjectRuntimeBundle;
  await project.brain!.write({ kind: "human" }, { agent: "fixture", role: "human" }, "projects/beta/notes/secret.md", "private-beta-canary");
  mkdirSync(path.join(f.root, "global"), { recursive: true });
  symlinkSync(project.paths.brain, path.join(f.root, "global", "redirected"), "junction");
  await expect(globalKnowledge(f.sy)).rejects.toThrow(/redirected/);
  rmSync(path.join(f.root, "global", "redirected"));
  f.env.cfg.brain.mounts.push({ prefix: "global/lessons", path: project.paths.brain, commit: false });
  await expect(globalKnowledge(f.sy)).rejects.toThrow(/private project storage/);
});

it("refuses a global mount into a configured project source repository outside its project directory", async () => {
  const f = await fixture(true);
  // This is the live resolved project configuration shape after an explicit config reload.
  f.sy.projects.require("alpha").repositoryPaths.core!.path = f.env.repo;
  file(f.env.repo, "private-settings.md", "private-source-outside-project-canary");
  f.env.cfg.brain.mounts.push({ prefix: "global/lessons", path: f.env.repo, commit: true });
  await expect(globalKnowledge(f.sy)).rejects.toThrow(/private project storage/);
  expect(() => f.sy.globalKnowledge.read("global/lessons/private-settings.md")).toThrow(/private project storage/);
});

it.each(["non_directory", "corrupt_git"] as const)("surfaces real global storage errors instead of empty success: %s", async kind => {
  const f = await fixture(); mkdirSync(f.root, { recursive: true });
  if (kind === "non_directory") writeFileSync(path.join(f.root, "global"), "malformed directory");
  else { file(f.root, "global/lessons/retries.md", lesson); writeFileSync(path.join(f.root, ".git"), "invalid Git identity"); }
  await expect(globalKnowledge(f.sy)).rejects.toThrow(); expect(f.client.calls).toHaveLength(0);
});

it("drains an admitted global human revert before closing and refuses a later action", async () => {
  const f = await fixture(); repository(f.root, { "global/lessons/retries.md": lesson });
  const original = f.sy.globalKnowledge.remove.bind(f.sy.globalKnowledge);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(f.sy.globalKnowledge, "remove").mockImplementationOnce(async (...args) => { enter(); await held; return original(...args); });
  const reverting = revertGlobalEntry(f.sy, "global/lessons/retries.md", "fixture", "Obsolete"); await entered;
  const close = vi.spyOn(f.sy.db, "close"), closing = f.sy.close();
  try {
    await expect(globalKnowledge(f.sy)).rejects.toThrow(/closing/); expect(close).not.toHaveBeenCalled();
    release(); expect((await reverting).commit).toMatch(/^[a-f0-9]{40,64}$/); await closing; expect(close).toHaveBeenCalledOnce();
    expect(readFileSync(path.join(f.root, ".git", "HEAD"), "utf8")).toContain("refs/heads/main");
  } finally { release(); await closing; }
});
