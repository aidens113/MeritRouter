import { z } from "zod";
import type { Db } from "../storage/db.js";
import { immediate } from "../storage/db.js";
import type { ResolvedConfig } from "../config/load.js";
import { TIER_NAMES, type ProfileName, type TierName } from "../config/schema.js";
import { MeritRouterError } from "../core/errors.js";
import { TaskStore } from "../storage/tasks.js";
import { ChannelStore, type ChannelKind } from "../storage/channel.js";
import { ContractStore } from "../verification/contract.js";
import { effectiveBudget, heldRequests, UNLIMITED_REQUESTS, verificationTotal } from "./admission.js";
import { extraRequests, grantOf } from "./job-pool.js";

/**
 * Budget control (docs/working/budget-control.md, D1-D5): the request pool of a job and the
 * request-for-more workflow. A worker that runs low files a request (`request_more_budget`); the
 * job's supervisor, an external supervisor over MCP, the auto approver, or a person decides it.
 * An approved request raises the task's run cap and counts in its contract's budget history
 * (events), and is drawn from the job's pool, which is checked here in one transaction. Paid
 * spend is unaffected (D6): a paid request still needs paid headroom.
 */

export const BUDGET_APPROVERS = ["supervisor", "external", "auto", "human"] as const;
export type BudgetApprover = (typeof BUDGET_APPROVERS)[number];
export const BUDGET_REQUEST_STATUSES = ["pending", "approved", "denied", "expired"] as const;
export type BudgetRequestStatus = (typeof BUDGET_REQUEST_STATUSES)[number];

/** Most requests one request for more may ask for. */
export const MAX_BUDGET_REQUEST = 1000;

export interface BudgetRequest {
  id: number;
  taskId: string;
  /** The job whose pool pays (the task's supervising parent); null for a top-level task. */
  jobId: string | null;
  project: string;
  role: string;
  /** Requests asked for. */
  requests: number;
  reason: string;
  /** Requests the task had used, and its run cap, when it asked. */
  used: number;
  cap: number;
  /** Who decides: the job's supervisor, an external supervisor (MCP), auto, or a person. */
  approver: BudgetApprover;
  status: BudgetRequestStatus;
  /** Requests granted (0 unless approved). */
  granted: number;
  decidedBy: string | null;
  decisionReason: string | null;
  createdAt: number;
  decidedAt: number | null;
}

const RowSchema = z.object({
  id: z.number().int(),
  task_id: z.string(),
  job_id: z.string().nullable(),
  project_id: z.string(),
  role: z.string(),
  requests: z.number().int(),
  reason: z.string(),
  used: z.number().int(),
  cap: z.number().int(),
  approver: z.enum(BUDGET_APPROVERS),
  status: z.enum(BUDGET_REQUEST_STATUSES),
  granted: z.number().int(),
  decided_by: z.string().nullable(),
  decision_reason: z.string().nullable(),
  created_at: z.number().int(),
  decided_at: z.number().int().nullable(),
});

function hydrate(raw: unknown): BudgetRequest {
  const r = RowSchema.parse(raw);
  return {
    id: r.id,
    taskId: r.task_id,
    jobId: r.job_id,
    project: r.project_id,
    role: r.role,
    requests: r.requests,
    reason: r.reason,
    used: r.used,
    cap: r.cap,
    approver: r.approver,
    status: r.status,
    granted: r.granted,
    decidedBy: r.decided_by,
    decisionReason: r.decision_reason,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
  };
}

/** A job's request pool: its budget, its own requests, what its tasks hold, and what is left to grant. */
export interface JobPool {
  jobId: string;
  /** Null when no job-wide request cap is configured. */
  cap: number | null;
  /** Requests the job's supervisor itself used. */
  used: number;
  /** Requests its open tasks and sub-supervisors hold (finished ones count what they used). */
  held: number;
  /** Kept for the supervisor's own turns (team.supervisor_reserve_requests). */
  reserve: number;
  /** What new grants and approvals may still take. */
  /** Null when uncapped. */
  available: number | null;
}

