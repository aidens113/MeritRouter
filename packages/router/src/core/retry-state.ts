import { z } from "zod";
import { TierNameSchema, type TierName } from "../config/schema.js";
import type { TaskStore } from "../storage/tasks.js";
import { ReviewRecordSchema, type ReviewRecord } from "./task.js";
import type { RetryContext } from "../runners/types.js";

/**
 * What verification and the one bounded retry have done for a task so far. It spans the task's
 * runs, so it is kept in task events and restored when a run starts after an interruption
 * (crash, shutdown, watchdog, capacity deferral): a resumed or re-run task never repeats its
 * repair, and its review numbering and history continue.
 */
export interface VerificationState {
  /** Reviews recorded so far (one per review attempt that returned). */
  reviews: ReviewRecord[];
  /** Review attempts started so far (an interrupted review is counted but has no record). */
  attempts: number;
  targetedRan: boolean;
  qualityRetriesUsed: number;
}

/** Task event written when a retry (quality repair or execution-failure escalation) begins. */
export const RETRY_STARTED = "retry_started";
/** Task event carrying each review's record, so a later run can restore the history. */
export const REVIEW_RECORDED = "review_recorded";

const RetryContextSchema = z.object({
  fromTier: TierNameSchema,
  reason: z.string(),
  stopReason: z.string(),
  findings: z.array(z.string()),
  unresolvedCriteria: z.array(z.string()),
  failingChecks: z.array(z.object({ command: z.string(), exitCode: z.number().nullable(), logRef: z.string(), logTail: z.string() })),
  verificationReasons: z.array(z.string()),
  startFrom: z.object({ alias: z.string(), commit: z.string() }).nullable().optional(),
});

export const RetryStartedSchema = z.object({
  fromTier: TierNameSchema,
  toTier: TierNameSchema,
  reason: z.string(),
  retry: RetryContextSchema,
});
export type RetryStarted = z.infer<typeof RetryStartedSchema>;

const AttemptSchema = z.object({ attempt: z.number().int().min(1) });

export interface RestoredRunState {
  st: VerificationState;
  /** The retry already started (its run is the one to continue), or null when none began. */
  retry: (RetryStarted & { retry: RetryContext }) | null;
}

/**
 * Rebuild the task's verification and retry state from its events. Stored rows are untrusted
 * input: events that fail validation are ignored.
 */
export function restoreRunState(tasks: TaskStore, taskId: string): RestoredRunState {
  const st: VerificationState = { reviews: [], attempts: 0, targetedRan: false, qualityRetriesUsed: 0 };
  let retry: RestoredRunState["retry"] = null;
  for (const e of tasks.events(taskId, 5000)) {
    if (e.type === RETRY_STARTED) {
      const r = RetryStartedSchema.safeParse(e.data);
      if (!r.success) continue;
      st.qualityRetriesUsed++;
      retry = r.data as RestoredRunState["retry"];
    } else if (e.type === REVIEW_RECORDED) {
      const r = ReviewRecordSchema.safeParse((e.data as { record?: unknown } | null)?.record);
      if (r.success) st.reviews.push(r.data);
    } else if (e.type === "review_started" || e.type === "review_not_run") {
      const a = AttemptSchema.safeParse(e.data);
      if (a.success) st.attempts = Math.max(st.attempts, a.data.attempt);
    } else if (e.type === "targeted_check") st.targetedRan = true;
  }
  st.attempts = Math.max(st.attempts, st.reviews.length);
  return { st, retry };
}

/** The retry event's data (validated before it is written, so a restore can read it back). */
export function retryStarted(fromTier: TierName, toTier: TierName, reason: string, retry: RetryContext): RetryStarted {
  return RetryStartedSchema.parse({ fromTier, toTier, reason, retry });
}
