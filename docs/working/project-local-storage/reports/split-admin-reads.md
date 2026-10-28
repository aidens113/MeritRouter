# Split admin reads: sessions, labs, and the legacy demo's Lab fixture (worker report)

Worker: split-admin-reads (worker, Sonnet 5). Date: 2026-10-27. Branch dev, main checkout. I made
no commits and created no worktrees (git state is for the lead to commit).

## Outcome

Done.

## What changed and why

**`packages/router/src/admin/sessions.ts`** — `sessionsView`'s per-project branch read
`sy.sessions.list(...)` (the installation-level `SessionStore`, built on `sy.db`) unconditionally.
In split layout `sy.db` is the coordination store, and `ProjectEvidenceScope.assert()` refuses any
read from it, so every split project's Sessions page had no data (wave-c3's defect #1). The
unfiltered branch (no `project` given) had the same problem.

Rewrote `sessionsView` to fan out over each project's own store (`sy.projectStores(slug)`, via
`fanOutProjects`/`projectScope`, the same helpers `jobsView` uses), reading session ids filtered
explicitly by `project_id` (via `projectIdFilter`, so a shared legacy database is not scanned once
per project and double-counted) plus the caller's other filters (status, taskId, jobId,
parentSessionId), then fetching each full record through that same store. It now returns
`RowsWithAvailability<SessionView>` (an `unavailable` marker array, like `jobsView`) instead of a
plain array; `project_id`-unfiltered rows merge newest-first across projects the same way
`jobsView` does. Legacy (single shared database) behaviour is unchanged in effect — every project's
own store *is* `sy.db` there, so the same query still reads the same rows — but it is no longer a
special-cased code path.

`sessionViews` (the helper that fills in `taskLabel`/`resumable`) also called the
installation-level `sy.tasks`/`sy.sessions` directly, which has the identical problem for any
split project. I scoped it to take a small `SessionViewContext` (`tasks`/`sessions` picked from
one project's own `ProjectRuntimeStore`, with a `sy.tasks`/`sy.sessions` fallback only for the `''`
"no project" row, matching the fallback pattern already used in `admin/entities.ts`). `sessionDetail`
(a sibling reader in the same file, per the brief) had the same three call sites
(`sy.sessions.get`, `sy.sessions.list({parentSessionId...})`, `sy.sessions.forTask(...)`) and is now
scoped through `contextFor(sy, located.stores)` too, so a session's own project's store is used
throughout, not just for its timeline (which `session-project-scope.ts` already scoped correctly).

**`packages/router/src/admin/labs.ts`** — `labsListView` called `requireProjectStores`, which
throws `ProjectStoreUnavailableError` for an unavailable store, unlike `jobsView`/`teamMetrics`/etc.
(wave-c3's defect #2). Split `labEntry` out as its own function (so `labsListView`'s return type
could reference `ReturnType<typeof labEntry>` without a circular self-reference), and wrapped the
`requireProjectStores` call in `try/catch`: an unavailable store now returns
`withUnavailable({ project, archived, configured, labs: [] }, [{ project, reason }])` — the same
`WithUnavailable<T>` shape `project-reads.ts` defines for single-object views — instead of
throwing. `archived` and `configured` are still read `scope`/`projectConfig` first, since those are
config-only reads that do not need the store.

**`apps/panel/app/p/[slug]/jobs/page.tsx`** — `labsListView` is now called unconditionally (never
throws), and the labs list is skipped only when its own `unavailableProjects` marker says so,
instead of piggy-backing on `jobs.unavailable.length` (a different, if usually-correlated, signal).

**`apps/panel/app/p/[slug]/sessions/page.tsx`** — removed the `safeSessionsView` try/catch
workaround (no longer needed: `sessionsView` no longer throws for a healthy project, per the fix
above) and the separate `insights.unavailableProjectStores(sy, p.slug)` call. The page now reads
`sessionsView(...).unavailable[0]` directly, the same way `jobs/page.tsx` already read
`jobsView(...).unavailable`.

