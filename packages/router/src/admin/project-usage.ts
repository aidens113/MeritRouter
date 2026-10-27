import type { MeritRouter } from "../core/service.js";
import type { Db } from "../storage/db.js";
import { usageSummary, type UsageSummary } from "../storage/usage.js";
import { adminProjectScopes, fanOutProjects, withUnavailable, type WithUnavailable } from "./project-reads.js";

/**
 * Installation-wide usage for admin views, assembled per project: each project's summary comes
 * from its own store (filtered to that project), and requests charged to no project (probes,
 * scans) come from the installation database. Physical requests are still counted once.
 */

type Row = Record<string, number | null>;

/** Usage of requests charged to no project ('' project): installation accounting, no tasks. */
export function unattributedUsageSummary(db: Db, sinceMs: number, untilMs: number): UsageSummary {
  const where = "reserved_at > ? AND reserved_at <= ? AND project_id = ''";
  const r = db
    .prepare(
      `SELECT COUNT(*) AS n, SUM(status = 'succeeded') AS ok, SUM(status = 'failed') AS failed, SUM(status = 'uncertain') AS uncertain,
              SUM(provider_attempts) AS attempts, SUM(provider_attempts IS NULL AND status != 'reserved') AS attempts_unknown,
              COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(cached_input_tokens), 0) AS cached, COALESCE(SUM(cached_input_tokens IS NULL), 0) AS unknown_cache,
              COALESCE(SUM(MAX(0, input_tokens - COALESCE(cached_input_tokens, 0))), 0) AS uncached,
              COALESCE(SUM(reasoning_tokens), 0) AS reasoning, SUM(usage_basis = 'provider_reported') AS reported,
              SUM(reported_cost_usd) AS cost, SUM(policy_violation IS NOT NULL) AS violations
         FROM model_requests WHERE ${where}`,
    )
    .get(sinceMs, untilMs) as Row;
  const byEndpoint = db
    .prepare(
      `SELECT served_endpoint_id AS endpointId, COUNT(*) AS requests, COALESCE(SUM(input_tokens),0) AS inputTokens,
              COALESCE(SUM(cached_input_tokens),0) AS cachedInputTokens, COALESCE(SUM(cached_input_tokens IS NULL),0) AS requestsWithUnknownCacheUsage,
              COALESCE(SUM(MAX(0, input_tokens - COALESCE(cached_input_tokens, 0))),0) AS uncachedInputTokens, COALESCE(SUM(output_tokens),0) AS outputTokens
         FROM model_requests WHERE ${where} GROUP BY served_endpoint_id`,
    )
    .all(sinceMs, untilMs) as Array<Omit<UsageSummary["byEndpoint"][number], "cacheUsageKnown">>;
  const byGatewayModel = db
    .prepare(`SELECT gateway_model AS gatewayModel, COUNT(*) AS requests, SUM(status != 'succeeded') AS failed FROM model_requests WHERE ${where} GROUP BY gateway_model`)
    .all(sinceMs, untilMs) as UsageSummary["byGatewayModel"];
  const n = r.n ?? 0;
  const reported = r.reported ?? 0;
  return {
    windowStart: sinceMs,
    windowEnd: untilMs,
    logicalTasks: { submitted: 0, completed: 0, failed: 0, other: 0 },
    modelRequests: n,
    succeededResponses: r.ok ?? 0,
    failedRequests: r.failed ?? 0,
    uncertainRequests: r.uncertain ?? 0,
    providerAttempts: (r.attempts_unknown ?? 0) > 0 ? null : (r.attempts ?? 0),
    providerAttemptsExact: false,
    inputTokens: r.input_tokens ?? 0,
    outputTokens: r.output_tokens ?? 0,
    cachedInputTokens: r.cached ?? 0,
    cacheUsageKnown: (r.unknown_cache ?? 0) === 0,
    requestsWithUnknownCacheUsage: r.unknown_cache ?? 0,
    uncachedInputTokens: r.uncached ?? 0,
    reasoningTokens: r.reasoning ?? 0,
    tokenUsageBasis: n === 0 ? "unknown" : reported === n ? "provider_reported" : reported === 0 ? "unknown" : "mixed",
    reportedCostUsd: r.cost ?? null,
    policyViolations: r.violations ?? 0,
    byEndpoint: byEndpoint.map((row) => ({ ...row, cacheUsageKnown: row.requestsWithUnknownCacheUsage === 0 })),
    byGatewayModel,
  };
}

