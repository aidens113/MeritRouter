# Report: j1-fairness (projects plan, phase J1)

Worker report for the brief "j1-fairness" in [projects.md](../../projects.md). Worktree
`D:/sy-wt/pj`, branch `feat/projects`. Nothing committed.

## Outcome

Done.
- **Claiming (D5).** Claims round-robin across projects that have ready tasks, weighted by each
  project's `priority`, oldest first within a project. This runs inside the existing IMMEDIATE
  claim transaction.
- **Per-project concurrency cap.** An optional per-project `max_concurrent_tasks` holds. Global
  caps, provider slots, file leases, and the per-job agent caps still apply to every candidate.
- **Prompt batches.** A batch is keyed by project, so it cannot mix projects.
- **Budgets (D7).** An optional per-project paid cap (USD per day, week, or month) and request
  share (a fraction of the package allocation) are enforced at admission.
- **Checks.** Typecheck, build, and the full suite pass (414 tests: the 404 baseline plus 10 new).

## What changed and why

| File | Change |
| --- | --- |
| `src/projects/schema.ts` | Adds `ProjectLimitsSchema` (spread into `ProjectConfigSchema`), the type `ProjectLimits`, and `projectLimits(cfg, slug)`, which reads a project's limits from the raw `projects.<slug>` entry (already validated at load). A legacy, unknown, or unconfigured project gets `{ priority: 1 }`. |
| `src/storage/fair-claim.ts` (new) | `FairClaimOrder`: stride scheduling over the claim candidates. Its state lives in `meta`. |
| `src/storage/tasks.ts` | `ClaimLimits.projectLimits?: (projectId) => { priority, maxConcurrent? }`. `claim()` iterates candidates in `FairClaimOrder` order instead of `created_at` order. Running worker tasks are counted per project, and the project cap is checked for worker tasks. The per-row checks are otherwise unchanged. |
| `src/core/scheduler.ts` | Passes `projectLimits` from the config. New `projectBatchKey(task)` returns `JSON.stringify([project_id, batchKey(spec)])`, or null when not batchable. It is used for the leader, companions, and extra members, replacing the separate project checks. |
| `src/admission/admission.ts` | In `reserve()`, after the global allocation checks, the project is taken from the first participant (batches never mix projects). That project's `request_share` is enforced per configured allocation window, and so is its `paid_budgets` (after the global paid windows). Adds `projectCount(project, since)`; `windowReopensAt` gains an optional project. |
| `src/paid/spend.ts` | Adds `projectSpendSince(project, since)` (joins `paid_spend` to `model_requests.project_id`) and `projectDenial(project, budgets, worstUsd)`. |
| `src/index.ts` | One line: exports `ProjectLimitsSchema`, `projectLimits`, and `ProjectLimits`. |
| `tests/projects-fairness.test.ts` (new) | 10 tests (below). |

`fair-claim.ts` is a new file outside the listed owned paths. It is the claim order's own
concern, and `tasks.ts` would otherwise grow toward 800 lines (it is 725 now). No other file was
touched, and no migration was added: the stride state uses the existing `meta` table.

## Claim algorithm

1. Ready candidates (queued, or `waiting_for_capacity` whose retry time has passed) are read
   oldest first, as before, and grouped into one queue per `project_id`.
2. Each project has a pass, stored in `meta` as `claim_pass:<slug>`. A virtual time is stored
   as `claim_pass`: the pass at which the last claim was made.
3. A project's effective pass is `max(stored pass, or the virtual time if none; virtual time)`.
   A project that was idle or blocked therefore rejoins at the front of the rotation, but it
   banks no credit for the time it had nothing to run.
4. The next candidate is the head of the queue of the project with the lowest effective pass.
   Ties go to the older head task, then the lower slug. A single project, or equal passes, gives
   plain FIFO.
5. Every existing check runs on that row unchanged, plus the new project cap check:
   - supervisor and worker slots;
   - the project's `max_concurrent_tasks` (worker tasks only);
   - `team.max_agents` per job;
   - provider slots;
   - file lease and writer count.
6. When the row is claimed, the virtual time becomes the project's effective pass, and the
   project's pass becomes that value plus `1 / priority`. When the row is skipped, its project
   keeps its pass and its next row is tried later.
7. Changed passes are written to `meta` inside the same transaction. The rotation therefore
   carries across ticks, restarts, and processes sharing one store.

Result: while two projects both have ready tasks, they are claimed in the ratio of their
priorities, whatever the length of either backlog. A 50-task backlog in A, with B's task
submitted after it, is served A, B, A, and so on.

## Config fields (`projects.<slug>`, all optional)

```yaml
projects:
  alpha:
    priority: 2                # > 0, max 100, default 1: fair-share weight at claim
    max_concurrent_tasks: 3    # int > 0: most worker tasks of this project running at once
    paid_budgets:              # USD per rolling window, inside the global paid.budgets
      per_day_usd: 1
      per_week_usd: 5
      per_month_usd: 15
    request_share: 0.5         # (0, 1]: fraction of allocation.max_model_requests_per_hour/_per_day
```

- `max_concurrent_tasks` counts what `execution.max_concurrent_tasks` counts: worker tasks.
  Top-level supervisors are bounded by `supervisor.max_concurrent_jobs`, and sub-supervisors by
  the job's agent cap.
- Batch companions share their leader's execution slot, so neither the global cap nor the
  project cap is re-applied to them. This is the existing global semantics.
