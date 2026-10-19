# Report: s2-exec

Worker report for "Brief: s2-exec (after s2-core)" in [agent-sessions-and-teams.md](../../agent-sessions-and-teams.md),
plus the supervisor's extra items (index exports, `sessions.recover_edits`, the panel `resumed` event,
the terminal-tool shortcut, re-runs under the same call id, `markDeadRunning` at recovery).

## Outcome

Done. The executor, scheduler, harness loop, and runners now apply the S2 resume rule. An interrupted
session of an agent-loop role is reopened and continued. A completion or batch task re-runs fresh in a
new session linked to the old one. Supervisors resume from their session; `job_state` is read only as
a fallback and is no longer written. Native coding tasks auto-resume in the same worktree, with
interrupted edits reconciled. `Switchyard.resumeSession(id)` exists. A test-only fault hook
(`SWITCHYARD_FAULT_AT`) simulates process death.

Results: `pnpm -r typecheck` passes for the router and the panel, after the router `dist` was
rebuilt. `npx vitest run tests` passes 144 of 144 tests. That is 134 existing tests, of which 4 were
updated for the new behaviour, plus 10 new tests in `tests/session-faults.test.ts`. Nothing in
`src/sessions/**` was changed; I found no bug there.

## What changed and why

**New files**
- `src/core/faults.ts`: the fault hook.
  - Syntax: `SWITCHYARD_FAULT_AT=<point>[:<n>][:<name>]`.
  - Points: `after_tool_intent`, `after_tool_run`, `after_model_request`, `after_model_response`.
  - `n` is the n-th hit. `name` filters by tool name (tool points) or request purpose (model points).
    I added this optional third segment beyond the brief, so a test can pick out one call while
    child tasks run in the same process.
  - It throws `SimulatedCrash`. Also exports `isSimulatedCrash`, `resetFaults`, and
    `simulatedCrashCount` (tests wait on the count).
- `src/harness/journal.ts`: `journaled()` and `parseArgs()`, moved out of `loop.ts` so the loop and
  the resume code share them. Fault points `after_tool_intent` and `after_tool_run` sit here.