/** The pool of a supervising task (null for a task that is not a supervisor job). */
export function jobPool(db: Db, cfg: ResolvedConfig, jobId: string): JobPool | null {
  const job = new TaskStore(db).get(jobId);
  if (!job || cfg.profiles[job.spec.profile]?.mode !== "supervisor") return null;
  const limit = Math.min(effectiveBudget(cfg, job.spec, null).maxModelRequests, verificationTotal(cfg, job.spec));
  const used = (db.prepare("SELECT COUNT(*) AS n FROM request_charges WHERE task_id = ?").get(jobId) as { n: number }).n;
  const held = heldRequests(db, jobId);
  const reserve = cfg.team.supervisor_reserve_requests;
  const cap = limit === UNLIMITED_REQUESTS ? null : limit;
  const available = cap === null ? null : Math.max(0, cap - used - held - reserve);
  return { jobId, cap, used, held, reserve, available };
}

/** One line describing a pool, for supervisors and the CLI. */
export function poolLine(p: JobPool): string {
  return p.cap === null
    ? `job ${p.jobId} pool: uncapped (supervisor used ${p.used}, tasks hold ${p.held}, ${p.reserve} reserved for the supervisor)`
    : `job ${p.jobId} pool: ${p.available} available of ${p.cap} (supervisor used ${p.used}, tasks hold ${p.held}, ${p.reserve} kept for the supervisor)`;
}

/**
 * The budget a delegated worker task gets when its brief sets no max_requests:
 * team.default_task_requests, else the execution cap at the brief's tier (its difficulty; without
 * one T2, or the profile's minimum tier when higher; T4 counts as T3), bounded by the profile and
 * per-task caps. A task classified higher may use more; the pool then counts what it used.
 */
export function defaultTaskGrant(cfg: ResolvedConfig, profile: ProfileName, difficulty?: string | null): number {
  if (cfg.team.default_task_requests !== undefined) return cfg.team.default_task_requests;
  const p = cfg.profiles[profile];
  const named = difficulty === "T4" ? "T3" : difficulty;
  const floor = p && TIER_NAMES.indexOf(p.min_tier) > TIER_NAMES.indexOf("T2") ? p.min_tier : "T2";
  const tier: TierName = named && (TIER_NAMES as readonly string[]).includes(named) ? (named as TierName) : floor;
  return Math.min(p?.max_model_requests ?? UNLIMITED_REQUESTS, cfg.tiers[tier].max_model_requests, cfg.execution.max_model_requests_per_task);
}

/** The supervising job a task's pool belongs to: its parent, when that is a supervisor job. */
export function jobOfTask(db: Db, cfg: ResolvedConfig, taskId: string): string | null {
  const tasks = new TaskStore(db);
  const parent = tasks.get(taskId)?.spec.parentTaskId;
  if (!parent) return null;
  const job = tasks.get(parent);
  return job && cfg.profiles[job.spec.profile]?.mode === "supervisor" ? parent : null;
}

const TERMINAL = new Set(["completed", "failed", "cancelled", "budget_exhausted"]);
const POST_AUTHOR = { sessionId: null, role: "system", label: "budget" } as const;

export interface DecideInput {
  approve: boolean;
  /** Requests to grant (default: what was asked); never more than the job's pool has available. */
  grant?: number | null;
  by: string;
  reason: string;
  /** The task's project configuration (team settings, the job's budget). */
  cfg: ResolvedConfig;
}

/** Requests for more model requests and their decisions (`budget_requests`). */
export class BudgetRequests {
  private readonly tasks: TaskStore;

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {
    this.tasks = new TaskStore(db, now);
  }

  get(id: number): BudgetRequest | null {
    const r = this.db.prepare("SELECT * FROM budget_requests WHERE id = ?").get(id);
    return r ? hydrate(r) : null;
  }

