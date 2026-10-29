# Report: merge-check-publication

## Outcome

Done within assigned files; source frozen for root verification. Confirmed and repaired transient integration publication before awaited checks. No live runtime, provider, application or configuration changes.

## Reproduction and cause

`MergeQueue.finish` previously invoked the integration hook, set queue state `integrated`, and emitted `merge_integrated` before awaiting `hooks.checks`. The actual `TaskStore.claim` dependency gate treats that state as satisfied. A command-filing exception could then roll back the Git branch and mark the queue failed after a dependent had already started and after success events were visible.

The new real-Git temporary fixture holds a check on a deferred promise, samples the queue/events and invokes actual `TaskStore.claim` during the wait. It covers normal zero/nonzero check returns and an exception followed by branch rollback. No fake scheduler or provider response supplies the observed claim result.

## Changes

- `packages/router/src/workspaces/merge-queue.ts`: keep the item `picked` and withhold the integration hook/state/events until checks return normally. Checks still run outside the Git mutation fence and inside the branch mutex. Reacquire the mutation fence and verify the captured HEAD before publication, including when a check hook returns an empty list. Preserve recorded nonzero checks as integrated results rather than rolling them back. Database-only integration callbacks remain outside the Git fence for existing crash-recovery behavior.
- `packages/router/tests/merge-check-publication.test.ts`: three deterministic deferred-check regressions. While checks wait, no integration receipt/event is emitted and the dependent remains `waiting_for_dependencies`. Thrown checks restore the owned branch, leave a failed queue item and no success events, and keep the dependent blocked. Returned zero/nonzero checks publish integration and then permit dependency admission.

## Validation

- Red: `pnpm exec vitest run tests/merge-check-publication.test.ts --maxWorkers=1` -> **3 failed**,10.14s; actual pending state `integrated`, expected `picked`.
- Additional red after moving the scheduler assertion first: same command with `-t 'throw'` -> **1 failed /2 skipped**,4.15s; actual dependent state `running`, expected `waiting_for_dependencies`.
- Green: `pnpm exec vitest run tests/merge-check-publication.test.ts tests/project-metadata-merge-queue.test.ts --maxWorkers=1` -> **14 passed /2 files**,34.24s. Includes unchanged pending-publication snapshot, long-check fence release, acceptance rollback, foreign-head preservation and missing-pick evidence tests.
- After that run, added explicit `checked: MergeItem` type annotation only to accommodate nullable persisted `afterHead`. No behavior changed. Root owns combined typecheck/build and wider checks.

## Limits

No broad suite run by this worker. Existing `RepositoryMutationError`/`SelectedCommitError` paths still preserve uncertain ownership and recovery evidence instead of forcing rollback; ordinary thrown check errors use the existing owned-chain rollback path. This repair does not introduce recovery authority, approve commands, or change human/digest/source/lease policy. Crash during final bookkeeping remains recoverable from `picked` under the existing idempotent callbacks. Source and tests are frozen; no tests remain running.
