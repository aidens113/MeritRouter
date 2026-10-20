# Report: t2-nesting

Worker report for "Brief: t2-nesting" (T2 sub-supervisors and merge queue). Worktree `D:\sy-wt\v1`,
branch `feat/t2-nesting`. Nothing committed.

## Outcome

Done, with one edit outside my owned paths: `src/storage/tasks.ts`. Without it a nested job
deadlocks under the default `supervisor.max_concurrent_jobs: 1`. See "Open questions" 1.

Every item in the brief's definition of done is met:
- A nested job runs parent -> sub-supervisor -> worker, under the default job slot of 1. The
  worker's Agent/Model/Task trailers survive two cherry-picks onto the parent branch, blame names
  the worker, and no integration is lost.
- Two integrations started together are serialised, and the second is rebased.
- A crash in the middle of an integration resumes without a double cherry-pick. This holds at the
  queue level and through a real S2 supervisor resume.

Checks:
- `pnpm -r typecheck`: passes.
- `pnpm --filter switchyard-router build`: exit 0.
- `npx vitest run`: 272 of 272 passed, twice. That is 265 existing tests plus 7 new ones.

`plan_work` with `supervise` nodes still fails: `src/storage/plans.ts` (not mine) refuses them.
See "Open questions" 2.

## What changed and why

**Config** (`src/config/schema.ts`, team section only)
- New `team.max_depth` (default 2, range 1..5). A top-level job is depth 1, so 2 allows one level
  of sub-supervisors and 1 turns nesting off.
- New `team.child_budget_share` (default 0.5).
- New constant `MIN_CHILD_REQUESTS = 3`. A carve smaller than this is refused.

**Migration** (`src/storage/migrations.ts`, one appended entry). It must be ordered against
t2-channel's at merge.
- `job_budget_carves` has one row per sub-job: child, parent, requests, parent_remaining, share,
  depth.
- `merge_queue` has one row per integration item. It records:
  - kind (`task` or `job`), repo, branch, and lock_key;
  - the integration worktree and the source worktree;
  - source base and head, and the commits;
  - state: `queued`, `integrating`, `picked`, `integrated`, `conflict`, `redelegated`, `refused`,
    `failed`;
  - owner, attempts, before and after head, rebased, acceptance, redelegated_to, detail.
- `merge_queue.job_id` has no foreign key on purpose. Existing tests build a `SupervisorState`
  with a fake job id (`job-1`), and foreign keys are on.

**Admission** (`src/admission/admission.ts`)
- `carvedRequests(db, parent)`: an open sub-job holds its whole carve. A finished one counts only
  what it used, including its own sub-jobs, so unused requests go back to the parent.
- `childRequestBudget(...)` (pure): the carve is `floor(share × (cap − used − carved))`, or null
  when that is below the minimum.
- `recordCarve` (idempotent per child) and `carvesOf` record and list carves.
- `Admission.reserve` now refuses a request when `used + carved + 1 > max`. The message names the
  carved amount.

**Merge queue** (`src/workspaces/merge-queue.ts`, new)
- API: `MergeQueue(db, events, owner)` with `enqueue`, `run`, `recover`, `latest`, `forJob`,
  `mayRedelegate`. Also exported: `pickedSources`, `abortInProgress`, `MERGE_PICK_FAULT`.
- **Picking.** Commits are cherry-picked one at a time with `-x`, and a commit whose
  `(cherry picked from commit <sha>)` line is already on the branch since `before_head` is skipped.
  This is the rule that prevents double picks.
- **Serialisation.**
  - Within a process, `run` chains on a promise per branch.
  - Across runs, `run` first recovers any item a different owner left `integrating` or `picked` on
    the same branch.
  - A branch belongs to one job, and only one process holds a job's task lease, so the job lease is
    the cross-process lock. No separate DB lock is taken.
- **Conflicts.**
  1. The pick is aborted and the branch reset (`reset --keep`) to `before_head`.
  2. If the source worktree is clean, the item is rebased in that worktree with
     `git rebase --empty=drop --onto <branch head> <source base> <recorded source head>`. Starting
     from the recorded head means a repeat after a crash replays the same commits.
  3. If the rebase succeeds, the new commits are recorded and picked.
  4. If the rebase also conflicts, the rebase is aborted and the `redelegate` hook is called once.
     `mayRedelegate` is false when the task came from a re-delegation, or when it already has a
     `redelegated` item.
  5. Otherwise the item ends `conflict`. If the hook throws, that is also `conflict`, with
     `detail.redelegateError`.
- **Finish.**
  1. The `accept` hook runs. If it refuses, the branch is reset and the item ends `refused`.
  2. The `integrated` hook runs, and the item ends `integrated`.
  3. The `checks` hook runs, and its results are stored in `detail.checks`.
