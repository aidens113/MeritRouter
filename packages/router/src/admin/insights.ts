import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { ConfigSchema, MODALITIES, PROFILE_NAMES, TIER_NAMES, type Importance, type Modality, type ProfileName, type TierName } from "../config/schema.js";
import { formatIssues, parseConfig } from "../config/load.js";
import type { Switchyard } from "../core/service.js";
import { criteria as taskCriteria, type Criterion, type SupervisorDecision, type TaskState, type VerificationRecord, type WorkerResult, type WorkerTask } from "../core/task.js";
import { verificationTrail, type TaskVerificationTrail } from "../verification/trail.js";
import { SwitchyardError } from "../core/errors.js";
import type { AcceptanceDecisionOutcome } from "../runners/types.js";
import type { StoredContract } from "../verification/contract.js";
import { resolveLevel } from "../verification/policy.js";
import type { EndpointOverride, ModelEndpoint, RoutingOverride } from "../models/catalog.js";
import type { ChainVerification } from "../models/chains.js";
import { planRoute, type CandidateExplanation } from "../routing/select.js";
import { qualificationLookup, qualificationStat, type QualificationStat } from "../qualification/stats.js";
import { DEFAULT_RULEBOOK, RulebookSchema } from "../scoring/rulebook.js";
import type { Classification } from "../scoring/score.js";
import type { UsageSummary } from "../storage/usage.js";
import type { ArtifactRow } from "../storage/artifacts.js";
import type { ProviderStatus } from "../gateway/types.js";
import { readBreakerRecords, type BreakerRecord, type BreakerSettings } from "../gateway/breaker.js";

const DAY = 86_400_000;

export interface WorkerInfo {
  owner: string;
  lastSeen: number;
}

export function workers(sy: Switchyard, withinMs = 15_000): WorkerInfo[] {
  const rows = sy.db.prepare("SELECT key, value FROM meta WHERE key LIKE 'worker:%'").all() as { key: string; value: string }[];
  const now = Date.now();
  return rows
    .map((r) => ({ owner: r.key.slice("worker:".length), lastSeen: Number(r.value) }))
    .filter((w) => now - w.lastSeen <= withinMs);
}

export interface Overview {
  generatedAt: number;
  gatewayConfigured: boolean;
  adminConfigured: boolean;
  workers: WorkerInfo[];
  usage24h: UsageSummary;
  usage7d: UsageSummary;
  tasksByState: Record<string, number>;
  models: Record<"active" | "pending_confirmation" | "disabled" | "removed", number> & { routable: number };
  providers: ProviderStatus[];
  lastScan: ReturnType<Switchyard["scanner"]["lastScan"]>;
  attention: string[];
}

