import type { ResolvedConfig } from "../config/load.js";
import type { Modality, PaidPolicy, ProfileName, TierName } from "../config/schema.js";
import type { Db } from "../storage/db.js";
import type { ArtifactStore } from "../storage/artifacts.js";
import type { StoredTask } from "../storage/tasks.js";
import type { Catalog, RoutingOverride } from "../models/catalog.js";
import type { Gate } from "../gateway/gate.js";
import { effectiveBudget } from "../admission/admission.js";
import { loadSources } from "../context/sources.js";
import { qualificationLookup } from "../qualification/stats.js";
import { Classifier } from "../scoring/classifier.js";
import { loadRulebook, rulebookFingerprint, type Rulebook } from "../scoring/rulebook.js";
import { classifierCouldMatter, decide, featureScore, measureFeatures, bumpTier, type Classification } from "../scoring/score.js";
import { planRoute, type ReviewerQualificationRequirement, type RoutePlan } from "./select.js";

export function modalitiesFromMediaType(mediaType: string): Modality | null {
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("audio/")) return "audio";
  if (mediaType.startsWith("video/")) return "video";
  if (mediaType === "application/pdf") return "file";
  return null;
}

export interface Prepared {
  classification: Classification;
  plan: RoutePlan | null;
  inputModalities: Modality[];
}

/** Classifies tasks with the rulebook (and, when it can matter, the classifier) and plans routes. */
export class TaskRouter {
  readonly rulebook: Rulebook;
  readonly fingerprint: string;
  readonly classifier: Classifier;

  constructor(
    private readonly cfg: ResolvedConfig,
    private readonly db: Db,
    private readonly catalog: Catalog,
    private readonly gate: Gate,
    private readonly artifacts: ArtifactStore,
    private readonly now: () => number = Date.now,
  ) {
    this.rulebook = loadRulebook(cfg.rulebookPath);
    this.fingerprint = rulebookFingerprint(this.rulebook);
    this.classifier = new Classifier(cfg, db, gate, this.fingerprint, () => this.classificationPlan(), now);
  }

  plan(profile: ProfileName, tier: TierName, inputModalities: Modality[], forcedEndpointId?: string, skipQualification = false, paidPolicy?: PaidPolicy, extraOverrides: RoutingOverride[] = []): RoutePlan {
    return planRoute(
      this.cfg,
      this.catalog.endpoints(),
      // Qualification runs measure one model in isolation: routing overrides do not apply.
      skipQualification ? [] : [...this.catalog.routingOverrides(), ...extraOverrides],
      { profile, tier, inputModalities, needsStructuredOutput: false, skipQualification, ...(forcedEndpointId ? { forcedEndpointId } : {}), ...(paidPolicy ? { paidPolicy } : {}) },
      {
        now: new Date(this.now()),
        qualification: qualificationLookup(this.db, this.cfg),
        health: this.gate.health.lookup,
        quarantined: (ep) => this.gate.quarantined(ep),
        ...(this.gate.paid ? { paidPlatforms: this.gate.paid.spend.paidFreeLlmApiPlatforms() } : {}),
      },
    );
  }

  /**
   * Route an independent reviewer: never an endpoint in `avoidEndpoints`, other model families
   * and platforms first, at least `minTotalParametersB`, and qualified reviewers first (or
   * only, when the requirement is `required`). Routing overrides for the profile still apply.
   */
  planReviewer(o: {
    profile: ProfileName;
    tier: TierName;
    inputModalities: Modality[];
    avoidEndpoints: string[];
    avoidFamilies: string[];
    avoidProviders: string[];
    minTotalParametersB: number | null;
    reviewer: ReviewerQualificationRequirement;
  }): RoutePlan {
    return planRoute(
      this.cfg,
      this.catalog.endpoints(),
      this.catalog.routingOverrides(),
      {
        profile: o.profile,
        tier: o.tier,
        inputModalities: o.inputModalities,
        needsStructuredOutput: false,
        avoidEndpoints: o.avoidEndpoints,
        avoidFamilies: o.avoidFamilies,
        avoidProviders: o.avoidProviders,
        ...(o.minTotalParametersB ? { minTotalParametersB: o.minTotalParametersB } : {}),
        reviewer: o.reviewer,
      },
      {
        now: new Date(this.now()),
        qualification: qualificationLookup(this.db, this.cfg),
        health: this.gate.health.lookup,
        quarantined: (ep) => this.gate.quarantined(ep),
        ...(this.gate.paid ? { paidPlatforms: this.gate.paid.spend.paidFreeLlmApiPlatforms() } : {}),
      },
    );
  }

