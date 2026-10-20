import { createHash } from "node:crypto";
import type { VerificationLevel } from "../config/schema.js";
import { VERIFICATION_LEVELS } from "../config/schema.js";
import type { Db } from "../storage/db.js";
import type { ArtifactStore } from "../storage/artifacts.js";
import type { TaskStore } from "../storage/tasks.js";
import type { UndoHook } from "../attribution/index.js";
import { ReviewRecordSchema, type AcceptanceStatus, type ReviewRecord, type VerificationStatus, type WorkerResult } from "../core/task.js";
import type { RunOutcome } from "../runners/types.js";
import { reviewerQualification } from "../qualification/stats.js";
import type { AcceptanceContract, StoredContract } from "./contract.js";
import { LEVEL_RANK } from "./policy.js";
import { answerDigest, reviewOutcomeOf, reviewResult, type ReviewDeps, type ReviewPhaseResult, type ReviewRequest, type Verdict } from "./review.js";

/**
 * Verdict calibration: how far a reviewer's verdicts (and verification as a whole) can be
 * trusted, measured against what happened to the result afterwards.
 *
 * - Every reviewer verdict is recorded once (`verdict_records`): the reviewed task, the reviewer
 *   endpoint, the level, whether the reviewer was qualified, the verdict, the revision it
 *   examined, and what it cost. Verification reviews, reused (cached) verdicts, and background
 *   audits all land here; only audits have purpose `audit`.
 * - Confirmation signals: the supervisor's or a person's acceptance or rejection (task events),
 *   integration onto a job branch, job checks on that branch afterwards, and an undo through
 *   attribution (`verification_signals`).
 * - A decisive verdict on the revision that was finally accepted is then correct, a false
 *   approval (it passed work that was undone, failed later job checks, or was rejected), or a
 *   false rejection (it failed work the supervisor accepted and nothing contradicted since).
 * - Cached verdicts: a decisive verdict is reused for the same contract, artifact, policy, and
 *   source revisions, never for a higher level, never across an author, and never once
 *   calibration has contradicted it.
 */

// ---------- verdict records ----------

export const VERDICT_PURPOSES = ["verification", "audit"] as const;
export type VerdictPurpose = (typeof VERDICT_PURPOSES)[number];

export interface StoredVerdict {
  id: number;
  taskId: string;
  purpose: VerdictPurpose;
  attempt: number;
  reviewer: string | null;
  level: VerificationLevel;
  qualification: string | null;
  qualified: boolean;
  verdict: "pass" | "fail" | "inconclusive" | null;
  revision: string | null;
  requests: number;
  cacheKey: string | null;
  /** The record this verdict was reused from (a cached verdict), or null. */
  cachedFrom: number | null;
  auditTaskId: string | null;
  record: ReviewRecord;
  createdAt: number;
}

export interface VerdictInput {
  taskId: string;
  purpose: VerdictPurpose;
  level: VerificationLevel;
  record: ReviewRecord;
  cacheKey?: string | null;
  cachedFrom?: number | null;
  auditTaskId?: string | null;
  now: number;
}

