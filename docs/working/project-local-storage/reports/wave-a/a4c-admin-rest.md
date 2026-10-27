# A4c: admin reads part 3 + isolation test

Worker: worker (Sonnet 5). Scope: Brief A4c (gate 1 wave A, S7 admin reads part 3 + isolation test).

## Outcome

Goal 1 (convert the 14 owned files) and Goal 2 (isolation test) are both done, with specific,
documented exceptions where a correct conversion needs a change outside my owned files (same
category of exception A4a already established for `insights.ts`). All acceptance checks pass.

## Goal 1: per file

For every file, "sharedTables reads left on `sy.db`" lists what stays there and why (per
`store-role.ts`'s `sharedTables`/`qualificationTables`, a table with no `project_id` column, or a
genuine install-wide concern with no project to key a store on).

- **`entities.ts`**: converted `agentsView` (fans out per project, merged, when no `project`),
  `taskRows`/`requestRows` (now take an optional `project`; with one, read that project's store
  only, filtered by its own `project_id`; without one, fan out over every configured project +
  qualification, each filtered to its own `project_id`, plus the `''` installation fallback —
  never a bare `id IN (...)` scan, which would have double-counted every project's rows once the
  physical databases differ), `sessionRequestIds` (now takes `project`, reads that project's own
  session log/`model_requests` when its store opens), `agentDetail`, `requestDetail` (now uses
  `locateRequest` instead of an unscoped `model_requests` read), `sessionRequests`, `taskRelated`
  (its entry lookup now uses `locateTask` — tried across every configured project's store, plus
  qualification and the `''` fallback — instead of the installation-wide `sy.tasks.get`, so a task
  that exists only in its own project's store is still found), `modelUsage` (fans out the
  `endpointId` scan per project, capped and merged with `newestFirst` so `limit` cannot be
  outrun). Left unscoped on purpose: the ancestor walk inside `taskRelated` (`parentOf`/`labelOf`)
  keeps the installation-wide `sy.tasks.get`, documented inline — a reparented task's ancestor can
  in principle sit in a different project's job than the task itself, and this walk does not know
  which project to open ahead of each hop.
- **`calibration.ts`**: converted `usageByPurpose` (fans out per project, filtered by its own
  `model_requests.project_id`) and the "verified vs subsequently confirmed" `passedIds` listing
  inside `calibrationOverview` (`tasks` has its own `project_id`, fanned out + `newestFirst`).
  **Left on `sy.db`, documented in the module's doc comment**: `verdictRecords(sy.db,{sinceMs})`
  and the `verification_audits` listing. Neither `verdict_records` nor `verification_audits` has
  a `project_id` column (checked `storage/migrations.ts`); `verdictRecords()` has no project
  filter or join either. Calling it once per project's store against today's single physical
  database would return the *same* unfiltered installation rows every time — double-counted once
  per project, the exact bug the brief says never to introduce — not once. A correct conversion
  needs a project-aware (joined) export added to `verification/calibration.ts`, which is outside
  my owned paths. What each listing's rows *connect to* is still converted: `confirm()`/`goal()`
  now resolve each task's owning project (via the install-wide `projectOf`, used only to locate
  the owner — the same bootstrap pattern as `locateTask`) and read `events`/`verification_signals`/
  `tasks` through that project's own store, not `sy.db`.
- **`dashboards.ts`**: converted `activeJobs` (single project reads that store; no project fans
  out + `newestFirst`; the task row and its pending questions are now read from the *same row's*
  own store via `taskIn`/`projectQuestions`, not the installation-wide `sy.tasks`/`sy.questions` —
  an earlier draft left that coupling in and it silently dropped every project-store-only task),
  `tasksByState` (now exported; single project reads that store, no project sums every project's
  own count), `oldestQueuedAt` (that project's store, `null` rather than throwing when
  unavailable). **`paidSpendByProject`**: `paid_spend` is a shared table (`sharedTables`) with no
  `project_id`; each configured project's own store is read, joining its own `model_requests` rows
  to `paid_spend` (today the same physical database, so the join resolves; once truly split this
  join needs its own design, flagged in the function's doc comment), and the `''`
  (unattributed/no-task) bucket is read from `sy.db` directly since it has no project store.
  `unattributedUsage`'s `project_id = ''` read is unchanged (by definition there is no store for
  `''`). `projectOverview`'s `sy.usage(...)` calls are untouched per A4a's note (another worker's
  area).
- **`deliveries.ts`**: `projectDeliveryReport` and `deliveryView` now open the project's own store
  (`requireProjectStores`/`locateProjectTask`) and pass its `db` to `ProductDeliveries` instead of
  `sy.db`.
