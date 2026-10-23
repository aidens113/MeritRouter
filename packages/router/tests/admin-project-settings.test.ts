import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { MeritRouter } from "../src/core/service.js";
import { projectLimits } from "../src/projects/schema.js";
import { inspectRepositoryPath, projectInfo, projectSettingsView, saveProjectRepositories, saveProjectSettings } from "../src/admin/insights.js";
import { baseConfig, commitAll, makeEnv, open, reply, ScriptedClient, summarizeTask, type Env } from "./helpers.js";

let env: Env | undefined;
let sy: MeritRouter | undefined;
afterEach(async () => {
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

/** Two projects; the global config sets a supervisor branch prefix and a coding allow-list to inherit. */
function setup(): MeritRouter {
  const base = baseConfig();
  env = makeEnv({
    config: {
      ...base,
      repositories: {},
      coding: { allowed_commands: ["npm test"] },
      supervisor: { branch_prefix: "sy/job-" },
      allocation: { max_model_requests_per_hour: 100 },
      projects: {
        alpha: { name: "Alpha", repositories: { app: { path: "alpha-app" } } },
        beta: { repositories: { app: { path: "beta-app" } } },
      },
    },
  });
  gitRepo(path.join(env.dir, "alpha-app"));
  gitRepo(path.join(env.dir, "beta-app"));
  gitRepo(path.join(env.dir, "docs-repo"));
  mkdirSync(path.join(env.dir, "plain-folder"));
  sy = open(env, new ScriptedClient(() => reply("{}")));
  return sy;
}

const fileEntry = (slug: string) => (YAML.parse(readFileSync(env!.cfg.configPath, "utf8")) as { projects: Record<string, Record<string, unknown>> }).projects[slug]!;
const override = (s: MeritRouter, slug: string, id: string) => projectSettingsView(s, slug).overrides.find((o) => o.id === id)!;

describe("project settings (admin)", () => {
  it("round-trips an override beside the inherited global value, then resets it to global", () => {
    const s = setup();
    expect(override(s, "alpha", "supervisor.branch_prefix")).toMatchObject({ global: "sy/job-", overridden: false, effective: "sy/job-" });
    expect(override(s, "alpha", "coding.allowed_commands")).toMatchObject({ global: ["npm test"], overridden: false, effective: ["npm test"] });

    const r = saveProjectSettings(s, "alpha", [
      { path: ["supervisor", "branch_prefix"], value: "alpha/job-" },
      { path: ["coding", "allowed_commands"], value: ["pnpm test*", "pnpm lint"] },
      { path: ["team", "max_agents"], value: 5 },
      { path: ["verification", "default_importance"], value: "high" },
      { path: ["roles", "reviewer"], value: { extra_rules: ["Cite a file for every finding"] } },
    ]);
    expect(r).toEqual({ ok: true });
    expect(fileEntry("alpha")).toMatchObject({ supervisor: { branch_prefix: "alpha/job-" }, team: { max_agents: 5 }, verification: { default_importance: "high" } });
    expect(override(s, "alpha", "supervisor.branch_prefix")).toMatchObject({ global: "sy/job-", overridden: true, override: "alpha/job-", effective: "alpha/job-" });
    expect(override(s, "alpha", "coding.allowed_commands")).toMatchObject({ global: ["npm test"], overridden: true, effective: ["pnpm test*", "pnpm lint"] });
    expect(override(s, "alpha", "team.max_agents")).toMatchObject({ global: undefined, overridden: true, override: 5, effective: 5 });
    expect(override(s, "alpha", "verification.default_importance")).toMatchObject({ global: "normal", overridden: true, effective: "high" });
    expect(override(s, "alpha", "roles.reviewer")).toMatchObject({ overridden: true, effective: { extra_rules: ["Cite a file for every finding"] } });
    // The live project context uses the override; the other project still inherits.
    expect(s.projects.get("alpha")!.supervisor.branch_prefix).toBe("alpha/job-");
    expect(override(s, "beta", "supervisor.branch_prefix")).toMatchObject({ overridden: false, effective: "sy/job-" });

    // Reset to global: null removes the project's own value.
    expect(saveProjectSettings(s, "alpha", [
      { path: ["supervisor", "branch_prefix"], value: null },
      { path: ["team", "max_agents"], value: null },
      { path: ["roles", "reviewer"], value: null },
    ])).toEqual({ ok: true });
    expect(override(s, "alpha", "supervisor.branch_prefix")).toMatchObject({ overridden: false, override: undefined, effective: "sy/job-" });
    expect(override(s, "alpha", "team.max_agents")).toMatchObject({ overridden: false, effective: undefined });
    expect(override(s, "alpha", "roles.reviewer").overridden).toBe(false);
    expect(s.projects.get("alpha")!.supervisor.branch_prefix).toBe("sy/job-");
    // Untouched overrides stay.
    expect(override(s, "alpha", "coding.allowed_commands").overridden).toBe(true);

    // The name is a project setting too.
    expect(saveProjectSettings(s, "alpha", [{ path: ["name"], value: "Alpha Two" }])).toEqual({ ok: true });
    expect(projectInfo(s, "alpha").name).toBe("Alpha Two");
  });

  it("keys validation failures by project-relative field", () => {
    const s = setup();
    const bad = saveProjectSettings(s, "alpha", [{ path: ["team", "max_depth"], value: 9 }]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.fieldErrors)).toEqual(["team.max_depth"]);
    const global = saveProjectSettings(s, "alpha", [{ path: ["execution", "max_concurrent_tasks"], value: 9 }]);
    expect(global.ok).toBe(false);
    if (!global.ok) expect(global.fieldErrors.form?.[0]).toMatch(/not a project setting/);
    const restricted = saveProjectSettings(s, "alpha", [{ path: ["team", "provider_concurrency_max"], value: 3 }]);
    expect(restricted.ok).toBe(false);
    if (!restricted.ok) expect(restricted.fieldErrors["team.provider_concurrency_max"]?.[0]).toMatch(/not a project setting/);
    // Nothing was written.
    expect(fileEntry("alpha").team).toBeUndefined();
  });

  it("checks repository folders and reports errors by row and field", async () => {
    const s = setup();
    expect(inspectRepositoryPath(s, "docs-repo")).toMatchObject({ isGit: true, problem: null, hint: null, resolved: path.join(env!.dir, "docs-repo") });
    // A folder without git, or no folder at all, is not a problem: saving prepares it.
    expect(inspectRepositoryPath(s, "plain-folder")).toMatchObject({ exists: true, isGit: false, problem: null, hint: expect.stringMatching(/git will be set up/) });
    expect(inspectRepositoryPath(s, "missing-folder")).toMatchObject({ exists: false, problem: null, hint: expect.stringMatching(/will be created/) });

    const bad = await saveProjectRepositories(s, "alpha", [
      { alias: "app", path: "alpha-app", writable: true },
      { alias: "app", path: "docs-repo", writable: true },
      { alias: "bad alias", path: "plain-folder", writable: true },
      { alias: "gone", path: "missing-folder", writable: true },
      { alias: "", path: "", writable: true },
    ]);
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.fieldErrors["repositories.0.alias"]).toBeUndefined();
    expect(bad.fieldErrors["repositories.0.path"]).toBeUndefined();
    expect(bad.fieldErrors["repositories.1.alias"]?.[0]).toMatch(/already used by row 1/);
    expect(bad.fieldErrors["repositories.2.alias"]?.[0]).toMatch(/letters, digits/);
    expect(bad.fieldErrors["repositories.2.path"]).toBeUndefined();
    expect(bad.fieldErrors["repositories.3.path"]).toBeUndefined();
    expect(bad.fieldErrors["repositories.4.alias"]).toEqual(["enter an alias"]);
    expect(bad.fieldErrors["repositories.4.path"]).toEqual(["enter the repository's folder"]);
    expect(Object.keys(fileEntry("alpha").repositories as object)).toEqual(["app"]);
    // A refused save prepares nothing.
    expect(inspectRepositoryPath(s, "missing-folder").exists).toBe(false);

    // Add one, make the other read only; then remove the added one.
    expect(await saveProjectRepositories(s, "alpha", [
      { alias: "app", path: "alpha-app", writable: false },
      { alias: "docs", path: "docs-repo", writable: true },
    ])).toEqual({ ok: true });
    expect(fileEntry("alpha").repositories).toEqual({ app: { path: "alpha-app", writable: false }, docs: { path: "docs-repo" } });
    expect(s.projects.get("alpha")!.repositoryPaths.docs).toEqual({ path: path.join(env!.dir, "docs-repo"), writable: true });
    expect(projectSettingsView(s, "alpha").repositoryRows).toEqual([
      expect.objectContaining({ alias: "app", writable: false, isGit: true, problem: null }),
      expect.objectContaining({ alias: "docs", writable: true, isGit: true }),
    ]);
    expect(await saveProjectRepositories(s, "alpha", [{ alias: "app", path: "alpha-app", writable: true }])).toEqual({ ok: true });
    expect(fileEntry("alpha").repositories).toEqual({ app: { path: "alpha-app" } });
    expect(s.projects.get("alpha")!.repositoryPaths.docs).toBeUndefined();
    // Beta is untouched.
    expect(fileEntry("beta").repositories).toEqual({ app: { path: "beta-app" } });
  });

  it("writes the fairness fields and reads them back", () => {
    const s = setup();
    const before = projectSettingsView(s, "alpha").limits;
    expect(before).toMatchObject({ priority: null, max_concurrent_tasks: null, request_share: null, paid_budgets: { per_day_usd: null, per_week_usd: null, per_month_usd: null } });
    expect(before.global).toMatchObject({ maxConcurrentTasks: 4, requestsPerHour: 100, requestsPerDay: null, paidEnabled: false });

    expect(saveProjectSettings(s, "alpha", [
      { path: ["priority"], value: 2 },
      { path: ["max_concurrent_tasks"], value: 3 },
      { path: ["paid_budgets"], value: { per_day_usd: 1, per_week_usd: 5 } },
      { path: ["request_share"], value: 0.5 },
    ])).toEqual({ ok: true });
    expect(fileEntry("alpha")).toMatchObject({ priority: 2, max_concurrent_tasks: 3, paid_budgets: { per_day_usd: 1, per_week_usd: 5 }, request_share: 0.5 });
    // What the scheduler and admission read.
    expect(projectLimits(s.cfg, "alpha")).toEqual({ priority: 2, max_concurrent_tasks: 3, paid_budgets: { per_day_usd: 1, per_week_usd: 5 }, request_share: 0.5 });
    expect(projectLimits(s.cfg, "beta")).toEqual({ priority: 1 });
    expect(projectSettingsView(s, "alpha").limits).toMatchObject({ priority: 2, max_concurrent_tasks: 3, request_share: 0.5, paid_budgets: { per_day_usd: 1, per_week_usd: 5, per_month_usd: null } });

    // Out-of-range values are refused, keyed by field, and nothing changes.
    const bad = saveProjectSettings(s, "alpha", [{ path: ["request_share"], value: 1.5 }, { path: ["priority"], value: 0 }]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.fieldErrors).sort()).toEqual(["priority", "request_share"]);
    expect(projectLimits(s.cfg, "alpha").request_share).toBe(0.5);

    // Clearing a field removes the per-project limit.
    expect(saveProjectSettings(s, "alpha", [{ path: ["request_share"], value: null }, { path: ["max_concurrent_tasks"], value: null }])).toEqual({ ok: true });
    expect(projectSettingsView(s, "alpha").limits).toMatchObject({ priority: 2, max_concurrent_tasks: null, request_share: null });
    expect(projectLimits(s.cfg, "alpha")).toEqual({ priority: 2, paid_budgets: { per_day_usd: 1, per_week_usd: 5 } });
  });

  it("shows brain mounts and access overrides, and reports archive blockers", async () => {
    const s = setup();
    mkdirSync(path.join(env!.dir, "notes"));
    expect(saveProjectSettings(s, "alpha", [
      { path: ["brain", "mounts"], value: [{ prefix: "projects/alpha/notes", path: "notes" }] },
      { path: ["brain", "access_approver"], value: "human" },
    ])).toEqual({ ok: true });
    const v = projectSettingsView(s, "alpha");
    expect(v.mounts).toEqual({ global: [], project: [{ prefix: "projects/alpha/notes", path: "notes", commit: false }] });
    expect(v.overrides.find((o) => o.id === "brain.access_approver")).toMatchObject({ global: "supervisor", overridden: true, effective: "human" });
    expect(v.overrides.find((o) => o.id === "brain.auto_approve")).toMatchObject({ overridden: false });
    expect(v).toMatchObject({ archived: false, activity: { runningTasks: 0, queuedTasks: 0 } });
    await s.submitTasks([summarizeTask()], { project: "beta" });
    expect(projectSettingsView(s, "beta").activity.queuedTasks).toBe(1);
  });
});
