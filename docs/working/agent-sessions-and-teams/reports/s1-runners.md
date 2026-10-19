# Report: s1-runners

Worker report for "Brief: s1-runners (after s1-store)" in [agent-sessions-and-teams.md](../../agent-sessions-and-teams.md).

## Outcome

Done. Every runner now records into an agent session: completion, batch, read-only, native
coding, external coding (through the policy gateway), supervisor, and the classifier. The
agent loop journals each tool call, terminal tools included. Tools declare `sideEffect`.
Coding runs and supervisors record their workspace pointer. Delegated tasks carry the
delegating session as their parent. `src/sessions/**` was not edited.

## What changed and why

- `src/core/executor.ts`
  - `ExecutorDeps.sessions: SessionStore | null`. When it is null, `ctx.session` stays null and
    nothing is recorded.
  - `openSession` opens one session per run:
    - role from `roleForProfile`; label `agentLabel(role, spec.label ?? taskId)`, which matches
      the commit/brain actor label;
    - `profile` and `tier` from the run's plan; `jobId` from the existing job rule, now the
      helper `jobIdFor`;
    - `previousSessionId`: the task's latest non-classifier session (a recovery re-run), or the
      session just ended (an escalation);
    - `parentSessionId`: from the task's first `delegated_by_session` event, validated with zod.
  - `sessionEnd(state, stopReason)` maps outcomes to end statuses:
    - `budget_exhausted` ends as `failed` with stopReason exactly `budget_exhausted`;
    - `completed`, `failed`, `interrupted`, and `cancelled` map to themselves, with the runner's
      stopReason.
  - Runs that end without an outcome:
    - a thrown error or abort ends with the `classify` disposition: final gives its state and
      stopReason, a capacity defer gives `interrupted` with `deferred_for_capacity: <why>`, and
      abandon (shutdown, lease lost) gives `interrupted` with the reason;
    - an escalated run ends as `<stopReason>; escalated to <tier>`;
    - a `finally` block ends any session still open as `failed`/`executor_error`.
  - `endSession` catches a failure in `end()` and records a `session_record_failed` task event.
    The task outcome is already decided at that point, so the failure is not rethrown.
  - Batches: each member gets its own session after classification. Members that leave without
    an outcome end as `batch_aborted`.
- `src/core/service.ts`
  - Passes `sessions` to the executor.
  - `submitTasks` accepts `opts.parentSessionId` and writes a `delegated_by_session` task event
    for each new (non-deduplicated) task before `scheduler.kick()`, so the child's first
    session always sees it. I chose this over looking the parent up at run time to avoid a race
    between submission and claim.
- `src/harness/tools.ts` and `src/harness/supervisor-tools.ts`
  - `HarnessTool` gains `sideEffect: ToolSideEffect` and an optional `idempotent`. The
    `tool()` helpers take the side effect as their second argument, so every new tool must
    declare one.
  - Side effects by tool:
    - `read`: list_files, read_file, search, read_artifact, brain_search, brain_read,
      brain_list, brain_my_requests, brain_access_requests, task_result, blame;
    - `edit`: write_file, replace_in_file, delete_file, integrate_task, undo;
    - `command`: run_command, run_check (neither marked idempotent);
    - `brain`: brain_set_current_state, brain_append_ledger, brain_write,
      brain_promote_lesson, brain_compact, brain_request_access, brain_decide_request;
    - `delegate`: delegate, cancel_tasks;
    - `none`: await_tasks;
    - `external`: ask_user.
  - Terminal tools and unknown tool names are journaled as `none`.
  - `delegate` passes the supervisor's session id to `submitTasks`; see Open questions about
    the interface type.
- `src/harness/loop.ts`
  - `journaled()` writes `tool_intent` (callId, name, parsed args or the raw string when the
    arguments are not valid JSON, sideEffect, idempotent) before the tool runs, and
    `tool_outcome` (ok, output) after.
  - Terminal calls are journaled too: ok means accepted, and the output is "accepted" or the
    rejection text.
  - The loop calls `syncMessages` after each turn and before each return, so the last turn's
    tool results are in the log even though no request follows them.
  - One behaviour change: a non-terminal tool call with invalid JSON arguments now returns
    `error: <tool> arguments are not valid JSON` instead of the raw `SyntaxError` text.
- `src/runners/batch.ts`: one physical request serves every pending item, so each item's
  session records:
  - a `note` "shared batch request (round N, K item(s)); this task is item iX", with
    `{executionId, itemId, members}`;
  - `syncMessages`, `modelRequest`, and then `modelResponse` or `modelError`.

  `ask()` is called with `{...first, session: null}`, so no session gets the request twice.
  Each item also gets a note when it is accepted or rejected. I picked this as the simplest
  correct approach: every member's log is complete on its own, and the shared execution id plus
  the member list show that the request was shared. `model_requests` counts 1 per member per
  round, the same as task usage.
