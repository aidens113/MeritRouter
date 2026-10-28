import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
export { acknowledgeModelQuarantine } from "./quarantine.js";
export { deliveryView, projectDeliveryReport } from "./deliveries.js";
export { listWorkerActions, getWorkerAction, decideWorkerAction, workerActionScope } from "./worker-actions.js";
import path from "node:path";
import YAML from "yaml";
import { MODALITIES, PROFILE_NAMES, TIER_NAMES, type Importance, type Modality, type ProfileName, type TierName } from "../config/schema.js";
import { formatIssues } from "../config/load.js";
import { patchConfig } from "./config-edit.js";
import { contextOfTask } from "./projects.js";
import { providerKeysView } from "./provider-keys.js";
import type { MeritRouter } from "../core/service.js";
import type { Db } from "../storage/db.js";
import { criteria as taskCriteria, type Criterion, type SupervisorDecision, type TaskState, type VerificationRecord, type WorkerResult, type WorkerTask } from "../core/task.js";
import { verificationTrail, type TaskVerificationTrail } from "../verification/trail.js";
import { MeritRouterError } from "../core/errors.js";
import type { AcceptanceDecisionOutcome } from "../runners/types.js";
import type { StoredContract } from "../verification/contract.js";
import { resolveLevel } from "../verification/policy.js";
import type { EndpointOverride, ModelEndpoint, RoutingOverride } from "../models/catalog.js";
import { planRoute, type CandidateExplanation } from "../routing/select.js";
import { qualificationLookup, qualificationStat, type QualificationStat } from "../qualification/stats.js";
import { DEFAULT_RULEBOOK, RulebookSchema } from "../scoring/rulebook.js";
import type { Classification } from "../scoring/score.js";
import type { UsageSummary } from "../storage/usage.js";
import { installationUsage } from "./project-usage.js";
import { admissionOf, adminProjectScopes, AmbiguousProjectIdError, fanOutProjectRows, legacyStores, locateProjectTask, openProjectStores, projectDbScopes, projectSessionsOf, requireProjectStores, taskIn } from "./project-reads.js";
import type { ProjectRuntimeStore } from "../projects/runtime-store.js";
import { QUALIFICATION_PROJECT } from "../qualification/registry.js";
import type { ArtifactRow } from "../storage/artifacts.js";
import type { ProviderStatus, WebCitation } from "../gateway/types.js";
import { z } from "zod";
import { parseCitations } from "./request-citations.js";
import { readBreakerRecords, type BreakerRecord, type BreakerSettings } from "../gateway/breaker.js";

const DAY = 86_400_000;

export interface WorkerInfo {
  owner: string;
  lastSeen: number;
}

/**
 * Active worker processes. Deliberately not fanned out per project: `store-role.ts`'s
 * `assertProjectContents` forbids a real (split) project store's `meta` table from holding
 * anything but its own brain-index-generation row, so a `worker:*` claim is installation-wide
 * state, never per-project data, even though `meta` is classified under `localTables` for schema
 * completeness. Reading `sy.db` here is correct today and stays correct once stores split.
 */
export function workers(sy: MeritRouter, withinMs = 15_000): WorkerInfo[] {
  const rows = sy.db.prepare("SELECT key, value FROM meta WHERE key LIKE 'worker:%'").all() as { key: string; value: string }[];
  const now = Date.now();
  return rows
    .map((r) => ({ owner: r.key.slice("worker:".length), lastSeen: Number(r.value) }))
    .filter((w) => now - w.lastSeen <= withinMs);
}

export interface Overview {
  generatedAt: number;
  /** Provider keys (and keyless providers) that can be used, before cooldowns and limits. */
  usableKeys: number;
  workers: WorkerInfo[];
  usage24h: UsageSummary;
  usage7d: UsageSummary;
  tasksByState: Record<string, number>;
  models: Record<"active" | "pending_confirmation" | "disabled" | "removed", number> & { routable: number };
  providers: ProviderStatus[];
  lastScan: ReturnType<MeritRouter["scanner"]["lastScan"]>;
  attention: string[];
}

/** Task counts by state across every project (plus unattributed tasks), summed in memory per state. */
function tasksByState(sy: MeritRouter): Record<string, number> {
  const { rows } = fanOutProjectRows(sy, undefined, { qualification: true }, (db, p) =>
    db.prepare("SELECT state, COUNT(*) AS n FROM tasks WHERE project_id = ? GROUP BY state").all(p) as Array<{ state: string; n: number }>,
  );
  const merged = new Map<string, number>();
  for (const r of rows) merged.set(r.state, (merged.get(r.state) ?? 0) + r.n);
  return Object.fromEntries(merged);
}

export async function overview(sy: MeritRouter): Promise<Overview> {
  await sy.health.refresh().catch(() => undefined);
  const now = Date.now();
  const tasksByStateNow = tasksByState(sy);
  const eps = sy.catalog.endpoints();
  const models = { active: 0, pending_confirmation: 0, disabled: 0, removed: 0, routable: 0 };
  for (const e of eps) models[e.status]++;
  models.routable = eps.filter((e) => e.status === "active" && e.available).length;
  const attention: string[] = [];
  const usable = sy.providers.credentials().list().filter((c) => c.unusableReason === null);
  if (!usable.length) attention.push("Add a provider key on the Provider keys page (or under providers in the config) so tasks can reach a model.");
  const switchedOff = providerKeysView(sy).providers.flatMap((p) => p.keys).filter((k) => k.status === "invalid" || k.status === "out_of_credits").length;
  if (switchedOff) attention.push(`${switchedOff} provider key(s) are invalid or out of credits; see the Provider keys page.`);
  if (models.pending_confirmation) attention.push(`${models.pending_confirmation} model(s) need a confirmed parameter count before they can be used.`);
  if (eps.length === 0) attention.push("No models in the catalog yet. Run a scan from the Models page.");
  // Installation-wide usage is every project's own usage plus unattributed (probe/scan) requests,
  // read through each project's store rather than scanning the installation database directly.
  const s = installationUsage(sy, now - DAY, now);
  if (s.policyViolations) attention.push(`${s.policyViolations} served-model policy violation(s) in the last 24h; affected models are quarantined.`);
  return {
    generatedAt: now,
    usableKeys: usable.length,
    workers: workers(sy),
    usage24h: s,
    usage7d: installationUsage(sy, now - 7 * DAY, now),
    tasksByState: tasksByStateNow,
    models,
    providers: sy.health.snapshot(),
    lastScan: sy.scanner.lastScan(),
    attention,
  };
}

