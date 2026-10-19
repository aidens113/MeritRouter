import type { Db } from "../storage/db.js";
import { immediate, newId } from "../storage/db.js";
import type { TaskStore } from "../storage/tasks.js";
import type { ResolvedConfig } from "../config/load.js";
import type { ProfileName, TierName } from "../config/schema.js";
import type { WorkerTask } from "../core/task.js";
import { AdmissionDenied } from "../core/errors.js";
import type { ChatResponse } from "../gateway/types.js";
import { actualUsd, type PaidSpend } from "../paid/spend.js";

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
  const tierCap = tier ? cfg.tiers[tier].max_model_requests : Number.MAX_SAFE_INTEGER;
  const narrow = (configured: number | undefined, requested: number | undefined): number | null => {
    if (configured === undefined) return requested ?? null;
    return requested === undefined ? configured : Math.min(configured, requested);
  };
  return {
    maxModelRequests: Math.min(
      profile.max_model_requests,
      tierCap,
      cfg.execution.max_model_requests_per_task,
      spec.budget?.maxModelRequests ?? Number.MAX_SAFE_INTEGER,
    ),
    maxInputTokens: narrow(profile.max_input_tokens, spec.budget?.maxInputTokens),
    maxOutputTokens: spec.budget?.maxOutputTokens ?? null,
    maxPaidUsd: cfg.paid.enabled ? (spec.budget?.maxPaidUsd ?? null) : 0,
  };
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
  paid?: { spend: PaidSpend; keyId: number; provider: string; worstCaseUsd: number; price: { in: number; out: number } };
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

  packageCount(sinceMs: number): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM model_requests WHERE reserved_at > ?").get(sinceMs) as { n: number }).n;
  }

  /** Oldest request inside the window; capacity returns when it ages out. */
  private windowReopensAt(windowMs: number, limit: number, now: number): number {
    const row = this.db
      .prepare("SELECT reserved_at FROM model_requests WHERE reserved_at > ? ORDER BY reserved_at DESC LIMIT 1 OFFSET ?")
      .get(now - windowMs, limit - 1) as { reserved_at: number } | undefined;
    return row ? row.reserved_at + windowMs + 1 : now;
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
        if (used.requests + 1 > p.budget.maxModelRequests) {
          throw new AdmissionDenied(
            "task_request_budget_exhausted",
            `task ${p.taskId} used ${used.requests}/${p.budget.maxModelRequests} model requests`,
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

      if (req.paid) {
        const p = req.paid;
        const global = p.spend.globalDenial(p.worstCaseUsd);
        if (global) throw new AdmissionDenied("paid_budget_exhausted", global);
        const key = p.spend.key(p.keyId);
        if (!key || !key.enabled) throw new AdmissionDenied("paid_budget_exhausted", `paid key ${p.keyId} is not enabled`);
        const room = p.spend.keyHeadroom(key);
        if (room < p.worstCaseUsd) throw new AdmissionDenied("paid_budget_exhausted", `key ${key.label || key.id} has $${room.toFixed(4)} left; worst case is $${p.worstCaseUsd.toFixed(4)}`);
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
      if (req.paid) req.paid.spend.record(requestId, req.paid.keyId, req.paid.provider, req.endpointId ?? "", req.paid.worstCaseUsd);
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
             input_tokens = @inputTokens, output_tokens = @outputTokens, cached_input_tokens = @cached, reasoning_tokens = @reasoning,
             usage_basis = @basis, reported_cost_usd = @cost, http_status = @http, error_kind = @errorKind, error_message = @errorMessage,
             cache_hit = @cacheHit, policy_violation = @violation, telemetry_json = @telemetry
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
          reasoning: usage?.reasoningTokens ?? null,
          basis: usage?.basis ?? "unknown",
          cost: usage?.reportedCostUsd ?? null,
          http: outcome.kind === "succeeded" ? outcome.response.httpStatus : (outcome.httpStatus ?? null),
          errorKind: outcome.kind === "succeeded" ? null : outcome.errorKind,
          errorMessage: outcome.kind === "succeeded" ? null : outcome.errorMessage.slice(0, 2000),
          cacheHit: t?.cacheHit === null || t?.cacheHit === undefined ? null : t.cacheHit ? 1 : 0,
          violation: outcome.kind === "succeeded" ? (outcome.policyViolation ?? null) : null,
          telemetry: t ? JSON.stringify(t.headers) : null,
        });

      if (res.paid) {
        const p = res.paid;
        let cost: number;
        let basis: "provider_reported" | "computed" | "not_billed" | "uncertain";
        if (outcome.kind === "succeeded") {
          if (usage?.reportedCostUsd !== null && usage?.reportedCostUsd !== undefined) {
            cost = usage.reportedCostUsd;
            basis = "provider_reported";
          } else {
            cost = actualUsd(usage?.inputTokens ?? res.estInputTokens, usage?.outputTokens ?? res.reservedOutputTokens, p.price);
            basis = "computed";
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
