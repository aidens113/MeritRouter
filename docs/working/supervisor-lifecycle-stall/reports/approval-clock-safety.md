# Approval execution-clock safety review
Status: Complete
Reviewer: loop_role_fix (read-only)
Date: 2026-10-25

## Scope
Reviewed operation-lifecycle.ts, worker-actions.ts, recipe-operations.ts and changed
approval-execution-timeout/external-task-tools test sources while implementation proceeds.
No source edits, tests, commits or real approvals performed by reviewer.

## Required correction
Initial worker implementation paused the operation execution clock during source/request
preparation before an owned pending action existed. Root explicitly rejected that expansion:
source capture remains active bounded preflight. Worker notified; final review must confirm
preparation pause removed. Fixtures should isolate pending-approval time with precreated
actions or sufficient real active budgets, rather than exempt hashing from production limits.

## Inspected safety properties
- Active clocks tracked by exact AbortSignal; nested operation pause walks known parent clocks.
- Reference-counted releases are idempotent; only zero outstanding holds reschedules execution.
- Operation cancel signal and independent task-deadline timer stay active during pending wait.
- Actual command executor retains runProcess timeout; pending wait does not extend command runtime.
- On cancellation, awaitWorkerCommand cancels the exact captured-lease request and awaits
  confirmed quiescence of a running action before throwing/releasing operation ownership.
- Operation settles only after actual awaited definition returns/throws; cleanup clears both
  timers and removes the clock mapping. Late release cannot restart a settled/aborted clock.
- Existing source/lease identity and human-only approval authorization remain unchanged.

## Unverified / follow-up
- Final worker source readiness and focused test results pending.
- Existing source-hash request filing checks persisted task authority after hashing, but
  explicit operation-only signal can abort during hashing before a pending row exists.
  This is a preexisting narrow filing race; noted to worker/root, no execution authorization
  relaxed by this clock fix. Task cancel/deadline authority remains checked by service.

## Timer race identified during review
First pause clears a timer before subtracting elapsed active time. If elapsed time already
exhausted the budget but its callback has not run yet, the initial implementation retains
remaining=0 while pausing indefinitely. That revives an expired preflight across approval wait.
Requested immediate operation-timeout abort when first pause observes remaining<=0, plus a
regression for event-loop/microtask delay; awaiting correction before final sign-off.

## Final source review
Worker declared source stable. Confirmed preparation pause removed: source hashing again
counts against active operation timeout. Pausing begins only after rereading an owned pending
request and checking captured lease fields. Source filing now checks operation cancellation
before/after asynchronous capture, closing the late-row race noted above.

Expired-active-budget race corrected: first pause aborts immediately at remaining=0 rather
than suspending an overdue timer. Added deterministic Date.now regression inspects that abort.
Additional tests cover cancellation during held source hash with zero approval rows and
changed-source rejection while paused. Existing focused fixtures cover nested batch ancestry,
explicit operation/task cancel, task deadlines, denial and process quiescence/late marker.

No remaining blocking issue found in reviewed source scope. Reviewer did not execute tests
while implementation edits/worker checks were active. Implementation worker reported tsc pass
and had focused checks running; root must observe final results independently before release.
No approval bypass, paid-policy changes, source edits or real human approval executed by reviewer.

## Follow-up: execution transition between polls
Root identified pending-to-running-to-completed can occur within the100ms waiter poll,
leaving the whole command duration excluded from a paused enclosing budget. Reviewing
trusted executionStartedAt metadata and compensation on clock release. Compensation must
avoid double charging after clocks resume and must apply to every enclosing clock.
Posthoc compensation detects overrun and forbids further grouped effects, but cannot alone
stop a process before the next poll. Suggested additionally persisting an action timeout
clamped to remaining active operation/ancestor budget, measured after bounded source capture;
trusted decider runProcess can enforce that limit across process boundaries.
Await worker/root choice and stable source before updated final sign-off.

## Follow-up implementation inspected
- Optional row executionStartedAt is set only by trusted pending-to-running claim.
- Optional row executionTimeoutMs stores remaining ancestor/operation cap after active source
  capture, outside immutable action identity/request_key. Exact requested action stays stable;
  replay pending cap can only narrow. Decider bounds runProcess by requested/effective minimum.
- Release charges trusted execution-start through observation, including a command completing
  wholly between polls. Legacy missing start charges the full paused span conservatively.
- Shared ancestor overlap intervals are merged before charge, avoiding double subtraction.
- No blocking defect found in this interim follow-up source pass; awaiting worker final
  stable-source notice and root's independently observed tests before updated sign-off.

## Follow-up final source pass
Reviewed final catch-up/cap implementation and new regression sources. No blocking defect
found: polling cannot erase completed command time; persisted broker cap enforces remaining
ancestor budget even when no operation timer is polling; immutable requested action/key is
preserved; pending replay metadata only narrows. Conservative legacy fallback avoids silently
excluding execution when old rows lack a trusted start.

Regression sources now cover fast completion before first poll (normal/legacy), refusal to
start another grouped command after overrun, real process late-marker suppression using
persisted ancestor cap after clocks settle, stable replay action identity with narrowed cap,
and overlap-union charging. Reviewer did not run tests; root owns observed results and final
acceptance. Earlier no-blocker statement was reopened for root's missed-execution finding;
this section records the updated reviewed outcome after its correction.
