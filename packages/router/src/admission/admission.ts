import type { Db } from "../storage/db.js";
import { immediate, newId } from "../storage/db.js";
import type { TaskStore } from "../storage/tasks.js";
import type { ResolvedConfig } from "../config/load.js";
import { TIER_NAMES, type ProfileName, type TierName } from "../config/schema.js";
import type { BudgetInput } from "../verification/contract.js";
import type { WorkerTask } from "../core/task.js";
import { AdmissionDenied } from "../core/errors.js";
import type { PaidSpend, SpendKey, TokenPrice } from "../paid/spend.js";
import { projectLimits } from "../projects/schema.js";
import { workerHeld } from "./job-pool.js";
import { SqliteRequestAccounting } from "./sqlite-request-ledger.js";
import type { RequestOutcomeDTO } from "./request-ledger.js";

/** Effective per-task limits: task budgets may narrow configured policy, never widen it. */
export interface EffectiveBudget {
  maxModelRequests: number;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  /** Per-task paid cap in USD (null: only global, key, and balance limits apply). */
  maxPaidUsd: number | null;
}

export function effectiveBudget(cfg: ResolvedConfig, spec: WorkerTask, tier: TierName | null = null): EffectiveBudget {
  const profile = cfg.profiles[spec.profile]!;
  const supervisor = profile.mode === "supervisor";
  const tierCap = tier && !supervisor ? cfg.tiers[tier].max_model_requests : Number.MAX_SAFE_INTEGER;
  const narrow = (configured: number | undefined, requested: number | undefined): number | null => {
    if (configured === undefined) return requested ?? null;
    return requested === undefined ? configured : Math.min(configured, requested);
  };
  return {
    maxModelRequests: Math.min(
      profile.max_model_requests,
      tierCap,
      supervisor ? Number.MAX_SAFE_INTEGER : cfg.execution.max_model_requests_per_task,
      spec.budget?.maxModelRequests ?? Number.MAX_SAFE_INTEGER,
    ),
    maxInputTokens: narrow(profile.max_input_tokens, spec.budget?.maxInputTokens),
    maxOutputTokens: spec.budget?.maxOutputTokens ?? null,
    maxPaidUsd: cfg.paid.enabled ? (spec.budget?.maxPaidUsd ?? null) : 0,
  };
}

/**
 * A task's total model requests across every purpose (classification, execution, review,
 * repair): verification.max_total_requests_per_task, narrowed by an explicit task
 * budget.maxModelRequests. Profile and tier caps bound execution only; the review and repair
 * reserves sit on top of them inside this total.
 */
export function verificationTotal(cfg: ResolvedConfig, spec: WorkerTask): number {
  return Math.min(cfg.verification.max_total_requests_per_task, spec.budget?.maxModelRequests ?? Number.MAX_SAFE_INTEGER);
}

/**
 * The request counts a task's contract allocation is computed from: the ceiling, the execution
 * cap at its tier, and the cap at the tier a quality repair runs at (the next tier when
 * routing.escalate_on_failure is on, else the same tier).
 */
export function budgetInputFor(cfg: ResolvedConfig, spec: WorkerTask, tier: TierName, classificationUsed: number): BudgetInput {
  const next = TIER_NAMES[TIER_NAMES.indexOf(tier) + 1] ?? null;
  const repairTier = cfg.routing.escalate_on_failure && next ? next : tier;
  return {
    total: verificationTotal(cfg, spec),
    tierExecution: effectiveBudget(cfg, spec, tier).maxModelRequests,
    nextTierExecution: effectiveBudget(cfg, spec, repairTier).maxModelRequests,
    classificationUsed,
    repairTier,
  };
}

// ---------- sub-supervisor budgets ----------

/** A request budget carved from a parent job for one sub-supervisor (`job_budget_carves`). */
export interface BudgetCarve {
  childTaskId: string;
  parentTaskId: string;
  requests: number;
  /** The parent's remaining requests when it carved (null when recorded on recovery). */
  parentRemaining: number | null;
  share: number;
  depth: number;
  createdAt: number;
}

const TERMINAL_TASK_STATES = new Set(["completed", "failed", "cancelled", "budget_exhausted"]);

function requestsCharged(db: Db, taskId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM request_charges WHERE task_id = ?").get(taskId) as { n: number }).n;
}

/**
 * Requests a parent job has handed to its sub-supervisors: an open sub-job holds its whole
 * carve; a finished one counts what it (and its own sub-jobs) actually used, so the unused rest
 * returns to the parent.
 */
export function carvedRequests(db: Db, parentTaskId: string, depth = 0): number {
  if (depth > 8) return 0;
  const rows = db
    .prepare("SELECT c.child_task_id AS child, c.requests AS requests, t.state AS state FROM job_budget_carves c JOIN tasks t ON t.id = c.child_task_id WHERE c.parent_task_id = ?")
    .all(parentTaskId) as Array<{ child: string; requests: number; state: string }>;
  let total = 0;
  for (const r of rows) total += TERMINAL_TASK_STATES.has(r.state) ? Math.min(r.requests, requestsCharged(db, r.child) + carvedRequests(db, r.child, depth + 1)) : r.requests;
  return total;
}

