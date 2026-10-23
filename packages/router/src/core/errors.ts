/** Base class for errors that carry a stable, machine-readable code. */
export class MeritRouterError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ConfigError extends MeritRouterError {
  constructor(message: string) {
    super("config_invalid", message);
  }
}

export class TaskValidationError extends MeritRouterError {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super("task_invalid", message);
  }
}

/** Reasons an admission request can be denied before any model request is dispatched. */
export type AdmissionDenialReason =
  | "task_not_active"
  | "lease_lost"
  | "cancel_requested"
  | "deadline_exceeded"
  | "task_request_budget_exhausted"
  | "task_token_budget_exhausted"
  | "package_hourly_allocation_exhausted"
  | "package_daily_allocation_exhausted"
  | "paid_routing_disabled"
  | "paid_budget_exhausted"
  /** A project's own paid cap (`projects.<slug>.paid_budgets`); like `paid_budget_exhausted`, the request falls back to free routes. */
  | "project_paid_budget_exhausted"
  /** A project's share of the package allocation (`projects.<slug>.request_share`); like the package reasons, the task waits for the window. */
  | "project_allocation_exhausted"
  | "no_eligible_endpoint"
  | "context_does_not_fit";

/** Denials of a paid route's budget: the paid endpoint is skipped and free routes are tried instead. */
export const PAID_BUDGET_DENIALS: ReadonlySet<AdmissionDenialReason> = new Set<AdmissionDenialReason>(["paid_budget_exhausted", "project_paid_budget_exhausted"]);

export class AdmissionDenied extends MeritRouterError {
  constructor(
    readonly reason: AdmissionDenialReason,
    message: string,
    /** When capacity may return (package allocation windows). */
    readonly retryAt?: number,
    /** The participant that caused the denial, for multi-task (batch) requests. */
    readonly taskId?: string,
  ) {
    super(`admission_denied:${reason}`, message);
  }
}

export type GatewayErrorKind =
  | "rate_limited"
  | "pool_exhausted"
  | "unknown_model"
  | "auth"
  | "bad_request"
  | "transport"
  | "timeout"
  | "aborted"
  | "server"
  | "policy_violation";

export class GatewayError extends MeritRouterError {
  constructor(
    readonly kind: GatewayErrorKind,
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
    /** True when the request may have reached a provider and consumed quota. */
    readonly possiblyConsumed = true,
  ) {
    super(`gateway:${kind}`, message);
  }
}