export interface ProviderBreakerView extends Omit<BreakerRecord, "probing"> {
  /** What routing does with the platform now: `open` skips it, `probe_due` lets one request through. */
  effective: "closed" | "open" | "probe_due" | "half_open";
  /** Milliseconds until a probe is due (open breakers only). */
  probeInMs: number | null;
}

export interface ProviderHealthView {
  generatedAt: number;
  /** Per-provider status derived from key state (cooldowns, invalid keys, limits). */
  providers: ProviderStatus[];
  /** Circuit breakers as last recorded by any process sharing this store (meta `circuit:*`). */
  breakers: ProviderBreakerView[];
  settings: BreakerSettings;
}

/** Provider health: reported cooldowns plus circuit breaker state, for the panel and the CLI. */
export async function providerHealth(sy: MeritRouter): Promise<ProviderHealthView> {
  await sy.health.refresh().catch(() => undefined);
  const now = Date.now();
  // Records from the store cover worker processes; this process's own state is newer when it has one.
  const byPlatform = new Map(readBreakerRecords(sy.db).map((r) => [r.platform, r]));
  for (const r of sy.health.breakers.list()) if ((byPlatform.get(r.platform)?.updatedAt ?? -1) <= r.updatedAt) byPlatform.set(r.platform, r);
  const breakers = [...byPlatform.values()]
    .sort((a, b) => a.platform.localeCompare(b.platform))
    .map(({ probing, ...r }) => {
      const due = r.state === "open" && (r.openUntil ?? 0) <= now;
      const effective: ProviderBreakerView["effective"] = r.state === "closed" ? "closed" : due ? "probe_due" : r.state === "half_open" ? (probing ? "half_open" : "probe_due") : "open";
      return { ...r, effective, probeInMs: r.state === "open" && !due ? (r.openUntil ?? now) - now : null };
    });
  return { generatedAt: now, providers: sy.health.snapshot(), breakers, settings: { ...sy.cfg.routing.circuit_breaker } };
}

export interface EndpointStats {
  requests: number;
  succeeded: number;
  failed: number;
  uncertain: number;
  policyViolations: number;
  inputTokens: number;
  outputTokens: number;
  avgLatencyMs: number | null;
  lastUsedAt: number | null;
  /** Results of tasks this model served (supervisor-visible outcomes). */
  tasksCompleted: number;
  tasksFailed: number;
}

/** One project's partial endpoint stats, before merging across every project. */
interface EndpointStatsPart {
  requests: number; ok: number; failed: number; uncertain: number; violations: number; inTok: number; outTok: number;
  /** Sum and count of finished requests' latency, to recompute a weighted average after merging (never average an average). */
  latencySum: number; latencyCount: number;
  last: number | null;
  done: number; taskFailed: number;
}

function endpointStatsPart(db: Db, project: string, id: string, sinceMs: number): EndpointStatsPart {
  const r = db
    .prepare(
      `SELECT COUNT(*) AS requests, SUM(status='succeeded') AS ok, SUM(status='failed') AS failed, SUM(status='uncertain') AS uncertain,
              SUM(policy_violation IS NOT NULL) AS violations, COALESCE(SUM(input_tokens),0) AS inTok, COALESCE(SUM(output_tokens),0) AS outTok,
              COALESCE(SUM(CASE WHEN finished_at IS NOT NULL THEN finished_at - reserved_at END),0) AS latencySum,
              SUM(finished_at IS NOT NULL) AS latencyCount, MAX(reserved_at) AS last
         FROM model_requests WHERE endpoint_id = ? AND reserved_at > ? AND project_id = ?`,
    )
    .get(id, sinceMs, project) as Record<string, number | null>;
  const t = db
    .prepare(
      `SELECT SUM(t.state = 'completed') AS done, SUM(t.state IN ('failed','budget_exhausted')) AS failed FROM tasks t
        WHERE t.finished_at > ? AND t.project_id = ? AND t.id IN (SELECT c.task_id FROM request_charges c JOIN model_requests m ON m.id = c.request_id WHERE m.served_endpoint_id = ? AND m.project_id = ?)`,
    )
    .get(sinceMs, project, id, project) as { done: number | null; failed: number | null };
  return {
    requests: r.requests ?? 0, ok: r.ok ?? 0, failed: r.failed ?? 0, uncertain: r.uncertain ?? 0, violations: r.violations ?? 0,
    inTok: r.inTok ?? 0, outTok: r.outTok ?? 0, latencySum: r.latencySum ?? 0, latencyCount: r.latencyCount ?? 0, last: r.last ?? null,
    done: t.done ?? 0, taskFailed: t.failed ?? 0,
  };
}

/** Every project's (plus unattributed requests') stats for one endpoint, merged: sums add, the average latency is recomputed from the merged sum and count. */
function endpointStats(sy: MeritRouter, id: string, sinceMs: number): EndpointStats {
  const { rows } = fanOutProjectRows(sy, undefined, { qualification: true }, (db, p) => [endpointStatsPart(db, p, id, sinceMs)]);
  const m = rows.reduce(
    (a, b) => ({
      requests: a.requests + b.requests, ok: a.ok + b.ok, failed: a.failed + b.failed, uncertain: a.uncertain + b.uncertain, violations: a.violations + b.violations,
      inTok: a.inTok + b.inTok, outTok: a.outTok + b.outTok, latencySum: a.latencySum + b.latencySum, latencyCount: a.latencyCount + b.latencyCount,
      last: a.last === null ? b.last : b.last === null ? a.last : Math.max(a.last, b.last), done: a.done + b.done, taskFailed: a.taskFailed + b.taskFailed,
    }),
    { requests: 0, ok: 0, failed: 0, uncertain: 0, violations: 0, inTok: 0, outTok: 0, latencySum: 0, latencyCount: 0, last: null as number | null, done: 0, taskFailed: 0 },
  );
  return {
    requests: m.requests,
    succeeded: m.ok,
    failed: m.failed,
    uncertain: m.uncertain,
    policyViolations: m.violations,
    inputTokens: m.inTok,
    outputTokens: m.outTok,
    avgLatencyMs: m.latencyCount === 0 ? null : Math.round(m.latencySum / m.latencyCount),
    lastUsedAt: m.last,
    tasksCompleted: m.done,
    tasksFailed: m.taskFailed,
  };
}

