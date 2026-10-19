import { statSync } from "node:fs";
import type { Db } from "../storage/db.js";
import type { ResolvedConfig } from "../config/load.js";
import type { ProfileName } from "../config/schema.js";
import type { FreeLlmApiAdmin, FreeLlmApiProfileModel } from "../gateway/freellmapi-admin.js";
import { staticIneligibility } from "./eligibility.js";

export interface PoolVerification {
  gatewayModel: string;
  profile: ProfileName;
  ok: boolean;
  verifiedAt: number;
  problems: string[];
  enabledMembers: Array<{ platform: string; modelId: string; endpointId: string | null }>;
}

/**
 * Checks a FreeLLMAPI curated chain against the package catalog:
 * - the chain exists and does not auto-include new catalog models;
 * - every enabled member maps to a catalog endpoint approved and eligible for the profile.
 * Disabled rows are skipped by FreeLLMAPI routing (router.ts filter(e => e.enabled)).
 */
export class PoolVerifier {
  constructor(
    private readonly db: Db,
    private readonly cfg: ResolvedConfig,
    private readonly admin: FreeLlmApiAdmin | null,
    private readonly now: () => number = Date.now,
  ) {}

  latest(gatewayModel: string): PoolVerification | null {
    const row = this.db
      .prepare("SELECT detail_json FROM pool_verifications WHERE gateway_model = ? ORDER BY verified_at DESC LIMIT 1")
      .get(gatewayModel) as { detail_json: string } | undefined;
    return row ? (JSON.parse(row.detail_json) as PoolVerification) : null;
  }

  /** A verification is fresh when it is within the TTL and newer than the catalog file. */
  freshness(gatewayModel: string): { fresh: boolean; verification: PoolVerification | null } {
    const v = this.latest(gatewayModel);
    if (!v) return { fresh: false, verification: null };
    let catalogMtime = 0;
    try {
      catalogMtime = statSync(this.cfg.catalog.sourcePath).mtimeMs;
    } catch {
      // In-memory catalog.
    }
    const ttl = this.cfg.gateway.pool_verification_ttl_seconds * 1000;
    return { fresh: v.verifiedAt > catalogMtime && this.now() - v.verifiedAt <= ttl, verification: v };
  }

  async verify(profile: ProfileName): Promise<PoolVerification> {
    const pcfg = this.cfg.profiles[profile];
    if (!pcfg) throw new Error(`profile ${profile} is not configured`);
    const gatewayModel = pcfg.gateway_model;
    const problems: string[] = [];
    const enabledMembers: PoolVerification["enabledMembers"] = [];

    if (!this.admin) {
      problems.push(`no admin token (set ${this.cfg.gateway.admin_token_env}) so chain membership cannot be verified`);
    } else {
      const chainName = gatewayModel.slice("auto:".length).toLowerCase();
      const profiles = await this.admin.listProfiles();
      const chain = profiles.find((p) => p.name.toLowerCase() === chainName);
      if (!chain) {
        problems.push(`FreeLLMAPI has no profile named ${chainName}`);
      } else {
        if (chain.auto_include_new_models !== 0) {
          problems.push(`profile ${chain.name} has auto_include_new_models=${chain.auto_include_new_models}; new catalog models could join it`);
        }
        const models: FreeLlmApiProfileModel[] = await this.admin.profileModels(chain.id);
        const policy = {
          now: new Date(this.now()),
          maxMetadataAgeDays: this.cfg.models.max_metadata_age_days,
          paidRoutingAllowed: this.cfg.spend.paid_fallback_enabled,
        };
        for (const m of models.filter((x) => x.enabled)) {
          const ep = this.cfg.catalog.endpoints.find((e) => e.providerId === m.platform && e.gatewayModelId === m.model_id);
          enabledMembers.push({ platform: m.platform, modelId: m.model_id, endpointId: ep?.id ?? null });
          if (!ep) {
            problems.push(`enabled member ${m.platform}/${m.model_id} is not in the SwitchYard catalog`);
            continue;
          }
          const reasons = staticIneligibility(ep, profile, pcfg, policy);
          if (reasons.length) problems.push(`enabled member ${ep.id}: ${reasons.join("; ")}`);
        }
        if (enabledMembers.length === 0) problems.push(`profile ${chain.name} has no enabled members`);
      }
    }

    const result: PoolVerification = {
      gatewayModel,
      profile,
      ok: problems.length === 0,
      verifiedAt: this.now(),
      problems,
      enabledMembers,
    };
    this.db
      .prepare("INSERT INTO pool_verifications (gateway_model, verified_at, ok, detail_json) VALUES (?, ?, ?, ?)")
      .run(gatewayModel, result.verifiedAt, result.ok ? 1 : 0, JSON.stringify(result));
    return result;
  }

  /** Re-verify when stale. Returns a denial reason, or null when dispatch may proceed. */
  async ensureVerified(profile: ProfileName): Promise<string | null> {
    if (!this.cfg.gateway.require_verified_pools) return null;
    const gatewayModel = this.cfg.profiles[profile]!.gateway_model;
    let { fresh, verification } = this.freshness(gatewayModel);
    if (!fresh) {
      try {
        verification = await this.verify(profile);
      } catch (err) {
        return `pool ${gatewayModel} verification failed: ${(err as Error).message}`;
      }
    }
    if (!verification!.ok) return `pool ${gatewayModel} failed verification: ${verification!.problems.join("; ")}`;
    return null;
  }
}
