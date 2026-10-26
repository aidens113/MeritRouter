import { z } from "zod";
import { AdmissionDenied } from "../core/errors.js";
import type { ResolvedConfig } from "../config/load.js";
import type { ProjectStoreIdentity } from "../projects/store-identity.js";
import { actualUsd } from "../paid/spend.js";
import type { Admission } from "./admission.js";
import { GlobalAccountingCostQuarantine, GlobalAccountingDenied } from "./sqlite-accounting-broker.js";
import { GlobalReceiptSchema, type GlobalReceipt, type RequestAccountingBroker, type SettleGlobalRequest } from "./accounting-broker.js";
import { assertProjectRequestAuthority } from "./project-request-authority.js";
import { applyProjectSettlement, assertOriginalProjectParticipants, bindProjectRequest, updateProjectLiability } from "./project-request-projection.js";
import { ProjectRequestStore, projectRequestDigest, type ProjectRequestRecord } from "./project-request-store.js";
import { ReserveRequestDTOSchema, ReservationDTOSchema, RequestOutcomeDTOSchema, RequestPersistenceError, type RequestLedger,
  type RequestLedgerPhase, type ReservationDTO, type ReserveRequestDTO, type RequestOutcomeDTO } from "./request-ledger.js";

export type ProjectRequestCheckpoint = "local_prepared" | "global_reserved" | "local_bound" | "local_dispatched" | "outcome_saved" | "global_settled" | "local_applied";
export interface ProjectRequestLedgerOptions {
  identity: ProjectStoreIdentity;
  cfg: ResolvedConfig;
  broker: RequestAccountingBroker;
  /** Host-only fault/coordination observer; always called after SQL commits, never within a transaction. */
  checkpoint?: (phase: ProjectRequestCheckpoint, requestId: string) => void | Promise<void>;
}

