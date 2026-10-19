import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ProfileNameSchema, TierNameSchema, type TierName } from "../config/schema.js";
import type { Switchyard } from "../core/service.js";
import { isTerminal, type WorkerResult } from "../core/task.js";
import { newId } from "../storage/db.js";
import { FILE_REF_RE } from "../core/task.js";
import { git } from "../workspaces/git.js";
import { minimalEnv, runProcess } from "../runners/coding/process.js";
import { registerRepository } from "./registry.js";

const EvalSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  family: z.enum(["coding", "read_only"]),
  tier: TierNameSchema,
  profile: ProfileNameSchema,
  title: z.string(),
  fixture: z.string(),
  task: z.object({
    goal: z.string(),
    acceptanceCriteria: z.array(z.string()).min(1),
    allowedPaths: z.array(z.string()).optional(),
    inlineText: z.string().optional(),
  }),
  hidden: z.object({ dir: z.string(), command: z.string() }).optional(),
  grade: z
    .object({
      mustCite: z.array(z.object({ path: z.string(), lines: z.tuple([z.number(), z.number()]) })).default([]),
      mustMention: z.array(z.array(z.string()).min(1)).default([]),
    })
    .optional(),
  budget: z.object({ maxModelRequests: z.number().int().positive() }),
});
export type EvalCase = z.infer<typeof EvalSchema>;
const SuiteSchema = z.object({ version: z.string(), description: z.string().optional(), evals: z.array(EvalSchema) });
export type Suite = z.infer<typeof SuiteSchema>;

export function evalsDir(): string {
  // dist/qualification/runner.js and src/qualification/runner.ts both sit two levels below the package.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "evals");
}

export function loadSuite(dir = evalsDir()): Suite {
  return SuiteSchema.parse(JSON.parse(readFileSync(path.join(dir, "suite.json"), "utf8")));
}

const INFRA = /capacity_exhausted|gateway_(auth|transport|server|timeout|unknown_model)|no_eligible_endpoint|deadline_exceeded|internal_error|repo_agent_config_present|worker shut down|lease/;

export interface StartedRun {
  runId: string;
  endpointId: string;
  tasks: number;
}

/**
 * Qualification: runs the private eval suite through the normal pipeline, pinned to one model,
 * and grades results with hidden tests (coding) or citation checks (read-only). Any running
 * worker executes the tasks; grading happens on the worker's tick or on demand.
 */
export class Qualifier {
  private grading = false;

  constructor(
    private readonly sy: Switchyard,
    private readonly suiteDir = evalsDir(),
  ) {}

  suite(): Suite {
    return loadSuite(this.suiteDir);
  }

  requestsUsedToday(): number {
    return (
      this.sy.db
        .prepare(
          `SELECT COUNT(DISTINCT r.id) AS n FROM model_requests r JOIN request_charges c ON c.request_id = r.id JOIN tasks t ON t.id = c.task_id
            WHERE t.purpose = 'qualification' AND r.reserved_at > ?`,
        )
        .get(Date.now() - 86_400_000) as { n: number }
    ).n;
  }

