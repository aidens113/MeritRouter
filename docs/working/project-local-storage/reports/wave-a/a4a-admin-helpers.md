# A4a: admin project-reads consolidation and store-routed reads

Worker: worker (Sonnet 5). Scope: Brief A4a (gate 1 wave A, S7 admin reads part 1).

## Outcome

Goal 1 (consolidation) and Goal 2 (usage wiring) are complete. Goal 3 is partial: the files with
an explicit, caller-supplied `project` parameter (`session-project-scope.ts`, `request-evidence.ts`,
`sessions.ts`, `budget.ts`) are fully converted to read through `sy.projectStores(slug)`. In
`insights.ts` I converted the two functions that do a direct project-private-table read by bare id
(`accessRequestProject`, `brainAccessRequests`); the remaining `insights.ts` surface (listed below)
still reads `sy.db` directly and needs a dedicated follow-up — converting it correctly requires
real fan-out/merge logic, not a mechanical substitution, and the brief's time budget did not cover
it safely.

## Goal 1: one helper module

Deleted `admin/project-job-reads.ts`; everything lives in `admin/project-reads.ts` now. One marker
type (`ProjectStoreUnavailable = { project, reason }`, reason always a short code, never raw error
text), one `ProjectStoreUnavailableError extends MeritRouterError`, one `fanOutProjects` (the
array/`rows`-returning shape — the shape 3 of 4 real callers already used; `project-usage.ts`'s two
callers were adapted to wrap their single value in a one-element array), one wrapper per result
shape (`RowsWithAvailability<T>` for arrays via `withAvailability`, `WithUnavailable<T>` for a
merged object via `withUnavailable`), documented in the module's doc comment.

Final exported API (next worker builds on this):

- `ProjectStoreUnavailable`, `ProjectStoreUnavailableError`, `ProjectStoreOpen`
- `isKnownProject(sy, project)` — configured or the qualification project.
- `openProjectStores(sy, project)` — never throws; `{ok:true,stores}` or `{ok:false,marker}`.
- `requireProjectStores(sy, project)` — throws `ProjectStoreUnavailableError`.
- `projectSessionsOf(stores)` — the store's session store or throws.
- `projectScope(sy, project, opts)` — listing-view scope: one *known* project, or every
  configured project + qualification (unless `opts.qualification===false`).
- `adminProjectScopes(sy, opts)` — `projectScope(sy, undefined, opts)`.
- `scopesFor(sy, project, opts)` — one project *trusted as given* (even if unknown — opening it
  then reports unavailable), or `adminProjectScopes`. Use for a direct id lookup; use
  `projectScope` for a listing view.
- `fanOutProjects(sy, projects, read)` — `read` returns `T[]`; result is `{rows, unavailable}`.
- `withAvailability`/`RowsWithAvailability<T>`, `withUnavailable`/`WithUnavailable<T>`.
- `unavailableProjectStores(sy, project?)` — markers only, for a page banner.
- `locateTask`/`locateSession(sy, id, project?)` → `{project, db, stores}`; `stores` is `null`
  and `db` is `sy.db` for the `''` (no-project / unassigned) case — a row charged to no project
  has no project store to open.
- `locateRequest(sy, requestId, project?)` → `{project, db, stores}` (unchanged from before).
- `ProjectTask`, `locateProjectTask(sy, id, project?)`, `taskIn`, `taskRequestsUsed`,
  `projectQuestions`, `newestFirst` — unchanged (used by jobs/job-plans/job-team/job-metrics).

