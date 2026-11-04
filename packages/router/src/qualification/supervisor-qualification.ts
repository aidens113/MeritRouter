import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { MeritRouter } from "../core/service.js";
import type { ResolvedConfig } from "../config/load.js";
import type { StoredTask } from "../storage/tasks.js";
import type { GateRequest } from "../gateway/gate.js";
import { MeritRouterError } from "../core/errors.js";
import { isTerminal, WorkerTaskSchema, type WorkerTask } from "../core/task.js";
import { canonicalJson } from "../storage/tasks.js";
import { immediate, newId, type Db } from "../storage/db.js";
import { freeKeyOnly, isPaid } from "../routing/select.js";
import type { ModelEndpoint } from "../models/catalog.js";
import { SupervisorRankingEvidenceSchema, type SupervisorRankingEvidence } from "../routing/supervisor-ranking.js";
import { assessSupervisorQuality, bindSupervisorEvidence, type SupervisorQualityRouting } from "../routing/supervisor-quality.js";
import { QUALIFICATION_PROJECT, registerRepository, SUPERVISOR_EVAL_PROFILE, SUPERVISOR_EVAL_INPUT_TOKENS, SUPERVISOR_EVAL_OUTPUT_TOKENS, SUPERVISOR_EVAL_CONTEXT_TOKENS } from "./registry.js";
import { initRepo } from "./runner.js";
import { gradeSupervisorDecisions, SUPERVISOR_SUITE_DIGEST, SUPERVISOR_SUITE_VERSION, SUPERVISOR_SUITE_SOURCE, SUPERVISOR_VARIANT } from "./supervisor-suite.js";
import { ask, baseResult, type RunContext, type RunOutcome } from "../runners/types.js";
import { SUPERVISOR_SCENARIOS, SUPERVISOR_DECISION_TOOL, SupervisorDecisionsSchema } from "./supervisor-suite.js";

const VERSION = `${SUPERVISOR_SUITE_VERSION}:${SUPERVISOR_SUITE_DIGEST}`;
const MAX_RUN_MS = 5 * 60_000;
const RETAIN_MS = 7 * 86_400_000;
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const RunSchema = z.object({
  kind: z.literal("supervisor_decisions"), version: z.literal(VERSION), variant: z.literal(SUPERVISOR_VARIANT),
  identity: z.string().regex(/^[a-f0-9]{64}$/), endpoint: z.string(), provider: z.string(), model: z.string(),
  taskId: z.string(), alias: z.string(), fixture: z.string(), deadline: z.number().int(), expiresAt: z.number().int(),
  maxPaidUsd: z.number().finite().min(0).max(1), funding: z.string(), owner: z.string(), preparingUntil: z.number().int(),
}).strict();
type RunDetail = z.infer<typeof RunSchema>;
type FundingEnvelope = { requests: number; paidUsd: number };
const RunRow = z.object({ id: z.string(), endpoint_id: z.string(), suite_version: z.string(), status: z.enum(["preparing", "running", "finished", "failed"]), detail_json: z.string() }).strict();
const Aggregate = z.object({ runId: z.string(), evidence: SupervisorRankingEvidenceSchema }).strict();
const Intent = z.object({ project: z.string(), digest: z.string(), submissionRef: z.string(), endpoints: z.array(z.object({ id: z.string(), paidBudget: z.number().finite().min(0).max(1) }).strict()), runs: z.array(z.string()), unavailable: z.array(z.object({ endpointId: z.string(), reason: z.string(), checkedAt: z.number().int() }).strict()).default([]), requestHold: z.number().int().nonnegative(), paidHold: z.number().finite().nonnegative() }).strict();
const SavedSubmission = z.object({ project: z.string(), digest: z.string(), specs: z.array(WorkerTaskSchema), inputSpecs: z.array(WorkerTaskSchema), purpose: z.string().optional(), parentSessionId: z.string().optional() }).strict();

/** Resolve only a service-persisted sandbox binding; purpose/goal text alone grants nothing. */
export function supervisorSandboxBinding(db: Db, raw: unknown, project: string, purpose: string | undefined): { runId: string; detail: RunDetail; status: string } | null {
  const input = WorkerTaskSchema.safeParse(raw);
  if (!input.success || !input.data.id) return null;
  const spec = input.data;
  const found = db.prepare("SELECT id,endpoint_id,suite_version,status,detail_json FROM qualification_runs WHERE json_valid(detail_json) AND json_extract(detail_json,'$.kind')='supervisor_decisions' AND json_extract(detail_json,'$.taskId')=?").get(spec.id);
  if (!found) return null;
  if (z.object({ suite_version: z.string() }).parse(found).suite_version !== VERSION) throw new MeritRouterError("supervisor_qualification_suite_stale", "supervisor_qualification_suite_stale: persisted internal evaluation belongs to a different suite; it cannot use the ordinary repository harness or consume a new model request");
  const row = RunRow.parse(found), d = RunSchema.parse(JSON.parse(row.detail_json));
  if (project !== QUALIFICATION_PROJECT || purpose !== "qualification" || spec.profile !== "inspect" || spec.id !== d.taskId
    || spec.idempotencyKey !== `supervisor-eval:${row.id}` || spec.routing?.endpointId !== d.endpoint || spec.repositoryAliases.length !== 1 || spec.repositoryAliases[0] !== d.alias
    || spec.goal !== `Internal supervisor decision suite ${VERSION}` || spec.budget?.maxModelRequests !== 1 || spec.budget.maxInputTokens !== SUPERVISOR_EVAL_INPUT_TOKENS || spec.budget.maxOutputTokens !== SUPERVISOR_EVAL_OUTPUT_TOKENS || spec.budget.maxPaidUsd !== d.maxPaidUsd
    || spec.writableRepository !== undefined || spec.constraints.checks?.length || spec.context.inlineText !== undefined || spec.context.artifactRefs?.length || spec.context.fileRefs?.length
    || row.endpoint_id !== d.endpoint || d.identity !== hash({ endpointId: d.endpoint, route: { kind: "direct", provider: d.provider, model: d.model }, suite: VERSION, variant: SUPERVISOR_VARIANT })) {
    throw new MeritRouterError("supervisor_qualification_binding_invalid", "Internal qualification binding does not authorize this task");
  }
  return { runId: row.id, detail: d, status: row.status };
}

