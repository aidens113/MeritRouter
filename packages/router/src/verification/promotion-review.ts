import type { ResolvedConfig } from "../config/load.js";
import type { ProfileName } from "../config/schema.js";
import type { Admission } from "../admission/admission.js";
import type { Catalog } from "../models/catalog.js";
import type { TaskRouter } from "../routing/router.js";
import { modelFamily } from "../routing/select.js";
import type { SubmitOutcome, TaskStore } from "../storage/tasks.js";
import { reviewerQualification } from "../qualification/stats.js";
import { isTerminal } from "../core/task.js";
import type { PromotionReviewPort, PromotionReviewRequest, PromotionReviewResult, PromotionReviewStart } from "../brain/promotion.js";
import { resolveLevel } from "./policy.js";
import { renderEvidencePackage, reviewOutcomeOf, validateVerdict, VERDICT_JSON_SCHEMA } from "./review.js";

/**
 * The independent reviewer of global promotions (decision D9): one review task per promotion,
 * like an audit (purpose `promotion_review`, a completion task (review or summarize) pinned to the
 * chosen reviewer, free models only, a small budget), so its requests go through the scheduler,
 * admission, and the Gate like any other task's. The reviewer is never the promoting supervisor's
 * model: every endpoint the supervisor's task used, and every endpoint of the same model family
 * (or of the supervisor's named model), is excluded. It judges the lesson against a fixed rubric
 * and returns the standard verdict object, validated in code.
 */

export const PROMOTION_RUBRIC_VERSION = "global-lesson-rubric-1";

/** The fixed rubric: a lesson is global only when every criterion passes. */
export const PROMOTION_RUBRIC: Array<{ id: string; text: string; verify: string }> = [
  {
    id: "beyond_project",
    text: "The lesson applies beyond the project it came from: it would hold, unchanged, for other codebases, teams, and domains, not only for this project's code, data, or setup.",
    verify: "review",
  },
  {
    id: "no_project_detail",
    text: "The lesson names nothing specific to one project (products, people, customers, repositories, file paths, services, identifiers, or internal terms) and does not depend on one project's architecture or configuration.",
    verify: "review",
  },
  {
    id: "actionable",
    text: "The lesson states a concrete, reusable practice, rule, or fact that would change how an agent works; it is not a status report, a one-off observation, or a restatement of the task.",
    verify: "review",
  },
  {
    id: "supported",
    text: "The cited sources support the lesson; it is not speculation and does not contradict them.",
    verify: "review",
  },
];

/** Requests one promotion review may use. */
export const PROMOTION_REVIEW_MAX_REQUESTS = 4;
/** Label of promotion review tasks. */
export const PROMOTION_REVIEW_LABEL = "promotion-review";
export const PROMOTION_REVIEW_PURPOSE = "promotion_review";

export interface PromotionReviewHost {
  cfg: ResolvedConfig;
  tasks: TaskStore;
  catalog: Catalog;
  router: TaskRouter;
  admission: Admission;
  submitTasks: (raw: unknown[], opts: { purpose?: string; project?: string }) => Promise<SubmitOutcome[]>;
}

export class PromotionReviewer implements PromotionReviewPort {
  constructor(private readonly h: PromotionReviewHost) {}

  /** The supervisor's endpoints (every one its task was served by, and its named model) and their families. */
  private supervisorModels(s: { taskId: string | null; model: string | null }): { endpoints: string[]; families: Set<string> } {
    const endpoints = new Set<string>();
    if (s.taskId) for (const list of Object.values(this.h.admission.servedEndpointsByPurpose(s.taskId))) for (const e of list) endpoints.add(e);
    const families = new Set<string>();
    if (s.model) {
      const ep = this.h.catalog.get(s.model);
      if (ep) endpoints.add(ep.id);
      families.add(modelFamily({ gatewayModelId: s.model, providerModelId: undefined }));
    }
    for (const id of endpoints) {
      const ep = this.h.catalog.get(id);
      if (ep) families.add(modelFamily(ep));
    }
    return { endpoints: [...endpoints], families };
  }

  /** The task type a promotion review runs as: a completion type (the lesson and its sources are inline; no repository is read). */
  private profile(): ProfileName | null {
    const cfg = this.h.cfg;
    for (const name of ["review", "summarize"] as ProfileName[]) if (cfg.profiles[name]?.mode === "completion") return name;
    return null;
  }

