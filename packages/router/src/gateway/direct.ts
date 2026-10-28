import { createHash } from "node:crypto";
import { canonicalJson } from "../storage/tasks.js";
import { newId } from "../storage/db.js";
import { projectCaptureInput, projectCaptureOutput, type CaptureOutputProjection, type RequestCaptureStore } from "./request-capture.js";
import type { ResolvedConfig } from "../config/load.js";
import type { Participant } from "../admission/admission.js";
import { requestAttemptId, RequestOutcomeDTOSchema, ReservationDTOSchema, ReserveRequestDTOSchema, RequestPersistenceError, type ReserveRequestDTO, type RequestLedger, type ReservationDTO, type RequestOutcomeDTO } from "../admission/request-ledger.js";
import { AdmissionDenied, GatewayError, PAID_BUDGET_DENIALS, type GatewayErrorKind } from "../core/errors.js";
import type { ModelEndpoint } from "../models/catalog.js";
import { freeKeyOnly, isPaid, planSearch } from "../routing/select.js";
import { endpointPrice, worstCaseUsd, type PaidSpend } from "../paid/spend.js";
import type { ProviderClient, ProviderRequest, ProviderResponse, RequestCredential } from "../providers/client.js";
import type { ProviderCredential } from "../providers/credentials.js";
import { searchOutcome } from "../providers/native-search.js";
import { ProviderError, type ProviderErrorKind } from "../providers/errors.js";
import type { ProviderRuntime } from "../providers/runtime.js";
import type { ChatRequest, ChatResponse } from "./types.js";
import type { SlotHandle } from "./capacity.js";
import type { GateAttempt, GateRequest, ProviderHealth } from "./gate.js";

/**
 * The direct path: every `{kind:"direct"}` endpoint, free or paid, goes to its provider through
 * MeritRouter's own keys. Per endpoint: choose the provider's next usable key (round-robin, with
 * cooldowns, disables, rate-limit snapshots, and configured limits reserved atomically), reserve
 * the request (and for a paid model its worst-case cost), call the provider once, record the
 * outcome on the key, and verify the served model. A key-level failure (429, invalid key, out of
 * credits) moves to the provider's next usable key before the gate moves to the next endpoint.
 */

export interface DirectRuntime {
  providers: ProviderRuntime;
  spend: PaidSpend;
}

/** Gateway errors after which trying the next ranked model is reasonable. */
export const FALLBACK_KINDS = new Set<GatewayErrorKind>(["rate_limited", "pool_exhausted", "server", "timeout", "transport", "bad_request", "unknown_model"]);

/**
 * Failures that say something about the key, not the provider or the request: try another key
 * (`not_in_plan`: another key's plan may include the model; with none, the gate tries the next model).
 */
const KEY_LEVEL = new Set<ProviderErrorKind>(["rate_limited", "auth_invalid", "out_of_credits", "not_in_plan", "unknown_model"]);

/** Definite account/model refusals do not consume the transient endpoint retry allowance.
 * Every physical request still consumes normal admission, request and paid budgets. */
function unavailableRefusal(error: GatewayError): boolean {
  return error instanceof ProviderError && !error.possiblyConsumed && ["not_in_plan", "unknown_model", "auth_invalid", "out_of_credits"].includes(error.reason);
}

const REASON_OF: Record<GatewayErrorKind, ProviderErrorKind> = {
  rate_limited: "rate_limited",
  auth: "auth_invalid",
  pool_exhausted: "out_of_credits",
  policy_violation: "policy",
  server: "server",
  timeout: "timeout",
  transport: "transport",
  bad_request: "bad_request",
  unknown_model: "unknown_model",
  aborted: "aborted",
};

/** Any failure as a classified provider error (an injected client may throw plain errors). */
export function asProviderError(err: unknown, provider: string, aborted: boolean): ProviderError {
  if (aborted) return new ProviderError("aborted", (err as Error)?.message ?? "aborted", { provider, possiblyConsumed: err instanceof GatewayError ? err.possiblyConsumed : true });
  if (err instanceof ProviderError) return err;
  if (err instanceof GatewayError) {
    return new ProviderError(REASON_OF[err.kind], err.message, {
      provider,
      ...(err.status !== undefined ? { status: err.status } : {}),
      ...(err.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}),
      possiblyConsumed: err.possiblyConsumed,
    });
  }
  return new ProviderError("transport", (err as Error)?.message ?? String(err), { provider, possiblyConsumed: true });
}