- `src/scoring/classifier.ts`
  - Each classification request opens one `classifier` session per task in the batch:
    taskId, jobId, label `classifier:<label|id>`, tier from the plan, profile null.
  - When several tasks share the request, each session gets a shared-request note. The request
    and the response or error are recorded in each session.
  - A session ends `completed`/`classified` with a "verdict" note, or `failed` with
    `classifier_failed: <msg>` or `no_valid_verdict`.
  - Cached verdicts open no session. The classifier builds its own `SessionStore(db,
    cfg.storageDir, now)`; the store is stateless, so `router.ts` did not need to change.
- `src/runners/session-workspace.ts` (new): `WorkspacePointer`.
  - It records the `workspace` event only when the pointer changes. `setHead(alias, sha)`
    records after a commit, and `refresh()` re-reads HEAD.
  - Callers:
    - native coding: after the worktree is prepared (base = head) and after each per-response
      commit;
    - external coding: the same, after each snapshot commit;
    - supervisor: integration repos with their job branch and current HEAD, after each
      response commit, and after every `edit` supervisor tool (integrate_task, undo).
- `src/runners/coding/index.ts`: the external runner also adds a note that the agent's own tool
  calls are not journaled. They run inside its process, so they appear only in the transcript
  it sends.
- `tests/session-recording.test.ts` (new, 10 tests). The tests cover:
  - completion: events, label, counters, and end status;
  - escalation linkage;
  - read-only journal order (intent < outcome < next intent) with an unknown tool, invalid JSON
    arguments, and the terminal tool, plus the final "accepted" message in the log;
  - `budget_exhausted` ending as failed/`budget_exhausted`;
  - batch: three item sessions sharing one request id;
  - classifier sessions, shared and linked;
  - native coding: edit journal and the workspace head moving;
  - external agent: gateway requests recorded and the head moving;
  - supervisor: tool side effects, job-branch workspace, head moved by integrate_task, and the
    child's `parentSessionId`/`jobId`;
  - a shutdown giving `interrupted`/`shutdown` with the in-flight `ask_user` journaled as
    failed, and the resumed run as a new session with `previousSessionId` whose transcript
    includes the resume notice.

## Commands run and observed results

- `npx tsc --noEmit -p .` (packages/router): no output.
- `npx vitest run tests/session-recording.test.ts`: `Tests 10 passed (10)`.
- `pnpm -r typecheck`: `packages/router typecheck: Done`, `apps/panel typecheck: Done`. Run
  again after the last edit, with the same result.
- `npx vitest run tests` (packages/router): `Test Files 16 passed (16)`, `Tests 122 passed
  (122)`. Run again after the last edit, with the same result. The total includes the
  parallel workers' new tests in this checkout.
- I did not run `pnpm --filter switchyard-router build`, as instructed.

## Not verified

- No test builds a `RunContext` or an `Executor` by hand with no store. The `session: null`
  path in the loop and batch code is covered only by type checking and by s1-store's
  `ask()`-without-session test.
- Recording failures (disk full, fsync errors) on the runner paths are not exercised. The
  classifier treats a failure to open a session as a classification failure, which rounds the
  tier up. In the executor, a failure to open a session fails the task as `internal_error`.
- Batch error paths: the round where an `AdmissionDenied` drops one member, and the case where
  `runBatch` throws. The code ends those sessions, but no test drives them.
- Capacity deferral producing `interrupted`/`deferred_for_capacity` is not tested.
- Real OpenCode was not run; only the `fake-agent.mjs` command runner.

## Open questions or contradictions found

- `SupervisorServices.submitTasks` in `src/runners/types.ts` (not mine) declares opts as only
  `{ purpose?: string }`. `delegate` passes a variable typed `{ purpose: "work";
  parentSessionId?: string }`, which TypeScript allows, and the service reads the extra field.
  Suggested one-line follow-up: add `parentSessionId?: string` to that interface.
- A deferred-for-capacity run ends `interrupted`. S2 should decide whether resume treats it
  like a crash, or whether it should end `failed` with that reason. The task re-runs as a new
  session either way, linked by `previousSessionId`.
- Side-effect choices that S2 may want to revisit:
  - `cancel_tasks` is `delegate` (re-issuing is safe);
  - `ask_user` is `external` (re-asking would duplicate the question);
  - `brain_request_access` and `brain_decide_request` are `brain`, although they write
    SQLite rows, not brain git commits;
  - `run_check` is not marked idempotent.
- Pre-existing, not changed: when `runBatch` throws, members that had already finished inside
  it are neither recorded nor settled by the executor. Their sessions now end as
  `batch_aborted`, but the task rows keep the earlier behaviour.
- Classifier sessions have no parent. They are part of routing, not of the delegating
  session.
