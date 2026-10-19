import type { ResolvedConfig } from "../config/load.js";
import type { Modality } from "../config/schema.js";
import type { Db } from "../storage/db.js";
import type { FreeLlmApiAdmin, FreeLlmApiModel } from "../gateway/freellmapi-admin.js";
import { endpointIdFor, type Catalog, type ModelEndpointInput, type ParamEvidence } from "./catalog.js";
import type { ChainManager } from "./chains.js";
import { parseParamsFromDescription, parseParamsFromName, resolveParams } from "./params.js";

interface OpenRouterModel {
  id: string;
  hugging_face_id?: string | null;
  name?: string;
  description?: string;
  context_length?: number | null;
  architecture?: { input_modalities?: string[] };
  pricing?: { prompt?: string; completion?: string };
  top_provider?: { context_length?: number | null; max_completion_tokens?: number | null };
  supported_parameters?: string[];
}

export interface ScanSummary {
  scanned: number;
  added: string[];
  pendingConfirmation: string[];
  unavailable: string[];
  chainsSynced: number;
  chainsDisabled: number;
  errors: string[];
}

const KNOWN_MODALITIES: Modality[] = ["text", "image", "audio", "video", "file"];

/** Strip routing suffixes and vendor prefix so the same model matches across platforms. */
export function modelKey(id: string): string {
  const base = id.toLowerCase().replace(/:free$|:beta$|-free$/, "");
  return base.includes("/") ? base.slice(base.lastIndexOf("/") + 1) : base;
}

export class Scanner {
  private hfCache = new Map<string, number | null>();