export interface DirectDeps {
  cfg: ResolvedConfig;
  ledger: RequestLedger;
  captures: RequestCaptureStore;
  assertDispatch(participants: Participant[], reservation?: ReservationDTO, dispatchId?: string): void;
  health: ProviderHealth;
  direct: DirectRuntime;
}

export type DirectOutcome =
  | { kind: "skip"; resumeAt: number | null }
  | { kind: "failed"; error: GatewayError; unavailable?: boolean }
  | { kind: "ok"; requestId: string; response: ChatResponse };

const when = (t: number | null) => (t === null ? "" : ` until ${new Date(t).toISOString()}`);

/** Keys the endpoint may never use, with why: billing class against price, and paid key headroom. */
function ineligibleKeys(ep: ModelEndpoint, creds: ProviderCredential[], spend: PaidSpend, paid: boolean, worst: number): Map<string, string> {
  const out = new Map<string, string>();
  const keyOnly = freeKeyOnly(ep);
  for (const c of creds) {
    if (paid && c.billingClass === "free_tier") out.set(c.ref, "a free_tier key cannot serve a priced model");
    else if (keyOnly && c.billingClass !== "free_tier") out.set(c.ref, `a ${c.billingClass} key would bill a model that is free only on free_tier keys`);
    else if (paid) {
      const k = spend.spendKey(c);
      const room = k ? spend.keyHeadroom(k) : -Infinity;
      if (room < worst) out.set(c.ref, `$${Math.max(0, room).toFixed(4)} headroom`);
    }
  }
  return out;
}