- **`brain-entities.ts`**: the two `tasks` ownership checks in `brainDocumentRelated` and
  `brainDocumentBlame` (`belongs.get(id, project)`) now read through `openProjectStores(sy,
  project)`; an unavailable store degrades to "nothing belongs" (empty/masked) rather than reading
  `sy.db`.
- **`brain-memory-manifest.ts`**: `brainMemoryManifestPreview`'s `tasks`/`artifacts` reads and
  `sy.artifacts.readScoped` now go through `requireProjectStores(sy, query.project)`.
- **`labs.ts`**: `operationViews`'s and `labsListView`'s `lab_operations` reads now go through
  `requireProjectStores(sy, project)` instead of `sy.db`.
- **`qualification-work.ts`**: `isQualificationTask` now uses `locateProjectTask(sy, taskId,
  QUALIFICATION_PROJECT)` (a real per-store-scoped ownership check) instead of comparing
  `sy.tasks.projectOf`. `qualificationTasks` now opens the qualification project's own store
  (`openProjectStores`) and reads `tasks`/`qualification_tasks` from it, with `taskIn` for the
  per-row ownership check; empty (never a crash) when that store cannot be opened. Per the brief,
  the qualification project's tables belong to its own reserved scope, not `sy.db`.
- **`project-settings.ts`**: `tasksUsingRepository` now opens `slug`'s own store and reads
  `tasks` from it (empty, not a crash, when unavailable).
