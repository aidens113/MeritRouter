import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import YAML from "yaml";
import { z } from "zod";
import { ModalitySchema, ProfileNameSchema, TierNameSchema, type ProfileName } from "../config/schema.js";
import { ConfigError } from "../core/errors.js";
import type { Db } from "../storage/db.js";

export const ParamSourceSchema = z.enum(["override", "manual", "huggingface", "description", "name", "unknown"]);
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

/**
 * Package-owned endpoint record (not FreeLLMAPI's schema). An endpoint is one model served
 * by one FreeLLMAPI platform; its id is `<platform>/<model_id>`.
 */
export const ModelEndpointSchema = z
  .object({
    id: z.string().min(1),
    providerId: z.string().min(1),
    /** FreeLLMAPI `model_id`; with providerId it identifies the served route. */
    gatewayModelId: z.string().min(1),
    providerModelId: z.string().min(1).optional(),
    displayName: z.string().optional(),
    origin: z.enum(["discovered", "manual"]).default("manual"),
    /** FreeLLMAPI models.id, needed to write chain membership. */
    flModelDbId: z.number().int().nullable().default(null),
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
    contextLimitTokens: z.number().int().positive().nullable(),
    outputLimitTokens: z.number().int().positive().nullable(),
    outputLimitSource: z.enum(["provider", "override", "manual", "default"]).default("manual"),
    inputModalities: z.array(ModalitySchema).default(["text"]),
    supportsTools: z.boolean(),
    supportsStructuredOutput: z.boolean(),
    pricing: z
      .object({
        inputUsdPerMillion: z.number().min(0).nullable(),
        outputUsdPerMillion: z.number().min(0).nullable(),
        freeVerified: z.boolean(),
        source: z.string().default("manual"),
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
  .strict();
export type ModelEndpointInput = z.input<typeof ModelEndpointSchema>;
type BaseEndpoint = z.infer<typeof ModelEndpointSchema>;

export interface ModelEndpoint extends BaseEndpoint {
  status: EndpointStatus;
  statusReason: string | null;
  /** FreeLLMAPI single-model chain name (`sy-<hash>`), routed as `auto:<chainName>`. */
  chainName: string;
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
    contextLimitTokens: z.number().int().positive().optional(),
    outputLimitTokens: z.number().int().positive().optional(),
    inputModalities: z.array(ModalitySchema).optional(),
    supportsTools: z.boolean().optional(),
    supportsStructuredOutput: z.boolean().optional(),
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

export function chainNameFor(endpointId: string): string {
  return `sy-${createHash("sha256").update(endpointId).digest("hex").slice(0, 10)}`;
}

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
  if (o.contextLimitTokens !== undefined) next.contextLimitTokens = o.contextLimitTokens;
  if (o.outputLimitTokens !== undefined) {
    next.outputLimitTokens = o.outputLimitTokens;
    next.outputLimitSource = "override";
  }
  if (o.inputModalities) next.inputModalities = o.inputModalities;
  if (o.supportsTools !== undefined) next.supportsTools = o.supportsTools;
  if (o.supportsStructuredOutput !== undefined) next.supportsStructuredOutput = o.supportsStructuredOutput;
  if (o.quotaScopeIds) next.quotaScopeIds = o.quotaScopeIds;
  if (o.note) next.notes = o.note;
  return o.forceStatus ? { ep: next, forceStatus: o.forceStatus } : { ep: next };
}

function computeStatus(ep: BaseEndpoint, forceStatus: "active" | "disabled" | undefined, requireConfirmation: boolean): { status: EndpointStatus; reason: string | null } {
  if (!ep.enabled && ep.origin === "discovered" && !ep.available) return { status: "removed", reason: "no longer offered by FreeLLMAPI" };
  if (forceStatus === "disabled") return { status: "disabled", reason: "disabled manually" };
  if (!ep.enabled) return { status: "disabled", reason: "disabled in catalog" };
  if (forceStatus === "active") return { status: "active", reason: "enabled manually" };
  if (ep.totalParametersB === null) return { status: "pending_confirmation", reason: "parameter count unknown: enter it to enable this model" };
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
    private readonly opts: { requireConfirmationForHeuristicParams: boolean },
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
    return `${this.version()}:${this.yamlMtime()}`;
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
      out.push({ ...cur.ep, status: s.status, statusReason: s.reason, chainName: chainNameFor(ep.id) });
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

  /** Persist discovered endpoint records. Rows not in `seen` are marked unavailable. */
  saveDiscovered(records: BaseEndpoint[], now = Date.now()): void {
    const upsert = this.db.prepare(
      `INSERT INTO endpoints (id, data_json, first_seen_at, last_scanned_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json, last_scanned_at = excluded.last_scanned_at`,
    );
    this.db.transaction(() => {
      const seen = new Set<string>();
      for (const r of records) {
        upsert.run(r.id, JSON.stringify(ModelEndpointSchema.parse(r)), now, now);
        seen.add(r.id);
      }
      for (const row of this.db.prepare("SELECT id, data_json FROM endpoints").all() as { id: string; data_json: string }[]) {
        if (seen.has(row.id)) continue;
        const ep = JSON.parse(row.data_json) as BaseEndpoint;
        if (ep.available === false && ep.enabled === false) continue;
        this.db.prepare("UPDATE endpoints SET data_json = ?, last_scanned_at = ? WHERE id = ?").run(JSON.stringify({ ...ep, available: false, enabled: false }), now, row.id);
      }
    }).immediate();
    this.bump();
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
