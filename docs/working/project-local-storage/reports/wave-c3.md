# Gate 1 wave C3: panel support for split project storage (worker report)

Worker: wave-c3 (worker, Sonnet 5). Date: 2026-10-27. Branch dev, main checkout. I made no commits
and created no worktrees (git state is for the lead to commit). Paths below are relative to
`apps/panel` unless stated otherwise.

## Outcome

Done.

## What changed and why

**`app/new/page.tsx`**: reads `r.sy.layout === "split"` (no new read needed — `MeritRouter.layout`
is already a public field) and passes it to the form as `split`.

**`components/client/new-project.tsx`**: a `directory` field, shown only when `split`, with help
text "MeritRouter keeps this project's data in `<directory>/.MeritRouter`, separate from every
other project's." `fieldErrors.directory` renders under it exactly like every other field (no
special-casing needed: `directory` is not a row-indexed key like `repositories.N`, so the existing
error-mapping path already handles it). The API route (`app/api/projects/route.ts`) already
accepted `directory` from wave B2b; unchanged.

**`packages/router/src/admin/insights.ts`** (the one allowed router export): added
`export { unavailableProjectStores, type ProjectStoreUnavailable } from "./project-reads.js";`.
`project-reads.ts` was not previously re-exported through the `insights` barrel; views that read a
single project's store directly (sessions) need this to report "unavailable" rather than silence.

**Unavailable-store notices**, all `apps/panel`:

- `app/page.tsx` (projects grid): `projectsGrid`'s existing `attentionItems` already contains a
  store-unavailable sentence (wave A/B work). Added `STORE_ISSUE_RE` to detect it and render a
  distinct `tone="bad"` "store unavailable" badge plus the full (non-clamped) message, instead of
  folding it into the generic "N need you" badge.
- `app/p/[slug]/jobs/page.tsx`: `insights.jobsView(...)` returns `RowsWithAvailability`; added a
  `Callout tone="bad"` when `jobs.unavailable.length`, naming the reason and the next step.
  **Also fixed a real crash found during validation**: `insights.labsListView(sy, p.slug)` throws
  `ProjectStoreUnavailableError` (uncaught) for an unavailable store, which crashed this page with
  an HTTP 500 before my own notice could render. Now skipped (`labs = []`) whenever
  `jobs.unavailable.length`, since `labsListView` cannot read that project's store either.
- `app/p/[slug]/sessions/page.tsx`: `sessionsView` silently returns `[]` for an unavailable store
  (no marker), so it separately calls `insights.unavailableProjectStores(sy, p.slug)`. **Also
  fixed a second real crash found during validation** (see below): `sessionsView`'s per-project
  branch can throw even for a perfectly healthy project's store, crashing the page with a 500. All
  four `sessionsView` calls on this page are now wrapped in a `safeSessionsView` helper that
  catches and falls back to `[]`, and the notice fires on either cause (store unavailable, or the
  read itself failing), both worded the same way for the reader.

**`apps/panel/scripts/seed-demo.mjs`**: added a `--split` branch (`buildSplitLayoutDemo`), gated so
the existing legacy demo is unaffected without the flag. Builds `apps/panel/.demo-split/` with
`storage.layout: "split"` and two real projects created through `insights.createProject`: `available`
(healthy) and `store-missing` (its `state/meritrouter.db` is deleted right after creation, to
produce a genuine "store unavailable" marker). No scripted task/job history — kept small. The
installation (config + coordination store) lives in `.demo-split/install/`, with the projects as
siblings in `.demo-split/projects/` (store-provisioning refuses a project directory that overlaps
the installation directory, so they cannot be nested). `profiles: {}` is required explicitly
(the schema has no default for it). `apps/panel/package.json` gained
`"seed:demo:split": "node scripts/seed-demo.mjs --split"`.

## Commands run and observed results

- `pnpm --filter meritrouter build` -> exit 0, clean (run twice: before and after the `insights.ts`
  change).
- `pnpm --filter meritrouter-panel typecheck` -> clean, no errors (run three times across the
  session as edits landed).
