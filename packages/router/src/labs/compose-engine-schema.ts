import { z } from "zod";
import { ComposeCapabilitiesSchema } from "./compose-recipe.js";
import {
  ComposeContainerInspectSchema, ComposeEngineBaselineSchema, ComposeFullResourceIdSchema, ComposeImageIdSchema,
  ComposeHostConfigSchema, ComposeNetworkInspectSchema, ComposeResourceApprovalSchema,
  ComposeResourceCreationReceiptSchema, ComposeResourceIdentitySchema,
} from "./compose-ownership-schema.js";

const Sha = z.string().regex(/^[a-f0-9]{64}$/);
const Name = z.string().regex(/^[a-z][a-z0-9-]{0,40}$/);
const Text = z.string().max(8192).refine(value => !value.includes("\0"));
const Args = z.array(z.string().max(16000).refine(value => !value.includes("\0"))).max(100);
const Labels = z.record(z.string().max(200), Text).refine(value => Object.keys(value).length <= 200);
const Empty = z.object({}).strict();
const OperationId = z.string().min(1).max(200);

/** Trusted caller input, NOT host attestation. No installed/accepted profile ships here. */
export const ComposeEngineProfileSchema = z.object({
  version: z.literal(1), apiVersion: z.literal("1.51"),
  profileSha256: Sha, engine: ComposeCapabilitiesSchema,
  platform: z.string().regex(/^linux\/(amd64|arm64)(\/v[1-9][0-9]*)?$/),
  baseline: ComposeEngineBaselineSchema, appArmorProfile: Text,
}).strict();

export const ComposeEngineBuildInputSchema = z.object({
  approval: ComposeResourceApprovalSchema,
  original: ComposeResourceIdentitySchema,
  current: ComposeResourceIdentitySchema,
  profile: ComposeEngineProfileSchema,
  effect: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("create_network"), operationId: OperationId }).strict(),
    z.object({
      kind: z.literal("create_container"), operationId: OperationId, service: Name,
      network: ComposeResourceCreationReceiptSchema,
    }).strict(),
    z.object({
      kind: z.enum(["inspect", "start", "stop", "remove"]), operationId: OperationId,
      resource: ComposeResourceCreationReceiptSchema,
    }).strict(),
  ]),
}).strict();

export const ComposeEngineNetworkBodySchema = z.object({
  Name: Text, Driver: z.literal("bridge"), Scope: z.literal("local"),
  Internal: z.literal(false), Attachable: z.literal(false), Ingress: z.literal(false),
  EnableIPv6: z.literal(false),
  Labels, Options: Empty, IPAM: z.object({ Driver: z.literal("default"), Options: Empty }).strict(),
}).strict();

export const ComposeEngineContainerBodySchema = z.object({
  Image: z.string().max(300), Entrypoint: Args, Cmd: Args,
  Env: z.array(z.string().max(65737).refine(value => !value.includes("\0"))).max(200),
  User: z.string().max(200), WorkingDir: Text, Labels,
  ExposedPorts: z.record(z.string().regex(/^[0-9]{1,5}\/tcp$/), Empty)
    .refine(value => Object.keys(value).length <= 100),
  Volumes: Empty, Tty: z.literal(false), OpenStdin: z.literal(false), StdinOnce: z.literal(false),
  AttachStdin: z.literal(false), AttachStdout: z.literal(false), AttachStderr: z.literal(false),
  Domainname: z.literal(""), StopSignal: z.string().max(30),
  HostConfig: ComposeHostConfigSchema,
  // HostConfig.NetworkMode pins the committed network ID. No name-based endpoint fallback.
}).strict();

const NoQuery = Empty;
const CreateNetwork = z.object({
  operation: z.literal("create_network"), method: z.literal("POST"),
  path: z.literal("/v1.51/networks/create"), query: NoQuery,
  body: ComposeEngineNetworkBodySchema,
}).strict();
const CreateContainer = z.object({
  operation: z.literal("create_container"), method: z.literal("POST"),
  path: z.literal("/v1.51/containers/create"),
  query: z.object({ name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/).max(200), platform: ComposeEngineProfileSchema.shape.platform }).strict(),
  body: ComposeEngineContainerBodySchema,
}).strict();
const ExactRequest = z.object({
  operation: z.enum(["inspect", "start", "stop", "remove"]),
  resourceKind: z.enum(["network", "container"]), resourceId: ComposeFullResourceIdSchema,
  method: z.enum(["GET", "POST", "DELETE"]), path: z.string().max(200),
  query: z.union([NoQuery, z.object({ t: z.literal(10) }).strict(),
    z.object({ force: z.literal(false), v: z.literal(false) }).strict()]), body: z.null(),
}).strict().superRefine((value, ctx) => {
  const base = `/v1.51/${value.resourceKind === "network" ? "networks" : "containers"}/${value.resourceId}`;
  const suffix = value.operation === "inspect" && value.resourceKind === "container" ? "/json"
    : ["start", "stop"].includes(value.operation) ? `/${value.operation}` : "";
  const method = value.operation === "inspect" ? "GET" : value.operation === "remove" ? "DELETE" : "POST";
  const query = value.operation === "stop" ? { t: 10 }
    : value.operation === "remove" && value.resourceKind === "container" ? { force: false, v: false } : {};
  if (value.path !== base + suffix || value.method !== method ||
      JSON.stringify(value.query) !== JSON.stringify(query) ||
      value.resourceKind === "network" && ["start", "stop"].includes(value.operation)) {
    ctx.addIssue({ code: "custom", message: "invalid exact resource request" });
  }
});

export const ComposeEnginePlanSchema = z.object({
  version: z.literal(1), authority: z.literal("none"), runtimeEnabled: z.literal(false),
  operationId: OperationId, original: ComposeResourceIdentitySchema,
  current: ComposeResourceIdentitySchema, profile: ComposeEngineProfileSchema,
  service: Name.nullable(), expectedImageConfigId: ComposeImageIdSchema.nullable(), planSha256: Sha,
  request: z.union([CreateNetwork, CreateContainer, ExactRequest]),
}).strict();
export type ComposeEnginePlan = z.infer<typeof ComposeEnginePlanSchema>;

// Private observation only. A create response is NOT a committed journal receipt.
export const ComposeEngineResponseSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("unknown"), operationId: Text.min(1), planSha256: Sha,
    code: z.enum(["transport_unknown", "cancelled_unknown", "response_invalid"]) }).strict(),
  z.object({ state: z.literal("http"), operationId: Text.min(1), planSha256: Sha,
    engine: ComposeCapabilitiesSchema, sameConnection: z.literal(true),
    status: z.number().int().min(100).max(599),
    body: z.union([
      z.object({ Id: ComposeFullResourceIdSchema, Warning: z.literal("") }).strict(),
      z.object({ Id: ComposeFullResourceIdSchema, Warnings: z.array(z.string().max(8192)).length(0).nullable() }).strict(),
      ComposeContainerInspectSchema, ComposeNetworkInspectSchema, z.null(),
    ]),
  }).strict(),
]);
export type ComposeEngineResponse = z.infer<typeof ComposeEngineResponseSchema>;

/** Implementations must serialize identity check and effect on ONE live checked local channel.
 * No reconnect/retry, context/TCP fallback, discovery adoption or journal writes are implicit.
 * Caller supplies separate live journal fencing and positive resource proof before mutation.
 */
export interface ComposeEnginePort {
  perform(plan: Readonly<ComposeEnginePlan>, signal: AbortSignal): Promise<ComposeEngineResponse>;
}