/**
 * Everything a job's budget holds for others: its sub-supervisors' carves and its worker tasks'
 * grants (budget control D2; see admission/job-pool.ts). Its own requests come on top.
 */
export function heldRequests(db: Db, jobId: string): number {
  return carvedRequests(db, jobId) + workerHeld(db, jobId);
}

/**
 * The budget a new sub-supervisor gets: `share` of what the parent has left after its own
 * requests and its open carves, rounded down; null when that is below `min`.
 */
export function childRequestBudget(o: { parentCap: number; parentUsed: number; carved: number; share: number; min: number }): { requests: number; remaining: number } | null {
  const remaining = Math.max(0, o.parentCap - o.parentUsed - o.carved);
  const requests = Math.floor(remaining * o.share);
  return requests >= o.min ? { requests, remaining } : null;
}

/** Record a carve; idempotent per child (a resumed parent records missing carves again). */
export function recordCarve(db: Db, c: Omit<BudgetCarve, "createdAt">, now: number): void {
  db.prepare("INSERT OR IGNORE INTO job_budget_carves (child_task_id, parent_task_id, requests, parent_remaining, share, depth, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    c.childTaskId,
    c.parentTaskId,
    c.requests,
    c.parentRemaining,
    c.share,
    c.depth,
    now,
  );
}

export function carvesOf(db: Db, parentTaskId: string): BudgetCarve[] {
  const rows = db.prepare("SELECT * FROM job_budget_carves WHERE parent_task_id = ? ORDER BY created_at, child_task_id").all(parentTaskId) as Array<{
    child_task_id: string;
    parent_task_id: string;
    requests: number;
    parent_remaining: number | null;
    share: number;
    depth: number;
    created_at: number;
  }>;
  return rows.map((r) => ({ childTaskId: r.child_task_id, parentTaskId: r.parent_task_id, requests: r.requests, parentRemaining: r.parent_remaining, share: r.share, depth: r.depth, createdAt: r.created_at }));
}

/** What a model request was for, as budgets and usage reports group them. */
export const REQUEST_PURPOSES = ["classification", "execution", "verification", "repair"] as const;
export type RequestPurpose = (typeof REQUEST_PURPOSES)[number];

/** Group a raw request purpose label: runners label their own (tool_loop, coding, batch, ...), all execution. */
export function purposeCategory(purpose: string): RequestPurpose {
  if (purpose === "classification" || purpose === "verification" || purpose === "repair") return purpose;
  return "execution";
}

export interface Participant {
  taskId: string;
  leaseOwner: string;
  budget: EffectiveBudget;
  estInputTokens: number;
  reservedOutputTokens: number;
}

export interface ReservationRequest {
  executionId: string;
  profile: ProfileName;
  purpose: string;
  gatewayModel: string;
  endpointId: string | null;
  tier: string | null;
  routeNote?: string | null;
  /** Physical request totals (a batch is one request shared by several tasks). */
  estInputTokens: number;
  reservedOutputTokens: number;
  participants: Participant[];
  /** Direct paid request: the worst-case cost is reserved atomically with the request. */
  paid?: { spend: PaidSpend; key: SpendKey; provider: string; worstCaseUsd: number; price: TokenPrice };
}

export interface Reservation {
  requestId: string;
  executionId: string;
  participants: Participant[];
  paid?: ReservationRequest["paid"];
  estInputTokens: number;
  reservedOutputTokens: number;
}

export interface TaskUsageTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export class Admission {
  private readonly accounting: SqliteRequestAccounting;
  constructor(
    private readonly db: Db,
    private readonly tasks: TaskStore,
    private readonly cfg: ResolvedConfig,
    private readonly now: () => number = Date.now,
  ) {
    this.accounting = new SqliteRequestAccounting(db, tasks, cfg, now, {
      taskTotals: id => this.taskTotals(id), heldRequests: id => heldRequests(db, id),
      packageCount: since => this.packageCount(since),
      windowReopensAt: (window, limit, at, project) => this.windowReopensAt(window, limit, at, project),
      projectShareDenial: (project, share, at) => this.projectShareDenial(project, share, at),
    });
  }

  createExecution(kind: "task" | "batch", profile: ProfileName, members: Array<{ taskId: string; itemId: string }>, retryOf?: string): string {
    const id = newId(kind === "batch" ? "b" : "x");
    immediate(this.db, () => {
      this.db
        .prepare("INSERT INTO executions (id, kind, profile, retry_of, status, created_at) VALUES (?, ?, ?, ?, 'running', ?)")
        .run(id, kind, profile, retryOf ?? null, this.now());
      const ins = this.db.prepare("INSERT INTO execution_members (execution_id, task_id, item_id) VALUES (?, ?, ?)");
      for (const m of members) ins.run(id, m.taskId, m.itemId);
    });
    return id;
  }

