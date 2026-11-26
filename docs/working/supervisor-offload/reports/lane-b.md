# Lane B: channel backend

Worker: worker-heavy (Opus 5.5, high). Date: 2026-11-25/26. Branch: dev, main checkout, uncommitted.

## Outcome

Done. `SupervisorChannelService` is implemented twice and wired in:

- `ChannelService` is the supervisor's side, exposed as `MeritRouter.channel`.
- `RunChannel` is one worker run's side, exposed as `RunContext.channel`.

No migration was needed. Lineage uses the existing `task_rework` table. The rework start and
lineage go in a task event. The package typecheck is clean, and the new test file passes 12/12.
Some existing tests fail, and every one of those failures also happens in a baseline copy without
my changes (details below).

## What changed and why

**`packages/router/src/core/channel-service.ts` (new)**

`RunChannel(stores, taskId, lease, now)` is bound to one task and its captured lease.

- **postFromWorker**
  - Accepts only the run's own task id, and the lease must still be live.
  - A tool_request must name known worker tools (`KNOWN_WORKER_TOOLS`).
  - A read-only task cannot request write tools.
  - The idempotency key (the tool call id) returns the first message after an interruption.
- **awaitReply**
  - Polls the store every 100 ms and makes no model requests.
  - Before every poll it checks the lease (`tasks.dispatchable`) and the abort signal. It rejects when either fails.
  - It pauses the operation execution clocks through `pauseOperationExecutionTimeout`, the same pattern as `awaitWorkerAction`.
  - It records `channel_wait` and `channel_wait_end` task events.
  - It resolves in one of three ways:
    - `answered`: the reply is marked delivered.
    - `expired`.
    - `timeout`, with `guidance: "no answer, proceed or stop"`. The request stays pending, so a later answer reaches `pendingForWorker`.
  - The wait has no cap of its own. The task deadline, the lease and cancellation bound it.
- **replyFromSupervisor**
  - On this side it records the worker's answer to a supervisor probe of its own task. Only `kind: "answer"` is allowed.
  - A worker can never answer its own request, which would let it grant itself tools.
  - The same call is also exposed as `replyFromWorker`.
- **pendingForWorker and grantedTools** cover the run's own task only.
- **probe, rework and listPendingForSupervisor** are refused on this side.
- **markDelivered(id)** is an extra method, not part of the interface. See open question 1.

`ChannelService(deps)` routes every call through `ProjectStoreRouter` to the store that holds the
task or message. A split installation has one store per project.

- **postFromWorker** requires a non-terminal task.
- **awaitReply** has no lease to check.
- **replyFromSupervisor**
  - Answers worker requests only.
  - Atomicity comes from `SupervisorChannelStore.answer`. A double answer fails with `already_answered`.
  - A grant may name only requested, known tools, and never write tools for a read-only task.
- **probe(taskId, question)**
  - Posts the probe and then re-reads the task state, so a probe cannot fall between "running" and "finished".
  - **Running, queued or interrupted task:** the probe stays pending for the worker's next turn.
  - **Finished task:** the service submits a read-only `summarize` task.
    - Its purpose is `probe` and its idempotency key is `probe-answer:<probe id>`.
    - Its `inlineText` is the probed task's goal, result, findings, checks, changed paths and transcript tail, from `sessions/probe-record.ts`. The bound is 48k characters, and the material is quoted as data.
    - The service waits up to `min(60, execution.await_max_seconds)` seconds for it.
    - The task's summary and findings become the probe's `answer`.
    - The answer's evidence refs are: `task:<probed>`, `session:<id>` for each author session, patch refs, check log refs, artifact refs, and `task:<answer task>`. At most 32 refs.
    - The answer task's model request goes through the gate like any other.
  - **Answer task fails or cannot start:** the probe is answered with an explicit "No answer: ... ended <state> (<reason>)".
- **rework(taskId, feedback, criteria)** works on finished, non-supervisor tasks only.
  - The new task's id is deterministic (`rw-<sha256 prefix>`) and its key is `rework:<orig>:<digest>`, so repeating the call returns the same task.
  - The spec is the original spec with these changes:
    - The feedback is appended to the goal under a "Supervisor rework" heading.
    - `criteria` are appended to the acceptance criteria.
    - The writable repository, allowedPaths and checks stay the same.
    - `dependsOn` and `repairSource` are dropped.
    - For a coding task, `baseCommits[alias]` is set to the original base, so the patch stays cumulative.
  - The candidate commit is found with `unfinishedWorkStart`. It is the original worktree's HEAD, after committing any leftovers.
  - The rework refuses if the original changed files but its worktree is gone.
  - Write order:
    1. The `supervisor_rework` event `{reworkOf, feedback, criteria, start, base}` is written on the new id **before** the task exists. This way the executor can never claim the task without its start.
    2. The task is submitted.
    3. A rework notice is posted on the original task (refs `task:<new>`).
    4. `recordRework` records the lineage.
    5. The notice is marked delivered. This settles Phase 1 open question 4.
