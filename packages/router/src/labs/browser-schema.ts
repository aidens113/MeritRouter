import path from "node:path";
import { z } from "zod";
const Name = z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/);
const Selector = z.string().min(1).max(500);
export const BrowserAssertionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exists"), selector: Selector }).strict(),
  z.object({ kind: z.literal("text_contains"), selector: Selector, text: z.string().min(1).max(2000) }).strict(),
  z.object({ kind: z.literal("title_contains"), text: z.string().min(1).max(2000) }).strict(),
]);
/** Explicit static mode never executes application scripts or tests hydration. */
export const BrowserCheckSchema = z.object({
  kind: z.literal("browser"),
  mode: z.literal("static"),
  service: Name,
  path: z.string().min(1).max(2000).default("/").refine(value => value.startsWith("/") && !value.startsWith("//") && !/[\\\r\n\u0000]/.test(value), "path must stay relative to the declared service"),
  executable: z.string().min(1).max(1000).refine(path.isAbsolute, "browser executable must be an absolute human-configured path"),
  repo: Name.optional(),
  on_integrate: z.boolean().default(false),
  viewport: z.object({ width: z.number().int().min(320).max(1920), height: z.number().int().min(200).max(1080) }).strict().default({ width: 1000, height: 700 }),
  timeout_seconds: z.number().min(1).max(60).default(20),
  settle_ms: z.number().int().min(0).max(2000).default(100),
  max_resources: z.number().int().min(1).max(100).default(30),
  max_resource_bytes: z.number().int().min(1024).max(1048576).default(262144),
  max_total_bytes: z.number().int().min(1024).max(8388608).default(2097152),
  screenshot: z.boolean().default(true),
  max_screenshot_bytes: z.number().int().min(1024).max(4194304).default(1048576),
  assertions: z.array(BrowserAssertionSchema).min(1).max(25),
}).strict();
export type BrowserCheck = z.infer<typeof BrowserCheckSchema>;
export const BrowserArtifactSchema = z.object({ id: z.string().max(100).regex(/^lba_[a-z0-9]+$/), mediaType: z.literal("image/png"), bytes: z.number().int().min(1).max(4194304), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const BrowserEvidenceSchema = z.object({
  mode: z.literal("static"), scriptsExecuted: z.literal(false),
  assertions: z.array(z.object({ kind: z.enum(["exists", "text_contains", "title_contains"]), passed: z.boolean(), detail: z.string().max(2000) }).strict()).max(25),
  console: z.array(z.string().max(2000)).max(20),
  pageErrors: z.array(z.string().max(2000)).max(20),
  violations: z.array(z.string().max(2000)).max(20),
  blockedConnections: z.number().int().min(0).max(1000),
  blockedTargets: z.number().int().min(0).max(1000),
  requests: z.number().int().nonnegative().max(101),
  responseBytes: z.number().int().nonnegative().max(8388608),
  heads: z.record(z.string(), z.string().regex(/^[a-f0-9]{40,64}$/)),
  artifacts: z.array(BrowserArtifactSchema).max(1),
}).strict();
export type BrowserEvidence = z.infer<typeof BrowserEvidenceSchema>;