/** One direct endpoint attempt, rotating through the provider's keys on key-level failures. */
export async function requestDirect(
  d: DirectDeps,
  ep: ModelEndpoint,
  req: GateRequest,
  participants: Participant[],
  estInput: number,
  attempts: GateAttempt[],
  admit: (ep: ModelEndpoint) => SlotHandle | null,
): Promise<DirectOutcome> {
  const route = { ...ep.route } as { kind: "direct"; provider: string; model: string };
  const rt = d.direct.providers;
  const provider = rt.provider(route.provider);
  if (!provider || !provider.enabled) {
    attempts.push({ endpointId: ep.id, outcome: `skipped: provider ${route.provider} is ${provider ? "disabled" : "not configured"}` });
    return { kind: "skip", resumeAt: null };
  }
  // Native web search under this plan: an always-on model, or a web task's optional search.
  const search = planSearch(ep, d.cfg, req.plan);
  const paid = isPaid(ep) || (search?.charged ?? false);
  // Server-tool loops can cache growing internal prompts: no finite input-only write bound.
  const disableCacheWrites = paid && provider.api === "anthropic" && (ep.pricing.cacheWriteInputUsdPerMillion == null || !!search);
  const requestProvider = disableCacheWrites ? { ...provider, promptCache: "none" as const } : provider;
  const price = { ...endpointPrice(ep.pricing), ...(search ? { perSearch: search.usdPerSearch } : {}) };
  const worst = paid ? worstCaseUsd(estInput, req.chat.max_tokens, price, search?.charged ? search.maxSearches : 0) : 0;
  const creds = rt.credentials().list(provider.id);
  const usable = creds.filter((c) => c.unusableReason === null);
  const ineligible = ineligibleKeys(ep, usable, d.direct.spend, paid, worst);
  if (usable.length === 0 || usable.every((c) => ineligible.has(c.ref))) {
    const why = !usable.length
      ? `no usable ${provider.id} key`
      : paid && [...ineligible.values()].every((r) => r.endsWith("headroom"))
        ? `(paid budget): no ${provider.id} key with $${worst.toFixed(4)} headroom`
        : `no ${provider.id} key may serve it (${[...ineligible.values()].join("; ")})`;
    attempts.push({ endpointId: ep.id, outcome: why.startsWith("(paid budget)") ? `skipped ${why}` : `skipped: ${why}` });
    return { kind: "skip", resumeAt: null };
  }

  const chat: Omit<ChatRequest, "model"> = { ...req.chat };
  if (ep.supportsStructuredOutput !== true) delete chat.response_format;
  const timeoutMs = d.cfg.providers.request_timeout_seconds * 1000;
  const estTokens = estInput + req.chat.max_tokens;
  const tried = new Set(ineligible.keys());
  let slot: SlotHandle | null = null;
  let lastKeyError: GatewayError | null = null;
  try {
    for (;;) {
      const sel = rt.keys.select(provider, creds, {
        estimatedTokens: estTokens,
        exclude: tried,
        model: route.model,
        modelLimits: ep.rateLimits ?? null,
        freeQuota: provider.keyInfoShape === "openrouter_key" && /:free$/.test(route.model),
        limits: rt.limits,
      });
      if (!sel.credential) {
        // Keys were tried and failed: the gate moves on to the next endpoint.
        if (lastKeyError) return { kind: "failed", error: lastKeyError, unavailable: unavailableRefusal(lastKeyError) };
        const blocked = sel.blocked.filter((b) => b.reason !== "excluded" && b.reason !== "unusable");
        attempts.push({ endpointId: ep.id, outcome: `skipped: no ${provider.id} key available (${blocked.map((b) => `${b.ref}: ${b.reason}${when(b.until)}`).join("; ") || "none usable"})` });
        return { kind: "skip", resumeAt: sel.resumeAt };
      }
      const cred = sel.credential;
      tried.add(cred.ref);
      const release = () => {
        if (sel.reservation) rt.limits.release(sel.reservation);
      };
      let credential: RequestCredential;
      try {
        credential = rt.credentials().requestCredential(cred.ref);
      } catch {
        release();
        continue;
      }
      if (!slot) {
        slot = admit(ep);
        if (!slot) {
          release();
          return { kind: "skip", resumeAt: null };
        }
      }

      const spendKey = paid ? d.direct.spend.spendKey(cred) : null;
      if (paid && !spendKey) {
        release();
        continue;
      }
      let reservation: ReservationDTO;
      const requestId = requestAttemptId(rt.now());
      try {
        reservation = ReservationDTOSchema.parse(await d.ledger.reserve(ReserveRequestDTOSchema.parse({
          requestId, payloadDigest: createHash("sha256").update(canonicalJson({ model: route.model, chat, search, cacheKey: req.cacheKey ?? null })).digest("hex"),
          keyRef: cred.ref, providerReservationId: sel.reservation?.id ?? null,
          slot: { id: slot.id, nonce: slot.nonce ?? "" },
          executionId: req.executionId,
          profile: req.plan.profile,
          purpose: req.purpose,
          gatewayModel: `direct:${provider.id}/${route.model}`,
          endpointId: ep.id,
          tier: req.plan.tier,
          routeNote: `${paid ? "paid" : "free"} via ${cred.label} (${cred.billingClass})${paid ? `; worst case $${worst.toFixed(4)}` : ""}${req.plan.belowFloorEndpoints.has(ep.id) ? "; forced below size floor" : ""}${search ? `; native web search (${search.via})` : ""}`,
          estInputTokens: estInput,
          reservedOutputTokens: req.chat.max_tokens,
          participants: participants as ReserveRequestDTO["participants"],
          ...(spendKey ? { paid: { key: spendKey, provider: route.provider, worstCaseUsd: worst, price } } : {}),
        })));
      } catch (err) {
        release();
        d.health.breakers.release(ep.providerId);
        if (err instanceof AdmissionDenied && PAID_BUDGET_DENIALS.has(err.reason)) {
          attempts.push({ endpointId: ep.id, outcome: `skipped (paid budget): ${err.message}`, denial: err.reason });
          return lastKeyError ? { kind: "failed", error: lastKeyError, unavailable: unavailableRefusal(lastKeyError) } : { kind: "skip", resumeAt: null };
        }
        throw err instanceof AdmissionDenied ? err : new RequestPersistenceError("reserve", requestId, err);
      }

      if (reservation.disposition !== "fresh") throw new RequestPersistenceError("reserve", requestId, new Error("replayed reservation never authorizes another provider call"));
      // Capture is observational: its errors never enter provider classification/retry logic.
      const observe = async (write: () => Promise<void>) => { try { await write(); } catch { /* private capture unavailable; accounting/provider policy is unchanged */ } };
      const webSearch = search ? { via: search.via, alwaysOn: search.alwaysOn, maxUses: search.maxUses, maxResults: search.maxResults } : undefined;
      await observe(() => d.captures.begin(reservation.requestId, projectCaptureInput(route.model, chat, webSearch), reservation.participants.map(p => p.taskId)));
      await observe(() => d.captures.dispatched(reservation.requestId));
      let output: CaptureOutputProjection | undefined;
      let notDispatched = false;
      const reconcile = async (outcome: RequestOutcomeDTO) => {
        try { await d.ledger.reconcile(reservation, RequestOutcomeDTOSchema.parse(outcome)); }
        catch (error) { throw new RequestPersistenceError("reconcile", reservation.requestId, error); }
        finally {
          await observe(() => d.captures.complete(reservation.requestId, {
            kind: outcome.kind, httpStatus: outcome.kind === "succeeded" ? outcome.response.httpStatus : (outcome.httpStatus ?? null),
            errorKind: outcome.kind === "succeeded" ? null : outcome.errorKind,
            possiblyConsumed: outcome.kind === "succeeded" ? true : outcome.kind === "uncertain",
            policyViolation: outcome.kind === "succeeded" && !!outcome.policyViolation,
          }, output, notDispatched));
        }
      };
      // An async reserve may commit before cancellation arrives. Keep its audit row, return
      // definitely-unsent quota/billing, and never send a provider request after the abort.
      if (req.signal?.aborted) {
        notDispatched = true;
        release();
        d.health.breakers.release(ep.providerId);
        await reconcile({ kind: "failed", errorKind: "aborted", errorMessage: "aborted after reservation, before provider dispatch" });
        throw Object.assign(new GatewayError("aborted", "aborted before provider dispatch", undefined, undefined, false), { attempts });
      }

      const dispatchId = newId("dispatch");
      try {
        const intent = await d.ledger.beginDispatch(reservation, dispatchId);
        if (intent.disposition !== "fresh") throw new Error("replayed dispatch never authorizes another provider call");
      } catch (error) {
        if (error instanceof AdmissionDenied) {
          notDispatched = true; release(); d.health.breakers.release(ep.providerId);
          await reconcile({ kind: "failed", errorKind: error.reason, errorMessage: error.message });
          throw error;
        }
        throw new RequestPersistenceError("dispatch", requestId, error);
      }
      // No await between this exact SQLite guard and invoking the provider client.
      try {
        if (req.signal?.aborted) throw new AdmissionDenied("cancel_requested", "request aborted before provider dispatch");
        d.assertDispatch(participants, reservation, dispatchId);
      }
      catch (error) {
        notDispatched = true;
        release();
        d.health.breakers.release(ep.providerId);
        if (!(error instanceof AdmissionDenied)) throw new RequestPersistenceError("dispatch", reservation.requestId, error);
        await reconcile({ kind: "failed", errorKind: error.reason, errorMessage: error.message });
        throw error;
      }

      let response: ProviderResponse;
      try {
        const webSearch = search ? { via: search.via, alwaysOn: search.alwaysOn, maxUses: search.maxUses, maxResults: search.maxResults, ...(search.engine ? { engine: search.engine } : {}) } : null;
        const call: ProviderRequest = {
          provider: requestProvider,
          credential,
          model: route.model,
          chat,
          timeoutMs,
          ...(req.signal ? { signal: req.signal } : {}),
          ...(req.cacheKey ? { cacheKey: req.cacheKey } : {}),
          ...(webSearch ? { webSearch } : {}),
        };
        response = await rt.client.complete(call);
      } catch (err) {
        const pe = asProviderError(err, provider.id, !!req.signal?.aborted);
        rt.keys.recordFailure(cred, pe, route.model);
        if (sel.reservation) {
          if (pe.possiblyConsumed) rt.limits.settle(sel.reservation, estTokens);
          else release();
        }
        const keyLevel = KEY_LEVEL.has(pe.reason);
        d.health.recordOutcome(ep.providerId, pe, slot.generation, { keyLevel });
        await reconcile({ kind: pe.possiblyConsumed ? "uncertain" : "failed", ...(pe.status !== undefined ? { httpStatus: pe.status } : {}), errorKind: pe.kind, errorMessage: pe.message });
        attempts.push({ endpointId: ep.id, outcome: pe.kind });
        if (pe.reason === "aborted") throw Object.assign(pe, { attempts });
        if (keyLevel) {
          lastKeyError = pe;
          // Split accounting binds one physical request to one exact slot: the next key gets its own slot.
          if (d.health.capacity.splitMode) { d.health.capacity.release(slot); slot = null; }
          continue;
        }
        if (FALLBACK_KINDS.has(pe.kind)) return { kind: "failed", error: pe, unavailable: unavailableRefusal(pe) };
        throw Object.assign(pe, { attempts });
      }

      try { output = projectCaptureOutput(response); } catch { /* capture projection cannot alter response/accounting */ }
      const { rateLimits, ...chatResponse } = response;
      // A client that reports nothing about the search still searched: count it as assumed.
      if (search && !chatResponse.webSearch) chatResponse.webSearch = searchOutcome({ via: search.via, alwaysOn: search.alwaysOn, maxUses: search.maxUses, maxResults: search.maxResults }, null, []);
      rt.keys.recordSuccess(cred, rateLimits.windows.length ? rateLimits : null);
      if (sel.reservation) rt.limits.settle(sel.reservation, (chatResponse.usage.inputTokens ?? estInput) + (chatResponse.usage.outputTokens ?? req.chat.max_tokens));
      d.health.recordOutcome(ep.providerId, null, slot.generation);
      // Providers often report a dated variant of the requested model id.
      const served = chatResponse.telemetry.servedModel;
      const unexpectedWrite = disableCacheWrites && (chatResponse.usage.cacheCreationInputTokens ?? 0) > 0
        ? `provider ${provider.id} reported ${chatResponse.usage.cacheCreationInputTokens} cache creation tokens despite disabled prompt caching` : undefined;
      const violation = unexpectedWrite ?? (
        served && served !== route.model && !served.startsWith(`${route.model}-`) && !served.endsWith(`/${route.model}`) ? `requested ${route.model} but ${provider.id} served ${served}` : undefined);
      await reconcile({ kind: "succeeded", response: chatResponse, servedEndpointId: violation ? null : ep.id, ...(violation ? { policyViolation: violation } : {}) });
      if (violation) {
        attempts.push({ endpointId: ep.id, outcome: "policy_violation" });
        throw Object.assign(new GatewayError("policy_violation", `${violation}; response discarded and ${ep.id} quarantined`), { attempts });
      }
      attempts.push({ endpointId: ep.id, outcome: "succeeded" });
      return { kind: "ok", requestId: reservation.requestId, response: chatResponse };
    }
  } catch (error) {
    if (slot && error instanceof RequestPersistenceError) d.health.capacity.quarantine(slot);
    throw error;
  } finally {
    if (slot) d.health.capacity.release(slot);
  }
}