- **pendingForWorker, grantedTools and listPendingForSupervisor(projectScope?)**
  - The listing covers all stores and projects when no scope is given. It runs a synchronous sweep first.
- **Extra methods (not in the interface):**
  - `acknowledge(ids)`: marks worker replies received.
  - `replyTo(requestId)`.
  - `messagesForTask(taskId)`.
  - `onTaskSettled(id)`.
  - `reconcile()`.
  - `close()`.
- **Settling finished tasks.** This happens on the `settled` event and in the sweep:
  - Pending worker requests are expired.
  - Undelivered supervisor replies to a worker that is gone are expired.
  - A probe whose answer task finished gets its answer recorded.
  - A probe of a finished task that has no answer task gets one started.
  - A probe left open when its running task finished without answering is answered from the record.
  - Settlement is deferred with `setImmediate` if the database is inside a transaction.
- **Restart and multi-process safety.**
  - `reconcile()` runs at worker start. It repairs rework lineage from `supervisor_rework` events (a crash between submit and link) and sweeps every store.
  - A probe-answer task is linked to its probe only when the task has the key **and** the `probe` purpose.

**`packages/router/src/sessions/probe-record.ts` (new)**

- `renderProbeRecord(task, sessions, maxChars)` produces bounded plain text from the task's goal and result, plus the newest transcript messages of the last author session.
- System prompts are left out. Each message is clipped to 2k characters and tool arguments to 400.

**`packages/router/src/core/executor.ts`** (I own this construction site)

- `context()` builds `channel: new RunChannel({db: d.tasks.db, tasks: d.tasks}, task.row.id, lease, now)`. This covers every run context in both the legacy and the split executor. `projects/runtime-services.ts` needed no change.
- Reviewer contexts drop `channel`. A reviewer does not speak on the worker's channel.
- `reworkRetry()` applies when a coding task has a `supervisor_rework` event with a start.
  - The first run gets a `RetryContext` with reason `supervisor_rework` and `startFrom` set to the candidate.
  - A later repair or escalation with no start of its own keeps the candidate start.
  - A non-null retry also means a rework's first attempt never runs as a redundant twin.

**`packages/router/src/core/service.ts`**

- The constructor assigns `this.channel = this.channelService` (a `ChannelService`) after `stores` is built.
- It registers the `settled` listener on `channelService`, so the hook survives a test swapping `channel`.
- `reconcile()` runs after `startWorker` when the worker option is on.
- `closeOnce` awaits `channelService.close()`, which aborts and drains in-flight probe answers.

**`packages/router/tests/offload-channel.test.ts` (new, 12 tests)**

These tests use a real MeritRouter, fake coding runners, a `ScriptedClient` or `FakeProvider`, and temp configs and stores. Every router and database is closed before cleanup.

- A worker question through the real executor:
  - `ctx.channel` is a `RunChannel`.
  - No model request is made during a 300 ms wait.
  - The answer resumes the worker, and the reply shows as delivered.
- Timeout returns "no answer, proceed or stop". An abort rejects. Cancelling the task rejects the wait and expires the request.
- Restart: a request filed before close is found after reopening. The same idempotency key returns the same message, and a later reply reaches a waiter.
- Three concurrent answers, one on a second database connection, store exactly one reply.
- Tool grants:
  - A grant takes effect, and a grant of tools that were not requested is refused.
  - A read-only task cannot request or be granted write tools.
  - Unknown tools are refused.
- RunChannel boundaries: another task's id, a self-grant and the supervisor-only calls are all refused.
- Probing a running task: the worker answers with refs, and `acknowledge` removes the answer from the inbox.
- Probing a finished task:
  - Exactly one extra gated model request.
  - The request carries the question and the recorded material.
  - The answer has the probed task as its first ref and the answer task (purpose `probe`) as its last.
- A running task that finishes without answering its probe has the probe answered from the record.
- Rework with a real `prepareWorkspace`:
  - The rework worktree starts at the candidate commit and contains the first attempt's change.
  - It has the original base, the feedback, the extra criteria and the same scope.
  - Repeating the call is idempotent.
  - Lineage is recorded, the notice is delivered, and the source checkout is untouched.
- Rework is refused for a running task and an unknown task. Reconcile repairs lineage left by a crash.
- Split layout: rows live in the project's own store, none in the installation store, and the probe is answered there.

## Commands run and observed results

- `cd packages/router && pnpm typecheck` → `tsc -p tsconfig.json --noEmit`, no output. Run after the final edits.
- `npx vitest run tests/offload-channel.test.ts tests/offload-contracts.test.ts` → `Test Files 2 passed (2)`, `Tests 34 passed (34)`. Run after the final edits.
- First regression run, 17 files, under load:
  - Command: `npx vitest run tests/offload-contracts.test.ts tests/session-faults.test.ts tests/session-recording.test.ts tests/session-resume.test.ts tests/session-surface.test.ts tests/sessions.test.ts tests/task-queue.test.ts tests/task-leases.test.ts tests/task-recovery-retention.test.ts tests/task-startup-recovery.test.ts tests/executor-task-leases.test.ts tests/execution.test.ts tests/verification-resume.test.ts tests/verification-flow.test.ts tests/repair-hydration.test.ts tests/approval-execution-timeout.test.ts tests/coding.test.ts`
  - Result: `Test Files 6 failed | 11 passed (17)`, `Tests 20 failed | 206 passed (226)`.
