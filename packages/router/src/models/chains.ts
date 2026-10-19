import type { Db } from "../storage/db.js";
import type { ResolvedConfig } from "../config/load.js";
import type { FreeLlmApiAdmin, FreeLlmApiProfile } from "../gateway/freellmapi-admin.js";
import type { Catalog, ModelEndpoint } from "./catalog.js";

export interface ChainVerification {
  chainName: string;
  endpointId: string;
  ok: boolean;
  verifiedAt: number;
  problems: string[];
  enabledMembers: Array<{ platform: string; modelId: string }>;
}

/**
 * Each routable endpoint gets its own FreeLLMAPI chain `sy-<hash>` containing exactly that
 * model, created empty so catalog sync never adds members (auto_include_new_models = 0).
 * SwitchYard picks the endpoint; FreeLLMAPI only rotates keys within it.
 */
export class ChainManager {
  private profilesCache: { at: number; profiles: FreeLlmApiProfile[] } | null = null;

  constructor(
    private readonly db: Db,
    private readonly cfg: ResolvedConfig,
    private readonly catalog: Catalog,
    private readonly admin: FreeLlmApiAdmin | null,
    private readonly now: () => number = Date.now,
  ) {}

  get adminAvailable(): boolean {
    return this.admin !== null;
  }

  private async profiles(fresh = false): Promise<FreeLlmApiProfile[]> {
    if (!this.admin) throw new Error(`no admin token (set ${this.cfg.gateway.admin_token_env})`);
    if (!fresh && this.profilesCache && this.now() - this.profilesCache.at < 30_000) return this.profilesCache.profiles;
    const profiles = await this.admin.listProfiles();
    this.profilesCache = { at: this.now(), profiles };
    return profiles;
  }

  latest(chainName: string): ChainVerification | null {
    const row = this.db
      .prepare("SELECT detail_json FROM pool_verifications WHERE gateway_model = ? ORDER BY verified_at DESC, id DESC LIMIT 1")
      .get(chainName) as { detail_json: string } | undefined;
    return row ? (JSON.parse(row.detail_json) as ChainVerification) : null;
  }

  private record(v: ChainVerification): ChainVerification {
    this.db
      .prepare("INSERT INTO pool_verifications (gateway_model, verified_at, ok, detail_json) VALUES (?, ?, ?, ?)")
      .run(v.chainName, v.verifiedAt, v.ok ? 1 : 0, JSON.stringify(v));
    return v;
  }

  async verify(ep: ModelEndpoint): Promise<ChainVerification> {
    const problems: string[] = [];
    const enabledMembers: ChainVerification["enabledMembers"] = [];
    try {
      const chain = (await this.profiles(true)).find((p) => p.name.toLowerCase() === ep.chainName.toLowerCase());
      if (!chain) problems.push(`chain ${ep.chainName} does not exist in FreeLLMAPI (run a scan to sync chains)`);
      else {
        if (chain.auto_include_new_models !== 0) problems.push(`chain ${ep.chainName} auto-includes new models`);
        const members = (await this.admin!.profileModels(chain.id)).filter((m) => m.enabled);
        for (const m of members) enabledMembers.push({ platform: m.platform, modelId: m.model_id });
        const ok = members.length === 1 && members[0]!.platform === ep.providerId && members[0]!.model_id === ep.gatewayModelId;
        if (!ok) problems.push(`chain ${ep.chainName} must contain exactly ${ep.id}; found [${enabledMembers.map((m) => `${m.platform}/${m.modelId}`).join(", ")}]`);
      }
    } catch (err) {
      problems.push((err as Error).message);
    }
    return this.record({ chainName: ep.chainName, endpointId: ep.id, ok: problems.length === 0, verifiedAt: this.now(), problems, enabledMembers });
  }

  /** Create or repair the endpoint's chain so it contains exactly this model. */
  async sync(ep: ModelEndpoint): Promise<ChainVerification> {
    if (!this.admin) throw new Error(`no admin token (set ${this.cfg.gateway.admin_token_env})`);
    if (ep.flModelDbId === null) {
      return this.record({ chainName: ep.chainName, endpointId: ep.id, ok: false, verifiedAt: this.now(), problems: ["endpoint has no FreeLLMAPI model id (manual entry); create its chain by hand"], enabledMembers: [] });
    }
    let chain = (await this.profiles(true)).find((p) => p.name.toLowerCase() === ep.chainName.toLowerCase());
    if (!chain) chain = await this.admin.createEmptyProfile(ep.chainName);
    await this.admin.setProfileMembers(chain.id, [{ modelDbId: ep.flModelDbId, priority: 1, enabled: true }]);
    this.profilesCache = null;
    return this.verify(ep);
  }

  /** Empty the chain of a disabled/removed endpoint so nothing can route through it. */
  async disable(ep: ModelEndpoint): Promise<void> {
    if (!this.admin) return;
    const chain = (await this.profiles(true)).find((p) => p.name.toLowerCase() === ep.chainName.toLowerCase());
    if (chain) await this.admin.setProfileMembers(chain.id, []);
    this.profilesCache = null;
  }

  freshness(ep: ModelEndpoint): { fresh: boolean; verification: ChainVerification | null } {
    const v = this.latest(ep.chainName);
    if (!v) return { fresh: false, verification: null };
    return { fresh: this.now() - v.verifiedAt <= this.cfg.gateway.chain_verification_ttl_seconds * 1000, verification: v };
  }

  /** Denial reason when the endpoint's chain cannot be trusted right now, else null. */
  async ensureVerified(ep: ModelEndpoint): Promise<string | null> {
    if (!this.cfg.gateway.require_verified_chains) return null;
    let { fresh, verification } = this.freshness(ep);
    if (!fresh) {
      if (!this.admin) return `chain for ${ep.id} cannot be verified: set ${this.cfg.gateway.admin_token_env} or disable gateway.require_verified_chains`;
      verification = await this.verify(ep);
    }
    return verification!.ok ? null : `chain for ${ep.id} failed verification: ${verification!.problems.join("; ")}`;
  }
}
