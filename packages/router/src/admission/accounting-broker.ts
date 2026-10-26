import { createHash } from "node:crypto";
import { z } from "zod";
import { RequestIdSchema } from "./request-ledger.js";

const uuid = z.uuid().refine(value => value === value.toLowerCase());
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positive = count.refine(value => value > 0);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().min(1).max(300).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const money = z.number().finite().nonnegative().max(1e12);
export const GlobalRequestOwnerSchema = z.object({ installationId: uuid, projectId: uuid, storeId: uuid, generation: positive }).strict();
export const ReserveGlobalRequestSchema = z.object({
  requestId: RequestIdSchema, owner: GlobalRequestOwnerSchema, payloadDigest: digest, bindingDigest: digest,
  endpointId: z.string().min(1).max(300).refine(value => !/[\u0000-\u001f]/.test(value)), keyRef: id.nullable(),
  providerReservationId: id.nullable(), slot: z.object({ id, nonce: id }).strict().nullable(),
  estimatedInputTokens: count, reservedOutputTokens: count,
  /** Bound by local preparation from actual deadline/lease authority, never model text. */
  dispatchNotAfter: positive,
  participants: z.array(z.object({ taskDigest: digest, ownerDigest: digest, incarnation: z.string().regex(/^[a-f0-9]{32}$/), runCount: positive }).strict()).max(128),
}).strict().refine(value => new Set(value.participants.map(part => part.taskDigest)).size === value.participants.length,
  "Physical request participants must be unique").refine(value => Number.isSafeInteger(value.estimatedInputTokens + value.reservedOutputTokens), "Combined token reservation exceeds supported range");
export type ReserveGlobalRequest = z.infer<typeof ReserveGlobalRequestSchema>;
const tokenPrice = z.object({ in: money, out: money, cachedIn: money.nullable().optional(), cacheWriteIn: money.nullable().optional(), perSearch: money.nullable().optional() }).strict();
/** Trusted host resolver result, never part of a request/model/tool DTO. */
export const GlobalEndpointAuthoritySchema = z.object({
  endpointId: z.string().min(1).max(300), keyRef: id.nullable(), provider: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/),
  platform: z.string().min(1).max(300), enabled: z.boolean(), providerUsageScopes: z.array(z.string().min(1).max(500)).max(16),
  paid: z.object({ price: tokenPrice, maxSearches: count,
    monthlyCapUsd: money.nullable(), prepaidBalanceUsd: money.nullable(), balanceCheckedAt: count.nullable() }).strict().nullable(),
}).strict();
export type GlobalEndpointAuthority = z.infer<typeof GlobalEndpointAuthoritySchema>;
export const GlobalReceiptSchema = z.object({
  requestId: RequestIdSchema, owner: GlobalRequestOwnerSchema, fingerprint: digest,
  state: z.enum(["reserved", "dispatch_intent", "settled", "retired"]), admittedAt: count,
  dispatchId: id.nullable(), outcomeDigest: digest.nullable(),
  outcome: z.enum(["succeeded", "failed", "uncertain"]).nullable(),
  inputTokens: count.nullable(), outputTokens: count.nullable(),
  reservedUsd: money.nullable(), liabilityUsd: money.nullable(), actualUsd: money.nullable(),
  unexpectedLiabilityUsd: money.nullable(), quarantineOutcomeDigest: digest.nullable(), costQuarantined: z.boolean(), quarantineConflict: z.boolean(),
  /** Finite liability fields are only a known minimum when this flag is true. */
  unboundedCost: z.boolean(),
}).strict();
export type GlobalReceipt = z.infer<typeof GlobalReceiptSchema>;
export const GlobalRequestReferenceSchema = z.object({ requestId: RequestIdSchema, fingerprint: digest }).strict();
export type GlobalRequestReference = z.infer<typeof GlobalRequestReferenceSchema>;
export const SettleGlobalRequestSchema = GlobalRequestReferenceSchema.extend({
  outcomeDigest: digest, outcome: z.enum(["succeeded", "failed", "uncertain"]),
  inputTokens: count.nullable(), outputTokens: count.nullable(), actualUsd: money.nullable(),
  costBasis: z.enum(["provider_reported", "computed", "not_billed", "uncertain"]),
  errorCode: z.enum(["none", "aborted", "timeout", "rate_limited", "authentication", "provider_error", "policy", "unknown"]),
}).strict().refine(value => value.costBasis !== "not_billed" || value.actualUsd === 0, "Not-billed accounting requires an exact zero cost");
export type SettleGlobalRequest = z.infer<typeof SettleGlobalRequestSchema>;
export const UnboundedGlobalCostSchema = GlobalRequestReferenceSchema.extend({
  outcomeDigest: digest, minimumUsd: money, code: z.enum(["cache_write_price_unknown", "provider_cost_unknown"]),
}).strict();
export type UnboundedGlobalCost = z.infer<typeof UnboundedGlobalCostSchema>;
export interface RequestAccountingBroker {
  reserveGlobal(input: ReserveGlobalRequest): { disposition: "fresh" | "replayed"; receipt: GlobalReceipt };
  beginDispatchGlobal(reference: GlobalRequestReference, dispatchId: string): { disposition: "fresh" | "replayed"; receipt: GlobalReceipt };
  settleGlobal(input: SettleGlobalRequest): GlobalReceipt;
  quarantineUnboundedCost(input: UnboundedGlobalCost): GlobalReceipt;
  readReceipt(requestId: string): GlobalReceipt | null;
  retireDefinitelyUnsent(reference: GlobalRequestReference): GlobalReceipt;
  listUnresolved(limit?: number): GlobalReceipt[];
}
export function accountingIdentityDigest(projectId: string, taskId: string): string {
  return createHash("sha256").update(JSON.stringify([uuid.parse(projectId), z.string().min(1).max(4096).parse(taskId)])).digest("hex");
}
export function accountingOwnerDigest(owner: string): string {
  return createHash("sha256").update(z.string().min(1).max(4096).parse(owner)).digest("hex");
}
export const globalReservationFingerprint = (input: ReserveGlobalRequest): string => createHash("sha256")
  .update(JSON.stringify(ReserveGlobalRequestSchema.parse(input))).digest("hex");
