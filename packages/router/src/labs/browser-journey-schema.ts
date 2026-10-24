import path from "node:path";
import { z } from "zod";
import { BrowserArtifactSchema, BrowserAssertionSchema } from "./browser-schema.js";
const Name = z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/);
const Selector = z.string().min(1).max(500);
const RelativeURL = z.string().min(1).max(2000).refine(value => value.startsWith("/") && !value.startsWith("//") && !/[\\\r\n\0]/.test(value), "Navigation must remain relative to the declared service");
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Upload = z.object({ name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/), base64: z.string().max(1398104).regex(/^[a-zA-Z0-9+/]*={0,2}$/), sha256: Digest }).strict();
export const DockerBrowserConfigSchema = z.object({
  backend: z.literal("docker_network_none_v1"),
  executable: z.string().max(1000).refine(path.isAbsolute, "Docker executable must be an absolute trusted path"),
  endpoint: z.string().regex(/^(unix:\/\/\/var\/run\/docker\.sock|npipe:\/\/\/\/\.\/pipe\/(docker_engine|dockerDesktopLinuxEngine))$/),
  image: z.string().min(1).max(500).regex(/^[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64}$/),
  browser: z.string().min(1).max(500).regex(/^\/[a-zA-Z0-9_./-]+$/),
  node: z.string().min(1).max(500).regex(/^\/[a-zA-Z0-9_./-]+$/).default("/usr/local/bin/node"),
  user: z.string().regex(/^[1-9][0-9]{0,8}:[1-9][0-9]{0,8}$/).default("1000:1000"),
}).strict();
export type DockerBrowserConfig = z.infer<typeof DockerBrowserConfigSchema>;
const StepBase = { id: Name, criterionIds: z.array(z.string().min(1).max(200)).min(1).max(30) };
export const BrowserJourneyStepSchema = z.discriminatedUnion("action", [
  z.object({ ...StepBase, action: z.literal("navigate"), path: RelativeURL }).strict(),
  z.object({ ...StepBase, action: z.literal("click"), selector: Selector }).strict(),
  z.object({ ...StepBase, action: z.literal("fill"), selector: Selector, text: z.string().max(16000) }).strict(),
  z.object({ ...StepBase, action: z.literal("key"), key: z.enum(["Enter", "Escape", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Backspace"]) }).strict(),
  z.object({ ...StepBase, action: z.literal("wait_for"), assertion: BrowserAssertionSchema, timeout_ms: z.number().int().min(100).max(15000).default(5000) }).strict(),
  z.object({ ...StepBase, action: z.literal("assert"), assertion: BrowserAssertionSchema }).strict(),
  z.object({ ...StepBase, action: z.literal("reload") }).strict(),
  z.object({ ...StepBase, action: z.literal("screenshot") }).strict(),
  z.object({ ...StepBase, action: z.literal("upload"), selector: Selector, fixture: Name }).strict(),
  z.object({ ...StepBase, action: z.literal("viewport"), width: z.number().int().min(320).max(1920), height: z.number().int().min(200).max(1080), mobile: z.boolean().default(false) }).strict(),
  z.object({ ...StepBase, action: z.literal("restart_service") }).strict(),
]);
export const BrowserJourneyCheckSchema = z.object({
  kind: z.literal("browser"), mode: z.literal("interactive"), service: Name, repo: Name.optional(), on_integrate: z.boolean().default(false),
  path: RelativeURL.default("/"), isolation: DockerBrowserConfigSchema,
  specDigest: Digest, fixtureDigest: Digest.nullable().default(null),
  uploads: z.record(Name, Upload).default({}),
  viewport: z.object({ width: z.number().int().min(320).max(1920), height: z.number().int().min(200).max(1080), mobile: z.boolean().default(false) }).strict().default({ width: 1000, height: 700, mobile: false }),
  timeout_seconds: z.number().int().min(1).max(60).default(60),
  max_resources: z.number().int().min(1).max(500).default(200),
  max_resource_bytes: z.number().int().min(1024).max(4 * 1024 * 1024).default(1024 * 1024),
  max_total_bytes: z.number().int().min(1024).max(32 * 1024 * 1024).default(16 * 1024 * 1024),
  max_request_bytes: z.number().int().min(1).max(1024 * 1024).default(65536),
  methods: z.array(z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"])).min(1).max(6).default(["GET", "HEAD"]),
  expected_api_errors: z.array(z.number().int().min(400).max(599)).max(32).default([400, 401, 403, 409, 422]),
  max_screenshot_bytes: z.number().int().min(1024).max(4 * 1024 * 1024).default(1024 * 1024),
  steps: z.array(BrowserJourneyStepSchema).min(1).max(100),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.steps.map(step => step.id)).size !== value.steps.length)
    ctx.addIssue({ code: "custom", path: ["steps"], message: "Journey step IDs must be unique" });
  if (!value.steps.some(step => step.action === "assert" || step.action === "wait_for"))
    ctx.addIssue({ code: "custom", path: ["steps"], message: "Journeys require an observable assertion; clicks alone are not product evidence" });
  const covered = new Set(value.steps.filter(step => step.action === "assert" || step.action === "wait_for").flatMap(step => step.criterionIds));
  for (const criterion of new Set(value.steps.flatMap(step => step.criterionIds)))
    if (!covered.has(criterion))
      ctx.addIssue({ code: "custom", path: ["steps"], message: `Criterion ${criterion} has actions but no observable assertion` });
  if (value.steps.filter(step => step.action === "screenshot").length > 20)
    ctx.addIssue({ code: "custom", path: ["steps"], message: "At most20 bounded screenshots per journey" });
  if (Object.keys(value.uploads).length > 10 || Object.values(value.uploads).reduce((sum, file) => sum + file.base64.length, 0) > 5592416)
    ctx.addIssue({ code: "custom", path: ["uploads"], message: "Upload fixture aggregate exceeds four MiB" });
  for (const step of value.steps)
    if (step.action === "upload" && !value.uploads[step.fixture])
      ctx.addIssue({ code: "custom", path: ["steps"], message: `Unknown declared upload fixture ${step.fixture}` });
});
export type BrowserJourneyCheck = z.infer<typeof BrowserJourneyCheckSchema>;
export const BrowserJourneyEvidenceSchema = z.object({
  schemaVersion: z.literal(1), mode: z.literal("interactive"), scriptsEnabled: z.boolean(),
  status: z.enum(["passed", "failed", "unavailable", "cancelled"]), cleanup: z.enum(["complete", "blocked"]),
  isolation: z.object({ backend: z.literal("docker_network_none_v1"), generation: z.string().regex(/^[a-f0-9]{32}$/), engineId: z.string().min(1).max(200), imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).nullable(),
  browser: z.object({ product: z.string().max(200), protocolVersion: z.string().max(100) }).nullable(),
  heads: z.record(z.string(), z.string().regex(/^[a-f0-9]{40,64}$/)), trees: z.record(z.string(), z.string().regex(/^[a-f0-9]{40,64}$/)),
  specDigest: Digest, testDigest: Digest, recipeDigest: Digest, environmentDigest: Digest, dependencyDigest: Digest, fixtureDigest: Digest, fixtureAfterDigest: Digest.nullable(), resourceDigest: Digest, serviceIdentities: z.array(Digest).max(101),
  steps: z.array(z.object({ id: Name, criterionIds: z.array(z.string()), action: z.string(), passed: z.boolean(), durationMs: z.number().nonnegative(), detail: z.string().max(2000) }).strict()).max(100),
  console: z.array(z.string().max(2000)).max(20), pageErrors: z.array(z.string().max(2000)).max(20), violations: z.array(z.string().max(2000)).max(20),
  requests: z.number().int().nonnegative().max(501), responseBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  artifacts: z.array(BrowserArtifactSchema).max(20),
  unknowns: z.array(z.string().max(2000)).max(30),
}).strict();
export type BrowserJourneyEvidence = z.infer<typeof BrowserJourneyEvidenceSchema>;
