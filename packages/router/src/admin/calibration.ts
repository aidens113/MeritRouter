import type { MeritRouter } from "../core/service.js";
import { purposeCategory } from "../admission/admission.js";
import { modelFamily } from "../routing/select.js";
import { VERIFICATION_LEVELS } from "../config/schema.js";
import { taskConfirmation, verdictOutcome, verdictRecords, type ConfirmationStatus, type StoredVerdict, type TaskConfirmation, type VerdictOutcome } from "../verification/calibration.js";
import { adminProjectScopes, fanOutProjects, newestFirst, openProjectStores } from "./project-reads.js";
import type { ProjectRuntimeStore } from "../projects/runtime-store.js";

/**
 * The panel's calibration views: how each reviewer's verdicts held up against what happened to
 * the results afterwards, verified vs subsequently confirmed overall and per level, background
 * audits, and model requests by purpose. Re-exported through insights.
 *
 * `verdict_records` and `verification_audits` carry no `project_id` column of their own (only
 * `task_id`); `verdictRecords()` has no project filter either, so listing them per project would
 * need a join this shared, not-owned helper does not expose, and calling it once per project's
 * store against today's single physical database would return the same unfiltered installation
 * rows every time (double-counted once per project, never once per project). Converting those two
 * listings safely needs a project-aware export added to `verification/calibration.ts` (outside
 * this file's owned paths); they are left reading `sy.db` directly, documented here rather than
 * attempted as an unsafe mechanical substitution (the same call A4a made for `insights.ts`'s
 * parameter-less cross-project reads). Everything each listing's rows connect to (a verdict's or
 * audit's confirmation and task goal) is routed through that task's own owning project's store,
 * resolved via `sy.tasks.projectOf` (itself install-wide, used only to locate the owner) so the
 * per-task reads (`events`, `verification_signals`, `tasks`) are project-scoped. `usageByPurpose`'s
 * request/task/charge join is likewise left on `sy.db`: no single project to key its scan on.
 */

const DAY = 86_400_000;
const DEFAULT_WINDOW_MS = 30 * DAY;

export interface ReviewerLevelCalibration {
  level: string;
  reviews: number;
  correct: number;
  falseApprovals: number;
  falseRejections: number;
}

export interface ReviewerCalibration {
  /** Endpoint id (null: reviews that never reached a reviewer are not recorded, so this is rare). */
  reviewer: string | null;
  name: string;
  family: string | null;
  /** Every recorded verdict: verification reviews (including reused ones) and audits. */
  reviews: number;
  audits: number;
  /** Verdicts reused from the cache (no request spent). */
  cached: number;
  pass: number;
  fail: number;
  inconclusive: number;
  /** Reviews that ended without a valid verdict (budget, invalid output, provider error). */
  noVerdict: number;
  qualified: number;
  unqualified: number;
  confirmedCorrect: number;
  falseApprovals: number;
  falseRejections: number;
  /** Decisive verdicts whose task has no confirmation signal yet. */
  pending: number;
  /** Fail verdicts on a revision that was then repaired. */
  ledToRepair: number;
  /** Requests spent on verification reviews (audits are counted separately). */
  requests: number;
  auditRequests: number;
  /** Distinct reviewed tasks whose final result was accepted (met). */
  acceptedTasks: number;
  requestsPerAcceptedTask: number | null;
  levels: ReviewerLevelCalibration[];
}

export interface VerifiedVsConfirmed {
  /** A verification level, or "all". */
  level: string;
  /** Results that passed verification. */
  passed: number;
  confirmed: number;
  /** Accepted or integrated, then undone or failing later job checks. */
  escaped: number;
  rejected: number;
  unconfirmed: number;
}

export interface CalibrationVerdictView {
  id: number;
  taskId: string;
  goal: string;
  purpose: StoredVerdict["purpose"];
  reviewer: string | null;
  reviewerName: string;
  level: string;
  verdict: StoredVerdict["verdict"];
  qualified: boolean;
  cached: boolean;
  outcome: VerdictOutcome;
  confirmation: ConfirmationStatus;
  reasons: string[];
  requests: number;
  at: number;
}

export interface AuditView {
  taskId: string;
  goal: string;
  decision: string;
  status: string;
  reviewer: string | null;
  reviewerName: string | null;
  auditTaskId: string | null;
  verdict: StoredVerdict["verdict"];
  reason: string | null;
  at: number;
}

