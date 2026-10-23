import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { MeritRouter } from "../src/core/service.js";
import { teamMetrics } from "../src/admin/job-metrics.js";
import { planComparison } from "../src/qualification/comparison.js";
import { baseConfig, commitAll, makeEnv, open, ScriptedClient, reply, type Env } from "./helpers.js";

// Admin calls the panel's per-project pages make (J2): team metrics scoped to one project, and
// comparisons (system work in the primary project) resolving repositories in that project.

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

const supervise = { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100, max_model_requests: 60, max_output_tokens: 8000, classify: "never", min_tier: "T3" };

/** Two projects sharing the `app` alias; only beta has `docs`. Alpha is the primary project. */
function makeTwoProjects(): Env {
  const base = baseConfig();
  const e = makeEnv({
    config: {
      ...base,
      repositories: {},
      brain: { ...((base.brain as Record<string, unknown> | undefined) ?? {}), project: "alpha" },
      profiles: { ...(base.profiles as Record<string, unknown>), supervise },
      projects: {
        alpha: { name: "Alpha", repositories: { app: { path: "alpha-app" } } },
        beta: { repositories: { app: { path: "beta-app" }, docs: { path: "beta-docs" } } },
      },
    },
  });
  for (const d of ["alpha-app", "beta-app", "beta-docs"]) gitRepo(path.join(e.dir, d));
  return e;
}

describe("panel scope across projects", () => {
  it("teamMetrics lists one project's jobs with `project`, every project's without", async () => {
    env = makeTwoProjects();
    sy = open(env, new ScriptedClient(() => reply("{}")));
    const a = await sy.startJob({ goal: "Alpha job", repositories: ["app"], project: "alpha" });
    const b = await sy.startJob({ goal: "Beta job", repositories: ["app"], project: "beta" });
    expect(teamMetrics(sy, { project: "alpha" }).map((m) => m.jobId)).toEqual([a.taskId]);
    expect(teamMetrics(sy, { project: "beta" }).map((m) => m.jobId)).toEqual([b.taskId]);
    expect(teamMetrics(sy).map((m) => m.jobId).sort()).toEqual([a.taskId, b.taskId].sort());
    expect(teamMetrics(sy, { project: "gamma" })).toEqual([]);
  });

  it("planComparison resolves goal repositories in the primary project, where comparison runs land", () => {
    env = makeTwoProjects();
    sy = open(env, new ScriptedClient(() => reply("{}")));
    const goal = (repository: string) => [{ id: "g", goal: "Where is the README?", repository, profile: "inspect", acceptanceCriteria: ["cites it"], singleRequests: 2, teamRequests: 4 }];
    expect(sy.projects.primary.project.slug).toBe("alpha");
    expect(planComparison(sy, { goals: goal("app") }).goals.map((g) => g.repository)).toEqual(["app"]);
    expect(() => planComparison(sy!, { goals: goal("docs") })).toThrow(/unknown repository docs in project alpha/);
  });
});