/**
 * A provider client for discovery's tool probe that goes through the same machinery as routed
 * requests: the provider's breaker, its slot limit (a full provider refuses the probe), the next
 * usable `free_tier` key with its limits reserved, and the outcome recorded on that key and the
 * provider's health. Probes never spend money: a provider with no usable free key is refused
 * before any HTTP (the probe then reports unknown). A probe belongs to no task, so it is not
 * admission-charged and its slot row does not count against tasks' slots.
 */
export function probeClient(d: Omit<DirectDeps, "ledger" | "captures" | "assertDispatch">): Pick<ProviderClient, "complete"> {
  const rt = d.direct.providers;
  return {
    async complete(req) {
      const provider = req.provider;
      const free = rt.credentials().list(provider.id).filter((c) => c.billingClass !== "free_tier").map((c) => c.ref);
      const sel = rt.keys.select(provider, rt.credentials().list(provider.id), { estimatedTokens: req.chat.max_tokens, exclude: free, model: req.model, limits: rt.limits });
      if (!sel.credential) throw new ProviderError("policy", `no free ${provider.id} key available for a tool probe`, { provider: provider.id, possiblyConsumed: false });
      const cred = sel.credential;
      if (!d.health.breakers.admit(provider.id)) {
        if (sel.reservation) rt.limits.release(sel.reservation);
        throw new ProviderError("policy", `circuit open for ${provider.id}`, { provider: provider.id, possiblyConsumed: false });
      }
      const holder = { id: newId("probe"), taskIds: [], leases: [], leaseOwner: null, priority: 0 as const, since: null };
      const slot = d.health.capacity.tryAcquire(holder, provider.id);
      if ("full" in slot) {
        d.health.breakers.release(provider.id);
        if (sel.reservation) rt.limits.release(sel.reservation);
        throw new ProviderError("policy", `provider slots full for ${provider.id}`, { provider: provider.id, possiblyConsumed: false });
      }
      try {
        const res = await rt.client.complete({ ...req, credential: rt.credentials().requestCredential(cred.ref) });
        rt.keys.recordSuccess(cred, res.rateLimits.windows.length ? res.rateLimits : null);
        if (sel.reservation) rt.limits.settle(sel.reservation, (res.usage.inputTokens ?? 0) + (res.usage.outputTokens ?? req.chat.max_tokens));
        d.health.recordOutcome(provider.id, null, slot.generation);
        return res;
      } catch (err) {
        const pe = asProviderError(err, provider.id, !!req.signal?.aborted);
        // A priced model refusing a free key says nothing about the key's credits.
        if (pe.reason !== "out_of_credits") rt.keys.recordFailure(cred, pe, req.model);
        if (sel.reservation) {
          if (pe.possiblyConsumed) rt.limits.settle(sel.reservation, req.chat.max_tokens);
          else rt.limits.release(sel.reservation);
        }
        d.health.recordOutcome(provider.id, pe, slot.generation, { keyLevel: KEY_LEVEL.has(pe.reason) });
        throw pe;
      } finally {
        d.health.capacity.release(slot);
        d.health.capacity.leave(holder);
      }
    },
  };
}
