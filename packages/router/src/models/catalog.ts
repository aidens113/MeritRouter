import { existsSync, readFileSync, statSync } from "node:fs";
import YAML from "yaml";
import { z } from "zod";
import { ModalitySchema, ProfileNameSchema, TierNameSchema, type ProfileName } from "../config/schema.js";
import { ConfigError } from "../core/errors.js";
import type { Db } from "../storage/db.js";

export const ParamSourceSchema = z.enum(["override", "manual", "provider", "huggingface", "description", "name", "unknown"]);
export const ParamConfidenceSchema = z.enum(["exact", "agreed", "heuristic", "unknown"]);
export const EndpointStatusSchema = z.enum(["active", "pending_confirmation", "disabled", "removed"]);
export type EndpointStatus = z.infer<typeof EndpointStatusSchema>;

const EvidenceSchema = z.object({
  source: ParamSourceSchema,
  totalB: z.number().positive().nullable(),
  activeB: z.number().positive().nullable(),
  detail: z.string(),
});
export type ParamEvidence = z.infer<typeof EvidenceSchema>;

/** How requests reach the model: its provider and the provider's own model id. */
export const EndpointRouteSchema = z
  .object({
    kind: z.literal("direct", { error: "the only route is direct: delete route (it defaults to providerId and gatewayModelId) or set kind: direct" }),
    provider: z.string().min(1),
    model: z.string().min(1),
  })
  .strict();
export type EndpointRoute = z.infer<typeof EndpointRouteSchema>;

/**
 * How a provider is asked to search the web inside the model call (decision D9 of the web-search
 * working document): `openrouter_plugin` (OpenRouter's `plugins: [{id: "web"}]`, the same as the
 * `:online` suffix), `openai_web_search_options` (Chat Completions `web_search_options`),
 * `anthropic_server_tool` (the Messages API `web_search` server tool), or `always_on` (the model
 * searches on every request and nothing is sent to turn it on).
 */
export const NATIVE_WEB_SEARCH_VIAS = ["openrouter_plugin", "openai_web_search_options", "anthropic_server_tool", "always_on"] as const;
export const NativeWebSearchViaSchema = z.enum(NATIVE_WEB_SEARCH_VIAS);
export type NativeWebSearchVia = z.infer<typeof NativeWebSearchViaSchema>;

/**
 * An endpoint's built-in web search, with provenance. `usdPerSearch` null means the price is
 * unknown: it counts as paid, an optional search is never enabled, and an `always_on` model is
 * not routed until an override states the price.
 */
export const NativeWebSearchSchema = z
  .object({
    via: NativeWebSearchViaSchema,
    /** OpenRouter plugin engine: `native` (the model's own provider searches) or `exa`. */
    engine: z.enum(["native", "exa"]).optional(),
    usdPerSearch: z.number().min(0).nullable(),
    /** Where the price came from (a model list field, a documented fact, an override). */
    priceDetail: z.string().optional(),
    /** registry: a documented fact; discovery: the provider's model metadata; override or manual: the user. */
    source: z.enum(["registry", "discovery", "override", "manual"]),
    detail: z.string(),
    sourceUrl: z.string().optional(),
    checkedAt: z.string().optional(),
  })
  .strict();
export type NativeWebSearch = z.infer<typeof NativeWebSearchSchema>;

/** The user's statement of an endpoint's native web search (models file or panel); null in an override removes it. */
export const NativeWebSearchOverrideSchema = z
  .object({
    via: NativeWebSearchViaSchema,
    engine: z.enum(["native", "exa"]).optional(),
    usdPerSearch: z.number().min(0).nullable(),
    note: z.string().optional(),
  })
  .strict();

/**
 * Package-owned endpoint record. An endpoint is one model served by one provider; its id is
 * `<provider>/<model_id>`. Without a `route`, requests go to provider `providerId` for model
 * `gatewayModelId`.
 */
