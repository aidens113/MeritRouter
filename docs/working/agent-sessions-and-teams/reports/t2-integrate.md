# Report: t2-integrate

Worker report for "Brief: t2-integrate" in
[agent-sessions-and-teams.md](../../agent-sessions-and-teams.md). Worktree `D:\sy-wt\v1`, branch
`feat/t2-nesting`. Nothing was committed.

## Outcome

Done. Every item in the brief is implemented, and each has a test that fails when the fix is
removed.

- `plan_work` accepts `supervise` nodes and sends them through `dispatchBriefs`, the same path
  `delegate` uses: depth limit, branch fork, and budget carve.
- `plan_work` exposes and passes `redundancy`.
- The channel tools are offered only to tasks that belong to a job.
- Three `team.channel_*` config keys replace the channel constants.
- Calibration writes its own event type, `integration_recorded`.
- The integration block now lives in `src/harness/integration-tools.ts`. This was a pure move.
- The watchdog allowance for `integrate_task` scales with the number of job checks.
- `undo kind: task` on a sub-job reverts the commits of every task under it.
- The new surfaces are exported from `src/index.ts`.

Checks:
- `pnpm --filter switchyard-router build`: exit 0.
- `pnpm -r typecheck`: passes for the router and the panel.
- `npx vitest run`: 288 of 288 passed, twice. That is the 283 existing tests plus 5 new ones.

## What changed and why

**`src/harness/integration-tools.ts`** (new, 286 lines; `supervisor-tools.ts` went from 863 to 679 lines)
- **What moved.** These moved out of `supervisor-tools.ts` without changing what they do:
  - `IntegrationTarget`, `TaskView`;
  - `integrationGate`, `integrationGateAfter`, `integrationTargets`;
  - `redelegationBrief`, `describeMerge`, `integrate`;
  - the merge hooks, now named `integrationHooks`;
  - `queueOf`;
  - the `integrate_task` tool, now returned by `integrationTools(s, seam)`.
- **The seam.** `IntegrationSeam` holds the four things integration needs from the delegation
  side: `ownTask(ref)`, `repoFor(alias)`, `identity()`, and `redelegate(name, brief(label), env,
  artifactRefs)`.
  - `supervisor-tools.ts` builds the seam (`seamOf`). In it, `redelegate` slugs the label, skips
    a label already dispatched, and calls `dispatchBriefs`, which is what the old inline hook did.
- **No import cycle.** `integration-tools.ts` imports only types from `supervisor-tools.ts`.
- **Kept the old API.**
  - `supervisor-tools.ts` still exports `mergeHooks(s, env)` (now a wrapper) and re-exports
    `queueOf`. `runners/supervisor.ts` is unchanged.
  - `integrate_task` stays in the same position in the supervisor's tool list.
- **Checked as a pure move.**
  - A `diff` of the old block against the new file shows only the seam substitutions, the rename,
    and two comment changes.
  - An md5 of the `integrate_task` description and its parameters matches the original.

**`src/harness/supervisor-tools.ts`**
- **`plan_work` and redundancy.** Each node now has a `redundancy` property (`enum [1, 2]`, using
  the description from t2-channel). The node mapping passes `redundancy` when it is a number.
- **`supervise` nodes** go through the existing `dispatchBriefs`. On refusal (for example, depth),
  the existing catch withdraws the plan version.
- **Undo by task on a sub-job.**
  - `undo kind: task` now checks whether the target is a sub-job (`subJobTasks`): a `supervise`
    task, together with all its descendants, found breadth-first through `childrenOf`.
  - If so, it reverts the commits whose `Task` trailer names any of those tasks, using the new
    `commitsOfTasks`.
  - `withSubJob` wraps the calibration undo hook so that the sub-job itself also gets an `undone`
    signal. Its integrated result was taken back, so calibration marks it `escaped_defect`.
  - The tool description now mentions sub-jobs.

**`src/harness/tools.ts` and `loop.ts`: channel only inside a job**
- `HarnessTool` has a new optional `available(env)`, and `availableTools(tools, env)` applies it.
- `runAgentLoop` filters the tool list once at the start. An unavailable tool is neither offered
  to the model nor run; a call to one returns "unknown tool". `applyResume` gets the filtered list.
- **Why the loop and not the runners.** The runners (`readonly.ts`, `coding/native.ts`,
  `supervisor.ts`) build the tool lists and are not mine. `brainReadTools()` takes no context, so
  the loop is the narrowest owned place that has `env.ctx.jobId`.

**`src/harness/channel-tools.ts`**
- Both tools declare `available: inJob` (`Boolean(env.ctx.jobId)`).
- `jobOf` still throws "not part of a job" as a second guard.
- The per-author caps are now `cfg.team.channel_max_posts_per_task` and
  `cfg.team.channel_max_posts_per_supervisor`.
