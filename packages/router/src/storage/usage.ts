import type { Db } from "./db.js";
import type { EndpointCatalog } from "../models/catalog.js";
import type { Usage } from "../core/task.js";

interface ChargeRow {
  request_id: string;
  input_tokens: number;
  output_tokens: number;
  tokens_exact: number;
  status: string;
  provider_attempts: number | null;
  attempts_exact: number | null;
  cached_input_tokens: number | null;
  reported_cost_usd: number | null;
  served_endpoint_id: string | null;
  usage_basis: string | null;
  kind: string;
  execution_id: string;
  participants: number;
}

/**
 * Task usage derived from the admission ledger. Exact only when every charged request was a
 * single-task request with provider-reported tokens; batch shares are labelled estimated.
 */
export function taskUsage(db: Db, catalog: EndpointCatalog, taskId: string): { usage: Usage; servedEndpoints: string[] } {
  const rows = db
    .prepare(
      `SELECT c.request_id, c.input_tokens, c.output_tokens, c.tokens_exact, r.status, r.provider_attempts, r.attempts_exact,
              r.cached_input_tokens, r.reported_cost_usd, r.served_endpoint_id, r.usage_basis, e.kind, e.id AS execution_id,
              (SELECT COUNT(*) FROM request_charges c2 WHERE c2.request_id = c.request_id) AS participants
         FROM request_charges c
         JOIN model_requests r ON r.id = c.request_id
         JOIN executions e ON e.id = r.execution_id
        WHERE c.task_id = ?
        ORDER BY r.reserved_at`,
    )
    .all(taskId) as ChargeRow[];

  const usage: Usage = {
    modelRequests: rows.length,
    providerAttempts: 0,
    providerAttemptsExact: true,
    tokenUsageBasis: "unknown",
    batchId: null,
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    reportedCostUsd: null,
    estimatedCostUsd: null,
  };
  if (rows.length === 0) return { usage, servedEndpoints: [] };

  let attempts = 0;
  let attemptsKnown = true;
  let anyReported = false;
  let allExact = true;
  let inTok = 0;
  let outTok = 0;
  let cached: number | null = 0;
  let reportedCost: number | null = null;
  let estCost = 0;
  let estCostKnown = true;
  const served = new Set<string>();

  for (const r of rows) {
    if (r.kind === "batch") usage.batchId = r.execution_id;
    if (r.provider_attempts === null) attemptsKnown = false;
    else attempts += r.provider_attempts;
    if (!r.attempts_exact) usage.providerAttemptsExact = false;
    if (r.usage_basis === "provider_reported") anyReported = true;
    if (!r.tokens_exact) allExact = false;
    inTok += r.input_tokens;
    outTok += r.output_tokens;
    if (r.participants > 1 || r.cached_input_tokens === null) cached = null;
    else if (cached !== null) cached += r.cached_input_tokens;
    if (r.reported_cost_usd !== null) reportedCost = (reportedCost ?? 0) + r.reported_cost_usd / r.participants;
    if (r.served_endpoint_id) {
      served.add(r.served_endpoint_id);
      const ep = catalog.endpoints.find((e) => e.id === r.served_endpoint_id);
      const pin = ep?.pricing.inputUsdPerMillion;
      const pout = ep?.pricing.outputUsdPerMillion;
      if (pin === null || pin === undefined || pout === null || pout === undefined) estCostKnown = false;
      else estCost += (r.input_tokens * pin + r.output_tokens * pout) / 1_000_000;
    } else if (r.status !== "failed") {
      estCostKnown = false;
    }
  }
  usage.providerAttempts = attemptsKnown ? attempts : null;
  if (!attemptsKnown) usage.providerAttemptsExact = false;
  usage.tokenUsageBasis = allExact && anyReported ? "provider_reported" : "estimated";
  usage.inputTokens = inTok;
  usage.outputTokens = outTok;
  usage.cachedInputTokens = cached;
  usage.reportedCostUsd = reportedCost;
  usage.estimatedCostUsd = estCostKnown ? Math.round(estCost * 1e6) / 1e6 : null;
  return { usage, servedEndpoints: [...served] };
}

