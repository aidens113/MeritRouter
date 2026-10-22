import { z } from "zod";
import type { TaskStore } from "../storage/tasks.js";
import type { Catalog } from "../models/catalog.js";
import type { SessionStore } from "../sessions/store.js";
import type { Admission, RequestPurpose } from "../admission/admission.js";
import { modelFamily } from "../routing/select.js";
import type { ReviewRecord, VerificationRecord } from "../core/task.js";
import { restoreRunState, RetryStartedSchema, RETRY_STARTED, REVIEW_RECORDED } from "../core/retry-state.js";
import { authorSessions } from "../core/executor.js";

/** One independent review, with its reviewer's display name and model family. */
export interface ReviewView extends ReviewRecord {
  /** When the review was recorded (its review_recorded event), if that event is kept. */
  at: number | null;
  reviewerName: string | null;
  reviewerFamily: string | null;
}

/** The task's one bounded retry: a quality repair or an execution-failure escalation. */
export interface RetryView {
  at: number;
  kind: "repair" | "escalation";
  fromTier: string;
  toTier: string;
  reason: string;
  /** For a coding repair: the submitted commit the repair started from. */
  startFrom: string | null;
  /** The review verdict that called for the repair, if a review did. */
  reviewVerdict: string | null;
  reasons: string[];
  /** The run that carried the retry out (the author session after the one it ended). */
  sessionId: string | null;
}

/** A targeted check a reviewer asked for, run once on the submitted revision. */
export interface TargetedCheckView {
  at: number;
  commands: string[];
  ran: Array<{ command: string; exitCode: number | null }>;
  note: string;
}

/** The verification level raised on the result, and the review reserve that drew. */
export interface RaisedLevelView {
  at: number;
  from: string;
  to: string;
  tier: string | null;
  newRules: string[];
  reserveAdjustment: { from: number; to: number; fromUnallocated: number; wanted: number } | null;
}

/** Requests granted on top of the task's budget by an approved request for more (budget control). */
export interface BudgetGrantView {
  at: number;
  /** The `budget_requests` row. */
  requestId: number;
  granted: number;
  /** Every request granted so far, this one included. */
  extraTotal: number;
  by: string | null;
  /** The contract's total plus every grant so far (null when the task has no contract). */
  contractTotal: number | null;
}

export interface TaskVerificationTrail {
  /** Oldest first: the result's record, or (while the task runs) the reviews recorded so far. */
  reviews: ReviewView[];
  retries: RetryView[];
  targetedChecks: TargetedCheckView[];
  raised: RaisedLevelView[];
  /** The contract's budget history: grants from approved requests for more, oldest first. */
  budgetGrants: BudgetGrantView[];
  /** Model requests charged to the task, by purpose (admission accounting). */
  requestsByPurpose: Record<RequestPurpose, number>;
}

// Stored task events are untrusted input: each is validated, and an invalid one is skipped.
const QualityRepairEventSchema = z.object({ startFrom: z.string().nullable().optional(), review: z.string().nullable().optional(), reasons: z.array(z.string()).optional() });
const TargetedCheckEventSchema = z.object({ commands: z.array(z.string()), ran: z.array(z.object({ command: z.string(), exitCode: z.number().nullable() })), note: z.string() });
const RecordedAtSchema = z.object({ record: z.object({ attempt: z.number() }) });
const ReserveSchema = z.object({ from: z.number(), to: z.number(), fromUnallocated: z.number(), wanted: z.number() });
const BudgetGrantedSchema = z.object({ id: z.number().int(), granted: z.number().int(), extraTotal: z.number().int(), by: z.string().nullable().optional(), contractTotal: z.number().int().optional() });
const RaisedEventSchema = z.object({ from: z.string(), to: z.string(), tier: z.string().optional(), newRules: z.array(z.string()).optional(), reserveAdjustment: z.object({ review: ReserveSchema }).optional() });