- The text length is checked against `cfg.team.channel_max_post_chars` after zod parsing. The
  error is `text is longer than N characters (team.channel_max_post_chars)`.
- The S2 journaling classes are unchanged: `post_channel` is `brain`, `read_channel` is `read`.

**`src/config/schema.ts`** (team section)
- `channel_max_posts_per_task`: default 10, range 1..1000.
- `channel_max_posts_per_supervisor`: default 40, range 1..1000.
- `channel_max_post_chars`: default 2000, range 100..2000. The upper bound is the store's hard
  limit (`CHANNEL_MAX_TEXT_CHARS`). A test asserts that the two agree.

**`src/storage/plans.ts`**
- Removed the `.refine` that refused `supervise` nodes.
- The `superRefine` now also refuses `redundancy: 2` on a `supervise` node.

**`src/verification/calibration.ts`**
- New `INTEGRATION_RECORDED_EVENT = "integration_recorded"`. `recordIntegration` writes it
  instead of `integrated`.
- The `verification_signals` kind `integrated` is unchanged, so calibration (`taskConfirmation`,
  the panel) still reads it.
- `integrated` is now written only by the merge hook (`INTEGRATED_EVENT`,
  `{repository, branch, head}`), which is what `integrationOf` parses.

**`src/core/watchdog.ts`**
- New `WATCHDOG_CHECK_RUNNING_TOOLS = {"integrate_task"}`.
- For a pending `tool_intent` of such a tool, the bound is
  `check_timeout × max(1, task.checks)`, and the allowance is
  `max(watchdog_minutes, bound + 60 s)`.
- Other tools keep a single check timeout.
- The executor already passes `checks` as the job spec's check count for a supervisor task, and
  those are exactly the checks `integrate_task` runs.

**`src/attribution/index.ts`**
- New `commitsOfTasks(repo, range, tasks)`.
- `commitsMatching` and `commitsOfTasks` now share a private `commitsIn`. Its behaviour is the
  same, except that commits with no info are skipped instead of passed as `undefined` to the
  filter.

**`src/index.ts`** exports:
- `jobDepth`, `subJobSection`, `SupervisorState`, `IntegrationRepo`;
- `MergeQueue`, `MERGE_STATES`, `ACTIVE_MERGE_STATES`, `MAX_MERGE_ATTEMPTS`, and the merge types;
- `carvedRequests`, `carvesOf`, `childRequestBudget`, `BudgetCarve`;
- `ChannelStore`, `ChannelError`, `ChannelPostInputSchema`, `CHANNEL_*`, and the channel types;
- `channelTools`, `renderChannelPost`, `mirrorChannel`;
- `MAX_REDUNDANCY`, `REDUNDANT_DIFFICULTIES`, `redundancyFor`;
- `REDUNDANCY_STARTED`, `REDUNDANCY_SKIPPED`, `REDUNDANCY_SETTLED`, `SUPERSEDED`, `RedundancyPlan`;
- `INTEGRATION_RECORDED_EVENT`;
- the watchdog exports, `commitsMatching`, `commitsOfTasks`, `CommitInfo`.

**Tests**
- **`tests/team-integration.test.ts`** (new, 5 tests):
  1. **`plan_work` with a `supervise` node, end to end** (real git, scripted models). It checks:
     - the recorded node;
     - the carve: 14 of 29, the `job_budget_carves` row, and the tool output;
     - the fork: the base commit and `merge-base`;
     - the depth refusal from the sub-job's `plan_work`, with that version withdrawn;
     - that the worker is offered `post_channel` and `read_channel`;
     - `integrated` with the dependents' shape and `integration_recorded` with calibration's
       shape, and `integrationOf` for both levels.

     It then calls `undo {kind: task, target: "sub"}` on the parent's branch. One commit is
     reverted, `subtract` is gone, `undone` events are recorded on the worker and the sub-job, and
     the sub-job is `escaped_defect`.
  2. **`plan_work` with a stubbed delegate service.** The `redundancy` enum is offered, and
     redundancy 2 and 1 are recorded and read back by `redundancyFor`. A `supervise` node is
     accepted, and a `supervise` node with redundancy 2 is refused.
  3. **A standalone inspect task** (no job) has `brain_search` but no `post_channel` or
     `read_channel` among the tools offered.
  4. **Config defaults and bounds**, and configured caps enforced: 100 characters, 2 per worker,
     3 for the supervisor.
  5. **Watchdog with a fake clock.** A real `SessionStore` indexes an `integrate_task`
     `tool_intent`, and `sessionProgress` reads it. With 3 checks, the call is ok at 40 min and
     46 min and stuck at 46 min + 1 ms (allowance 46 min). With 0 checks the allowance is 16 min.
     A `run_command` intent is still 16 min with 3 checks.
