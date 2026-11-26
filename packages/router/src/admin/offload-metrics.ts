/**
 * Supervisor-offload measurement (lane E). Answers "how much of the work did free workers do,
 * and how well": task counts by kind/outcome, accepted changed lines attributed to the model
 * that produced them, commands run by workers, a rough context-compression ratio, model request
 * and token usage, channel activity (questions/reworks/probes, answer latency) and the
 * first-attempt vs after-rework acceptance rate.
 *
 * Every number in `OffloadReport` is either EXACT (computed from a stored, harness-written
 * record: `tasks.result_json`, `model_requests`/`request_charges`, `channel_messages`,
 * `task_rework`, or git commit metadata) or ESTIMATED (derived with a documented assumption,
 * because the underlying measurement does not exist yet, e.g. there is no per-tool-call byte
 * counter for what a worker actually read). `OffloadReport.estimates` lists every estimated
 * field by path so a caller never mistakes one for a measurement.
 */
import { z } from "zod";
import type { MeritRouter } from "../core/service.js";
import { fanOutProjectRows, requireProjectStores } from "./project-reads.js";
import { WorkerResultSchema, type WorkerResult, type WorkerTask } from "../core/task.js";
import { renderReportV1 } from "../core/report.js";
import { git } from "../workspaces/git.js";
import { splitRepoKey } from "../projects/context.js";

// ---------------------------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------------------------

export const OffloadReportInputSchema = z
  .object({
    /** One project; omitted scans every configured project (plus qualification, as other cross-project views do). */
    project: z.string().min(1).max(200).optional(),
    /** Window start, epoch ms (inclusive). Default: no lower bound. */
    since: z.number().int().min(0).optional(),
    /** Window end, epoch ms (exclusive). Default: now. */
    until: z.number().int().min(0).optional(),
    /** Narrow to these task ids (and, for line attribution, their rework lineage) instead of the whole window. */
    sessionTaskIds: z.array(z.string().min(1)).max(2000).optional(),
    /** Cap on commits inspected per repository for line attribution (cost control). Default 500. */
    maxCommitsPerRepo: z.number().int().min(1).max(5000).default(500),
  })
  .strict();
export type OffloadReportInput = z.input<typeof OffloadReportInputSchema>;

// ---------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------

const CountSchema = z.object({ count: z.number().int().min(0) }).strict();