  /** Classification requests are T1 completions; they use the summarize type when configured. */
  private classificationPlan(): RoutePlan {
    const profile: ProfileName = this.cfg.profiles.summarize ? "summarize" : (Object.keys(this.cfg.profiles)[0] as ProfileName);
    return this.plan(profile, "T1", ["text"]);
  }

  inputModalities(task: StoredTask): Modality[] {
    const out = new Set<Modality>(["text"]);
    for (const ref of task.spec.context.artifactRefs ?? []) {
      const m = modalitiesFromMediaType(this.artifacts.get(ref)?.media_type ?? "text/plain");
      if (m) out.add(m);
    }
    return [...out];
  }

  async prepare(task: StoredTask, leaseOwner: string): Promise<Prepared> {
    await this.gate.health.refresh();
    const spec = task.spec;
    const profile = this.cfg.profiles[spec.profile]!;
    const inputModalities = this.inputModalities(task);
    const sources = await loadSources(this.cfg, spec, this.artifacts);
    const features = await measureFeatures(this.cfg, spec, sources, {
      runCount: task.row.run_count,
      attachmentModalities: inputModalities.filter((m) => m !== "text"),
    });
    const detScore = featureScore(this.rulebook, features).reduce((s, l) => s + l.points, 0);
    const base = { rulebookVersion: this.fingerprint, confidence: null, rationale: null, suggestedTier: null };

    let classification: Classification;
    if (profile.mode === "supervisor") {
      // Supervisors are not scored: they run at T3 on the models you chose for the role.
      classification = decide(this.cfg, this.rulebook, spec, features, { ...base, basis: "forced", tags: null });
      classification.tier = "T3";
      classification.rejectReason = null;
      this.db.prepare("UPDATE tasks SET tier = ?, classification_json = ? WHERE id = ?").run("T3", JSON.stringify(classification), task.row.id);
      const chosen: RoutingOverride[] = this.cfg.supervisor.endpoints.map((endpointId) => ({ profile: spec.profile, tier: null, kind: "force", endpointId, allowBelowFloor: true, enabled: true }));
      return { classification, plan: this.plan(spec.profile, "T3", inputModalities, spec.routing?.endpointId, false, this.cfg.supervisor.paid_policy, chosen), inputModalities };
    }
    if (spec.routing?.tier || spec.routing?.endpointId) {
      classification = decide(this.cfg, this.rulebook, spec, features, { ...base, basis: "forced", tags: spec.hints?.tags ?? null });
    } else if (spec.hints?.difficulty || spec.hints?.tags) {
      classification = decide(this.cfg, this.rulebook, spec, features, { ...base, basis: "rules+hint", tags: spec.hints.tags ?? null });
    } else if (profile.classify === "always" || (profile.classify === "auto" && classifierCouldMatter(this.cfg, this.rulebook, detScore))) {
      const verdict = await this.classifier.classify({
        taskId: task.row.id,
        leaseOwner,
        budget: effectiveBudget(this.cfg, spec, null),
        spec,
        specHash: task.row.spec_hash,
        features,
      });
      if (verdict) {
        classification = decide(this.cfg, this.rulebook, spec, features, {
          rulebookVersion: this.fingerprint,
          basis: "rules+classifier",
          tags: verdict.tags,
          confidence: verdict.confidence,
          rationale: verdict.rationale,
          suggestedTier: verdict.suggestedTier,
        });
      } else {
        // Classifier unavailable or invalid: be conservative and round up one tier.
        classification = decide(this.cfg, this.rulebook, spec, features, { ...base, basis: "rules+classifier_failed", tags: null });
        if (classification.tier !== "T4") {
          classification.tier = bumpTier(classification.tier);
          classification.breakdown.push({ rule: "classifier_failed", points: 0, detail: `classifier unavailable: rounded up to ${classification.tier}` });
        }
      }
    } else {
      classification = decide(this.cfg, this.rulebook, spec, features, { ...base, basis: "rules", tags: null });
    }

    this.db.prepare("UPDATE tasks SET tier = ?, classification_json = ? WHERE id = ?").run(classification.tier, JSON.stringify(classification), task.row.id);
    if (classification.tier === "T4") {
      // Premium: T4 work goes to paid models (at T3 limits) instead of back to the supervisor.
      if (this.cfg.paid.enabled && this.cfg.paid.tiers.T4 === "premium" && !classification.rejectReason?.includes("clarification")) {
        const plan = this.plan(spec.profile, "T3", inputModalities, spec.routing?.endpointId, false, "premium");
        if (plan.candidates.length) return { classification, plan, inputModalities };
      }
      return { classification, plan: null, inputModalities };
    }
    const qualifying = (task.row as typeof task.row & { purpose?: string }).purpose === "qualification";
    return { classification, plan: this.plan(spec.profile, classification.tier, inputModalities, spec.routing?.endpointId, qualifying), inputModalities };
  }
}