export interface EligibilityCell {
  profile: ProfileName;
  tier: TierName;
  eligible: boolean;
  rank: number | null;
  reasons: string[];
}

export interface ModelView {
  endpoint: ModelEndpoint;
  override: EndpointOverride | null;
  /** Set only after a served-model violation (the provider answered with another model). */
  quarantined: string | null;
  /** Every usable key's plan refused the model (not a quarantine; rechecked after a day). */
  planRefused: string | null;
  firstSeenAt: number | null;
  stats7d: EndpointStats;
  eligibility: EligibilityCell[];
  qualification: Array<{ family: string; tier: TierName; stat: QualificationStat | null }>;
  /** Short plain-language status line. */
  headline: string;
}

function matrix(sy: MeritRouter): Map<string, EligibilityCell[]> {
  const out = new Map<string, EligibilityCell[]>();
  const qual = qualificationLookup(sy.db, sy.cfg);
  const eps = sy.catalog.endpoints();
  const overrides = sy.catalog.routingOverrides();
  for (const profile of Object.keys(sy.cfg.profiles) as ProfileName[]) {
    for (const tier of TIER_NAMES) {
      const plan = planRoute(sy.cfg, eps, overrides, { profile, tier, inputModalities: ["text"], needsStructuredOutput: false }, { now: new Date(), qualification: qual, health: sy.health.lookup, quarantined: (ep) => sy.gate.excluded(ep) });
      for (const ex of plan.explanations) {
        const cells = out.get(ex.endpointId) ?? [];
        cells.push({ profile, tier, eligible: ex.eligible, rank: ex.rank, reasons: ex.reasons });
        out.set(ex.endpointId, cells);
      }
    }
  }
  return out;
}

function headline(ep: ModelEndpoint, cells: EligibilityCell[], quarantined: string | null, planRefused: string | null): string {
  if (quarantined) return "Quarantined after its provider served a different model than the one requested.";
  if (planRefused) return `Not available with your keys: ${planRefused}.`;
  if (ep.status !== "active") return ep.statusReason ?? ep.status;
  const usable = cells.filter((c) => c.eligible);
  if (!usable.length) return `Not used for any task: ${cells[0]?.reasons[0] ?? "no eligible task type"}.`;
  const byTier = TIER_NAMES.filter((t) => usable.some((c) => c.tier === t));
  const types = [...new Set(usable.map((c) => c.profile))];
  return `Eligible for ${types.join(", ")} at ${byTier.join("/")}.`;
}

export function modelsView(sy: MeritRouter): ModelView[] {
  const m = matrix(sy);
  const since = Date.now() - 7 * DAY;
  const families = [...new Set(Object.values(sy.cfg.profiles).map((p) => p.mode))];
  // qualification_results is qualificationTables (store-role.ts): the qualification project's own store.
  const qdb = requireProjectStores(sy, QUALIFICATION_PROJECT).db;
  return sy.catalog.endpoints().map((ep) => {
    const cells = m.get(ep.id) ?? [];
    const quarantined = sy.gate.quarantined(ep);
    const planRefused = sy.gate.planRefused(ep);
    return {
      endpoint: ep,
      override: sy.catalog.override(ep.id),
      quarantined,
      planRefused,
      firstSeenAt: sy.catalog.discoveredRow(ep.id)?.firstSeenAt ?? null,
      stats7d: endpointStats(sy, ep.id, since),
      eligibility: cells,
      qualification: families.flatMap((family) => TIER_NAMES.map((tier) => ({ family, tier, stat: qualificationStat(qdb, sy.cfg, ep.id, family, tier) }))),
      headline: headline(ep, cells, quarantined, planRefused),
    };
  });
}

export interface RequestRow {
  id: string;
  reservedAt: number;
  finishedAt: number | null;
  status: string;
  purpose: string;
  tier: string | null;
  endpointId: string | null;
  servedModel: string | null;
  providerAttempts: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  errorKind: string | null;
  errorMessage: string | null;
  policyViolation: string | null;
  routeNote: string | null;
  /** How the provider searched the web inside this request (the via; "(count assumed)" when it reported no count), or null. */
  nativeWebSearch: string | null;
  webSearchRequests: number | null;
  /** Sources the provider cited (untrusted web data). */
  webCitations: WebCitation[];
  taskIds: string[];
  taskRefs: Array<{ id: string; label: string | null; job: boolean }>;
  /** The project the request was charged to ('' for none: probes, scans). */
  project: string;
}

/**
 * Model requests, newest first. `project` limits them to one project's requests (those charged to
 * its tasks); without it every request is listed, including probes charged to no project.
 */
export interface RequestLogOptions {
  limit?: number; offset?: number; endpointId?: string; taskId?: string; jobId?: string;
  status?: string; project?: string; purpose?: string; tier?: string; problems?: boolean;
}

