import { z } from "zod";

const label = z.string().trim().min(1).max(500);
const metric = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/);
const metrics = z.record(metric, z.number().finite()).refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 64, "Provide 1 to 64 measured metrics");

/** Trusted configuration imports observed scores on one comparable, higher-is-better scale. */
export const SupervisorRankingPolicySchema = z.object({
  source: label, suite_version: label, metric_scale: label, rank_metric: metric,
  capability_floors: metrics,
  /** Image-input supervision needs an explicitly measured/floored visual metric. */
  visual_metric: metric.optional(),
}).strict().superRefine((value, ctx) => {
  for (const name of [value.rank_metric, ...(value.visual_metric ? [value.visual_metric] : [])]) {
    if (!Object.hasOwn(value.capability_floors, name)) ctx.addIssue({ code: "custom", path: ["capability_floors", name], message: "Ranking and visual metrics require explicit capability floors" });
  }
});
export const SupervisorRankingEvidenceSchema = z.object({
  endpoint_id: label, provider: label, model: label,
  source_model_id: label, mapping_source: label,
  source: label, source_url: z.string().max(4096).refine(value => /^meritrouter:qualification:q_[a-z0-9]+$/.test(value) || (() => { try { return ["https:", "http:"].includes(new URL(value).protocol); } catch { return false; } })(), "Evidence requires HTTP(S) or a persisted qualification run URI"),
  suite_version: label, metric_scale: label,
  checked_at: z.string().datetime({ offset: true }), expires_at: z.string().datetime({ offset: true }),
  metrics,
}).strict().superRefine((value, ctx) => {
  if (Date.parse(value.expires_at) <= Date.parse(value.checked_at)) ctx.addIssue({ code: "custom", path: ["expires_at"], message: "Ranking evidence must expire after observation" });
});
export type SupervisorRankingPolicy = z.infer<typeof SupervisorRankingPolicySchema>;
export type SupervisorRankingEvidence = z.infer<typeof SupervisorRankingEvidenceSchema>;
export interface SupervisorEndpointRoute { provider: string; model: string }
export interface SupervisorRankingAssessment {
  eligible: boolean; score: number | null; source: string | null;
  classification: "benchmark_qualified_supervisor" | null; reason: string;
}

/** No network fetch, score synthesis or size inference. Imported records retain their expiry. */
export function assessSupervisorRanking(endpointId: string, policy: unknown, records: unknown, now: Date, route?: SupervisorEndpointRoute, visualRequired = false): SupervisorRankingAssessment {
  const denied = (detail: string): SupervisorRankingAssessment => ({ eligible: false, score: null, source: null, classification: null, reason: `supervisor_quality_unavailable: ${detail}` });
  const parsed = SupervisorRankingPolicySchema.safeParse(policy);
  const evidence = z.array(SupervisorRankingEvidenceSchema).max(10_000).safeParse(records);
  if (!parsed.success) return denied("configure a comparable ranking source, version, metric scale and explicit capability floors");
  if (!evidence.success) return denied("ranking evidence is malformed; import reviewed source records with exact identity and expiry");
  if (!route || !Number.isFinite(now.getTime())) return denied("current endpoint route identity and time are required for ranked supervision");
  const p = parsed.data;
  if (visualRequired && !p.visual_metric) return denied("image-input supervision requires a measured visual metric and floor");
  // A new observation supersedes an old score for the same mapped endpoint/source/version.
  // It cannot resurrect an older, higher score after the new observation fails a floor.
  const current = evidence.data.filter(e => e.endpoint_id === endpointId && e.provider === route.provider && e.model === route.model
    && e.source === p.source && e.suite_version === p.suite_version && e.metric_scale === p.metric_scale
    && Date.parse(e.checked_at) <= now.getTime())
    .sort((a, b) => Date.parse(b.checked_at) - Date.parse(a.checked_at));
  const best = current[0];
  if (!best) return denied("no current reviewed ranking matches this endpoint/provider/model, source, suite version and metric scale");
  if (Date.parse(best.expires_at) <= now.getTime()) return denied("latest comparable ranking has expired; refresh the reviewed import without reviving superseded scores");
  if (current[1] && Date.parse(current[1].checked_at) === Date.parse(best.checked_at)) return denied("ambiguous equal-time ranking records; import one reviewed observation per mapped endpoint");
  if (Object.entries(p.capability_floors).some(([name, floor]) => !Object.hasOwn(best.metrics, name) || best.metrics[name]! < floor)) return denied("latest comparable ranking does not meet every configured supervisor capability floor");
  const score = best.metrics[p.rank_metric]!;
  return { eligible: true, score, source: best.source_url, classification: "benchmark_qualified_supervisor",
    reason: `benchmark-qualified for configured supervisor role; ${p.rank_metric} ${score} on ${p.metric_scale} (${p.source}, ${p.suite_version}; ${best.source_url}; observed ${best.checked_at}, expires ${best.expires_at}). Reviewed source model ${best.source_model_id}; mapping: ${best.mapping_source}. Product/visual delivery still requires independent FINAL acceptance` };
}