- **`tests/team-channel.test.ts`.** The tool unit test's hand-built context now includes a parsed
  `cfg`, since the caps come from config. It asserts `available()`, and it uses
  `cfg.team.channel_max_posts_per_task` instead of the removed import of the
  `DEFAULT_CHANNEL_POSTS_PER_TASK` constant.

## Commands run and observed results

- `npx tsc --noEmit -p .` after each change group: no output.
- **First full `npx vitest run`** after the core changes: 1 failed, 282 passed.
  - The failing test was in `team-channel.test.ts`: "Cannot read properties of undefined (reading
    'team')". Its hand-built context had no `cfg`.
  - After fixing the test: `tests/team-channel.test.ts` 11 of 11.
- **`npx vitest run tests/team-integration.test.ts`:** 5 of 5 passed.
- **Mutation checks.** Each fix was reverted temporarily from a scratchpad copy and then restored.
  Restoration was confirmed with grep, and the full suite passes afterwards. Results:
  - Undo using only the sub-job id fails with
    `expected 'no matching commits on the job branch' to match /^reverted 1 commit\(s\)/`.
  - Dropping the `redundancy` pass-through fails with
    `expected [['twice',1],['once',1]] to deeply equal [['twice',2],['once',1]]`.
  - Making the channel always available fails with
    `expected [...] to not include 'post_channel'`.
  - Using a single check timeout for `integrate_task` fails the watchdog test.
  - Re-adding the supervise refusal fails both `plan_work` tests.
- **Final checks:**
  - `pnpm --filter switchyard-router build`: `tsc -p tsconfig.build.json`, exit 0.
  - `pnpm -r typecheck`: `packages/router typecheck: Done`, `apps/panel typecheck: Done`.
  - `cd packages/router && npx vitest run`: `Test Files 31 passed (31)`,
    `Tests 288 passed (288)`, run twice.
- **Line endings.** Every touched or new file has 0 CR bytes (counted with Python). They were all
  LF before.

## Not verified

- **Watchdog allowance is per call, not per repository.**
  - A sub-job integrated into several repositories runs the job checks once per repository in a
    single `integrate_task` call.
  - `queue.run` may also first recover another owner's item, which runs its own checks.
  - The allowance covers one round of checks (n × check timeout). Several repositories with slow
    checks could still trip the watchdog. Only one repository was tested.
- **The watchdog through the executor.** The allowance was not tested through
  `executor.checkWatchdog` on a live supervisor; only `watchdogVerdict` with indexed session data
  and a fake clock was tested.
- **Other undo kinds on a sub-job.** `undo` by task on a sub-job was tested with one worker
  commit. Nested sub-jobs (depth 3) and partially undone sub-jobs, where a revert could conflict,
  were not tested. Undo by `lines`, `model`, `agent`, or `commit` is unchanged.
- **`plan_work` with a dependent of a `supervise` node.** A dependent of a supervise node, which
  waits on its integration and base commit, was not tested end to end.
- **No live providers.** Tests ran on Windows only.

## Open questions or contradictions found

1. **`src/storage/channel.ts` is not mine.** Its `DEFAULT_CHANNEL_POSTS_PER_TASK` and
   `DEFAULT_CHANNEL_POSTS_PER_SUPERVISOR` are now unused in `src/` and no longer used in tests.
   Its comment still says "proposed config key". Please delete them, or point the comment at
   `team.channel_max_posts_per_task`. `CHANNEL_MAX_TEXT_CHARS` stays: it is the hard limit, and
   the config key's upper bound mirrors it.
2. **The charter (`charters/supervisor.md`, not mine)** should say:
   - when to use `redundancy: 2`: small T1/T2 non-coding nodes;
   - that `plan_work` accepts `supervise` nodes;
   - that `undo kind: task` on a sub-job reverts its whole sub-team.
3. **Docs** (`docs/roles.md`, `operations.md`, `decisions.md`) are not updated. They should cover
   the three `team.channel_*` keys, the `integration_recorded` event, the watchdog rule for
   `integrate_task`, and the channel's availability rule. Presets are not regenerated: they list
   only `team.max_agents`, and the new keys have defaults.
4. **Design choice to confirm.** The channel is hidden through a general `HarnessTool.available`
   filter in the agent loop, not through runner wiring, because the runners are outside my
   ownership. If you prefer explicit wiring, the runners could pass `ctx` to `brainReadTools`, and
   the filter would stay as a backstop.
5. **Calibration choice to confirm.** Undoing a sub-job also records an `undone` signal on the
   sub-job itself (`withSubJob`), not only on its workers. This makes the sub-job's integrated
   result count as an escaped defect.
