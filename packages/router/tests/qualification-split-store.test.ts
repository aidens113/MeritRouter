import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MeritRouter } from "../src/core/service.js";
import type { ChatRequest } from "../src/gateway/types.js";
import { QUALIFICATION_PROJECT } from "../src/qualification/registry.js";
import { planComparison, runComparison } from "../src/qualification/comparison.js";
import { qualificationBoard } from "../src/admin/insights.js";
import { baseConfig, goodOutput, makeEnv, open, reply, ScriptedClient, servedFor, summarizeTask, type Env } from "./helpers.js";

// B2c: the reserved qualification project gets an installation-owned store in split layout, so
// qualification and comparison runs work the same way they do in legacy/projects layout (see
// tests/projects-router-fixes.test.ts), while staying out of every real project's own store.

const dirs: string[] = [];
let env: Env | undefined;
let sy: MeritRouter | undefined;
afterEach(async () => {
  await sy?.close();
  sy = undefined;
  env?.cleanup();
  env = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, stdio: "pipe" }).toString();

/** A real, git-initialised project directory, outside the installation's config/storage directory. */
function projectRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "meritrouter-qsplit-project-"));
  dirs.push(dir);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "src", "app.ts"), "export const add = (a: number, b: number) => a + b;\n");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

const supervise = { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100, max_model_requests: 30, max_output_tokens: 4000, classify: "never", min_tier: "T3" };

/** A split installation with one real project ("alpha"), ready for `createSplitProject`. */
function splitFixture(alphaRepo: string): Env {
  const base = baseConfig();
  return makeEnv({
    config: {
      ...base,
      storage: { directory: ".meritrouter", layout: "split" },
      repositories: {},
      routing: { escalate_on_failure: false },
      team: { provider_concurrency_enabled: false, max_agents: 8 },
      brain: { ...(base.brain as Record<string, unknown>), project: "alpha" },
      profiles: { ...(base.profiles as Record<string, unknown>), supervise },
      projects: { alpha: { directory: alphaRepo, repositories: { app: { path: "app" } } } },
    },
  });
}

/** Aliases of runtime fixtures (qualification `q-...`, comparison `c-...`). */
const fixtureAliases = (paths: Record<string, unknown>) => Object.keys(paths).filter((a) => /^[qc]-/.test(a));
const call = (name: string, args: unknown, id = name) => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
const turns = (req: ChatRequest) => req.messages.filter((m) => m.role === "assistant").length;
const isSupervisor = (req: ChatRequest) => String(req.messages[0]!.content).startsWith("# Supervisor charter");

async function waitForRun(runId: string, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await sy!.qualifier.gradePending();
    const run = qualificationBoard(sy!).runs.find((r) => r.id === runId)!;
    if (run.status === "finished") return run;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("qualification run did not finish");
}

/** Zero rows in every table a qualification/comparison run could have written. */
function assertNoQualificationData(db: { prepare(sql: string): { get(): unknown } }, label: string): void {
  for (const table of ["tasks", "qualification_tasks", "qualification_runs", "qualification_results", "repository_registry"]) {
    expect(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get(), `${label}.${table}`).toEqual({ n: 0 });
  }
}