/** Record one verdict (or a review that ran without one). Returns the record id. */
export function recordVerdict(db: Db, v: VerdictInput): number {
  const r = ReviewRecordSchema.parse(v.record);
  return Number(
    db
      .prepare(
        `INSERT INTO verdict_records (task_id, purpose, attempt, reviewer, level, qualification, qualified, verdict, revision, requests, cache_key, cached_from, audit_task_id, record_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(v.taskId, v.purpose, r.attempt, r.reviewer, v.level, r.qualification, r.qualified ? 1 : 0, r.verdict, r.revision, r.requests, v.cacheKey ?? null, v.cachedFrom ?? null, v.auditTaskId ?? null, JSON.stringify(r), v.now).lastInsertRowid,
  );
}

interface VerdictRow {
  id: number;
  task_id: string;
  purpose: string;
  attempt: number;
  reviewer: string | null;
  level: string;
  qualification: string | null;
  qualified: number;
  verdict: string | null;
  revision: string | null;
  requests: number;
  cache_key: string | null;
  cached_from: number | null;
  audit_task_id: string | null;
  record_json: string;
  created_at: number;
}

function toStored(row: VerdictRow): StoredVerdict | null {
  // Stored rows are data: validate before use, skip what does not parse.
  let raw: unknown;
  try {
    raw = JSON.parse(row.record_json);
  } catch {
    return null;
  }
  const record = ReviewRecordSchema.safeParse(raw);
  if (!record.success) return null;
  if (!(VERIFICATION_LEVELS as readonly string[]).includes(row.level) || !(VERDICT_PURPOSES as readonly string[]).includes(row.purpose)) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    purpose: row.purpose as VerdictPurpose,
    attempt: row.attempt,
    reviewer: row.reviewer,
    level: row.level as VerificationLevel,
    qualification: row.qualification,
    qualified: row.qualified === 1,
    verdict: record.data.verdict,
    revision: row.revision,
    requests: row.requests,
    cacheKey: row.cache_key,
    cachedFrom: row.cached_from,
    auditTaskId: row.audit_task_id,
    record: record.data,
    createdAt: row.created_at,
  };
}

/** Verdict records, oldest first. */
export function verdictRecords(db: Db, f: { taskId?: string; reviewer?: string; purpose?: VerdictPurpose; sinceMs?: number; cacheKey?: string } = {}): StoredVerdict[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.taskId) (where.push("task_id = ?"), args.push(f.taskId));
  if (f.reviewer) (where.push("reviewer = ?"), args.push(f.reviewer));
  if (f.purpose) (where.push("purpose = ?"), args.push(f.purpose));
  if (f.sinceMs !== undefined) (where.push("created_at >= ?"), args.push(f.sinceMs));
  if (f.cacheKey) (where.push("cache_key = ?"), args.push(f.cacheKey));
  const rows = db.prepare(`SELECT * FROM verdict_records ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id`).all(...args) as VerdictRow[];
  return rows.map(toStored).filter((v): v is StoredVerdict => v !== null);
}

// ---------- confirmation signals ----------

export const SIGNAL_KINDS = ["integrated", "job_check", "undone"] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

export function recordSignal(db: Db, s: { taskId: string; kind: SignalKind; jobId: string | null; detail?: unknown; now: number }): void {
  db.prepare("INSERT INTO verification_signals (task_id, kind, job_id, detail_json, created_at) VALUES (?, ?, ?, ?, ?)").run(s.taskId, s.kind, s.jobId, s.detail === undefined ? null : JSON.stringify(s.detail), s.now);
}

/** A task's commits were integrated onto a job branch (supervisor `integrate_task`). */
export function recordIntegration(db: Db, tasks: Pick<TaskStore, "event"> | null, i: { taskId: string; jobId: string; repo: string; commits: number; head: string; now: number }): void {
  recordSignal(db, { taskId: i.taskId, kind: "integrated", jobId: i.jobId, detail: { repo: i.repo, commits: i.commits, head: i.head }, now: i.now });
  tasks?.event(i.taskId, "integrated", { jobId: i.jobId, repo: i.repo, commits: i.commits, head: i.head });
}

/** A check ran on a job's integration branch (supervisor `run_check`); it confirms what was integrated before it. */
export function recordJobCheck(db: Db, c: { jobId: string; repo: string; command: string; exitCode: number | null; now: number }): void {
  recordSignal(db, { taskId: c.jobId, kind: "job_check", jobId: c.jobId, detail: { repo: c.repo, command: c.command, exitCode: c.exitCode }, now: c.now });
}

/**
 * The attribution undo hook: every task whose commits an undo took back gets an `undone`
 * signal (an escaped defect when its result had been accepted) and a task event.
 */
export function calibrationUndoHook(db: Db, tasks: Pick<TaskStore, "event"> | null, o: { jobId: string | null; now: () => number }): UndoHook {
  return (change) => {
    const byTask = new Map<string, string[]>();
    for (const u of change.undone) if (u.task) byTask.set(u.task, [...(byTask.get(u.task) ?? []), u.commit]);
    for (const [taskId, commits] of byTask) {
      const detail = { kind: change.kind, undoCommit: change.commit, commits: commits.map((c) => c.slice(0, 12)), reason: change.reason.slice(0, 500), by: change.actor.agent, ...(change.file ? { file: change.file, lines: change.lines ?? [] } : {}) };
      recordSignal(db, { taskId, kind: "undone", jobId: o.jobId, detail, now: o.now() });
      tasks?.event(taskId, "undone", detail);
    }
  };
}

// ---------- confirmation ----------

export type ConfirmationStatus = "confirmed" | "escaped_defect" | "rejected" | "unconfirmed";

export interface TaskConfirmation {
  taskId: string;
  /** The revision (coding: tree or patch digest; otherwise the answer digest) the final result stands at. */
  finalRevision: string | null;
  acceptanceStatus: AcceptanceStatus | null;
  verificationStatus: VerificationStatus | null;
  level: VerificationLevel | null;
  /** The latest acceptance decision by the supervisor or a person. */
  decision: { decision: "accepted" | "rejected"; by: string; at: number } | null;
  integratedAt: number | null;
  /** Job checks run on the job branch after the integration: the latest run of each command decides. */
  jobChecks: { passed: number; failed: number; outcome: "passed" | "failed" | null };
  undoneAt: number | null;
  status: ConfirmationStatus;
  reasons: string[];
}

interface SignalRow {
  id: number;
  task_id: string;
  kind: string;
  job_id: string | null;
  detail_json: string | null;
  created_at: number;
}

function detailOf(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Whether two revision strings name the same revision (a 12+ character prefix matches). */
export function sameRevision(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  return s.length >= 12 && l.startsWith(s);
}

/**
 * The revision a stored result stands at, computed the way the review phase binds verdicts: the
 * last review's revision; else the revision its checks ran on; else (coding) a digest of its
 * patch; else the answer digest.
 */
export function resultRevision(artifacts: Pick<ArtifactStore, "read">, result: WorkerResult): string | null {
  const reviewed = [...(result.verification?.reviews ?? [])].reverse().find((r) => r.revision)?.revision;
  if (reviewed) return reviewed;
  const checked = result.checks.find((c) => typeof c.revision === "string")?.revision;
  if (checked) return checked;
  if (result.patchRefs.length || result.changedPaths !== undefined) {
    const digest = result.checks.find((c) => typeof c.artifactDigest === "string")?.artifactDigest;
    if (digest) return digest;
    const text = result.patchRefs.map((ref) => {
      try {
        return artifacts.read(ref)?.content.toString("utf8") ?? "";
      } catch {
        return "";
      }
    });
    return `patch-${createHash("sha256").update(text.join("\n")).digest("hex").slice(0, 16)}`;
  }
  return answerDigest(result);
}

export interface ConfirmationDeps {
  db: Db;
  tasks: TaskStore;
  artifacts: Pick<ArtifactStore, "read">;
}

/** What happened to a task's result after verification, and the status that follows. */
export function taskConfirmation(d: ConfirmationDeps, taskId: string): TaskConfirmation | null {
  const t = d.tasks.get(taskId);
  if (!t) return null;
  const r = t.result;
  const reasons: string[] = [];
  const decisions = d.db.prepare("SELECT ts, type, data_json FROM events WHERE task_id = ? AND type IN ('result_accepted', 'result_rejected') ORDER BY id").all(taskId) as Array<{ ts: number; type: string; data_json: string | null }>;
  const last = decisions.at(-1);
  const by = last ? detailOf(last.data_json).by : null;
  const byText = by && typeof by === "object" ? `${String((by as Record<string, unknown>).kind ?? "")}:${String((by as Record<string, unknown>).id ?? "")}` : "unknown";
  const decision = last ? { decision: last.type === "result_accepted" ? ("accepted" as const) : ("rejected" as const), by: byText, at: last.ts } : null;

  const signals = d.db.prepare("SELECT * FROM verification_signals WHERE task_id = ? ORDER BY id").all(taskId) as SignalRow[];
  const integrations = signals.filter((s) => s.kind === "integrated");
  const integrated = integrations[0] ?? null;
  const undone = signals.find((s) => s.kind === "undone") ?? null;

  // Job checks after the integration: run_check signals on the job, and the job's own final checks.
  let jobChecks: TaskConfirmation["jobChecks"] = { passed: 0, failed: 0, outcome: null };
  if (integrated?.job_id) {
    const latest = new Map<string, { at: number; ok: boolean }>();
    const note = (command: string, at: number, exitCode: unknown) => {
      const prev = latest.get(command);
      if (!prev || prev.at <= at) latest.set(command, { at, ok: exitCode === 0 });
    };
    const runs = d.db.prepare("SELECT * FROM verification_signals WHERE job_id = ? AND kind = 'job_check' AND created_at >= ? ORDER BY id").all(integrated.job_id, integrated.created_at) as SignalRow[];
    for (const s of runs) {
      const x = detailOf(s.detail_json);
      if (typeof x.command === "string") note(x.command, s.created_at, x.exitCode);
    }
    const job = d.tasks.get(integrated.job_id);
    if (job?.result && job.row.finished_at !== null && job.row.finished_at >= integrated.created_at) for (const c of job.result.checks) note(c.command, job.row.finished_at, c.exitCode);
    const all = [...latest.values()];
    const failed = all.filter((x) => !x.ok).length;
    jobChecks = { passed: all.length - failed, failed, outcome: all.length ? (failed ? "failed" : "passed") : null };
  }

  let status: ConfirmationStatus;
  if (undone) {
    status = "escaped_defect";
    reasons.push(`undone through attribution: ${String(detailOf(undone.detail_json).reason ?? "").slice(0, 200)}`);
  } else if (jobChecks.outcome === "failed") {
    status = "escaped_defect";
    reasons.push(`${jobChecks.failed} job check(s) failed on the job branch after the integration`);
  } else if (decision?.decision === "rejected") {
    status = "rejected";
    reasons.push(`rejected by ${decision.by}`);
  } else if (decision?.decision === "accepted" || integrated) {
    status = "confirmed";
    if (decision?.decision === "accepted") reasons.push(`accepted by ${decision.by}`);
    if (integrated) reasons.push("integrated onto the job branch");
    if (jobChecks.outcome === "passed") reasons.push(`${jobChecks.passed} job check(s) passed after the integration`);
  } else status = "unconfirmed";

  return {
    taskId,
    finalRevision: r ? resultRevision(d.artifacts, r) : null,
    acceptanceStatus: r?.acceptanceStatus ?? null,
    verificationStatus: r?.verificationStatus ?? null,
    level: r?.verification?.level ?? null,
    decision,
    integratedAt: integrated?.created_at ?? null,
    jobChecks,
    undoneAt: undone?.created_at ?? null,
    status,
    reasons,
  };
}

export type VerdictOutcome = "correct" | "false_approval" | "false_rejection" | "pending" | "led_to_repair" | "superseded" | "no_verdict";

/**
 * Judge one verdict against what happened to its task. Only a decisive verdict (pass or fail) on
 * the revision that was finally accepted or rejected is judged; a fail on an earlier revision led
 * to a repair, and inconclusive verdicts (or reviews without a verdict) judge nothing.
 */
export function verdictOutcome(v: Pick<StoredVerdict, "verdict" | "revision">, c: TaskConfirmation): VerdictOutcome {
  if (v.verdict !== "pass" && v.verdict !== "fail") return "no_verdict";
  if (v.revision && c.finalRevision && !sameRevision(v.revision, c.finalRevision)) return v.verdict === "fail" ? "led_to_repair" : "superseded";
  if (c.status === "unconfirmed") return "pending";
  const bad = c.status === "escaped_defect" || c.status === "rejected";
  if (v.verdict === "pass") return bad ? "false_approval" : "correct";
  return bad ? "correct" : "false_rejection";
}

// ---------- verdict cache ----------

/**
 * Digest of what a verdict judged: the goal, criteria, and scope (without the task id, the
 * timestamp, the budget, or the base commits, which are keyed separately as source revisions),
 * so an identical contract on another task keys the same.
 */
export function judgedContractDigest(c: AcceptanceContract): string {
  const judged = {
    goal: c.goal,
    profile: c.profile,
    criteria: c.criteria,
    scope: { repositoryAliases: c.scope.repositoryAliases, writableRepository: c.scope.writableRepository, allowedPaths: c.scope.allowedPaths },
    declaredChecks: c.declaredChecks,
    hasOutputSchema: c.hasOutputSchema,
  };
  return createHash("sha256").update(JSON.stringify(judged)).digest("hex");
}

export interface VerdictCacheKeyParts {
  contractDigest: string;
  artifactDigest: string;
  policyFingerprint: string;
  sourceRevisions: Record<string, string>;
}

export function verdictCacheKey(p: VerdictCacheKeyParts): string {
  const sources = Object.entries(p.sourceRevisions).sort(([a], [b]) => a.localeCompare(b));
  return `vk-${createHash("sha256").update(JSON.stringify([p.contractDigest, p.artifactDigest, p.policyFingerprint, sources])).digest("hex").slice(0, 32)}`;
}

/** The cache key of a review of `outcome` under `contract`, or null when the artifact has no digest. */
export function reviewCacheKey(contract: StoredContract, outcome: RunOutcome, coding: boolean): string | null {
  const ev = outcome.evidence ?? {};
  const artifactDigest = coding ? (ev.artifactDigest ?? ev.revision ?? null) : answerDigest(outcome.result);
  if (!artifactDigest) return null;
  return verdictCacheKey({
    contractDigest: judgedContractDigest(contract.contract),
    artifactDigest,
    policyFingerprint: contract.contract.fingerprints.policy,
    sourceRevisions: { ...contract.contract.scope.baseCommits, ...outcome.result.baseCommits },
  });
}

export interface CacheQuery {
  key: string;
  level: VerificationLevel;
  /** The qualification the level asks for, and whether it is required. */
  qualification: string;
  requirementMode: "preferred" | "required";
  /** Endpoints that served this task: a verdict they gave is never reused for it. */
  avoid: string[];
}

/**
 * A decisive verdict to reuse, or null. A verdict counts only at its own level or a lower one; a
 * required qualification must have been held; the reviewer must be independent of this task's
 * authors; and a verdict calibration has since contradicted is never reused.
 */
export function cachedVerdict(d: ConfirmationDeps, q: CacheQuery): StoredVerdict | null {
  const candidates = verdictRecords(d.db, { cacheKey: q.key, purpose: "verification" }).reverse();
  for (const v of candidates) {
    if (v.cachedFrom !== null || (v.verdict !== "pass" && v.verdict !== "fail")) continue;
    if (LEVEL_RANK[v.level] < LEVEL_RANK[q.level]) continue;
    if (!v.reviewer || q.avoid.includes(v.reviewer)) continue;
    if (q.requirementMode === "required" && !(v.qualified && v.qualification === q.qualification)) continue;
    const c = taskConfirmation(d, v.taskId);
    const judged = c ? verdictOutcome(v, c) : "pending";
    if (judged === "false_approval" || judged === "false_rejection") continue;
    return v;
  }
  return null;
}

/**
 * The review phase with calibration: reuse a cached verdict when one qualifies (no request is
 * spent and no reviewer session runs), otherwise run the review; either way record the verdict.
 */
export async function calibratedReview(d: ReviewDeps, r: ReviewRequest, now: () => number = Date.now): Promise<ReviewPhaseResult> {
  const { task, contract, outcome } = r;
  const id = task.row.id;
  const re = r.reevaluation;
  const coding = !!task.spec.writableRepository && d.cfg.profiles[task.spec.profile]?.mode === "coding";
  const key = d.cfg.verification.cache_verdicts ? reviewCacheKey(contract, outcome, coding) : null;
  if (key) {
    const served = d.gate.admission.servedEndpointsByPurpose(id);
    const qualification = re.review.qualification ?? "review";
    const hit = cachedVerdict(d, {
      key,
      level: re.level,
      qualification,
      requirementMode: reviewerQualification(d.cfg, qualification, r.tier).mode,
      avoid: [...served.classification, ...served.execution, ...served.repair],
    });
    if (hit) return reuseVerdict(d, r, hit, key, coding, now);
  }
  const phase = await reviewResult(d, r);
  // A review that never reached a reviewer (no candidate, no budget) is not a verdict to calibrate.
  if (phase.record.reviewer) recordVerdict(d.db, { taskId: id, purpose: "verification", level: re.level, record: phase.record, cacheKey: phase.verdict ? key : null, now: now() });
  return phase;
}

function reuseVerdict(d: ReviewDeps, r: ReviewRequest, hit: StoredVerdict, key: string, coding: boolean, now: () => number): ReviewPhaseResult {
  const { task, contract, outcome } = r;
  const ev = outcome.evidence ?? {};
  const revision = ev.revision ?? (coding ? (ev.artifactDigest ?? "unknown") : answerDigest(outcome.result));
  const h = hit.record;
  const record: ReviewRecord = {
    ...h,
    attempt: r.attempt,
    sessionId: null,
    revision,
    requests: 0,
    flags: [...h.flags.filter((f) => f !== "cached_verdict"), "cached_verdict"],
    stopReason: `cached_verdict: record ${hit.id} (task ${hit.taskId}, ${hit.level})`,
  };
  const verdict: Verdict = {
    verdict: hit.verdict as "pass" | "fail",
    examinedRevision: revision,
    policyVersion: contract.contract.fingerprints.policy,
    criteria: h.criteria,
    blockingFindings: h.blockingFindings,
    missingEvidence: h.missingEvidence,
    recommendedAction: h.recommendedAction ?? (hit.verdict === "pass" ? "accept" : "needs_supervisor"),
    ...(h.score !== null ? { score: h.score } : {}),
  };
  d.tasks.event(task.row.id, "review_cached", { attempt: r.attempt, from: hit.id, fromTask: hit.taskId, reviewer: hit.reviewer, level: hit.level, verdict: hit.verdict });
  recordVerdict(d.db, { taskId: task.row.id, purpose: "verification", level: r.reevaluation.level, record, cacheKey: key, cachedFrom: hit.id, now: now() });
  return { outcome: reviewOutcomeOf(verdict), verdict, record, budgetExhausted: false, notes: [`review ${r.attempt}: reused the ${hit.level} verdict ${hit.verdict} by ${hit.reviewer} (record ${hit.id}) for the same contract, artifact, policy, and sources`] };
}
