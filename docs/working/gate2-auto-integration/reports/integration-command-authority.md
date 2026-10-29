# Report: integration-command-authority

## Outcome

Initial read-only diagnosis confirmed a split path mismatch in command approval authority. A later bounded brief authorized the framework repair and isolated fake-provider tests recorded below. No live DB writes, live approvals, real-provider calls or application edits.

## Exact cause

`packages/router/src/runners/supervisor.ts:230` creates integration worktrees under `projectRuntimeActivationRoots(ctx.cfg).worktrees`. For split project contexts (`storageDir=<project>/.MeritRouter/state`) that helper returns `<project>/.MeritRouter/worktrees` (`workspaces/worktree.ts:34`).

`harness/worker-actions.ts:152` instead derives allowed supervisor integration roots from `path.join(ctx.cfg.storageDir, "worktrees", ...)`, which becomes `<project>/.MeritRouter/state/worktrees/job-...`. The actual integration root is neither that path nor the canonical repository, and supervisor jobs have no ordinary task-workspace row that could admit it. Therefore human-only command filing rejects the actual cwd at line 155. Lease/supervisor authority checks succeeded before this cwd check; bypassing those checks is unnecessary.

`harness/integration-tools.ts:208` runs each job check through `executeSupervisorCommand` at `item.integrationWorktree` after picking the accepted task. Under human-only host policy this reaches the bad root allowlist. This explains why earlier split A/B integration tests passed: their jobs had no command checks and never exercised this approval filing path.

## Branch, rollback and readers

Read-only Git observation during this audit:

- Canonical project and actual fresh-job integration worktree both currently resolve to `a63e3be664d0b7fa94d7480723f119271e272284` (initial commit).
- Integration worktree `git --no-optional-locks ... status --porcelain` returned empty.
- Job reflog shows `e2adeb067b6fae5603fda66c6068a5fb27d55fd2` and `ff18404eb2d9804e019833e75f5b3a10d74d5126` cherry-picks, each followed by reset to the initial commit. Thus the earlier observed contract commit was a real transient advance that the queue subsequently rolled back; it is not present on the current job branch.

`merge-queue.ts:finish` records the integrated event/state before invoking `hooks.checks`. A thrown check-filing error propagates into `pickAndFinish`'s ordinary-error catch, which restores the owned branch chain and records `failed`. That matches the observed reflog. A normal nonzero check result is recorded without rollback; this exception is a different path. No queue/DB state was read or changed in this audit, so exact persisted row/signal outcomes remain unverified.

The supervisor replaces canonical readers with `new RepoReader(alias, integrationWorktree, null)` (`supervisor.ts:337`). Worktree file/list reads go to the current filesystem/index, without a cached file list or pinned commit. An empty initial tree after rollback therefore explains the reads. `RepoReader` does cache HEAD/dirty metadata, and pointer refresh does not invalidate those caches; that is a separate possible provenance/dirty-label issue, not evidence that current file reads are pinned to the initial commit.

## Minimal proposed implementation brief

1. Own `packages/router/src/harness/worker-actions.ts` and new `tests/split-supervisor-command-authority.test.ts`; import/reuse `projectRuntimeActivationRoots` for the supervisor-only allowed integration root instead of rebuilding a legacy path. Preserve exact realpath equality, persisted lease, own project/store, source digest and human approval checks. Do not broaden to arbitrary descendants or every session worktree.
2. Regression first: actual split service/supervisor with a declared post-integration command check and human-only policy. Confirm command request is filed at the exact job worktree, remains pending without approval, then an explicit fixture operator approves that exact source-bound command; queue completes, real integrated HEAD remains, dependent starts from that head. Confirm another job's worktree and sibling path are still refused. Existing no-check A/B regression is insufficient.
3. Run focused authority/approval/integration tests serially after the current full-suite freeze ends. Include legacy layout control to preserve its original allowed path. Supervisor independently validates/builds/restarts at a safe boundary, preserving prior usage and failed integration evidence.
4. Optional separately owned follow-up: `integration-tools.ts:128` also reconstructs a sub-job worktree from `cfg.storageDir/worktrees`; use the same activation helper there with a sub-job split fixture. This is adjacent, not required to explain the current task integration failure.

## Separate lifecycle risk to preserve

Because integration events/state precede exception-prone command checks, an exception and rollback can leave earlier integration signals or a brief scheduler window that treats the result as integrated. Scheduler failure-state waiting helps after rollback, but the transient release and stale event consequences were not reproduced here. A focused future queue regression should throw during checks after a successful pick and inspect final branch, merge state, emitted authority/evidence, and a dependent that becomes runnable during the check. Do not claim successful integration solely from a stale event or transient Git log.

## Authorized repair and validation

Subsequent bounded brief authorized only `src/harness/worker-actions.ts`, new `tests/split-integration-command-authority.test.ts`, and this report. Implemented exactly the activation-root import/reuse in the supervisor-only integration allowlist. Exact task-derived cwd/realpath equality, current lease/supervisor/project guards, source digest and human-only policy remain unchanged.

New test uses an actual split service, real temporary Git worktrees, native coding runner and scripted fake provider. It accepts A/B through real supervisor tools with declared job checks. An explicit fixture operator inspects the exact pending request/source digest before approving each integration/final check. It confirms the dependent's base equals A's integrated head and final branch remains at B's integrated head. Another job's worktree, foreign project repository, arbitrary source subdirectory and a persisted unauthorized inspect task cannot use the supervisor cwd. A separate legacy installation control approves its original exact integration root.

- Red before runtime edit: `pnpm exec vitest run tests/split-integration-command-authority.test.ts --maxWorkers=1` -> **1 failed**, 29.66s. Actual accept_task output contains the live assigned-cwd refusal; job ends `internal_error: worker action cwd must be an assigned repository or task workspace`.
- First green attempt reached actual pending approval but negative test setup manually claimed its inspect fixture without required split coordination fairness: **1 failed / 17 passed**, 60.37s. Fixed only that new fixture to use `project_fifo` with the exact local store identity. Existing approval/clock assertions were unchanged.
- Final command: `pnpm exec vitest run tests/split-integration-command-authority.test.ts tests/supervisor-action-clock.test.ts tests/approval-execution-timeout.test.ts --maxWorkers=1` -> **19/19 passed, 3 files**, 81.97s (new authority 2/2, approval timing 14/14, injected clock 3/3). `git diff --check` exit 0, CRLF warnings only. Source/tests frozen for supervisor verification; no tests running.

No broad checks, live writes, real-provider calls, application edits, commits or pushes. Adjacent sub-job root reconstruction, reader metadata-cache invalidation and exception-after-integration evidence ordering remain follow-ups outside this repair; no claim they were fixed.