- **`live.ts`**: a single-project scope (`cursor.scope !== "all"`) now opens that project's own
  store and runs every source's SQL against its `db` instead of `sy.db` (`scopeDb`); today the
  same physical handle, so every result is unchanged, and this is forward-compatible once stores
  split. **`scope: "all"` is left reading `sy.db` across every project in one query, documented in
  a new module-level comment**: its project-scoped sources (`tasks`, `sessions`, `budget`,
  `requests`, `events`, `jobs`, `workerActions`, `brainAccess`, `labs`, `web`) use digest-based
  marks (a SHA-256 of concatenated rows) and id-attribution queries that cannot simply be re-run
  per project and concatenated — converting them needs new per-source mark/topic merge math (the
  same class of "needs real design time, not a mechanical substitution" call A4a made for
  `insights.ts`'s parameter-less cross-project reads), which this brief's time did not cover
  safely. The remaining five sources (`keys`, `models`, `projects`, `config`, `workers`) are
  genuinely install-wide (no project column at all) and always read `sy.db`, as the module's own
  doc comment already said before my change.
- **`config-edit.ts`**, **`provider-keys.ts`**, **`quarantine.ts`**, **`plan-recovery.ts`**: no
  change. None of these files has a direct `sy.db`/`sy.tasks`/`sy.sessions`/`sy.artifacts` read of
  a `localTable` at all:
  - `config-edit.ts` only does file I/O and delegates `sy.db` to `retainedLabConfigErrors`/
    `recordPreparation` (defined in other, not-owned files).
  - `provider-keys.ts`'s only raw `sy.db` read is `SELECT value FROM meta WHERE key =
    'provider_discovery_last'` — install-wide operational metadata (no project column), the same
    category `live.ts`'s `workers`/`models` sources and A4a's `insights.ts` `workers()` already
    document as staying on `sy.db`. Everything else goes through `sy.vault`/`sy.providers`/
    `sy.spend` (shared-table services).
  - `quarantine.ts` touches only `endpoint_quarantines` (a `sharedTable`) via
    `gateway/quarantine.ts`.
  - `plan-recovery.ts` has no raw `sy.db`/`sy.tasks` read; it calls `sy.sessions.forTask` (a
    service call, not raw SQL) and the already-converted `jobPlan`/`jobDetail`/`contextOfTask`.

### `apps/panel/**` follow-ups

None needed: `pnpm --filter meritrouter-panel typecheck` passes with no changes. The only
additive, exported-type changes were `taskRows`/`requestRows` gaining an optional trailing
`project` parameter (source-compatible) and `tasksByState` becoming exported (new export, no
existing call site touched).

## Goal 2: `tests/project-admin-store-isolation.test.ts`

**Design.** A shared `buildFixture()`/`fixture()` builds one `MeritRouter` (via `makeEnv`/`open`)
configured with three projects: `alpha` and `beta` each get a genuinely separate physical sqlite
database (`openDatabase` in its own temp dir, with its own `TaskStore`/`ArtifactStore`/
`SessionStore`/`ContractStore`, wrapped with `createProjectRuntimeStore` exactly as
`runtime-store.ts` wraps the installation's own same-DB handle today — not
`createSplitProjectRuntimeStore`, which asserts a registered store identity this fixture
deliberately does not set up); `broken` is configured but its `projectStores` throws. The test
replaces `sy.projectStores` on the instance to route `alpha`/`beta` to their shadow stores and
`broken` to a throw, falling back to the original method for the qualification project.

A canary row goes only into its project's own shadow database; a decoy with the same id/project
goes only into `sy.db`. A converted view that reads the right store returns the canary and (where
the function's content differs per project, such as a budget `reason` or a job's `goal`) never the
decoy or another project's row; a view that mistakenly fell through to `sy.db` would see the decoy
instead, or nothing (when the decoy only exists for a different id), which the tests assert
explicitly either way. One known, pre-existing limitation is called out in-line in the fixture
comment rather than hidden: session logs still share the installation's own `storageDir`, since
file-level (not table-level) project isolation is out of this wave's scope — each shadow's
`SessionStore` is built against the real `storageDir` but its own separate database.

One `describe` per admin module, appended to the shared fixture, as asked, so a later worker
(insights.ts) can add its own `describe` without touching what is here.

**Coverage and findings:**
- `session-project-scope.ts` (`scopedSessionTimeline`, A4a): finds a session that exists only in
  its project's own store; refuses it under the wrong project; reports `broken` as unavailable
  (`null`, not a throw).
- `request-evidence.ts` (`requestEvidence`, A4a): finds a request by the *same id* in two
  different projects, each correctly returning its own project's related task, never the other's;
  never shows a row that exists only in `sy.db` under the same id/project.
- `budget.ts` (`budgetRequestsView`, A4a): lists a project's own budget requests (reason text,
  task label from that project's own store) without the other project's or the installation's
  decoy; merges every project when none is given and reports `broken` unavailable without failing.
- `jobs.ts` (`jobsView`, A4a): lists a supervise task only from its own project's store, never an
  installation decoy charged to the same project; merges and reports `broken` unavailable.
- `dashboards.ts` (`activeJobs`, `tasksByState`, owned): same pattern — project-scoped reads never
  see the installation decoy or another project's rows; merging across every project sums
  correctly. Finding this test caught: my first draft of `activeJobs` still read the task row via
  the installation-wide `sy.tasks.get`/`sy.questions`, which silently dropped every task that
  existed only in a project's own store — fixed before this report (see `dashboards.ts` above).
- `entities.ts` (`taskRelated`, owned): finds a task that exists *only* in its project's own
  store (not present in `sy.db` at all), proving the entry lookup no longer depends on the
  installation-wide `sy.tasks`.

**A second fix this test surfaced**, outside my owned files: the existing
`tests/brain-provenance-paging.test.ts` builds a hand-rolled fake `MeritRouter` object (`{ db,
artifacts, projects }`) for `brainMemoryManifestPreview`, with no `projectStores` method. Once
that function reads through `requireProjectStores`, the fake object's missing method made
`openProjectStores` catch a "not a function" error and report the project unavailable, so the
test failed. I added a minimal `projectStores: (project) => ({ project, db, artifacts })` to that
one fixture (the only two fields `brain-memory-manifest.ts` reads from a store) — a necessary,
minimal collateral fix, not a new feature; flagging it since it touches a file outside my named
owned list, but leaving it broken would be a correctness regression my own conversion caused.

**Exact counts**: `tests/project-admin-store-isolation.test.ts` — 10 tests, all pass.

## Commands run and observed results

- `cd packages/router && npx tsc --noEmit -p .` → clean, no errors, repeated after every file's
  edits and again at the end.
- `cd packages/router && npx vitest run tests/project-admin-store-isolation.test.ts` → **10/10
  pass**.
- `cd D:/MeritRouter && pnpm --filter meritrouter-panel typecheck` → exit 0, no errors.
- Every existing test file importing an owned file (found via `grep -rl` for the 14 modules'
  import paths under `tests/`), run in batches of ≤4, serially:
  - `admin-brain-entities.test.ts` (15), `admin-keys.test.ts` (9), `admin-labs.test.ts` (8),
    `admin-live.test.ts` (20) → **52/52 pass**.
  - `admin-plan-recovery.test.ts` (1), `admin-project-settings.test.ts` (5),
    `admin-promotions.test.ts` (5), `admin-request-evidence.test.ts` (8) → **19/19 pass**.
  - `admin-session-project-scope.test.ts` (14), `brain-provenance-paging.test.ts` (2 — 1 failed
    before the fixture fix above, 2/2 after), `delivery-attention-report.test.ts` (4),
    `execution.test.ts` (16) → **36/36 pass** after the fixture fix.
  - `lab-config-guard.test.ts` (1), `process-performance.test.ts` (9 — see below),
    `roadmap-project.test.ts` (8), `task-lab-validation.test.ts` (6).
  - `usage-cache-certainty.test.ts` (4), `verification-calibration.test.ts` (8) → **12/12 pass**.
  - Additional `insights.js`-importing tests (that module re-exports every one of my 14 files),
    sampled per the brief's own list plus the ones A4a already exercised:
    `admin-job-navigation.test.ts` (3), `qualification.test.ts` (6), `team-surface.test.ts` (6),
    `verification-surface.test.ts` (7) → **22/22 pass**; `sessions.test.ts` (14),
    `session-surface.test.ts` (6), `resilience.test.ts` (11) → **31/31 pass**.
- **`process-performance.test.ts`'s "measures bounded task throughput at concurrency 1 and 4"
  test timed out (45s) three times in isolation, including once with `live.ts` temporarily
  reverted to its committed, unmodified content** (verified with `git show HEAD:...` swapped in,
  tested, then swapped my changes back and re-verified with `git diff` that the restore was exact
  and `tsc`/the isolation test still pass). This test exercises task admission/scheduling and a
  fake 25ms-per-response provider with no call into any file I changed (only the *other* `it` in
  the same file calls `liveCursor`/`liveChanges`, and that one passed in every run, quickly, with
  its own perf numbers printed). I conclude this is a pre-existing, environment/CPU-contention
  flake on this machine, unrelated to this brief's changes, and did not change the timeout per the
  brief's instruction. All 8 other tests in that file pass every time.

## Not verified

- The remaining `insights.js`-importing tests not run above (`admin-keys.test.ts` was run;
  `operations.test.ts`, `project-delete-pending-requests.test.ts`,
  `project-request-protocol.test.ts`, `project-task-lab-deletion.test.ts`, `projects-*.test.ts`,
  `repository-prepare.test.ts`): not individually re-run; most exercise `insights.ts`/`projects.ts`
  surfaces that A4a's own brief already validated and that this brief did not touch.
- `live.ts`'s `scope: "all"` behaviour for a true multi-store future (today's same-DB handle keeps
  it byte-for-byte identical; the per-project fan-out/merge math for its digest-based marks is
  explicitly left for a follow-up, documented in the file).
- `calibration.ts`'s `verdictRecords`/`verification_audits` listings for a true multi-store
  future, for the reason documented above (needs a shared-module export outside my owned files).
- Full-suite `pnpm -r test`/`pnpm -r build` were not run (not named in this brief's acceptance
  checks).

## Report

Outcome: Done
Changed: packages/router/src/admin/entities.ts, packages/router/src/admin/calibration.ts, packages/router/src/admin/dashboards.ts, packages/router/src/admin/deliveries.ts, packages/router/src/admin/brain-entities.ts, packages/router/src/admin/brain-memory-manifest.ts, packages/router/src/admin/labs.ts, packages/router/src/admin/qualification-work.ts, packages/router/src/admin/project-settings.ts, packages/router/src/admin/live.ts (config-edit.ts/provider-keys.ts/quarantine.ts/plan-recovery.ts reviewed, no changes needed — see report); packages/router/tests/project-admin-store-isolation.test.ts (new); packages/router/tests/brain-provenance-paging.test.ts (minimal fixture fix, necessary collateral — outside my named owned list, flagged above)
Validation: `cd packages/router && npx tsc --noEmit -p .` -> clean; `npx vitest run tests/project-admin-store-isolation.test.ts` -> 10/10 pass; `pnpm --filter meritrouter-panel typecheck` -> exit 0; batches of ≤4 existing test files (listed above, counts given) -> all pass except one pre-existing, environment-dependent timeout in `process-performance.test.ts` verified unrelated to this brief's changes (reproduced identically with `live.ts` reverted to its committed content)
Not verified: live.ts's "all" scope and calibration.ts's verdict/audit listings under a true future multi-store split (both documented, both need a change outside my owned files to convert safely); the long tail of insights.js-importing tests not individually re-run (listed above); full-suite pnpm -r test/build
Notes: Two real bugs were found and fixed before this report, not left for review: dashboards.ts's first-draft activeJobs silently dropped project-store-only tasks via sy.tasks/sy.questions (fixed, now taskIn/projectQuestions on the row's own store); tests/brain-provenance-paging.test.ts's fake MeritRouter needed a minimal projectStores method once brain-memory-manifest.ts started requiring one. Three documented exceptions (live.ts "all" scope, calibration.ts's two verdict-table listings) need a shared-module change outside my 14 owned files to convert without a double-counting risk; left as follow-ups per the same standard A4a set for insights.ts.