  async start(endpointId: string, opts: { evalIds?: string[]; trials?: number } = {}): Promise<StartedRun> {
    const ep = this.sy.catalog.get(endpointId);
    if (!ep) throw new Error(`unknown model ${endpointId}`);
    if (ep.status !== "active") throw new Error(`${endpointId} is ${ep.status}: ${ep.statusReason ?? ""}`);
    const suite = this.suite();
    const evals = suite.evals.filter((e) => !opts.evalIds || opts.evalIds.includes(e.id)).filter((e) => this.sy.cfg.profiles[e.profile]);
    if (!evals.length) throw new Error("no evaluations match (or their task types are not configured)");
    const trials = opts.trials ?? this.sy.cfg.qualification.trials_per_task;
    const projected = evals.reduce((s, e) => s + e.budget.maxModelRequests, 0) * trials;
    const remaining = this.sy.cfg.qualification.max_requests_per_day - this.requestsUsedToday();
    if (projected > remaining) {
      throw new Error(`qualification could use up to ${projected} requests but only ${Math.max(0, remaining)} of today's qualification allocation (${this.sy.cfg.qualification.max_requests_per_day}) remain; lower trials or pick fewer evals`);
    }

    const runId = newId("q");
    const root = path.join(this.sy.cfg.storageDir, "qualification", runId);
    this.sy.db
      .prepare("INSERT INTO qualification_runs (id, endpoint_id, suite_version, status, started_at, detail_json) VALUES (?, ?, ?, 'preparing', ?, ?)")
      .run(runId, endpointId, suite.version, Date.now(), JSON.stringify({ evals: evals.map((e) => e.id), trials, projectedRequests: projected }));

    const specs: Array<{ spec: Record<string, unknown>; evalId: string; trial: number; fixture: string }> = [];
    for (const e of evals) {
      for (let trial = 1; trial <= trials; trial++) {
        const repo = path.join(root, `${e.id}-t${trial}`);
        mkdirSync(repo, { recursive: true });
        cpSync(path.join(this.suiteDir, e.fixture), repo, { recursive: true });
        await initRepo(repo);
        const alias = `q-${runId.slice(-8)}-${e.id}-${trial}`;
        registerRepository(this.sy.db, this.sy.cfg, { alias, path: repo, writable: e.family === "coding", origin: `qualification:${runId}` });
        specs.push({
          evalId: e.id,
          trial,
          fixture: repo,
          spec: {
            profile: e.profile,
            goal: e.task.goal,
            repositoryAliases: [alias],
            ...(e.family === "coding" ? { writableRepository: alias } : {}),
            context: e.task.inlineText ? { inlineText: e.task.inlineText } : {},
            constraints: { acceptanceCriteria: e.task.acceptanceCriteria, ...(e.task.allowedPaths ? { allowedPaths: e.task.allowedPaths } : {}) },
            hints: { difficulty: e.tier },
            routing: { endpointId },
            budget: { maxModelRequests: e.budget.maxModelRequests },
          },
        });
      }
    }
    const submitted = await this.sy.submitTasks(specs.map((s) => s.spec), { purpose: "qualification" });
    const ins = this.sy.db.prepare("INSERT INTO qualification_tasks (task_id, run_id, eval_id, trial, endpoint_id, fixture_path) VALUES (?, ?, ?, ?, ?, ?)");
    this.sy.db.transaction(() => {
      submitted.forEach((s, i) => ins.run(s.taskId, runId, specs[i]!.evalId, specs[i]!.trial, endpointId, specs[i]!.fixture));
      this.sy.db.prepare("UPDATE qualification_runs SET status = 'running' WHERE id = ?").run(runId);
    })();
    return { runId, endpointId, tasks: submitted.length };
  }

