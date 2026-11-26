# Phase 1 contracts: Brief v1, Report v1, Channel v1

Worker: worker-heavy (Opus 5.5, high). Date: 2026-11-25. Branch: dev, main checkout, uncommitted.

## Outcome

Partial. All four deliverables are implemented and tested. Typecheck is clean. One registry file
I do not own, `src/projects/store-export.ts`, still has to classify the two new tables. Until it
does, 21 project-migration tests fail with `unclassified_tables`. I tested the exact two-line
patch in a scratch copy of the package (see below), and it makes those tests pass.

## What changed and why

- `packages/router/src/core/brief.ts` (new)
  - `BriefV1Schema` is strict. Fields: kind, goal, context, scope, tools, checks, doneWhen,
    report.detail (default standard) and budget.requests. It also accepts optional `version: 1`,
    `idempotencyKey` and `label`, which pass through to the task so a repeated `delegate` stays
    idempotent.
  - `lintBrief` returns `{errors, warnings}` as `{code, field, message}` items. Each message says
    how to fix the problem.
    - Errors: a writable brief (edit, implement, or writable run) without allowedPaths or a
      repository; edit or implement not writable; implement or run without checks; goal under 30
      characters or 5 words; vague doneWhen; scout, summarize or review set writable; a bare file
      path with no repository; an unknown tool name; write tools granted while writable is false;
      a read-only run that does not name exactly one repository.
    - Warnings: vague goal wording, broad allowedPaths, edit without checks, a "passes"
      criterion with no checks, no context, an always-on tool listed explicitly, budget under 3,
      duplicate checks.
  - `checkBrief(raw)` runs the schema and the lint together.
  - `briefToTaskArgument(brief)` throws `BriefError` if lint finds errors. Otherwise it returns a
    `WorkerTaskInput`. The test confirms that output parses with both `WorkerTaskSchema` and the
    MCP `TaskArgumentSchema`.
    - Kind maps to profile: scout -> inspect, summarize -> summarize, review -> review,
      edit/implement -> implement, run -> inspect (implement when writable).
  - Tool grants and report detail have no place in today's task contract, so they stay on the
    brief. Read them with `resolveBriefTools(brief)` and `brief.report.detail`.
  - `TOOL_PROFILES` maps each profile to existing harness tool names. A test builds the real
    registries (repoTools, editTools, artifactTool, declaredCheckTool, commandTool,
    brainReadTools, webTools, labHarnessTools, requestBudgetTool, workerActionTools,
    operationRegistry, SUBMIT_RESULT_DEF) and fails on any profile name that does not exist.
  - `ALWAYS_ON_WORKER_TOOLS` = ask_supervisor, request_tools, report_blocked, reply_supervisor
    (added at the lead's request), submit_result. A test asserts that none of them collides with
    an existing tool except submit_result.
  - `WRITE_TOOLS` and `KNOWN_WORKER_TOOLS` are exported for the worker-side lane.
- `packages/router/src/core/report.ts` (new)
  - `SelfCheckSchema` is strict: notTested[], assumptions[], riskiestChange (required),
    checkNext[].
  - `renderReportV1(result, {detail, messages, criteria, diffstat, checkTails, claimedChecks,
    refs})` always emits these nine sections in order: Outcome (with a "Needs attention" line),
    Summary, Changed, Checks, Criteria, Claims not verified by the harness, Self-check, Open
    messages, Drill-down refs.
  - Check labels:
    - `VERIFIED pass` or `VERIFIED fail (exit N)` only for `result.checks`, which the harness ran.
    - `STALE` when the verification record marks a check stale.
    - `VERIFIED did not finish` when there is no exit code.
    - `CLAIMED by the worker` for `claimedChecks`.
    - Policy checks the harness did not run as commands are shown with their outcome, e.g. NOT
      RUN or FAILED.
  - Worker text (summary, findings, message bodies) is quoted with `> `.
  - There is no length cap on worker content. A 2000-line summary is shown in full at every
    detail level.
  - Detail controls verbosity: how many log tail lines are shown (brief 0/10, standard 10/40,
    full 80/200 for passing/failing checks), whether met criteria are listed, and whether
    evidence refs, usage and answered messages appear. Full logs and diffs stay behind refs.
  - The renderer is pure. Callers fetch log text and diffstat and pass them in.
- `packages/router/src/core/channel.ts` (new)
  - `ChannelMessageSchema` has every field in the brief plus `projectId` (copied from the task
    row, never taken from the caller), `deliveredAt` and `expiredAt`.
  - The schema enforces three rules: which direction each kind may travel; replies (answer,
    grant, deny) and only replies carry `inReplyTo`; only requests are answered and only
    replies or notices are delivered.
  - `SupervisorChannelStore` methods:
    - `post`: accepts requests and the rework notice only. It is idempotent per (task,
      idempotencyKey), and a tool_request must carry `tool:<name>` refs.
    - `get`, `replyTo`, `listForTask`.
    - `listPendingForSupervisor(projectId, {taskIds?, since?})`: worker requests awaiting an
      answer plus worker replies not yet delivered.
    - `listPendingForWorker`.
    - `answer`: atomic. It updates `WHERE status='pending'` inside BEGIN IMMEDIATE, and a unique
      index on `in_reply_to` adds a database-level guard. It refuses a double answer, an expired
      request, a wrong reply kind, and a grant of tools that were not requested.
    - `markDelivered` (idempotent) and `expire` (returns whether this call expired the message).
    - `grantedTools(taskId)`: tools from pending or delivered grants; expired grants do not count.
    - `recordRework`, `reworkOf`, `reworksOf`: lineage stays inside one project and the store
      refuses cycles.
  - `SupervisorChannelService` is an interface with signatures and doc comments only. It has the
    five briefed methods plus the lead's three: `pendingForWorker`, `grantedTools` and
    `listPendingForSupervisor(projectScope?)`.
  - A comment in the file documents how another lane wires it in: `MeritRouter.channel`,
    optional `RunContext.channel`, the harness injecting pending messages at the next turn, and
    the watchdog exemption.
  - I did not edit service.ts or runners/types.ts.
- `packages/router/src/storage/migrations.ts`: I appended one migration.
  - It creates the `channel_messages` table with indexes `channel_messages_one_reply` (unique
    partial), `channel_messages_task` and `channel_messages_inbox`. Its CHECK constraints cover
    direction, kind, status, body length (1 to 20000) and a JSON array in refs_json. task_id has
    a foreign key to tasks with ON DELETE CASCADE.
  - It creates `task_rework` (task_id PK, rework_of, project_id, message_id, created_at) and its
    index `task_rework_of`.
- `packages/router/src/core/task.ts`: one additive change, `selfCheck: SelfCheckSchema.optional()`
  on `WorkerResultSchema`. report.ts imports only types from task.ts, so the import is not
  circular at runtime.
- `packages/router/src/storage/store-role.ts` (granted mid-task by the lead): `channel_messages`
  and `task_rework` are added to the local (project-owned) tables and to the tables scoped by
  project_id.
- `packages/router/src/index.ts`: export additions only. The new store is exported as
  `SupervisorChannelStore` because `ChannelStore` is already the T2 team channel. Its post input
  type is exported as `ChannelMessagePostInput`.
- `packages/router/tests/offload-contracts.test.ts` (new, 22 tests). All tests use temp DBs and
  close them before deleting the directories.

**Design change from the brief: lineage is a table, not a column.** At first I added
`tasks.rework_of`. That broke `StoredTaskDTOSchema` in `src/storage/task-queue.ts`, which parses
task rows strictly. Task-recovery and runtime-store tests failed with
`Unrecognized key: "rework_of"`. A separate `task_rework` table keeps task rows unchanged, and the
test asserts the migration has no `ALTER TABLE tasks`. The migration was never committed or
applied to real data, so rewriting it in place is safe.

## Commands run and observed results

- `cd packages/router && pnpm typecheck` -> `tsc -p tsconfig.json --noEmit` exited 0 with no
  output. I ran it after the final edits.
- `npx vitest run tests/offload-contracts.test.ts` -> `Test Files 1 passed (1)`,
  `Tests 22 passed (22)`.
- Existing store and migration files plus the lead's three, in the main checkout after all code
  edits:
  - Command: `npx vitest run tests/project-store-identity.test.ts
    tests/project-store-migration.test.ts tests/project-store-provision.test.ts
    tests/project-runtime-store.test.ts tests/project-admin-store-isolation.test.ts
    tests/project-tool-store-isolation.test.ts tests/qualification-split-store.test.ts
    tests/qualification-routing-store.test.ts tests/team-channel.test.ts tests/projects.test.ts
    tests/task-recovery-retention.test.ts tests/channel-delivery.test.ts
    tests/project-metadata-deletion.test.ts tests/project-task-lab-deletion.test.ts
    tests/zero-project-installation.test.ts tests/project-cli-operations.test.ts
    tests/offload-contracts.test.ts`
  - Result: `Test Files 3 failed | 14 passed (17)`, `Tests 25 failed | 193 passed (218)`.
    project-store-provision 22/22, zero-project-installation 5/5 and project-store-identity
    19/19 pass.
  - 21 failures come from the store-export gap: project-store-migration 19/19, plus 2 tests in
    project-cli-operations under "legacy project migration through the CLI". The error is
    `[unclassified_tables] the legacy store has tables the export does not classify
    (channel_messages, task_rework). Extend store-export.ts with an ownership rule for these
    tables.`
  - 3 failures in project-task-lab-deletion
    (`expected 'environment_failure' to be 'passed'`) were already there. They fail the same way
    in a scratch copy with none of my changes (no migration, store-role, task.ts, index.ts or new
    files).
  - 1 failure in project-cli-operations, "init/setup provision ... repairs a stuck stub",
    belongs to the other worker's in-progress test. The doctor JSON reports no provider keys or
    models. It also fails in the scratch baseline with my database changes reverted.
- Store-export patch check, in a scratch copy of the package (src and tests copied, node_modules
  via a junction, removed afterwards with the real node_modules confirmed intact):
  - I added `channel_messages: OWNED,` and `task_rework: OWNED,` to the export table rules in
    `src/projects/store-export.ts`.
  - `npx vitest run tests/project-store-migration.test.ts tests/project-cli-operations.test.ts`
    -> project-store-migration `19 tests` passed. project-cli-operations had 1 failure, the
    other worker's stub test above.

## Patch the lead needs to apply (outside my ownership)

`packages/router/src/projects/store-export.ts`, at the end of the export table rules after
`web_usage_protocol: OWNED,` (the file uses CRLF line endings):

```ts
  channel_messages: OWNED,
  task_rework: OWNED,
```

## Not verified

- The full router suite (about 3,400 tests) was not run. Only the 17 files above were.
- MCP tests and `pnpm -r build` were not run. No MCP or dist changes were made.
- Behaviour with a real worker. The channel tools, wait, delivery and grant enforcement in the
  harness belong to lanes B and C. Only the pure store is tested here, including two connections
  racing on one answer.
- That the summarize tool profile matches reality. Today the `summarize` task profile runs with
  no tools (presets set `tools` to none for it), so TOOL_PROFILES.summarize describes the grant
  lane C will make, not current behaviour.

## Open questions or contradictions found

1. Placement. The brief put `SupervisorChannelStore` in `src/core/channel.ts`. Under the AGENTS.md
   area rules, SQLite stores normally live in `src/storage/`, next to the T2 `storage/channel.ts`.
   I kept it in core as briefed. Moving it to `src/storage/` later is a mechanical change.
2. Naming collision. `ChannelStore` and `ChannelPostInput` already exist for the T2 team channel,
   so the new names are `SupervisorChannelStore` and `ChannelMessagePostInput`. The lane briefs
   should use those names.
3. Any new SQLite table needs classification in both `storage/store-role.ts` and
   `projects/store-export.ts`. Lane B's brief should own both if it adds tables.
4. Rework notice. A rework notice posted on a finished original task stays `pending` until
   someone marks it delivered or expired. Lane B should settle it when it creates the rework
   task.