`jobs.ts`, `job-plans.ts`, `job-team.ts`, `job-metrics.ts` now import from `./project-reads.js`;
no logic in those four files changed, only the import path (per the brief, their deeper query
correctness is a different brief's scope — see "Found but out of scope" below).

## Goal 2: `project-usage.ts`

Wired in, not deleted: `admin/insights.ts`'s `overview()` now computes `usage24h`/`usage7d` via
`installationUsage(sy, since, until)` (every project's own store, merged, plus unattributed ('')
requests from `sy.db`) instead of `sy.usage()` reading `sy.db` directly across every project.
`projectUsageSummary`/`installationUsage` are re-exported from `insights.ts`. I left
`admin/dashboards.ts`'s `sy.usage(..., project)` calls untouched — that file is **not** in my
owned list ("another worker converts them after you"), and its calls already filter by a known
project explicitly (today behaviour-identical).

`admin/budget.ts` does not read any `UsageSummary`/model-usage data at all (checked — no match for
"usage" in the file before my edit), so there was nothing to wire there on that axis; its
project-private reads (`budget_requests`, `task_request_grants`, `job_budget_carves`) are handled
under Goal 3 below.

## Goal 3: converted files

- **`session-project-scope.ts`**: `scopedSessionTimeline(sy, id, project)` now opens
  `project`'s own store once and reads `sessions`, `tasks`, `model_requests`, `executions`,
  `execution_members`, `request_charges` from it, never `sy.db`.
- **`request-evidence.ts`**: `requestEvidence(sy, project, id)` opens `project`'s store once;
  `recordedMembersExclusive` now takes a `db: Db` instead of `sy`. All raw reads
  (`model_requests`, `request_charges`, `sessions`, `tasks`, `executions`, `execution_members`,
  `artifacts`) go through that store. `journal()` is unchanged (filesystem only, no `sy.db`).
- **`sessions.ts`**: `sessionsView`'s project-filtered branch and `sessionDetail` (which now uses
  `locateSession` instead of a raw owner lookup) read through the project's own store.
  `sessionViews`'s per-task labelling (`sy.tasks.get`/`sy.sessions.forTask`) is unchanged — it
  labels sessions that may span several projects via existing service abstractions, not a raw
  `sy.db` read, and redesigning it for per-project correctness is a bigger change than this
  brief's "direct reads" scope.
- **`budget.ts`**: `budgetRequestsView`, `decideBudgetRequest`, `jobBudget`, `taskBudget` all read
  `budget_requests`/`task_request_grants`/`job_budget_carves` from the owning project's store.
  `budgetRequestsView` returns `RowsWithAvailability<BudgetRequestView>` now (an array, so this is
  source-compatible). A real wrinkle found while fixing the regression below: a budget request
  charged to no project (`project_id=''`, an installation-level task) has no project store, so it
  is read from `sy.db` directly — exactly like `locateRequest`'s existing `''` case. Both
  `budgetRequestsView` and `decideBudgetRequest` special-case `project === ""` this way, and
  `budgetRequestsView` with no `project` filter unions every configured project's rows with the
  `''` rows (matching the original flat-table-scan behaviour exactly).
- **`insights.ts`**: `accessRequestProject` (used by `decideBrainAccess`) and the project branch
  of `brainAccessRequests` now read `brain_access_requests` through the owning project's store.
  `accessRequestProject`'s id is only unique within one project's own store (same ambiguity as
  budget request ids below), so it tries every configured project + qualification until found.

### A real regression found and fixed along the way

`locate()` (backing `locateTask`/`locateSession`) and `budgetRequestsView`/`decideBudgetRequest`
initially missed the `''` (no-project / unassigned) case entirely — `sessionDetail` broke for a
taskless legacy session (`sessions.test.ts`), and `budgetRequestsView(sy,{project:""})` returned
nothing (`admin-budget-panel.test.ts`). Both are fixed as described above and now pass. I mention
this because it shows the `''` scope is a recurring, easy-to-miss case across every one of these
helpers — `locateRequest` already had it; `locate`/budget did not.

## Left for a dedicated follow-up (not attempted)