  finishExecution(id: string, status: string, detail?: unknown): void {
    this.db
      .prepare("UPDATE executions SET status = ?, finished_at = ?, detail_json = ? WHERE id = ?")
      .run(status, this.now(), detail === undefined ? null : JSON.stringify(detail), id);
  }

  setMemberOutcome(executionId: string, taskId: string, outcome: string): void {
    this.db.prepare("UPDATE execution_members SET outcome = ? WHERE execution_id = ? AND task_id = ?").run(outcome, executionId, taskId);
  }

  taskTotals(taskId: string): TaskUsageTotals {
    const r = this.db
      .prepare(
        "SELECT COUNT(*) AS requests, COALESCE(SUM(input_tokens), 0) AS inputTokens, COALESCE(SUM(output_tokens), 0) AS outputTokens FROM request_charges WHERE task_id = ?",
      )
      .get(taskId) as TaskUsageTotals;
    return r;
  }

  /** Requests charged to a task, by purpose (see purposeCategory). */
  taskTotalsByPurpose(taskId: string): Record<RequestPurpose, number> {
    const rows = this.db
      .prepare("SELECT r.purpose AS purpose, COUNT(*) AS n FROM request_charges c JOIN model_requests r ON r.id = c.request_id WHERE c.task_id = ? GROUP BY r.purpose")
      .all(taskId) as Array<{ purpose: string; n: number }>;
    const out: Record<RequestPurpose, number> = { classification: 0, execution: 0, verification: 0, repair: 0 };
    for (const r of rows) out[purposeCategory(r.purpose)] += r.n;
    return out;
  }

  /** Endpoints that served (succeeded) requests charged to a task, by purpose. */
  servedEndpointsByPurpose(taskId: string): Record<RequestPurpose, string[]> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT r.purpose AS purpose, r.served_endpoint_id AS endpoint FROM request_charges c JOIN model_requests r ON r.id = c.request_id
          WHERE c.task_id = ? AND r.served_endpoint_id IS NOT NULL`,
      )
      .all(taskId) as Array<{ purpose: string; endpoint: string }>;
    const out: Record<RequestPurpose, string[]> = { classification: [], execution: [], verification: [], repair: [] };
    for (const r of rows) {
      const list = out[purposeCategory(r.purpose)];
      if (!list.includes(r.endpoint)) list.push(r.endpoint);
    }
    return out;
  }

  packageCount(sinceMs: number): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM model_requests WHERE reserved_at > ?").get(sinceMs) as { n: number }).n;
  }

  /** Requests one project reserved since `sinceMs` (attributed by `model_requests.project_id`). */
  projectCount(project: string, sinceMs: number): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM model_requests WHERE project_id = ? AND reserved_at > ?").get(project, sinceMs) as { n: number }).n;
  }

  /** Oldest request inside the window (of one project, when given); capacity returns when it ages out. */
  private windowReopensAt(windowMs: number, limit: number, now: number, project?: string): number {
    const row = (
      project === undefined
        ? this.db.prepare("SELECT reserved_at FROM model_requests WHERE reserved_at > ? ORDER BY reserved_at DESC LIMIT 1 OFFSET ?").get(now - windowMs, limit - 1)
        : this.db.prepare("SELECT reserved_at FROM model_requests WHERE project_id = ? AND reserved_at > ? ORDER BY reserved_at DESC LIMIT 1 OFFSET ?").get(project, now - windowMs, limit - 1)
    ) as { reserved_at: number } | undefined;
    return row ? row.reserved_at + windowMs + 1 : now;
  }

  /**
   * A project's share of the package allocation (decision D7): with `request_share` set, the
   * project may reserve at most that fraction (at least one request) of each configured window.
   * Denied with `project_allocation_exhausted` and the time the window reopens, so the task waits
   * for capacity like a package allocation denial.
   */
  private projectShareDenial(project: string, share: number | undefined, now: number): AdmissionDenied | null {
    if (share === undefined) return null;
    const { max_model_requests_per_hour: perHour, max_model_requests_per_day: perDay } = this.cfg.allocation;
    const windows: Array<[number | undefined, number, "hour" | "day"]> = [
      [perHour, HOUR, "hour"],
      [perDay, DAY, "day"],
    ];
    for (const [cap, windowMs, unit] of windows) {
      if (cap === undefined) continue;
      const allowed = Math.max(1, Math.floor(cap * share));
      if (this.projectCount(project, now - windowMs) >= allowed) {
        return new AdmissionDenied("project_allocation_exhausted", `project ${project} share of the package allocation (${allowed} of ${cap} requests/${unit}) reached`, this.windowReopensAt(windowMs, allowed, now, project));
      }
    }
    return null;
  }

  /** SQLite-only synchronous compatibility facade; routed requests use RequestLedger. */
  assertDispatch(participants: Participant[]): void { this.accounting.assertDispatch(participants); }

  reserve(req: ReservationRequest): Reservation { return this.accounting.reserve(req); }

  reconcile(res: Reservation, outcome: RequestOutcomeDTO): void { this.accounting.reconcile(res, outcome); }
}
