import { createHash } from "node:crypto";
import { z } from "zod";
import { immediate, type Db } from "../storage/db.js";
import { LeaseRefSchema } from "../storage/lease-ref.js";
import { assertCriticalStoreDurability, readProjectStoreRegistration, readStoreIdentity } from "../projects/store-identity.js";
import { projectLimits } from "../projects/schema.js";
import type { ResolvedConfig } from "../config/load.js";
import { worstCaseUsd, type PaidSpend } from "../paid/spend.js";
import { physicalRequestCount } from "./accounting-usage.js";
import { accountingIdentityDigest, accountingOwnerDigest, GlobalEndpointAuthoritySchema, GlobalReceiptSchema,
  GlobalRequestReferenceSchema, ReserveGlobalRequestSchema, SettleGlobalRequestSchema, globalReservationFingerprint,
  type GlobalEndpointAuthority, type GlobalReceipt, type GlobalRequestReference, type RequestAccountingBroker,
  type ReserveGlobalRequest, type SettleGlobalRequest } from "./accounting-broker.js";

const DAY = 86_400_000;
const rowSchema = z.object({
  id: z.string(), installation_uuid: z.string(), project_uuid: z.string(), store_uuid: z.string(), generation: z.number().int(),
  fingerprint: z.string(), accounting_json: z.string().max(131072), endpoint_id: z.string(), provider: z.string(), key_ref: z.string().nullable(),
  provider_reservation_id: z.string().nullable(), paid: z.union([z.literal(0),z.literal(1)]), slot_id: z.string().nullable(), slot_nonce: z.string().nullable(),
  status: z.enum(["reserved", "dispatch_intent", "settled", "retired"]), reserved_at: z.number().int().nonnegative(),
  dispatch_id: z.string().nullable(), outcome_digest: z.string().nullable(), accounting_outcome_sha256: z.string().nullable(),
  outcome: z.enum(["succeeded", "failed", "uncertain"]).nullable(), input_tokens: z.number().int().nonnegative().nullable(),
  unexpected_liability_usd: z.number().finite().positive().nullable(), cost_quarantined: z.union([z.literal(0),z.literal(1)]),
  quarantine_outcome_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(), quarantine_conflict: z.union([z.literal(0),z.literal(1)]),
  output_tokens: z.number().int().nonnegative().nullable(), error_code: z.string().nullable(), finished_at: z.number().int().nonnegative().nullable(),
}).strict().refine(row => row.status === "reserved" ? row.dispatch_id === null && row.outcome_digest === null && row.outcome === null && row.finished_at === null
  : row.status === "dispatch_intent" ? row.dispatch_id !== null && row.outcome_digest === null && row.outcome === null && row.finished_at === null
  : row.status === "settled" ? row.dispatch_id !== null && row.outcome_digest !== null && row.accounting_outcome_sha256 !== null && row.outcome !== null && row.finished_at !== null
  : row.dispatch_id === null && row.outcome_digest === null && row.outcome === null && row.finished_at !== null, "Physical request state is incomplete")
  .refine(row => row.cost_quarantined === 0 ? row.unexpected_liability_usd === null && row.quarantine_outcome_sha256 === null && row.quarantine_conflict === 0
      && (row.status === "settled" || row.accounting_outcome_sha256 === null)
    : row.paid === 0 && row.status === "dispatch_intent" && row.unexpected_liability_usd !== null && row.quarantine_outcome_sha256 !== null
      && row.accounting_outcome_sha256 !== null, "Unexpected cost quarantine is incomplete");