/** Project-local authority plus synchronous shared accounting. This adapter is not activated by construction. */
export class ProjectRequestLedger implements RequestLedger {
  private readonly store: ProjectRequestStore;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly issued = new Map<string, { dispatchId: string; fingerprint: string }>();
  private readonly liveRecords = new Map<string, ProjectRequestRecord>();
  private readonly consumed = new Map<string, { dispatchId: string; fingerprint: string }>();
  constructor(private readonly admission: Admission, private readonly options: ProjectRequestLedgerOptions) {
    this.store = new ProjectRequestStore(admission.db, options.identity, () => admission.serverNow());
    if (options.cfg.brain.project !== options.identity.slug) throw new Error("Local project context does not match pinned store identity");
  }
  private operation<T>(stage: "reserve" | "dispatch" | "reconcile", id: string | null, work: () => Promise<T>): Promise<T> {
    const promise = Promise.resolve().then(work).catch(error => {
      if (error instanceof RequestPersistenceError) throw error;
      if (error instanceof AdmissionDenied && stage === "reserve" && id !== null && !this.store.read(id)) throw error;
      throw new RequestPersistenceError(stage, id, error);
    });
    this.pending.add(promise); void promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise)); return promise;
  }
  private async checkpoint(phase: ProjectRequestCheckpoint, id: string): Promise<void> { await this.options.checkpoint?.(phase, id); }
  private global(record: ProjectRequestRecord): GlobalReceipt | null {
    const value = this.options.broker.readReceipt(record.row.request_id);
    return value === null ? null : this.store.assertGlobalReceipt(record, GlobalReceiptSchema.parse(value));
  }
  private mark(record: ProjectRequestRecord, receipt: GlobalReceipt | null, code: string): void {
    try { this.store.transaction(() => {
      const fresh = this.store.read(record.row.request_id); if (!fresh || ["settled", "retired"].includes(fresh.row.phase)) return;
      if (receipt?.costQuarantined) {
        try { assertOriginalProjectParticipants(this.admission, this.store, fresh); updateProjectLiability(this.store, fresh, receipt); } catch { /* Incarnation or projection failure never changes the new task's charges. */ }
      }
      this.store.update(fresh, receipt?.costQuarantined ? "quarantined" : "uncertain", receipt ?? undefined, code);
    }); } catch { /* Original durable preparation/charges remain counted; do not invent rollback evidence. */ }
  }
  private pendingParticipants(input: ReserveRequestDTO): void {
    for (const part of input.participants) for (const pending of this.store.pendingForTask(part.taskId, input.requestId)) {
      const receipt = this.global(pending);
      if (["uncertain", "quarantined"].includes(pending.row.phase) || pending.outcome !== null || receipt?.costQuarantined
        || receipt?.state === "settled" || receipt?.state === "retired") throw new Error("Participant has unresolved local/global accounting; reconcile it before new admission");
    }
  }
  reserve(value: ReserveRequestDTO): Promise<ReservationDTO> {
    return this.operation("reserve", value.requestId, async () => {
      const input = ReserveRequestDTOSchema.parse(value);
      let record = this.store.transaction(() => {
        const old = this.store.read(input.requestId);
        if (old) {
          if (old.row.fingerprint !== projectRequestDigest(input)) throw new Error("Project request ID reused with changed private binding");
          return old;
        }
        if (this.store.db.prepare("SELECT 1 FROM model_requests WHERE id=? UNION ALL SELECT 1 FROM request_protocol_keys WHERE id=? LIMIT 1").get(input.requestId, input.requestId))
          throw new Error("Project request ID already has legacy authority");
        this.pendingParticipants(input);
        const deadline = assertProjectRequestAuthority(this.admission, this.options.cfg, this.store.identity, input, false);
        return this.store.insert(input, deadline);
      });
      try {
        if (!["prepared", "uncertain"].includes(record.row.phase) || record.row.dispatch_id !== null) return { ...record.reservation, disposition: "replayed" };
        await this.checkpoint("local_prepared", input.requestId);
        this.store.transaction(() => assertProjectRequestAuthority(this.admission, this.options.cfg, this.store.identity, record.input, true));
        const result = z.object({ disposition: z.enum(["fresh", "replayed"]), receipt: GlobalReceiptSchema }).strict().parse(this.options.broker.reserveGlobal(record.global));
        const receipt = this.store.assertGlobalReceipt(record, result.receipt);
        await this.checkpoint("global_reserved", input.requestId);
        if (receipt.state !== "reserved") {
          this.mark(record, receipt, "global_not_reserved");
          throw new Error("Original global request cannot authorize a fresh reservation/transport");
        }
        record = this.store.transaction(() => {
          const fresh = this.store.read(input.requestId)!;
          this.store.resizePreparation(fresh, receipt);
          assertProjectRequestAuthority(this.admission, this.options.cfg, this.store.identity, fresh.input, true);
          if ((receipt.reservedUsd !== null) !== (fresh.input.paid !== undefined)) throw new AdmissionDenied("paid_budget_exhausted", "Paid classification changed after local preparation");
          bindProjectRequest(this.admission, this.store, fresh, receipt);
          return this.store.read(input.requestId)!;
        });
        await this.checkpoint("local_bound", input.requestId);
        return { ...record.reservation, disposition: result.disposition };
      } catch (error) {
        let receipt: GlobalReceipt | null = null;
        try { receipt = this.global(record); } catch { /* Unknown coordinator state must retain local preparation. */ }
        if (!receipt && (error instanceof GlobalAccountingDenied || error instanceof AdmissionDenied)) {
          this.store.transaction(() => { const fresh = this.store.read(input.requestId)!; this.store.releasePreparation(fresh); this.store.update(fresh, "retired", undefined, "never_globally_admitted"); });
        } else if (receipt?.state === "reserved" && error instanceof AdmissionDenied) {
          try {
            const retired = this.store.assertGlobalReceipt(record, this.options.broker.retireDefinitelyUnsent({ requestId: receipt.requestId, fingerprint: receipt.fingerprint }));
            this.store.transaction(() => { const fresh = this.store.read(input.requestId)!; bindProjectRequest(this.admission, this.store, fresh, retired);
              applyProjectSettlement(this.admission, this.store, this.store.read(input.requestId)!, retired); });
          } catch { this.mark(record, receipt, "unsent_reconciliation_pending"); }
        } else this.mark(record, receipt, "reservation_reconciliation_pending");
        throw error;
      }
    });
  }
  beginDispatch(value: ReservationDTO, dispatchId: string): Promise<{ disposition: "fresh" | "replayed" }> {
    return this.operation("dispatch", value.requestId, async () => {
      let record = this.store.bound(value);
      try {
        const result = this.store.transaction(() => {
          const fresh = this.store.bound(value);
          if (fresh.row.dispatch_id !== null) {
            if (fresh.row.dispatch_id !== dispatchId) throw new Error("Project dispatch identity changed");
            return { disposition: "replayed" as const };
          }
          if (fresh.row.phase !== "bound") throw new Error("Project request is not durably bound");
          assertProjectRequestAuthority(this.admission, this.options.cfg, this.store.identity, fresh.input, true);
          if (this.admission.serverNow() >= fresh.global.dispatchNotAfter) throw new Error("Captured local dispatch window expired");
          const global = this.global(fresh);
          if (!global || global.state !== "reserved" || global.costQuarantined) throw new Error("Global request cannot authorize a fresh dispatch");
          const dispatched = z.object({ disposition: z.enum(["fresh", "replayed"]), receipt: GlobalReceiptSchema }).strict()
            .parse(this.options.broker.beginDispatchGlobal({ requestId: global.requestId, fingerprint: global.fingerprint }, dispatchId));
          if (dispatched.disposition !== "fresh") throw new Error("Replayed global intent never authorizes transport");
          const receipt = this.store.assertGlobalReceipt(fresh, dispatched.receipt);
          this.store.markDispatch(fresh, dispatchId); this.store.update(fresh, "dispatch_intent", receipt);
          return { disposition: "fresh" as const };
        });
        if (result.disposition === "replayed") return result;
        await this.checkpoint("local_dispatched", value.requestId);
        this.store.transaction(() => {
          record = this.store.bound(value);
          assertProjectRequestAuthority(this.admission, this.options.cfg, this.store.identity, record.input, true);
          if (this.admission.serverNow() >= record.global.dispatchNotAfter) throw new Error("Dispatch authority expired after persistence");
          const global = this.global(record);
          if (!global || global.state !== "dispatch_intent" || global.dispatchId !== dispatchId || global.costQuarantined) throw new Error("Fresh global dispatch ownership changed");
        });
        this.issued.set(value.requestId, { dispatchId, fingerprint: record.row.fingerprint });
        return result;
      } catch (error) {
        this.issued.delete(value.requestId);
        let receipt: GlobalReceipt | null = null; try { receipt = this.global(record); } catch { /* retain unknown state */ }
        this.mark(record, receipt, "dispatch_reconciliation_pending"); throw error;
      }
    });
  }
  /** Consumes a private process-owned proof. Serialized/replayed receipts cannot recreate it. */
  assertDispatch(value: ReservationDTO, dispatchId: string): void {
    const authority = this.issued.get(value.requestId); this.issued.delete(value.requestId);
    if (!authority || authority.dispatchId !== dispatchId || authority.fingerprint !== value.fingerprint) throw new RequestPersistenceError("dispatch", value.requestId, new Error("No fresh process-owned transport authority"));
    try {
      let captured: ProjectRequestRecord | undefined;
      this.store.transaction(() => {
        const record = this.store.bound(value);
        captured = record;
        if (record.row.phase !== "dispatch_intent" || record.row.dispatch_id !== dispatchId || record.row.transport_consumed !== 0) throw new Error("Project transport authority already consumed or changed");
        assertProjectRequestAuthority(this.admission, this.options.cfg, this.store.identity, record.input, true);
        if (this.admission.serverNow() >= record.global.dispatchNotAfter) throw new Error("Captured dispatch deadline expired");
        const receipt = this.global(record);
        if (!receipt || receipt.state !== "dispatch_intent" || receipt.dispatchId !== dispatchId || receipt.costQuarantined) throw new Error("Global transport authority is unavailable");
        this.store.db.prepare("UPDATE project_request_protocol SET transport_consumed=1,updated_at=? WHERE request_id=?").run(this.admission.serverNow(), value.requestId);
      });
      this.consumed.set(value.requestId, authority);
      this.liveRecords.set(value.requestId, captured!);
    } catch (error) { throw new RequestPersistenceError("dispatch", value.requestId, error); }
  }
  private globalOutcome(record: ProjectRequestRecord, value: RequestOutcomeDTO): SettleGlobalRequest {
    const outcome = RequestOutcomeDTOSchema.parse(value), usage = outcome.response?.usage, paid = record.reservation.paid;
    let cost: number | null = usage?.reportedCostUsd ?? null;
    let basis: SettleGlobalRequest["costBasis"] = cost !== null ? "provider_reported" : "uncertain";
    if (outcome.kind === "uncertain") basis = "uncertain";
    else if (cost === null && outcome.kind === "failed") { cost = 0; basis = "not_billed"; }
    else if (cost === null && !paid) { cost = 0; basis = "not_billed"; }
    else if (cost === null && paid && usage?.inputTokens !== null && usage?.inputTokens !== undefined && usage.outputTokens !== null) {
      const computed = actualUsd(usage.inputTokens, usage.outputTokens, paid.price, usage.cachedInputTokens ?? 0,
        outcome.response?.webSearch?.requests ?? 0, usage.cacheCreationInputTokens ?? 0);
      if (Number.isFinite(computed)) { cost = computed; basis = "computed"; }
    }
    const error = outcome.kind === "succeeded" ? "none" : outcome.errorKind.includes("timeout") ? "timeout"
      : outcome.errorKind.includes("abort") ? "aborted" : outcome.errorKind.includes("rate") ? "rate_limited" : "provider_error";
    return { requestId: record.row.request_id, fingerprint: record.receipt!.fingerprint, outcomeDigest: projectRequestDigest(outcome),
      outcome: outcome.kind, inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null, actualUsd: cost, costBasis: basis, errorCode: error };
  }
  private settleGlobally(record: ProjectRequestRecord, outcome: RequestOutcomeDTO): GlobalReceipt {
        let receipt = this.global(record); if (!receipt) throw new Error("Original global accounting receipt is unavailable");
        if (receipt.state === "reserved" && outcome.kind === "failed") {
          receipt = this.store.assertGlobalReceipt(record, this.options.broker.retireDefinitelyUnsent({ requestId: receipt.requestId, fingerprint: receipt.fingerprint }));
        } else {
          const usage = outcome.response?.usage, paid = record.reservation.paid;
          const unpricedWrite = paid && (usage?.cacheCreationInputTokens ?? 0) > 0 && paid.price.cacheWriteIn == null;
          const unpricedSearch = paid && (outcome.response?.webSearch?.requests ?? 0) > 0 && paid.price.perSearch == null;
          if ((unpricedWrite || unpricedSearch) && (usage?.reportedCostUsd == null || outcome.kind === "uncertain")) {
            receipt = this.store.assertGlobalReceipt(record, this.options.broker.quarantineUnboundedCost({ requestId: receipt.requestId, fingerprint: receipt.fingerprint,
              outcomeDigest: projectRequestDigest(outcome), minimumUsd: usage?.reportedCostUsd ?? 0,
              code: unpricedWrite ? "cache_write_price_unknown" : "provider_cost_unknown" }));
          } else receipt = this.store.assertGlobalReceipt(record, this.options.broker.settleGlobal(this.globalOutcome({ ...record, receipt }, outcome)));
        }
    return receipt;
  }
  reconcile(value: ReservationDTO, valueOutcome: RequestOutcomeDTO): Promise<void> {
    return this.operation("reconcile", value.requestId, async () => {
      const outcome = RequestOutcomeDTOSchema.parse(valueOutcome);
      const captured = this.liveRecords.get(value.requestId), proof = this.consumed.get(value.requestId);
      if (captured && proof) {
        const parsed = ReservationDTOSchema.parse(value);
        if (projectRequestDigest({ ...parsed, disposition: "fresh" }) !== projectRequestDigest(captured.reservation)
          || proof.fingerprint !== captured.row.fingerprint || proof.dispatchId !== captured.row.dispatch_id)
          throw new Error("Live outcome binding changed");
        const usage = outcome.response?.usage, paid = captured.reservation.paid;
        const unpriced = paid && (((usage?.cacheCreationInputTokens ?? 0) > 0 && paid.price.cacheWriteIn == null)
          || ((outcome.response?.webSearch?.requests ?? 0) > 0 && paid.price.perSearch == null));
        if (unpriced && (usage?.reportedCostUsd == null || outcome.kind === "uncertain")) {
          // Trusted process context survives a closed project DB. Fence unbounded liability first.
          const receipt = this.settleGlobally(captured, outcome);
          if (receipt.costQuarantined) this.mark(captured, receipt, "global_cost_quarantine");
        }
      }
      let record = this.store.bound(value);
      if (record.row.phase === "settled" || record.row.phase === "retired") {
        if (record.row.outcome_digest !== null && record.row.outcome_digest !== projectRequestDigest(outcome)) throw new Error("Conflicting local settlement outcome");
        return;
      }
      const live = this.consumed.get(value.requestId);
      if (record.outcome === null && !live && !(record.row.phase === "bound" && outcome.kind === "failed")) throw new Error("Outcome lacks original process transport or durable captured evidence");
      if (live && (live.fingerprint !== record.row.fingerprint || live.dispatchId !== record.row.dispatch_id)) throw new Error("Outcome process authority changed");
      try {
        try {
          record = this.store.transaction(() => { const fresh = this.store.bound(value); this.store.saveOutcome(fresh, outcome); return this.store.bound(value); });
        } catch (persistenceError) {
          // A provider already ran. Preserve minimal global financial truth even if private diagnostics cannot commit.
          // Conflicting durable outcomes are never substituted with a new claim.
          if (live && (record.outcome === null || projectRequestDigest(record.outcome) === projectRequestDigest(outcome))) {
            try { this.settleGlobally(record, outcome); } catch (globalError) {
              if (globalError instanceof GlobalAccountingCostQuarantine) this.mark(record, globalError.receipt, "global_cost_quarantine");
            }
          }
          throw persistenceError;
        }
        await this.checkpoint("outcome_saved", value.requestId);
        const receipt = this.settleGlobally(record, outcome);
        await this.checkpoint("global_settled", value.requestId);
        if (receipt.costQuarantined || receipt.unboundedCost) { this.mark(record, receipt, "global_cost_quarantine"); throw new GlobalAccountingCostQuarantine(receipt); }
        this.store.transaction(() => { const fresh = this.store.bound(value); applyProjectSettlement(this.admission, this.store, fresh, receipt!); });
        this.consumed.delete(value.requestId); this.liveRecords.delete(value.requestId);
        await this.checkpoint("local_applied", value.requestId);
      } catch (error) {
        let receipt: GlobalReceipt | null = error instanceof GlobalAccountingCostQuarantine ? error.receipt : null;
        if (!receipt) try { receipt = this.global(record); } catch { /* original local holds remain */ }
        this.mark(record, receipt, receipt?.costQuarantined ? "global_cost_quarantine" : "settlement_reconciliation_pending"); throw error;
      }
    });
  }
  recover(requestId: string): Promise<{ state: RequestLedgerPhase } | null> {
    return this.operation("reconcile", requestId, async () => {
      const record = this.store.read(requestId); if (!record) return null;
      if (record.outcome) { await this.reconcile(record.reservation, record.outcome); return this.receipt(requestId); }
      const global = this.global(record);
      if (global?.state === "settled" || global?.state === "retired") {
        this.store.transaction(() => { const fresh = this.store.read(requestId)!; bindProjectRequest(this.admission, this.store, fresh, global);
          applyProjectSettlement(this.admission, this.store, this.store.read(requestId)!, global); });
      } else if (global?.state === "dispatch_intent" || global?.costQuarantined) this.mark(record, global, "transport_outcome_unknown");
      else if (["prepared", "uncertain"].includes(record.row.phase)) await this.reserve(record.input);
      return this.receipt(requestId);
    });
  }
  async receipt(requestId: string): Promise<{ state: RequestLedgerPhase } | null> {
    const record = this.store.read(requestId); return record ? { state: record.row.phase === "bound" ? "reserved" : record.row.phase } : null;
  }
  async drain(): Promise<void> { while (this.pending.size) await Promise.allSettled([...this.pending]); }
}