const RequestLogOptionsSchema = z.object({
  limit: z.number().int().positive().max(1000).optional(), offset: z.number().int().nonnegative().max(100000000).optional(),
  endpointId: z.string().max(1000).optional(), taskId: z.string().max(1000).optional(), jobId: z.string().max(1000).optional(),
  status: z.string().max(100).optional(), project: z.string().max(1000).optional(), purpose: z.string().max(100).optional(),
  tier: z.string().max(100).optional(), problems: z.boolean().optional(),
}).strict();
/**
 * `where`/`args` for one db scope's slice of the log. `scopeProject` is always bound (even when
 * the caller passed no `project`): the fan-out in `requestLogCount`/`requestLog` runs this once
 * per project (plus the installation database's `''` rows), and today every scope can share one
 * database handle, so the explicit filter is what keeps each scope's rows from counting twice.
 */
function requestLogScope(opts: RequestLogOptions, scopeProject: string): { where: string[]; args: unknown[] } {
  const where: string[] = ["r.project_id = ?"];
  const args: unknown[] = [scopeProject];
  for (const [column, value] of [["endpoint_id", opts.endpointId], ["status", opts.status], ["purpose", opts.purpose], ["tier", opts.tier]] as const) {
    if (value !== undefined) { where.push(`r.${column} = ?`); args.push(value); }
  }
  if (opts.taskId) {
    where.push("r.id IN (SELECT request_id FROM request_charges WHERE task_id = ?)");
    args.push(opts.taskId);
  }
  if (opts.jobId) {
    // Derive scope from the stored root, never from a URL's project assertion. UNION terminates cycles.
    where.push(`r.id IN (WITH RECURSIVE job_tasks(id, project_id) AS (
      SELECT id, project_id FROM tasks WHERE id = ? AND profile = 'supervise'
      UNION SELECT t.id, t.project_id FROM tasks t JOIN job_tasks j
        ON json_extract(t.spec_json, '$.parentTaskId') = j.id AND t.project_id = j.project_id
    ) SELECT c.request_id FROM request_charges c JOIN job_tasks j ON j.id = c.task_id
      WHERE j.project_id = r.project_id)`);
    args.push(opts.jobId);
  }
  if (opts.problems) where.push("(r.error_kind IS NOT NULL OR r.policy_violation IS NOT NULL)");
  return { where, args };
}

/** Matching physical requests, before pagination; batches count once. `project` reads one project's store (or `''`'s installation rows); without it, every scope is summed. */
export function requestLogCount(sy: MeritRouter, opts: RequestLogOptions = {}): number {
  const parsed = RequestLogOptionsSchema.parse(opts);
  const { scopes } = projectDbScopes(sy, parsed.project, { qualification: true });
  return scopes.reduce((total, s) => {
    const { where, args } = requestLogScope(parsed, s.project);
    return total + (s.db.prepare(`SELECT COUNT(*) AS n FROM model_requests r WHERE ${where.join(" AND ")}`).get(...args) as { n: number }).n;
  }, 0);
}

const TaskRefRow = z.object({ label: z.string().nullable(), profile: z.string() });

/** `db` is the store the row came from: a request's tasks live in its own project's store. */
function requestRowOf(db: Db, r: Record<string, unknown>): RequestRow {
  const taskRef = db.prepare("SELECT json_extract(spec_json, '$.label') AS label, profile FROM tasks WHERE id = ? AND project_id = ?");
  return {
    id: String(r.id),
    reservedAt: Number(r.reserved_at),
    finishedAt: (r.finished_at as number | null) ?? null,
    status: String(r.status),
    purpose: String(r.purpose),
    tier: (r.tier as string | null) ?? null,
    endpointId: (r.endpoint_id as string | null) ?? null,
    servedModel: (r.served_model as string | null) ?? null,
    providerAttempts: (r.provider_attempts as number | null) ?? null,
    inputTokens: (r.input_tokens as number | null) ?? null,
    outputTokens: (r.output_tokens as number | null) ?? null,
    cachedInputTokens: (r.cached_input_tokens as number | null) ?? null,
    errorKind: (r.error_kind as string | null) ?? null,
    errorMessage: (r.error_message as string | null) ?? null,
    policyViolation: (r.policy_violation as string | null) ?? null,
    routeNote: (r.route_note as string | null) ?? null,
    nativeWebSearch: (r.native_web_search as string | null) ?? null,
    webSearchRequests: (r.web_search_requests as number | null) ?? null,
    webCitations: parseCitations(r.web_citations_json),
    taskRefs: (r.task_ids ? String(r.task_ids).split(",") : []).flatMap(id => {
      const task = TaskRefRow.safeParse(taskRef.get(id, String(r.project_id ?? "")));
      return task.success ? [{ id, label: task.data.label, job: task.data.profile === "supervise" }] : [];
    }),
    taskIds: r.task_ids ? String(r.task_ids).split(",") : [],
    project: String(r.project_id ?? ""),
  };
}

/**
 * Model requests, newest first. `project` reads one project's own store (or `''`'s installation
 * rows); without it, every project's store (plus `''`) is read and merged in memory, re-sorting
 * and re-paginating after the merge so ties (the same `reservedAt`) keep the stored `id DESC`
 * order a single-scope SQL `ORDER BY` would give.
 */
export function requestLog(sy: MeritRouter, opts: RequestLogOptions = {}): RequestRow[] {
  const parsed = RequestLogOptionsSchema.parse(opts);
  const { scopes } = projectDbScopes(sy, parsed.project, { qualification: true });
  const limit = Math.max(1, Math.min(1000, parsed.limit ?? 200));
  const offset = Math.max(0, parsed.offset ?? 0);
  // Each scope need only contribute its own newest (offset+limit) candidates for the merge to be
  // correct; cap that per-scope fetch so a huge offset against many scopes stays bounded.
  const perScopeFetch = Math.min(offset + limit, 100_000);
  const rows = scopes.flatMap((s) => {
    const { where, args } = requestLogScope(parsed, s.project);
    return (s.db
      .prepare(
        `SELECT r.*, (SELECT group_concat(c.task_id) FROM request_charges c JOIN tasks t ON t.id = c.task_id WHERE c.request_id = r.id AND t.project_id = r.project_id) AS task_ids
           FROM model_requests r WHERE ${where.join(" AND ")} ORDER BY r.reserved_at DESC, r.id DESC LIMIT ?`,
      )
      .all(...args, perScopeFetch) as Array<Record<string, unknown>>).map((r) => ({ r, db: s.db }));
  });
  rows.sort(({ r: a }, { r: b }) => (Number(b.reserved_at) - Number(a.reserved_at)) || (String(b.id) < String(a.id) ? -1 : String(b.id) > String(a.id) ? 1 : 0));
  return rows.slice(offset, offset + limit).map(({ r, db }) => requestRowOf(db, r));
}