export interface PurposeUsage {
  /** classification, execution, verification, repair (by request purpose), or audit / qualification (by task purpose). */
  purpose: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface CalibrationOverview {
  sinceMs: number;
  totals: {
    verdicts: number;
    decisive: number;
    inconclusive: number;
    /** Inconclusive verdicts over verdicts given (pass, fail, or inconclusive). */
    inconclusiveRate: number | null;
    cached: number;
    audits: number;
    falseApprovals: number;
    falseRejections: number;
    confirmedCorrect: number;
  };
  reviewers: ReviewerCalibration[];
  /** "all" first, then per level. */
  verified: VerifiedVsConfirmed[];
  /** Verdicts calibration contradicted (false approvals and false rejections), newest first. */
  contradicted: CalibrationVerdictView[];
  recent: CalibrationVerdictView[];
  audits: { sampleRate: number; decisions: Record<string, number>; recent: AuditView[] };
  usage: PurposeUsage[];
}

/**
 * Model requests by purpose since `sinceMs`. A batched request counts once per purpose. Fanned
 * out over every configured project's own store (plus qualification), each filtered to its own
 * `project_id`, so no project's rows are read twice.
 */
export function usageByPurpose(sy: MeritRouter, sinceMs = Date.now() - DEFAULT_WINDOW_MS): PurposeUsage[] {
  type Row = { id: string; rp: string; tp: string | null; inTok: number; outTok: number; cost: number };
  const rows = fanOutProjects(sy, adminProjectScopes(sy), (stores, project) =>
    stores.db
      .prepare(
        `SELECT r.id AS id, r.purpose AS rp, t.purpose AS tp, c.input_tokens AS inTok, c.output_tokens AS outTok, COALESCE(r.reported_cost_usd, r.estimated_cost_usd, 0) AS cost
           FROM request_charges c JOIN model_requests r ON r.id = c.request_id JOIN tasks t ON t.id = c.task_id
          WHERE r.reserved_at >= ? AND r.project_id = ?`,
      )
      .all(sinceMs, project) as Row[],
  ).rows;
  const out = new Map<string, PurposeUsage & { seen: Set<string> }>();
  for (const r of rows) {
    const purpose = r.tp === "audit" || r.tp === "qualification" ? r.tp : purposeCategory(r.rp);
    const u = out.get(purpose) ?? { purpose, requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, seen: new Set<string>() };
    u.inputTokens += r.inTok;
    u.outputTokens += r.outTok;
    if (!u.seen.has(r.id)) {
      u.seen.add(r.id);
      u.requests++;
      u.costUsd += r.cost;
    }
    out.set(purpose, u);
  }
  const order = ["classification", "execution", "verification", "repair", "audit", "qualification"];
  return [...out.values()].map(({ seen: _seen, ...u }) => u).sort((a, b) => order.indexOf(a.purpose) - order.indexOf(b.purpose));
}

export function calibrationOverview(sy: MeritRouter, opts: { sinceMs?: number } = {}): CalibrationOverview {
  const sinceMs = opts.sinceMs ?? Date.now() - DEFAULT_WINDOW_MS;
  // Each task's confirmation/goal is read through its own owning project's store (resolved via
  // the install-wide `projectOf`, used only to locate that owner), never the bare installation db.
  const storeCache = new Map<string, ProjectRuntimeStore | null>();
  const storeOf = (project: string | null): ProjectRuntimeStore | null => {
    const key = project ?? "";
    if (!storeCache.has(key)) {
      const opened = project ? openProjectStores(sy, project) : null;
      storeCache.set(key, opened?.ok ? opened.stores : null);
    }
    return storeCache.get(key)!;
  };
  const depsOf = (taskId: string) => {
    const stores = storeOf(sy.tasks.projectOf(taskId));
    return stores ? { db: stores.db, tasks: stores.tasks, artifacts: stores.artifacts } : { db: sy.db, tasks: sy.tasks, artifacts: sy.artifacts };
  };
  const confirmations = new Map<string, TaskConfirmation | null>();
  const confirm = (id: string) => {
    if (!confirmations.has(id)) confirmations.set(id, taskConfirmation(depsOf(id), id));
    return confirmations.get(id) ?? null;
  };
  const goals = new Map<string, string>();
  const goal = (id: string) => {
    if (!goals.has(id)) {
      const stores = storeOf(sy.tasks.projectOf(id));
      goals.set(id, (stores ? stores.tasks.get(id) : sy.tasks.get(id))?.spec.goal ?? "");
    }
    return goals.get(id)!;
  };
  const name = (id: string | null) => {
    if (!id) return "no reviewer";
    const ep = sy.catalog.get(id);
    return ep?.displayName ?? ep?.gatewayModelId ?? id;
  };

  // `verdict_records` has no project_id column; see the module doc comment for why this stays on
  // the installation database rather than a per-project fan-out.
  const verdicts = verdictRecords(sy.db, { sinceMs });
  const views: CalibrationVerdictView[] = [];
  const byReviewer = new Map<string, ReviewerCalibration & { accepted: Set<string>; byLevel: Map<string, ReviewerLevelCalibration> }>();
  for (const v of verdicts) {
    const c = confirm(v.taskId);
    const outcome: VerdictOutcome = c ? verdictOutcome(v, c) : "pending";
    views.push({
      id: v.id,
      taskId: v.taskId,
      goal: goal(v.taskId),
      purpose: v.purpose,
      reviewer: v.reviewer,
      reviewerName: name(v.reviewer),
      level: v.level,
      verdict: v.verdict,
      qualified: v.qualified,
      cached: v.cachedFrom !== null,
      outcome,
      confirmation: c?.status ?? "unconfirmed",
      reasons: c?.reasons ?? [],
      requests: v.requests,
      at: v.createdAt,
    });
    const key = v.reviewer ?? "";
    let r = byReviewer.get(key);
    if (!r) {
      const ep = v.reviewer ? sy.catalog.get(v.reviewer) : undefined;
      r = {
        reviewer: v.reviewer,
        name: name(v.reviewer),
        family: ep ? modelFamily(ep) : null,
        reviews: 0,
        audits: 0,
        cached: 0,
        pass: 0,
        fail: 0,
        inconclusive: 0,
        noVerdict: 0,
        qualified: 0,
        unqualified: 0,
        confirmedCorrect: 0,
        falseApprovals: 0,
        falseRejections: 0,
        pending: 0,
        ledToRepair: 0,
        requests: 0,
        auditRequests: 0,
        acceptedTasks: 0,
        requestsPerAcceptedTask: null,
        levels: [],
        accepted: new Set<string>(),
        byLevel: new Map(),
      };
      byReviewer.set(key, r);
    }
    r.reviews++;
    if (v.purpose === "audit") {
      r.audits++;
      r.auditRequests += v.requests;
    } else {
      r.requests += v.requests;
      if (c?.acceptanceStatus === "met") r.accepted.add(v.taskId);
    }
    if (v.cachedFrom !== null) r.cached++;
    if (v.verdict === "pass") r.pass++;
    else if (v.verdict === "fail") r.fail++;
    else if (v.verdict === "inconclusive") r.inconclusive++;
    else r.noVerdict++;
    if (v.qualified) r.qualified++;
    else r.unqualified++;
    if (outcome === "correct") r.confirmedCorrect++;
    else if (outcome === "false_approval") r.falseApprovals++;
    else if (outcome === "false_rejection") r.falseRejections++;
    else if (outcome === "pending") r.pending++;
    else if (outcome === "led_to_repair") r.ledToRepair++;
    const l = r.byLevel.get(v.level) ?? { level: v.level, reviews: 0, correct: 0, falseApprovals: 0, falseRejections: 0 };
    l.reviews++;
    if (outcome === "correct") l.correct++;
    if (outcome === "false_approval") l.falseApprovals++;
    if (outcome === "false_rejection") l.falseRejections++;
    r.byLevel.set(v.level, l);
  }
  const reviewers: ReviewerCalibration[] = [...byReviewer.values()]
    .map(({ accepted, byLevel, ...r }) => ({
      ...r,
      acceptedTasks: accepted.size,
      requestsPerAcceptedTask: accepted.size ? r.requests / accepted.size : null,
      levels: VERIFICATION_LEVELS.map((lv) => byLevel.get(lv)).filter((x): x is ReviewerLevelCalibration => !!x),
    }))
    .sort((a, b) => b.reviews - a.reviews);

  // Verified vs subsequently confirmed: results that passed verification, and what happened
  // since. `tasks` carries its own `project_id`, so this listing fans out over every configured
  // project's own store (plus qualification), each capped at 5000 and merged back down to the
  // overall top 5000 by `finished_at` (never more, never a duplicate).
  const passed = fanOutProjects(sy, adminProjectScopes(sy), (stores, project) =>
    (stores.db.prepare("SELECT id, finished_at FROM tasks WHERE purpose = 'work' AND state = 'completed' AND finished_at >= ? AND project_id = ? ORDER BY finished_at DESC LIMIT 5000").all(sinceMs, project) as Array<{ id: string; finished_at: number }>),
  ).rows;
  const passedIds = newestFirst(passed, (r) => r.finished_at, 5000).map((r) => r.id);
  const rows = new Map<string, VerifiedVsConfirmed>([["all", { level: "all", passed: 0, confirmed: 0, escaped: 0, rejected: 0, unconfirmed: 0 }]]);
  for (const id of passedIds) {
    const c = confirm(id);
    if (!c || c.verificationStatus !== "passed") continue;
    for (const k of ["all", c.level ?? "unknown"]) {
      const row = rows.get(k) ?? { level: k, passed: 0, confirmed: 0, escaped: 0, rejected: 0, unconfirmed: 0 };
      row.passed++;
      if (c.status === "confirmed") row.confirmed++;
      else if (c.status === "escaped_defect") row.escaped++;
      else if (c.status === "rejected") row.rejected++;
      else row.unconfirmed++;
      rows.set(k, row);
    }
  }
  const verified = [rows.get("all")!, ...VERIFICATION_LEVELS.map((l) => rows.get(l)).filter((x): x is VerifiedVsConfirmed => !!x)];

  const given = views.filter((v) => v.verdict !== null);
  const inconclusive = given.filter((v) => v.verdict === "inconclusive").length;
  const newest = [...views].reverse();

  // `verification_audits` has no project_id column either; see the module doc comment.
  const auditRows = sy.db
    .prepare("SELECT task_id, decision, status, reviewer, audit_task_id, detail_json, created_at FROM verification_audits WHERE created_at >= ? ORDER BY created_at DESC")
    .all(sinceMs) as Array<{ task_id: string; decision: string; status: string; reviewer: string | null; audit_task_id: string | null; detail_json: string | null; created_at: number }>;
  const decisions: Record<string, number> = {};
  for (const a of auditRows) decisions[a.decision] = (decisions[a.decision] ?? 0) + 1;
  const auditVerdict = new Map(views.filter((v) => v.purpose === "audit").map((v) => [v.taskId, v.verdict]));
  const recentAudits: AuditView[] = auditRows
    .filter((a) => a.decision !== "not_sampled" && a.decision !== "not_eligible")
    .slice(0, 20)
    .map((a) => {
      let reason: string | null = null;
      try {
        const d = JSON.parse(a.detail_json ?? "{}") as { reason?: unknown };
        reason = typeof d.reason === "string" ? d.reason : null;
      } catch {
        reason = null;
      }
      return { taskId: a.task_id, goal: goal(a.task_id), decision: a.decision, status: a.status, reviewer: a.reviewer, reviewerName: a.reviewer ? name(a.reviewer) : null, auditTaskId: a.audit_task_id, verdict: auditVerdict.get(a.task_id) ?? null, reason, at: a.created_at };
    });

  return {
    sinceMs,
    totals: {
      verdicts: views.length,
      decisive: given.length - inconclusive,
      inconclusive,
      inconclusiveRate: given.length ? inconclusive / given.length : null,
      cached: views.filter((v) => v.cached).length,
      audits: views.filter((v) => v.purpose === "audit").length,
      falseApprovals: views.filter((v) => v.outcome === "false_approval").length,
      falseRejections: views.filter((v) => v.outcome === "false_rejection").length,
      confirmedCorrect: views.filter((v) => v.outcome === "correct").length,
    },
    reviewers,
    verified,
    contradicted: newest.filter((v) => v.outcome === "false_approval" || v.outcome === "false_rejection").slice(0, 20),
    recent: newest.slice(0, 30),
    audits: { sampleRate: sy.cfg.verification.audit_sample_rate, decisions, recent: recentAudits },
    usage: usageByPurpose(sy, sinceMs),
  };
}

export type { TaskConfirmation, ConfirmationStatus, VerdictOutcome };