`insights.ts` has several functions that read project-private tables directly on `sy.db` **without
any project parameter at all** (installation-wide, no per-project filter to key a store open on):
`workers()` (`meta`), `overview()`'s `tasksByState` (`tasks`), `endpointStats`/`modelsView`
(`model_requests`+`tasks` joined, no project column referenced), `requestLog`/`requestLogCount`/
`timeseries`/`tierDistribution` (optional `project`; unfiltered call sites aggregate across every
project in one SQL `GROUP BY`), `taskDetail`'s direct `sy.artifacts`/`sy.tasks` service calls (not
raw `sy.db`, left alone), and `qualificationBoard`'s `qualification_runs`/`qualification_results`
reads (classified as `qualificationTables` in `store-role.ts`, conceptually belonging to the
qualification project's own future store, not `sy.db`).

Converting these correctly needs real per-project fan-out and in-memory re-aggregation (bucket
math for `timeseries`, re-grouping for `tierDistribution`/`endpointStats`), not a `sy.db` →
`stores.db` substitution, since there is no single project to open a store for. I judged
attempting this within the time available to be a correctness risk rather than a safe mechanical
step, and left it for a follow-up brief with its own time to design and test the fan-out/merge
math. `sy.db` is still correct and behaviour-unchanged for all of these today (same-DB handle).

## Found but out of scope: `jobsView`/`teamMetrics` miss unassigned-project jobs

`tests/team-metrics.test.ts > job metrics > derives wall-clock...` fails deterministically (not a
timing flake — reproduces in isolation): `teamMetrics(sy, {now})` returns `[]` where a job
submitted via the raw `sy.tasks.submit(...)` (no `project` option, so `project_id=''`) is expected.

Root cause, confirmed by code trace (not something my import-only change to these four files could
cause): `jobsView`/`teamMetrics` filter each project's store with raw SQL
`WHERE profile='supervise' AND project_id = ?` bound to the *exact* scanned project slug (e.g. the
legacy primary project's real slug, never `''`). But `taskIn`'s `ownedBy()` (used elsewhere in the
same two files) treats a `project_id=''` row as belonging to the *primary* project by convention.
The SQL filter and the `ownedBy` convention disagree, so a job with `project_id=''` is never
selected by the `WHERE project_id = ?` scan in the first place. This is pre-existing in the
uncommitted S7 `jobs.ts`/`job-metrics.ts` work (not written by me, and unchanged by me beyond the
import path) — I verified my `projectScope`/`taskIn`/`fanOutProjects` are behaviourally identical
to the deleted `project-job-reads.ts` versions for this path. I did not fix it: `jobs.ts`,
`job-plans.ts`, `job-team.ts`, `job-metrics.ts` are only import-converted per my brief; their query
correctness is explicitly reserved ("another brief" per the gate1 inventory's "split the files
across two or three briefs"). Flagging for the lead/next worker on those files.

## Commands run and observed results

- `cd packages/router && npx tsc --noEmit` → clean except 4 pre-existing errors in
  `src/runners/coding/finish.ts`/`src/runners/supervisor.ts` (`ResolvedConfig` missing
  `projectDirectory`) and 1 pre-existing error in `tests/brain-commit-performance.test.ts`
  (`GrantContext` missing `task`) — all outside my owned paths, present before any of my edits,
  and unchanged by them (verified the error set and line numbers are identical before/after each
  of my edits).
- `pnpm --filter meritrouter-panel typecheck` → exit 0, no errors.
- `npx vitest run tests/admin-budget-panel.test.ts tests/admin-job-navigation.test.ts tests/admin-session-project-scope.test.ts tests/admin-request-evidence.test.ts`
  → **4 files, 28 tests, all pass** (after fixing the `''`-scope regression above).
- Additional tests importing the files I changed (found via `grep -rl` for
  `admin/project-reads|project-job-reads|project-usage|jobs.js|job-plans|job-team|job-metrics|insights|sessions.js|session-project-scope|request-evidence|budget.js` under `tests/`):
  `budget-control.test.ts`, `project-delete-pending-requests.test.ts`,
  `project-request-protocol.test.ts`, `verification-surface.test.ts`,
  `admin-project-settings.test.ts`, `team-metrics.test.ts`, `team-surface.test.ts`,
  `resilience.test.ts`, `roadmap-project.test.ts`, `session-surface.test.ts`, `sessions.test.ts`,
  `project-task-lab-deletion.test.ts`, `projects-delete.test.ts`, `projects-followups.test.ts`,
  `projects-operations.test.ts`, `projects-panel-scope.test.ts`, `projects-router-fixes.test.ts`,
  `projects-surfaces.test.ts`, `qualification.test.ts`, `repository-prepare.test.ts`,
  `operations.test.ts`, `admin-live.test.ts`, `admin-keys.test.ts`. Ran a representative subset
  (the ones that actually exercise jobs/team/sessions/budget/request-evidence behaviour, not just
  an unrelated re-export) together first, then re-ran every file that showed a failure **in
  isolation** (the brief's "shared CPU" note — a 13-file-parallel run produced many EBUSY/timeout
  failures that disappeared once run alone):
  - `tests/sessions.test.ts` → failed in the parallel run (the `''`-scope bug above, now fixed) →
    **14/14 pass** in isolation after the fix.
  - `tests/verification-surface.test.ts` → **7/7 pass** in isolation (parallel-run failures were
    `timedOut` flags flipping true under CPU contention, not logic).
  - `tests/team-surface.test.ts` → **6/6 pass** in isolation (same contention pattern).
  - `tests/supervisor-lifecycle.test.ts` → **46/46 pass** in isolation (parallel-run EBUSY
    `rmdir`/`unlink` and 30-120s timeouts; this file alone took 263s).
  - `tests/qualification.test.ts` → **6/6 pass** in isolation (parallel-run hook timeout).
  - `tests/team-metrics.test.ts` → **6/7 pass** in isolation; the one failure is the pre-existing
    `jobsView`/`teamMetrics` defect above, reproduces deterministically, unrelated to my changes.

## Not verified

- The rest of the "additional tests" list above (`admin-project-settings`, `resilience`,
  `roadmap-project`, `project-task-lab-deletion`, `projects-*`, `repository-prepare`, `operations`,
  `admin-live`, `admin-keys`, `project-delete-pending-requests`, `project-request-protocol`,
  `budget-control`) were not individually re-run after the `''`-scope fix; they either don't
  exercise the specific code paths I changed (mostly `admin/projects.ts`, which I must not touch)
  or import `insights.js`/`job-*` only incidentally. Given the time already spent isolating
  contention-vs-real failures above, I did not re-run this full tail set file-by-file.
- The `insights.ts` functions listed under "Left for a dedicated follow-up" are unverified beyond
  "unchanged, still reads `sy.db`, still typechecks" — I did not write new tests for them since I
  made no behavioural change there.
- Full-suite `pnpm -r test`/`pnpm -r build` were not run (out of the brief's named acceptance
  checks).

## Report

This file.

Outcome: Partial
Changed: packages/router/src/admin/project-reads.ts (rewritten/consolidated), packages/router/src/admin/project-job-reads.ts (deleted), packages/router/src/admin/project-usage.ts, packages/router/src/admin/jobs.ts, packages/router/src/admin/job-plans.ts, packages/router/src/admin/job-team.ts, packages/router/src/admin/job-metrics.ts, packages/router/src/admin/insights.ts, packages/router/src/admin/sessions.ts, packages/router/src/admin/session-project-scope.ts, packages/router/src/admin/request-evidence.ts, packages/router/src/admin/budget.ts
Validation: `cd packages/router && npx tsc --noEmit` -> clean except 4+1 pre-existing errors outside my owned files (unchanged by my edits); `pnpm --filter meritrouter-panel typecheck` -> exit 0; `npx vitest run tests/admin-budget-panel.test.ts tests/admin-job-navigation.test.ts tests/admin-session-project-scope.test.ts tests/admin-request-evidence.test.ts` -> 4 files / 28 tests pass; `tests/sessions.test.ts`, `tests/verification-surface.test.ts`, `tests/team-surface.test.ts`, `tests/supervisor-lifecycle.test.ts`, `tests/qualification.test.ts` each run in isolation -> all pass; `tests/team-metrics.test.ts` in isolation -> 6/7 pass, 1 pre-existing failure unrelated to this brief (documented above)
Not verified: the long tail of other tests that import insights.js/job-*.js only incidentally (listed above, not re-run individually); insights.ts's still-unconverted cross-project functions (no behavioural change made, so nothing new to verify there); full-suite `pnpm -r test`/`pnpm -r build`
Notes: Goal 1 and 2 fully done; Goal 3 done for every file with an explicit per-call `project` parameter, left insights.ts's parameter-less cross-project reads (workers/tasksByState/endpointStats/modelsView/requestLog family/timeseries/tierDistribution/qualificationBoard) for a follow-up brief with room to design the fan-out/merge math safely. Found and reported a pre-existing, unrelated defect in jobs.ts/job-metrics.ts (unassigned-project jobs missed by their raw SQL project filter) — not fixed, out of this brief's owned-file scope.