export interface UsageSummary {
  windowStart: number;
  windowEnd: number;
  logicalTasks: { submitted: number; completed: number; failed: number; other: number };
  modelRequests: number;
  succeededResponses: number;
  failedRequests: number;
  uncertainRequests: number;
  providerAttempts: number | null;
  providerAttemptsExact: false;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  tokenUsageBasis: "provider_reported" | "mixed" | "unknown";
  reportedCostUsd: number | null;
  policyViolations: number;
  byEndpoint: Array<{ endpointId: string | null; requests: number; inputTokens: number; outputTokens: number }>;
  byGatewayModel: Array<{ gatewayModel: string; requests: number; failed: number }>;
}

/** Package-level totals: physical requests are counted once regardless of batch participants. */
export function usageSummary(db: Db, sinceMs: number, untilMs = Date.now()): UsageSummary {
  const t = db
    .prepare(
      `SELECT COUNT(*) AS submitted,
              SUM(state = 'completed') AS completed,
              SUM(state IN ('failed','budget_exhausted')) AS failed
         FROM tasks WHERE created_at > ? AND created_at <= ?`,
    )
    .get(sinceMs, untilMs) as { submitted: number; completed: number | null; failed: number | null };
  const r = db
    .prepare(
      `SELECT COUNT(*) AS n,
              SUM(status = 'succeeded') AS ok,
              SUM(status = 'failed') AS failed,
              SUM(status = 'uncertain') AS uncertain,
              SUM(provider_attempts) AS attempts,
              SUM(provider_attempts IS NULL AND status != 'reserved') AS attempts_unknown,
              COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(cached_input_tokens), 0) AS cached,
              COALESCE(SUM(reasoning_tokens), 0) AS reasoning,
              SUM(usage_basis = 'provider_reported') AS reported,
              SUM(reported_cost_usd) AS cost,
              SUM(policy_violation IS NOT NULL) AS violations
         FROM model_requests WHERE reserved_at > ? AND reserved_at <= ?`,
    )
    .get(sinceMs, untilMs) as Record<string, number | null>;
  const byEndpoint = db
    .prepare(
      `SELECT served_endpoint_id AS endpointId, COUNT(*) AS requests, COALESCE(SUM(input_tokens),0) AS inputTokens,
              COALESCE(SUM(output_tokens),0) AS outputTokens
         FROM model_requests WHERE reserved_at > ? AND reserved_at <= ? GROUP BY served_endpoint_id ORDER BY requests DESC`,
    )
    .all(sinceMs, untilMs) as UsageSummary["byEndpoint"];
  const byGatewayModel = db
    .prepare(
      `SELECT gateway_model AS gatewayModel, COUNT(*) AS requests, SUM(status != 'succeeded') AS failed
         FROM model_requests WHERE reserved_at > ? AND reserved_at <= ? GROUP BY gateway_model ORDER BY requests DESC`,
    )
    .all(sinceMs, untilMs) as UsageSummary["byGatewayModel"];
  const n = r.n ?? 0;
  const reported = r.reported ?? 0;
  return {
    windowStart: sinceMs,
    windowEnd: untilMs,
    logicalTasks: {
      submitted: t.submitted,
      completed: t.completed ?? 0,
      failed: t.failed ?? 0,
      other: t.submitted - (t.completed ?? 0) - (t.failed ?? 0),
    },
    modelRequests: n,
    succeededResponses: r.ok ?? 0,
    failedRequests: r.failed ?? 0,
    uncertainRequests: r.uncertain ?? 0,
    providerAttempts: (r.attempts_unknown ?? 0) > 0 ? null : (r.attempts ?? 0),
    providerAttemptsExact: false,
    inputTokens: r.input_tokens ?? 0,
    outputTokens: r.output_tokens ?? 0,
    cachedInputTokens: r.cached ?? 0,
    reasoningTokens: r.reasoning ?? 0,
    tokenUsageBasis: n === 0 ? "unknown" : reported === n ? "provider_reported" : reported === 0 ? "unknown" : "mixed",
    reportedCostUsd: r.cost ?? null,
    policyViolations: r.violations ?? 0,
    byEndpoint,
    byGatewayModel,
  };
}