- **Baseline.** I made a scratch copy of the current working tree with only my changes reverted: `executor.ts` and `service.ts` restored from HEAD, and my new files removed. node_modules was a junction; I removed it afterwards and confirmed the real node_modules is intact.
  - Command: `npx vitest run tests/session-faults.test.ts tests/session-recording.test.ts tests/verification-resume.test.ts tests/approval-execution-timeout.test.ts tests/coding.test.ts`
  - Result: `Tests 18 failed | 37 passed (55)`. These are the same named failures as with my changes:

    | File | Failing tests |
    | --- | --- |
    | session-faults | 5 |
    | session-recording | native journaling, external agent, and the supervisor shutdown/resume test (it failed alone in the baseline too) |
    | verification-resume | 3 |
    | coding | 2 external-runner tests |
    | approval-execution-timeout | 6 in the baseline, 4 with my changes; this file is timing-sensitive |

  - Causes seen in the output:
    - `ConfigError` for the external runners. Lane C is removing that option.
    - `declared_checks environment_failure` / `needs_supervisor`. Checks need supervisor action approval, and `open()` has no test operator.
  - These failures come from code I do not own, which is being edited concurrently: runners/coding, harness, config/schema and tests/helpers.
- `tests/task-recovery-retention.test.ts` timed out at 120 s under load in both regression runs. Run alone it gives `Tests 10 passed (10)`.
- Second regression run, 14 files, after the final edits:
  - Command: `npx vitest run tests/session-resume.test.ts tests/session-surface.test.ts tests/sessions.test.ts tests/task-queue.test.ts tests/task-leases.test.ts tests/task-startup-recovery.test.ts tests/task-recovery-retention.test.ts tests/executor-task-leases.test.ts tests/execution.test.ts tests/verification-flow.test.ts tests/repair-hydration.test.ts tests/project-runtime-store.test.ts tests/projects.test.ts tests/split-cli-reads.test.ts`
  - Result: `Tests 1 failed | 172 passed (173)`. The one failure is the load timeout in task-recovery-retention described above.

## Not verified

- The full router suite (about 3,400 tests), MCP tests, `pnpm -r typecheck` and `pnpm -r build`.
- The real harness tools (lane C) calling `ctx.channel`. Only fake runners call it here.
- That the watchdog leaves a waiting worker alone. That depends on lane C's tool names being in `WATCHDOG_EXEMPT_TOOLS`. ask_supervisor, request_tools and report_blocked are already listed there.
- Restart through the executor: the interrupted run is resumed, its tool call is re-run with the same id, and it waits again. Restart is tested at the service and store level only.
- Probing a finished coding task with a long native transcript. The probe test uses a completion task.
- Two separate processes (an MCP server plus a worker daemon) settling the same probe. Only in-process concurrency is tested, plus a second database connection racing on an answer.

## Open questions or contradictions found

1. **Gaps in the interface.**
   - **Worker side:** `SupervisorChannelService` has no way to mark a message delivered, but lane C's brief says the loop "marks delivered". I added `RunChannel.markDelivered(id)`. Alternatively, lane C can call `new SupervisorChannelStore(ctx.tasks.db).markDelivered(id)`. The lead could also add `markDelivered` to the interface.
   - **Supervisor side:** there is no way to acknowledge a probe answer, so it would stay in `listPendingForSupervisor` forever. There is also no way to read a request's reply. `ChannelService.acknowledge(ids)` and `replyTo(id)` exist, and lane A can reach them by casting `router.channel`. Adding both to the interface is a one-line change for each.
2. **How a worker answers a probe.** Through the interface, the worker answers a probe with `ctx.channel.replyFromSupervisor({messageId, kind: "answer", body, refs})`, because `RunChannel` speaks only for the worker. The name reads oddly. `replyFromWorker` is the explicit form.
3. **Probes are requests, not deliverables.** `pendingForWorker` returns a probe until the worker answers it. Lane C should inject each probe id once per run, or accept the repeat.
4. **"Read-only resume" is not a literal session reopen.** A finished task has no lease, and the gate refuses a task request without one. The probe is answered by a new gated read-only task that reads the session's recorded transcript. It does not get the original endpoint's prompt cache.
5. **Retry wording for a rework.** A rework's first run carries `RetryContext.reason = "supervisor_rework"`. `renderRetryContext` (lane C's `prompts.ts`) prints it as "Previous attempt ... was not accepted: supervisor_rework (...)". The meaning is right but lane C may want different wording.
6. **Documentation not updated.** `docs/roles.md` and `docs/operations.md` say nothing about the channel. I do not own them.