  async start(r: PromotionReviewRequest): Promise<PromotionReviewStart> {
    const h = this.h;
    const profile = this.profile();
    if (!profile) return { kind: "unavailable", reason: "no completion task type (review or summarize) is configured to run the review" };
    const sup = this.supervisorModels(r.supervisor);
    const plan = h.router.planReviewer({
      profile,
      tier: "T2",
      inputModalities: ["text"],
      avoidEndpoints: sup.endpoints,
      avoidFamilies: [...sup.families],
      avoidProviders: [],
      minTotalParametersB: resolveLevel(h.cfg.verification, "deep").review.minTotalParametersB,
      reviewer: reviewerQualification(h.cfg, "review", "T2"),
    });
    const pick = plan.candidates.find((c) => {
      const ep = h.catalog.get(c.id);
      return !!ep && ep.origin !== "paid" && !sup.endpoints.includes(ep.id) && !sup.families.has(modelFamily(ep));
    });
    if (!pick) {
      const families = [...sup.families].join(", ") || "none";
      return { kind: "unavailable", reason: `no eligible reviewer: no free model is available outside the supervisor's model families (${families})` };
    }
    const context = r.sources.map((s) => `### brain:${s.path}\n\`\`\`\n${s.text || "(empty or unreadable)"}\n\`\`\``).join("\n\n");
    const evidence = renderEvidencePackage({
      goal: "Decide whether the lesson under review belongs in global knowledge, which the agents of every project read.",
      criteria: PROMOTION_RUBRIC,
      scope: { repositoryAliases: [], writableRepository: null, allowedPaths: null },
      level: "global-promotion",
      policyVersion: PROMOTION_RUBRIC_VERSION,
      revision: r.digest,
      baseCommits: {},
      changedPaths: [],
      patch: null,
      checks: [],
      deterministic: [{ name: "project_specificity", outcome: "passed", detail: "the lesson names no project slug or name, repository alias or path, or file inside a repository, and cites at least one source in the project's brain" }],
      work: { summary: `${r.candidate.title}\n\n${r.candidate.body}`, findings: [] },
      claim: { summary: "A supervisor of one project proposes this lesson as applying to every project.", findings: [], self: [] },
      context: context || null,
    });
    try {
      const [sub] = await h.submitTasks(
        [
          {
            profile,
            label: PROMOTION_REVIEW_LABEL,
            goal:
              "Promotion review: judge the lesson in the evidence against every rubric criterion in the contract and return your verdict as data (the verdict object). " +
              'examinedRevision and policyVersion exactly as given; cite evidence as "inline"; verdict "pass" only when every criterion passes, "fail" when any fails (recommend needs_supervisor), "inconclusive" when you cannot tell.',
            context: { inlineText: evidence },
            constraints: { acceptanceCriteria: ["returns a verdict on every rubric criterion"], outputSchema: VERDICT_JSON_SCHEMA },
            importance: "low",
            hints: { difficulty: "T1" },
            routing: { endpointId: pick.id },
            budget: { maxModelRequests: PROMOTION_REVIEW_MAX_REQUESTS, maxPaidUsd: 0 },
          },
        ],
        { purpose: PROMOTION_REVIEW_PURPOSE, project: r.project },
      );
      return { kind: "started", reviewTaskId: sub!.taskId, reviewer: pick.id };
    } catch (err) {
      return { kind: "unavailable", reason: `the review task could not be submitted: ${(err as Error).message.slice(0, 300)}` };
    }
  }

  result(reviewTaskId: string, expect: { digest: string; supervisor: { taskId: string | null; model: string | null } }): PromotionReviewResult {
    const t = this.h.tasks.get(reviewTaskId);
    if (!t) return { kind: "failed", reason: `review task ${reviewTaskId} does not exist` };
    if (!isTerminal(t.row.state)) return { kind: "running" };
    const res = t.result;
    if (t.row.state !== "completed" || !res) return { kind: "failed", reason: `review task ${reviewTaskId} ended ${t.row.state}${res?.stopReason ? `: ${res.stopReason}` : ""}` };
    const reviewer = res.servedEndpoints[res.servedEndpoints.length - 1] ?? t.spec.routing?.endpointId ?? null;
    const ep = reviewer ? this.h.catalog.get(reviewer) : undefined;
    const sup = this.supervisorModels(expect.supervisor);
    if (reviewer && (sup.endpoints.includes(reviewer) || (ep && sup.families.has(modelFamily(ep))))) return { kind: "failed", reason: `review task ${reviewTaskId} was served by ${reviewer}, the supervisor's own model family` };
    const v = validateVerdict(res.data, { criteria: PROMOTION_RUBRIC, revision: expect.digest, policyVersion: PROMOTION_RUBRIC_VERSION, universe: null });
    if (!v.ok) return { kind: "failed", reason: `the reviewer's verdict failed validation: ${v.errors.slice(0, 3).join("; ")}` };
    const reason = reviewOutcomeOf(v.value).reason;
    return {
      kind: "verdict",
      verdict: v.value.verdict,
      reasons: reason ? reason.split("; ").filter(Boolean) : [],
      reviewer,
      reviewerModel: ep ? (ep.providerModelId ?? ep.gatewayModelId) : null,
      rubric: PROMOTION_RUBRIC_VERSION,
    };
  }
}
