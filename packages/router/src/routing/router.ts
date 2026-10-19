import type { ResolvedConfig } from "../config/load.js";
import type { Modality, ProfileName, TierName } from "../config/schema.js";
import type { Db } from "../storage/db.js";
import type { ArtifactStore } from "../storage/artifacts.js";
import type { StoredTask } from "../storage/tasks.js";
import type { Catalog } from "../models/catalog.js";
import type { Gate } from "../gateway/gate.js";
import { effectiveBudget } from "../admission/admission.js";
import { loadSources } from "../context/sources.js";
import { qualificationLookup } from "../qualification/stats.js";
import { Classifier } from "../scoring/classifier.js";
import { loadRulebook, rulebookFingerprint, type Rulebook } from "../scoring/rulebook.js";
import { classifierCouldMatter, decide, featureScore, measureFeatures, bumpTier, type Classification } from "../scoring/score.js";
import { planRoute, type RoutePlan } from "./select.js";

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

  plan(profile: ProfileName, tier: TierName, inputModalities: Modality[], forcedEndpointId?: string): RoutePlan {
    return planRoute(
      this.cfg,
      this.catalog.endpoints(),
      this.catalog.routingOverrides(),
      { profile, tier, inputModalities, needsStructuredOutput: false, ...(forcedEndpointId ? { forcedEndpointId } : {}) },
      { now: new Date(this.now()), qualification: qualificationLookup(this.db, this.cfg), health: this.gate.health.lookup },
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
    if (classification.tier === "T4") return { classification, plan: null, inputModalities };
    return { classification, plan: this.plan(spec.profile, classification.tier, inputModalities, spec.routing?.endpointId), inputModalities };
  }
}