/** Sum disjoint usage summaries of one window (each physical request belongs to exactly one part). */
export function mergeUsageSummaries(sinceMs: number, untilMs: number, parts: UsageSummary[]): UsageSummary {
  const add = (f: (u: UsageSummary) => number) => parts.reduce((n, u) => n + f(u), 0);
  const nonEmpty = parts.filter((u) => u.modelRequests > 0);
  const bases = new Set(nonEmpty.map((u) => u.tokenUsageBasis));
  const endpoints = new Map<string, UsageSummary["byEndpoint"][number]>();
  const models = new Map<string, UsageSummary["byGatewayModel"][number]>();
  for (const u of parts) {
    for (const e of u.byEndpoint) {
      const key = JSON.stringify(e.endpointId);
      const m = endpoints.get(key) ?? { endpointId: e.endpointId, requests: 0, inputTokens: 0, cachedInputTokens: 0, uncachedInputTokens: 0, outputTokens: 0, cacheUsageKnown: true, requestsWithUnknownCacheUsage: 0 };
      m.requests += e.requests;
      m.inputTokens += e.inputTokens;
      m.cachedInputTokens += e.cachedInputTokens;
      m.uncachedInputTokens += e.uncachedInputTokens;
      m.outputTokens += e.outputTokens;
      m.requestsWithUnknownCacheUsage += e.requestsWithUnknownCacheUsage;
      m.cacheUsageKnown = m.requestsWithUnknownCacheUsage === 0;
      endpoints.set(key, m);
    }
    for (const g of u.byGatewayModel) {
      const m = models.get(g.gatewayModel) ?? { gatewayModel: g.gatewayModel, requests: 0, failed: 0 };
      m.requests += g.requests;
      m.failed += g.failed ?? 0;
      models.set(g.gatewayModel, m);
    }
  }
  const submitted = add((u) => u.logicalTasks.submitted);
  const completed = add((u) => u.logicalTasks.completed);
  const failed = add((u) => u.logicalTasks.failed);
  const unknownCache = add((u) => u.requestsWithUnknownCacheUsage);
  return {
    windowStart: sinceMs,
    windowEnd: untilMs,
    logicalTasks: { submitted, completed, failed, other: submitted - completed - failed },
    modelRequests: add((u) => u.modelRequests),
    succeededResponses: add((u) => u.succeededResponses),
    failedRequests: add((u) => u.failedRequests),
    uncertainRequests: add((u) => u.uncertainRequests),
    providerAttempts: parts.some((u) => u.providerAttempts === null) ? null : add((u) => u.providerAttempts ?? 0),
    providerAttemptsExact: false,
    inputTokens: add((u) => u.inputTokens),
    outputTokens: add((u) => u.outputTokens),
    cachedInputTokens: add((u) => u.cachedInputTokens),
    cacheUsageKnown: unknownCache === 0,
    requestsWithUnknownCacheUsage: unknownCache,
    uncachedInputTokens: add((u) => u.uncachedInputTokens),
    reasoningTokens: add((u) => u.reasoningTokens),
    tokenUsageBasis: bases.size === 0 ? "unknown" : bases.size === 1 ? [...bases][0]! : "mixed",
    reportedCostUsd: parts.some((u) => u.reportedCostUsd !== null) ? add((u) => u.reportedCostUsd ?? 0) : null,
    policyViolations: add((u) => u.policyViolations),
    byEndpoint: [...endpoints.values()].sort((a, b) => b.requests - a.requests),
    byGatewayModel: [...models.values()].sort((a, b) => b.requests - a.requests),
  };
}

/** One project's usage from its own store (explicitly filtered to that project). */
export function projectUsageSummary(sy: MeritRouter, project: string, sinceMs: number, untilMs = Date.now()): WithUnavailable<UsageSummary> {
  const read = fanOutProjects(sy, [project], (stores, p) => [usageSummary(stores.db, sinceMs, untilMs, p)]);
  return withUnavailable(mergeUsageSummaries(sinceMs, untilMs, read.rows), read.unavailable);
}

/** Usage of every project plus requests charged to no project, in one window. */
export function installationUsage(sy: MeritRouter, sinceMs: number, untilMs = Date.now()): WithUnavailable<UsageSummary> {
  const read = fanOutProjects(sy, adminProjectScopes(sy), (stores, p) => [usageSummary(stores.db, sinceMs, untilMs, p)]);
  const parts = [...read.rows, unattributedUsageSummary(sy.db, sinceMs, untilMs)];
  return withUnavailable(mergeUsageSummaries(sinceMs, untilMs, parts), read.unavailable);
}