- `request_share` allows `max(1, floor(cap * share))` requests per configured window, counted by
  `model_requests.project_id`. With no package allocation configured it has no effect. A denial
  uses the existing `package_hourly_allocation_exhausted` or `package_daily_allocation_exhausted`
  reason, with a project-specific message and a `retryAt`, so the task waits for capacity like any
  allocation denial. No new denial reason was added (that would have meant editing `core/errors.ts`
  and `core/disposition.ts`).
- A `paid_budgets` denial is `paid_budget_exhausted`, with the message "project <slug> <window>
  paid budget: ...". The gate already treats that reason as "skip this paid endpoint", so the
  project falls through to free endpoints, and other projects keep paid routing.

## Tests (`tests/projects-fairness.test.ts`, 10)

- Config: the fields are read, the defaults are correct, and bad values are refused (`priority:
  0`, `request_share: 1.5`, `max_concurrent_tasks: 0`, an unknown `paid_budgets` key).
- **Starvation.** A 50-task backlog in A, then one task in B, one claim at a time: the order is
  alpha, beta, alpha. B is claimed second. The test also covers two cases:
  - B submitting again after A has been served 10 more times: B is claimed next.
  - A new `TaskStore` over the same database (a restart): the rotation continues.
- Oldest first within a project.
- **Priority 3 to 1.** Twenty sequential claims give 15 alpha and 5 beta. One claim with 8 slots
  gives 6 and 2.
- Equal priorities alternate within one claim.
- **Project cap (store level).** Alpha has a cap of 2 and the global cap is 8. The first claim
  gives 2 alpha and 5 beta. The next claim gives nothing, even though a global slot is free.
  After one alpha task finishes, exactly one alpha task is claimed.
- **Project cap (real worker).** The Scheduler gets its limits from the config, with alpha capped
  at 1. Exactly 1 alpha task and 2 beta tasks are in flight, and the alpha peak stays at 1 until
  all of them complete.
- **Batching never mixes projects.** Two summarize tasks per project are claimed in one tick.
  That gives 2 provider requests of 2 items each, each from one project, and a shared `batchId`
  only within a project.
- **Paid cap.** Alpha's `per_week_usd` is 0.001, and paid is preferred.
  - Alpha's task skips paid with "(paid budget) ... project alpha weekly paid budget" and is
    served free.
  - Beta's task is served by `paid:acme/acme-large`.
  - `projectSpendSince`: beta is 0.006, alpha is 0.
- **Request share.** At 0.5 of 4 requests per hour, alpha's third reservation is denied with
  `package_hourly_allocation_exhausted` and a `retryAt`. Beta can still use the rest of the
  package allocation, and then the global allocation denies it.

## Commands run and observed results

- `npx tsc --noEmit -p .` (router): clean.
- `pnpm -r typecheck`: router Done, panel Done. This was run several times while j1-brain and
  j1-surfaces were editing.
- `pnpm -r build`: "packages/router build: Done", "apps/panel build: Done".
- `npx vitest run tests/projects-fairness.test.ts`: 10 passed.
- Full suite `cd packages/router && npx vitest run`, twice: "Test Files 41 passed (41) / Tests
  414 passed (414)". The second run was after the final edits. Other workers' new test files
  were not yet present.
- **Mutation checks.** Each was a temporary edit, restored from a scratchpad backup and confirmed
  with grep:
  - Effective pass forced to 0 (FIFO): the starvation, priority, and equal-split tests failed.
  - `projectBatchKey` returning the bare `batchKey`: the batching test failed.
  - Project cap check removed: both cap tests failed.
  - `projectDenial` throw removed: the paid cap test failed.
  - Share throw removed: the request share test failed.
- **Flake.** The real-worker cap test failed once (12 s) in a 5-file run while the other workers
  were active. It passed alone and in two further runs of the same 5 files. The cause was its own
  10 s wait for 3 in-flight requests, too short under load. I raised it to 25 s, `awaitResults`
  to 30 s, and the test timeout to 90 s. The two known timing tests did not fail in my runs.

## Not verified

- No live provider or paid provider. The paid cap and spend attribution were checked only with
  the scripted client.
- Multi-process claiming. The passes live in `meta` inside the IMMEDIATE transaction, so this
  should hold, but no test ran two processes claiming at once.
- Supervisors and sub-supervisors. They also advance their project's pass when claimed: one
  rotation is shared by all claim kinds. No test covers a mix of jobs and workers across
  projects.
- `max_concurrent_tasks` does not record a `state_reason` or event while a task waits on it,
  unlike provider-slot and file-lease waits. The panel cannot show "waiting for project cap".
- A config hot reload changing `priority` or caps. The scheduler reads `this.cfg.projects` on
  every tick, but no test covers a reload.
- The meta passes grow without bound (by `1/priority` per claim). Doubles stay exact far beyond
  any realistic claim count, but nothing renormalises them.
- No documentation updated (`docs/operations.md`, `docs/setup.md`, and the example config are
  J3's). The presets and example config were not regenerated by me.

## Open questions or contradictions found

1. The plan's ownership list for this brief does not include a new file. I added
   `src/storage/fair-claim.ts` rather than growing `tasks.ts` (725 lines).
2. Field names were not fixed by the plan. I chose flat `priority`, `max_concurrent_tasks`, and
   `request_share`, plus `paid_budgets` with the same keys as the global `paid.budgets`. J2's
   project settings page and J3's docs should use these names.
3. Request-share and per-project paid denials reuse existing reasons. If the panel needs to tell
   "project share" from "package" denials, a dedicated reason would need `core/errors.ts` and
   `core/disposition.ts` edits.