type Row = z.infer<typeof rowSchema>;
export class GlobalAccountingDenied extends Error {
  constructor(readonly code: "authority" | "slot" | "quota" | "paid_budget" | "conflict" | "state" | "deadline" | "cost_quarantine") { super(`Global accounting refused: ${code}`); }
}
export class GlobalAccountingCostQuarantine extends GlobalAccountingDenied {
  readonly receipt: GlobalReceipt;
  constructor(receipt: GlobalReceipt) { super("cost_quarantine"); this.receipt = GlobalReceiptSchema.parse(receipt); }
}
export interface SqliteAccountingBrokerOptions {
  cfg: ResolvedConfig;
  spend: PaidSpend;
  /** Trusted host configuration/key lookup. No serialized request can supply this capability. */
  authorize(endpointId: string, keyRef: string | null): GlobalEndpointAuthority | null;
  now?: () => number;
}

/** Synchronous single-host coordinator. No method opens a project DB or calls a provider. */
export class SqliteRequestAccountingBroker implements RequestAccountingBroker {
  private readonly now: () => number;
  constructor(private readonly db: Db, private readonly options: SqliteAccountingBrokerOptions) {
    this.now = options.now ?? Date.now;
    this.coordination();
    if (typeof options.authorize !== "function" || !options.spend.usesDatabase(db)) throw new GlobalAccountingDenied("authority");
  }
  private coordination(): string {
    assertCriticalStoreDurability(this.db);
    const identity = readStoreIdentity(this.db);
    if (!identity || identity.role !== "coordination") throw new GlobalAccountingDenied("authority");
    return identity.installationId;
  }
  private mutation<T>(action: () => T): T {
    if (this.db.inTransaction) throw new GlobalAccountingDenied("state");
    this.coordination();
    return immediate(this.db, action);
  }
  private dispatchWindow(input: ReserveGlobalRequest): void {
    if (z.number().int().nonnegative().parse(this.now()) >= input.dispatchNotAfter) throw new GlobalAccountingDenied("deadline");
  }
  private row(id: string): Row | null {
    this.coordination();
    const value = this.db.prepare("SELECT * FROM physical_requests WHERE id=?").get(id);
    if (!value) return null;
    const row = rowSchema.parse(value), request = ReserveGlobalRequestSchema.parse(JSON.parse(row.accounting_json));
    if (globalReservationFingerprint(request) !== row.fingerprint || row.id !== request.requestId
      || row.installation_uuid !== this.coordination() || row.installation_uuid !== request.owner.installationId
      || row.project_uuid !== request.owner.projectId || row.store_uuid !== request.owner.storeId || row.generation !== request.owner.generation
      || row.endpoint_id !== request.endpointId || row.key_ref !== request.keyRef || row.provider_reservation_id !== request.providerReservationId
      || row.slot_id !== (request.slot?.id ?? null) || row.slot_nonce !== (request.slot?.nonce ?? null)) throw new GlobalAccountingDenied("conflict");
    return row;
  }
  private receipt(row: Row): GlobalReceipt {
    const spend = z.object({ key_ref: z.string(), provider: z.string(), endpoint_id: z.string(), reserved_usd: z.number().finite().nonnegative(), liability_usd: z.number().finite().nonnegative(), actual_usd: z.number().finite().nonnegative().nullable() }).strict().optional()
      .parse(this.db.prepare("SELECT key_ref,provider,endpoint_id,reserved_usd,liability_usd,actual_usd FROM broker_paid_spend WHERE request_id=?").get(row.id));
    if (!!spend !== (row.paid === 1) || (spend && (spend.liability_usd < spend.reserved_usd || spend.key_ref !== row.key_ref
      || spend.provider !== row.provider || spend.endpoint_id !== row.endpoint_id))) throw new GlobalAccountingDenied("conflict");
    return GlobalReceiptSchema.parse({ requestId: row.id,
      owner: { installationId: row.installation_uuid, projectId: row.project_uuid, storeId: row.store_uuid, generation: row.generation },
      fingerprint: row.fingerprint, state: row.status, admittedAt: row.reserved_at, dispatchId: row.dispatch_id,
      outcomeDigest: row.outcome_digest, outcome: row.outcome, inputTokens: row.input_tokens, outputTokens: row.output_tokens,
      reservedUsd: spend?.reserved_usd ?? null, liabilityUsd: spend?.liability_usd ?? row.unexpected_liability_usd,
      actualUsd: spend?.actual_usd ?? null, unexpectedLiabilityUsd: row.unexpected_liability_usd,
      quarantineOutcomeDigest: row.quarantine_outcome_sha256,
      costQuarantined: row.cost_quarantined === 1, quarantineConflict: row.quarantine_conflict === 1 });
  }
  private bound(reference: GlobalRequestReference): Row {
    const input = GlobalRequestReferenceSchema.parse(reference), row = this.row(input.requestId);
    if (!row || row.fingerprint !== input.fingerprint) throw new GlobalAccountingDenied("conflict");
    return row;
  }
  private registered(input: ReserveGlobalRequest): string {
    const registration = readProjectStoreRegistration(this.db, input.owner.projectId);
    if (input.owner.installationId !== this.coordination() || !registration || registration.state !== "registered"
      || registration.storeId !== input.owner.storeId || registration.generation !== input.owner.generation) throw new GlobalAccountingDenied("authority");
    return registration.slug;
  }
  private authority(input: ReserveGlobalRequest): GlobalEndpointAuthority {
    const authorized = this.options.authorize(input.endpointId, input.keyRef);
    if (!authorized) throw new GlobalAccountingDenied("authority");
    const authority = GlobalEndpointAuthoritySchema.parse(authorized);
    if (this.db.prepare("SELECT 1 FROM physical_requests WHERE cost_quarantined=1 AND (endpoint_id=? OR provider=? OR (key_ref=? AND key_ref IS NOT NULL)) LIMIT 1")
      .get(authority.endpointId, authority.provider, authority.keyRef)) throw new GlobalAccountingDenied("cost_quarantine");
    if (!authority.enabled || authority.endpointId !== input.endpointId || authority.keyRef !== input.keyRef
      || (authority.paid !== null && input.keyRef === null) || (input.keyRef !== null && authority.providerUsageScopes.length === 0)) throw new GlobalAccountingDenied("authority");
    if (authority.paid && !this.options.cfg.paid.enabled) throw new GlobalAccountingDenied("paid_budget");
    if (authority.paid && authority.paid.maxSearches > 0 && authority.paid.price.perSearch == null) throw new GlobalAccountingDenied("paid_budget");
    if (authority.providerUsageScopes.length) {
      if (!input.providerReservationId) throw new GlobalAccountingDenied("quota");
      const scopes = z.array(z.object({ scope: z.string(), at: z.number().int(), tokens: z.number().int() }).strict())
        .parse(this.db.prepare("SELECT scope,at,tokens FROM provider_usage WHERE reservation=?").all(input.providerReservationId));
      if (authority.providerUsageScopes.some(scope => !scopes.some(row => row.scope === scope && row.at > this.now() - DAY && row.at <= this.now()
        && row.tokens >= input.estimatedInputTokens + input.reservedOutputTokens))) throw new GlobalAccountingDenied("quota");
    } else if (input.providerReservationId !== null) throw new GlobalAccountingDenied("authority");
    return authority;
  }
  private slot(input: ReserveGlobalRequest, slug: string, authority: GlobalEndpointAuthority): void {
    if (!input.slot) {
      if (this.options.cfg.team.provider_concurrency_enabled) throw new GlobalAccountingDenied("slot");
      return;
    }
    const value = this.db.prepare("SELECT platform,kind,nonce,uncertain,lease_json,project_uuid,store_uuid,store_generation FROM provider_slots WHERE id=?").get(input.slot.id);
    const row = z.object({ platform: z.string(), kind: z.string(), nonce: z.string().nullable(), uncertain: z.number().int(), lease_json: z.string().max(65536).nullable(),
      project_uuid: z.string().nullable(), store_uuid: z.string().nullable(), store_generation: z.number().int().nullable() }).strict().optional().parse(value);
    if (!row || row.platform !== authority.platform || row.kind !== "request" || row.nonce !== input.slot.nonce || row.uncertain !== 0
      || row.project_uuid !== input.owner.projectId || row.store_uuid !== input.owner.storeId || row.store_generation !== input.owner.generation) throw new GlobalAccountingDenied("slot");
    const leases = z.array(LeaseRefSchema).max(128).parse(JSON.parse(row.lease_json ?? "[]"));
    if (leases.length !== input.participants.length || leases.some(lease => lease.project !== slug || !input.participants.some(part =>
      part.taskDigest === accountingIdentityDigest(input.owner.projectId, lease.taskId) && part.ownerDigest === accountingOwnerDigest(lease.owner)
      && part.incarnation === lease.incarnation && part.runCount === lease.runCount))) throw new GlobalAccountingDenied("slot");
  }
  private limits(input: ReserveGlobalRequest, slug: string, authority: GlobalEndpointAuthority, extraUsd: number, admitted: boolean): void {
    const now = this.now(), limits = projectLimits(this.options.cfg, slug);
    for (const [window, cap] of [[3_600_000, this.options.cfg.allocation.max_model_requests_per_hour], [DAY, this.options.cfg.allocation.max_model_requests_per_day]] as const) {
      if (cap === undefined) continue;
      const extra = admitted ? 0 : 1;
      if (physicalRequestCount(this.db, now - window) + extra > cap) throw new GlobalAccountingDenied("quota");
      if (limits.request_share !== undefined && physicalRequestCount(this.db, now - window, input.owner.projectId) + extra > Math.max(1, Math.floor(cap * limits.request_share))) throw new GlobalAccountingDenied("quota");
    }
    if (authority.paid) {
      if (this.options.spend.globalDenial(extraUsd)) throw new GlobalAccountingDenied("paid_budget");
      const budgets = limits.paid_budgets;
      for (const [window, cap] of [[DAY, budgets?.per_day_usd], [7 * DAY, budgets?.per_week_usd], [30 * DAY, budgets?.per_month_usd]] as const) {
        if (cap !== undefined && this.options.spend.projectAccountingSpendSince(input.owner.projectId, now - window) + extraUsd > cap) throw new GlobalAccountingDenied("paid_budget");
      }
      const key = { ref: input.keyRef!, label: "", enabled: true, ...authority.paid };
      if (this.options.spend.keyHeadroom(key) < extraUsd) throw new GlobalAccountingDenied("paid_budget");
    }
  }
  reserveGlobal(value: ReserveGlobalRequest): { disposition: "fresh" | "replayed"; receipt: GlobalReceipt } {
    const input = ReserveGlobalRequestSchema.parse(value), fingerprint = globalReservationFingerprint(input);
    return this.mutation(() => {
      const existing = this.row(input.requestId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new GlobalAccountingDenied("conflict");
        return { disposition: "replayed", receipt: this.receipt(existing) };
      }
      if (this.db.prepare("SELECT 1 FROM model_requests WHERE id=? UNION ALL SELECT 1 FROM request_deletion_tombstones WHERE request_id=? LIMIT 1").get(input.requestId, input.requestId)) throw new GlobalAccountingDenied("conflict");
      if (input.providerReservationId && this.db.prepare("SELECT 1 FROM physical_requests WHERE provider_reservation_id=?").get(input.providerReservationId)) throw new GlobalAccountingDenied("conflict");
      if (input.providerReservationId && this.db.prepare(`SELECT 1 FROM request_protocol
        WHERE json_extract(CASE WHEN json_valid(binding_json) THEN binding_json ELSE '{}' END,'$.providerReservationId')=? LIMIT 1`).get(input.providerReservationId)) throw new GlobalAccountingDenied("conflict");
      if (input.slot && this.db.prepare("SELECT 1 FROM physical_requests WHERE slot_id=? AND slot_nonce=?").get(input.slot.id, input.slot.nonce)) throw new GlobalAccountingDenied("conflict");
      const slug = this.registered(input), authority = this.authority(input); this.slot(input, slug, authority); this.dispatchWindow(input);
      const rawUsd = authority.paid ? worstCaseUsd(input.estimatedInputTokens, input.reservedOutputTokens, authority.paid.price, authority.paid.maxSearches) : 0;
      if (!Number.isFinite(rawUsd) || rawUsd < 0 || rawUsd > 1e12) throw new GlobalAccountingDenied("paid_budget");
      const reservedUsd = Math.ceil(rawUsd * 1e6) / 1e6;
      this.limits(input, slug, authority, reservedUsd, false);
      const now = z.number().int().nonnegative().parse(this.now());
      this.db.prepare(`INSERT INTO physical_requests(id,installation_uuid,project_uuid,store_uuid,generation,fingerprint,accounting_json,
        endpoint_id,provider,key_ref,provider_reservation_id,paid,slot_id,slot_nonce,status,reserved_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'reserved',?)`).run(input.requestId, input.owner.installationId, input.owner.projectId,
          input.owner.storeId, input.owner.generation, fingerprint, JSON.stringify(input), input.endpointId, authority.provider,
          input.keyRef, input.providerReservationId, authority.paid ? 1 : 0, input.slot?.id ?? null, input.slot?.nonce ?? null, now);
      if (authority.paid) this.db.prepare("INSERT INTO broker_paid_spend(request_id,key_ref,provider,endpoint_id,reserved_usd,liability_usd,created_at) VALUES(?,?,?,?,?,?,?)")
        .run(input.requestId, input.keyRef, authority.provider, input.endpointId, reservedUsd, reservedUsd, now);
      return { disposition: "fresh", receipt: this.receipt(this.row(input.requestId)!) };
    });
  }
  beginDispatchGlobal(reference: GlobalRequestReference, dispatchId: string): { disposition: "fresh" | "replayed"; receipt: GlobalReceipt } {
    z.string().min(1).max(300).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/).parse(dispatchId);
    return this.mutation(() => {
      const row = this.bound(reference);
      if (row.dispatch_id !== null) {
        if (row.dispatch_id !== dispatchId) throw new GlobalAccountingDenied("conflict");
        return { disposition: "replayed", receipt: this.receipt(row) };
      }
      if (row.status !== "reserved") throw new GlobalAccountingDenied("state");
      const input = ReserveGlobalRequestSchema.parse(JSON.parse(row.accounting_json)), slug = this.registered(input), authority = this.authority(input);
      this.dispatchWindow(input);
      if (authority.provider !== row.provider || (authority.paid !== null) !== (this.receipt(row).reservedUsd !== null)) throw new GlobalAccountingDenied("authority");
      if (authority.paid && worstCaseUsd(input.estimatedInputTokens, input.reservedOutputTokens, authority.paid.price, authority.paid.maxSearches) > this.receipt(row).reservedUsd!) throw new GlobalAccountingDenied("paid_budget");
      this.slot(input, slug, authority); this.limits(input, slug, authority, 0, true);
      this.dispatchWindow(input);
      this.db.prepare("UPDATE physical_requests SET status='dispatch_intent',dispatch_id=? WHERE id=?").run(dispatchId, row.id);
      return { disposition: "fresh", receipt: this.receipt(this.row(row.id)!) };
    });
  }
  settleGlobal(value: SettleGlobalRequest): GlobalReceipt {
    const input = SettleGlobalRequestSchema.parse(value), digest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    let quarantined = false;
    const receipt = this.mutation(() => {
      const row = this.bound({ requestId: input.requestId, fingerprint: input.fingerprint });
      if (row.status === "settled") {
        if (row.outcome_digest !== input.outcomeDigest || row.accounting_outcome_sha256 !== digest) throw new GlobalAccountingDenied("conflict");
        return this.receipt(row);
      }
      if (row.status !== "dispatch_intent") throw new GlobalAccountingDenied("state");
      if (row.paid === 0 && ((input.actualUsd !== null && input.actualUsd > 0) || row.cost_quarantined === 1)) {
        if (input.actualUsd !== null && input.actualUsd > 0) this.db.prepare(`UPDATE physical_requests SET
          unexpected_liability_usd=MAX(COALESCE(unexpected_liability_usd,0),?),cost_quarantined=1,
          quarantine_conflict=CASE WHEN accounting_outcome_sha256 IS NOT NULL AND accounting_outcome_sha256!=? THEN 1 ELSE quarantine_conflict END,
          quarantine_outcome_sha256=COALESCE(quarantine_outcome_sha256,?),
          accounting_outcome_sha256=COALESCE(accounting_outcome_sha256,?),error_code='unexpected_cost' WHERE id=?`)
          .run(input.actualUsd, digest, input.outcomeDigest, digest, row.id);
        quarantined = true;
        return this.receipt(this.row(row.id)!);
      }
      const now = this.now();
      this.db.prepare("UPDATE physical_requests SET status='settled',outcome_digest=?,accounting_outcome_sha256=?,outcome=?,input_tokens=?,output_tokens=?,error_code=?,finished_at=? WHERE id=?")
        .run(input.outcomeDigest, digest, input.outcome, input.inputTokens, input.outputTokens, input.errorCode, now, row.id);
      const actual = input.outcome === "uncertain" || input.costBasis === "uncertain" ? null : input.actualUsd;
      this.db.prepare("UPDATE broker_paid_spend SET actual_usd=?,liability_usd=MAX(liability_usd,?),cost_basis=?,settled_at=? WHERE request_id=?")
        .run(actual, input.actualUsd ?? 0, actual === null ? "uncertain" : input.costBasis, now, row.id);
      return this.receipt(this.row(row.id)!);
    });
    // Commit incident evidence before surfacing failure; throwing inside mutation would erase the quarantine.
    if (quarantined) throw new GlobalAccountingCostQuarantine(receipt);
    return receipt;
  }
  readReceipt(requestId: string): GlobalReceipt | null {
    const parsed = ReserveGlobalRequestSchema.shape.requestId.parse(requestId), row = this.row(parsed);
    return row ? this.receipt(row) : null;
  }
  retireDefinitelyUnsent(reference: GlobalRequestReference): GlobalReceipt {
    return this.mutation(() => {
      const row = this.bound(reference);
      if (row.status === "retired") return this.receipt(row);
      if (row.status !== "reserved" || row.dispatch_id !== null) throw new GlobalAccountingDenied("state");
      if (row.slot_id && this.db.prepare("SELECT 1 FROM provider_slots WHERE id=? AND uncertain!=0").get(row.slot_id)) throw new GlobalAccountingDenied("slot");
      this.db.prepare("UPDATE physical_requests SET status='retired',finished_at=? WHERE id=?").run(this.now(), row.id);
      this.db.prepare("UPDATE broker_paid_spend SET actual_usd=0,cost_basis='not_billed',settled_at=? WHERE request_id=?").run(this.now(), row.id);
      return this.receipt(this.row(row.id)!);
    });
  }
  listUnresolved(limit = 100): GlobalReceipt[] {
    z.number().int().min(1).max(1000).parse(limit); this.coordination();
    const ids = z.array(z.object({ id: z.string() }).strict()).parse(this.db.prepare(`SELECT r.id FROM physical_requests r
      LEFT JOIN broker_paid_spend p ON p.request_id=r.id WHERE r.status IN ('reserved','dispatch_intent')
      OR r.cost_quarantined=1 OR r.outcome='uncertain' OR (r.status='settled' AND p.actual_usd IS NULL AND p.request_id IS NOT NULL)
      ORDER BY r.reserved_at,r.id LIMIT ?`).all(limit));
    return ids.map(row => this.readReceipt(row.id)!);
  }
}
