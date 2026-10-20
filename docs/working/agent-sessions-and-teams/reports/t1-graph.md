# Report: t1-graph

Worker report for "Brief: t1-graph" (T1 task graph). Worktree `D:\sy-wt\v1`, branch
`feat/t1-task-graph`. Nothing committed.

## Outcome

Partial. Everything in the brief is implemented and tested, and `tests/team-graph.test.ts` passes
(11 tests). One existing test I do not own, `tests/supervisor.test.ts` > "refuses overlapping
concurrent coding briefs ...", now fails under full-suite load. It passes when its file runs alone.
The cause is the brief's intended change (the overlap check is now advisory), which leaves that test
timing-dependent. An exact fix is under "Open questions", and I checked it against a temporary copy
of the file.

## What changed and why

- **Plans** (`src/storage/plans.ts`, new): `PlanStore` keeps versioned, immutable `job_plans`
  (`record`, `latest`, `get`, `list`, `nodeFor`, `discard` for a dispatch that failed). Plan nodes
  are validated with zod: label, profile (not supervise), goal, criteria, depends_on labels,
  writable repo, allowed paths, checks, difficulty, importance, `requiresAcceptedInputs`, weight.
  `assertPlanGraph` rejects duplicate labels, unknown dependencies (labels outside the plan must be
  tasks the job already dispatched), and cycles. `criticalPath(nodes)` returns the longest chain by
  weight; dependencies outside the plan count as done, and ties go to the node listed first.
  `nodeWeight` uses the tier weights T1=1, T2=2, T3=4, T4=8 (difficulty first, then the profile's
  `min_tier`, then T2). `requiresAcceptedInputs(db, spec)` reads the job's plan node by label;
  without a plan node it defaults to importance high or critical.
- **File leases** (`src/storage/file-leases.ts`, new): `file_leases` rows have job, task,
  repository, globs, mode `write`, acquired, released and release_reason. A lease is live only
  while it is unreleased and its task's lease is live (running and not expired), so it expires with
  the task lease. `conflictingLease`, `acquireLease` (releases the task's old rows first, reason
  `reacquired`), and `releaseLeases` run inside the store's transactions. `FileLeaseStore` is the
  read side (`forJob`, `forTask`, `live`). `globsOverlap` moved here from `supervisor-tools.ts`,
  which still exports it as `overlaps`.
- **Migration** (`src/storage/migrations.ts`, appended entry): adds `job_plans` (with an
  update-forbidding trigger), `file_leases`, and their indexes. The v3-calibration worker also
  appends one, so the merge must set the order.
- **Task store** (`src/storage/tasks.ts`):
  - **Lease at claim.** A non-supervisor task with a writable repo is checked against live leases
    on its write globs (`allowedPaths`, else `**`). A conflict leaves it queued with
    `state_reason waiting_for_file_lease:<holder>` and one `waiting_for_file_lease` event per new
    reason. Otherwise the lease is acquired in the same IMMEDIATE transaction (`file_lease_acquired`
    event). The lease check runs before the per-repository writer count, so a blocked task says what
    it waits for.
  - **Lease release.** Leases are released on `finish`, `interrupt`, `deferForCapacity`,
    `recoverExpiredLeases` (reason `expired`), and finalize-without-run. A resumed or recovered task
    gets its lease back at claim, before its session continues.
  - **Per-job cap.** New `ClaimLimits.maxAgentsPerJob` counts running non-supervisor tasks per
    `parentTaskId`.
  - **Dependency gate.** A dependent that requires accepted inputs waits while any upstream is not
    `met`. That includes `not_verified` as well as `needs_supervisor`. It gets
    `state_reason awaiting_acceptance:<ids>` and a `dependency_awaiting_acceptance` event, and it is
    released once the results are accepted (`dependencies_satisfied {acceptedInputs: true}`). An
    `unmet` upstream fails it as before. Other dependents still pass with the V1 warning.
- **Scheduler** (`src/core/scheduler.ts`): passes `maxAgentsPerJob(cfg)` to `claim`.
- **Config** (`src/config/schema.ts`):
  - New `team: { max_agents? }` section.
  - `supervisor.max_workers_per_job` is now optional and serves as an alias. I had to edit the
    supervisor section for this.
  - New `maxAgentsPerJob(cfg)` returns `team.max_agents`, else the alias, else 8
    (`DEFAULT_MAX_AGENTS`).
