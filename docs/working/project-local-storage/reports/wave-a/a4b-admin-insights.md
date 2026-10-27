# A4b: admin project-reads consolidation and store-routed reads, part 2

Worker: worker (Sonnet 5). Scope: Brief A4b (gate 1 wave A, S7 admin reads part 2), built on A4a's
`admin/project-reads.ts`.

## Outcome

All three goals done.

## Goal 1: `insights.ts`'s remaining parameter-less cross-project reads

Added two additive helpers to `admin/project-reads.ts` (no renames/removals of A4a's exports):

- `ProjectDbScope`/`projectDbScopes(sy, project, opts)`: the db scopes a view reads — one
  project's own store (or `sy.db` directly for `''`, matching `locateRequest`'s/
  `budgetRequestsView`'s `''` case) when `project` is given; every configured project (plus
  qualification unless excluded) **plus** `sy.db`'s unattributed (`project_id=''`) rows, last,
  when it is omitted. Every scope still needs an explicit `project_id = scope.project` filter in
  the query, because today every scope can share one database handle — that's what prevents
  double counting, not the scope list itself.
- `fanOutProjectRows(sy, project, opts, read)`: `projectDbScopes` plus running `read(db, project)`
  over each scope and flattening the rows.
- `projectIdFilter(sy, project)` (used for Goal 2, see below).

Converted, with the merge rule for each:

- **`workers()`**: **left unconverted, by design**, not a mechanical conversion I ran out of time
  for. `store-role.ts`'s `assertProjectContents` forbids a real (split) project store's `meta`
  table from holding anything but its own brain-index-generation row — a `worker:*` claim is
  installation-wide process state, never per-project data, even though `meta` is classified under
  `localTables` for schema completeness. Fanning this out per project would be wrong once stores
  split (the rows would not exist there at all), not just redundant today. Documented in the
  function's new doc comment.
- **`tasksByState`** (inside `overview()`): new private `tasksByState(sy)` fans out
  `SELECT state, COUNT(*) FROM tasks WHERE project_id = ? GROUP BY state` per scope and sums counts
  per state in a `Map`. `Overview.tasksByState`'s shape (`Record<string, number>`) is unchanged —
  I deliberately did **not** wrap it in `WithUnavailable` (apps/panel's `app/all/page.tsx` does
  `Object.entries(p.tasksByState)` expecting every value to be a number; an extra
  `unavailableProjects` array value would be a ticking type-hole and a render-time surprise even
  though it type-checks against the generic `WithUnavailable<T extends object>` signature).
- **`endpointStats`** (used by `modelsView`): split into `endpointStatsPart(db, project, id,
  sinceMs)` (per-scope partial: counts, sums, `COALESCE(SUM(latency),0)` **and** `COUNT(latency)`
  separately, `MAX(reserved_at)`) and `endpointStats` which fans out and merges: every count/sum
  adds; `lastUsedAt` is the max of the parts' maxes (ignoring nulls); `avgLatencyMs` is **recomputed
  from the merged latency sum and count** (`latencySum / latencyCount`), never averaged from
  per-project averages. The second (tasks-joined) query gained `t.project_id = ?` and
  `m.project_id = ?` filters so it only counts that scope's own tasks/requests.
- **`modelsView`**: unaffected beyond `endpointStats`'s fix, except its `qualification` field
  (see Goal 3 below for why).
- **`requestLog`/`requestLogCount`/`requestLogScope`**: `requestLogScope` now takes an explicit
  `scopeProject` and always binds `r.project_id = scopeProject` (removed from the old
  value-presence loop) instead of conditionally filtering only when the caller passed `project`.
  `requestLogCount` sums each scope's own `COUNT(*)`. `requestLog` fetches each scope's newest
  `min(offset+limit, 100_000)` rows (ordered `reserved_at DESC, id DESC` — enough for any scope to
  contribute to the final page), merges all scopes' rows with the same tie-break (`reserved_at`
  desc, then `id` desc as a string compare), then re-slices `[offset, offset+limit)` — "ordering/
  limits re-applied after the merge" per the brief. Verified the `id DESC` tie-break matters:
  `admin-job-navigation.test.ts`'s "filters before limiting, pages deterministically" test has two
  rows sharing `reserved_at=1` and asserts `id="b"` then `id="a"` page by page.