export const ModelEndpointSchema = z
  .object({
    id: z.string().min(1),
    providerId: z.string().min(1),
    /** The provider's model id; with providerId it identifies the served route. */
    gatewayModelId: z.string().min(1),
    providerModelId: z.string().min(1).optional(),
    displayName: z.string().optional(),
    origin: z.enum(["discovered", "manual", "paid"]).default("manual"),
    /** The provider and model requests go to (defaults to providerId and gatewayModelId). */
    route: EndpointRouteSchema.optional(),
    /** Closed models publish no size; exempt them from parameter floors (shown in explanations). */
    ignoreSizeFloor: z.boolean().default(false),
    quotaScopeIds: z.array(z.string().min(1)).default([]),
    totalParametersB: z.number().positive().nullable(),
    activeParametersB: z.number().positive().nullable(),
    params: z
      .object({
        source: ParamSourceSchema,
        confidence: ParamConfidenceSchema,
        confirmed: z.boolean().default(false),
        evidence: z.array(EvidenceSchema).default([]),
      })
      .prefault({ source: "manual", confidence: "exact", confirmed: true }),
    maxContextTokens: z.number().int().positive().nullable().optional(),
    quantization: z.string().nullable().optional(),
    contextDetail: z.string().nullable().optional(),
    contextLimitTokens: z.number().int().positive().nullable(),
    outputLimitTokens: z.number().int().positive().nullable(),
    outputLimitSource: z.enum(["provider", "override", "manual", "default"]).default("manual"),
    inputModalities: z.array(ModalitySchema).default(["text"]),
    /** Null when no source reports it: unknown support is excluded from work that needs it, never guessed. */
    supportsTools: z.boolean().nullable(),
    supportsStructuredOutput: z.boolean().nullable(),
    /** Web search inside the model call; absent or null: none known. */
    nativeWebSearch: NativeWebSearchSchema.nullable().optional(),
    pricing: z
      .object({
        inputUsdPerMillion: z.number().min(0).nullable(),
        outputUsdPerMillion: z.number().min(0).nullable(),
        /**
         * Price of input tokens the provider serves from its prompt cache. Unset or null: cached
         * input is priced as ordinary input (never guessed).
         */
        cachedInputUsdPerMillion: z.number().min(0).nullable().optional(),
        /** Where `cachedInputUsdPerMillion` came from (a model list, paid.models, an override). */
        cachedInputSource: z.string().optional(),
        cacheWriteInputUsdPerMillion: z.number().min(0).nullable().optional(),
        cacheWriteInputSource: z.string().optional(),
        freeVerified: z.boolean(),
        source: z.string().default("manual"),
        /**
         * Why a direct endpoint is free: `model` (a `:free` or $0 model: any key serves it without
         * charge) or `key` (free only through a `free_tier` key: other keys would bill it).
         */
        freeBasis: z.enum(["model", "key"]).optional(),
      })
      .strict(),
    rateLimits: z
      .object({ rpm: z.number().nullable(), rpd: z.number().nullable(), tpm: z.number().nullable(), tpd: z.number().nullable() })
      .partial()
      .optional(),
    /** Platform-reported availability (catalog enabled flag, provider keys present). */
    available: z.boolean().default(true),
    /** Set false to stop routing (removed, re-priced, lost a capability). */
    enabled: z.boolean().default(true),
    deniedProfiles: z.array(ProfileNameSchema).default([]),
    notes: z.string().optional(),
    sourceUrls: z.array(z.string()).default([]),
    checkedAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .transform((ep) => ({ ...ep, route: ep.route ?? { kind: "direct" as const, provider: ep.providerId, model: ep.gatewayModelId } }));
export type ModelEndpointInput = z.input<typeof ModelEndpointSchema>;
type BaseEndpoint = z.infer<typeof ModelEndpointSchema>;

export interface ModelEndpoint extends BaseEndpoint {
  status: EndpointStatus;
  statusReason: string | null;
}

/** Manual corrections applied on top of discovered metadata (YAML file or panel). */
export const EndpointOverrideSchema = z
  .object({
    totalParametersB: z.number().positive().nullable().optional(),
    activeParametersB: z.number().positive().nullable().optional(),
    /** Accept heuristic parameter evidence as correct. */
    confirmParams: z.boolean().optional(),
    forceStatus: z.enum(["active", "disabled"]).optional(),
    deniedProfiles: z.array(ProfileNameSchema).optional(),
    freeVerified: z.boolean().optional(),
    /** USD per million cached input tokens (null clears it: cached input at the input price). */
    cachedInputUsdPerMillion: z.number().min(0).nullable().optional(),
    contextLimitTokens: z.number().int().positive().optional(),
    outputLimitTokens: z.number().int().positive().optional(),
    inputModalities: z.array(ModalitySchema).optional(),
    supportsTools: z.boolean().optional(),
    supportsStructuredOutput: z.boolean().optional(),
    /** Set the endpoint's native web search (price included); null: the endpoint has none. */
    nativeWebSearch: NativeWebSearchOverrideSchema.nullable().optional(),
    quotaScopeIds: z.array(z.string()).optional(),
    note: z.string().optional(),
  })
  .strict();
export type EndpointOverride = z.infer<typeof EndpointOverrideSchema>;

const CatalogFileSchema = z
  .object({
    version: z.literal(1),
    endpoints: z.array(ModelEndpointSchema).default([]),
    overrides: z.record(z.string(), EndpointOverrideSchema).default({}),
  })
  .strict();

export const RoutingOverrideSchema = z
  .object({
    id: z.number().int().optional(),
    profile: ProfileNameSchema.nullable(),
    tier: TierNameSchema.nullable(),
    kind: z.enum(["force", "prefer", "block"]),
    endpointId: z.string().min(1),
    /** Force only: allow a model below the size floor (recorded on every request). */
    allowBelowFloor: z.boolean().default(false),
    note: z.string().optional(),
    enabled: z.boolean().default(true),
  })
  .strict();
export type RoutingOverride = z.infer<typeof RoutingOverrideSchema>;

export function endpointIdFor(platform: string, modelId: string): string {
  return `${platform}/${modelId}`;
}

function applyOverride(ep: BaseEndpoint, o: EndpointOverride | undefined): { ep: BaseEndpoint; forceStatus?: "active" | "disabled" } {
  if (!o) return { ep };
  const next: BaseEndpoint = { ...ep, params: { ...ep.params, evidence: [...ep.params.evidence] }, pricing: { ...ep.pricing } };
  if (o.totalParametersB !== undefined || o.activeParametersB !== undefined) {
    if (o.totalParametersB !== undefined) next.totalParametersB = o.totalParametersB;
    if (o.activeParametersB !== undefined) next.activeParametersB = o.activeParametersB;
    next.params = { ...next.params, source: "override", confidence: "exact", confirmed: true };
  }
  if (o.confirmParams) next.params.confirmed = true;
  if (o.deniedProfiles) next.deniedProfiles = o.deniedProfiles;
  if (o.freeVerified !== undefined) next.pricing = { ...next.pricing, freeVerified: o.freeVerified, source: "override" };
  if (o.cachedInputUsdPerMillion !== undefined) next.pricing = { ...next.pricing, cachedInputUsdPerMillion: o.cachedInputUsdPerMillion, cachedInputSource: "override" };
  if (o.contextLimitTokens !== undefined) next.contextLimitTokens = o.contextLimitTokens;
  if (o.outputLimitTokens !== undefined) {
    next.outputLimitTokens = o.outputLimitTokens;
    next.outputLimitSource = "override";
  }
  if (o.inputModalities) next.inputModalities = o.inputModalities;
  if (o.supportsTools !== undefined) next.supportsTools = o.supportsTools;
  if (o.supportsStructuredOutput !== undefined) next.supportsStructuredOutput = o.supportsStructuredOutput;
  if (o.nativeWebSearch !== undefined) {
    const n = o.nativeWebSearch;
    next.nativeWebSearch =
      n === null ? null : { via: n.via, ...(n.engine ? { engine: n.engine } : {}), usdPerSearch: n.usdPerSearch, priceDetail: "override", source: "override", detail: n.note ?? "user override" };
  }
  if (o.quotaScopeIds) next.quotaScopeIds = o.quotaScopeIds;
  if (o.note) next.notes = o.note;
  return o.forceStatus ? { ep: next, forceStatus: o.forceStatus } : { ep: next };
}

function computeStatus(ep: BaseEndpoint, forceStatus: "active" | "disabled" | undefined, requireConfirmation: boolean): { status: EndpointStatus; reason: string | null } {
  if (!ep.enabled && ep.origin === "discovered" && !ep.available) return { status: "removed", reason: `no longer listed by ${ep.route.provider}` };
  if (forceStatus === "disabled") return { status: "disabled", reason: "disabled manually" };
  if (!ep.enabled) return { status: "disabled", reason: "disabled in catalog" };
  if (forceStatus === "active") return { status: "active", reason: "enabled manually" };
  if (ep.totalParametersB === null && !ep.ignoreSizeFloor) return { status: "pending_confirmation", reason: "parameter count unknown: enter it to enable this model" };
  if (ep.origin === "paid" && !ep.available) return { status: "disabled", reason: "paid routing is off or no enabled key for this provider" };
  if (requireConfirmation && ep.params.confidence === "heuristic" && !ep.params.confirmed) {
    return { status: "pending_confirmation", reason: `parameter count ${ep.totalParametersB}B comes only from the model name/description: confirm it` };
  }
  return { status: "active", reason: null };
}

/**
 * The live endpoint catalog: discovered rows in SQLite, manual endpoints and overrides from the
 * optional models YAML, and panel overrides in SQLite. Cached until any source changes.
 */
export class Catalog {
  private cache: { key: string; endpoints: ModelEndpoint[] } | null = null;

  constructor(
    private readonly db: Db,
    readonly yamlPath: string | null,
    private readonly opts: {
      requireConfirmationForHeuristicParams: boolean;
      /** Endpoints defined elsewhere (configured paid models), with a change fingerprint. */
      extra?: { list: () => ModelEndpointInput[]; key: () => string };
    },
  ) {
    if (yamlPath && !existsSync(yamlPath)) throw new ConfigError(`model catalog not found: ${yamlPath}`);
    if (yamlPath) this.readYaml(); // fail fast on an invalid file
  }

  version(): number {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'catalog_version'").get() as { value: string } | undefined;
    return row ? Number(row.value) : 0;
  }

  bump(): void {
    this.db
      .prepare("INSERT INTO meta (key, value) VALUES ('catalog_version', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1")
      .run();
  }

  private yamlMtime(): number {
    if (!this.yamlPath) return 0;
    try {
      return statSync(this.yamlPath).mtimeMs;
    } catch {
      return 0;
    }
  }

  private readYaml(): z.infer<typeof CatalogFileSchema> {
    if (!this.yamlPath) return { version: 1, endpoints: [], overrides: {} };
    let raw: unknown;
    try {
      raw = YAML.parse(readFileSync(this.yamlPath, "utf8")) ?? { version: 1 };
    } catch (err) {
      throw new ConfigError(`cannot parse model catalog ${this.yamlPath}: ${(err as Error).message}`);
    }
    const parsed = CatalogFileSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ConfigError(`invalid model catalog ${this.yamlPath}:\n  ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  ")}`);
    }
    return parsed.data;
  }

  /** Last-change marker for anything that affects routing (catalog, overrides). */
  changeKey(): string {
    return `${this.version()}:${this.yamlMtime()}:${this.opts.extra?.key() ?? ""}`;
  }

  endpoints(): ModelEndpoint[] {
    const key = this.changeKey();
    if (this.cache?.key === key) return this.cache.endpoints;
    const yaml = this.readYaml();
    const base = new Map<string, BaseEndpoint>();
    for (const row of this.db.prepare("SELECT data_json FROM endpoints").all() as { data_json: string }[]) {
      const ep = ModelEndpointSchema.parse(JSON.parse(row.data_json));
      base.set(ep.id, ep);
    }
    for (const ep of yaml.endpoints) base.set(ep.id, ep); // manual entries win over discovery
    for (const raw of this.opts.extra?.list() ?? []) {
      const ep = ModelEndpointSchema.parse(raw);
      base.set(ep.id, ep);
    }
    const dbOverrides = new Map<string, EndpointOverride>();
    for (const row of this.db.prepare("SELECT endpoint_id, data_json FROM endpoint_overrides").all() as { endpoint_id: string; data_json: string }[]) {
      dbOverrides.set(row.endpoint_id, EndpointOverrideSchema.parse(JSON.parse(row.data_json)));
    }
    const out: ModelEndpoint[] = [];
    const routes = new Set<string>();
    for (const ep of base.values()) {
      const route = `${ep.providerId}/${ep.gatewayModelId}`;
      if (routes.has(route)) throw new ConfigError(`model catalog: duplicate route ${route}`);
      routes.add(route);
      let cur = applyOverride(ep, yaml.overrides[ep.id]);
      const panel = applyOverride(cur.ep, dbOverrides.get(ep.id));
      const forceStatus = panel.forceStatus ?? cur.forceStatus;
      cur = panel;
      const s = computeStatus(cur.ep, forceStatus, this.opts.requireConfirmationForHeuristicParams);
      out.push({ ...cur.ep, status: s.status, statusReason: s.reason });
    }
    out.sort((a, b) => a.id.localeCompare(b.id));
    this.cache = { key, endpoints: out };
    return out;
  }

  get(id: string): ModelEndpoint | undefined {
    return this.endpoints().find((e) => e.id === id);
  }

  /** Endpoints that could have served a gateway-reported (provider, model). */
  findServed(servedProvider: string | null, servedModel: string): ModelEndpoint[] {
    const byModel = this.endpoints().filter((e) => e.gatewayModelId === servedModel);
    return servedProvider === null ? byModel : byModel.filter((e) => e.providerId === servedProvider);
  }

  override(id: string): EndpointOverride | null {
    const row = this.db.prepare("SELECT data_json FROM endpoint_overrides WHERE endpoint_id = ?").get(id) as { data_json: string } | undefined;
    return row ? EndpointOverrideSchema.parse(JSON.parse(row.data_json)) : null;
  }

  /** Replace the panel override for an endpoint (null clears it). */
  setOverride(id: string, override: EndpointOverride | null, now = Date.now()): void {
    if (override === null) this.db.prepare("DELETE FROM endpoint_overrides WHERE endpoint_id = ?").run(id);
    else {
      const data = JSON.stringify(EndpointOverrideSchema.parse(override));
      this.db
        .prepare("INSERT INTO endpoint_overrides (endpoint_id, data_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(endpoint_id) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at")
        .run(id, data, now);
    }
    this.bump();
  }

  /**
   * Persist one provider discovery run. Every record is upserted; then, for each provider in
   * `listed` (its model list succeeded), its stored discovered rows not in `records` are marked
   * unavailable and disabled. Other providers, and providers whose listing failed, are untouched.
   */
  saveProviderDiscovery(records: ModelEndpointInput[], listed: readonly string[], now = Date.now()): { saved: number } {
    const upsert = this.db.prepare(
      `INSERT INTO endpoints (id, data_json, first_seen_at, last_scanned_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json, last_scanned_at = excluded.last_scanned_at`,
    );
    const parsed = records.map((r) => ModelEndpointSchema.parse(r));
    const scope = new Set(listed);
    const out = { saved: 0 };
    this.db.transaction(() => {
      const stored = new Map<string, BaseEndpoint>();
      for (const row of this.db.prepare("SELECT id, data_json FROM endpoints").all() as { id: string; data_json: string }[]) {
        const ep = ModelEndpointSchema.safeParse(JSON.parse(row.data_json));
        if (ep.success) stored.set(row.id, ep.data);
      }
      const seen = new Set<string>();
      for (const r of parsed) {
        upsert.run(r.id, JSON.stringify(r), now, now);
        seen.add(r.id);
        out.saved++;
      }
      for (const [id, ep] of stored) {
        if (seen.has(id) || ep.origin !== "discovered" || !scope.has(ep.route.provider)) continue;
        if (!ep.available && !ep.enabled) continue;
        this.db.prepare("UPDATE endpoints SET data_json = ?, last_scanned_at = ? WHERE id = ?").run(JSON.stringify({ ...ep, available: false, enabled: false }), now, id);
      }
    }).immediate();
    this.bump();
    return out;
  }

  /** Stored discovered rows, before overrides. */
  storedEndpoints(): BaseEndpoint[] {
    const out: BaseEndpoint[] = [];
    for (const row of this.db.prepare("SELECT data_json FROM endpoints").all() as { data_json: string }[]) {
      const ep = ModelEndpointSchema.safeParse(JSON.parse(row.data_json));
      if (ep.success) out.push(ep.data);
    }
    return out;
  }

  /** Endpoints defined in the models file (manual entries win over discovery). */
  manualEndpoints(): BaseEndpoint[] {
    return this.readYaml().endpoints;
  }

  /** Overrides by endpoint id: the models file's, with the panel's fields on top. */
  mergedOverrides(): Record<string, EndpointOverride> {
    const out: Record<string, EndpointOverride> = { ...this.readYaml().overrides };
    for (const row of this.db.prepare("SELECT endpoint_id, data_json FROM endpoint_overrides").all() as { endpoint_id: string; data_json: string }[]) {
      out[row.endpoint_id] = { ...out[row.endpoint_id], ...EndpointOverrideSchema.parse(JSON.parse(row.data_json)) };
    }
    return out;
  }

  discoveredRow(id: string): { firstSeenAt: number; lastScannedAt: number } | null {
    const r = this.db.prepare("SELECT first_seen_at, last_scanned_at FROM endpoints WHERE id = ?").get(id) as { first_seen_at: number; last_scanned_at: number } | undefined;
    return r ? { firstSeenAt: r.first_seen_at, lastScannedAt: r.last_scanned_at } : null;
  }

  routingOverrides(): RoutingOverride[] {
    const rows = this.db.prepare("SELECT * FROM routing_overrides ORDER BY id").all() as Array<{
      id: number;
      profile: string | null;
      tier: string | null;
      kind: string;
      endpoint_id: string;
      allow_below_floor: number;
      note: string | null;
      enabled: number;
    }>;
    return rows.map((r) =>
      RoutingOverrideSchema.parse({
        id: r.id,
        profile: r.profile,
        tier: r.tier,
        kind: r.kind,
        endpointId: r.endpoint_id,
        allowBelowFloor: r.allow_below_floor === 1,
        ...(r.note ? { note: r.note } : {}),
        enabled: r.enabled === 1,
      }),
    );
  }

  addRoutingOverride(o: RoutingOverride, now = Date.now()): number {
    const v = RoutingOverrideSchema.parse(o);
    const r = this.db
      .prepare("INSERT INTO routing_overrides (profile, tier, kind, endpoint_id, allow_below_floor, note, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(v.profile, v.tier, v.kind, v.endpointId, v.allowBelowFloor ? 1 : 0, v.note ?? null, v.enabled ? 1 : 0, now);
    this.bump();
    return Number(r.lastInsertRowid);
  }

  updateRoutingOverride(id: number, patch: { enabled?: boolean; note?: string }): void {
    if (patch.enabled !== undefined) this.db.prepare("UPDATE routing_overrides SET enabled = ? WHERE id = ?").run(patch.enabled ? 1 : 0, id);
    if (patch.note !== undefined) this.db.prepare("UPDATE routing_overrides SET note = ? WHERE id = ?").run(patch.note, id);
    this.bump();
  }

  removeRoutingOverride(id: number): void {
    this.db.prepare("DELETE FROM routing_overrides WHERE id = ?").run(id);
    this.bump();
  }
}

export function profilesDenied(ep: ModelEndpoint, profile: ProfileName): boolean {
  return ep.deniedProfiles.includes(profile);
}
