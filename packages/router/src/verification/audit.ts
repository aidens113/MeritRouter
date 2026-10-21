import { createHash } from "node:crypto";
import type { ResolvedConfig } from "../config/load.js";
import type { Db } from "../storage/db.js";
import type { ArtifactStore } from "../storage/artifacts.js";
import type { StoredTask, SubmitOutcome, TaskStore } from "../storage/tasks.js";
import type { Admission } from "../admission/admission.js";
import type { Catalog } from "../models/catalog.js";
import type { TaskRouter } from "../routing/router.js";
import { modelFamily } from "../routing/select.js";
import { reviewerQualification } from "../qualification/stats.js";
import { isTerminal, type ReviewRecord } from "../core/task.js";
import type { ContractStore } from "./contract.js";
import { resolveLevel } from "./policy.js";
import { renderEvidencePackage, reviewProfile, validateVerdict, VERDICT_JSON_SCHEMA } from "./review.js";
import { recordVerdict, resultRevision } from "./calibration.js";

/**
 * Audit sampling: a share (`verification.audit_sample_rate`) of results that passed verification
 * gets a second, background review by an independent reviewer. An audit never blocks or changes
 * acceptance; its verdict is recorded for calibration only (purpose `audit`).
 *
 * The audit runs as its own task (purpose `audit`, a `review`-type task pinned to the chosen
 * reviewer, free models only, its own small budget), so the scheduler runs it when capacity
 * allows and its requests are charged to the audit, never to the audited task's contract. Audits
 * are skipped while the package allocation is tight or work is waiting for capacity.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Results older than this when sampling is considered are left alone. */
const AUDIT_WINDOW_MS = DAY;
const SWEEP_LIMIT = 25;
const LOG_TAIL = 1500;

export interface AuditHost {
  cfg: ResolvedConfig;
  db: Db;
  tasks: TaskStore;
  artifacts: ArtifactStore;
  admission: Admission;
  catalog: Catalog;
  router: TaskRouter;
  contracts: ContractStore;
  submitTasks: (raw: unknown[], opts: { purpose?: string; project?: string }) => Promise<SubmitOutcome[]>;
}

export type AuditDecision = "sampled" | "not_sampled" | "not_eligible" | "skipped_capacity" | "skipped_no_reviewer" | "skipped_error";

export interface AuditStart {
  taskId: string;
  decision: AuditDecision;
  auditTaskId: string | null;
  reviewer: string | null;
  reason: string;
}

/** Deterministic sampling: a task is sampled when its id hashes below the rate. */
export function auditSampled(taskId: string, rate: number): boolean {
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  return parseInt(createHash("sha256").update(taskId).digest("hex").slice(0, 8), 16) / 0x1_0000_0000 < rate;
}