/** A live owning-config view, used only after the persisted task binding is established. */
export function supervisorSandboxConfig(cfg: ResolvedConfig): ResolvedConfig {
  return new Proxy(cfg, { get(target, key) {
    if (key === "profiles") return { ...target.profiles, inspect: SUPERVISOR_EVAL_PROFILE };
    if (key === "paid") return { ...target.paid, tiers: { ...target.paid.tiers, T1: "on_free_exhaustion" } };
    return Reflect.get(target, key);
  } });
}

/** Fresh request and pretransport proof; no production task can borrow this Gate fork. */
export function assertSupervisorSandboxRequest(db: Db, task: StoredTask, req: GateRequest): void {
  const current = db.prepare("SELECT spec_json,project_id,purpose,lease_owner,run_count,lease_incarnation,state FROM tasks WHERE id=?").get(task.row.id) as { spec_json: string; project_id: string; purpose: string; lease_owner: string; run_count: number; lease_incarnation: string; state: string } | undefined;
  const binding = current && supervisorSandboxBinding(db, JSON.parse(current.spec_json), current.project_id, current.purpose);
  const p = req.participants[0];
  if (!binding || !["preparing", "running"].includes(binding.status) || binding.detail.deadline <= Date.now() || current!.state !== "running"
    || current!.run_count !== task.row.run_count || current!.lease_incarnation !== task.row.lease_incarnation || current!.lease_owner !== task.row.lease_owner
    || req.purpose !== "supervisor_qualification" || req.plan.profile !== "inspect" || req.participants.length !== 1 || p?.taskId !== task.row.id
    || p.lease.runCount !== task.row.run_count || p.lease.incarnation !== task.row.lease_incarnation || p.lease.owner !== task.row.lease_owner || p.lease.project !== QUALIFICATION_PROJECT
    || p.budget.maxModelRequests > 1 || (p.budget.maxPaidUsd ?? Infinity) > binding.detail.maxPaidUsd || req.chat.max_tokens > SUPERVISOR_EVAL_OUTPUT_TOKENS
    || req.chat.tools?.length !== 1 || canonicalJson(req.chat.tools[0]) !== canonicalJson(SUPERVISOR_DECISION_TOOL)
    || req.plan.candidates.length !== 1 || req.plan.candidates[0]!.id !== binding.detail.endpoint || req.plan.candidates[0]!.route.provider !== binding.detail.provider || req.plan.candidates[0]!.route.model !== binding.detail.model) {
    throw new MeritRouterError("supervisor_qualification_binding_invalid", "Captured qualification task/run/lease does not authorize this request");
  }
}

/** Remaining finite allocation across every qualification family, including pre-task holds. */
export function qualificationRequestsHeld(db: Db, dailyLimit: number): number {
  let held = 0;
  const tasks = db.prepare("SELECT id,spec_json,state FROM tasks WHERE purpose='qualification'").all() as { id: string; spec_json: string; state: string }[];
  for (const task of tasks) {
    if (isTerminal(task.state as Parameters<typeof isTerminal>[0])) continue;
    const spec = WorkerTaskSchema.parse(JSON.parse(task.spec_json));
    const used = (db.prepare("SELECT COUNT(DISTINCT request_id) n FROM request_charges WHERE task_id=?").get(task.id) as { n: number }).n;
    held += Math.max(0, (spec.budget?.maxModelRequests ?? dailyLimit) - used);
  }
  for (const raw of db.prepare("SELECT detail_json FROM qualification_runs WHERE status='preparing'").all() as { detail_json: string }[]) {
    const detail = JSON.parse(raw.detail_json) as unknown;
    const supervisor = RunSchema.safeParse(detail);
    if (supervisor.success) { if (!tasks.some(task => task.id === supervisor.data.taskId)) held++; }
    else { const generic = z.object({ projectedRequests: z.number().int().nonnegative() }).passthrough().safeParse(detail); if (generic.success) held += generic.data.projectedRequests; }
  }
  return held;
}

export class SupervisorQualificationPending extends MeritRouterError {
  constructor(readonly project: string, readonly submissionRef: string, readonly runIds: string[]) {
    super("supervisor_qualification_pending", `Supervisor task has not been submitted. Qualification is pending for runs ${runIds.join(", ")}. Original goal/context/idempotency and limits are retained in ${submissionRef} in project ${project}. Retry the identical submission, call MCP resume_supervisor_submission with submissionRef and project, or use SDK resumeSupervisorSubmission(submissionRef, project); start a MeritRouter worker if none is running. No unqualified model may supervise the project.`);
  }
}

/** Validated aggregate reads only. No user goal, model output or private-store access. */
function aggregateEvidence(db: Db): SupervisorRankingEvidence[] {
  return (db.prepare("SELECT value FROM meta WHERE key LIKE 'supervisor-evidence:%'").all() as { value: string }[]).flatMap(row => {
    try { const v = Aggregate.parse(JSON.parse(row.value)); return v.evidence.source_url === `meritrouter:qualification:${v.runId}` ? [v.evidence] : []; } catch { return []; }
  });
}

/** Durable, bounded service-owned qualification; all inference remains a normal accounted task. */
export class SupervisorQualifier {
  private sweeping = false;
  private readonly resumedDefaults = new WeakMap<object, number>();
  private closing = false;
  private readonly pending = new Set<Promise<unknown>>();
  constructor(private readonly sy: MeritRouter) {}

