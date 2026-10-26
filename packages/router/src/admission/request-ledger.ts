import { z } from "zod";
import { randomBytes } from "node:crypto";
import { LeaseRefSchema } from "../storage/task-leases.js";
import { ProfileNameSchema } from "../config/schema.js";

const Count = z.number().int().nonnegative();
const Money = z.number().nonnegative();
const Budget = z.object({ maxModelRequests: Count, maxInputTokens: Count.nullable(), maxOutputTokens: Count.nullable(), maxPaidUsd: Money.nullable() }).strict();
export const RequestParticipantSchema = z.object({ lease: LeaseRefSchema, taskId: z.string().min(1), leaseOwner: z.string().min(1), budget: Budget, estInputTokens: Count, reservedOutputTokens: Count }).strict().refine(p => p.taskId === p.lease.taskId && p.leaseOwner === p.lease.owner, "participant identity disagrees with captured lease");
const Participant = RequestParticipantSchema;
const Paid = z.object({
  key: z.object({ ref: z.string().min(1), label: z.string(), enabled: z.boolean(), monthlyCapUsd: Money.nullable(), prepaidBalanceUsd: Money.nullable(), balanceCheckedAt: z.number().nullable() }).strict(),
  provider: z.string().min(1), worstCaseUsd: Money,
  // null/absent cache-write prices deliberately remain unknown; the accounting core retains
  // the reservation and quarantines an unpriceable reported cache creation.
  price: z.object({ in: Money, out: Money, cachedIn: Money.nullable().optional(), cacheWriteIn: Money.nullable().optional(), perSearch: Money.nullable().optional() }).strict(),
}).strict();
export const RequestIdSchema = z.string().regex(/^req_[a-z0-9]{1,12}_[a-f0-9]{24}$/);
export function requestAttemptId(now = Date.now()): string { return `req_${now.toString(36)}_${randomBytes(12).toString("hex")}`; }
export const ReserveRequestDTOSchema = z.object({
  requestId: RequestIdSchema, payloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
  keyRef: z.string().max(300), providerReservationId: z.string().nullable(),
  slot: z.object({ id: z.string().nullable(), nonce: z.string() }).strict().optional(),
  executionId: z.string().min(1), profile: ProfileNameSchema, purpose: z.string(), gatewayModel: z.string(), endpointId: z.string().nullable(), tier: z.string().nullable(), routeNote: z.string().nullable().optional(),
  estInputTokens: Count, reservedOutputTokens: Count, participants: z.array(Participant), paid: Paid.optional(),
}).strict();
export const ReservationDTOSchema = z.object({
  requestId: RequestIdSchema, fingerprint: z.string().regex(/^[a-f0-9]{64}$/), disposition: z.enum(["fresh", "replayed"]), executionId: z.string().min(1), participants: z.array(Participant), estInputTokens: Count, reservedOutputTokens: Count, paid: Paid.optional(),
}).strict();
const Response = z.object({
  usage: z.object({ inputTokens: Count.nullable(), outputTokens: Count.nullable(), cachedInputTokens: Count.nullable(), cacheCreationInputTokens: Count.nullable().optional(), reasoningTokens: Count.nullable(), reportedCostUsd: Money.nullable(), basis: z.enum(["provider_reported", "unknown"]) }).strict(),
  telemetry: z.object({ servedModel: z.string().nullable(), servedProvider: z.string().nullable(), providerAttempts: Count.nullable(), providerAttemptsExact: z.boolean(), cacheHit: z.boolean().nullable(), headers: z.record(z.string(), z.string()) }).strict(),
  httpStatus: z.number().int(),
  webSearch: z.object({ via: z.string(), alwaysOn: z.boolean(), requests: Count, requestsBasis: z.enum(["provider_reported", "assumed"]), citations: z.array(z.object({ url: z.string(), title: z.string().nullable(), text: z.string().nullable() }).strict()) }).strict().optional(),
}); // Intentionally projects ChatResponse onto accounting metadata: never model messages/tools.
export const RequestOutcomeDTOSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("succeeded"), response: Response, servedEndpointId: z.string().nullable(), policyViolation: z.string().optional() }).strict(),
  z.object({ kind: z.enum(["failed", "uncertain"]), httpStatus: z.number().int().optional(), errorKind: z.string(), errorMessage: z.string(), response: Response.optional() }).strict(),
]);

export type ReserveRequestDTO = z.infer<typeof ReserveRequestDTOSchema>;
export type ReservationDTO = z.infer<typeof ReservationDTOSchema>;
export type RequestOutcomeDTO = z.infer<typeof RequestOutcomeDTOSchema>;
export type RequestLedgerPhase = "prepared" | "reserved" | "dispatch_intent" | "settled" | "retired" | "uncertain" | "quarantined";
export interface RequestLedger {
  reserve(input: ReserveRequestDTO): Promise<ReservationDTO>;
  beginDispatch(reservation: ReservationDTO, dispatchId: string): Promise<{ disposition: "fresh" | "replayed" }>;
  reconcile(reservation: ReservationDTO, outcome: RequestOutcomeDTO): Promise<void>;
  receipt(requestId: string): Promise<{ state: RequestLedgerPhase } | null>;
  /** Split adapters consume a process-owned single-use proof immediately before transport. */
  assertDispatch?(reservation: ReservationDTO, dispatchId: string): void;
  drain(): Promise<void>;
}

/** Persistence errors are never provider/transport errors and must not trigger another spend. */
export class RequestPersistenceError extends Error {
  constructor(readonly stage: "reserve" | "dispatch" | "reconcile", readonly requestId: string | null, cause: unknown) {
    super(`request persistence ${stage} failed${requestId ? ` for ${requestId}` : ""}: ${(cause as Error)?.message ?? String(cause)}`, { cause });
    this.name = "RequestPersistenceError";
  }
}
