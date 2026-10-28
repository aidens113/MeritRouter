# Split-layout CLI reads: fix report

## Root cause

`meritrouter session <id> --project <slug>` printed the correct header (counted from the
project's own `sessions` row) but an empty `log` path and "(no events after seq 0)" because
`scopedSessionTimeline` (`src/admin/session-project-scope.ts`) read the event log from
`path.join(sy.cfg.storageDir, "sessions")` — the **installation's** storage directory — instead
of the owning project's own sessions directory. In a split installation the project's log lives
under `<project>/.MeritRouter/sessions/`, a different directory, so the file was never found, the
whole cohort validation returned `null`, and the CLI fell back to "no events".

## What changed and why

- `src/admin/session-project-scope.ts` (`scopedSessionTimeline`): get the opened project's own
  `SessionStore` (`opened.stores.sessions`) and use its public `logPathFor(id)` to resolve the
  log file/directory, instead of reconstructing a path from `sy.cfg.storageDir`. `logPathFor`
  already derives the correct root from the project's own database location
  (`ProjectEvidenceScope.rootFor`), so this is correct for both split and legacy layouts (legacy's
  `stores.sessions` is the shared installation store, which resolves to the same directory as
  before). Returns `null` (same as other validation failures) if the project has no session
  store.

- `src/cli.ts`:
  - **`job`**: now passes `{ project: idScope() }` to `jobDetail`, then uses the job's own
    `project` field (from the result) for the `jobTeam` lookup, instead of calling both with no
    project at all.
  - **`plan`**, **`metrics`**, **`channel`**: now pass `{ project: idScope() }` to `jobPlan`,
    `jobMetrics`, `jobChannel` respectively. These admin functions already accepted an optional
    `project` parameter (per `src/admin/job-plans.ts`, `job-metrics.ts`, `job-team.ts`); the CLI
    simply was not passing it through. `idScope()` is the CLI's existing helper (project only when
    `--project`/`MERITROUTER_PROJECT` was explicit), matching the pattern already used by
    `status`/`collect`/`await`/`cancel`/`resume`/`accept`/`reject`/`answer`/`transport`.
  - **`artifact`**: previously called `sy.artifacts.read(ref)` directly against the installation
    store with no project scoping at all (a bug in both legacy and split layouts, though only
    split actually isolates the data). Now scans each project's own store
    (`scopesFor(sy, idScope())` → `openProjectStores` → `artifacts.readScoped(ref, project)`,
    the project-scoped accessor the codebase already uses elsewhere, e.g.
    `src/context/sources.ts`, `src/admin/brain-memory-manifest.ts`). Falls back to the direct
    `sy.artifacts.read(ref)` only on a **legacy** installation (`sy.layout === "legacy"`) and only
    when no project claims the artifact, to preserve the historical behaviour for an artifact
    recorded with no `task_id` (e.g. a qualification probe's shared artifact) — legacy layout has
    only one physical store, so this path carries no cross-project leak risk.
  - `status`, `collect`, `usage`, `questions`, `sessions` (list) were already passing their
    project scope (`idScope()`/`listScope()`) into service methods or `sessionsView`/`sessionDetail`,
    which are already split-aware (`src/admin/sessions.ts` fans out via
    `sy.projectStores(slug)`/`fanOutProjects`). No change needed there.

## Not my files (left for the admin-side worker, per the lead's scope note)

I did **not** touch any `src/admin/**` file other than `src/admin/sessions.ts` and
`src/admin/session-project-scope.ts` (used only by `sessions.ts`). Specifically, the following
admin functions already accept a `project` option and the CLI now passes it through, but their
*internal* split-layout correctness (e.g. `jobDetail`'s and `jobTeam`'s own cross-store lookups
without an explicit project, `jobMetrics`, `jobPlan`, `jobChannel` internals) is the other
worker's workstream — I only verified they compile and accept the parameter, not their internal
behaviour. Also noted, not touched:

- `src/admin/request-evidence.ts:42` builds `path.join(sy.cfg.storageDir, "sessions")` the same
  way the bug I fixed did — this looks like the identical defect, in a file outside my ownership.
- `src/admin/insights.ts:615` (`qualify status`'s artifact text helper) calls
  `sy.artifacts.read(ref)` directly, same pattern as the CLI `artifact` bug, also outside my
  ownership.
- `tests/split-detail-views.test.ts` (untracked, presumably the other worker's in-progress probe)
  has one pre-existing `tsc --noEmit` error (`Property 'ref' does not exist on type
  'ArtifactRow'` at line 61) unrelated to my changes; left as-is.

## Commands run and observed results

- `npx tsc --noEmit` (from `packages/router`, source only, no dist build): one error, in
  `tests/split-detail-views.test.ts` (not mine, see above). No errors in any file I touched.
- `npx vitest run tests/project-cli-operations.test.ts tests/admin-session-project-scope.test.ts tests/session-recording.test.ts tests/split-cli-reads.test.ts`
  → **4 files passed, 36 tests passed** (admin-session-project-scope 14, split-cli-reads 3 (new),
  project-cli-operations 9, session-recording 10).
- New test file `tests/split-cli-reads.test.ts`: split installation, one project ("alpha"), a
  `FakeProvider` task completed end to end, then:
  1. `sessionDetail(sy, sessionId, { project: "alpha" })` returns non-empty `events`, a positive
     `lastSeq`, `timelineUnavailable: null`, and `sessionTimeline(...)` no longer renders
     "(no events after seq 0)" — reproduces and verifies the fix for the reported bug.
  2. The same session is still found when no `--project` is given (cross-project search).
  3. `sessionsView(sy, { project: "alpha" })` lists that session with its real `lastSeq`.
  4. An artifact written into the project's own store is read back by scanning each project with
     `readScoped`, exactly as the fixed CLI `artifact` command now does.

No dist build was run; no panel or worker processes were started; no live pilot files were
touched.

## Not verified

- The admin-side split-layout correctness of `jobDetail`, `jobTeam`, `jobPlan`, `jobMetrics`,
  `jobChannel` beyond "they accept and type-check with the `project` option the CLI now passes."
  Their own internal store-selection logic is the other worker's workstream.
- `src/admin/request-evidence.ts` and the `qualify status` artifact-text path in
  `src/admin/insights.ts` were not fixed (out of scope) but are flagged above as carrying the
  same defect pattern.
- Did not run the full repository test suite (`pnpm -r test`) or `pnpm -r typecheck`, only the
  acceptance-listed tests and `npx tsc --noEmit` for `packages/router`, per the brief and the
  no-dist-build constraint.
- `sy.artifacts.read` fallback path for a legacy installation with no owning project is exercised
  only indirectly (not by a dedicated test); the new test covers the split, project-scoped path.

## Open questions or contradictions found

- The lead's mid-task note reassigned ownership of `src/admin/**` (except `sessions.ts`) to a
  second worker for by-id detail views, after I had already read `src/admin/sessions.ts`,
  `session-project-scope.ts`, and `project-reads.ts` (read-only import, not edited) to diagnose
  the session bug. I did not edit anything in `src/admin/**` besides `sessions.ts`'s sibling
  `session-project-scope.ts`, which is only ever called from `sessions.ts`.
- `src/admin/project-reads.ts` is owned by the other worker going forward; my `cli.ts` and test
  changes import (read-only) `openProjectStores` and `scopesFor` from it. If that worker renames
  or removes those exports, my `artifact` command and the new test's third case will need a
  follow-up.

Outcome: Done
Changed: src/admin/session-project-scope.ts, src/cli.ts, tests/split-cli-reads.test.ts (new)
Validation: `npx tsc --noEmit` -> clean except a pre-existing unrelated error in another worker's untracked tests/split-detail-views.test.ts; `npx vitest run tests/project-cli-operations.test.ts tests/admin-session-project-scope.test.ts tests/session-recording.test.ts tests/split-cli-reads.test.ts` -> 4 files / 36 tests passed
Not verified: internal split-layout correctness of jobDetail/jobTeam/jobPlan/jobMetrics/jobChannel beyond accepting the project param; src/admin/request-evidence.ts and insights.ts's qualify-status artifact read (same bug pattern, out of scope, flagged above); full pnpm -r typecheck/test
Report: docs/working/project-local-storage/reports/split-cli-reads.md
Notes: request-evidence.ts:42 has the identical sy.cfg.storageDir sessions-dir bug I fixed in session-project-scope.ts, but it's outside my ownership now.