export const OffloadReportSchema = z
  .object({
    window: z.object({ project: z.string().nullable(), since: z.number().int().nullable(), until: z.number().int() }).strict(),
    /** How many tasks ran in the window; the rest of the report is drawn from this set. EXACT. */
    totalTasks: z.number().int().min(0),
    /** EXACT: tasks.profile x (executionStatus, acceptanceStatus) from the stored WorkerResult, or state for unfinished tasks. */
    tasksByKindOutcome: z.array(
      z.object({ kind: z.string(), executionStatus: z.string().nullable(), acceptanceStatus: z.string().nullable(), state: z.string() }).merge(CountSchema).strict(),
    ),
    /**
     * EXACT per commit: added/removed lines from `git log --numstat` for commits whose `Task`
     * trailer names a task in the window, grouped by the commit's `Model` trailer (absent ->
     * "no model trailer", i.e. likely a human or lead commit) and whether that model is free or
     * paid. "Accepted" means the owning task's stored acceptanceStatus is "met"; commits for
     * tasks that are not met, or whose repository could not be read, are reported separately and
     * excluded from the accepted totals. Paid/free classification is ESTIMATED (see `estimates`):
     * it reads the model catalog's `origin` field (origin "paid" = paid) when the model is still
     * in the catalog, and falls back to "unknown" otherwise.
     */
    acceptedLines: z.object({
      byModel: z.array(z.object({ model: z.string(), classification: z.enum(["free", "paid", "unknown"]), added: z.number().int(), removed: z.number().int(), commits: z.number().int() }).strict()),
      otherAuthors: z.object({ added: z.number().int(), removed: z.number().int(), commits: z.number().int() }).strict(),
      notAccepted: z.object({ added: z.number().int(), removed: z.number().int(), commits: z.number().int() }).strict(),
      reposSkipped: z.array(z.object({ repository: z.string(), reason: z.string() }).strict()),
    }).strict(),
    /** EXACT: `WorkerResult.checks`, which only lists checks the harness actually ran. */
    commandsRun: z.object({
      total: z.number().int().min(0),
      passed: z.number().int().min(0),
      failed: z.number().int().min(0),
      didNotFinish: z.number().int().min(0),
      byTaskKind: z.array(z.object({ kind: z.string() }).merge(CountSchema).strict()),
    }).strict(),
    /**
     * Context compression: bytes of context handed to each worker vs. bytes of the report the
     * supervisor reads back. `bytesOfReportReturned` is EXACT (the report is rendered here with
     * `renderReportV1`, the same renderer a supervisor sees, and measured in UTF-8 bytes).
     * `bytesReadEstimate` is ESTIMATED: MeritRouter does not yet instrument how many bytes a
     * worker's read/search tool calls actually returned, so this counts only the context the
     * supervisor *handed in* (goal + context.notes + one byte per file ref as a stand-in for an
     * unknown read), which understates true reads whenever the worker searched or read beyond
     * what the brief listed. Treat the ratio as a floor on compression, not a measurement of it.
     */
    contextCompression: z.object({
      bytesHandedInEstimate: z.number().int().min(0),
      bytesOfReportReturned: z.number().int().min(0),
      ratioEstimate: z.number().nullable(),
      tasksCounted: z.number().int().min(0),
    }).strict(),
    /** EXACT: summed from each task's stored `WorkerResult.usage` (provider-reported where usageBasis says so, else estimated upstream — that upstream distinction is preserved in `tokenBasis`). */
    modelUsage: z.object({
      modelRequests: z.number().int().min(0),
      inputTokens: z.number().int().min(0),
      outputTokens: z.number().int().min(0),
      tokenBasis: z.enum(["provider_reported", "estimated", "unknown", "mixed"]),
    }).strict(),
    /** EXACT counts from `channel_messages` / `task_rework` for tasks in the window. Latency is EXACT where both timestamps exist. */
    channelActivity: z.object({
      questions: z.number().int().min(0),
      toolRequests: z.number().int().min(0),
      helpOrBlocked: z.number().int().min(0),
      probes: z.number().int().min(0),
      reworks: z.number().int().min(0),
      answeredCount: z.number().int().min(0),
      medianAnswerLatencyMs: z.number().min(0).nullable(),
    }).strict(),
    /** EXACT: first-attempt = tasks with no `task_rework` row reworking them that are "met"; afterRework = the rework chain's final task is "met". */
    acceptanceRate: z.object({
      firstAttempt: z.object({ met: z.number().int().min(0), total: z.number().int().min(0) }).strict(),
      afterRework: z.object({ met: z.number().int().min(0), total: z.number().int().min(0) }).strict(),
    }).strict(),
    unavailableProjects: z.array(z.object({ project: z.string(), reason: z.string() }).strict()),
    /** Dotted paths of every field above that is an estimate, not a direct measurement. */
    estimates: z.array(z.string()),
  })
  .strict();
export type OffloadReport = z.infer<typeof OffloadReportSchema>;

// ---------------------------------------------------------------------------------------------
// Row shapes read from a project's own store
// ---------------------------------------------------------------------------------------------

interface TaskRow {
  id: string;
  project_id: string;
  profile: string;
  state: string;
  created_at: number;
  finished_at: number | null;
  writable_repo: string | null;
  spec_json: string;
  result_json: string | null;
}

