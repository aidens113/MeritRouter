import { z } from "zod";
const cap = z.number().int().min(0).max(100_000);
export const MemoryContextConfigSchema = z.object({
  enabled: z.boolean().default(true),
  role_tokens: z.object({ supervisor: cap.default(12_000), reviewer: cap.default(6000), implementer: cap.default(4000), analyst: cap.default(4000), inspector: cap.default(4000), summarizer: cap.default(2000), classifier: cap.default(2000) }).strict().prefault({}),
}).strict().prefault({});
export const MemoryManifestSchema = z.object({
  schemaVersion: z.literal(1), role: z.string(), project: z.string(), generatedAt: z.number().int(), tokenBudget: cap,
  estimatedTokens: z.number().int().nonnegative(),
  entries: z.array(z.object({ ref: z.string(), digest: z.string().regex(/^[a-f0-9]{64}$/), reason: z.string(), estimatedTokens: z.number().int().nonnegative() }).strict()),
  omissions: z.array(z.object({ ref: z.string(), reason: z.string() }).strict()),
}).strict();
export type MemoryManifest = z.infer<typeof MemoryManifestSchema>;