- `pnpm --filter meritrouter-panel build` -> exit 0, full route manifest printed (run twice; the
  second time after the two page-level crash fixes).
- `pnpm --filter meritrouter-panel seed:demo`: the PID I had started before this follow-up
  (36156, started 17:33) finished on its own (exit code 0 at the process level; the `pnpm` wrapper
  itself exited 1 — see **Pre-existing defect found** below) at 17:41, after writing most of its
  scripted history. `apps/panel/.demo/meritrouter.config.yaml` and
  `apps/panel/.demo/.meritrouter/meritrouter.db` (7.8 MB) exist and are usable; the legacy-billing
  project was never archived and the final config tightening (`security.outside_repository`,
  `verification.audit_sample_rate`) never ran, because the script crashed before reaching them.
  This did not block my validation of the panel pages.
- `pnpm --filter meritrouter-panel seed:demo:split`: failed twice before succeeding, both fixed in
  `seed-demo.mjs` (see "What changed and why"): first a Zod error ("profiles: Invalid input:
  expected record, received undefined" — `profiles` has no schema default), then a project-store
  overlap refusal ("project directory ... overlaps the installation directory ..." — my first
  version put `projects/` under the same folder as the config file). Third run: succeeded, printed
  `Split-layout demo ready at D:\MeritRouter\apps\panel\.demo-split.` Verified on disk:
  `available/.MeritRouter/state/meritrouter.db` exists; `store-missing/.MeritRouter/state/` is
  empty.
- Production panel against the legacy demo, port 4580: `npx next start -H 127.0.0.1 -p 4580`
  (`MERITROUTER_CONFIG=.demo/meritrouter.config.yaml`) -> "✓ Ready in 736ms". Curled
  `/ /new /p/demo/jobs /p/demo/sessions /p/storefront/jobs /p/storefront/sessions` -> all HTTP 200.
  Stopped (killed the process owning the port); confirmed `netstat` shows no LISTENING entry on
  4580 afterward (TIME_WAIT only, from the curls).
- Production panel against the split demo, port 4581, first run (before the two page fixes):
  curled the same route shapes against `available`/`store-missing` ->
  `/p/available/sessions` and `/p/store-missing/jobs` both returned HTTP 500 (both logged to the
  panel's stdout; see **Pre-existing defects found**). Stopped the panel, rebuilt the panel with
  the fixes, restarted on 4581: all of `/ /new /p/available/jobs /p/available/sessions
  /p/store-missing/jobs /p/store-missing/sessions` -> HTTP 200, no server-side errors logged.
  Stopped; confirmed `netstat` shows no LISTENING entry on 4581 or 4580.
- Headless Chrome screenshots (desktop 1400px, mobile 390px), all inspected directly (not just
  captured): see **Screenshots** below.
- Confirmed ports 4580, 4581, and the Chrome CDP debug port 9333 are all free after cleanup
  (`Get-NetTCPConnection` shows nothing listening on any of them).

## Pre-existing defects found during validation (not fixed — outside my owned paths)

These are real, reproducible crashes in `packages/router/src/**`, found while validating my panel
changes against the split demo. I did not touch these files (outside my brief's "Must not touch"),
but I did defensively guard my own panel pages against them (see above), so the panel itself no
longer crashes — it shows a clear notice instead. The underlying router-level bugs still need
fixing by whoever owns those files:

1. **`admin/sessions.ts`'s `sessionsView` crashes for a *healthy* split project, not just an
   unavailable one.** Its per-project branch still calls `sy.sessions.list(...)` (the
   *installation-level* `SessionStore`, built on the coordination db in split layout)
   unconditionally, before filtering down to the named project. In split layout,
   `ProjectEvidenceScope.assert()` (`src/storage/project-evidence-scope.ts:18`) now refuses any
   read from a store whose identity role is `"coordination"`, throwing `"Private evidence requires
   an explicit project store"`. This means **no split-layout project's sessions page can ever show
   sessions** through this code path, healthy store or not. Reproduced live:
   `GET /p/available/sessions` (a project with a perfectly good store) returned HTTP 500 with this
   exact stack before my panel-side fix; now the panel shows a "cannot be read right now
   (read_failed)" notice instead of crashing, but the underlying data still is not read. Wave A's
   report (`reports/wave-a.md`) lists `sessions.ts` among the files "Converted to per-project
   reads", so this looks like an incomplete conversion rather than new breakage.
2. **`admin/labs.ts`'s `labsListView` throws uncaught for an unavailable store** (via
   `requireProjectStores`), unlike `jobsView`/`teamMetrics`/etc., which return
   `RowsWithAvailability` instead of throwing. That is likely intentional for `labsListView`'s own
   single-project contract, but my jobs page called it unconditionally and crashed as a result —
   fixed on my side by skipping the call when `jobs.unavailable.length`.

I recommend the lead route a follow-up fix for #1 to whoever owns `packages/router/src/admin/`
(likely the same workstream that did wave A's admin conversion), since it affects every
split-layout project's Sessions page, not an edge case.

## Screenshots

All under the OS temp scratch dir:
`C:\Users\mrjoh\AppData\Local\Temp\claude\d--MeritRouter\0378a7ee-52d2-4bc1-adb7-aa4d2ad7f466\scratchpad\shots\`

Legacy demo (port 4580, baseline — confirms nothing regressed for a legacy installation):

- `legacy-new-desktop.png` / `legacy-new-mobile.png`: `/new` with no `directory` field at all
  (correct — the field is `split`-only). Mobile: the page's existing description/mono-path text
  overflows the 390px viewport horizontally; this predates my change (I did not touch
  `PageHeader` or its container) and is visible on every page at this width, not just mine (see
  below).
- `legacy-grid-desktop.png`: all three legacy projects show the plain "N need you" warn badge, no
  "store unavailable" badge — confirms the new badge logic correctly does not fire for legacy.
  (Aside: "Legacy billing" shows as live, not archived, because the legacy seed script crashed
  before reaching `archiveProject` — a side effect of the pre-existing Labs bug below, not a panel
  issue.)
- `legacy-jobs-desktop.png`: a healthy legacy project's jobs page, no unavailable-store callout.

Split demo (port 4581 — the directory field and unavailable-store notices):

- `split-new-empty-desktop.png` / `split-new-empty-mobile.png`: the Directory field renders
  between Slug and Repositories, with the help text "MeritRouter keeps this project's data in
  `<directory>/.MeritRouter`, separate from every other project's." Same pre-existing mobile
  horizontal-overflow pattern as the legacy page (not new).
- `split-new-error-desktop.png` / `split-new-error-mobile.png`: driven live with headless Chrome
  over the DevTools protocol (filled Name + a repository path, left Directory empty, clicked
  Create project). Server returned `fieldErrors.directory`; the Directory field shows a red border
  and the exact server message ("enter the project's folder; this installation keeps each
  project's private data in `<directory>/.MeritRouter`") beneath it, plus the page-level "Check the
  highlighted fields." banner. Renders correctly at both widths.
- `split-grid-desktop.png` / `split-grid-mobile.png`: three projects, two different unavailable
  reasons shown side by side — `default` (the implicit primary project of a fresh split install
  with zero configured projects) shows "store unavailable" with "Project default has no store yet;
  create it with its directory (meritrouter projects create default <directory>)."; `store-missing`
  shows "Project store-missing's store is unavailable (store_unavailable); its tasks cannot be
  read."; `available` shows neither, just its normal zero-activity state. Mobile: the grid's cards
  overflow past 390px (pre-existing — the `<ul>` has no explicit `grid-cols-1` before the `sm:`
  breakpoint; not something I introduced or was asked to fix, but worth the lead's attention since
  it affects the projects grid specifically, not just incidental page text).
- `split-jobs-unavailable-desktop.png` / `-mobile.png`: `/p/store-missing/jobs` — the red callout
  "This project's jobs cannot be read right now (store_unavailable)" renders above an otherwise
  normal (empty) jobs list; HTTP 200, no crash.
- `split-sessions-unavailable-desktop.png`: `/p/store-missing/sessions` — the same style of
  callout, "(store_unavailable)".
- `split-sessions-available-desktop.png`: `/p/available/sessions` — a *healthy* project still
  shows the callout, worded "(read_failed)", because of defect #1 above; this is the panel
  correctly refusing to claim "0 sessions" when it actually could not read them, not a false
  positive on my part.

## Not verified

- The pre-existing router defects above (sessions.ts's split-layout crash, labs.ts's throw-vs-return
  contract) — reported, not fixed; outside my owned paths.
- POSIX behaviour (Windows only, per environment).
- The teams page, tasks page, and other admin views beyond the three named in the brief
  (projects grid, job list, session list) were not checked for the same "throws instead of
  reporting unavailable" pattern; `teamMetrics`/`jobMetrics` likely share code with `jobsView`
  (`fanOutProjects`/`withAvailability`) and so are probably fine, but I did not load them against
  `store-missing` to confirm.
- Full content/visual review of every other panel page; I only looked at the pages the brief named
  plus the two I had to fix to keep them from crashing.
- The legacy demo's incomplete tail (missing fixture Labs, unarchived legacy-billing project, config
  not tightened to `security.outside_repository: human_only`) — not re-run to completion, since
  that failure is the pre-existing Labs bug (`"A project directory is required before creating
  project-local Labs"` for a legacy project with no `projects.<slug>.directory`, from
  `packages/router/src/labs/lab.ts:367`, committed in `5cb43f9`), not something in my scope, and
  not blocking for what I needed to validate.

## Open questions for the lead

1. Please route the two `packages/router/src/admin/sessions.ts` / `src/labs/lab.ts` defects above
   to whoever owns those files. The `sessions.ts` one in particular silently defeats the Sessions
   page for every split-layout project today (no crash now that I've guarded the panel side, but
   no real data either).
2. The projects-grid mobile card overflow at 390px is pre-existing (the `<ul>` in `app/page.tsx`
   has no `grid-cols-1` before `sm:grid-cols-2`); I left it alone since it's unrelated to my brief,
   but it is visible in `split-grid-mobile.png`.

Outcome: Done
Changed: apps/panel/app/new/page.tsx; apps/panel/components/client/new-project.tsx;
apps/panel/app/page.tsx; apps/panel/app/p/[slug]/jobs/page.tsx;
apps/panel/app/p/[slug]/sessions/page.tsx; apps/panel/scripts/seed-demo.mjs;
apps/panel/package.json; packages/router/src/admin/insights.ts
Validation: `pnpm --filter meritrouter build` -> exit 0; `pnpm --filter meritrouter-panel typecheck`
-> clean; `pnpm --filter meritrouter-panel build` -> exit 0; `pnpm --filter meritrouter-panel
seed:demo` -> completed (with a pre-existing, unrelated Labs-creation crash near the end — demo
still usable); `pnpm --filter meritrouter-panel seed:demo:split` -> completed after two fixes to my
own script; production panel on port 4580 against the legacy config, 6 routes curled -> all 200,
stopped, port confirmed free; production panel on port 4581 against the split config, 6 routes
curled -> 2×500 before my crash fixes, all 200 after, stopped, port confirmed free; 13 headless-
Chrome screenshots (desktop 1400px + mobile 390px) taken and inspected, including one interactive
form-submission flow driven live over the Chrome DevTools Protocol
Not verified: the two reported pre-existing router defects (not fixed, outside my owned paths);
POSIX; teams/tasks pages and other admin views beyond the three named in the brief; the legacy
demo's incomplete tail
Report: docs/working/project-local-storage/reports/wave-c3.md
Notes: Two real page-crash bugs were found and fixed on the panel side during validation (not just
the planned directory-field and notice work) — see "Pre-existing defects found". Screenshots are in
the OS temp scratch dir listed above, not in the repo.
