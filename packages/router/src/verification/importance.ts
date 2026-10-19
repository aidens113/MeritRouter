import { IMPORTANCE_LEVELS, type Importance, type VerificationConfig } from "../config/schema.js";
import { matchesWhen, type MatchFacts } from "./match.js";

export const IMPORTANCE_RANK: Readonly<Record<Importance, number>> = Object.fromEntries(IMPORTANCE_LEVELS.map((l, i) => [l, i])) as Record<Importance, number>;

export function strongerImportance(a: Importance, b: Importance): Importance {
  return IMPORTANCE_RANK[b] > IMPORTANCE_RANK[a] ? b : a;
}

/** Where an importance came from: the policy default, the task, the parent job, a floor, or a rule. */
export interface ImportanceSource {
  kind: "default" | "task" | "parent" | "floor" | "rule";
  /** Floor or rule id; the parent task id; null for default and task. */
  id: string | null;
  importance: Importance;
}

export interface EffectiveImportance {
  importance: Importance;
  /** What the task asked for (or the policy default). */
  requested: Importance;
  reason: string | null;
  /** The source that set the final importance (the first to reach it, in the order below). */
  source: ImportanceSource;
  /** Every source considered: requested, parent, matching floors, matching rules. */
  considered: ImportanceSource[];
}

export interface ImportanceInput {
  requested?: Importance | null;
  reason?: string | null;
  /** The parent job's effective importance, applied as a floor when inherit_parent_importance. */
  parent?: { taskId: string; importance: Importance } | null;
  facts: MatchFacts;
}

/** Display form of a source, e.g. "floor:risk-critical" or "task". */
export function formatImportanceSource(s: ImportanceSource): string {
  return s.id ? `${s.kind}:${s.id}` : s.kind;
}

/**
 * Effective importance is the strongest of the request (or default) and every applicable floor:
 * the parent job, matching floors, and rules that set importance. It can only rise.
 */
export function effectiveImportance(policy: VerificationConfig, input: ImportanceInput): EffectiveImportance {
  const requested = input.requested ?? policy.default_importance;
  const considered: ImportanceSource[] = [{ kind: input.requested ? "task" : "default", id: null, importance: requested }];
  if (input.parent && policy.inherit_parent_importance) considered.push({ kind: "parent", id: input.parent.taskId, importance: input.parent.importance });
  for (const f of policy.floors) if (matchesWhen(f.when, input.facts)) considered.push({ kind: "floor", id: f.id, importance: f.importance });
  for (const r of policy.rules) if (r.importance && matchesWhen(r.when, input.facts)) considered.push({ kind: "rule", id: r.id, importance: r.importance });
  let source = considered[0]!;
  for (const s of considered) if (IMPORTANCE_RANK[s.importance] > IMPORTANCE_RANK[source.importance]) source = s;
  return { importance: source.importance, requested, reason: input.reason ?? null, source, considered };
}
