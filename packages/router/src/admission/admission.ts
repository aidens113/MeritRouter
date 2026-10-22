import type { Db } from "../storage/db.js";
import { immediate, newId } from "../storage/db.js";
import type { TaskStore } from "../storage/tasks.js";
import type { ResolvedConfig } from "../config/load.js";
import { TIER_NAMES, type ProfileName, type TierName } from "../config/schema.js";
import type { BudgetInput } from "../verification/contract.js";
import type { WorkerTask } from "../core/task.js";
import { AdmissionDenied } from "../core/errors.js";
import type { ChatResponse } from "../gateway/types.js";
import { actualUsd, type PaidSpend, type SpendKey, type TokenPrice } from "../paid/spend.js";
import { projectLimits } from "../projects/schema.js";
import { workerHeld } from "./job-pool.js";

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
  constructor(
    private readonly db: Db,
    private readonly tasks: TaskStore,
    private readonly cfg: ResolvedConfig,
    private readonly now: () => number = Date.now,
  ) {}

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

  /**
   * Atomically check every participant and the package allocation, then record one physical
   * request and one charge per participant. Nothing is dispatched unless this succeeds.
   */
  reserve(req: ReservationRequest): Reservation {
    return immediate(this.db, () => {
      const now = this.now();
      for (const p of req.participants) {
        const status = this.tasks.activeStatus(p.taskId, p.leaseOwner);
        if (status === "cancel_requested") throw new AdmissionDenied("cancel_requested", `task ${p.taskId} has a pending cancellation`, undefined, p.taskId);
        if (status === "lease_lost") throw new AdmissionDenied("lease_lost", `task ${p.taskId} execution lease is no longer held`, undefined, p.taskId);
        if (status !== "active") throw new AdmissionDenied("task_not_active", `task ${p.taskId} is not running`, undefined, p.taskId);
        const deadline = (this.db.prepare("SELECT deadline_at FROM tasks WHERE id = ?").get(p.taskId) as { deadline_at: number | null }).deadline_at;
        if (deadline !== null && now >= deadline) throw new AdmissionDenied("deadline_exceeded", `task ${p.taskId} passed its deadline`, undefined, p.taskId);

        const used = this.taskTotals(p.taskId);
        // A job's budget also covers what its sub-supervisors and worker tasks hold (one pool).
        const held = heldRequests(this.db, p.taskId);
        if (used.requests + held + 1 > p.budget.maxModelRequests) {
          throw new AdmissionDenied(
            "task_request_budget_exhausted",
            `task ${p.taskId} used ${used.requests}/${p.budget.maxModelRequests} model requests${held ? ` (plus ${held} held by its delegated tasks)` : ""}`,
            undefined,
            p.taskId,
          );
        }
        if (p.budget.maxInputTokens !== null && used.inputTokens + p.estInputTokens > p.budget.maxInputTokens) {
          throw new AdmissionDenied(
            "task_token_budget_exhausted",
            `task ${p.taskId} input tokens ${used.inputTokens} + ~${p.estInputTokens} exceed ${p.budget.maxInputTokens} (estimated)`,
            undefined,
            p.taskId,
          );
        }
        if (p.budget.maxOutputTokens !== null && used.outputTokens + p.reservedOutputTokens > p.budget.maxOutputTokens) {
          throw new AdmissionDenied(
            "task_token_budget_exhausted",
            `task ${p.taskId} output tokens ${used.outputTokens} + ${p.reservedOutputTokens} reserved exceed ${p.budget.maxOutputTokens}`,
            undefined,
            p.taskId,
          );
        }
      }

      const { max_model_requests_per_hour: perHour, max_model_requests_per_day: perDay } = this.cfg.allocation;
      if (perHour !== undefined && this.packageCount(now - HOUR) >= perHour) {
        throw new AdmissionDenied(
          "package_hourly_allocation_exhausted",
          `package allocation of ${perHour} requests/hour reached`,
          this.windowReopensAt(HOUR, perHour, now),
        );
      }
      if (perDay !== undefined && this.packageCount(now - DAY) >= perDay) {
        throw new AdmissionDenied(
          "package_daily_allocation_exhausted",
          `package allocation of ${perDay} requests/day reached`,
          this.windowReopensAt(DAY, perDay, now),
        );
      }

      // Per-project limits (D7). A batch never mixes projects, so the first participant names it.
      const project = req.participants.length ? (this.tasks.projectOf(req.participants[0]!.taskId) ?? "") : "";
      const limits = project ? projectLimits(this.cfg, project) : null;
      const shareDenied = limits ? this.projectShareDenial(project, limits.request_share, now) : null;
      if (shareDenied) throw shareDenied;

      if (req.paid) {
        const p = req.paid;
        const global = p.spend.globalDenial(p.worstCaseUsd);
        if (global) throw new AdmissionDenied("paid_budget_exhausted", global);
        const own = limits ? p.spend.projectDenial(project, limits.paid_budgets, p.worstCaseUsd) : null;
        if (own) throw new AdmissionDenied("project_paid_budget_exhausted", own);
        const key = p.key;
        if (!key.enabled) throw new AdmissionDenied("paid_budget_exhausted", `paid key ${key.label || key.ref} is not enabled`);
        const room = p.spend.keyHeadroom(key);
        if (room < p.worstCaseUsd) throw new AdmissionDenied("paid_budget_exhausted", `key ${key.label || key.ref} has $${room.toFixed(4)} left; worst case is $${p.worstCaseUsd.toFixed(4)}`);
        const share = p.worstCaseUsd / req.participants.length;
        for (const part of req.participants) {
          if (part.budget.maxPaidUsd === null) continue;
          const spent = p.spend.taskSpend(part.taskId);
          if (spent + share > part.budget.maxPaidUsd) {
            throw new AdmissionDenied("paid_budget_exhausted", `task ${part.taskId} paid budget: $${spent.toFixed(4)} + $${share.toFixed(4)} exceeds $${part.budget.maxPaidUsd}`, undefined, part.taskId);
          }
        }
      }
      const requestId = newId("r");
      this.db
        .prepare(
          `INSERT INTO model_requests (id, execution_id, purpose, gateway_model, endpoint_id, tier, route_note, status, reserved_at, est_input_tokens, reserved_output_tokens)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?)`,
        )
        .run(requestId, req.executionId, req.purpose, req.gatewayModel, req.endpointId, req.tier, req.routeNote ?? null, now, req.estInputTokens, req.reservedOutputTokens);
      const charge = this.db.prepare(
        "INSERT INTO request_charges (request_id, task_id, input_tokens, output_tokens, tokens_exact) VALUES (?, ?, ?, ?, 0)",
      );
      for (const p of req.participants) charge.run(requestId, p.taskId, p.estInputTokens, p.reservedOutputTokens);
      if (req.paid) req.paid.spend.record(requestId, req.paid.key.ref, req.paid.provider, req.endpointId ?? "", req.paid.worstCaseUsd);
      return {
        requestId,
        executionId: req.executionId,
        participants: req.participants,
        estInputTokens: req.estInputTokens,
        reservedOutputTokens: req.reservedOutputTokens,
        ...(req.paid ? { paid: req.paid } : {}),
      };
    });
  }

  /**
   * Reconcile a reservation with the gateway outcome. Single-participant requests take exact
   * provider-reported tokens; batch participants keep an estimated proportional share.
   */
  reconcile(
    res: Reservation,
    outcome:
      | { kind: "succeeded"; response: ChatResponse; servedEndpointId: string | null; policyViolation?: string }
      | { kind: "failed" | "uncertain"; httpStatus?: number; errorKind: string; errorMessage: string; response?: ChatResponse },
  ): void {
    immediate(this.db, () => {
      const now = this.now();
      const resp = outcome.response;
      const usage = resp?.usage;
      const t = resp?.telemetry;
      this.db
        .prepare(
          `UPDATE model_requests SET status = @status, finished_at = @now, served_model = @servedModel, served_endpoint_id = @servedEndpointId,
             served_provider = @servedProvider, provider_attempts = @attempts, attempts_exact = @attemptsExact,
             input_tokens = @inputTokens, output_tokens = @outputTokens, cached_input_tokens = @cached, cache_creation_input_tokens = @created, reasoning_tokens = @reasoning,
             usage_basis = @basis, reported_cost_usd = @cost, http_status = @http, error_kind = @errorKind, error_message = @errorMessage,
             cache_hit = @cacheHit, policy_violation = @violation, telemetry_json = @telemetry,
             native_web_search = @nativeSearch, web_search_requests = @searches, web_citations_json = @citations
           WHERE id = @id`,
        )
        .run({
          id: res.requestId,
          status: outcome.kind,
          now,
          servedModel: t?.servedModel ?? null,
          servedEndpointId: outcome.kind === "succeeded" ? outcome.servedEndpointId : null,
          servedProvider: t?.servedProvider ?? null,
          attempts: t?.providerAttempts ?? null,
          attemptsExact: t ? (t.providerAttemptsExact ? 1 : 0) : 0,
          inputTokens: usage?.inputTokens ?? null,
          outputTokens: usage?.outputTokens ?? null,
          cached: usage?.cachedInputTokens ?? null,
          created: usage?.cacheCreationInputTokens ?? null,
          reasoning: usage?.reasoningTokens ?? null,
          basis: usage?.basis ?? "unknown",
          cost: usage?.reportedCostUsd ?? null,
          http: outcome.kind === "succeeded" ? outcome.response.httpStatus : (outcome.httpStatus ?? null),
          errorKind: outcome.kind === "succeeded" ? null : outcome.errorKind,
          errorMessage: outcome.kind === "succeeded" ? null : outcome.errorMessage.slice(0, 2000),
          cacheHit: t?.cacheHit === null || t?.cacheHit === undefined ? null : t.cacheHit ? 1 : 0,
          violation: outcome.kind === "succeeded" ? (outcome.policyViolation ?? null) : null,
          telemetry: t ? JSON.stringify(t.headers) : null,
          // Native web search: how it ran, the searches (reported or assumed), and the cited sources as evidence.
          nativeSearch: resp?.webSearch ? `${resp.webSearch.via}${resp.webSearch.requestsBasis === "assumed" ? " (count assumed)" : ""}` : null,
          searches: resp?.webSearch?.requests ?? null,
          citations: resp?.webSearch?.citations.length ? JSON.stringify(resp.webSearch.citations) : null,
        });

      if (res.paid) {
        const p = res.paid;
        let cost: number;
        let basis: "provider_reported" | "computed" | "not_billed" | "uncertain";
        if (outcome.kind === "succeeded") {
          if (usage?.reportedCostUsd != null && Number.isFinite(usage.reportedCostUsd)) {
            cost = usage.reportedCostUsd;
            basis = "provider_reported";
          } else if (usage?.inputTokens != null && usage.outputTokens != null) {
            const computed = actualUsd(usage.inputTokens, usage.outputTokens, p.price, usage.cachedInputTokens ?? 0, resp?.webSearch?.requests ?? 0, usage.cacheCreationInputTokens ?? 0);
            if (Number.isFinite(computed)) {
              cost = computed;
              basis = "computed";
            } else {
              // Unknown creation pricing is an accounting incident, not an ordinary-input charge.
              // Retain the finite reservation as uncertain; quarantine prevents automatic retries.
              cost = p.worstCaseUsd;
              basis = "uncertain";
              this.db.prepare("UPDATE model_requests SET policy_violation = COALESCE(policy_violation, ?) WHERE id = ?")
                .run(`cannot price reported cache creation (${usage.cacheCreationInputTokens ?? 0} tokens): paid reservation retained; actual cost unknown`, res.requestId);
            }
          } else {
            // No billed usage reported: keep the worst case rather than an estimate.
            cost = p.worstCaseUsd;
            basis = "uncertain";
          }
        } else if (outcome.kind === "failed") {
          cost = 0;
          basis = "not_billed";
        } else {
          cost = p.worstCaseUsd;
          basis = "uncertain";
        }
        p.spend.settle(res.requestId, cost, basis);
        this.db.prepare("UPDATE model_requests SET estimated_cost_usd = ? WHERE id = ?").run(cost, res.requestId);
      }

      // Without reported usage the conservative reservation stays as the charge.
      if (!usage || usage.basis !== "provider_reported") return;
      const inTotal = usage.inputTokens ?? res.participants.reduce((s, p) => s + p.estInputTokens, 0);
      const outTotal = usage.outputTokens ?? res.participants.reduce((s, p) => s + p.reservedOutputTokens, 0);
      const update = this.db.prepare(
        "UPDATE request_charges SET input_tokens = ?, output_tokens = ?, tokens_exact = ? WHERE request_id = ? AND task_id = ?",
      );
      if (res.participants.length === 1) {
        update.run(inTotal, outTotal, 1, res.requestId, res.participants[0]!.taskId);
        return;
      }
      const estIn = res.participants.reduce((s, p) => s + p.estInputTokens, 0) || 1;
      const estOut = res.participants.reduce((s, p) => s + p.reservedOutputTokens, 0) || 1;
      for (const p of res.participants) {
        update.run(
          Math.ceil((inTotal * p.estInputTokens) / estIn),
          Math.ceil((outTotal * p.reservedOutputTokens) / estOut),
          0,
          res.requestId,
          p.taskId,
        );
      }
    });
  }
}