**`apps/panel/scripts/seed-demo.mjs`** — the legacy demo's `demo` project has two repositories
(`core`, `app`), so (per `projects/resolve.ts`'s `projectDirectory` default) it gets no *implicit*
project directory the way `storefront`/`legacy-billing` do from their one repository each. Its
fixture Labs (`idle.labs.create("demo", ...)`) therefore hit `labs/lab.ts`'s deliberate
`"A project directory is required before creating project-local Labs"` check (since commit
`5cb43f9`) and crashed the seed before it reached `archiveProject("legacy-billing")` and the final
`security`/`verification` config tightening. Added an explicit `directory` to all three projects
(not just `demo`) for clarity — `demo: "project-demo"` (a new, dedicated subfolder, not nested
under another project's directory, since `resolve.ts` refuses that overlap), `storefront:
"storefront"` and `legacy-billing: "billing"` (the same values they already got implicitly, so no
behaviour change for them) — plus `mkdirSync(path.join(demo, "project-demo"))`, since
`runtime-paths.ts`'s `validateRuntimeLocation` requires the project directory to already exist on
disk before a Lab is created there (discovered live; `labOwnedPath` alone does not create it). I
did not touch `src/labs/**`.

## Commands run and observed results

- `pnpm --filter meritrouter build` → exit 0, clean (run twice: after the admin changes, and again
  at the end).
- `npx tsc --noEmit -p packages/router/tsconfig.json` → one pre-existing, unrelated error,
  `qualification/runner.ts(177,13): 'goal' is specified more than once`. Confirmed pre-existing on
  `HEAD` (`git diff` on that file is empty; the line is unchanged since commit `ba32ab3`, before
  this session) and outside `qualification/**`'s scope for this brief. `npx tsc --noEmit -p
  tsconfig.build.json` (what `pnpm --filter meritrouter build` actually uses) is clean, as is the
  build itself.
- `npx vitest run tests/admin-session-project-scope.test.ts tests/admin-labs.test.ts
  tests/project-admin-store-isolation.test.ts` → 3 files, 41 tests, all passed (run twice, final
  run clean in 12.9s).
- Added two new cases to `project-admin-store-isolation.test.ts` (`project store isolation:
  sessions (split-admin-reads)` and `... labs (split-admin-reads)`), using the file's existing
  shadow-store fixture (`alpha`/`beta` genuinely separate physical databases, `broken`'s
  `projectStores` throwing): `sessionsView` reads each project's own canary session and excludes
  the installation decoy and the other project's session, both per-project and merged, and reports
  `broken` unavailable; `labsListView("broken")` returns an `unavailableProjects` marker instead of
  throwing.
- `pnpm --filter meritrouter-panel typecheck` → clean (run three times across the session).
- `pnpm --filter meritrouter-panel build` → exit 0, full route manifest printed.
- `pnpm --filter meritrouter-panel seed:demo` → failed twice before succeeding, both diagnosed and
  fixed live (see above): first `ENOENT ... project-demo` (the project directory did not yet exist
  on disk; fixed with `mkdirSync`), then a transient `EBUSY`-style "a running panel or worker still
  has it open" from a stale process left by an earlier killed attempt (killed it, no code change
  needed). Third run (fresh, CPU-free): **completed to the end**, including the two fixture Labs
  (`calculator-preview`, `validation-fix`, health checks passed, promoted, stopped) and the tail
  config tightening (`security.outside_repository: human_only`, `verification.audit_sample_rate:
  0.2`, both confirmed present in the written `.demo/meritrouter.config.yaml` afterward) — the
  exact failure wave-c3 reported as a pre-existing defect is now fixed end-to-end, not just
  worked around. One pre-existing warning unrelated to this fix: "the repeated analysis did not
  reuse the cached verdict".
- `pnpm --filter meritrouter-panel seed:demo:split` → exit 0, "Split-layout demo ready".
- Production panel on a spare port (4591, not 4477) against `.demo-split`: started clean (`✓ Ready
  in 286ms`). Curled `/ /new /p/available/jobs /p/available/sessions /p/store-missing/jobs
  /p/store-missing/sessions` → all HTTP 200. Inspected the rendered bodies directly (not just the
  status code): `/p/available/sessions` and `/p/available/jobs` show the real empty state ("No
  sessions yet" / "No jobs yet"), no unavailable notice; `/p/store-missing/sessions` and
  `/p/store-missing/jobs` both show the "cannot be read right now (store_unavailable)" callout.
  Stopped both panel processes (`taskkill`); confirmed with `netstat` that port 4591 has no
  `LISTENING` entry afterward (only `TIME_WAIT` from the curls).
- Headless Chrome screenshot of `/p/available/sessions` at 1400px: confirms the Sessions page for
  a healthy split project — stats (Running/Interrupted/Failed all 0), filters, and the genuine "No
  sessions yet" empty state, no error notice. Saved at
  `C:\Users\mrjoh\AppData\Local\Temp\claude\d--MeritRouter\0378a7ee-52d2-4bc1-adb7-aa4d2ad7f466\scratchpad\available-sessions-desktop.png`
  (OS temp, not in the repo).
- `npx vitest run` (the full router suite) was started twice but not completed: it is very large
  (many multi-minute end-to-end tests) and the first run coincided with an earlier
  `seed:demo` attempt, causing CPU contention that I traced a transient seed failure to (see
  below). I stopped both full runs rather than wait tens of minutes once my three named acceptance
  files and the files I touched were independently confirmed clean. One incidental finding while
  the full suite was running: `tests/supervisor.test.ts`'s `"a shutdown while waiting for an
  answer spends no more requests, and the resumed job sees the answer"` failed (`expect(sy
  .questions()).toHaveLength(1)` timed out at 0) when run under heavy concurrent load, both as
  part of the full suite and once in isolation right after; re-run alone on a quiet machine it
  passed cleanly in 67s. I did not touch `core/service.ts` or anything in its path (`sy.questions`
  reads `job_questions`/`tasks`, nothing in `admin/sessions.ts` or `admin/labs.ts`), so I believe
  this is a CPU-contention-sensitive timing test (a 10-second, 100×100ms polling budget), not a
  regression from this change, but I did not run the full suite to a clean completion to be certain
  nothing else is affected.

## Not verified

- The full router test suite (`npx vitest run`, no file filter) was not run to completion; only
  the three named acceptance files (plus my two new cases in the third) were confirmed, along with
  a targeted, isolated re-run of `supervisor.test.ts` (see above). I have no evidence of any other
  regression, but I did not exhaustively check every test file.
- MCP-level smoke testing of `list_sessions`/`get_session` (`src/mcp/tools.ts`) was not run live;
  I confirmed by reading that `json(sessionsView(...))` serializes the same as before (the
  `unavailable` field is non-enumerable, exactly like `jobsView`'s, so no wire-format change) but
  did not call the tool.
- The CLI's `sessionsView` callers (`cli.ts`'s session list/detail commands) were not exercised
  live, only read.
- POSIX behaviour (Windows only, per environment).
- Other panel pages that call `labsListView` (`app/p/[slug]/page.tsx`, `app/p/[slug]/labs/page.tsx`,
  `app/api/labs/route.ts`) were not in my owned paths and I left them untouched; they still work
  correctly since `labsListView`'s return shape only gained an optional field, but I did not load
  them live in a split layout to double check a store-unavailable project renders sensibly there
  too (only the two pages named in the brief, `jobs/page.tsx` and `sessions/page.tsx`, were
  verified live).

## Open questions / contradictions found

None blocking. One minor note: `projects/resolve.ts`'s overlap check
(`project directory ownership overlaps between <a> and <b>`) only fires when at least one of the
two directories involved is *explicit* in the config; naming all three legacy demo projects'
directories explicitly (rather than leaving two to their implicit single-repository default) makes
that check active for all three pairs going forward, which seems like the more correct state, but
it is a behaviour difference from before worth the lead's awareness if the demo's project shapes
ever change.

Outcome: Done
Changed: packages/router/src/admin/sessions.ts; packages/router/src/admin/labs.ts;
packages/router/tests/project-admin-store-isolation.test.ts;
apps/panel/app/p/[slug]/jobs/page.tsx; apps/panel/app/p/[slug]/sessions/page.tsx;
apps/panel/scripts/seed-demo.mjs
Validation: `pnpm --filter meritrouter build` -> exit 0; `pnpm --filter meritrouter-panel
typecheck` -> clean; `pnpm --filter meritrouter-panel build` -> exit 0; `npx vitest run
tests/admin-session-project-scope.test.ts tests/admin-labs.test.ts
tests/project-admin-store-isolation.test.ts` -> 3 files, 41 tests, all passed; `pnpm --filter
meritrouter-panel seed:demo` -> completed to the end (previously crashed on the Labs fixture, now
fixed, confirmed by the config's tail tightening landing); `pnpm --filter meritrouter-panel
seed:demo:split` -> completed; production panel on port 4591 against the split demo, 6 routes
curled -> all 200, bodies inspected (`available` shows real empty states, `store-missing` shows
the unavailable notice on both jobs and sessions), stopped, port confirmed free; one desktop
screenshot of `/p/available/sessions` taken and inspected
Not verified: the full router test suite to completion (only the three named acceptance files,
plus an isolated, passing re-run of a flaky-under-load `supervisor.test.ts` case unrelated to the
touched files); MCP/CLI session-view callers exercised live; other `labsListView` panel callers
outside the two pages named in the brief
Report: docs/working/project-local-storage/reports/split-admin-reads.md
Notes: `labs/lab.ts`'s `validateRuntimeLocation` also requires a project's `directory` to already
exist on disk (not just be named in config) before a Lab is created there; the `mkdirSync` fix
for `project-demo` reflects that, discovered live rather than by reading `src/labs/**` (which I
did not edit, per the brief).
