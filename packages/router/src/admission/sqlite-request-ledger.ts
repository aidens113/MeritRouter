import { RequestReceipts } from "./request-receipts.js";
import type { Db } from "../storage/db.js";
import { immediate, newId } from "../storage/db.js";
import type { TaskStore } from "../storage/tasks.js";
import type { ResolvedConfig } from "../config/load.js";
import { AdmissionDenied } from "../core/errors.js";
import { actualUsd, type PaidSpend } from "../paid/spend.js";
import { projectLimits } from "../projects/schema.js";
import type { Admission, ReservationRequest, Reservation, TaskUsageTotals } from "./admission.js";
import { ReserveRequestDTOSchema, ReservationDTOSchema, RequestOutcomeDTOSchema, type RequestLedger, type ReserveRequestDTO, type ReservationDTO, type RequestOutcomeDTO } from "./request-ledger.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Reads execute synchronously inside the same SQLite transaction, never over a remote port. */
interface AccountingReads {
  taskTotals(taskId: string): TaskUsageTotals;
  heldRequests(taskId: string): number;
  packageCount(sinceMs: number): number;
  windowReopensAt(windowMs: number, limit: number, now: number, project?: string): number;
  projectShareDenial(project: string, share: number | undefined, now: number): AdmissionDenied | null;
}

/** Single transaction implementation shared by the sync facade and async runtime adapter. */
export class SqliteRequestAccounting {
  constructor(private readonly db: Db, private readonly tasks: TaskStore, private readonly cfg: ResolvedConfig,
    private readonly now: () => number, private readonly reads: AccountingReads) {}

  /** Recheck local task authority after asynchronous persistence, without reserving again. */
  assertDispatch(participants: ReservationRequest["participants"]): void {
    const now = this.now();
    for (const p of participants) {
      const status = this.tasks.activeStatus(p.taskId, p.leaseOwner);
      if (status === "cancel_requested") throw new AdmissionDenied("cancel_requested", `task ${p.taskId} has a pending cancellation`, undefined, p.taskId);
      if (status === "lease_lost") throw new AdmissionDenied("lease_lost", `task ${p.taskId} execution lease is no longer held`, undefined, p.taskId);
      if (status !== "active") throw new AdmissionDenied("task_not_active", `task ${p.taskId} is not running`, undefined, p.taskId);
      const deadline = (this.db.prepare("SELECT deadline_at FROM tasks WHERE id = ?").get(p.taskId) as { deadline_at: number | null }).deadline_at;
      if (deadline !== null && now >= deadline) throw new AdmissionDenied("deadline_exceeded", `task ${p.taskId} passed its deadline`, undefined, p.taskId);
      if (p.lease && !this.tasks.dispatchable(p.lease.taskId, p.lease.owner, p.lease.runCount, p.lease.incarnation, p.lease.project))
        throw new AdmissionDenied("lease_lost", "captured participant generation no longer authorizes dispatch", undefined, p.taskId);
    }
  }