describe("qualification's installation-owned store in split layout", () => {
  it("a qualification run grades, a comparison completes, and no qualification rows reach alpha's store or the coordination store", async () => {
    const alphaRepo = projectRepo();
    env = splitFixture(alphaRepo);
    const client = new ScriptedClient((req) => {
      if (isSupervisor(req)) {
        const alias = JSON.stringify(req.messages).match(/c-[a-z0-9]+-locate-validator-(team|single)/)?.[0];
        const script = [
          () => [call("delegate", { tasks: [{ label: "find-check", profile: "inspect", goal: "Find the email validator.", acceptance_criteria: ["cites it"], file_refs: [`${alias}:src/validation/address.js`] }] })],
          () => [call("await_tasks", { timeout_seconds: 30 })],
          () => [call("finish_job", { status: "completed", summary: "checkAddress validates emails.", verified: [{ claim: "checkAddress is in src/validation/address.js", evidence: "worker citation" }], not_verified: [] })],
        ];
        return reply(null, { ...servedFor(sy!, req), toolCalls: script[Math.min(turns(req), 2)]!() });
      }
      if (req.tools?.length) {
        const alias = JSON.stringify(req.messages).match(/[qc]-[a-z0-9-]+-locate-validator-(1|team|single)/)?.[0];
        if (turns(req) === 0) return reply(null, { ...servedFor(sy!, req), toolCalls: [call("read_file", { alias, path: "src/validation/address.js" })] });
        return reply(null, {
          ...servedFor(sy!, req),
          toolCalls: [call("submit_result", { summary: "checkAddress in src/validation/address.js decides it", findings: [{ description: "checkAddress validates emails", evidenceRefs: [`${alias}:src/validation/address.js#L5-L9`] }], criteria: [0, 1].map((index) => ({ index, status: "met", evidenceRefs: [`${alias}:src/validation/address.js#L5-L9`] })) }, "1")],
        });
      }
      return reply(JSON.stringify(goodOutput()), servedFor(sy!, req));
    });
    sy = open(env, client, { worker: true });
    expect(sy.layout).toBe("split");

    await sy.createSplitProject({ slug: "alpha", directory: alphaRepo });

    // Qualification: runs and grades entirely in the installation-owned qualification store.
    const run = await sy.qualifier.start("openrouter/vendor/big-a:free", { evalIds: ["locate-validator"], trials: 1 });
    expect(run.tasks).toBe(1);
    const finished = await waitForRun(run.runId);
    expect(finished.graded).toBe(1);
    const board = qualificationBoard(sy);
    expect(board.results.find((r) => r.evalId === "locate-validator")!.outcome, JSON.stringify(board.results)).toBe("pass");

    const qualStore = sy.projectStores(QUALIFICATION_PROJECT);
    expect(qualStore.project).toBe(QUALIFICATION_PROJECT);
    expect((qualStore.db.prepare("SELECT COUNT(*) n FROM qualification_runs WHERE id = ?").get(run.runId) as { n: number }).n).toBe(1);
    expect(fixtureAliases(sy.projects.qualification.repositoryPaths)).toHaveLength(1);

    // Comparison: an eval goal, run as a team then as a single agent, also in that store.
    const plan = planComparison(sy, { evalIds: ["locate-validator"] });
    expect(plan.goals).toMatchObject([{ id: "locate-validator", source: "eval", repository: null }]);
    expect(plan.fits).toBe(true);
    const c = await runComparison(sy, plan, { timeoutSeconds: 60 });
    expect(c.status).toBe("finished");
    const r = c.results[0]!;
    expect(r.team.metrics.state, JSON.stringify(r.team)).toBe("completed");
    expect(r.single.metrics.state, JSON.stringify(r.single)).toBe("completed");
    expect(qualStore.tasks.get(r.team.taskId)).toBeDefined();
    expect(qualStore.tasks.get(r.single.taskId)).toBeDefined();
    expect(fixtureAliases(sy.projects.qualification.repositoryPaths)).toHaveLength(3);

    // Neither run ever touched alpha's project store...
    const alphaStore = sy.projectStores("alpha");
    expect(alphaStore.project).toBe("alpha");
    assertNoQualificationData(alphaStore.db, "alpha");
    expect(fixtureAliases(sy.projectContext("alpha").repositoryPaths)).toEqual([]);
    // ...nor the coordination store (the installation's own db holds no project rows at all).
    assertNoQualificationData(sy.db, "coordination");
    expect(fixtureAliases(sy.cfg.repositoryPaths)).toEqual([]);

    // Nobody may submit work into the qualification project by name.
    await expect(sy.submitTasks([summarizeTask()], { project: QUALIFICATION_PROJECT })).rejects.toThrow(/unknown project _qualification/);
  }, 120_000);
});