export interface TimeseriesPoint {
  bucketStart: number;
  endpointId: string;
  requests: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Requests per time bucket per endpoint, for charts. `project` reads one project's own store (or
 * `''`'s installation rows); without it, every scope is read and merged in memory, summing each
 * (bucket, endpoint) pair's counts and tokens (a bucket boundary is the same instant everywhere,
 * so no recomputation beyond the sum is needed).
 */
export function timeseries(sy: MeritRouter, opts: { hours?: number; bucketMinutes?: number; project?: string } = {}): TimeseriesPoint[] {
  const hours = opts.hours ?? 24;
  const bucket = (opts.bucketMinutes ?? 60) * 60_000;
  const since = Date.now() - hours * 3_600_000;
  const { rows } = fanOutProjectRows(sy, opts.project, { qualification: true }, (db, p) =>
    db
      .prepare(
        `SELECT reserved_at - (reserved_at % CAST(? AS INTEGER)) AS bucket, COALESCE(endpoint_id, '(none)') AS ep, COUNT(*) AS n, SUM(status != 'succeeded') AS failed,
                COALESCE(SUM(input_tokens),0) AS inTok, COALESCE(SUM(output_tokens),0) AS outTok
           FROM model_requests WHERE reserved_at > ? AND project_id = ? GROUP BY bucket, ep`,
      )
      .all(bucket, since, p) as Array<{ bucket: number; ep: string; n: number; failed: number; inTok: number; outTok: number }>,
  );
  const merged = new Map<string, TimeseriesPoint>();
  for (const r of rows) {
    const key = `${r.bucket}:${r.ep}`;
    const m = merged.get(key) ?? { bucketStart: r.bucket, endpointId: r.ep, requests: 0, failed: 0, inputTokens: 0, outputTokens: 0 };
    m.requests += r.n;
    m.failed += r.failed;
    m.inputTokens += r.inTok;
    m.outputTokens += r.outTok;
    merged.set(key, m);
  }
  return [...merged.values()].sort((a, b) => a.bucketStart - b.bucketStart);
}

/**
 * Tasks created since `sinceMs`, grouped by tier. `project` reads one project's own store (or
 * `''`'s installation rows); without it, every scope is read and the per-tier counts summed.
 */
export function tierDistribution(sy: MeritRouter, sinceMs: number, project?: string): Array<{ tier: string; tasks: number; completed: number }> {
  const { rows } = fanOutProjectRows(sy, project, { qualification: true }, (db, p) =>
    db.prepare("SELECT COALESCE(tier, 'unclassified') AS tier, COUNT(*) AS tasks, SUM(state = 'completed') AS completed FROM tasks WHERE created_at > ? AND project_id = ? GROUP BY tier").all(sinceMs, p) as Array<{
      tier: string; tasks: number; completed: number;
    }>,
  );
  const merged = new Map<string, { tier: string; tasks: number; completed: number }>();
  for (const r of rows) {
    const m = merged.get(r.tier) ?? { tier: r.tier, tasks: 0, completed: 0 };
    m.tasks += r.tasks;
    m.completed += r.completed;
    merged.set(r.tier, m);
  }
  return [...merged.values()].sort((a, b) => a.tier.localeCompare(b.tier));
}

export function routingPreview(sy: MeritRouter, profile: ProfileName, tier: TierName, modalities: Modality[] = ["text"]): { floorB: number; forced: boolean; explanations: CandidateExplanation[] } {
  const plan = planRoute(
    sy.cfg,
    sy.catalog.endpoints(),
    sy.catalog.routingOverrides(),
    { profile, tier, inputModalities: modalities, needsStructuredOutput: false },
    { now: new Date(), qualification: qualificationLookup(sy.db, sy.cfg), health: sy.health.lookup, quarantined: (ep) => sy.gate.excluded(ep) },
  );
  return { floorB: plan.floorB, forced: plan.forced, explanations: plan.explanations };
}

export interface TaskDetail {
  status: ReturnType<MeritRouter["getStatus"]>[number];
  spec: WorkerTask;
  result: WorkerResult | null;
  classification: Classification | null;
  events: Array<{ ts: number; type: string; data: unknown }>;
  artifacts: ArtifactRow[];
  requests: RequestRow[];
  /** The acceptance criteria with their ids (strings get c1..cn). */
  criteria: Criterion[];
  /** The stored acceptance contract; null before classification and for supervisor jobs. */
  contract: StoredContract | null;
  /** Set when the stored contract failed validation or its digest check. */
  contractError: string | null;
  /** The result's verification record, if verification ran. */
  verification: VerificationRecord | null;
  importance: TaskImportanceView | null;
  acceptance: TaskAcceptanceView;
  /** Reviews, retries, targeted checks, raised levels, and requests by purpose. */
  trail: TaskVerificationTrail;
}

/** Effective importance: from the result when it was raised there, else the contract, else the request. */
export interface TaskImportanceView {
  level: Importance;
  requested: Importance | null;
  reason: string | null;
  source: string;
  /** False until the contract is compiled: the level shown is only what was requested. */
  compiled: boolean;
}

export interface TaskAcceptanceView {
  /** Finished, completed, and waiting for a supervisor's or a human's decision. */
  awaitingDecision: boolean;
  /** The effective verification level requires an explicit acceptance (strict). */
  supervisorAcceptance: boolean;
  /** verification.strict_acceptor: with "human", only the CLI, MCP, or panel can accept a strict result. */
  strictAcceptor: "supervisor" | "human";
  decisions: SupervisorDecision[];
}