- **Crash recovery** (`recover` at runner start, or lazily in `run`):
  1. An in-progress cherry-pick or rebase is aborted, in the integration worktree and in the source
     worktree.
  2. A `queued` item is processed.
  3. A `picked` item finishes.
  4. An `integrating` item with every commit present goes to `picked` and finishes.
  5. Otherwise, if attempts are below 2 it is retried, picking only the missing commits.
  6. Otherwise it ends `failed` and the branch is restored.
- **Simulated crashes.** `isSimulatedCrash` errors are always rethrown untouched, so a test crash
  leaves the item recoverable.
- **Fault point.** `faultPoint("after_tool_run", "merge_queue_pick")` runs after each pick. It is
  armed with `SWITCHYARD_FAULT_AT=after_tool_run:<n>:merge_queue_pick`, so `core/faults.ts` did not
  need a change.
- **Task events** on the item's task: `merge_queued` (with `ahead`), `merge_integrating`,
  `merge_rebased`, `merge_conflict`, `merge_redelegated`, `merge_refused`, `merge_failed`,
  `merge_recovered` (outcome, present, missing, aborted), `merge_integrated`, `merge_checks`.

**Supervisor tools** (`src/harness/supervisor-tools.ts`)
- `SupervisorState` has three new optional fields: `queue`, `depth`, `docSection`. They are created
  or computed when absent, so tests that build states by hand still work.
- New exports: `jobDepth`, `subJobSection`, `queueOf`, `mergeHooks`, `ensureCarves`.
- **`delegate` and `plan_work` offer `supervise`** only while the job's depth is below
  `team.max_depth`. Both the enum and `dispatchBriefs` enforce it; the error is
  `<label>: sub-supervisors are limited to team.max_depth N; this job is at depth N`.
- **A supervise brief becomes a sub-job task:**
  - `profile: supervise` and `parentTaskId` set to the parent job;
  - `baseCommits` for every writable repo is the parent's integration-worktree HEAD, so the child
    branch `switchyard/job-<child>` forks from the parent's branch;
  - `budget.maxModelRequests` is the carve;
  - `brain.effort` is the parent's effort;
  - no hints and no allowedPaths.
- **The carve is recorded right after submission.** If a crash lands between the two,
  `ensureCarves` repairs it when the job resumes.
- **The sub-job's section.** The parent writes `## Sub-job: <label>` (brief, branches, budget, and
  depth) before `Work Ledger`.
- **Briefs dispatched by a sub-job** go into that sub-job's section, above its status. They do not
  go to `Worker Briefs`.
- **New tool `brain_set_job_section`** (sub-jobs only). It rewrites the `**Sub-job status:**`
  part and keeps the record above it.
- **`integrate_task` now goes through the queue.**
  - A call for a task that is already queued or integrated continues or reports it without running
    the gate again (`already integrated ...; nothing was picked again`).
  - The gate itself is unchanged: out-of-scope refused, unmet refused, `accept_test_changes`,
    `accept: true` plus a reason for `not_verified` and `needs_supervisor`, verified-tree binding,
    strict-human refusal. It runs before anything is queued.
  - Acceptance is recorded only after the picks succeed. If it is refused, the integration is
    rolled back, as before.
  - The `INTEGRATED_EVENT` is now written after `recordIntegration`. See "Open questions" 5.
  - Sub-job targets are `refs/heads/switchyard/job-<child>` from the child's recorded base, one per
    parent repo where the branch exists. The source worktree is
    `<storage>/worktrees/job-<child>-<alias>`.
  - The job checks (`spec.constraints.checks`) run in the integration worktree after each
    integration. They are logged as artifacts and recorded with `recordJobCheck`.
  - Re-delegation submits `<label>-rebase` through `dispatchBriefs`. It copies the original spec,
    adds the conflict to the goal, sets the base to the current job branch, and attaches the patch
    refs as `artifactRefs`.
  - Calling `integrate_task` on the original after a re-delegation is an explicit retry: it creates
    a new item, says so in a note, and never re-delegates a second time.
- **Output wording.** The existing message shapes are kept: `integrated N commit(s) ... your
  acceptance is recorded`, `conflict integrating ... no acceptance was recorded`, `refused: ...
  rolled back`, `nothing to integrate: the task made no commits ...`. A new `job checks after it:`
  suffix is added.

**Supervisor runner** (`src/runners/supervisor.ts`)
- It detects a sub-job (the parent is a supervise task) and computes the depth.
- It creates one `MergeQueue` per run, with owner `mqrun_*`, and calls `ensureCarves`.
- A sub-job gets:
  - its section, created if the parent's write failed;
  - its section as its "Current State" input;
  - a system-prompt note on its level, branch, and section;
  - its tools without `brain_set_current_state` and `brain_compact`;
  - a ledger title of `Sub-job <label> <status>`.