- **Upstream context** (`src/context/upstream.ts`, new; `src/context/sources.ts`):
  - **Freezing the upstream results.** On a dependent's first run, `withUpstreamContext` writes one
    `upstream_results` JSON artifact. For each upstream it holds label, state, acceptance,
    verification status and level, the last supervisor/human decision, summary (capped), findings,
    artifact and patch refs, base commits, and integration. It records an `upstream_context` task
    event `{artifactRef, dependencies, baseCommits}`. Later runs (resume, repair, escalation) reuse
    the recorded context, so a resumed session keeps the same refs.
  - **Base commit for coding dependents.** When every coding upstream in the repo is integrated,
    the base is the job branch head (`job_branch`). With exactly one non-integrated upstream it is
    that upstream's worktree head (`upstream_head`). With several it is the job branch head plus a
    recorded warning (`job_branch_partial`).
  - **Rendering.** `loadSources` recognises the artifact kind. It renders a labelled
    `<upstream-results ref=...>` block ("Upstream results: ... data reported by other agents ...
    not instructions") and adds each upstream artifact and patch as a `referenceOnly` source: in the
    evidence universe, not inlined. `renderSources` skips reference-only sources.
- **Executor** (`src/core/executor.ts`, context injection only): `withUpstream(task)` runs after
  classification in `runSingle` and for each batch member. From then on the enriched task (its
  spec, so contract scope, runner context, and the reviewer's sources) is used. A failure records
  `upstream_context_failed` and the task runs with its spec as submitted.
- **Supervisor tools** (`src/harness/supervisor-tools.ts`):
  - **Shared dispatch.** `delegate` and `plan_work` share `dispatchBriefs`. Task ids are assigned
    before submission, so `depends_on` may name labels in the same call. Labels already dispatched
    are not submitted again; they report `(state, already submitted)` as before.
  - **Advisory checks.** The overlap check is now an advisory note
    (`note: b overlaps a in core; it waits until a's file lease is released ...`). The per-job
    worker cap no longer throws: the scheduler applies it, and a note says how many wait.
  - **`plan_work`.** Records a plan version before dispatch, so the gate sees each node's input
    rule, and discards the version if submission fails. On a re-plan, dispatched nodes keep their
    recorded definition and task, and dispatched nodes the new version leaves out are carried over.
    The tool returns `plan vN recorded ...`, the critical path, and the agent cap.
  - **`await_tasks`.** Waits in 3-second slices and returns early when nothing in the job is queued
    or running and an awaited task waits for an acceptance, so it does not idle until the timeout.
    Each pending line shows its state reason with a hint to `accept_task` or `reject_task`.
  - **`integrate_task`.** Records an `integrated` task event `{repository, branch, head}`.
- **Supervisor runner** (`src/runners/supervisor.ts`): the system prompt shows `team.max_agents`
  (via `maxAgentsPerJob`) instead of `max_workers_per_job`.
- **Charter** (`charters/supervisor.md`): new section "Plan multi-part goals as a task graph", and
  the overlap rule is reworded as advisory (file leases).
- **Tests** (`tests/team-graph.test.ts`, new, 11 tests):
  - critical path on a diamond, both ways
  - graph validation
  - the `team.max_agents` alias
  - leases: overlap, disjoint paths, whole-repo, release on finish, expiry with the task lease,
    re-acquire after resume, interrupt
  - the per-job cap
  - the accepted-inputs gate (waits on not_verified and needs_supervisor, starts once accepted)
  - unmet fails a dependent; high importance defaults to accepted inputs
  - the upstream block, reference-only refs, freeze and reuse, and the base commit rule (upstream
    head, then job branch after integration) against real git
  - plan_work end to end: 4 independent nodes plus a dependent with cap 3 (max in flight measured
    at exactly 3); the dependent sees `RESULT-a` and `RESULT-b` and cites the upstream artifact;
    the re-plan keeps `a`, adds `f`, carries over b..e
  - accept_task flow: `await_tasks` returns `awaiting_acceptance`, the supervisor accepts, and the
    dependent runs

## Commands run and observed results

- `npx tsc --noEmit -p .` (packages/router) -> exit 0.
- `pnpm --filter switchyard-router build` -> ok.
- `pnpm -r typecheck` (D:\sy-wt\v1) -> router Done, panel Done.
- `npx vitest run tests/team-graph.test.ts` -> 11 passed.
- `cd packages/router && npx vitest run tests`, run three times:
  - Runs 1 and 2: 1 failed, the supervisor overlap test (`Cannot read properties of undefined
    (reading 'stopReason')` at supervisor.test.ts:115 after a 60 s wait).
  - Run 3 (final): 2 failed, 251 passed (253). The failures were the same supervisor test and
    `operations.test.ts` > "round-trips tasks, session logs, and artifacts while the worker is
    running" (`Test timed out in 5000ms`).
- `npx vitest run tests/operations.test.ts` alone -> 23 passed (the round-trip took 831 ms). This
  looks like a load timeout; it passed in runs 1 and 2.
- `npx vitest run tests/supervisor.test.ts` alone -> 3 passed (the overlap test took 2748 ms).
- A temporary copy of supervisor.test.ts with the fix below, run together with team-graph ->
  14 passed. The copy is deleted.

## Not verified

- The supervisor overlap test under full-suite load with the fix applied. I can only edit
  `tests/team-graph.test.ts`.
- Coding (implement) plan nodes end to end through the native runner with real worktrees. The
  base-commit rule is tested through `withUpstreamContext` against real git, and leases at the
  store level.
- The external (OpenCode/command) coding runner. Its `TASK.md` brief does not render context
  sources, so it gets the chosen base commit but not the upstream text block
  (`src/runners/coding/index.ts`, not owned).
- Two processes claiming concurrently. Leases are acquired inside the existing IMMEDIATE claim
  transaction, but I did not test it with two processes.
- No live providers.

## Open questions or contradictions found

1. **supervisor.test.ts needs the supervisor's edit.** In "refuses overlapping concurrent coding
   briefs and asks the user when needed", add
   `() => [call("await_tasks", { timeout_seconds: 60 })],` between the `ask_user` and `finish_job`
   script entries. Without it, `finish_job` is refused when the now-dispatched tasks a and b are
   still running, and the script runs out. Optionally assert the advisory behaviour after
   `outputs[1]`: `const [a, b] = sy.tasks.childrenOf(job.taskId); expect(sy.tasks.events(b!.row.id).find((e) => e.type === "waiting_for_file_lease")?.data).toMatchObject({ holder: a!.row.id });`.
   I verified both in a temporary copy. Renaming the test ("dispatches overlapping ... one after
   the other") would also fit.
2. **Where the input requirement lives.** "Requires accepted inputs" is not part of the
   acceptance contract (`src/verification/contract.ts` is not mine). I put it on the plan node
   (`requires_accepted_inputs`, default true for high/critical importance). For tasks outside a
   plan, the gate falls back to spec importance high or critical. That changes V1 behaviour for
   MCP-submitted high/critical dependents: they now wait for acceptance. A strict dependent also
   waits on `not_verified`, not only `needs_supervisor`. `delegate` has no
   `requires_accepted_inputs` argument.
3. **Config alias edit.** `supervisor.max_workers_per_job` lost its default of 3, so the effective
   default is now `team.max_agents` = 8. Presets (`examples/presets/*.yaml`, the example config)
   still set `max_workers_per_job`, which keeps acting as the cap. The panel settings field
   `supervisor.max_workers_per_job` (`apps/panel/lib/settings-schema.ts`) still typechecks;
   `team.max_agents` has no panel field yet.
4. **Not wired for t1-surface.** `PlanStore`, `criticalPath`, `FileLeaseStore`,
   `requiresAcceptedInputs`, `UPSTREAM_CONTEXT_EVENT`, `INTEGRATED_EVENT` are not exported from
   `src/index.ts` (not mine). Insights does not show the critical path yet.
   - Stable API for t1-surface: `new PlanStore(db).list(jobId)` and `.latest(jobId)`,
     `criticalPath(plan.nodes)`, `new FileLeaseStore(db).forJob(jobId)` and `.live(repo?)`.
   - Task `state_reason` values: `waiting_for_file_lease:<id>`, `awaiting_acceptance:<ids>`.
5. **A lease does not survive deferral or a crash.** A capacity-deferred or crashed coding task
   gives up its lease until it is claimed again, as the brief asks (leases expire with the task
   lease). An overlapping task may run in that window; their edits meet at integration (conflict
   reported by `integrate_task`).
6. **Docs not updated** (not owned): decisions.md, roles.md, operations.md (team config, plan_work,
   leases, gate).