  /** Grade finished qualification tasks. Safe to call repeatedly and from several processes. */
  async gradePending(): Promise<number> {
    if (this.grading) return 0;
    this.grading = true;
    let graded = 0;
    try {
      const suite = this.suite();
      const pending = this.sy.db.prepare("SELECT * FROM qualification_tasks WHERE evaluated = 0").all() as Array<{
        task_id: string;
        run_id: string;
        eval_id: string;
        trial: number;
        endpoint_id: string;
        fixture_path: string;
      }>;
      for (const q of pending) {
        const t = this.sy.tasks.get(q.task_id);
        if (!t || !isTerminal(t.row.state) || !t.result) continue;
        // Claim the row so another process does not grade it too.
        if (this.sy.db.prepare("UPDATE qualification_tasks SET evaluated = 2 WHERE task_id = ? AND evaluated = 0").run(q.task_id).changes === 0) continue;
        const e = suite.evals.find((x) => x.id === q.eval_id);
        const verdict = e ? await this.grade(e, t.result, q.fixture_path) : { outcome: "infra_error" as const, detail: "eval no longer in suite" };
        this.sy.db
          .prepare("INSERT INTO qualification_results (run_id, endpoint_id, eval_id, family, tier, trial, outcome, task_id, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(q.run_id, q.endpoint_id, q.eval_id, e?.family ?? "unknown", e?.tier ?? "T1", q.trial, verdict.outcome, q.task_id, JSON.stringify({ detail: verdict.detail, stopReason: t.result.stopReason }), Date.now());
        this.sy.db.prepare("UPDATE qualification_tasks SET evaluated = 1 WHERE task_id = ?").run(q.task_id);
        graded++;
      }
      for (const run of this.sy.db.prepare("SELECT id FROM qualification_runs WHERE status = 'running'").all() as { id: string }[]) {
        const left = this.sy.db.prepare("SELECT COUNT(*) AS n FROM qualification_tasks WHERE run_id = ? AND evaluated != 1").get(run.id) as { n: number };
        if (left.n > 0) continue;
        const tally = this.sy.db.prepare("SELECT outcome, COUNT(*) AS n FROM qualification_results WHERE run_id = ? GROUP BY outcome").all(run.id) as { outcome: string; n: number }[];
        this.sy.db
          .prepare("UPDATE qualification_runs SET status = 'finished', finished_at = ?, detail_json = json_set(COALESCE(detail_json, '{}'), '$.tally', json(?)) WHERE id = ?")
          .run(Date.now(), JSON.stringify(Object.fromEntries(tally.map((r) => [r.outcome, r.n]))), run.id);
      }
    } finally {
      this.grading = false;
    }
    return graded;
  }

  async grade(e: EvalCase, result: WorkerResult, fixture: string): Promise<{ outcome: "pass" | "fail" | "infra_error"; detail: string }> {
    if (result.executionStatus !== "completed" && INFRA.test(result.stopReason)) return { outcome: "infra_error", detail: result.stopReason };
    if (e.family === "coding") return this.gradeCoding(e, result, fixture);
    return gradeReadOnly(e, result);
  }

  private async gradeCoding(e: EvalCase, result: WorkerResult, fixture: string): Promise<{ outcome: "pass" | "fail" | "infra_error"; detail: string }> {
    const patchRef = result.patchRefs[0];
    if (!patchRef) return { outcome: "fail", detail: `no patch (${result.stopReason})` };
    if (result.findings.some((f) => f.description.startsWith("Out-of-scope changes"))) return { outcome: "fail", detail: "out-of-scope edits" };
    const patch = this.sy.artifacts.read(patchRef)?.content.toString("utf8");
    if (!patch) return { outcome: "infra_error", detail: "patch artifact missing" };
    // Grade on a clean copy of the fixture so nothing the worker left behind can influence it.
    const gradeDir = `${fixture}-grade`;
    cpSync(path.join(this.suiteDir, e.fixture), gradeDir, { recursive: true });
    await initRepo(gradeDir);
    const patchFile = path.join(gradeDir, "..", `${path.basename(gradeDir)}.patch`);
    writeFileSync(patchFile, patch);
    try {
      await git(gradeDir, ["apply", "--whitespace=nowarn", patchFile]);
    } catch (err) {
      return { outcome: "fail", detail: `patch does not apply: ${(err as Error).message.slice(0, 300)}` };
    }
    if (!e.hidden) return { outcome: "infra_error", detail: "coding eval without hidden tests" };
    // Hidden tests are copied in after the patch, overwriting anything the worker wrote there.
    cpSync(path.join(this.suiteDir, e.hidden.dir), path.join(gradeDir, "hidden"), { recursive: true, force: true });
    const r = await runProcess(e.hidden.command, [], { cwd: gradeDir, env: minimalEnv({ CI: "1" }), timeoutMs: 120_000, shell: true });
    const log = this.sy.artifacts.write({ taskId: result.taskId, kind: "qualification_grade", label: `hidden tests for ${e.id}`, content: `$ ${e.hidden.command}\nexit ${r.exitCode}\n\n${r.stdout}\n${r.stderr}`, extension: ".log" });
    return r.exitCode === 0 && !r.killed ? { outcome: "pass", detail: `hidden tests passed (${log})` } : { outcome: "fail", detail: `hidden tests failed with exit ${r.exitCode} (${log})` };
  }
}

export function gradeReadOnly(e: EvalCase, result: WorkerResult): { outcome: "pass" | "fail"; detail: string } {
  if (result.executionStatus !== "completed") return { outcome: "fail", detail: result.stopReason };
  const refs = result.findings.flatMap((f) => f.evidenceRefs);
  const text = `${result.summary}\n${result.findings.map((f) => f.description).join("\n")}`.toLowerCase();
  const problems: string[] = [];
  for (const cite of e.grade?.mustCite ?? []) {
    const hit = refs.some((ref) => {
      const m = FILE_REF_RE.exec(ref);
      if (!m || !m[2]!.endsWith(cite.path)) return false;
      if (!m[3]) return true;
      const start = Number(m[3]);
      const end = m[4] ? Number(m[4]) : start;
      return start <= cite.lines[1] && end >= cite.lines[0];
    });
    if (!hit) problems.push(`did not cite ${cite.path}#L${cite.lines[0]}-L${cite.lines[1]}`);
  }
  for (const group of e.grade?.mustMention ?? []) {
    if (!group.some((w) => text.includes(w.toLowerCase()))) problems.push(`did not mention any of: ${group.join(", ")}`);
  }
  return problems.length ? { outcome: "fail", detail: problems.join("; ") } : { outcome: "pass", detail: "required evidence cited" };
}

async function initRepo(dir: string): Promise<void> {
  if (!existsSync(path.join(dir, ".git"))) await git(dir, ["init", "-q", "-b", "main"]);
  await git(dir, ["add", "-A"]);
  await git(dir, ["-c", "user.email=qualification@switchyard.local", "-c", "user.name=switchyard", "commit", "-q", "--allow-empty", "-m", "fixture"]);
}

export type { TierName };