  bind(policy: SupervisorQualityRouting): void { bindSupervisorEvidence(policy, () => aggregateEvidence(this.sy.db)); }
  retainedPaidDefault(raw: unknown): number | undefined { return raw && typeof raw === "object" ? this.resumedDefaults.get(raw) : undefined; }
  private track<T>(work: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new MeritRouterError("qualification_closed", "Qualification service is draining"));
    const promise = work();
    this.pending.add(promise);
    void promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise));
    return promise;
  }
  async close(): Promise<void> { this.closing = true; while (this.pending.size) await Promise.allSettled([...this.pending]); }

  private store() { return this.sy.projectStores(QUALIFICATION_PROJECT); }

  private fundingHolds(funding: string): { requests: number; paid: number } {
    const rows = this.store().db.prepare("SELECT detail_json FROM qualification_runs WHERE json_valid(detail_json) AND json_extract(detail_json,'$.kind')='supervisor_decisions' AND json_extract(detail_json,'$.funding')=?").all(funding) as { detail_json: string }[];
    const paid = rows.reduce((sum, row) => sum + z.object({ maxPaidUsd: z.number().finite().min(0).max(1) }).passthrough().parse(JSON.parse(row.detail_json)).maxPaidUsd, 0);
    return { requests: rows.length, paid };
  }

  /** Read-only actual key/model-plan/quota checks; this does not reserve quota or imply quality. */
  private callable(ep: ModelEndpoint | undefined): boolean {
    if (!ep || ep.status !== "active" || !ep.enabled || !ep.available || ep.route.kind !== "direct" || ep.supportsTools !== true
      || (ep.contextLimitTokens ?? 0) < SUPERVISOR_EVAL_CONTEXT_TOKENS || (ep.outputLimitTokens ?? 0) < SUPERVISOR_EVAL_OUTPUT_TOKENS || this.sy.gate.excluded(ep)
      || this.sy.health.breakers.blockedUntil(ep.providerId) !== null) return false;
    const provider = this.sy.providers.provider(ep.route.provider);
    if (!provider?.enabled) return false;
    const credentials = this.sy.providers.credentials().list(ep.route.provider);
    return credentials.some(credential => {
      if (credential.unusableReason || (isPaid(ep) ? credential.billingClass === "free_tier" : freeKeyOnly(ep) && credential.billingClass !== "free_tier")) return false;
      return this.sy.providers.keys.availability(provider, credential, this.sy.providers.keys.get(credential.ref), {
        model: ep.route.model, modelLimits: ep.rateLimits ?? null, estimatedTokens: SUPERVISOR_EVAL_CONTEXT_TOKENS, siblings: credentials, limits: this.sy.providers.limits,
        freeQuota: provider.keyInfoShape === "openrouter_key" && /:free$/.test(ep.route.model),
      }).available;
    });
  }

  private capable(endpointId: string, cfg: ResolvedConfig, specs: WorkerTask[]): boolean {
    const ep = this.sy.catalog.get(endpointId);
    if (!this.callable(ep) || !ep || !assessSupervisorQuality(ep.id, cfg.supervisor.routing, new Date(), false, ep.route).eligible) return false;
    return specs.some(spec => cfg.profiles[spec.profile]?.mode === "supervisor"
      && this.sy.router.plan(spec.profile, "T3", ["text"], spec.routing?.endpointId, false, cfg.supervisor.paid_policy, [], spec.hints?.web, cfg).candidates.some(candidate => candidate.id === ep.id));
  }

  private failInfrastructure(row: { id: string; endpoint_id: string; detail: RunDetail }, reason: string): void {
    const store = this.store(), task = store.tasks.get(row.detail.taskId);
    immediate(store.db, () => {
      if (!store.db.prepare("UPDATE qualification_runs SET status='failed',finished_at=? WHERE id=? AND status IN ('preparing','running')").run(Date.now(), row.id).changes) return;
      store.db.prepare("INSERT INTO qualification_results(run_id,endpoint_id,eval_id,family,tier,trial,outcome,task_id,detail_json,created_at) VALUES(?,?,?,'supervisor','T3',1,'infra_error',?,?,?)").run(row.id, row.endpoint_id, SUPERVISOR_SUITE_VERSION, task?.row.id ?? null, JSON.stringify({ detail: reason.slice(0, 2000), artifactRefs: task?.result?.artifactRefs ?? [] }), Date.now());
      store.db.prepare("UPDATE qualification_tasks SET evaluated=1 WHERE run_id=?").run(row.id);
    });
  }

  private quarantineHistorical(raw: unknown, rowId: number): void {
    const store = this.store();
    const identity = z.object({ id: z.string(), endpoint_id: z.string(), suite_version: z.string() }).passthrough().safeParse(raw);
    const diagnostic = { detail: "Malformed historical supervisor qualification record quarantined; original detail bytes retained. No task identity/cancellation or model score was inferred." };
    immediate(store.db, () => {
      if (!store.db.prepare("UPDATE qualification_runs SET status='failed',finished_at=? WHERE rowid=? AND status IN ('preparing','running')").run(Date.now(), rowId).changes) return;
      if (identity.success) {
        const row = identity.data;
        store.db.prepare("INSERT INTO qualification_results(run_id,endpoint_id,eval_id,family,tier,trial,outcome,task_id,detail_json,created_at) VALUES(?,?,?,'supervisor','T3',1,'infra_error',NULL,?,?)")
          .run(row.id, row.endpoint_id, row.suite_version, JSON.stringify(diagnostic), Date.now());
      } else {
        store.artifacts.writeJson({ kind: "qualification_history_diagnostic", label: "Malformed historical qualification identity", value: { historicalRowId: rowId, ...diagnostic } });
      }
    });
  }

  /** Explicit retry of infrastructure failure: preserves all previous request/credit accounting. */
  async retryFailed(endpointId: string, maxPaidUsd = 0): Promise<{ runId: string; fresh: boolean }> {
    const store = this.store();
    for (const row of this.runs().filter(run => run.endpoint_id === endpointId && run.status === "failed")) {
      const updated = { ...row.detail, expiresAt: Date.now() };
      store.db.prepare("UPDATE qualification_runs SET detail_json=? WHERE id=? AND status='failed' AND detail_json=?").run(JSON.stringify(updated), row.id, row.detail_json);
    }
    return this.start(endpointId, maxPaidUsd);
  }

  private runs() {
    return this.store().db.prepare("SELECT id,endpoint_id,suite_version,status,detail_json FROM qualification_runs WHERE suite_version=? ORDER BY started_at DESC").all(VERSION)
      .flatMap(raw => { try { const row = RunRow.parse(raw), detail = RunSchema.parse(JSON.parse(row.detail_json)); return [{ ...row, detail }]; } catch { return []; } });
  }

  /** One durable run per exact route/suite/variant until expiry, including failures. */
  start(endpointId: string, maxPaidUsd = 0, funding = "direct", envelope?: FundingEnvelope): Promise<{ runId: string; fresh: boolean }> {
    const bound = envelope === undefined ? undefined : z.object({ requests: z.number().int().positive(), paidUsd: z.number().finite().nonnegative() }).strict().parse(envelope);
    return this.track(() => this.startRun(endpointId, maxPaidUsd, funding, bound));
  }
  private async startRun(endpointId: string, maxPaidUsd: number, funding: string, envelope?: FundingEnvelope): Promise<{ runId: string; fresh: boolean }> {
    const ep = this.sy.catalog.get(endpointId);
    if (!ep || ep.status !== "active" || !ep.enabled || !ep.available || ep.route.kind !== "direct" || ep.supportsTools !== true
      || !ep.inputModalities.includes("text") || (ep.contextLimitTokens ?? 0) < SUPERVISOR_EVAL_CONTEXT_TOKENS || (ep.outputLimitTokens ?? 0) < SUPERVISOR_EVAL_OUTPUT_TOKENS) {
      throw new MeritRouterError("supervisor_qualification_metadata_unavailable", `${endpointId}: qualification requires active exact direct route, known tool support and at least ${SUPERVISOR_EVAL_CONTEXT_TOKENS} context/${SUPERVISOR_EVAL_OUTPUT_TOKENS} output tokens. Refresh metadata or verify these prerequisites; listing alone is not callable access.`);
    }
    if (isPaid(ep) && (!this.sy.cfg.paid.enabled || maxPaidUsd <= 0)) throw new MeritRouterError("supervisor_qualification_budget_unavailable", "Paid qualification requires an explicit positive caller budget and enabled paid routing.");
    if (!this.callable(ep)) throw new MeritRouterError("supervisor_qualification_access_unavailable", `supervisor_qualification_access_unavailable: ${endpointId}: ${this.sy.gate.excluded(ep) ?? "no currently usable key satisfies authentication, quota, model-plan, limits or circuit availability"}. Metadata listing does not establish account entitlement; existing model-plan refusals expire under the normal provider recheck policy.`);
    const store = this.store(), now = Date.now();
    const identity = hash({ endpointId, route: ep.route, suite: VERSION, variant: SUPERVISOR_VARIANT });
    const selected = immediate(store.db, () => {
      const old = this.runs().find(run => run.detail.identity === identity && run.detail.expiresAt > now);
      if (old) return { row: old, fresh: false };
      const prior = this.fundingHolds(funding);
      if (envelope && (prior.requests + 1 >= envelope.requests || prior.paid + Math.min(1, maxPaidUsd) > envelope.paidUsd))
        throw new MeritRouterError("supervisor_qualification_budget_unavailable", "Qualification (including prior suite versions) must leave execution room inside the original caller request/paid envelope; previous usage and holds are retained.");
      const used = this.sy.qualifier.requestsUsedToday();
      const held = qualificationRequestsHeld(store.db, this.sy.cfg.qualification.max_requests_per_day);
      if (used + held >= this.sy.cfg.qualification.max_requests_per_day) throw new MeritRouterError("supervisor_qualification_budget_unavailable", "The daily qualification request allocation is used or reserved by durable pending runs.");
      const id = newId("q"), taskId = newId("t"), alias = `qs-${id.slice(-12)}`;
      const detail = RunSchema.parse({ kind: "supervisor_decisions", version: VERSION, variant: SUPERVISOR_VARIANT, identity, endpoint: endpointId,
        provider: ep.route.provider, model: ep.route.model, taskId, alias,
        fixture: path.join(this.sy.layout === "split" ? path.dirname(store.artifacts.root) : path.join(this.sy.cfg.storageDir, "qualification"), "supervisor-fixtures", id),
        deadline: now + MAX_RUN_MS, expiresAt: now + RETAIN_MS, maxPaidUsd: Math.min(1, maxPaidUsd), funding, owner: this.sy.owner, preparingUntil: now + 30_000 });
      const row = { id, endpoint_id: endpointId, suite_version: VERSION, status: "preparing" as const, detail_json: JSON.stringify(detail), detail };
      store.db.prepare("INSERT INTO qualification_runs(id,endpoint_id,suite_version,status,started_at,detail_json) VALUES(?,?,?,'preparing',?,?)").run(id, endpointId, VERSION, now, row.detail_json);
      return { row, fresh: true };
    });
    const { row } = selected;
    if (row.status === "preparing") {
      if (!selected.fresh && row.detail.preparingUntil > now) return { runId: row.id, fresh: false };
      const claim = { ...row.detail, owner: this.sy.owner, preparingUntil: now + 30_000 };
      if (store.db.prepare("UPDATE qualification_runs SET detail_json=? WHERE id=? AND status='preparing' AND detail_json=?").run(JSON.stringify(claim), row.id, row.detail_json).changes) {
        try {
          mkdirSync(claim.fixture, { recursive: true });
          writeFileSync(path.join(claim.fixture, "README.md"), "Internal supervisor decision fixture. No user source or memory.\n");
          await initRepo(claim.fixture);
          if (!store.db.prepare("SELECT 1 FROM repository_registry WHERE alias=?").get(claim.alias)) registerRepository(store.db, this.sy.projects.qualification, { alias: claim.alias, path: claim.fixture, writable: false, origin: `qualification:${row.id}` });
          const [submitted] = await this.sy.submitTasks([{
            id: claim.taskId, idempotencyKey: `supervisor-eval:${row.id}`, profile: "inspect", goal: `Internal supervisor decision suite ${VERSION}`,
            repositoryAliases: [claim.alias], context: {}, hints: { difficulty: "T1", web: false }, routing: { endpointId },
            constraints: { acceptanceCriteria: ["service-owned observed supervisor decisions recorded"] },
            budget: { maxModelRequests: 1, maxInputTokens: SUPERVISOR_EVAL_INPUT_TOKENS, maxOutputTokens: SUPERVISOR_EVAL_OUTPUT_TOKENS, maxPaidUsd: claim.maxPaidUsd, timeoutSeconds: 120 },
          }], { purpose: "qualification" });
          if (!submitted || submitted.taskId !== claim.taskId) throw new Error("Qualification task binding changed");
          immediate(store.db, () => {
            store.db.prepare("INSERT OR IGNORE INTO qualification_tasks(task_id,run_id,eval_id,trial,endpoint_id,fixture_path) VALUES(?,?,?,1,?,?)").run(claim.taskId, row.id, SUPERVISOR_SUITE_VERSION, endpointId, claim.fixture);
            store.db.prepare("UPDATE qualification_runs SET status='running' WHERE id=? AND status='preparing'").run(row.id);
          });
        } catch (err) {
          // A persisted task remains authoritative after a crash or submission acknowledgement loss.
          if (store.tasks.get(claim.taskId)) immediate(store.db, () => {
            store.db.prepare("INSERT OR IGNORE INTO qualification_tasks(task_id,run_id,eval_id,trial,endpoint_id,fixture_path) VALUES(?,?,?,1,?,?)").run(claim.taskId, row.id, SUPERVISOR_SUITE_VERSION, endpointId, claim.fixture);
            store.db.prepare("UPDATE qualification_runs SET status='running' WHERE id=?").run(row.id);
          });
          else { this.failInfrastructure(row, `Qualification preparation failed: ${(err as Error).message}`); throw err; }
        }
      }
    }
    return { runId: row.id, fresh: selected.fresh };
  }

  gradePending(): Promise<number> { return this.track(() => this.gradeRuns()); }
  private async gradeRuns(): Promise<number> {
    if (this.sweeping) return 0;
    this.sweeping = true;
    let n = 0;
    try {
      const store = this.store();
      // Persisted old-suite tasks remain internal data, never ordinary read-only work.
      for (const raw of store.db.prepare("SELECT rowid AS history_rowid,id,endpoint_id,suite_version,status,detail_json FROM qualification_runs WHERE suite_version LIKE 'supervisor-decisions-%' AND suite_version!=? AND status IN ('preparing','running')").all(VERSION)) {
        const { history_rowid: rowId, ...candidate } = z.object({ history_rowid: z.number().int() }).passthrough().parse(raw);
        let row: z.infer<typeof RunRow>, detail: { kind: "supervisor_decisions"; taskId: string };
        try {
          row = RunRow.parse(candidate);
          detail = z.object({ kind: z.literal("supervisor_decisions"), taskId: z.string() }).passthrough().parse(JSON.parse(row.detail_json));
        } catch {
          this.quarantineHistorical(candidate, rowId);
          continue;
        }
        let task = store.tasks.get(detail.taskId);
        if (task && (task.row.project_id !== QUALIFICATION_PROJECT || (task.row as typeof task.row & { purpose?: string }).purpose !== "qualification")) continue;
        if (task && !isTerminal(task.row.state)) { this.sy.cancelTasks([task.row.id], QUALIFICATION_PROJECT); task = store.tasks.get(detail.taskId); }
        if (task && !isTerminal(task.row.state)) continue;
        immediate(store.db, () => {
          if (!store.db.prepare("UPDATE qualification_runs SET status='failed',finished_at=? WHERE id=? AND status IN ('preparing','running')").run(Date.now(), row.id).changes) return;
          store.db.prepare("INSERT INTO qualification_results(run_id,endpoint_id,eval_id,family,tier,trial,outcome,task_id,detail_json,created_at) VALUES(?,?,?,'supervisor','T3',1,'infra_error',?,?,?)")
            .run(row.id, row.endpoint_id, row.suite_version, task?.row.id ?? null, JSON.stringify({ detail: "supervisor_qualification_suite_stale: superseded internal evaluation retired without a new model request or reusable score", artifactRefs: task?.result?.artifactRefs ?? [] }), Date.now());
          store.db.prepare("UPDATE qualification_tasks SET evaluated=1 WHERE run_id=?").run(row.id);
        });
      }
      for (const row of this.runs()) {
        if (row.status === "finished" || row.status === "failed") continue;
        const task = store.tasks.get(row.detail.taskId);
        if (!task && row.status === "preparing" && row.detail.preparingUntil <= Date.now()) {
          try {
            if (row.detail.deadline <= Date.now()) this.failInfrastructure(row, "Qualification preparation deadline expired; no model decision observed");
            else await this.start(row.endpoint_id, row.detail.maxPaidUsd, row.detail.funding);
          } catch (error) { this.failInfrastructure(row, `Qualification restart prerequisites unavailable: ${(error as Error).message}`); }
          continue;
        }
        if ((!task || !isTerminal(task.row.state)) && Date.now() < row.detail.deadline) continue;
        if (task && !isTerminal(task.row.state)) { this.sy.cancelTasks([task.row.id], QUALIFICATION_PROJECT); continue; }
        if (!task || task.result?.executionStatus !== "completed") {
          this.failInfrastructure(row, task?.result?.stopReason ?? "deadline expired without a completed qualification task; no quality score published");
          continue;
        }
        const observed = task?.result?.data;
        const grade = gradeSupervisorDecisions(task?.result?.executionStatus === "completed" ? observed : null);
        const checkedAt = Date.now();
        const evidence = SupervisorRankingEvidenceSchema.parse({ endpoint_id: row.endpoint_id, provider: row.detail.provider, model: row.detail.model,
          source_model_id: row.detail.model, mapping_source: `Gate-pinned exact endpoint/route; ${SUPERVISOR_VARIANT}; ${grade.coverage}/6 scenario groups, one trial; limited role evidence, not general frontier or visual capability`,
          source: SUPERVISOR_SUITE_SOURCE, source_url: `meritrouter:qualification:${row.id}`, suite_version: VERSION,
          metric_scale: "observed decision points 0..100; provider_default", checked_at: new Date(checkedAt).toISOString(), expires_at: new Date(row.detail.expiresAt).toISOString(), metrics: grade.metrics });
        immediate(store.db, () => {
          if (!store.db.prepare("UPDATE qualification_runs SET status='finished',finished_at=? WHERE id=? AND status IN ('preparing','running')").run(checkedAt, row.id).changes) return;
          store.db.prepare("INSERT INTO qualification_results(run_id,endpoint_id,eval_id,family,tier,trial,outcome,task_id,detail_json,created_at) VALUES(?,?,?,'supervisor','T3',1,?,?,?,?)").run(row.id, row.endpoint_id, SUPERVISOR_SUITE_VERSION, grade.metrics.role_points! >= 60 && Object.entries(grade.metrics).every(([k,v]) => k === "role_points" || v === 1) ? "pass" : "fail", task?.row.id ?? null, JSON.stringify({ ...grade, artifactRefs: task?.result?.artifactRefs ?? [], stopReason: task?.result?.stopReason ?? "qualification deadline expired before a task completed" }), checkedAt);
          store.db.prepare("UPDATE qualification_tasks SET evaluated=1 WHERE run_id=?").run(row.id);
          n++;
        });
        // Safe after an interrupted cross-store publication: aggregate can be reconstructed below.
        this.publish(row.id, evidence);
      }
      // Reconcile publication if a process died between private grading and aggregate projection.
      for (const row of this.runs().filter(r => r.status === "finished")) {
        if (this.sy.db.prepare("SELECT 1 FROM meta WHERE key=?").get(`supervisor-evidence:${row.id}`)) continue;
        const task = store.tasks.get(row.detail.taskId);
        const grade = gradeSupervisorDecisions(task?.result?.executionStatus === "completed" ? task.result.data : null);
        const finished = store.db.prepare("SELECT finished_at FROM qualification_runs WHERE id=?").get(row.id) as { finished_at: number };
        this.publish(row.id, SupervisorRankingEvidenceSchema.parse({ endpoint_id: row.endpoint_id, provider: row.detail.provider, model: row.detail.model, source_model_id: row.detail.model,
          mapping_source: `Gate-pinned exact route; ${SUPERVISOR_VARIANT}; ${grade.coverage}/6 groups, one trial, limited role evidence`, source: SUPERVISOR_SUITE_SOURCE, source_url: `meritrouter:qualification:${row.id}`, suite_version: VERSION,
          metric_scale: "observed decision points 0..100; provider_default", checked_at: new Date(finished.finished_at).toISOString(), expires_at: new Date(row.detail.expiresAt).toISOString(), metrics: grade.metrics }));
      }
    } finally { this.sweeping = false; }
    return n;
  }

  private publish(runId: string, evidence: SupervisorRankingEvidence): void {
    this.sy.db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING").run(`supervisor-evidence:${runId}`, JSON.stringify(Aggregate.parse({ runId, evidence })));
  }

  /** Retain the entire original submission privately before starting any paid/quota-consuming work. */
  preflight(specs: WorkerTask[], project: string, opts: { purpose?: string; parentSessionId?: string }, inputSpecs = specs): Promise<WorkerTask[]> {
    return this.track(() => this.preflightRuns(specs, project, opts, inputSpecs));
  }
  private async preflightRuns(specs: WorkerTask[], project: string, opts: { purpose?: string; parentSessionId?: string }, inputSpecs: WorkerTask[]): Promise<WorkerTask[]> {
    const cfg = this.sy.projectContext(project);
    this.bind(cfg.supervisor.routing);
    if (cfg.supervisor.routing.minimum_quality !== "ranked_capable" || cfg.supervisor.routing.ranking_policy) return specs;
    const supervisors = specs.filter(s => cfg.profiles[s.profile]?.mode === "supervisor");
    if (!supervisors.length) return specs;
    const envelope = { requests: Math.min(...supervisors.map(spec => spec.budget?.maxModelRequests ?? cfg.profiles[spec.profile]?.max_model_requests ?? 32)), paidUsd: Math.min(...supervisors.map(spec => spec.budget?.maxPaidUsd ?? 0)) };
    const digest = hash({ specs, project, opts }), key = `supervisor-submission:${project}:${digest}`;
    const existing = this.sy.db.prepare("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | undefined;
    const projectStore = this.sy.projectStores(project);
    let intent = existing ? Intent.parse(JSON.parse(existing.value)) : undefined;
    if (!intent) {
      const endpoints = this.sy.catalog.endpoints().filter(ep => ep.status === "active" && ep.enabled && ep.available && ep.route.kind === "direct" && ep.supportsTools === true
        && ep.inputModalities.includes("text") && (ep.contextLimitTokens ?? 0) >= SUPERVISOR_EVAL_CONTEXT_TOKENS && (ep.outputLimitTokens ?? 0) >= SUPERVISOR_EVAL_OUTPUT_TOKENS
        && (!cfg.supervisor.endpoints.length || cfg.supervisor.endpoints.includes(ep.id))
        && supervisors.some(s => !s.routing?.endpointId || s.routing.endpointId === ep.id)
        && (!isPaid(ep) || cfg.paid.enabled && cfg.supervisor.paid_policy !== "never" && supervisors.every(s => (s.budget?.maxPaidUsd ?? 0) > 0)));
      // Qualification must fit the original caller envelope; it never resets or increases it.
      const available = Math.min(...supervisors.map(s => s.budget?.maxModelRequests ?? cfg.profiles[s.profile]?.max_model_requests ?? 32));
      const current = this.runs();
      const needs = endpoints.filter(ep => !current.some(run => run.detail.identity === hash({ endpointId: ep.id, route: ep.route, suite: VERSION, variant: SUPERVISOR_VARIANT }) && run.detail.expiresAt > Date.now()));
      if (needs.length >= available) throw new MeritRouterError("supervisor_qualification_budget_unavailable", `Testing ${needs.length} unobserved candidates needs ${needs.length} requests plus supervisor execution within the original ${available}-request envelope. Narrow endpoint selection or supply an adequate bounded request budget.`);
      const submissionRef = projectStore.artifacts.writeJson({ kind: "supervisor_submission", label: "Original supervisor submission awaiting qualification", value: SavedSubmission.parse({ project, digest, specs, inputSpecs, ...opts }) });
      // Insert the private-reference intent before scheduling. Retry owns the same budget holds.
      const paidCandidates = endpoints.filter(isPaid).length;
      const perPaidRun = paidCandidates ? Math.min(1, Math.min(...supervisors.map(s => s.budget?.maxPaidUsd ?? 0)) / (paidCandidates + 1)) : 0;
      intent = { project, digest, submissionRef, endpoints: endpoints.map(ep => ({ id: ep.id, paidBudget: isPaid(ep) ? perPaidRun : 0 })), runs: [], unavailable: [], requestHold: 0, paidHold: 0 };
      immediate(this.sy.db, () => {
        this.sy.db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING").run(key, JSON.stringify(intent));
        intent = Intent.parse(JSON.parse((this.sy.db.prepare("SELECT value FROM meta WHERE key=?").get(key) as { value: string }).value));
      });
    }
      const currentRuns: string[] = [];
      this.sy.reloadIfChanged();
      intent.unavailable = [];
      const free = intent.endpoints.filter(endpoint => { const ep = this.sy.catalog.get(endpoint.id); return ep ? !isPaid(ep) : endpoint.paidBudget === 0; });
      const paid = intent.endpoints.filter(endpoint => { const ep = this.sy.catalog.get(endpoint.id); return ep ? isPaid(ep) : endpoint.paidBudget > 0; });
      const available = (endpointId: string) => {
        if (this.callable(this.sy.catalog.get(endpointId))) return true;
        intent!.unavailable.push({ endpointId, checkedAt: Date.now(), reason: "route disabled/removed or no current key satisfies model-plan, authentication, quota, limits and availability" });
        return false;
      };
      for (const ep of free) {
        if (!available(ep.id)) continue;
        const started = await this.start(ep.id, ep.paidBudget, key, envelope);
        currentRuns.push(started.runId);
      }
      await this.gradePending();
      const freePending = this.runs().some(run => currentRuns.includes(run.id) && ["preparing", "running"].includes(run.status));
      const freeCapable = free.some(endpoint => this.capable(endpoint.id, cfg, supervisors));
      // Paid evaluations are themselves spend: wait for free results and use credits only
      // when no free candidate demonstrates the required role capabilities.
      const paidAuthorized = cfg.paid.enabled && cfg.supervisor.paid_policy !== "never" && supervisors.every(spec => (spec.budget?.maxPaidUsd ?? 0) > 0);
      if (!freePending && !freeCapable && paidAuthorized) for (const ep of paid) {
        if (!available(ep.id)) continue;
        const remainingPaid = Math.max(0, envelope.paidUsd - this.fundingHolds(key).paid);
        const started = await this.start(ep.id, Math.min(ep.paidBudget, remainingPaid / 2), key, envelope);
        currentRuns.push(started.runId);
      }
    intent.runs = currentRuns;
    const funded = this.fundingHolds(key);
    intent.requestHold = funded.requests;
    intent.paidHold = funded.paid;
    this.sy.db.prepare("UPDATE meta SET value=? WHERE key=?").run(JSON.stringify(intent), key);
    await this.gradePending();
    let pending = this.runs().filter(run => intent!.runs.includes(run.id) && ["preparing", "running"].includes(run.status));
    if (pending.length) {
      await this.sy.awaitResults(pending.map(run => run.detail.taskId), { project: QUALIFICATION_PROJECT, timeoutSeconds: 3 });
      await this.gradePending();
      pending = this.runs().filter(run => intent!.runs.includes(run.id) && ["preparing", "running"].includes(run.status));
    }
    if (pending.length) throw new SupervisorQualificationPending(project, intent.submissionRef, pending.map(r => r.id));
    if (paidAuthorized && paid.some(endpoint => this.callable(this.sy.catalog.get(endpoint.id))) && !intent.runs.some(id => this.runs().some(run => run.id === id && paid.some(endpoint => endpoint.id === run.endpoint_id)))
      && !free.some(endpoint => this.capable(endpoint.id, cfg, supervisors))) {
      return this.preflight(specs, project, opts, inputSpecs);
    }
    const failed = this.runs().filter(run => intent!.runs.includes(run.id) && run.status === "failed");
    const capable = intent.endpoints.some(endpoint => this.capable(endpoint.id, cfg, supervisors));
    if (failed.length && !capable) throw new MeritRouterError("supervisor_qualification_failed", `Qualification infrastructure did not complete for ${failed.map(run => `${run.endpoint_id} (${run.id})`).join(", ")}. No quality score was inferred. Inspect retained qualification results; after correcting the reported access/transport issue use supervisorQualifier.retryFailed(endpointId, explicitPaidBudget). Original submission remains ${intent.submissionRef}; previous usage and outstanding liabilities are retained.`);
    if (intent.unavailable.length && !capable) throw new MeritRouterError("supervisor_qualification_access_unavailable", `No currently callable qualified route remains. ${intent.unavailable.map(item => `${item.endpointId}: ${item.reason}`).join("; ")}. Original submission remains ${intent.submissionRef}; no unavailable route was graded as a failed model decision.`);
    return specs.map((spec, index) => cfg.profiles[spec.profile]?.mode !== "supervisor" ? spec : { ...spec,
      idempotencyKey: spec.idempotencyKey ?? `supervisor-submission:${digest}:${index}`, budget: { ...spec.budget,
      maxModelRequests: (spec.budget?.maxModelRequests ?? cfg.profiles[spec.profile]?.max_model_requests ?? 32) - intent!.requestHold,
      maxPaidUsd: Math.max(0, (spec.budget?.maxPaidUsd ?? 0) - intent!.paidHold) } });
  }

  async resume(submissionRef: string, project: string) {
    const artifact = this.sy.projectStores(project).artifacts.read(submissionRef);
    if (!artifact || artifact.row.kind !== "supervisor_submission" || createHash("sha256").update(artifact.content).digest("hex") !== artifact.row.sha256) throw new MeritRouterError("task_invalid", "Original supervisor submission is unavailable in the named project or failed its digest check");
    const saved = SavedSubmission.parse(JSON.parse(artifact.content.toString("utf8")));
    if (saved.project !== project || saved.digest !== hash({ specs: saved.specs, project, opts: { ...(saved.purpose ? { purpose: saved.purpose } : {}), ...(saved.parentSessionId ? { parentSessionId: saved.parentSessionId } : {}) } })) throw new MeritRouterError("task_invalid", "Original submission identity does not match");
    saved.inputSpecs.forEach((spec, index) => {
      const retained = saved.specs[index]?.budget?.maxPaidUsd;
      if (spec.budget?.maxPaidUsd === undefined && retained !== undefined) this.resumedDefaults.set(spec, retained);
    });
    return this.sy.submitTasks(saved.inputSpecs, { project, ...(saved.purpose ? { purpose: saved.purpose } : {}), ...(saved.parentSessionId ? { parentSessionId: saved.parentSessionId } : {}) });
  }
}