  constructor(
    private readonly db: Db,
    private readonly cfg: ResolvedConfig,
    private readonly catalog: Catalog,
    private readonly chains: ChainManager,
    private readonly admin: FreeLlmApiAdmin | null,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private async json<T>(url: string): Promise<T | null> {
    try {
      const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(20_000), headers: { accept: "application/json" } });
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      return null;
    }
  }

  private async openRouterIndex(): Promise<{ byId: Map<string, OpenRouterModel>; byKey: Map<string, OpenRouterModel> }> {
    const body = await this.json<{ data: OpenRouterModel[] }>(this.cfg.discovery.openrouter_models_url);
    const byId = new Map<string, OpenRouterModel>();
    const byKey = new Map<string, OpenRouterModel>();
    for (const m of body?.data ?? []) {
      byId.set(m.id, m);
      const k = modelKey(m.id);
      if (!byKey.has(k) || m.hugging_face_id) byKey.set(k, m);
    }
    return { byId, byKey };
  }

  /** Exact total parameters (billions) from a Hugging Face repo's safetensors metadata. */
  async huggingFaceTotal(repo: string): Promise<number | null> {
    if (this.hfCache.has(repo)) return this.hfCache.get(repo)!;
    const body = await this.json<{ safetensors?: { total?: number } }>(`${this.cfg.discovery.huggingface_api_url}/${repo}`);
    const total = typeof body?.safetensors?.total === "number" && body.safetensors.total > 0 ? body.safetensors.total / 1e9 : null;
    this.hfCache.set(repo, total);
    return total;
  }

  async describe(fl: FreeLlmApiModel, or: { byId: Map<string, OpenRouterModel>; byKey: Map<string, OpenRouterModel> }): Promise<ModelEndpointInput> {
    const id = endpointIdFor(fl.platform, fl.modelId);
    const onOpenRouter = fl.platform === "openrouter";
    const orExact = onOpenRouter ? (or.byId.get(fl.modelId) ?? or.byId.get(fl.modelId.replace(/:free$/, ""))) : undefined;
    const orModel = orExact ?? or.byKey.get(modelKey(fl.modelId));

    const evidence: ParamEvidence[] = [];
    const fromName = parseParamsFromName(fl.modelId) ?? (fl.displayName ? parseParamsFromName(fl.displayName) : null);
    if (fromName) evidence.push({ source: "name", totalB: fromName.totalB, activeB: fromName.activeB, detail: fromName.detail });
    if (orModel?.description) {
      const d = parseParamsFromDescription(orModel.description);
      if (d) evidence.push({ source: "description", totalB: d.totalB, activeB: d.activeB, detail: `OpenRouter ${orModel.id}: ${d.detail}` });
    }
    if (orModel?.hugging_face_id) {
      const total = await this.huggingFaceTotal(orModel.hugging_face_id);
      evidence.push(
        total !== null
          ? { source: "huggingface", totalB: total, activeB: null, detail: `Hugging Face ${orModel.hugging_face_id} safetensors total ${total.toFixed(1)}B` }
          : { source: "huggingface", totalB: null, activeB: null, detail: `Hugging Face ${orModel.hugging_face_id}: no parameter metadata (gated or missing)` },
      );
    }
    if (fl.sizeLabel) evidence.push({ source: "unknown", totalB: null, activeB: null, detail: `FreeLLMAPI size label "${fl.sizeLabel}" (not numeric; not used)` });
    const params = resolveParams(evidence);

    const modalities = new Set<Modality>(["text"]);
    if (fl.supportsVision) modalities.add("image");
    if (orExact?.architecture?.input_modalities) {
      for (const m of orExact.architecture.input_modalities) if ((KNOWN_MODALITIES as string[]).includes(m)) modalities.add(m as Modality);
      if (!fl.supportsVision) modalities.delete("image");
    }

    const promptPrice = orExact?.pricing?.prompt !== undefined ? Number(orExact.pricing.prompt) * 1e6 : null;
    const completionPrice = orExact?.pricing?.completion !== undefined ? Number(orExact.pricing.completion) * 1e6 : null;
    const declaredFree = this.cfg.discovery.free_platforms.includes(fl.platform);
    const orFree = onOpenRouter && promptPrice === 0 && completionPrice === 0;
    const pricing = declaredFree
      ? { inputUsdPerMillion: 0, outputUsdPerMillion: 0, freeVerified: true, source: `${fl.platform} declared a free platform in config` }
      : orFree
        ? { inputUsdPerMillion: 0, outputUsdPerMillion: 0, freeVerified: true, source: "OpenRouter published price is 0" }
        : { inputUsdPerMillion: promptPrice, outputUsdPerMillion: completionPrice, freeVerified: false, source: onOpenRouter ? "OpenRouter published price" : "not verified" };

    const outputLimit = orExact?.top_provider?.max_completion_tokens ?? null;
    const structured = orExact?.supported_parameters?.some((p) => p === "response_format" || p === "structured_outputs") ?? false;

    return {
      id,
      providerId: fl.platform,
      gatewayModelId: fl.modelId,
      ...(orModel ? { providerModelId: orModel.id } : {}),
      ...(fl.displayName ? { displayName: fl.displayName } : {}),
      origin: "discovered",
      flModelDbId: fl.id,
      quotaScopeIds: [`${fl.platform}:account`],
      totalParametersB: params.totalParametersB,
      activeParametersB: params.activeParametersB,
      params: { source: params.source, confidence: params.confidence, confirmed: params.confidence === "exact" || params.confidence === "agreed", evidence: params.evidence },
      contextLimitTokens: fl.contextWindow ?? orExact?.top_provider?.context_length ?? null,
      outputLimitTokens: outputLimit ?? this.cfg.discovery.default_output_limit_tokens,
      outputLimitSource: outputLimit ? "provider" : "default",
      inputModalities: [...modalities],
      supportsTools: fl.supportsTools,
      supportsStructuredOutput: structured,
      pricing,
      rateLimits: { rpm: fl.rpmLimit, rpd: fl.rpdLimit, tpm: fl.tpmLimit, tpd: fl.tpdLimit },
      available: fl.enabled && fl.hasProvider && fl.keyCount > 0,
      enabled: fl.enabled,
      sourceUrls: [
        ...(orModel ? [`https://openrouter.ai/${orModel.id}`] : []),
        ...(orModel?.hugging_face_id ? [`https://huggingface.co/${orModel.hugging_face_id}`] : []),
      ],
      checkedAt: new Date(this.now()).toISOString(),
    };
  }

  /** Scan FreeLLMAPI's catalog, refresh endpoint metadata, and sync every single-model chain. */
  async scan(): Promise<ScanSummary> {
    const started = this.now();
    const scanId = Number(this.db.prepare("INSERT INTO scans (started_at) VALUES (?)").run(started).lastInsertRowid);
    const summary: ScanSummary = { scanned: 0, added: [], pendingConfirmation: [], unavailable: [], chainsSynced: 0, chainsDisabled: 0, errors: [] };
    try {
      if (!this.admin) throw new Error(`model scanning needs FreeLLMAPI admin access: set ${this.cfg.gateway.admin_token_env}`);
      const [flModels, or] = await Promise.all([this.admin.listModels(), this.openRouterIndex()]);
      if (or.byId.size === 0) summary.errors.push("OpenRouter model metadata unavailable; parameter evidence limited to names");
      const records: ModelEndpointInput[] = [];
      for (const fl of flModels) {
        summary.scanned++;
        if (!this.catalog.discoveredRow(endpointIdFor(fl.platform, fl.modelId))) summary.added.push(endpointIdFor(fl.platform, fl.modelId));
        records.push(await this.describe(fl, or));
      }
      this.catalog.saveDiscovered(records as never, this.now());

      for (const ep of this.catalog.endpoints()) {
        if (ep.status === "pending_confirmation") summary.pendingConfirmation.push(ep.id);
        if (!ep.available) summary.unavailable.push(ep.id);
        try {
          if (ep.status === "active" && ep.available) {
            const f = this.chains.freshness(ep);
            if (!f.verification?.ok || !f.fresh) {
              const v = await this.chains.sync(ep);
              if (v.ok) summary.chainsSynced++;
              else summary.errors.push(`${ep.id}: ${v.problems.join("; ")}`);
            }
          } else if (this.chains.latest(ep.chainName)?.enabledMembers.length) {
            await this.chains.disable(ep);
            summary.chainsDisabled++;
          }
        } catch (err) {
          summary.errors.push(`${ep.id}: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      summary.errors.push((err as Error).message);
    }
    this.db
      .prepare("UPDATE scans SET finished_at = ?, ok = ?, summary_json = ? WHERE id = ?")
      .run(this.now(), summary.errors.length === 0 ? 1 : 0, JSON.stringify(summary), scanId);
    return summary;
  }

  lastScan(): { startedAt: number; finishedAt: number | null; ok: boolean | null; summary: ScanSummary | null } | null {
    const r = this.db.prepare("SELECT * FROM scans ORDER BY id DESC LIMIT 1").get() as
      | { started_at: number; finished_at: number | null; ok: number | null; summary_json: string | null }
      | undefined;
    if (!r) return null;
    return { startedAt: r.started_at, finishedAt: r.finished_at, ok: r.ok === null ? null : r.ok === 1, summary: r.summary_json ? (JSON.parse(r.summary_json) as ScanSummary) : null };
  }
}
