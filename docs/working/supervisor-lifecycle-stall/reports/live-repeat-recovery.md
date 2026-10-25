# Live supervisor repeat-observation correction

Status: implemented, focused checks passed; supervisor integration/live recovery pending.

## Cause
The generic loop accumulates observation equality per exact signature across all turns. `await_tasks` is intentionally repeatable and has sideEffect none, so actual waits did not clear previous `task_result` observations. In the live parent, its third running observation stopped the supervisor even after a real bounded wait for an operator command.

## Change
- `packages/router/src/harness/tools.ts`: optional host-only shared observationWait epoch receipt, never populated from model arguments or output prose.
- `packages/router/src/harness/loop.ts`: creates a new receipt per loop; after successful tool execution, clears the observation window only if a trusted receipt advanced. Effect deduplication remains untouched.
- `packages/router/src/harness/supervisor-tools.ts`: actual await_tasks advances receipt only when the trusted service reports positive measured waitedSeconds, and cancellation is absent. Immediate returns/unknown legacy wait duration do not reset history.
- `packages/router/src/runners/types.ts`: exposes optional waitedSeconds already returned by the real service; absent legacy fixture metrics conservatively grant no progress.
- `packages/router/tests/harness-repeat-policy.test.ts`: four regressions cover real supervisor-tool waits against unchanged running task results; immediate returns still fail on third observation; fabricated wait prose grants nothing; cancellation and request caps remain enforced.

## Validation
- `pnpm exec vitest run tests/harness-repeat-policy.test.ts tests/supervisor-human-approval-wait.test.ts --maxWorkers=1 --reporter=dot` (packages/router): 27/27 tests, 2 files passed, 11.89s.
- `pnpm exec tsc --noEmit` (packages/router): exit0 after adding the optional service metric. Initial check found the missing metric in the narrow interface and was corrected. One accidental root-directory tsc invocation printed help because root has no tsconfig; that was not counted as validation.
- No application edits, live-provider calls, runtime state changes, commits, or pushes performed.

## Recovery recommendation
Current failed tasks cannot use supported resume. A narrow trusted failed-supervisor continuation can reopen only the verified repeated-observation stop, preserve original deadline/request accounting/retained workspace, and enter a linked supervisor session or explicitly reconciled interrupted continuation. Never broadly reopen cancelled/arbitrarily failed tasks or reset budgets/deadlines. A separate worker owns recovery implementation.

## Limits
Full recursive checks/build and actual runtime recovery are for the senior supervisor. The receipt does not exempt status tools: three immediate identical reads still fail. Repeated waits remain bounded by the task deadline and admitted model requests. Actual bounded waits clear the observation window even if child state remains running; that is deliberate asynchronous coordination rather than proof the product is complete.