  list(filter: { status?: BudgetRequestStatus; jobId?: string; taskId?: string; project?: string; limit?: number } = {}): BudgetRequest[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.status) (where.push("status = ?"), args.push(filter.status));
    if (filter.jobId) (where.push("job_id = ?"), args.push(filter.jobId));
    if (filter.taskId) (where.push("task_id = ?"), args.push(filter.taskId));
    if (filter.project !== undefined) (where.push("project_id = ?"), args.push(filter.project));
    const limit = Math.max(1, Math.min(filter.limit ?? 200, 1000));
    return this.db.prepare(`SELECT * FROM budget_requests ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ${limit}`).all(...args).map(hydrate);
  }

  /** Requests a task has filed (any status): team.max_budget_requests_per_task bounds them. */
  countFor(taskId: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM budget_requests WHERE task_id = ?").get(taskId) as { n: number }).n;
  }

  /** File a request; it waits for its approver (see `decide`, `autoDecide`). */
  file(input: { taskId: string; jobId: string | null; role: string; requests: number; reason: string; used: number; cap: number; approver: BudgetApprover }): BudgetRequest {
    if (!Number.isInteger(input.requests) || input.requests < 1 || input.requests > MAX_BUDGET_REQUEST) throw new MeritRouterError("invalid_request", `requests must be a whole number from 1 to ${MAX_BUDGET_REQUEST}`);
    const reason = input.reason.trim().slice(0, 2000);
    if (!reason) throw new MeritRouterError("invalid_request", "a reason is required");
    const id = Number(
      this.db
        .prepare("INSERT INTO budget_requests (task_id, job_id, role, requests, reason, used, cap, approver, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)")
        .run(input.taskId, input.jobId, input.role, input.requests, reason, input.used, input.cap, input.approver, this.now()).lastInsertRowid,
    );
    const req = this.get(id)!;
    const data = { id, requests: req.requests, reason: req.reason, used: req.used, cap: req.cap, approver: req.approver };
    this.tasks.event(req.taskId, "budget_requested", data);
    if (req.jobId) {
      this.tasks.event(req.jobId, "budget_requested", { ...data, taskId: req.taskId });
      this.post(req, "blocker", `Budget request #${id}: ${req.requests} more model request(s) (used ${req.used} of ${req.cap}). Reason: ${req.reason}`);
    }
    return req;
  }

  /**
   * Decide a pending request. An approval grants `grant` (default: what was asked) from the job's
   * pool, refused when the pool has less available; a task that already finished cannot be
   * granted more (the request expires). Throws a MeritRouterError with the reason.
   */
  decide(id: number, d: DecideInput): BudgetRequest {
    let finished: string | null = null;
    const decided = immediate(this.db, () => {
      const req = this.get(id);
      if (!req) throw new MeritRouterError("not_found", `unknown budget request ${id}`);
      if (req.status !== "pending") throw new MeritRouterError("already_decided", `budget request ${id} is already ${req.status}${req.decidedBy ? ` (by ${req.decidedBy})` : ""}`);
      const state = this.tasks.get(req.taskId)?.row.state ?? "unknown";
      if (TERMINAL.has(state)) {
        // Recorded (not rolled back), then refused below.
        finished = state;
        this.settle(id, "expired", 0, "meritrouter", `task already ${state}`);
        return this.get(id)!;
      }
      const reason = d.reason.trim().slice(0, 2000) || (d.approve ? "approved" : "denied");
      if (!d.approve) {
        this.settle(id, "denied", 0, d.by, reason);
        return this.get(id)!;
      }
      const grant = d.grant ?? req.requests;
      if (!Number.isInteger(grant) || grant < 1 || grant > MAX_BUDGET_REQUEST) throw new MeritRouterError("invalid_request", `grant must be a whole number from 1 to ${MAX_BUDGET_REQUEST}`);
      if (req.jobId) {
        const pool = jobPool(this.db, d.cfg, req.jobId);
        if (pool?.available !== null && pool && grant > pool.available) throw new MeritRouterError("budget_pool_exhausted", `grant ${grant} does not fit: ${poolLine(pool)}; grant at most ${pool.available}, or deny`);
      }
      this.settle(id, "approved", grant, d.by, reason);
      return this.get(id)!;
    });
    this.announce(decided);
    if (finished) throw new MeritRouterError("task_finished", `task ${decided.taskId} already ${finished}; its budget request ${id} expired`);
    return decided;
  }

  /**
   * The auto approver: grant what was asked, up to team.auto_grant_max and what the job's pool has
   * available; denied when the pool is empty.
   */
  autoDecide(id: number, cfg: ResolvedConfig): BudgetRequest {
    const req = this.get(id);
    if (!req) throw new MeritRouterError("not_found", `unknown budget request ${id}`);
    const pool = req.jobId ? jobPool(this.db, cfg, req.jobId) : null;
    const grant = Math.min(req.requests, cfg.team.auto_grant_max, pool?.available ?? UNLIMITED_REQUESTS);
    if (grant < 1) return this.decide(id, { approve: false, by: "auto", reason: `the job's request pool is exhausted (${pool ? poolLine(pool) : "no pool"})`, cfg });
    return this.decide(id, { approve: true, grant, by: "auto", reason: grant < req.requests ? `granted ${grant} of ${req.requests} (auto_grant_max ${cfg.team.auto_grant_max}${pool?.available !== null && pool ? `, ${pool.available} available` : ""})` : "within the job's pool", cfg });
  }

  /** A request nobody decided in time: it expires (a decision that won the race stands). */
  expire(id: number, why: string): BudgetRequest {
    const r = this.db.prepare("UPDATE budget_requests SET status = 'expired', decided_by = 'meritrouter', decision_reason = ?, decided_at = ? WHERE id = ? AND status = 'pending'").run(why.slice(0, 500), this.now(), id);
    const req = this.get(id)!;
    if (r.changes) this.announce(req);
    return req;
  }

  private settle(id: number, status: Exclude<BudgetRequestStatus, "pending">, granted: number, by: string, reason: string): void {
    this.db.prepare("UPDATE budget_requests SET status = ?, granted = ?, decided_by = ?, decision_reason = ?, decided_at = ? WHERE id = ? AND status = 'pending'").run(status, granted, by.slice(0, 200), reason, this.now(), id);
  }

  /** Events on the task (its budget history) and the job, and a channel post. */
  private announce(req: BudgetRequest): void {
    const data = { id: req.id, status: req.status, granted: req.granted, by: req.decidedBy, reason: req.decisionReason };
    this.tasks.event(req.taskId, "budget_request_decided", data);
    if (req.status === "approved") {
      const extra = extraRequests(this.db, req.taskId);
      let contractTotal: number | null = null;
      try {
        contractTotal = new ContractStore(this.db).get(req.taskId)?.contract.budget.total ?? null;
      } catch {
        contractTotal = null;
      }
      const grant = grantOf(this.db, req.taskId);
      this.tasks.event(req.taskId, "budget_granted", {
        id: req.id,
        granted: req.granted,
        extraTotal: extra,
        by: req.decidedBy,
        ...(contractTotal !== null ? { contractTotal: contractTotal + extra } : {}),
        ...(grant ? { grantTotal: grant.requests + extra } : {}),
      });
    }
    if (req.jobId) {
      this.tasks.event(req.jobId, "budget_request_decided", { ...data, taskId: req.taskId });
      const what = req.status === "approved" ? `approved: +${req.granted} request(s)` : req.status;
      this.post(req, "finding", `Budget request #${req.id} ${what} by ${req.decidedBy ?? "?"}${req.decisionReason ? `: ${req.decisionReason}` : ""}`);
    }
  }

  /** Best effort: a channel failure never blocks a budget decision. */
  private post(req: BudgetRequest, kind: ChannelKind, text: string): void {
    if (!req.jobId) return;
    try {
      new ChannelStore(this.db, this.now).post({ jobId: req.jobId, author: { taskId: req.taskId, ...POST_AUTHOR }, kind, text: text.slice(0, 1900), refs: [req.taskId], callId: null, maxPerAuthor: 1000 });
    } catch {
      /* the channel is a view; the request row and events are the record */
    }
  }
}

/** Who decides a task's requests, from team.budget_approver and whether the task has a job. */
export function approverFor(cfg: ResolvedConfig, jobId: string | null): BudgetApprover {
  const a = cfg.team.budget_approver;
  if (a === "supervisor") return jobId ? "supervisor" : "external";
  return a;
}
