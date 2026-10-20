import { cpSync, mkdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { jobMetrics, summaryOf, WAIT_REASONS, type JobMetrics, type WaitReason } from "../admin/job-metrics.js";
import type { Switchyard } from "../core/service.js";
import { SwitchyardError } from "../core/errors.js";
import { isTerminal } from "../core/task.js";
import { newId } from "../storage/db.js";
import { registerRepository } from "./registry.js";
import { initRepo, loadSuite } from "./runner.js";

// Team vs single agent: run the same goals as a team job (a supervisor that plans and delegates)
// and as one agent, with the same configuration and model pools, and record both metric sets.
// It is opt-in and cost-aware: it never starts on its own, every run has a request cap, the plan
// states the total before anything runs, and the total must fit what is left of today's
// qualification allocation (`qualification.max_requests_per_day`, shared with `qualify`).

/** Task purpose of a comparison run's root task (its delegated tasks keep the default purpose). */
export const COMPARISON_PURPOSE = "comparison";
export const COMPARISON_STARTED = "comparison_started";
export const COMPARISON_RUN = "comparison_run";
export const COMPARISON_FINISHED = "comparison_finished";
/** A team run's request cap, as a multiple of the single run's, unless given. */
export const DEFAULT_TEAM_FACTOR = 3;
const DEFAULT_SINGLE_REQUESTS = 8;

const GOAL_ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
const SupplierProfile = z.enum(["inspect", "analyze", "implement"]);

/** A supplied goal (`switchyard compare --goals <file>`): run against a configured repository. */
export const ComparisonGoalInputSchema = z
  .object({
    id: z.string().regex(GOAL_ID),
    goal: z.string().min(1).max(4000),
    repository: z.string().min(1),
    profile: SupplierProfile.default("implement"),
    acceptanceCriteria: z.array(z.string().min(1)).min(1).max(20),
    allowedPaths: z.array(z.string().min(1)).optional(),
    checks: z.array(z.string().min(1)).optional(),
    singleRequests: z.number().int().positive().max(200).optional(),
    teamRequests: z.number().int().positive().max(1000).optional(),
  })
  .strict()
  .refine((g) => g.profile !== "implement" || (g.allowedPaths?.length ?? 0) > 0, { message: "implement goals need allowedPaths" });
export const ComparisonGoalsSchema = z.array(ComparisonGoalInputSchema).min(1).max(20);

export interface ComparisonGoal {
  id: string;
  source: "eval" | "supplied";
  goal: string;
  profile: z.infer<typeof SupplierProfile>;
  acceptanceCriteria: string[];
  allowedPaths: string[] | null;
  checks: string[];
  /** A configured repository alias (supplied goals); null when the runs get fresh fixture copies. */
  repository: string | null;
  /** The eval fixture copied for each run (eval goals). */
  fixture: string | null;
  singleRequests: number;
  teamRequests: number;
}

export interface ComparisonPlan {
  goals: ComparisonGoal[];
  /** The most requests the comparison may use: every run's cap. */
  plannedRequests: number;
  dailyAllocation: number;
  /** Qualification and comparison requests in the last 24 hours. */
  usedToday: number;
  remaining: number;
  fits: boolean;
  notes: string[];
}

/** Requests charged in the last 24 hours to comparison runs and everything they delegated. */
export function comparisonRequestsToday(sy: Switchyard, now = Date.now()): number {
  const since = now - 86_400_000;
  const row = sy.db
    .prepare(
      `WITH RECURSIVE tree(id) AS (
         SELECT id FROM tasks WHERE purpose = ? AND created_at > ?
         UNION SELECT t.id FROM tasks t JOIN tree ON json_extract(t.spec_json, '$.parentTaskId') = tree.id
       )
       SELECT COUNT(DISTINCT r.id) AS n FROM model_requests r JOIN request_charges c ON c.request_id = r.id
        WHERE c.task_id IN (SELECT id FROM tree) AND r.reserved_at > ?`,
    )
    .get(COMPARISON_PURPOSE, since - 7 * 86_400_000, since) as { n: number };
  return row.n;
}

function budgetState(sy: Switchyard): { dailyAllocation: number; usedToday: number; remaining: number } {
  const dailyAllocation = sy.cfg.qualification.max_requests_per_day;
  const usedToday = sy.qualifier.requestsUsedToday() + comparisonRequestsToday(sy);
  return { dailyAllocation, usedToday, remaining: Math.max(0, dailyAllocation - usedToday) };
}

/**
 * The goals a comparison would run and the most requests it may use. Goals are the eval suite's
 * coding and read-only goals (or `evalIds` of them), or a supplied set. Nothing runs here.
 */
export function planComparison(sy: Switchyard, input: { evalIds?: string[]; goals?: unknown; teamFactor?: number; teamRequests?: number } = {}): ComparisonPlan {
  if (!sy.cfg.profiles.supervise) throw new SwitchyardError("usage", "a comparison needs the supervise task type (profiles.supervise) for its team runs");
  const factor = input.teamFactor ?? DEFAULT_TEAM_FACTOR;
  if (!(factor >= 1 && factor <= 20)) throw new SwitchyardError("usage", `the team factor must be between 1 and 20, got ${factor}`);
  const teamCap = (single: number, own?: number) => own ?? input.teamRequests ?? single * factor;
  const notes: string[] = [];
  let goals: ComparisonGoal[];
  if (input.goals !== undefined) {
    const parsed = ComparisonGoalsSchema.safeParse(input.goals);
    if (!parsed.success) throw new SwitchyardError("usage", `invalid goals: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
    const ids = parsed.data.map((g) => g.id);
    const dup = ids.find((id, i) => ids.indexOf(id) !== i);
    if (dup) throw new SwitchyardError("usage", `goal id ${dup} is used more than once`);
    goals = parsed.data.map((g) => {
      if (!sy.cfg.repositoryPaths[g.repository]) throw new SwitchyardError("usage", `goal ${g.id}: unknown repository ${g.repository}`);
      if (!sy.cfg.profiles[g.profile]) throw new SwitchyardError("usage", `goal ${g.id}: the ${g.profile} task type is not configured`);
      const single = g.singleRequests ?? DEFAULT_SINGLE_REQUESTS;
      return { id: g.id, source: "supplied", goal: g.goal, profile: g.profile, acceptanceCriteria: g.acceptanceCriteria, allowedPaths: g.allowedPaths ?? null, checks: g.checks ?? [], repository: g.repository, fixture: null, singleRequests: single, teamRequests: teamCap(single, g.teamRequests) };
    });
    notes.push("supplied goals run against the configured repository: each run works in its own worktree and branch");
  } else {
    const suite = loadSuite(sy.qualifier.suiteDir);
    const evals = suite.evals.filter((e) => e.family !== "review" && (!input.evalIds || input.evalIds.includes(e.id)));
    const unknown = (input.evalIds ?? []).filter((id) => !suite.evals.some((e) => e.id === id && e.family !== "review"));
    if (unknown.length) throw new SwitchyardError("usage", `unknown or review-only evals: ${unknown.join(", ")}`);
    goals = evals
      .filter((e) => {
        const ok = Boolean(sy.cfg.profiles[e.profile]);
        if (!ok) notes.push(`skipped ${e.id}: the ${e.profile} task type is not configured`);
        return ok;
      })
      .map((e) => ({
        id: e.id,
        source: "eval" as const,
        goal: e.task.goal,
        profile: SupplierProfile.parse(e.profile),
        acceptanceCriteria: e.task.acceptanceCriteria,
        allowedPaths: e.task.allowedPaths ?? null,
        checks: [],
        repository: null,
        fixture: path.join(sy.qualifier.suiteDir, e.fixture),
        singleRequests: e.budget.maxModelRequests,
        teamRequests: teamCap(e.budget.maxModelRequests),
      }));
    notes.push("eval goals run on fresh copies of their fixtures; results are not graded with the hidden tests");
  }
  if (!goals.length) throw new SwitchyardError("usage", "no goals to compare");
  notes.push(
    "a team run's cap covers its supervisor and every task under it; the runner checks it every half second and cancels the team once it is reached, so requests made in that window can exceed it slightly",
    "runs go one after another (team, then single) so they do not compete for capacity",
  );
  const plannedRequests = goals.reduce((s, g) => s + g.singleRequests + g.teamRequests, 0);
  const b = budgetState(sy);
  return { goals, plannedRequests, ...b, fits: plannedRequests <= b.remaining, notes };
}

// ---------- recorded comparisons (task-less events) ----------

const MetricsSnapshotSchema = z.object({
  state: z.string(),
  wallClockMs: z.number().nullable(),
  peakParallelism: z.number(),
  meanParallelism: z.number(),
  requests: z.number(),
  costUsd: z.number(),
  completedTasks: z.number(),
  requestsPerCompletedTask: z.number().nullable(),
  verificationShare: z.number().nullable(),
  waitingMs: z.number(),
  agents: z.number(),
  agentMs: z.number(),
  criticalPathMs: z.number(),
  criticalPathLabels: z.array(z.string()),
  waitingByReason: z.record(z.string(), z.number()),
});
export type MetricsSnapshot = z.infer<typeof MetricsSnapshotSchema>;

const RunRecordSchema = z.object({
  taskId: z.string(),
  acceptance: z.string().nullable(),
  stopReason: z.string().nullable(),
  stoppedAtCap: z.boolean(),
  timedOut: z.boolean(),
  requestCap: z.number(),
  endpoints: z.array(z.string()),
  metrics: MetricsSnapshotSchema,
});
export type ComparisonRunRecord = z.infer<typeof RunRecordSchema>;

const StartedSchema = z.object({
  id: z.string(),
  plannedRequests: z.number(),
  goals: z.array(z.object({ id: z.string(), goal: z.string(), source: z.string(), singleRequests: z.number(), teamRequests: z.number() })),
});
const RunEventSchema = z.object({ id: z.string(), goalId: z.string(), team: RunRecordSchema, single: RunRecordSchema });
const FinishedSchema = z.object({ id: z.string(), status: z.enum(["finished", "aborted"]), reason: z.string().nullable() });

export interface ComparisonResult {
  goalId: string;
  goal: string;
  team: ComparisonRunRecord;
  single: ComparisonRunRecord;
}

export interface ComparisonRecord {
  id: string;
  status: "running" | "finished" | "aborted";
  reason: string | null;
  startedAt: number;
  finishedAt: number | null;
  plannedRequests: number;
  goals: Array<z.infer<typeof StartedSchema>["goals"][number]>;
  results: ComparisonResult[];
}

/** Recorded comparisons, newest first. */
export function comparisons(sy: Switchyard, opts: { limit?: number } = {}): ComparisonRecord[] {
  const rows = sy.db
    .prepare("SELECT ts, type, data_json FROM events WHERE task_id IS NULL AND type IN (?, ?, ?) ORDER BY id")
    .all(COMPARISON_STARTED, COMPARISON_RUN, COMPARISON_FINISHED) as Array<{ ts: number; type: string; data_json: string | null }>;
  const byId = new Map<string, ComparisonRecord>();
  for (const r of rows) {
    let data: unknown;
    try {
      data = r.data_json ? JSON.parse(r.data_json) : null;
    } catch {
      continue;
    }
    if (r.type === COMPARISON_STARTED) {
      const s = StartedSchema.safeParse(data);
      if (s.success) byId.set(s.data.id, { id: s.data.id, status: "running", reason: null, startedAt: r.ts, finishedAt: null, plannedRequests: s.data.plannedRequests, goals: s.data.goals, results: [] });
    } else if (r.type === COMPARISON_RUN) {
      const s = RunEventSchema.safeParse(data);
      const c = s.success ? byId.get(s.data.id) : undefined;
      if (s.success && c) c.results.push({ goalId: s.data.goalId, goal: c.goals.find((g) => g.id === s.data.goalId)?.goal ?? s.data.goalId, team: s.data.team, single: s.data.single });
    } else {
      const s = FinishedSchema.safeParse(data);
      const c = s.success ? byId.get(s.data.id) : undefined;
      if (s.success && c) Object.assign(c, { status: s.data.status, reason: s.data.reason, finishedAt: r.ts });
    }
  }
  return [...byId.values()].reverse().slice(0, opts.limit ?? 20);
}

export function comparison(sy: Switchyard, id: string): ComparisonRecord | null {
  return comparisons(sy, { limit: 10_000 }).find((c) => c.id === id) ?? null;
}

// ---------- running ----------

function snapshot(m: JobMetrics): MetricsSnapshot {
  const s = summaryOf(m);
  return {
    state: s.state,
    wallClockMs: s.wallClockMs,
    peakParallelism: s.peakParallelism,
    meanParallelism: s.meanParallelism,
    requests: s.requests,
    costUsd: s.costUsd,
    completedTasks: s.completedTasks,
    requestsPerCompletedTask: s.requestsPerCompletedTask,
    verificationShare: s.verificationShare,
    waitingMs: s.waitingMs,
    agents: m.tasks.agents,
    agentMs: m.parallelism.agentMs,
    criticalPathMs: m.criticalPath.actual.agentMs,
    criticalPathLabels: m.criticalPath.actual.labels,
    waitingByReason: Object.fromEntries(WAIT_REASONS.map((r: WaitReason) => [r, m.waiting.byReason[r]])),
  };
}

function servedEndpoints(sy: Switchyard, m: JobMetrics): string[] {
  const ids = [m.jobId, ...m.agents.map((a) => a.taskId)];
  const rows = sy.db
    .prepare(`SELECT DISTINCT r.served_endpoint_id AS e FROM model_requests r JOIN request_charges c ON c.request_id = r.id WHERE c.task_id IN (${ids.map(() => "?").join(",")}) AND r.served_endpoint_id IS NOT NULL ORDER BY e`)
    .all(...ids) as Array<{ e: string }>;
  return rows.map((r) => r.e);
}

export interface RunComparisonOptions {
  /** Longest a single run may take before it is cancelled (default: supervisor.job_timeout_seconds). */
  timeoutSeconds?: number;
  signal?: AbortSignal;
  /** How often a running team's request total is checked against its cap (default 500 ms). */
  pollMs?: number;
  /** Called as each run starts and ends (for a terminal progress line). */
  onProgress?: (line: string) => void;
}

/**
 * Run a planned comparison and record it. Needs a worker to execute the runs (the CLI opens a
 * worker in-process). Refuses when the plan no longer fits today's allocation. Each goal runs as
 * a team job, then as a single agent; both metric sets are recorded as the runs finish.
 */
export async function runComparison(sy: Switchyard, plan: ComparisonPlan, opts: RunComparisonOptions = {}): Promise<ComparisonRecord> {
  const b = budgetState(sy);
  if (plan.plannedRequests > b.remaining) {
    throw new SwitchyardError("budget", `the comparison could use up to ${plan.plannedRequests} requests but only ${b.remaining} of today's qualification allocation (${b.dailyAllocation}) remain; compare fewer goals or lower the caps`);
  }
  const id = newId("cmp");
  sy.tasks.event(null, COMPARISON_STARTED, { id, plannedRequests: plan.plannedRequests, goals: plan.goals.map((g) => ({ id: g.id, goal: g.goal, source: g.source, singleRequests: g.singleRequests, teamRequests: g.teamRequests })) });
  const timeoutMs = (opts.timeoutSeconds ?? sy.cfg.supervisor.job_timeout_seconds) * 1000;
  let aborted: string | null = null;
  try {
    for (const g of plan.goals) {
      if (opts.signal?.aborted) {
        aborted = "stopped by the user";
        break;
      }
      const team = await runOne(sy, id, g, "team", timeoutMs, opts);
      const single = await runOne(sy, id, g, "single", timeoutMs, opts);
      sy.tasks.event(null, COMPARISON_RUN, { id, goalId: g.id, team, single });
    }
  } catch (err) {
    aborted = (err as Error).message;
    throw err;
  } finally {
    sy.tasks.event(null, COMPARISON_FINISHED, { id, status: aborted ? "aborted" : "finished", reason: aborted });
  }
  return comparison(sy, id)!;
}

async function repositoryFor(sy: Switchyard, comparisonId: string, g: ComparisonGoal, kind: "team" | "single"): Promise<string> {
  if (g.repository) return g.repository;
  const dir = path.join(sy.cfg.storageDir, "comparisons", comparisonId, `${g.id}-${kind}`);
  mkdirSync(dir, { recursive: true });
  cpSync(g.fixture!, dir, { recursive: true });
  await initRepo(dir);
  const alias = `c-${comparisonId.slice(-8)}-${g.id}-${kind}`;
  registerRepository(sy.db, sy.cfg, { alias, path: dir, writable: true, origin: `comparison:${comparisonId}` });
  return alias;
}

async function runOne(sy: Switchyard, comparisonId: string, g: ComparisonGoal, kind: "team" | "single", timeoutMs: number, opts: RunComparisonOptions): Promise<ComparisonRunRecord> {
  const alias = await repositoryFor(sy, comparisonId, g, kind);
  const cap = kind === "team" ? g.teamRequests : g.singleRequests;
  const label = `cmp-${g.id}-${kind}`.slice(0, 41);
  const criteria = { acceptanceCriteria: g.acceptanceCriteria, ...(g.checks.length ? { checks: g.checks } : {}) };
  const spec =
    kind === "team"
      ? { profile: "supervise", label, goal: g.goal, repositoryAliases: [alias], constraints: criteria, budget: { maxModelRequests: cap } }
      : {
          profile: g.profile,
          label,
          goal: g.goal,
          repositoryAliases: [alias],
          ...(g.profile === "implement" ? { writableRepository: alias } : {}),
          constraints: { ...criteria, ...(g.allowedPaths ? { allowedPaths: g.allowedPaths } : {}) },
          budget: { maxModelRequests: cap },
        };
  const [sub] = await sy.submitTasks([spec], { purpose: COMPARISON_PURPOSE });
  const taskId = sub!.taskId;
  opts.onProgress?.(`${g.id}: ${kind} run ${taskId} started (cap ${cap} requests)`);
  const started = Date.now();
  let stoppedAtCap = false;
  let timedOut = false;
  for (;;) {
    const r = await sy.awaitResults([taskId], { timeoutSeconds: (opts.pollMs ?? 500) / 1000, ...(opts.signal ? { signal: opts.signal } : {}) });
    if (!r.timedOut) break;
    const m = jobMetrics(sy, taskId);
    const open = () => [taskId, ...(m?.agents.map((a) => a.taskId) ?? [])].filter((t) => {
      const s = sy.tasks.get(t)?.row.state;
      return s && !isTerminal(s);
    });
    if (m && m.requests >= cap) {
      stoppedAtCap = true;
      sy.cancelTasks(open());
    } else if (Date.now() - started > timeoutMs || opts.signal?.aborted) {
      timedOut = !opts.signal?.aborted;
      sy.cancelTasks(open());
    } else continue;
    await sy.awaitResults([taskId], { timeoutSeconds: 30 });
    break;
  }
  const t = sy.tasks.get(taskId)!;
  const m = jobMetrics(sy, taskId)!;
  opts.onProgress?.(`${g.id}: ${kind} run ${taskId} ${t.row.state}${t.result ? ` / ${t.result.acceptanceStatus}` : ""}; ${m.requests} requests`);
  return {
    taskId,
    acceptance: t.result?.acceptanceStatus ?? null,
    stopReason: t.result?.stopReason ?? null,
    stoppedAtCap,
    timedOut,
    requestCap: cap,
    endpoints: servedEndpoints(sy, m),
    metrics: snapshot(m),
  };
}