/** Parse a stored result; a corrupt or pre-contract row is treated as absent rather than thrown. */
function safeResult(raw: string | null): WorkerResult | null {
  if (!raw) return null;
  try {
    return WorkerResultSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

function safeSpec(raw: string): Partial<WorkerTask> {
  try {
    return JSON.parse(raw) as Partial<WorkerTask>;
  } catch {
    return {};
  }
}

const utf8Bytes = (s: string): number => Buffer.byteLength(s, "utf8");

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

// ---------------------------------------------------------------------------------------------
// Line attribution over git history
// ---------------------------------------------------------------------------------------------

interface CommitStat {
  sha: string;
  added: number;
  removed: number;
  task: string | null;
  model: string | null;
  authorName: string;
}

/** `git log --numstat` for commits in [sinceSec, untilSec), parsed with their trailers. */
async function commitStatsInWindow(repo: string, sinceMs: number | undefined, untilMs: number, maxCommits: number): Promise<CommitStat[]> {
  const args = ["log", `--max-count=${maxCommits}`, "--no-merges", "--numstat", `--until=${Math.floor(untilMs / 1000)}`, `--format=%x01%H%x1f%an%x1f%(trailers:unfold)%x02`];
  if (sinceMs !== undefined) args.push(`--since=${Math.floor(sinceMs / 1000)}`);
  const raw = await git(repo, args, { maxBuffer: 64 * 1024 * 1024 });
  const out: CommitStat[] = [];
  // Each commit block: \x01<sha>\x1f<author>\x1f<trailers>\x02\n<numstat lines...>
  for (const block of raw.split("\x01").slice(1)) {
    const headEnd = block.indexOf("\x02");
    if (headEnd === -1) continue;
    const head = block.slice(0, headEnd);
    const [sha, authorName, trailerText] = head.split("\x1f");
    if (!sha) continue;
    const trailers: Record<string, string> = {};
    for (const line of (trailerText ?? "").split(/\r?\n/)) {
      const m = /^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/.exec(line.trim());
      if (m) trailers[m[1]!] = m[2]!;
    }
    let added = 0;
    let removed = 0;
    for (const line of block.slice(headEnd + 1).split("\n")) {
      const m = /^(\d+|-)\t(\d+|-)\t/.exec(line);
      if (!m) continue;
      if (m[1] !== "-") added += Number(m[1]);
      if (m[2] !== "-") removed += Number(m[2]);
    }
    out.push({ sha, added, removed, task: trailers.Task ?? null, model: trailers.Model ?? null, authorName: authorName ?? "" });
  }
  return out;
}

/** Model id -> "free" | "paid" | "unknown" from the current catalog (origin "paid" = paid). */
function classify(sy: MeritRouter, model: string | null): "free" | "paid" | "unknown" {
  if (!model) return "unknown";
  const ep = sy.catalog.endpoints().find((e) => e.id === model || e.gatewayModelId === model);
  if (!ep) return "unknown";
  return ep.origin === "paid" ? "paid" : "free";
}

// ---------------------------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------------------------

export async function offloadReport(sy: MeritRouter, input: OffloadReportInput = {}): Promise<OffloadReport> {
  const opts = OffloadReportInputSchema.parse(input);
  const until = opts.until ?? Date.now();
  const since = opts.since;
  const idFilter = opts.sessionTaskIds ? new Set(opts.sessionTaskIds) : null;

  const { rows: allRows, unavailable } = fanOutProjectRows<TaskRow>(sy, opts.project, {}, (db, project) =>
    db
      .prepare(`SELECT id, project_id, profile, state, created_at, finished_at, writable_repo, spec_json, result_json FROM tasks WHERE project_id = ? AND created_at >= ? AND created_at < ?`)
      .all(project, since ?? 0, until) as TaskRow[],
  );
  const rows = idFilter ? allRows.filter((r) => idFilter.has(r.id)) : allRows;

  // ---- tasksByKindOutcome
  const byKey = new Map<string, { kind: string; executionStatus: string | null; acceptanceStatus: string | null; state: string; count: number }>();
  const parsed = rows.map((r) => ({ row: r, result: safeResult(r.result_json) }));
  for (const { row, result } of parsed) {
    const key = `${row.profile}\u0000${result?.executionStatus ?? ""}\u0000${result?.acceptanceStatus ?? ""}\u0000${row.state}`;
    const cur = byKey.get(key) ?? { kind: row.profile, executionStatus: result?.executionStatus ?? null, acceptanceStatus: result?.acceptanceStatus ?? null, state: row.state, count: 0 };
    cur.count++;
    byKey.set(key, cur);
  }

  // ---- commandsRun
  let total = 0, passed = 0, failed = 0, didNotFinish = 0;
  const byKind = new Map<string, number>();
  for (const { row, result } of parsed) {
    for (const c of result?.checks ?? []) {
      total++;
      byKind.set(row.profile, (byKind.get(row.profile) ?? 0) + 1);
      if (c.exitCode === null) didNotFinish++;
      else if (c.exitCode === 0) passed++;
      else failed++;
    }
  }

  // ---- contextCompression
  let bytesHandedIn = 0;
  let bytesReport = 0;
  let counted = 0;
  for (const { row, result } of parsed) {
    if (!result) continue;
    const spec = safeSpec(row.spec_json);
    const ctx = (spec.context ?? {}) as NonNullable<WorkerTask["context"]>;
    bytesHandedIn += utf8Bytes(ctx.inlineText ?? "") + utf8Bytes((ctx.fileRefs ?? []).join("\n")) + utf8Bytes((spec.goal as string) ?? "");
    bytesReport += utf8Bytes(renderReportV1(result));
    counted++;
  }

  // ---- modelUsage
  let modelRequests = 0, inputTokens = 0, outputTokens = 0;
  const bases = new Set<string>();
  for (const { result } of parsed) {
    if (!result) continue;
    modelRequests += result.usage.modelRequests;
    inputTokens += result.usage.inputTokens ?? 0;
    outputTokens += result.usage.outputTokens ?? 0;
    bases.add(result.usage.tokenUsageBasis);
  }
  const tokenBasis: "provider_reported" | "estimated" | "unknown" | "mixed" = bases.size === 0 ? "unknown" : bases.size > 1 ? "mixed" : ([...bases][0] as "provider_reported" | "estimated" | "unknown");

  // ---- channel activity and acceptance rate (per project, since channel_messages/task_rework are project-scoped tables)
  let questions = 0, toolRequests = 0, helpOrBlocked = 0, probes = 0, reworks = 0, answered = 0;
  const latencies: number[] = [];
  let firstMet = 0, firstTotal = 0, afterMet = 0, afterTotal = 0;
  const projectsSeen = [...new Set(rows.map((r) => r.project_id))];
  const taskIdsByProject = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!taskIdsByProject.has(r.project_id)) taskIdsByProject.set(r.project_id, new Set());
    taskIdsByProject.get(r.project_id)!.add(r.id);
  }
  const resultById = new Map(parsed.map((p) => [p.row.id, p.result]));
  const reworkOfById = new Map<string, string>();
  for (const projectId of projectsSeen) {
    const taskIds = [...(taskIdsByProject.get(projectId) ?? [])];
    if (!taskIds.length) continue;
    // A legacy task charged to no project ('') lives in the installation database directly
    // (same as `workers()` above); every other project reads through its own store.
    let db;
    if (!projectId) db = sy.db;
    else {
      try {
        db = requireProjectStores(sy, projectId).db;
      } catch {
        continue;
      }
    }
    const placeholders = taskIds.map(() => "?").join(",");
    const messages = db.prepare(`SELECT * FROM channel_messages WHERE task_id IN (${placeholders})`).all(...taskIds) as Array<{
      id: string; task_id: string; direction: string; kind: string; status: string; created_at: number; answered_at: number | null; in_reply_to: string | null;
    }>;
    const byRequestId = new Map(messages.map((m) => [m.id, m]));
    for (const m of messages) {
      if (m.kind === "question") questions++;
      else if (m.kind === "tool_request") toolRequests++;
      else if (m.kind === "help" || m.kind === "blocked") helpOrBlocked++;
      else if (m.kind === "probe") probes++;
      else if (m.kind === "rework") reworks++;
      if ((m.kind === "answer" || m.kind === "grant" || m.kind === "deny") && m.in_reply_to) {
        answered++;
        const req = byRequestId.get(m.in_reply_to);
        if (req) latencies.push(m.created_at - req.created_at);
      }
    }
    const reworkRows = db.prepare(`SELECT task_id, rework_of FROM task_rework WHERE task_id IN (${placeholders}) OR rework_of IN (${placeholders})`).all(...taskIds, ...taskIds) as Array<{ task_id: string; rework_of: string }>;
    for (const rr of reworkRows) reworkOfById.set(rr.task_id, rr.rework_of);
  }
  const reworkedTaskIds = new Set(reworkOfById.keys());
  const reworkedFrom = new Set(reworkOfById.values());
  for (const r of rows) {
    const result = resultById.get(r.id);
    const met = result?.acceptanceStatus === "met";
    const isRework = reworkedTaskIds.has(r.id);
    const isReworkedAway = reworkedFrom.has(r.id) && !isRework; // the original attempt, superseded
    if (isReworkedAway) continue; // counted via its final rework below
    if (isRework) {
      afterTotal++;
      if (met) afterMet++;
    } else {
      firstTotal++;
      if (met) firstMet++;
    }
  }

  // ---- accepted changed lines by model (git log, per writable repository actually touched)
  const acceptedTaskIds = new Set(parsed.filter((p) => p.result?.acceptanceStatus === "met").map((p) => p.row.id));
  const repoAliases = new Map<string, Set<string>>(); // project -> repo aliases touched
  for (const { row } of parsed) {
    if (!row.writable_repo) continue;
    const { alias } = splitRepoKey(row.writable_repo);
    if (!repoAliases.has(row.project_id)) repoAliases.set(row.project_id, new Set());
    repoAliases.get(row.project_id)!.add(alias);
  }
  const byModel = new Map<string, { classification: "free" | "paid" | "unknown"; added: number; removed: number; commits: number }>();
  const otherAuthors = { added: 0, removed: 0, commits: 0 };
  const notAccepted = { added: 0, removed: 0, commits: 0 };
  const reposSkipped: Array<{ repository: string; reason: string }> = [];
  for (const [projectId, aliases] of repoAliases) {
    // A task charged to no project ('', a legacy row) reads through the primary project's
    // repositories, same as `contextOfTask` (admin/projects.ts) does for a single-project install.
    const ctx = projectId ? sy.projects.context(projectId) : sy.projects.primary;
    if (!ctx) {
      for (const alias of aliases) reposSkipped.push({ repository: `${projectId}:${alias}`, reason: "project_context_unavailable" });
      continue;
    }
    for (const alias of aliases) {
      const repo = ctx.repositoryPaths[alias];
      if (!repo) {
        reposSkipped.push({ repository: `${projectId}:${alias}`, reason: "repository_not_configured" });
        continue;
      }
      let stats: CommitStat[];
      try {
        stats = await commitStatsInWindow(repo.path, since, until, opts.maxCommitsPerRepo);
      } catch {
        reposSkipped.push({ repository: `${projectId}:${alias}`, reason: "git_log_failed" });
        continue;
      }
      for (const c of stats) {
        if (!c.task) {
          otherAuthors.added += c.added;
          otherAuthors.removed += c.removed;
          otherAuthors.commits++;
          continue;
        }
        if (!acceptedTaskIds.has(c.task)) {
          notAccepted.added += c.added;
          notAccepted.removed += c.removed;
          notAccepted.commits++;
          continue;
        }
        const model = c.model ?? "no model trailer";
        const cur = byModel.get(model) ?? { classification: classify(sy, c.model), added: 0, removed: 0, commits: 0 };
        cur.added += c.added;
        cur.removed += c.removed;
        cur.commits++;
        byModel.set(model, cur);
      }
    }
  }

  const estimates = [
    "acceptedLines.byModel[].classification",
    "contextCompression.bytesHandedInEstimate",
    "contextCompression.ratioEstimate",
  ];

  return OffloadReportSchema.parse({
    window: { project: opts.project ?? null, since: since ?? null, until },
    totalTasks: rows.length,
    tasksByKindOutcome: [...byKey.values()],
    acceptedLines: {
      byModel: [...byModel.entries()].map(([model, v]) => ({ model, ...v })),
      otherAuthors,
      notAccepted,
      reposSkipped,
    },
    commandsRun: { total, passed, failed, didNotFinish, byTaskKind: [...byKind.entries()].map(([kind, count]) => ({ kind, count })) },
    contextCompression: {
      bytesHandedInEstimate: bytesHandedIn,
      bytesOfReportReturned: bytesReport,
      ratioEstimate: bytesHandedIn > 0 ? bytesReport / bytesHandedIn : null,
      tasksCounted: counted,
    },
    modelUsage: { modelRequests, inputTokens, outputTokens, tokenBasis },
    channelActivity: { questions, toolRequests, helpOrBlocked, probes, reworks, answeredCount: answered, medianAnswerLatencyMs: median(latencies) },
    acceptanceRate: { firstAttempt: { met: firstMet, total: firstTotal }, afterRework: { met: afterMet, total: afterTotal } },
    unavailableProjects: unavailable,
    estimates,
  });
}