export interface TrailDeps {
  tasks: TaskStore;
  catalog: Catalog;
  sessions: SessionStore;
  admission: Pick<Admission, "taskTotalsByPurpose">;
}

/**
 * What verification did for a task, rebuilt for display from its result and events: the reviews
 * (with reviewer name and family), the retry and the run that carried it out, targeted checks,
 * levels raised on the result with the review reserve they drew, and requests by purpose.
 */
export function verificationTrail(d: TrailDeps, id: string, verification: VerificationRecord | null): TaskVerificationTrail {
  const events = d.tasks.events(id, 5000);
  const recorded = verification?.reviews?.length ? verification.reviews : restoreRunState(d.tasks, id).st.reviews;
  const recordedAt = new Map<number, number>();
  for (const e of events) {
    const a = e.type === REVIEW_RECORDED ? RecordedAtSchema.safeParse(e.data) : null;
    if (a?.success) recordedAt.set(a.data.record.attempt, e.ts);
  }
  const reviews = recorded.map((r) => {
    const ep = r.reviewer ? d.catalog.get(r.reviewer) : undefined;
    return { ...r, at: recordedAt.get(r.attempt) ?? null, reviewerName: ep ? (ep.displayName ?? ep.gatewayModelId) : null, reviewerFamily: ep ? modelFamily(ep) : null };
  });
  // A retry's run is the author session that follows the one ended "...; repair at" / "...; escalated to".
  const authors = authorSessions(d.sessions, id);
  const handedOver = authors.filter((s) => /; (repair at|escalated to) /.test(s.stopReason ?? ""));
  const retries: RetryView[] = [];
  const targetedChecks: TargetedCheckView[] = [];
  const raised: RaisedLevelView[] = [];
  const budgetGrants: BudgetGrantView[] = [];
  for (const e of events) {
    if (e.type === "budget_granted") {
      const g = BudgetGrantedSchema.safeParse(e.data);
      if (g.success) budgetGrants.push({ at: e.ts, requestId: g.data.id, granted: g.data.granted, extraTotal: g.data.extraTotal, by: g.data.by ?? null, contractTotal: g.data.contractTotal ?? null });
      continue;
    }
    if (e.type === RETRY_STARTED) {
      const r = RetryStartedSchema.safeParse(e.data);
      if (!r.success) continue;
      const before = handedOver[retries.length];
      retries.push({
        at: e.ts,
        kind: r.data.reason === "acceptance_unmet" ? "repair" : "escalation",
        fromTier: r.data.fromTier,
        toTier: r.data.toTier,
        reason: r.data.reason,
        startFrom: r.data.retry.startFrom?.commit ?? null,
        reviewVerdict: null,
        reasons: r.data.retry.verificationReasons,
        sessionId: before ? (authors.find((s) => s.previousSessionId === before.id)?.id ?? null) : null,
      });
    } else if (e.type === "quality_repair") {
      const q = QualityRepairEventSchema.safeParse(e.data);
      const last = retries.at(-1);
      if (q.success && last) Object.assign(last, { reviewVerdict: q.data.review ?? null, ...(q.data.reasons?.length ? { reasons: q.data.reasons } : {}), startFrom: last.startFrom ?? q.data.startFrom ?? null });
    } else if (e.type === "targeted_check") {
      const t = TargetedCheckEventSchema.safeParse(e.data);
      if (t.success) targetedChecks.push({ at: e.ts, ...t.data });
    } else if (e.type === "verification_raised") {
      const v = RaisedEventSchema.safeParse(e.data);
      if (v.success) raised.push({ at: e.ts, from: v.data.from, to: v.data.to, tier: v.data.tier ?? null, newRules: v.data.newRules ?? [], reserveAdjustment: v.data.reserveAdjustment?.review ?? null });
    }
  }
  return { reviews, retries, targetedChecks, raised, budgetGrants, requestsByPurpose: d.admission.taskTotalsByPurpose(id) };
}