- A top-level job below the depth limit is told it may use sub-supervisors.
- Before the loop, `queue.recover(job, mergeHooks(...))` runs. Its outcomes are added to the S2
  resume notice (or the legacy notice, or a fresh user message) as "Merge queue after the
  interruption ...". `merge_recovery_failed` is recorded if recovery throws.

**Task store** (`src/storage/tasks.ts`, not owned; see "Open questions" 1)
- In `claim`, a supervise task with a `parentTaskId` (a sub-supervisor) takes neither a
  `max_concurrent_jobs` slot nor a worker slot. It counts toward its parent job's
  `team.max_agents` instead, and gets the supervisor timeout.
- Top-level supervisors are counted as before.

**Charter** (`charters/supervisor.md`)
- New section "Hand whole sub-goals to sub-supervisors".
- "Integrate" is rewritten for the merge queue: one at a time, trailers kept, checks after each,
  rebase then re-delegate once, and re-calling is safe.

**Tests** (`tests/team-nesting.test.ts`, new, 7 tests)
1. **Nested job end to end** (real git, scripted models, default job slot of 1). It checks:
   - carve 14 of 29 remaining, the `job_budget_carves` row, and that a finished sub-job counts only
     what it used;
   - the depth refusal in the sub-job, and that the `supervise` enum is offered only to the parent;
   - the sub-job's tools (section tool present, no Current State tool);
   - the fork point (`merge-base` equals the parent's base);
   - the worker commit on the parent branch with `implementer:w1`, its task id, and its model;
   - two `cherry picked from` lines on that commit, and blame naming the worker;
   - queue items on both branches, checks passed, and a re-call that picks nothing;
   - the parent session link;
   - the doc section (both briefs and the status) and the `Sub-job sub completed` ledger entry.
2. **Two integrations started together** (`Promise.all`): at most one active at a time, order
   A then B. B's duplicate first commit makes its pick fail, B is rebased (`dropped: 1`), and both
   are integrated with their trailers.
3. **A real conflict:** the rebase conflicts too, so the task is re-delegated once. The branch and
   the source worktree are unchanged. A second attempt on the original ends `conflict` without
   another re-delegation.
4. **A crash after pick 2 of 3**, with a cherry-pick also left in progress: recovery aborts it and
   picks only the third commit. Each source sha appears exactly once on the branch.
5. **A crash after the last pick** completes with nothing picked again. **Two crashes mid-item**
   (3 commits) end `failed`, with the branch restored to its head before the item.
6. **The budget formula.**
7. **A crash through S2 resume.** The supervisor dies after the first of the worker's 2 picks.
   After a restart the queue finishes the item before the model acts, the notice lists it, and
   `integrate_task` reports "already integrated". Each commit is on the branch once.

## Commands run and observed results

- `npx tsc --noEmit -p .` (packages/router), after each change group: no output, so it passes.
- **First full `npx vitest run`** after the core changes: 3 failed, 262 passed.
  - `security.test.ts` (2 tests): `jobDepth` was called on a state with `db: {}`.
  - `verification-review.test.ts`: the automatic re-delegation blocked the re-integration the test
    does after resetting the branch.
  - Fixes:
    - `depthOf` falls back to depth 1 when there is no task store;
    - a re-delegated item no longer blocks an explicit retry (re-delegation is still at most once).
  - After the fixes, those 6 files passed (63 tests).
- **First `npx vitest run tests/team-nesting.test.ts`:** 3 failed, 4 passed.
  - Two failures were CRLF in the fixture file (`core.autocrlf`). The assertions now normalise line
    endings, and `line()` keeps `\r`.
  - One was my test data: edits on adjacent lines 3 and 4 make a real git merge conflict. The
    queue handled it correctly (it rolled back and ended `conflict`).
  - The next failure was also my test's expectation: a second crash after the last pick correctly
    completes the item. I added a third commit so the exhausted-retry path is exercised.
  - Final run: 7 of 7 passed.
- **Final checks:**
  - `pnpm --filter switchyard-router build`: exit 0.
  - `pnpm -r typecheck`: `packages/router typecheck: Done`, `apps/panel typecheck: Done`.
  - `cd packages/router && npx vitest run`: `Test Files 29 passed (29)`, `Tests 272 passed (272)`,
    run twice. A third run after the last runner edits gave the same result: 272 of 272 in 44.5 s.

## Not verified

- **`plan_work` with `supervise` nodes.** `PlanStore` refuses them (plans.ts:27), so the tool
  returns an error. Only `delegate` was tested end to end.
- **Two processes integrating on one branch at the same time.** The design relies on the job's
  task lease, and it is not tested.
- **Real process death mid-integration.** It was simulated in-process. The S2 test closes the
  process after a caught simulated crash (`ask_user` holds the turn); no process was killed.
- **The watchdog with long job checks inside `integrate_task`.** The tool's allowance is one check
  timeout plus 60 s, and several slow checks could exceed it.
- **External (OpenCode or command) coding tasks.** Their commits go through the same queue, but
  that path was not tested.
- **Multi-repository sub-jobs.** Only one repository was tested.
- **`sessions.recover_edits: reset` combined with an interrupted `integrate_task`.**
- **No live providers.**

## Open questions or contradictions found

1. **`src/storage/tasks.ts` was edited outside ownership.**
   - Without the change, a sub-supervisor needs a `supervisor.max_concurrent_jobs` slot. The
     default is 1, and the parent holds it while it waits, so the child is never claimed.
   - Counting sub-supervisors as workers instead could starve their own workers of
     `max_concurrent_tasks` slots.
   - The change is three small hunks in `claim`. Please keep it or move it at merge. t2-channel
     does not own this file.
2. **`plan_work` and `supervise`.** Remove the
   `.refine((p) => p !== "supervise", ...)` on `profile` in `src/storage/plans.ts` (line 27),
   which is t2-channel's file. Then `plan_work` dispatches supervise nodes through the same
   `dispatchBriefs` path, carves included. `nodeWeight` for a supervise node falls back to the
   profile's `min_tier` (T3, weight 4).
3. **Supervisor wiring at merge.** The channel tools still need wiring into the supervisor's tool
   list, as the T2 split notes. The sub-job filter in `supervisor.ts` only removes
   `brain_set_current_state` and `brain_compact`.
4. **Not exported from `src/index.ts`** (not mine), for t2-surface:
   - `MergeQueue`, `MergeItem`, `MERGE_STATES`, `carvesOf`, `carvedRequests`, `jobDepth`,
     `subJobSection`.
   - Stable read API: `new MergeQueue(db, tasks, "reader").forJob(jobId)` and
     `carvesOf(db, parentId)`.
   - The job tree is `tasks.childrenOf(jobId)`, filtered on `spec.profile === "supervise"`.
5. **Existing bug fixed in passing.** Both `INTEGRATED_EVENT` (`{repository, branch, head}`) and
   calibration's `recordIntegration` write a task event of type `integrated`. `integrationOf()`
   (context/upstream.ts) parses the latest one with a strict schema. `integrate_task` used to write
   `recordIntegration`'s event last, so `integrationOf` returned null after a real integration and
   dependents never saw it.
   - I now write `INTEGRATED_EVENT` last.
   - A cleaner fix is to give the calibration event its own type (`calibration_integrated`) in
     `verification/calibration.ts`, which is not mine.
6. **File size.** `src/harness/supervisor-tools.ts` is now 863 lines, over the ~800 guideline.
   - Why: delegation (with sub-jobs and carves) and integration (gate, targets, queue hooks,
     output) now both live there.
   - Suggested split: move the integration block (`integrationGate`, `integrationGateAfter`,
     `integrationTargets`, `redelegationBrief`, `mergeHooks`, `describeMerge`, `integrate`, about
     230 lines) to a new `src/harness/integration-tools.ts`. That path is outside my ownership.
7. **Semantics to confirm.**
   - **"Rebase when clean".** I read it as: rebase in the item's worktree when that worktree is
     clean, and integrate if the rebase applies cleanly. In git, a rebase only succeeds where the
     cherry-pick failed when the branch already has a commit's change (the commit becomes empty and
     is dropped). That is the case the DoD test uses. A textual conflict conflicts in both, and goes
     to re-delegation.
   - **Re-delegation is automatic**, once per task, from inside `integrate_task`. The tool
     description and the charter say so.
   - **Job checks that fail after an integration** are reported and recorded as calibration
     signals. They do not undo the integration automatically.
8. **Accounting choice.** A finished sub-job returns its unused carve to the parent. A sub-job
   left `interrupted` holds its full carve.
9. **Not done.**
   - **Paid budget.** The child is given no `maxPaidUsd` share; only requests are carved.
   - **Scope.** A sub-job's write scope is not limited by the parent's `allowed_paths`; only its
     workers' briefs scope edits.
   - **`undo kind: task`** on the parent, targeting a sub-job, matches nothing, because the commits
     carry the workers' Task trailers. Undo by commit or by agent works.
10. **Docs** (`docs/roles.md`, `operations.md`, `decisions.md`) and the regenerated presets are not
    updated: they are outside my ownership. The new `team` keys have defaults, so existing configs
    and presets still parse.