/** The ONLY sandbox entry: exact persisted internal run/profile/task/endpoint binding. */
export async function runSupervisorSandbox(ctx: RunContext): Promise<RunOutcome | null> {
  const stored = ctx.tasks.get(ctx.taskId);
  const bound = supervisorSandboxBinding(ctx.tasks.db, ctx.spec, stored?.row.project_id ?? ctx.taskProject ?? "", (stored?.row as { purpose?: string } | undefined)?.purpose);
  if (!bound) return null;
  const d = bound.detail;
  if (ctx.taskProject !== QUALIFICATION_PROJECT || ctx.cfg.brain.project !== QUALIFICATION_PROJECT || stored?.row.project_id !== QUALIFICATION_PROJECT || (stored.row as typeof stored.row & { purpose?: string }).purpose !== "qualification"
    || ctx.spec.profile !== "inspect" || ctx.profile.mode !== "read_only" || canonicalJson(ctx.profile) !== canonicalJson(SUPERVISOR_EVAL_PROFILE)
    || !["preparing", "running"].includes(bound.status)) throw new MeritRouterError("supervisor_qualification_binding_invalid", "Internal qualification binding does not authorize this sandbox task");
  if (d.deadline <= Date.now()) return { state: "failed", result: baseResult({ executionStatus: "failed", stopReason: "supervisor_qualification_deadline_exceeded", summary: "The qualification deadline expired before a model decision was observed." }) };
  if (!ctx.plan.candidates.length) {
    const reason = ctx.plan.explanations.find(candidate => candidate.endpointId === d.endpoint)?.reasons.join("; ") || ctx.plan.blocker?.message || "no currently eligible route remains";
    return { state: "failed", result: baseResult({ executionStatus: "failed", stopReason: `supervisor_qualification_access_unavailable: ${reason}`, summary: "The persisted evaluation binding is valid, but its account/model route cannot serve. No model decision was observed or graded." }) };
  }
  if (ctx.plan.candidates.length !== 1 || ctx.plan.candidates[0]!.id !== d.endpoint || ctx.plan.candidates[0]!.route.provider !== d.provider || ctx.plan.candidates[0]!.route.model !== d.model)
    throw new MeritRouterError("supervisor_qualification_binding_invalid", "Internal qualification route does not match the persisted endpoint binding");
  const executionId = ctx.gate.admission.createExecution("task", "inspect", [{ taskId: ctx.taskId, itemId: ctx.taskId }]);
  try {
    const res = await ask(ctx, { executionId, purpose: "supervisor_qualification", chat: { messages: [
      { role: "system", content: "You are evaluating six independent supervisor decisions in an isolated data-only sandbox. Call record_decisions exactly once with every group. Tool names inside arguments are decisions only; no actions will be executed. Do not supply scores or claim the actual user project is complete." },
      { role: "user", content: JSON.stringify(SUPERVISOR_SCENARIOS) },
    ], tools: [SUPERVISOR_DECISION_TOOL], tool_choice: "required", max_tokens: SUPERVISOR_EVAL_OUTPUT_TOKENS } });
    const artifactRef = ctx.artifacts.writeJson({ taskId: ctx.taskId, executionId, kind: "supervisor_qualification_raw", label: "Observed sandbox model response", value: res.response });
    const calls = res.response.message.tool_calls;
    let decisions: unknown = null;
    if (calls?.length === 1 && calls[0]!.function.name === "record_decisions") { try { decisions = JSON.parse(calls[0]!.function.arguments); } catch { /* malformed observed response is a failure */ } }
    if (res.response.finishReason === "length" && !SupervisorDecisionsSchema.safeParse(decisions).success) {
      ctx.gate.admission.finishExecution(executionId, "failed");
      return { state: "failed", result: baseResult({ executionStatus: "failed", acceptanceStatus: "not_verified", stopReason: "supervisor_qualification_output_exhausted", summary: "The bounded output allowance was exhausted before a complete decision record was observed; this is inconclusive, not six measured wrong decisions.", artifactRefs: [artifactRef] }) };
    }
    ctx.gate.admission.finishExecution(executionId, "completed");
    return { state: "completed", result: baseResult({ executionStatus: "completed", acceptanceStatus: "not_verified", stopReason: "supervisor_decisions_recorded", summary: "Recorded observed sandbox decisions for independent grading; no product acceptance.", data: decisions, artifactRefs: [artifactRef] }) };
  } catch (error) { ctx.gate.admission.finishExecution(executionId, "failed"); throw error; }
}