  /**
   * Atomically check every participant and the package allocation, then record one physical
   * request and one charge per participant. Nothing is dispatched unless this succeeds.
   */
  reserve(req: ReservationRequest): Reservation {
    return immediate(this.db, () => {
      const now = this.now();
      this.assertDispatch(req.participants);
      const projects = new Set(req.participants.map(p => this.tasks.projectOf(p.taskId)));
      if (projects.size > 1) throw new AdmissionDenied("task_not_active", "request participants belong to different projects");
      for (const p of req.participants) {
        const used = this.reads.taskTotals(p.taskId);
        // A job's budget also covers what its sub-supervisors and worker tasks hold (one pool).
        const held = this.reads.heldRequests(p.taskId);
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
      if (perHour !== undefined && this.reads.packageCount(now - HOUR) >= perHour) {
        throw new AdmissionDenied(
          "package_hourly_allocation_exhausted",
          `package allocation of ${perHour} requests/hour reached`,
          this.reads.windowReopensAt(HOUR, perHour, now),
        );
      }
      if (perDay !== undefined && this.reads.packageCount(now - DAY) >= perDay) {
        throw new AdmissionDenied(
          "package_daily_allocation_exhausted",
          `package allocation of ${perDay} requests/day reached`,
          this.reads.windowReopensAt(DAY, perDay, now),
        );
      }

      // Per-project limits (D7). A batch never mixes projects, so the first participant names it.
      const project = req.participants.length ? (this.tasks.projectOf(req.participants[0]!.taskId) ?? "") : "";
      const limits = project ? projectLimits(this.cfg, project) : null;
      const shareDenied = limits ? this.reads.projectShareDenial(project, limits.request_share, now) : null;
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
      const requestId = req.requestId ?? newId("r");
      this.db
        .prepare(
          `INSERT INTO model_requests (id, execution_id, purpose, gateway_model, endpoint_id, tier, route_note, status, reserved_at, est_input_tokens, reserved_output_tokens)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?)`,
        )
        .run(requestId, req.executionId, req.purpose, req.gatewayModel, req.endpointId, req.tier, req.routeNote ?? null, now, req.estInputTokens, req.reservedOutputTokens);
      const charge = this.db.prepare(
        "INSERT INTO request_charges (request_id, task_id, input_tokens, output_tokens, tokens_exact,lease_incarnation,run_count) VALUES (?, ?, ?, ?, 0,?,?)",
      );
      for (const p of req.participants) charge.run(requestId, p.taskId, p.estInputTokens, p.reservedOutputTokens, p.lease?.incarnation ?? null, p.lease?.runCount ?? null);
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
    outcome: RequestOutcomeDTO,
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
        "UPDATE request_charges SET input_tokens = ?, output_tokens = ?, tokens_exact = ? WHERE request_id = ? AND task_id = ? AND (? IS NULL OR lease_incarnation = ?)",
      );
      if (res.participants.length === 1) {
        update.run(inTotal, outTotal, 1, res.requestId, res.participants[0]!.taskId, res.participants[0]!.lease?.incarnation ?? null, res.participants[0]!.lease?.incarnation ?? null);
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
          p.lease?.incarnation ?? null, p.lease?.incarnation ?? null,
        );
      }
    });
  }
}

/** SQLite remains synchronous internally; the routed runtime consumes this awaited port. */
export class SqliteRequestLedger implements RequestLedger {
  readonly receipts: RequestReceipts;
  constructor(private readonly admission: Admission, private readonly spend: PaidSpend) {
    this.receipts = new RequestReceipts(admission.db, () => admission.serverNow());
  }
  async reserve(input: ReserveRequestDTO): Promise<ReservationDTO> {
    const parsed = ReserveRequestDTOSchema.parse(input);
    return this.receipts.reserve(parsed, () => {
      const { paid, payloadDigest, keyRef, providerReservationId, slot, ...data } = parsed;
      const result = this.admission.reserve({ ...data, ...(paid ? { paid: { ...paid, spend: this.spend } } : {}) });
      const { paid: charged, ...bound } = result;
      return { ...bound, ...(charged ? { paid: { key: charged.key, provider: charged.provider, worstCaseUsd: charged.worstCaseUsd, price: charged.price } } : {}) };
    });
  }
  async beginDispatch(reservation: ReservationDTO, dispatchId: string) {
    return this.receipts.beginDispatch(reservation, dispatchId, participants => this.admission.assertDispatch(participants));
  }
  async reconcile(reservation: ReservationDTO, outcome: RequestOutcomeDTO): Promise<void> {
    const parsed = RequestOutcomeDTOSchema.parse(outcome);
    this.receipts.reconcile(reservation, parsed, bound => {
      const { paid, ...data } = bound;
      this.admission.reconcile({ ...data, ...(paid ? { paid: { ...paid, spend: this.spend } } : {}) }, parsed);
    });
  }
  async receipt(requestId: string) { return this.receipts.receipt(requestId); }
  async drain(): Promise<void> {}
}
