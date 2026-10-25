# Lifecycle safety review
Status: Complete
Reviewer: loop_role_fix (read-only follow-up)
Date: 2026-10-25

## Current findings
- Found pre-plan pure-read batch regression: batch registry has conservative command side effect,
  so generic command check blocked safe batched discovery. Worker corrected the condition to
  inspect batch child commands rather than block every batch.
- Found Lab execution bypass: lab_check/restart/promote are external side effects, not command.
  Worker added explicit gates, including mutating Lab HTTP while allowing GET/HEAD discovery.
- Found post-loop host command bypass: automatic final supervisor checks ran after blocked or
  stalled pre-plan finish. Worker now skips fresh final checks unless v2 returns completed;
  legacy behavior remains. Exact skip event is recorded.
- Flagged indirect integration command route: integrate_task launches parent host checks and
  Lab integration checks despite edit side effect; resumed old children can reach it pre-plan.
  Worker added integrate_task to the explicit pre-plan execution gate; regression assertion added.
- Planned execution matching now persists/compares Lab check names as a defaulted PlanNode
  field; old JSON plans remain readable through schema default.

## Reviewed invariants
- Discovery cap uses admission.taskTotals(taskId), so opening another runner/session cannot
  reset physical request count. No new in-memory-only lifecycle counter.
- Draft dispatch:false bypasses staffNodes entirely and records existing validated PlanStore
  graph. Existing panel admin view can show null task/state not_dispatched nodes.
- All lifecycle restrictions return early for non-v2 jobs; dispatch defaults true.
- Original human-only action approval service remains unchanged; gates reject before invoking
  command helpers. No automatic approval or configuration relaxation introduced.
- Loop request filtering is backed by actual execution and actual resume rerun wrappers;
  completed historical outcomes are preserved. Terminal validation remains independent.

## Validation status
- Read-only source/test diff inspection; no tests run during parallel edits.
- Earlier owned loop change independently ran 22/22 focused tests and router tsc; that is not
  final lifecycle acceptance; final source pass is recorded below.
- Full brief draft validation omits some optional future-dispatch fields (such as max_requests)
  at this interim snapshot; no budget execution occurs in draft, and dispatch still validates.

## Final source review
- Implementation worker declared sources stable; reread supervisor-lifecycle.ts,
  supervisor-tools.ts draft/dispatch block, runner guards/final checks, PlanNode schema,
  product-delivery transition, and lifecycle regression fixture assertions.
- All four concrete command/discovery findings above are corrected in source.
- Undispatched drafts alone no longer reopen discovery after the request allowance;
  policy requires a plan-linked actual child plus persisted delivery stage.
- No remaining blocking defect found in reviewed scope. This is source review, not a
  claim of full test success, live provider completion, or Facebook product acceptance.
- Tests added by implementation worker cover real supervisor blocked early exit and
  draft/dispatch flow; supervisor must observe their results independently.

