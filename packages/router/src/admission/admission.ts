import type { Db } from "../storage/db.js";
import { immediate, newId } from "../storage/db.js";
import type { TaskStore } from "../storage/tasks.js";
import type { ResolvedConfig } from "../config/load.js";
import type { ProfileName } from "../config/schema.js";
import type { WorkerTask } from "../core/task.js";
import { AdmissionDenied } from "../core/errors.js";
import type { ChatResponse } from "../gateway/types.js";

/** Effective per-task limits: task budgets may narrow configured policy, never widen it. */
export interface EffectiveBudget {
  maxModelRequests: number;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  maxPaidUsd: 0;
}

export function effectiveBudget(cfg: ResolvedConfig, spec: WorkerTask): EffectiveBudget {
  const profile = cfg.profiles[spec.profile]!;
  const narrow = (configured: number | undefined, requested: number | undefined): number | null => {
    if (configured === undefined) return requested ?? null;
    return requested === undefined ? configured : Math.min(configured, requested);
  };
  return {
    maxModelRequests: Math.min(
      profile.max_model_requests,
      cfg.execution.max_model_requests_per_task,
      spec.budget?.maxModelRequests ?? Number.MAX_SAFE_INTEGER,
    ),
    maxInputTokens: narrow(profile.max_input_tokens, spec.budget?.maxInputTokens),
    maxOutputTokens: spec.budget?.maxOutputTokens ?? null,
    // Paid routing is disabled package-wide; a task cannot opt in.
    maxPaidUsd: 0,
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
  /** Physical request totals (a batch is one request shared by several tasks). */
  estInputTokens: number;
  reservedOutputTokens: number;
  participants: Participant[];
}

export interface Reservation {
  requestId: string;
  executionId: string;
  participants: Participant[];
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

      const requestId = newId("r");
      this.db
        .prepare(
          `INSERT INTO model_requests (id, execution_id, purpose, gateway_model, status, reserved_at, est_input_tokens, reserved_output_tokens)
           VALUES (?, ?, ?, ?, 'reserved', ?, ?, ?)`,
        )
        .run(requestId, req.executionId, req.purpose, req.gatewayModel, now, req.estInputTokens, req.reservedOutputTokens);
      const charge = this.db.prepare(
        "INSERT INTO request_charges (request_id, task_id, input_tokens, output_tokens, tokens_exact) VALUES (?, ?, ?, ?, 0)",
      );
      for (const p of req.participants) charge.run(requestId, p.taskId, p.estInputTokens, p.reservedOutputTokens);
      return { requestId, executionId: req.executionId, participants: req.participants };
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