/**
 * One task's detail, read from its own project's store. With `project`, only that project is
 * searched (another project's task is null); without it, every project is searched and an id
 * held by two projects is refused.
 */
export function taskDetail(sy: MeritRouter, id: string, project?: string): TaskDetail | null {
  const located = locateProjectTask(sy, id, project);
  if (!located) return null;
  const { stores, task: t } = located;
  const row = t.row as typeof t.row & { classification_json?: string | null };
  let contract: StoredContract | null = null;
  let contractError: string | null = null;
  try {
    contract = stores.contracts.get(id);
  } catch (err) {
    contractError = (err as Error).message;
  }
  const verification = t.result?.verification ?? null;
  // The task's project may override its verification policy.
  const policy = contextOfTask(sy, id, located.project).verification;
  const strictAcceptor = contract?.contract.verification.strictAcceptor ?? policy.strict_acceptor;
  const supervisorAcceptance = verification ? resolveLevel(policy, verification.level).acceptance === "supervisor" || contract?.contract.verification.acceptance === "supervisor" : contract?.contract.verification.acceptance === "supervisor";
  return {
    status: sy.getStatus([id], located.project)[0]!,
    spec: t.spec,
    result: t.result,
    classification: row.classification_json ? (JSON.parse(row.classification_json) as Classification) : null,
    events: stores.tasks.events(id, 200),
    artifacts: stores.artifacts.listForTask(id),
    requests: requestLog(sy, { taskId: id, project: located.project, limit: 100 }),
    criteria: taskCriteria(t.spec),
    contract,
    contractError,
    verification,
    importance: importanceView(t.spec, contract, verification),
    trail: verificationTrail({ tasks: stores.tasks, catalog: sy.catalog, sessions: projectSessionsOf(stores), admission: stores.db === sy.db ? sy.gate.admission : admissionOf(sy, stores) }, id, verification),
    acceptance: {
      awaitingDecision: t.row.state === "completed" && t.result?.acceptanceStatus === "needs_supervisor",
      supervisorAcceptance,
      strictAcceptor,
      decisions: verification?.decisions ?? [],
    },
  };
}

function importanceView(spec: WorkerTask, contract: StoredContract | null, verification: VerificationRecord | null): TaskImportanceView | null {
  const c = contract?.contract.importance;
  if (verification) return { level: verification.importance, requested: c?.requested ?? spec.importance ?? null, reason: c?.reason ?? spec.importanceReason ?? null, source: verification.importanceSource, compiled: true };
  if (c) return { level: c.level, requested: c.requested, reason: c.reason, source: c.source, compiled: true };
  if (spec.importance) return { level: spec.importance, requested: spec.importance, reason: spec.importanceReason ?? null, source: "task", compiled: false };
  return null;
}

/**
 * Accept or reject a finished task's result from a surface outside a job. Human acceptance is an
 * explicit manual override: only the CLI (`{kind: "human", id: "cli:<os user>"}`) and the panel
 * (`{kind: "human", id: "panel"}`) are human. The MCP client is normally an agent (Claude Code)
 * acting as the user's supervisor, so it records `{kind: "supervisor", id: "mcp:<client>"}` and,
 * with `verification.strict_acceptor: human`, cannot accept a strict result. Refusals are
 * MeritRouterErrors with the library's code (reason_required, cannot_accept_unmet,
 * human_acceptance_required, task_invalid, not_found).
 */
export function decideTaskAcceptance(sy: MeritRouter, id: string, decision: "accept" | "reject", by: SupervisorDecision["by"], reason: string | null, project?: string): AcceptanceDecisionOutcome {
  // Read from the task's own project's store; with a project, another project's task reads as
  // unknown (as `getStatus` does).
  const located = locateProjectTask(sy, id, project);
  if (!located || (project && located.task.row.project_id !== project)) throw new MeritRouterError("not_found", `unknown task ${id}${project ? ` in project ${project}` : ""}`);
  const input = { by, reason };
  // Name the owning project so the service writes to that project's store.
  const owner = project ?? (located.task.row.project_id || undefined);
  return decision === "accept" ? sy.acceptTask(id, input, owner) : sy.rejectTask(id, input, owner);
}

/**
 * An artifact's text (the first `maxBytes`), read from the store holding it. With `project`, only
 * that project's store is searched and an artifact of another project's task is not found;
 * without it, a legacy installation reads its one store and a split installation searches every
 * project's store, refusing an id held by two.
 */
export function artifactText(sy: MeritRouter, ref: string, maxBytes = 200_000, project?: string): { row: ArtifactRow; text: string; truncated: boolean } | null {
  const a = readArtifact(sy, ref, project);
  if (!a) return null;
  const truncated = a.content.length > maxBytes;
  return { row: a.row, text: a.content.subarray(0, maxBytes).toString("utf8"), truncated };
}

function readArtifact(sy: MeritRouter, ref: string, project?: string): { row: ArtifactRow; content: Buffer } | undefined {
  const legacy = legacyStores(sy);
  if (project === undefined && legacy) return legacy.artifacts.read(ref);
  const found: Array<{ project: string; stores: ProjectRuntimeStore }> = [];
  for (const p of project !== undefined ? [project] : adminProjectScopes(sy)) {
    const opened = openProjectStores(sy, p);
    if (!opened.ok) continue;
    const row = opened.stores.artifacts.get(ref);
    // A task's artifact belongs to that task's project (a shared legacy store holds every project's).
    if (row && (!row.task_id || taskIn(sy, opened.stores, row.task_id))) found.push({ project: p, stores: opened.stores });
  }
  if (found.length > 1) throw new AmbiguousProjectIdError("artifact", ref, found.map((f) => f.project));
  return found[0]?.stores.artifacts.read(ref);
}

// ---------- configuration editing (config-edit.ts) ----------

export { readConfigText, validateConfigText, writeConfigText, patchConfig, writePreparedConfigText, patchPreparedConfig } from "./config-edit.js";
export * from "./labs.js";

export function configSchemaInfo() {
  return { profiles: PROFILE_NAMES, tiers: TIER_NAMES, modalities: MODALITIES };
}