export async function overview(sy: Switchyard): Promise<Overview> {
  await sy.health.refresh().catch(() => undefined);
  const now = Date.now();
  const tasksByState = Object.fromEntries(
    (sy.db.prepare("SELECT state, COUNT(*) AS n FROM tasks GROUP BY state").all() as { state: string; n: number }[]).map((r) => [r.state, r.n]),
  );
  const eps = sy.catalog.endpoints();
  const models = { active: 0, pending_confirmation: 0, disabled: 0, removed: 0, routable: 0 };
  for (const e of eps) models[e.status]++;
  models.routable = eps.filter((e) => e.status === "active" && e.available && sy.chains.latest(e.chainName)?.ok !== false).length;
  const attention: string[] = [];
  const gatewayConfigured = sy.client.name !== "unconfigured";
  if (!gatewayConfigured) attention.push(`Set ${sy.cfg.gateway.api_key_env} so tasks can reach FreeLLMAPI.`);
  if (!sy.admin) attention.push(`Set ${sy.cfg.gateway.admin_token_env} to scan models, manage chains, and edit provider keys.`);
  if (models.pending_confirmation) attention.push(`${models.pending_confirmation} model(s) need a confirmed parameter count before they can be used.`);
  if (eps.length === 0) attention.push("No models in the catalog yet. Run a scan from the Models page.");
  if (sy.cfg.discovery.free_platforms.length === 0) attention.push("No free platforms declared (discovery.free_platforms); only OpenRouter models priced at $0 count as free.");
  const s = sy.usage(now - DAY);
  if (s.policyViolations) attention.push(`${s.policyViolations} served-model policy violation(s) in the last 24h; affected models are quarantined.`);
  return {
    generatedAt: now,
    gatewayConfigured,
    adminConfigured: sy.admin !== null,
    workers: workers(sy),
    usage24h: s,
    usage7d: sy.usage(now - 7 * DAY),
    tasksByState,
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
  /** Per-platform status FreeLLMAPI reports (GET /v1/providers), cached. */
  providers: ProviderStatus[];
  /** Circuit breakers as last recorded by any process sharing this store (meta `circuit:*`). */
  breakers: ProviderBreakerView[];
  settings: BreakerSettings;
}

/** Provider health: reported cooldowns plus circuit breaker state, for the panel and the CLI. */
export async function providerHealth(sy: Switchyard): Promise<ProviderHealthView> {
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

function endpointStats(sy: Switchyard, id: string, sinceMs: number): EndpointStats {
  const r = sy.db
    .prepare(
      `SELECT COUNT(*) AS requests, SUM(status='succeeded') AS ok, SUM(status='failed') AS failed, SUM(status='uncertain') AS uncertain,
              SUM(policy_violation IS NOT NULL) AS violations, COALESCE(SUM(input_tokens),0) AS inTok, COALESCE(SUM(output_tokens),0) AS outTok,
              AVG(CASE WHEN finished_at IS NOT NULL THEN finished_at - reserved_at END) AS latency, MAX(reserved_at) AS last
         FROM model_requests WHERE endpoint_id = ? AND reserved_at > ?`,
    )
    .get(id, sinceMs) as Record<string, number | null>;
  const t = sy.db
    .prepare(
      `SELECT SUM(t.state = 'completed') AS done, SUM(t.state IN ('failed','budget_exhausted')) AS failed FROM tasks t
        WHERE t.finished_at > ? AND t.id IN (SELECT c.task_id FROM request_charges c JOIN model_requests m ON m.id = c.request_id WHERE m.served_endpoint_id = ?)`,
    )
    .get(sinceMs, id) as { done: number | null; failed: number | null };
  return {
    requests: r.requests ?? 0,
    succeeded: r.ok ?? 0,
    failed: r.failed ?? 0,
    uncertain: r.uncertain ?? 0,
    policyViolations: r.violations ?? 0,
    inputTokens: r.inTok ?? 0,
    outputTokens: r.outTok ?? 0,
    avgLatencyMs: r.latency === null ? null : Math.round(r.latency!),
    lastUsedAt: r.last ?? null,
    tasksCompleted: t.done ?? 0,
    tasksFailed: t.failed ?? 0,
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
  chain: ChainVerification | null;
  quarantined: string | null;
  firstSeenAt: number | null;
  stats7d: EndpointStats;
  eligibility: EligibilityCell[];
  qualification: Array<{ family: string; tier: TierName; stat: QualificationStat | null }>;
  /** Short plain-language status line. */
  headline: string;
}

function matrix(sy: Switchyard): Map<string, EligibilityCell[]> {
  const out = new Map<string, EligibilityCell[]>();
  const qual = qualificationLookup(sy.db, sy.cfg);
  const eps = sy.catalog.endpoints();
  const overrides = sy.catalog.routingOverrides();
  for (const profile of Object.keys(sy.cfg.profiles) as ProfileName[]) {
    for (const tier of TIER_NAMES) {
      const plan = planRoute(sy.cfg, eps, overrides, { profile, tier, inputModalities: ["text"], needsStructuredOutput: false }, { now: new Date(), qualification: qual, health: sy.health.lookup, quarantined: (ep) => sy.gate.quarantined(ep) });
      for (const ex of plan.explanations) {
        const cells = out.get(ex.endpointId) ?? [];
        cells.push({ profile, tier, eligible: ex.eligible, rank: ex.rank, reasons: ex.reasons });
        out.set(ex.endpointId, cells);
      }
    }
  }
  return out;
}

function headline(ep: ModelEndpoint, cells: EligibilityCell[], quarantined: string | null): string {
  if (quarantined) return "Quarantined after serving a request it should not have. Rescan to re-verify its chain.";
  if (ep.status !== "active") return ep.statusReason ?? ep.status;
  const usable = cells.filter((c) => c.eligible);
  if (!usable.length) return `Not used for any task: ${cells[0]?.reasons[0] ?? "no eligible task type"}.`;
  const byTier = TIER_NAMES.filter((t) => usable.some((c) => c.tier === t));
  const types = [...new Set(usable.map((c) => c.profile))];
  return `Eligible for ${types.join(", ")} at ${byTier.join("/")}.`;
}

export function modelsView(sy: Switchyard): ModelView[] {
  const m = matrix(sy);
  const since = Date.now() - 7 * DAY;
  const families = [...new Set(Object.values(sy.cfg.profiles).map((p) => p.mode))];
  return sy.catalog.endpoints().map((ep) => {
    const cells = m.get(ep.id) ?? [];
    const quarantined = sy.gate.quarantined(ep);
    return {
      endpoint: ep,
      override: sy.catalog.override(ep.id),
      chain: sy.chains.latest(ep.chainName),
      quarantined,
      firstSeenAt: sy.catalog.discoveredRow(ep.id)?.firstSeenAt ?? null,
      stats7d: endpointStats(sy, ep.id, since),
      eligibility: cells,
      qualification: families.flatMap((family) => TIER_NAMES.map((tier) => ({ family, tier, stat: qualificationStat(sy.db, sy.cfg, ep.id, family, tier) }))),
      headline: headline(ep, cells, quarantined),
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
  taskIds: string[];
}

export function requestLog(sy: Switchyard, opts: { limit?: number; endpointId?: string; taskId?: string; status?: string } = {}): RequestRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.endpointId) {
    where.push("r.endpoint_id = ?");
    args.push(opts.endpointId);
  }
  if (opts.status) {
    where.push("r.status = ?");
    args.push(opts.status);
  }
  if (opts.taskId) {
    where.push("r.id IN (SELECT request_id FROM request_charges WHERE task_id = ?)");
    args.push(opts.taskId);
  }
  const rows = sy.db
    .prepare(
      `SELECT r.*, (SELECT group_concat(task_id) FROM request_charges c WHERE c.request_id = r.id) AS task_ids
         FROM model_requests r ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY r.reserved_at DESC LIMIT ?`,
    )
    .all(...args, opts.limit ?? 200) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
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
    taskIds: r.task_ids ? String(r.task_ids).split(",") : [],
  }));
}

export interface TimeseriesPoint {
  bucketStart: number;
  endpointId: string;
  requests: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
}

/** Requests per time bucket per endpoint, for charts. */
export function timeseries(sy: Switchyard, opts: { hours?: number; bucketMinutes?: number } = {}): TimeseriesPoint[] {
  const hours = opts.hours ?? 24;
  const bucket = (opts.bucketMinutes ?? 60) * 60_000;
  const since = Date.now() - hours * 3_600_000;
  return (
    sy.db
      .prepare(
        `SELECT reserved_at - (reserved_at % CAST(? AS INTEGER)) AS bucket, COALESCE(endpoint_id, '(none)') AS ep, COUNT(*) AS n, SUM(status != 'succeeded') AS failed,
                COALESCE(SUM(input_tokens),0) AS inTok, COALESCE(SUM(output_tokens),0) AS outTok
           FROM model_requests WHERE reserved_at > ? GROUP BY bucket, ep ORDER BY bucket`,
      )
      .all(bucket, since) as Array<{ bucket: number; ep: string; n: number; failed: number; inTok: number; outTok: number }>
  ).map((r) => ({ bucketStart: r.bucket, endpointId: r.ep, requests: r.n, failed: r.failed, inputTokens: r.inTok, outputTokens: r.outTok }));
}

export function tierDistribution(sy: Switchyard, sinceMs: number): Array<{ tier: string; tasks: number; completed: number }> {
  return sy.db
    .prepare(
      `SELECT COALESCE(tier, 'unclassified') AS tier, COUNT(*) AS tasks, SUM(state = 'completed') AS completed FROM tasks WHERE created_at > ? GROUP BY tier ORDER BY tier`,
    )
    .all(sinceMs) as Array<{ tier: string; tasks: number; completed: number }>;
}

export function routingPreview(sy: Switchyard, profile: ProfileName, tier: TierName, modalities: Modality[] = ["text"]): { floorB: number; forced: boolean; explanations: CandidateExplanation[] } {
  const plan = planRoute(
    sy.cfg,
    sy.catalog.endpoints(),
    sy.catalog.routingOverrides(),
    { profile, tier, inputModalities: modalities, needsStructuredOutput: false },
    { now: new Date(), qualification: qualificationLookup(sy.db, sy.cfg), health: sy.health.lookup, quarantined: (ep) => sy.gate.quarantined(ep) },
  );
  return { floorB: plan.floorB, forced: plan.forced, explanations: plan.explanations };
}

export interface TaskDetail {
  status: ReturnType<Switchyard["getStatus"]>[number];
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

export function taskDetail(sy: Switchyard, id: string): TaskDetail | null {
  const t = sy.tasks.get(id);
  if (!t) return null;
  const row = t.row as typeof t.row & { classification_json?: string | null };
  let contract: StoredContract | null = null;
  let contractError: string | null = null;
  try {
    contract = sy.contract(id);
  } catch (err) {
    contractError = (err as Error).message;
  }
  const verification = t.result?.verification ?? null;
  const strictAcceptor = contract?.contract.verification.strictAcceptor ?? sy.cfg.verification.strict_acceptor;
  const supervisorAcceptance = verification ? resolveLevel(sy.cfg.verification, verification.level).acceptance === "supervisor" || contract?.contract.verification.acceptance === "supervisor" : contract?.contract.verification.acceptance === "supervisor";
  return {
    status: sy.getStatus([id])[0]!,
    spec: t.spec,
    result: t.result,
    classification: row.classification_json ? (JSON.parse(row.classification_json) as Classification) : null,
    events: sy.tasks.events(id, 200),
    artifacts: sy.artifacts.listForTask(id),
    requests: requestLog(sy, { taskId: id, limit: 100 }),
    criteria: taskCriteria(t.spec),
    contract,
    contractError,
    verification,
    importance: importanceView(t.spec, contract, verification),
    trail: verificationTrail({ tasks: sy.tasks, catalog: sy.catalog, sessions: sy.sessions, admission: sy.gate.admission }, id, verification),
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
 * SwitchyardErrors with the library's code (reason_required, cannot_accept_unmet,
 * human_acceptance_required, task_invalid, not_found).
 */
export function decideTaskAcceptance(sy: Switchyard, id: string, decision: "accept" | "reject", by: SupervisorDecision["by"], reason: string | null): AcceptanceDecisionOutcome {
  if (!sy.tasks.get(id)) throw new SwitchyardError("not_found", `unknown task ${id}`);
  const input = { by, reason };
  return decision === "accept" ? sy.acceptTask(id, input) : sy.rejectTask(id, input);
}

export function artifactText(sy: Switchyard, ref: string, maxBytes = 200_000): { row: ArtifactRow; text: string; truncated: boolean } | null {
  const a = sy.artifacts.read(ref);
  if (!a) return null;
  const truncated = a.content.length > maxBytes;
  return { row: a.row, text: a.content.subarray(0, maxBytes).toString("utf8"), truncated };
}

// ---------- configuration editing ----------

export function readConfigText(sy: Switchyard): string {
  return readFileSync(sy.cfg.configPath, "utf8");
}

export function validateConfigText(text: string, configPath: string): { ok: true } | { ok: false; errors: string[] } {
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (err) {
    return { ok: false, errors: [`YAML: ${(err as Error).message}`] };
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: formatIssues(parsed.error.issues) };
  try {
    parseConfig(raw, configPath);
  } catch (err) {
    return { ok: false, errors: [(err as Error).message] };
  }
  return { ok: true };
}

/** Validate, back up the previous file, and write. Running workers reload it automatically. */
export function writeConfigText(sy: Switchyard, text: string): { ok: true } | { ok: false; errors: string[] } {
  const v = validateConfigText(text, sy.cfg.configPath);
  if (!v.ok) return v;
  copyFileSync(sy.cfg.configPath, `${sy.cfg.configPath}.bak`);
  writeFileSync(sy.cfg.configPath, text);
  sy.reloadIfChanged();
  return { ok: true };
}

/** Apply a structured patch (e.g. from a settings form) to the YAML, preserving comments. */
export function patchConfig(sy: Switchyard, patch: Array<{ path: Array<string | number>; value: unknown }>): { ok: true } | { ok: false; errors: string[] } {
  const doc = YAML.parseDocument(readConfigText(sy));
  for (const p of patch) {
    if (p.value === undefined || p.value === null) doc.deleteIn(p.path);
    else doc.setIn(p.path, p.value);
  }
  return writeConfigText(sy, doc.toString());
}

export function configSchemaInfo() {
  return { profiles: PROFILE_NAMES, tiers: TIER_NAMES, modalities: MODALITIES };
}

export function rulebookText(sy: Switchyard): { path: string | null; text: string; isDefault: boolean } {
  if (sy.cfg.rulebookPath && existsSync(sy.cfg.rulebookPath)) return { path: sy.cfg.rulebookPath, text: readFileSync(sy.cfg.rulebookPath, "utf8"), isDefault: false };
  return { path: sy.cfg.rulebookPath, text: YAML.stringify(DEFAULT_RULEBOOK), isDefault: true };
}

/**
 * Save a rulebook. When none is configured, it is written next to the config as rulebook.yaml
 * and scoring.rulebook_file is set. Takes effect for newly classified tasks after a restart of
 * workers (the rulebook version is recorded on every classification).
 */
export function writeRulebook(sy: Switchyard, text: string): { ok: true; path: string } | { ok: false; errors: string[] } {
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

export function setModelOverride(sy: Switchyard, id: string, override: EndpointOverride | null): void {
  if (!sy.catalog.get(id)) throw new Error(`unknown model ${id}`);
  sy.catalog.setOverride(id, override);
}

export function addRoutingOverride(sy: Switchyard, o: RoutingOverride): number {
  if (!sy.catalog.get(o.endpointId)) throw new Error(`unknown model ${o.endpointId}`);
  return sy.catalog.addRoutingOverride(o);
}

// ---------- paid routes ----------

/** Spend against budgets, per key and per model (keys never include secrets). */
export function paidSummary(sy: Switchyard) {
  return { enabled: sy.cfg.paid.enabled, tiers: sy.cfg.paid.tiers, providers: Object.keys(sy.cfg.paid.providers), ...sy.spend.summary(), freeLlmApiKeyBilling: sy.spend.freeLlmApiKeyBilling() };
}

export function addPaidKey(sy: Switchyard, input: Parameters<Switchyard["vault"]["add"]>[0]) {
  if (!sy.cfg.paid.providers[input.provider]) throw new Error(`unknown paid provider ${input.provider}; add it under paid.providers first`);
  return sy.vault.add(input);
}

export function updatePaidKey(sy: Switchyard, id: number, patch: Parameters<Switchyard["vault"]["update"]>[1]) {
  return sy.vault.update(id, patch);
}

export function removePaidKey(sy: Switchyard, id: number): void {
  sy.vault.remove(id);
}

/** Mark a FreeLLMAPI key's billing class. A paid FreeLLMAPI key blocks its platform from free routing. */
export function setFreeLlmApiKeyBilling(sy: Switchyard, flKeyId: number, platform: string, billingClass: "free_tier" | "paid_credits" | "paid_postpaid" | "trial"): void {
  sy.spend.setFreeLlmApiKeyBilling(flKeyId, platform, billingClass);
  sy.catalog.bump();
}

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

export function qualificationBoard(sy: Switchyard): QualificationBoard {
  const suite = sy.qualifier.suite();
  const families = [...new Set(suite.evals.map((e) => e.family))];
  const rows: QualificationBoard["rows"] = [];
  for (const ep of sy.catalog.endpoints()) {
    if (ep.status === "removed") continue;
    for (const family of families) {
      for (const tier of TIER_NAMES) rows.push({ endpointId: ep.id, displayName: ep.displayName ?? ep.gatewayModelId, status: ep.status, family, tier, stat: qualificationStat(sy.db, sy.cfg, ep.id, family, tier) });
    }
  }
  const runs = (sy.db.prepare("SELECT * FROM qualification_runs ORDER BY started_at DESC LIMIT 50").all() as Array<{ id: string; endpoint_id: string; status: string; started_at: number; finished_at: number | null; detail_json: string | null }>).map((r) => {
    const c = sy.db.prepare("SELECT COUNT(*) AS total, SUM(evaluated = 1) AS graded FROM qualification_tasks WHERE run_id = ?").get(r.id) as { total: number; graded: number | null };
    return { id: r.id, endpointId: r.endpoint_id, status: r.status, startedAt: r.started_at, finishedAt: r.finished_at, detail: r.detail_json ? JSON.parse(r.detail_json) : null, graded: c.graded ?? 0, total: c.total };
  });
  const results = (sy.db.prepare("SELECT * FROM qualification_results ORDER BY created_at DESC LIMIT 300").all() as Array<{ run_id: string; endpoint_id: string; eval_id: string; trial: number; outcome: string; detail_json: string | null; task_id: string | null; created_at: number }>).map((r) => ({
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
export function startQualification(sy: Switchyard, endpointId: string, opts: { evalIds?: string[]; trials?: number } = {}) {
  return sy.qualifier.start(endpointId, opts);
}

export type { ModelEndpoint, EndpointOverride, RoutingOverride, CandidateExplanation, Classification, TaskState };
export type { ReviewView, RetryView, TargetedCheckView, RaisedLevelView, TaskVerificationTrail } from "../verification/trail.js";
// Calibration views live in their own file (insights.ts is a facade over many panel concerns).
export * from "./calibration.js";

// Jobs, their plans, and agent sessions live in their own modules; re-exported here so
// `insights.*` stays the panel's single entry point.
export * from "./jobs.js";
export * from "./job-plans.js";
export * from "./sessions.js";

// ---------- brain (for people: full access, edits committed as `human`) ----------

const HUMAN = { kind: "human" } as const;
const humanActor = { agent: "human", role: "human" };

export async function brainTree(sy: Switchyard, prefix = "") {
  await sy.brain.ensure();
  return sy.brain.list(HUMAN, prefix);
}

export function brainRead(sy: Switchyard, path: string) {
  return sy.brain.read(HUMAN, path);
}

export async function brainSearch(sy: Switchyard, query: string, prefix?: string) {
  await sy.brain.refreshIndex();
  return sy.brain.search(HUMAN, query, { ...(prefix ? { prefix } : {}), limit: 30 });
}

export function brainHistory(sy: Switchyard, path: string) {
  return sy.brain.history(path);
}

export function brainBlame(sy: Switchyard, path: string) {
  return sy.brain.blame(path);
}

/** Save a brain file as the user (protocol validation still applies to working docs and reports). */
export function brainWrite(sy: Switchyard, path: string, content: string) {
  return sy.brain.write(HUMAN, humanActor, path, content, `Edit ${path} in the panel`);
}

export function brainAccessRequests(sy: Switchyard, status?: "pending" | "approved" | "denied") {
  return sy.brainAccess.list(status ? { status } : {});
}

export function decideBrainAccess(sy: Switchyard, id: number, approve: boolean, reason: string) {
  return sy.brainAccess.decide(id, approve, "human", reason);
}