- `src/harness/resume.ts`: `applyResume()` (runs inside `runAgentLoop`) and `restoreEvidence()`.
  `applyResume` does these steps in order:
  1. Restores the evidence universe from the logged tool outputs:
     - `read_file` and `brain_read` `ref:` headers;
     - `read_artifact` refs;
     - edited files that are on disk.
     Without this, a resumed worker cannot cite files it read before the crash.
  2. Performs the plan's actions:
     - `rerun_tool`: journaled under the original `callId`;
     - `reconcile_edits`: per repository, aborts an interrupted cherry-pick or revert, then stages and
       diffs against HEAD. `commit` commits as `<role>: recovered edits after interruption` under the
       session's actor and moves the pointer. `reset` runs `reset --hard`. Commits made after the
       recorded head are kept. The text comes from `editRecoveryMessage`.
     - `report_external`: calls a runner callback.
  3. Writes `recorder.resumed(summary, actionsWithResults, plan)`.
  4. Checks the terminal call of the last turn:
     - `accepted` (outcome logged): it calls `accept` again to get the value and finishes without a
       request.
     - Never validated (`RESUME_TEXT.retry` or `notRun`): it re-runs `accept`, journaled under the
       same call id, and finishes if it is accepted.
     - Otherwise it appends the resume notice (`plan.summary` plus the runner's notice) as a user
       message.

**Changed router files**
- `src/harness/loop.ts`:
  - New `LoopOptions.resume?: ResumeInput`, applied before the first request.
  - `persist` was removed.
- `src/runners/types.ts`:
  - `RunContext.resume: { plan: ResumePlan } | null`.
  - `ask()` has the `after_model_request` and `after_model_response` fault points.
- `src/core/executor.ts`:
  - `runSingle` first ends any still-running session of the task: this process holds the lease, so
    those sessions belong to a dead process.
  - After `prepare`, `resumeFor(task)` applies the rule:
    - only for `read_only`, `coding`, and `supervisor` modes;
    - the target is the latest non-classifier session, or the one a directive names;
    - the target must be `interrupted`;
    - if the plan has no messages, the run starts fresh;
    - otherwise the session is reopened and a `session_resumed` task event is written.
  - Only the first attempt resumes; an escalation starts fresh.
  - A resume failure is recorded as `session_resume_failed`, and the run continues fresh.
  - A `SimulatedCrash` (in prepare, the run, or a batch) sets `crashed`. That skips session ending,
    settle, and record, but still clears the heartbeat timers, as process death would.
  - New `ResumeDirectiveSchema` (`{sessionId?, freshWorkspace?}`), read from the `resumed` task event
    that precedes the current claim.
- `src/core/scheduler.ts`:
  - Takes the `SessionStore`.
  - `recover()` calls `markDeadRunning(s => !s.taskId || tasks.leaseLive(s.taskId))` after
    `recoverExpiredLeases`.
  - Auto-resume now includes coding tasks (`run_count < 3`).
- `src/core/service.ts`. The `openDatabase` line was not touched.
  - The scheduler gets `this.sessions`.
  - `resumeTask(id)` passes `{freshWorkspace: true}` for coding tasks, so they start over in a new
    worktree. Other roles continue their session.
  - New `resumeSession(sessionId) -> {taskId, state}`:
    - validates the session (exists, has a task, is `interrupted`);
    - first settles a session still `running` whose lease is dead (`recoverExpiredLeases` plus
      `markDeadRunning`);
    - then calls `tasks.resume(taskId, {sessionId})`.
- `src/storage/tasks.ts`:
  - `resume(id, directive = {})` writes the directive on the `resumed` event.
  - New `leaseLive(id)`.
  - New `childrenOf(parentTaskId)`, using `json_extract` on `spec.parentTaskId`.
- `src/runners/readonly.ts`: on resume, it continues `plan.messages`. It still builds the fresh
  messages so the provided-context evidence is registered.
- `src/runners/coding/finish.ts`: new `resumeWorkspace(ctx, plan.workspace)`. It reuses the recorded
  worktree if it still exists (using the `workspaces` row when its path matches) and writes a
  `worktree_reused` event.
- `src/runners/coding/native.ts`:
  - It resumes in the same worktree. The pointer starts at the worktree's actual HEAD, and
    reconciliation commits under `workerActor`.
  - If the worktree is gone, it uses a fresh worktree and tells the model.
- `src/runners/coding/index.ts`: the external runner relaunches in the recorded worktree.
  - It applies `sessions.recover_edits` to leftover changes: commit as a recovered snapshot, or reset.
  - It writes `resumed` with no actions.
  - It appends a "Resumed after an interruption" section to `TASK.md`, with the summary and the
    agent's last three assistant messages.
- `src/runners/supervisor.ts`:
  - `saveState` was removed, and `job_state` is no longer written.
  - `loadLegacyState` is used only when the run is not a session resume.
  - On resume:
    - repositories come from `plan.workspace`;
    - children and brief checks come from `tasks.childrenOf(job)`, on every run;
    - `ask_user` with no outcome is answered from `job_questions` (answer, still open, or never
      recorded);
    - the notice keeps "Check your tasks with await_tasks..." plus answered and open questions.
  - `integrationRepos` reuses `job-<id>-<alias>` if the branch and the worktree already exist (a run
    that died before recording its workspace).
- `src/harness/supervisor-tools.ts` (`delegate`). A re-run delegation (labels already in `children`):
  - adds no worker toward `max_workers_per_job`;
  - does not clash with itself in the overlap check;
  - does not append its brief to the working document again. `Brain.addBrief` is not idempotent;
    without this, a resumed delegation duplicated the brief.
- `src/config/schema.ts`: `sessions: { recover_edits: "commit" | "reset" }` (default `commit`), as
  an inline enum to avoid a config-to-sessions import.
- `src/index.ts`: exports the s2-core API listed in its report:
  - `planResume`, `replayTranscript`, `pendingIntentsFrom`, `editRecoveryMessage`, `RESUME_TEXT`, and
    their types;
  - `ResumeActionSchema`, `RecoverEditsPolicySchema`, and their types;
  - `PROCESS_DIED` and `ReopenOptions`.

**Panel**
- `apps/panel/components/session-timeline.tsx`: a `resumed` label, a `RotateCcw` icon, and a warn dot.
  A `ResumedView` shows the summary, each action with its result, and the counts of settled intents
  and dropped requests.

**Tests**
- New `tests/session-faults.test.ts`, 10 tests. Each one does the following:
  1. Arms the fault and submits.
  2. Waits for the crash and closes.
  3. Asserts that the task is still `running` and its session is still `running`.
  4. Opens a worker whose clock is 10 minutes ahead (past the lease), and asserts the final state.

  The cases:
  - **Read-only, `after_tool_run` on `read_file`:** same session; `ended` is `process_died` then
    `worker_submitted`; the summary says "interrupted; call again"; 3 requests.
  - **Read-only on a paid route, `after_tool_run` on `submit_result`:** finishes with no new
    request:
    - 2 `FakeDirect` calls;
    - `spend.week` is 2 x $0.006;
    - 2 `model_request` and 2 `model_response` events;
    - the submit is journaled twice under `submit1`, with one `accepted` outcome.
  - **Accepted submission (`after_tool_intent:2:read_file`, a read in the same turn after an accepted
    submit):** finishes with that submission; 2 requests.
  - **Native coding, `after_tool_run` on `replace_in_file`:**
    - same session and the only worktree for the task;
    - `subtract` appears once;
    - git log since base is exactly `implementer: recovered edits after interruption` with Agent
      `implementer:sub`;
    - the pointer head equals HEAD;
    - the `reconcile_edits` result text is exact, and the model saw it in `edit0`'s tool message;
    - one `replace_in_file` intent;
    - checks pass, acceptance `met`.
  - **Native coding, `after_tool_intent` on `replace_in_file`:** "no uncommitted changes" result;
    the model edits again; `subtract` appears once; the only commit is the per-response commit.
  - **Lost response, `after_model_response` on `tool_loop`:** the response is restored; `read0`
    gets the "not run" text; 3 requests and 3 responses in all.
  - **Supervisor, `after_tool_run` on `delegate`:**
    - one child task;
    - the brief appears once in the working document;
    - one supervisor session;
    - a `rerun_tool` action with result `subtract -> <id> (<state>, already submitted)`;
    - two `delegate` intents, both `delegate0`;
    - the child's parent session is the supervisor's;
    - `return a - b` appears once in the integration worktree;
    - `supervisor_completed`, acceptance `met`.
  - **Completion, `after_model_request` on `completion`:** two sessions; the first is
    `interrupted/process_died`; the second is completed with `previousSessionId` set and no
    `resumed` event; 1 gateway request.
  - **Operator `resumeTask` on a coding task:** a fresh worktree and a linked new session; the old
    worktree keeps the uncommitted edit.
  - **`resumeSession` on a session left `running`:** an unknown id throws; the session is settled
    first; then the same session continues.
- Existing tests updated for the new behaviour:
  - `execution.test.ts`: coding work is now auto-resumed (`queued`, `queued`).
  - `supervisor.test.ts`:
    - the integration worktree is read from the session workspace;
    - the test asserts there is no `job_state` row;
    - the resume notice is matched on "has been resumed".
  - `session-recording.test.ts`: a shutdown now continues the same session, with a "reopened" note
    and one `resumed` event.

## Commands run and observed results

- `npx tsc --noEmit -p .` (packages/router), after each edit group: no output. The first run reported
  the removed `persist` option in `supervisor.ts`; that is fixed.
- `pnpm --filter switchyard-router build`: `tsc -p tsconfig.build.json`, no errors.
- First full `npx vitest run tests` after the source changes: 4 failed, 130 passed. The 4 failures
  were exactly the old-behaviour assertions:
  - coding not resumed;
  - `job_state` `detail_json`;
  - the "You were interrupted" text;
  - "a new session linked to it".
  After updating them, those 3 files passed: 29 of 29.
- `npx vitest run tests/session-faults.test.ts`:
  - First run: 3 failed. Two had a wrong expectation: read-only acceptance is `not_verified`, because
    a worker's own "met" is a claim. One counted classifier requests in `client.requests`.
  - After fixing the tests: 7 of 7, then 9 of 9 (operator-resume cases added), then the
    accepted-submission case alone: 1 passed.
- Final, from D:\sy-wt\s2:
  - `pnpm --filter switchyard-router build`: no errors.
  - `pnpm -r typecheck`: `packages/router typecheck: Done`, `apps/panel typecheck: Done`.
  - `npx vitest run tests` (packages/router): `Test Files 18 passed (18)`, `Tests 144 passed (144)`.

## Not verified

- **External coding resume.** It has no test. Its relaunch path (same worktree, recovered snapshot,
  `TASK.md` resume section) has only been typechecked. The fault hook cannot kill it either: model
  fault points fire inside the policy gateway's HTTP handler, which would turn the crash into an
  error response.
- **Batch runs.** A crash during a batch is handled in the executor (`crashed` skips ending the
  sessions), but no test injects one.
- **`sessions.recover_edits: reset`** against git: no fault test covers it, and the external runner's
  reset branch is not tested either.
- **The supervisor's interrupted cherry-pick or revert abort** (`abortSequencer`) has not been tested.
- **The panel `resumed` rendering.** It typechecks, but I did not build the panel, seed the demo, or
  take screenshots.
- **Two processes racing** on resume: not tested.
- **Real crashes.** The tests simulate death in-process; no real process was killed.

## Open questions or contradictions found

1. **`src/admin/insights.ts` `jobDetail` still reads `job_state`** for the job's branches and
   transcript. New jobs never write it now, so the panel's job page will show no branches and no
   transcript for them. This is s2-surface's file: switch it to the job's latest session (transcript
   via `sy.sessions.transcript`, branches from `SessionRecord.workspace`).
2. **Documentation is not updated:** `docs/roles.md` and `docs/operations.md` (recovery, coding
   auto-resume, `sessions.recover_edits`, `resumeSession`, the fault hook). Those files are outside
   my ownership. Generated presets (`scripts/build-presets.mjs`) were not regenerated. The
   `sessions` key has a default, so existing configs and presets still parse.
3. **`resumeTask(id)` semantics.** Coding tasks start over in a fresh worktree (as decided); every
   other role continues its session. s2-surface should map `switchyard resume <session-id>` to
   `resumeSession` and keep task ids on `resumeTask`.
4. **The fault hook's third `:<name>` segment** goes beyond the brief's `<point>[:<n>]`. The brief's
   form still works unchanged.
5. **On resume, `restoreEvidence` lets a worker cite a file that a reconciled edit touched**, the
   same as a normal edit would. A file whose interrupted read never logged an output is not citable
   until it is read again.