export function rulebookText(sy: MeritRouter): { path: string | null; text: string; isDefault: boolean } {
  if (sy.cfg.rulebookPath && existsSync(sy.cfg.rulebookPath)) return { path: sy.cfg.rulebookPath, text: readFileSync(sy.cfg.rulebookPath, "utf8"), isDefault: false };
  return { path: sy.cfg.rulebookPath, text: YAML.stringify(DEFAULT_RULEBOOK), isDefault: true };
}

/**
 * Save a rulebook. When none is configured, it is written next to the config as rulebook.yaml
 * and scoring.rulebook_file is set. Takes effect for newly classified tasks after a restart of
 * workers (the rulebook version is recorded on every classification).
 */
export function writeRulebook(sy: MeritRouter, text: string): { ok: true; path: string } | { ok: false; errors: string[] } {
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (err) {
    return { ok: false, errors: [`YAML: ${(err as Error).message}`] };
  }
  const parsed = RulebookSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: formatIssues(parsed.error.issues) };
  const target = sy.cfg.rulebookPath ?? path.join(path.dirname(sy.cfg.configPath), "rulebook.yaml");
  if (existsSync(target)) copyFileSync(target, `${target}.bak`);
  writeFileSync(target, text);
  if (!sy.cfg.rulebookPath) {
    const r = patchConfig(sy, [{ path: ["scoring", "rulebook_file"], value: path.basename(target) }]);
    if (!r.ok) return r;
  }
  return { ok: true, path: target };
}

// ---------- overrides ----------

export function setModelOverride(sy: MeritRouter, id: string, override: EndpointOverride | null): void {
  if (!sy.catalog.get(id)) throw new Error(`unknown model ${id}`);
  sy.catalog.setOverride(id, override);
}

export function addRoutingOverride(sy: MeritRouter, o: RoutingOverride): number {
  if (!sy.catalog.get(o.endpointId)) throw new Error(`unknown model ${o.endpointId}`);
  return sy.catalog.addRoutingOverride(o);
}

// Provider keys (vault and config), key tests, custom providers, and paid spend.
export * from "./provider-keys.js";
// Web search: backend status, search-service keys, recent web requests.
export * from "./web-search.js";

// ---------- qualification ----------

export interface QualificationBoard {
  suiteVersion: string;
  evals: Array<{ id: string; family: string; tier: TierName; title: string; profile: ProfileName; maxModelRequests: number }>;
  rows: Array<{ endpointId: string; displayName: string; status: string; family: string; tier: TierName; stat: QualificationStat | null }>;
  runs: Array<{ id: string; endpointId: string; status: string; startedAt: number; finishedAt: number | null; detail: unknown; graded: number; total: number }>;
  results: Array<{ runId: string; endpointId: string; evalId: string; trial: number; outcome: string; detail: unknown; taskId: string | null; createdAt: number }>;
  requestsUsedToday: number;
  dailyAllocation: number;
}

/**
 * `qualification_runs`/`qualification_results`/`qualification_tasks` are `qualificationTables`
 * (`store-role.ts`): they belong to the reserved qualification project's own store, not every
 * project's, so this board reads a single scope (that project's), never a fan-out.
 */
export function qualificationBoard(sy: MeritRouter): QualificationBoard {
  const suite = sy.qualifier.suite();
  const families = [...new Set(suite.evals.map((e) => e.family))];
  const qdb = requireProjectStores(sy, QUALIFICATION_PROJECT).db;
  const rows: QualificationBoard["rows"] = [];
  for (const ep of sy.catalog.endpoints()) {
    if (ep.status === "removed") continue;
    for (const family of families) {
      for (const tier of TIER_NAMES) rows.push({ endpointId: ep.id, displayName: ep.displayName ?? ep.gatewayModelId, status: ep.status, family, tier, stat: qualificationStat(qdb, sy.cfg, ep.id, family, tier) });
    }
  }
  const runs = (qdb.prepare("SELECT * FROM qualification_runs ORDER BY started_at DESC LIMIT 50").all() as Array<{ id: string; endpoint_id: string; status: string; started_at: number; finished_at: number | null; detail_json: string | null }>).map((r) => {
    const c = qdb.prepare("SELECT COUNT(*) AS total, SUM(evaluated = 1) AS graded FROM qualification_tasks WHERE run_id = ?").get(r.id) as { total: number; graded: number | null };
    return { id: r.id, endpointId: r.endpoint_id, status: r.status, startedAt: r.started_at, finishedAt: r.finished_at, detail: r.detail_json ? JSON.parse(r.detail_json) : null, graded: c.graded ?? 0, total: c.total };
  });
  const results = (qdb.prepare("SELECT * FROM qualification_results ORDER BY created_at DESC LIMIT 300").all() as Array<{ run_id: string; endpoint_id: string; eval_id: string; trial: number; outcome: string; detail_json: string | null; task_id: string | null; created_at: number }>).map((r) => ({
    runId: r.run_id,
    endpointId: r.endpoint_id,
    evalId: r.eval_id,
    trial: r.trial,
    outcome: r.outcome,
    detail: r.detail_json ? JSON.parse(r.detail_json) : null,
    taskId: r.task_id,
    createdAt: r.created_at,
  }));
  return {
    suiteVersion: suite.version,
    evals: suite.evals.map((e) => ({ id: e.id, family: e.family, tier: e.tier, title: e.title, profile: e.profile, maxModelRequests: e.budget.maxModelRequests })),
    rows,
    runs,
    results,
    requestsUsedToday: sy.qualifier.requestsUsedToday(),
    dailyAllocation: sy.cfg.qualification.max_requests_per_day,
  };
}

/** Start a qualification run; a running worker executes it and grades results as they finish. */
export function startQualification(sy: MeritRouter, endpointId: string, opts: { evalIds?: string[]; trials?: number } = {}) {
  return sy.qualifier.start(endpointId, opts);
}

