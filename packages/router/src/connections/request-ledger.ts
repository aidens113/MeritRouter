import type { Admission } from "../admission/admission.js";
import { SqliteRequestLedger } from "../admission/sqlite-request-ledger.js";
import type { RequestLedger, ReserveRequestDTO, ReservationDTO, RequestOutcomeDTO } from "../admission/request-ledger.js";
import { loadConfig, type ResolvedConfig } from "../config/load.js";
import { AdmissionDenied, ConfigError } from "../core/errors.js";
import type { PaidSpend } from "../paid/spend.js";
import { z } from "zod";
import { ClientConnectionError } from "./protocol.js";
import { clientConnectionTokenMatches } from "./access.js";
import { assertInstallationExecution, type InstallationExecution } from "./installation-execution.js";

interface ActiveRequest { proof: InstallationExecution; signal: AbortSignal; accessToken?: string; binding: string }
const binding = (cfg: ResolvedConfig) => JSON.stringify({ host: cfg.client_connections.host, port: cfg.client_connections.port, hash: cfg.client_connections.access_token_hash });
/** Ordinary requests retain their original ledger. Intrinsic direct calls add host authority. */
export class ClientConnectionRequestLedger implements RequestLedger {
  private readonly base: SqliteRequestLedger;
  private readonly active = new Map<string, ActiveRequest>();
  constructor(private readonly admission: Admission, spend: PaidSpend, private readonly cfg: ResolvedConfig) {
    this.base = new SqliteRequestLedger(admission, spend, { beforeReserve: input => this.beforeReserve(input) });
  }
  register(proof: InstallationExecution, signal: AbortSignal, accessToken?: string): void {
    if (this.active.has(proof.executionId)) throw new Error("Installation request already registered");
    this.active.set(proof.executionId, { proof, signal, ...(accessToken === undefined ? {} : { accessToken }), binding: binding(this.cfg) });
    try { this.assert(proof.executionId); } catch (error) { this.active.delete(proof.executionId); throw error; }
  }
  unregister(proof: InstallationExecution): void { if (this.active.get(proof.executionId)?.proof.nonce === proof.nonce) this.active.delete(proof.executionId); }
  assert(executionId: string): ResolvedConfig {
    const context = this.active.get(executionId);
    if (!context || context.signal.aborted) throw new ClientConnectionError(499, "request_cancelled", "The client request no longer has active host authority.");
    const now = this.admission.serverNow();
    if (now >= context.proof.deadlineAt) throw new ClientConnectionError(504, "request_timeout", "The client request exceeded its configured timeout.");
    assertInstallationExecution(this.admission.db, context.proof, now);
    let fresh: ResolvedConfig;
    try { fresh = loadConfig(this.cfg.configPath); }
    catch (error) { if (error instanceof ConfigError) throw new ClientConnectionError(503, "connection_configuration_unavailable", "Connections configuration is temporarily unavailable."); throw error; }
    const settings = fresh.client_connections;
    if (!settings.enabled || !settings.enabled_modes.includes("direct") || binding(fresh) !== context.binding)
      throw new ClientConnectionError(503, "connections_reconfigured", "Connections are disabled or their binding or access key changed.");
    if (!clientConnectionTokenMatches(settings, context.accessToken)) throw new ClientConnectionError(401, "connection_token_required", "Send a valid Connections access token in the Authorization: Bearer header.");
    return fresh;
  }
  private assertPolicy(executionId: string): ResolvedConfig {
    try { return this.assert(executionId); }
    catch (error) {
      if (error instanceof ClientConnectionError) throw new AdmissionDenied(error.status === 499 ? "cancel_requested" : error.status === 504 ? "deadline_exceeded" : "lease_lost", error.message);
      // Read/schema/receipt failures are persistence uncertainty, never an invented refund.
      throw error;
    }
  }
  private beforeReserve(input: ReserveRequestDTO): void {
    if (input.profile !== "direct") return;
    const cfg = this.assertPolicy(input.executionId);
    if (input.purpose !== "client_connection" || input.participants.length) throw new Error("Intrinsic direct requests cannot carry task authority");
    const used = z.object({ n: z.number().int().nonnegative() }).strict().parse(this.admission.db.prepare("SELECT COUNT(*) n FROM model_requests WHERE execution_id=?").get(input.executionId)).n;
    const cap = Math.min(cfg.execution.max_model_requests_per_task, cfg.tiers.T1.max_model_requests);
    if (used >= cap) throw new AdmissionDenied("task_request_budget_exhausted", "The installation's per-request attempt allowance is exhausted.");
  }
  reserve(input: ReserveRequestDTO): Promise<ReservationDTO> { if (input.profile === "direct") this.assertPolicy(input.executionId); return this.base.reserve(input); }
  beginDispatch(reservation: ReservationDTO, dispatchId: string): Promise<{ disposition: "fresh" | "replayed" }> {
    if (this.active.has(reservation.executionId) || this.isDirect(reservation.executionId)) this.assertPolicy(reservation.executionId);
    return this.base.beginDispatch(reservation, dispatchId);
  }
  assertDispatch(reservation: ReservationDTO, dispatchId: string): void {
    if (this.active.has(reservation.executionId) || this.isDirect(reservation.executionId)) this.assertPolicy(reservation.executionId);
    this.base.assertDispatch(reservation, dispatchId);
  }
  private isDirect(id: string): boolean { return !!this.admission.db.prepare("SELECT 1 FROM executions WHERE id=? AND profile='direct'").get(id); }
  reconcile(reservation: ReservationDTO, outcome: RequestOutcomeDTO): Promise<void> { return this.base.reconcile(reservation, outcome); }
  receipt(id: string): ReturnType<RequestLedger["receipt"]> { return this.base.receipt(id); }
  drain(): Promise<void> { return this.base.drain(); }
}