/** Why the free pool cannot spare an audit now, or null when it can. */
export function auditCapacityShortfall(cfg: ResolvedConfig, db: Db, admission: Pick<Admission, "packageCount">, now: number): string | null {
  const v = cfg.verification;
  const windows: Array<[number | undefined, number, string]> = [
    [cfg.allocation.max_model_requests_per_hour, HOUR, "hourly"],
    [cfg.allocation.max_model_requests_per_day, DAY, "daily"],
  ];
  for (const [limit, ms, name] of windows) {
    if (limit === undefined) continue;
    const left = limit - admission.packageCount(now - ms);
    const need = Math.max(v.audit_max_requests, Math.ceil(limit * v.audit_min_free_fraction));
    if (left < need) return `the ${name} package allocation is tight (${Math.max(0, left)} of ${limit} left; an audit needs ${need} free)`;
  }
  const waiting = (db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE state = 'waiting_for_capacity'").get() as { n: number }).n;
  if (waiting) return `${waiting} task(s) are waiting for capacity`;
  return null;
}

interface AuditRow {
  task_id: string;
  decision: string;
  audit_task_id: string | null;
  reviewer: string | null;
  status: string;
  detail_json: string | null;
  created_at: number;
}

interface AuditDetail {
  revision: string;
  level: string;
  qualified: boolean;
  qualification: string;
  flags: string[];
}

export class Auditor {
  private sweeping = false;

  constructor(
    private readonly h: AuditHost,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * One pass: grade finished audits, then consider recently finished results for sampling (each
   * once). Safe to call on every scheduler tick and from several processes.
   */
  async sweep(): Promise<{ graded: number; started: number }> {
    if (this.sweeping) return { graded: 0, started: 0 };
    this.sweeping = true;
    try {
      const graded = this.gradeFinished();
      let started = 0;
      if (this.h.cfg.verification.audit_sample_rate > 0) {
        const rows = this.h.db
          .prepare(
            `SELECT t.id FROM tasks t LEFT JOIN verification_audits a ON a.task_id = t.id
              WHERE a.task_id IS NULL AND t.state = 'completed' AND t.purpose = 'work' AND t.finished_at >= ?
              ORDER BY t.finished_at LIMIT ?`,
          )
          .all(this.now() - AUDIT_WINDOW_MS, SWEEP_LIMIT) as Array<{ id: string }>;
        for (const { id } of rows) if ((await this.consider(id)).decision === "sampled") started++;
      }
      return { graded, started };
    } finally {
      this.sweeping = false;
    }
  }

  /** Decide (and, when sampled or forced, start) the audit of one finished result. Each task is decided once. */
  async consider(taskId: string, opts: { force?: boolean } = {}): Promise<AuditStart> {
    const h = this.h;
    const t = h.tasks.get(taskId);
    const decided = (decision: AuditDecision, reason: string, extra: Partial<AuditStart> = {}): AuditStart => ({ taskId, decision, auditTaskId: null, reviewer: null, reason, ...extra });
    const existing = h.db.prepare("SELECT * FROM verification_audits WHERE task_id = ?").get(taskId) as AuditRow | undefined;
    if (existing) {
      let reason = "already decided";
      try {
        const d = JSON.parse(existing.detail_json ?? "{}") as { reason?: unknown };
        if (typeof d.reason === "string") reason = d.reason;
      } catch {
        /* keep the generic reason */
      }
      return decided(existing.decision as AuditDecision, reason, { auditTaskId: existing.audit_task_id, reviewer: existing.reviewer });
    }
    const claim = (decision: AuditDecision, status: string, detail: unknown, extra: { auditTaskId?: string | null; reviewer?: string | null } = {}) =>
      h.db
        .prepare("INSERT OR IGNORE INTO verification_audits (task_id, decision, audit_task_id, reviewer, status, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(taskId, decision, extra.auditTaskId ?? null, extra.reviewer ?? null, status, JSON.stringify(detail), this.now()).changes === 1;
    const settle = (decision: AuditDecision, reason: string): AuditStart => {
      claim(decision, "done", { reason });
      return decided(decision, reason);
    };

    const contract = t ? h.contracts.get(taskId) : null;
    const r = t?.result;
    const mode = t ? h.cfg.profiles[t.spec.profile]?.mode : undefined;
    if (!t || !r || !contract || t.row.state !== "completed" || mode === "supervisor" || r.verificationStatus !== "passed") return settle("not_eligible", "only completed results that passed verification are audited");
    if (!opts.force && !auditSampled(taskId, h.cfg.verification.audit_sample_rate)) return settle("not_sampled", `not in the ${h.cfg.verification.audit_sample_rate} sample`);
    const short = auditCapacityShortfall(h.cfg, h.db, h.admission, this.now());
    if (short) return settle("skipped_capacity", short);

    // The auditor: independent of everyone who worked on or reviewed the task, free models only.
    const profile = reviewProfile(h.cfg, t.spec.profile);
    const profileMode = h.cfg.profiles[profile]?.mode;
    if (profileMode !== "read_only" && profileMode !== "completion") return settle("skipped_no_reviewer", `no read-only review task type is configured (${profile} is ${profileMode ?? "missing"})`);
    const served = h.admission.servedEndpointsByPurpose(taskId);
    const authors = [...new Set([...served.classification, ...served.execution, ...served.repair])];
    const reviewers = served.verification;
    const authorEps = authors.map((a) => h.catalog.get(a)).filter((e): e is NonNullable<typeof e> => !!e);
    const tier = (t.row as typeof t.row & { tier?: string | null }).tier ?? contract.contract.tier;
    const level = r.verification?.level ?? contract.contract.verification.level;
    const deep = resolveLevel(h.cfg.verification, "deep").review;
    const requirement = reviewerQualification(h.cfg, "review", contract.contract.tier);
    const plan = (avoid: string[]) =>
      h.router.planReviewer({
        profile,
        tier: (["T1", "T2", "T3"].includes(tier) ? tier : contract.contract.tier) as typeof contract.contract.tier,
        inputModalities: h.router.inputModalities(t),
        avoidEndpoints: avoid,
        avoidFamilies: [...new Set(authorEps.map((e) => modelFamily(e)))],
        avoidProviders: [...new Set(authorEps.map((e) => e.providerId))],
        minTotalParametersB: deep.minTotalParametersB,
        reviewer: requirement,
      });
    const free = (p: ReturnType<typeof plan>) => p.candidates.filter((c) => h.catalog.get(c.id)?.origin !== "paid");
    // A second opinion first: also avoid the task's own reviewers; fall back to authors only.
    let p = plan([...authors, ...reviewers]);
    let pick = free(p)[0];
    if (!pick) {
      p = plan(authors);
      pick = free(p)[0];
    }
    if (!pick) return settle("skipped_no_reviewer", "no free reviewer is available that did not author the task");
    const qualified = p.explanations.find((e) => e.endpointId === pick!.id)?.qualification?.qualified ?? false;

    const revision = resultRevision(h.artifacts, r) ?? "unknown";
    const evidence = this.evidence(t, contract.contract, r, revision, level);
    const detail: AuditDetail = { revision, level, qualified, qualification: "review", flags: ["audit", ...(qualified ? [] : ["reviewer_unqualified"]), ...(reviewers.includes(pick.id) ? ["same_reviewer"] : [])] };
    // Claim before submitting, so two processes never start the same audit.
    if (!claim("sampled", "starting", detail, { reviewer: pick.id })) return decided("sampled", "already decided");
    try {
      const [sub] = await h.submitTasks(
        [
          {
            profile,
            label: "audit",
            goal: `Audit: review the submitted work below against its contract and return your verdict as data (the verdict object). The audited task (${taskId}) had the goal: ${contract.contract.goal.slice(0, 2000)}`,
            ...(t.spec.repositoryAliases?.length ? { repositoryAliases: t.spec.repositoryAliases } : {}),
            context: { inlineText: evidence },
            constraints: { acceptanceCriteria: ["returns a verdict on every criterion of the audited work"], outputSchema: VERDICT_JSON_SCHEMA },
            importance: "low",
            hints: { difficulty: "T1" },
            routing: { endpointId: pick.id },
            budget: { maxModelRequests: h.cfg.verification.audit_max_requests, maxPaidUsd: 0 },
          },
        ],
        // The audit runs in the audited task's project (its repositories).
        { purpose: "audit", ...(t.row.project_id ? { project: t.row.project_id } : {}) },
      );
      h.db.prepare("UPDATE verification_audits SET audit_task_id = ?, status = 'running' WHERE task_id = ?").run(sub!.taskId, taskId);
      h.tasks.event(taskId, "audit_started", { auditTaskId: sub!.taskId, reviewer: pick.id, qualified, revision });
      return decided("sampled", "audit started", { auditTaskId: sub!.taskId, reviewer: pick.id });
    } catch (err) {
      const reason = `the audit task could not be submitted: ${(err as Error).message.slice(0, 300)}`;
      h.db.prepare("UPDATE verification_audits SET decision = 'skipped_error', status = 'done', detail_json = ? WHERE task_id = ?").run(JSON.stringify({ ...detail, reason }), taskId);
      return decided("skipped_error", reason);
    }
  }

  /** Record the verdict of every finished audit task (purpose audit); never touches the audited result. */
  gradeFinished(): number {
    const h = this.h;
    const rows = h.db.prepare("SELECT * FROM verification_audits WHERE status = 'running'").all() as AuditRow[];
    let graded = 0;
    for (const a of rows) {
      const audit = a.audit_task_id ? h.tasks.get(a.audit_task_id) : undefined;
      if (audit && !isTerminal(audit.row.state)) continue;
      // Claim the row so another process does not record it too.
      if (h.db.prepare("UPDATE verification_audits SET status = 'grading' WHERE task_id = ? AND status = 'running'").run(a.task_id).changes === 0) continue;
      let detail: AuditDetail;
      try {
        detail = JSON.parse(a.detail_json ?? "{}") as AuditDetail;
      } catch {
        detail = { revision: "unknown", level: "deep", qualified: false, qualification: "review", flags: ["audit"] };
      }
      const contract = h.contracts.get(a.task_id);
      const res = audit?.result ?? null;
      const requests = a.audit_task_id ? h.admission.taskTotals(a.audit_task_id).requests : 0;
      const base: ReviewRecord = {
        attempt: 1,
        sessionId: null,
        reviewer: a.reviewer,
        qualification: detail.qualification ?? "review",
        qualified: !!detail.qualified,
        flags: Array.isArray(detail.flags) ? detail.flags.filter((f): f is string => typeof f === "string") : ["audit"],
        revision: detail.revision ?? null,
        verdict: null,
        recommendedAction: null,
        criteria: [],
        blockingFindings: [],
        missingEvidence: [],
        score: null,
        requests,
        stopReason: "",
        artifactRef: res?.artifactRefs[0] ?? null,
      };
      let record: ReviewRecord;
      if (!audit || !res || audit.row.state !== "completed" || !contract) record = { ...base, stopReason: `audit task ${audit?.row.state ?? "missing"}${res ? `: ${res.stopReason}` : ""}` };
      else {
        const v = validateVerdict(res.data, { criteria: contract.contract.criteria, revision: detail.revision, policyVersion: contract.contract.fingerprints.policy, universe: null });
        record = v.ok
          ? {
              ...base,
              verdict: v.value.verdict,
              recommendedAction: v.value.recommendedAction,
              criteria: v.value.criteria,
              blockingFindings: v.value.blockingFindings,
              missingEvidence: v.value.missingEvidence,
              score: v.value.score ?? null,
              stopReason: "verdict_submitted",
            }
          : { ...base, stopReason: `invalid_output: ${v.errors.slice(0, 3).join("; ").slice(0, 400)}` };
      }
      const level = (["basic", "standard", "deep", "strict"].includes(detail.level) ? detail.level : "deep") as "basic" | "standard" | "deep" | "strict";
      recordVerdict(h.db, { taskId: a.task_id, purpose: "audit", level, record, auditTaskId: a.audit_task_id, now: this.now() });
      h.db.prepare("UPDATE verification_audits SET status = 'done', finished_at = ? WHERE task_id = ?").run(this.now(), a.task_id);
      h.tasks.event(a.task_id, "audit_completed", { auditTaskId: a.audit_task_id, reviewer: a.reviewer, verdict: record.verdict, disagrees: record.verdict === "fail", stopReason: record.stopReason });
      graded++;
    }
    return graded;
  }

  /** The audit's evidence package: the stored final result, rendered like a verification review's. */
  private evidence(t: StoredTask, c: NonNullable<ReturnType<ContractStore["get"]>>["contract"], r: NonNullable<StoredTask["result"]>, revision: string, level: string): string {
    const readText = (ref: string) => {
      try {
        return this.h.artifacts.read(ref)?.content.toString("utf8") ?? "";
      } catch {
        return "";
      }
    };
    const coding = this.h.cfg.profiles[t.spec.profile]?.mode === "coding";
    const patchRef = r.patchRefs[0] ?? null;
    const tail = (s: string) => (s.length > LOG_TAIL ? `[...]\n${s.slice(-LOG_TAIL)}` : s);
    return renderEvidencePackage({
      goal: c.goal,
      criteria: c.criteria,
      scope: c.scope,
      level,
      policyVersion: c.fingerprints.policy,
      revision,
      baseCommits: r.baseCommits,
      changedPaths: r.changedPaths ?? [],
      patch: coding ? { ref: patchRef, text: (patchRef ? readText(patchRef) : "") || "(no changes)" } : null,
      checks: r.checks.map((x) => ({ command: x.command, exitCode: x.exitCode, revision: x.revision ?? null, logRef: x.logRef, logTail: tail(readText(x.logRef)) })),
      deterministic: r.verification?.checks.map((x) => ({ name: x.name, outcome: x.outcome, detail: x.detail })) ?? [],
      work: coding ? null : { summary: r.summary, findings: r.findings, ...(r.data !== undefined ? { data: r.data } : {}) },
      claim: { summary: r.summary, findings: coding ? r.findings : [], self: [] },
      context: null,
    });
  }
}