export type { ModelEndpoint, EndpointOverride, RoutingOverride, CandidateExplanation, Classification, TaskState };
export type { ReviewView, RetryView, TargetedCheckView, RaisedLevelView, TaskVerificationTrail } from "../verification/trail.js";
// Calibration views live in their own file (insights.ts is a facade over many panel concerns).
export * from "./calibration.js";

// Jobs, their plans and teams, and agent sessions live in their own modules; re-exported here
// so `insights.*` stays the panel's single entry point.
export * from "./jobs.js";
export * from "./job-plans.js";
export * from "./job-team.js";
export * from "./job-metrics.js";
export * from "./sessions.js";
// Projects: the grid, create and archive, the global dashboard and per-project overview, and the
// global vs per-project settings split.
export * from "./projects.js";
// A project whose store is unavailable right now (and the check for one or every project), for
// panel views (sessions, teams, ...) that read a single project's store directly and would
// otherwise show silence instead of a reason. `projectsGrid`'s own `attentionItems` already
// covers the grid.
export { unavailableProjectStores, type ProjectStoreUnavailable } from "./project-reads.js";
export * from "./dashboards.js";
export * from "./project-settings.js";
// Global knowledge (D9): global entries with provenance, promotions awaiting a person, reverts.
export * from "./promotions.js";
export * from "./budget.js";
// Team-vs-single comparisons (recorded by the qualification comparison runner).
export { comparisons, comparison, type ComparisonRecord, type ComparisonResult, type ComparisonRunRecord, type MetricsSnapshot } from "../qualification/comparison.js";
// The reserved `_qualification` project's tasks and eval comparisons (the panel's /all/qualification).
export * from "./qualification-work.js";
// Live updates: the change watcher behind the panel's /api/live stream.
export * from "./live.js";
// Entity pages: agents, requests, commits and repositories, and what a task or model connects to.
export * from "./entities.js";

// ---------- brain (for people: full access, edits committed as `human`) ----------
// Every function takes an optional project: its brain (one per project over the shared brain
// repository) is used; without one, the primary project's.

const HUMAN = { kind: "human" } as const;
const humanActor = { agent: "human", role: "human" };
const brainOf = (sy: MeritRouter, project?: string) => (project ? sy.brainFor(project) : sy.brain);

export async function brainTree(sy: MeritRouter, prefix = "", project?: string) {
  const brain = brainOf(sy, project);
  await brain.ensure();
  return brain.list(HUMAN, prefix);
}

export function brainRead(sy: MeritRouter, path: string, project?: string) {
  return brainOf(sy, project).read(HUMAN, path);
}

export async function brainSearch(sy: MeritRouter, query: string, prefix?: string, project?: string) {
  const brain = brainOf(sy, project);
  await brain.refreshIndex({ maxAgeMs: 5000 });
  return brain.search(HUMAN, query, { ...(prefix ? { prefix } : {}), limit: 30, scope: project ? "project" : "all" });
}

export { brainCatalogPage, brainSearchPage } from "./brain-catalog.js";
export { brainMemoryManifestPreview } from "./brain-memory-manifest.js";
export { brainDocumentHistoryPage } from "./brain-entities.js";

export function brainHistory(sy: MeritRouter, path: string, project?: string) {
  return brainOf(sy, project).history(path);
}

export { brainCommitDetail, brainDocumentBlame, brainDocumentHistory, brainDocumentRelated, brainDocumentVisible, type BrainCommitDetail, type BrainHistoryEntry } from "./brain-entities.js";
export * from "./plan-recovery.js";

export function brainBlame(sy: MeritRouter, path: string, project?: string) {
  return brainOf(sy, project).blame(path);
}

/** Save a brain file as the user (protocol validation still applies to working docs and reports). */
export function brainWrite(sy: MeritRouter, path: string, content: string, project?: string, opts: { expectedDigest?: string | null } = {}) {
  return brainOf(sy, project).write(HUMAN, humanActor, path, content, `Edit ${path} in the panel`, opts);
}

/**
 * The project a brain access request belongs to ('' when unassigned), or null for an unknown
 * request. `brain_access_requests` is project-private; its numeric id is unique only within its
 * own project's store, so every configured project (and qualification) is tried until found.
 */
function accessRequestProject(sy: MeritRouter, id: number): string | null {
  for (const p of adminProjectScopes(sy)) {
    const opened = openProjectStores(sy, p);
    if (!opened.ok) continue;
    const r = opened.stores.db.prepare("SELECT project_id FROM brain_access_requests WHERE id = ?").get(id) as { project_id: string } | undefined;
    if (r) return r.project_id;
  }
  return null;
}

/** Workers' brain access requests; `project` limits them to one project's (all projects when omitted). */
export function brainAccessRequests(sy: MeritRouter, status?: "pending" | "approved" | "denied", project?: string) {
  const all = (project ? sy.brainAccessFor(project) : sy.brainAccess).list(status ? { status } : {});
  if (!project) return all;
  // `brain_access_requests` is project-private: read the id set from the project's own store.
  const opened = openProjectStores(sy, project);
  if (!opened.ok) return [];
  const mine = new Set((opened.stores.db.prepare("SELECT id FROM brain_access_requests WHERE project_id = ?").all(project) as Array<{ id: number }>).map((r) => r.id));
  return all.filter((r) => mine.has(r.id));
}

/** Decide a request through its own project's brain access; with `project`, another project's request is refused. */
export function decideBrainAccess(sy: MeritRouter, id: number, approve: boolean, reason: string, project?: string) {
  const owner = accessRequestProject(sy, id);
  if (project && owner !== null && owner !== project) throw new MeritRouterError("not_found", `unknown brain access request ${id} in project ${project}`);
  const access = owner && sy.projects.get(owner) ? sy.brainAccessFor(owner) : sy.brainAccess;
  return access.decide(id, approve, "human", reason);
}

export * from "./client-supervision.js";

export * from "./request-evidence.js";
export * from "./request-capture.js";
// Per-project and installation-wide usage, read through each project's own store.
export { projectUsageSummary, installationUsage } from "./project-usage.js";