- **`timeseries`**: fans out the same per-bucket-per-endpoint query (now always filtered by
  `project_id = scope.project`) and merges by `(bucket, endpointId)` key, summing `requests`,
  `failed`, `inputTokens`, `outputTokens` (a bucket boundary is the same instant everywhere, so no
  recomputation beyond the sum). One intentional behavior change: the old code treated
  `project: ""` the same as "no project" (JS falsy check), silently reading every project; it now
  treats `''` as "unattributed rows only", consistent with `requestLog`/`budgetRequestsView`. No
  caller or test passes `project: ""` to `timeseries` today (grepped), so this is a correctness
  alignment, not an observed-behavior change.
- **`tierDistribution`**: same fan-out/merge shape, grouped by `tier`, summing `tasks`/`completed`.
  Same `''`-falsy-to-explicit-unattributed alignment as `timeseries`, same "no caller passes `''`"
  check.
- **`qualificationBoard`**: `qualification_runs`/`qualification_results`/`qualification_tasks` are
  `qualificationTables` (`store-role.ts`) — they belong to the reserved qualification project's own
  future store, not every project's, so this is a single-scope switch (`sy.db` →
  `requireProjectStores(sy, QUALIFICATION_PROJECT).db`), never a fan-out. Also switched
  `modelsView`'s direct `qualificationStat(sy.db, ...)` call to the same `qdb` for the same reason
  (it reads the same table). **Left untouched**: `matrix()`'s and `routingPreview()`'s
  `qualificationLookup(sy.db, sy.cfg)` calls — these feed core routing's eligibility/plan
  explanations, used identically by the live gateway (not just the panel), and changing only their
  call sites inside `insights.ts` while every other routing/admission call site keeps reading
  `sy.db` for the same table would be an inconsistent half-measure outside this brief's named scope
  (`qualificationBoard`, `endpointStats`/`modelsView`). Flagging for whoever eventually migrates
  qualification data to its own store for real.

## Goal 2: `jobsView`/`teamMetrics` miss `project_id=''` jobs

