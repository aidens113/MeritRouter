import { existsSync, readFileSync } from "node:fs";
import YAML from "yaml";
import { z } from "zod";
import { ProfileNameSchema, type ProfileName } from "../config/schema.js";
import { ConfigError } from "../core/errors.js";

/**
 * Package-owned endpoint metadata (not FreeLLMAPI's native schema). Keyed by provider plus
 * exact model identity; limits describe the served endpoint, not the model family.
 */
export const ModelEndpointSchema = z
  .object({
    id: z.string().min(1),
    providerId: z.string().min(1),
    providerModelId: z.string().min(1),
    /** Identity the gateway reports when this endpoint serves a request. */
    gatewayModelId: z.string().min(1),
    /** Real shared-allowance scopes, e.g. `openrouter:account:me`, `kilo:ip:egress`. */
    quotaScopeIds: z.array(z.string().min(1)).default([]),
    totalParametersB: z.number().positive().nullable(),
    activeParametersB: z.number().positive().nullable(),
    contextLimitTokens: z.number().int().positive().nullable(),
    outputLimitTokens: z.number().int().positive().nullable(),
    supportsTools: z.boolean(),
    supportsImages: z.boolean(),
    supportsStructuredOutput: z.boolean(),
    approvedProfiles: z.array(ProfileNameSchema).default([]),
    pricing: z
      .object({
        inputUsdPerMillion: z.number().min(0).nullable(),
        outputUsdPerMillion: z.number().min(0).nullable(),
        freeVerified: z.boolean(),
      })
      .strict(),
    /** Set false when an endpoint is removed, re-priced, or loses a capability. */
    enabled: z.boolean().default(true),
    notes: z.string().optional(),
    sourceUrls: z.array(z.string().url()).min(1),
    checkedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type ModelEndpoint = z.infer<typeof ModelEndpointSchema>;

const CatalogFileSchema = z
  .object({
    version: z.literal(1),
    endpoints: z.array(ModelEndpointSchema),
  })
  .strict();

export interface EndpointCatalog {
  sourcePath: string;
  endpoints: ModelEndpoint[];
}

export function parseEndpointCatalog(raw: unknown, sourcePath: string): EndpointCatalog {
  const parsed = CatalogFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new ConfigError(`invalid model catalog ${sourcePath}:\n  ${issues.join("\n  ")}`);
  }
  const seen = new Set<string>();
  const seenRoute = new Set<string>();
  for (const ep of parsed.data.endpoints) {
    const route = `${ep.providerId}/${ep.gatewayModelId}`;
    if (seen.has(ep.id)) throw new ConfigError(`model catalog ${sourcePath}: duplicate endpoint id ${ep.id}`);
    if (seenRoute.has(route)) throw new ConfigError(`model catalog ${sourcePath}: duplicate route ${route}`);
    seen.add(ep.id);
    seenRoute.add(route);
  }
  return { sourcePath, endpoints: parsed.data.endpoints };
}

export function loadEndpointCatalog(filePath: string): EndpointCatalog {
  if (!existsSync(filePath)) throw new ConfigError(`model catalog not found: ${filePath}`);
  let raw: unknown;
  try {
    raw = YAML.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new ConfigError(`cannot parse model catalog ${filePath}: ${(err as Error).message}`);
  }
  return parseEndpointCatalog(raw, filePath);
}

export function endpointsApprovedFor(catalog: EndpointCatalog, profile: ProfileName): ModelEndpoint[] {
  return catalog.endpoints.filter((e) => e.approvedProfiles.includes(profile));
}

/**
 * Catalog endpoints that could have served a gateway-reported (provider, model). When the
 * provider is unknown, every endpoint with that model id is returned; callers must treat the
 * request as approved only if all of them are approved.
 */
export function findServedEndpoints(
  catalog: EndpointCatalog,
  servedProvider: string | null,
  servedModel: string,
): ModelEndpoint[] {
  const byModel = catalog.endpoints.filter((e) => e.gatewayModelId === servedModel);
  if (servedProvider === null) return byModel;
  return byModel.filter((e) => e.providerId === servedProvider);
}
