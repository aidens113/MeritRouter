import { z } from "zod";
import { BILLING_CLASSES } from "./billing";

/** Request bodies of the Provider keys API. The library validates again before anything is stored. */

const limit = z.number().int("limits are whole numbers").positive("limits must be above 0 (leave empty for none)").nullable();
const money = z.number().min(0).nullable();
export const AccountId = z.string().trim().regex(/^[A-Za-z0-9_-]{1,128}$/, "an account id is letters, digits, dashes, and underscores");
export const QuotaGroup = z.string().trim().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, "a quota group is lowercase letters, digits, dots, dashes, and underscores");
export const ProviderId = z.string().regex(/^[a-z0-9-]+$/, "pick a provider");
const Secret = z.string().trim().min(8, "the key looks too short").max(4000);

export const AddKeyBody = z
  .object({
    provider: ProviderId,
    label: z.string().trim().max(80).default(""),
    secret: Secret,
    billingClass: z.enum(BILLING_CLASSES, { error: "choose a billing class" }),
    accountId: AccountId.nullable().default(null),
    quotaGroup: QuotaGroup.nullable().default(null),
    rpm: limit.default(null),
    rpd: limit.default(null),
    tpm: limit.default(null),
    tpd: limit.default(null),
    monthlyCapUsd: z.number().positive("a monthly cap must be more than $0 (leave it empty for none)").nullable().default(null),
    prepaidBalanceUsd: money.default(null),
    expiresAt: z.number().int().positive().nullable().default(null),
  })
  .strict();

export const KeyPatchBody = z
  .object({
    label: z.string().trim().max(80).optional(),
    enabled: z.boolean().optional(),
    billingClass: z.enum(BILLING_CLASSES).optional(),
    /** Rotate the secret. Write-only, like adding. */
    secret: Secret.optional(),
    accountId: AccountId.nullable().optional(),
    quotaGroup: QuotaGroup.nullable().optional(),
    rpm: limit.optional(),
    rpd: limit.optional(),
    tpm: limit.optional(),
    tpd: limit.optional(),
    monthlyCapUsd: z.number().positive("a monthly cap must be more than $0 (leave it empty for none)").nullable().optional(),
    prepaidBalanceUsd: money.optional(),
    expiresAt: z.number().int().positive().nullable().optional(),
  })
  .strict()
  .refine((p) => Object.values(p).some((v) => v !== undefined), "nothing to change");

/** Test a stored key by ref, or a pasted key before saving it. */
export const KeyTestBody = z.union([
  z.object({ ref: z.string().min(1).max(300) }).strict(),
  z
    .object({
      provider: ProviderId,
      secret: Secret,
      accountId: AccountId.nullable().default(null),
      billingClass: z.enum(BILLING_CLASSES).default("free_tier"),
    })
    .strict(),
]);

export const ScanBody = z.object({ provider: ProviderId }).strict();

export const CustomProviderBody = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "use lowercase letters, digits, and dashes"),
    displayName: z.string().trim().min(1).max(80).optional(),
    baseUrl: z.string().trim().url("enter the server's base URL, e.g. http://localhost:11434/v1"),
    api: z.enum(["openai_compatible", "anthropic"]).default("openai_compatible"),
    noKey: z.boolean().default(false),
    modelsPath: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