Root cause confirmed exactly as A4a's report described: both functions scan each project's store
with raw SQL `WHERE profile='supervise' AND project_id = ?` bound to the project's real slug, but
`taskIn`'s `ownedBy()` (used immediately after, in the same two files, to actually load the task)
treats a `project_id=''` row as owned by the **primary** project by convention. A job submitted via
`sy.tasks.submit(...)` with no `project` option is therefore never selected by the listing scan
(because its `project_id` is `''`, never the primary project's real slug) even though `ownedBy`/
`taskIn`/`locateProjectTask` would happily find it by id.

**The one rule, now shared**: added `projectIdFilter(sy, project)` to `project-reads.ts` — when
`project` is the primary project's slug, the filter is `project_id IN (?, '')`; otherwise it's the
plain `project_id = ?`. Used it in both `jobsView`'s and `teamMetrics`'s listing-scan SQL (replacing
the bare `project_id = ?` + `.all(slug, limit)` with the filter's `sql`/`args` spread). This makes
the listing scan and `ownedBy`'s lookup convention agree: a `project_id=''` job is now listed under
the primary project, exactly where a direct `jobDetail`/`jobMetrics` lookup by id already finds it.

`tests/team-metrics.test.ts`'s first failing assertion
(`teamMetrics(sy, { now: sec(100) }).map(...)).toEqual([["t_job", 12]])`) now passes; full file is
7/7 (was 6/7 per A4a).

## Follow-up: isolation tests appended to `tests/project-admin-store-isolation.test.ts`

Per the supervisor's follow-up message, appended one new `describe("project store isolation:
insights (A4b)", ...)` block (append-only; did not touch the other worker's existing cases or the
shared `buildFixture`/`canaryTask` helpers). Added one local helper, `insertModelRequest(db, opts)`,
scoped to the new `describe` block only. Seven new tests, using the same canary/decoy-in-`sy.db`
pattern as the existing blocks:

- `overview`'s `tasksByState`: two canary tasks in alpha's shadow, one in beta's, a `completed`
  decoy charged to `'alpha'` inserted directly into `sy.db` — asserts `queued: 3` and that
  `completed` never appears at all (not just that it's `0`).
- `modelsView`'s `endpointStats`: one request each in alpha's and beta's shadows (latencies 5ms
  and 15ms) plus a decoy in `sy.db` with latency ~100s and 999 tokens — asserts the merged
  `avgLatencyMs` is exactly `10` (the true weighted merge, not skewed by the decoy) and
  `inputTokens`/`outputTokens`/`lastUsedAt` match only the two real rows. (First run failed because
  my test timestamps were near-epoch, outside `endpointStats`'s 7-day window — fixed by using
  `Date.now()`-relative timestamps; not a defect in the converted code.)
- `requestLog`/`requestLogCount`: two rows in each of alpha's and beta's shadows at different
  `reserved_at` values, plus a decoy in `sy.db` — asserts the count excludes the decoy and that
  `limit`/`offset` paging across the two physically separate databases returns the correct
  newest-first page both times (proves the in-memory merge-then-repaginate, not just a lucky SQL
  `ORDER BY` on one shared handle).
- `timeseries`: one row in each shadow in the same bucket, plus a decoy in `sy.db` — asserts the
  merged bucket's `requests`/`inputTokens`/`outputTokens` count only the two real rows.
- `tierDistribution`: one tagged task in each shadow, plus a decoy in `sy.db` — asserts the merged
  tier's `tasks` count excludes the decoy.
- `qualificationBoard`: a `qualification_runs` row inserted directly into **alpha's** shadow store
  (contamination — alpha is not the qualification project) and a real row inserted into `sy.db`
  (today, the qualification project's own store, since the fixture does not shadow it) — asserts
  the board lists the real row and never the contamination, proving the function reads a single
  scope rather than fanning across every configured project's store.
- `jobsView`/`teamMetrics` (Goal 2's fix): a `project_id=''` supervise task inserted directly into
  **alpha's** own shadow store (alpha is this fixture's primary project, since `brain.project:
  "alpha"`) — asserts `jobsView(sy,50,"alpha")` and `teamMetrics(sy,{project:"alpha"})` both list
  it, `...,"beta"` never does, and the no-project (merge-all) call lists it exactly once.

Commands run: `cd packages/router && npx tsc --noEmit` → exit 0, clean;
`npx vitest run tests/project-admin-store-isolation.test.ts` → **17/17 pass** (10 pre-existing + 7
new).

## Goal 3: `sessions.ts`/`budget.ts` re-check

Both were already fully converted by A4a (every explicit-`project`-parameter function routes
through `sy.projectStores`/`openProjectStores`, with the `''`-unattributed case handled). Re-checked
for any remaining `localTables` read on `sy.db` directly; found none in either file. What
intentionally still reads outside a project's own store, and why:

- **`sessions.ts`**: `sessionViews`'s per-task labelling (`sy.tasks.get`/`sy.sessions.forTask`,
  `latestAgentSession`) goes through the service layer, not a raw `sy.db` query — unchanged from
  A4a's note, still correct, still out of this brief's "raw reads" scope.
- **`budget.ts`**: no raw `sy.db` localTables reads anywhere; its only `sy.db` use is the explicit
  `project === ""` branch (an installation-level task's `budget_requests` row, same convention as
  `locateRequest`'s `''` case) — that is the correct, intentional sharedTables-equivalent read for
  unattributed rows, not a leftover to convert.
- Neither file reads a `sharedTables` table (endpoints, provider state, paid spend, etc.) at all.

## Commands run and observed results

- `cd packages/router && npx tsc --noEmit` → exit 0, clean (run twice, once mid-way and once after
  all edits).
- `cd D:/MeritRouter && pnpm --filter meritrouter-panel typecheck` → exit 0, clean (no apps/panel
  type changes were needed — `Overview.tasksByState`, `tierDistribution`'s and `requestLog`'s
  return shapes are all unchanged).
- `npx vitest run tests/team-metrics.test.ts` → **7/7 pass** (confirms Goal 2's fix; was 6/7 before).
- Every existing test file importing `insights`/`jobs`/`job-metrics`/`sessions`/`budget` (found via
  `grep -rl` for those module paths plus a second grep for direct `requestLog(`/`timeseries(`/
  `tierDistribution(`/`qualificationBoard(`/`modelsView(`/`insights.overview` call sites under
  `tests/`), run serially in batches of 4:
  - `tests/admin-budget-panel.test.ts`, `tests/admin-job-navigation.test.ts`,
    `tests/admin-keys.test.ts`, `tests/admin-live.test.ts` → **4 files / 35 tests pass**.
  - `tests/admin-project-settings.test.ts`, `tests/admin-session-project-scope.test.ts`,
    `tests/budget-control.test.ts`, `tests/operations.test.ts` → **4 files / 59 tests pass**.
  - `tests/project-delete-pending-requests.test.ts`, `tests/project-request-protocol.test.ts`,
    `tests/project-task-lab-deletion.test.ts`, `tests/projects-delete.test.ts` → **4 files / 20
    tests pass**.
  - `tests/projects-followups.test.ts`, `tests/projects-operations.test.ts`,
    `tests/projects-panel-scope.test.ts`, `tests/projects-router-fixes.test.ts` → **4 files / 19
    tests pass** (`projects-panel-scope.test.ts` directly exercises
    `teamMetrics(sy,{project})`/`teamMetrics(sy,{})` from Goal 2).
  - `tests/projects-surfaces.test.ts`, `tests/qualification.test.ts`,
    `tests/repository-prepare.test.ts`, `tests/resilience.test.ts` → 1 failure
    (`resilience.test.ts > routing with open breakers > the gate skips a failing provider...`,
    `afterEach` hook timed out at 10s) on the first run; **re-ran `tests/resilience.test.ts` alone
    → 11/11 pass**, confirming CPU-contention flakiness per the brief's note, not a regression.
  - `tests/roadmap-project.test.ts`, `tests/session-surface.test.ts`, `tests/sessions.test.ts`,
    `tests/team-surface.test.ts` → **4 files / 34 tests pass**.
  - `tests/verification-surface.test.ts`, `tests/native-search.test.ts`,
    `tests/providers-routing.test.ts`, `tests/team-metrics.test.ts` → **4 files / 40 tests pass**.
  - Total: **27 test files, 227 tests, all pass** (one transient failure, reproduced-clean in
    isolation).

No provider/network calls were made.

## Not verified

- `requestLog`'s multi-scope merge-then-paginate path was exercised by existing tests only with
  small row counts (at most a handful of rows per scope); its `Math.min(offset+limit, 100_000)`
  per-scope fetch cap for very large offsets against many projects is untested (no existing test
  drives a large offset across more than one non-empty scope).
- `timeseries`'s and `tierDistribution`'s `project: ""` behavior change (now "unattributed rows
  only" instead of falling through to "every project") has no direct test either way; I verified by
  grep that no current caller or test passes `""` to either function, so the change is unobserved
  by the suite, not merely passing by coincidence.
- Full-suite `pnpm -r test`/`pnpm -r build` were not run (not in the brief's named acceptance
  checks).
- Did not re-run `admin-session-project-scope.test.ts`'s full 14/14 listing twice to rule out a
  flake of its own; it passed cleanly both times it ran as part of a batch.

## Report

This file.

Outcome: Done
Changed: packages/router/src/admin/project-reads.ts (additive: `ProjectDbScope`,
`projectDbScopes`, `fanOutProjectRows`, `projectIdFilter`), packages/router/src/admin/insights.ts
(`tasksByState`, `endpointStats`/`endpointStatsPart`, `modelsView`'s qualification lookup,
`requestLogScope`/`requestLogCount`/`requestLog`/`requestRowOf`, `timeseries`, `tierDistribution`,
`qualificationBoard`, `workers`' doc comment only), packages/router/src/admin/jobs.ts (`jobsView`'s
listing scan), packages/router/src/admin/job-metrics.ts (`teamMetrics`'s listing scan).
packages/router/src/admin/sessions.ts and packages/router/src/admin/budget.ts: reviewed, no code
changes needed (already fully converted by A4a; see Goal 3). packages/router/src/admin/project-usage.ts:
reviewed, no changes needed. Follow-up: packages/router/tests/project-admin-store-isolation.test.ts
(append-only: added imports plus one new `describe("project store isolation: insights (A4b)")`
block with 7 tests; did not touch the other worker's existing cases or the shared fixture builder).
Validation: `cd packages/router && npx tsc --noEmit` -> exit 0, clean; `pnpm --filter meritrouter-panel typecheck` -> exit 0, clean; `npx vitest run tests/team-metrics.test.ts` -> 7/7 pass; 27 test files importing the owned modules run serially in batches of 4 -> 227/227 tests pass (one transient `resilience.test.ts` afterEach-hook timeout on first run, reproduced clean 11/11 in isolation, confirmed CPU contention not a regression); `npx vitest run tests/project-admin-store-isolation.test.ts` -> 17/17 pass (10 pre-existing + 7 new, after fixing one test's near-epoch timestamps to be Date.now()-relative)
Not verified: requestLog's large-offset multi-scope merge path (untested at scale); timeseries/tierDistribution's project="" behavior change is unobserved by any current caller/test (verified by grep, not by a new test); full-suite pnpm -r test/build not run (outside the brief's named checks)
Report: docs/working/project-local-storage/reports/wave-a/a4b-admin-insights.md
Notes: Found jobs.ts/job-metrics.ts's project_id='' listing-scan defect fixed exactly as A4a described; added one shared `projectIdFilter` helper rather than duplicating the fix. Deliberately left `workers()` unconverted (meta's worker:* rows are installation-wide, not per-project, per store-role.ts's assertProjectContents) and left matrix()/routingPreview()'s qualification lookups on sy.db (core routing code outside this brief's named functions, consistent with the rest of the routing/admission system).
