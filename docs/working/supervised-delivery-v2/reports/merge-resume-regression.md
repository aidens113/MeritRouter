# Merge-resume regression

Worker: harness-v2. Feature worktree only; source ownership limited to merge-queue if evidence requires it. No commits or live providers.

## Investigation

- Added failure-only diagnostics before fixture cleanup: actual task/result/event data, recent model tool outputs and persisted worker-action status. No polling budget increase.
- First narrow run: `pnpm exec vitest run tests/team-nesting.test.ts -t 'a supervisor that dies mid-integration resumes'` passed, 18.86s test / 23.55s total. Exact two-commit crash/recovery assertions retained.
- Whole-file baseline: all 7 passed, 75.22s test / 79.27s total. No merge-queue source defect reproduced in this unloaded run.
- Authorized scope extension: tests/supervisor.test.ts first case has the same fixed await_tasks -> integrate sequence. Baseline passed (20.22s test / 25.18s total); added failure-only result/tool/child-event diagnostics.
- Candidate cause under investigation: `await_tasks` explicitly returns for pending operator actions or its timeout, but the final fixed script immediately attempts integration. Earlier nested-team fixture already waits for its child terminal state at this boundary. Temporarily shortened final fixture await_tasks to one second to exercise that existing legal early-return boundary and capture actual failed outputs before choosing a fix.

## Confirmed reproduction and fix

The one-second legal await probe reproduced the exact failure: 52.48s test / 56.79s total; simulated crash count stayed zero. Captured transcript before cleanup:

1. `await_tasks`: `<worker-id>: still running`.
2. `integrate_task`: `error: task has not finished`.
3. Fixed supervisor script advanced to ask_user (`Hold here until the restart`), without ever enqueuing/picking commits.
4. Worker subsequently completed with acceptanceStatus=met, 3 real scripted model turns and the real declared-check action approved by the fixture operator, exit0. Worker event chronology: started 02:34:02.351Z, supervisor already asking its hold question at 02:34:04.000Z, worker check waited 02:34:06.062Z–06.599Z, worker completed 02:34:06.913Z.

Thus zero simulated crashes did not demonstrate failed merge recovery; the obsolete fixed script failed to reach integration because a legal early wait return was treated as worker completion. The timeout probe reproduces the same caller obligation as the pending-approval early return under concurrent load; it does not prove that the release failure used timeout rather than approval.

Restored the fixture's original 120-second await_tasks timeout. Both final team-nesting fixture and first supervisor fixture now await the actual child's terminal result before issuing their predetermined integration response, using the same pattern already present in the nested parent/child fixture. Kept the real approval broker, declared checks, original polling budgets, exact two worker commits, injected first-pick crash, recovery present1/missing1, attempts2, attribution and each-cherry-pick-exactly-once assertions. No production source or merge queue changes. Failure diagnostics remain for future failures.

Final two-file run: **10/10 passed** (team-nesting7 + supervisor3), 68.56s wall. Crash-resume case17.14s. git diff --check passed. These fixture files are frozen.

## Authorized running-cancellation fixture extension

The original worker-containment fixture canceled after 300ms from decide(), so new source/metadata checks could still be running before process spawn. A cancelled status is correct for that pre-spawn state, whereas the fixture intended to exercise genuinely started external effects and expected uncertain. Replaced the timer with an actual child-written start marker in the fixture's sibling temporary directory (outside the pinned repository). Only after observing the marker does the fixture revoke DB authority. It still requires uncertain, then waits until 2200ms after observing startup, beyond the command's 2000ms delayed sentinel-write deadline, and verifies sentinel preservation. No production code/status weakening.

Focused cancellation verification: **1 passed**, 3.40s test / 7.68s total. This exercised actual process startup, authority revocation, uncertain result and sentinel preservation after the delayed write deadline. Whole worker-containment file: **14/14 passed**, 18.38s tests / 21.86s total, including exact approval/replay, dirty-source, forged actor and runtime-progress check behavior. All three test files and this report are frozen; diff-check clean. Supervisor owns integrated/release validation. No production edits, commits, or provider calls.

## Authorized external recipe timeout addendum

Release fixture used a 1000ms whole-operation deadline while intending to test timeout of a running command. Under load, approval/preflight could consume that deadline before spawn, yielding the correct cancelled result for a different lifecycle state. Updated only tests/external-task-tools.test.ts: a child-written timestamped startup marker lives outside the pinned repository; tool timeout is5000ms, forbidden write is scheduled8000ms after actual startup. The test requires observed start before its deadline, strict uncertain result, numeric quiescedAt after startup, and no forbidden write after8200ms from startup. Outer test budget20s accommodates the deliberate delayed-write proof. Adjacent expired-approval test still covers cancelled/no-spawn behavior unchanged. No production changes or relaxed status assertions.

Eight-case file verification: **8/8 passed**, 24.84s tests / 32.25s total; actual-start timeout case11.25s. git diff --check passed. New test source and report frozen. No production changes, commits, provider calls or additional validation runs.
