# Worker report: zero-project installation must not crash

## Outcome

Done.

## What changed and why

**Root cause fix** (`packages/router/src/projects/registry.ts`): `ProjectRegistry.primary` used to
return `undefined` (via `?? this.list()[0]!`) when a split installation has no project yet, so
every caller crashed with "Cannot read properties of undefined (reading 'project')". It now
throws `MeritRouterError("no_project", "this installation has no project yet: create a project
first")`. This turns every remaining unguarded `sy.web` / `sy.brain` / `sy.brainAccess` getter
(`core/service.ts`, unchanged) into a clear, catchable error instead of a crash, and callers that
must not throw now guard explicitly.

**Reachable call sites fixed** (admin view layer, following the lead's existing
`cli/doctor.ts`/`admin/web-search.ts` pattern of `sy.layout === "split" && !sy.projects.slugs().length`):

- `packages/router/src/admin/live.ts`: the `brainHead` live-watch source (`external: true`, so it
  runs on **every** `/api/live` poll, for every page, in `all` scope) called `sy.brain.root`
  unconditionally. This was the most severe bug: it would crash the live-update stream behind
  nearly every panel page. Fixed to read project roots directly and only touch the (now safe)
  `sy.brain` fallback when a project already exists, preserving the existing "also watch the
  install-level brain root" behavior for installations that do have one (kept
  `admin-live.test.ts`'s "watches the install brain even when project brain roots differ" passing).
- `packages/router/src/admin/promotions.ts`: `globalKnowledge` (used by `/all/knowledge`) now
  returns an empty, well-formed result when there is no project yet, instead of touching
  `sy.brain`.
- `apps/panel/app/all/knowledge/page.tsx`: removed a direct `sy.projects.primary` read used to
  pick which live project's Brain page global files should link to; falls back to `null` (no
  viewer) when there is none.
- `apps/panel/app/all/settings/page.tsx` and `apps/panel/app/api/web-search/route.ts`: both called
  `sy.web.status()` directly (bypassing the already-guarded `insights.webSearchView`). Switched to
  `insights.webSearchView(sy, { recent: 0 }).status`, which degrades gracefully.
- `apps/panel/app/api/brain/memory/route.ts` (global scope, used by `/all/brain`'s client-side
  fetch): GET returns an empty page and POST throws a clear 400 ("create a project first: there is
  no Brain to save a global preference in yet") instead of touching `sy.brain.project`.
- `apps/panel/app/api/brain/access/[id]/route.ts`: guarded before `sy.brainAccess.get(id)` (there
  can be no pending request without a project, so this degrades to the same 404 it would give for
  an unknown id).
- `packages/router/src/admin/provider-keys.ts` (`updateProviderKey`), `packages/router/src/admin/web-search.ts`
  (`setSearchKeyEnabled`, `removeSearchKey`), `packages/router/src/cli/keys.ts` (`meritrouter keys
  enable`): all cleared cached web/search-key health via `sy.web.clear*` as a side effect of
  adding/enabling/removing a provider or search key — all reachable *before* a project exists (a
  user may add keys before creating their first project). Guarded with
  `sy.layout !== "split" || sy.projects.slugs().length` (a no-op is correct: there is nothing
  cached to forget yet).

**Reviewed and left unchanged** (not reachable with zero projects, or require an existing project
by construction, so the new `no_project` error is the correct outcome if ever hit):
`admin/project-reads.ts` (`ownedBy`, `projectIdFilter` — only called with an already-resolved,
existing project slug), `admin/projects.ts` (`summary`, `contextOfTask`, `deleteProject` — mapped
over existing projects or deleting one), `qualification/comparison.ts` (`planComparison`, `runOne`
— explicit user action that needs a project for supplied goals), `core/project-runtime-host.ts`
(`runtimeOf` — only hit for legacy unassigned-project rows, which cannot exist on a fresh split
install), `admin/insights.ts` (`brainOf`, `brainAccessRequests`, `decideBrainAccess` — every panel
caller always passes an explicit, already-validated project; MCP's `brain_access_requests` tool
likewise always has `project` bound).

## Commands run and observed results

- `npx vitest run tests/zero-project-installation.test.ts` -> 5 passed.
- `npx vitest run tests/project-cli-operations.test.ts tests/install-layout.test.ts tests/project-service-activation.test.ts tests/admin-promotions.test.ts` -> all passed (33 passed, 1 skipped).
- `npx vitest run tests/admin-brain-entities.test.ts tests/admin-budget-panel.test.ts tests/admin-job-navigation.test.ts tests/admin-keys.test.ts tests/admin-labs.test.ts tests/admin-live.test.ts tests/admin-plan-recovery.test.ts tests/admin-project-settings.test.ts tests/admin-promotions.test.ts tests/admin-request-evidence.test.ts tests/admin-session-project-scope.test.ts` -> all passed when run together; `admin-promotions.test.ts`'s slowest test (`lists promotions awaiting a person...`) intermittently times out / hits `ENOTEMPTY` on its temp brain directory when run concurrently with many other heavy test files (Windows filesystem + git contention) — confirmed pre-existing and unrelated to this change by running `admin-promotions.test.ts` alone twice, both green.
- `pnpm -r typecheck` -> both `packages/router` and `apps/panel` clean.
- `pnpm -r build` -> both packages build.
- Panel check: built the router and panel; created a temp split install (`storage.layout: split`, `projects: {}`) via `meritrouter setup --yes` in OS temp, edited its generated config to `panel.port: 4488` / `auto_start: false` before any process touched it (the user's live panel stayed on 4477, pid unchanged throughout — verified with `netstat` before and after); started `next start -H 127.0.0.1 -p 4488` directly (the `start` script hardcodes `-p 4477`, so it was not used) with `MERITROUTER_CONFIG` pointing at the temp install; curled every sidebar/top-level page and every `/all/**` page:
  - `/`, `/new`, `/all/knowledge`, `/all/brain`, `/all/calibration`, `/all/keys`, `/all/models`, `/all/qualification`, `/all/requests`, `/all/routing`, `/all/settings` -> all `200`.
  - `/brain`, `/jobs`, `/sessions`, `/tasks`, `/teams`, `/requests` -> `307` to `/` (expected `toLastProject` redirect with no project); `/paid` -> `308` to `/all/keys#paid`; all resolve to `200` with `curl -L`.
  - `/api/web-search` and `/api/brain/memory?scope=global` -> `200`.
  - Panel log showed no server errors for any of the above.
  - Stopped the panel with `POST /api/panel/stop` -> `{"ok":true,"stopped":true,...}`; confirmed with `netstat` that port 4488 has no LISTENING socket afterwards. Confirmed 4477 (the user's panel, same pid) was never touched. Deleted the temp install directory afterwards.

## Not verified

- MCP server tools end-to-end against a zero-project install (reviewed `mcp/tools.ts` source for
  unguarded `primary`/`brain`/`web`/`brainAccess` reads — found none reachable without an explicit,
  bound `project`; did not run the MCP test suite, which needs a `dist/` build the brief did not
  ask for).
- `admin/insights.ts`'s `brainOf`/`brainAccessRequests`/`decideBrainAccess` fallbacks (project
  omitted) are now safe in the sense that they throw a clear `no_project` error rather than
  crashing, but I did not add a dedicated regression test for that path since no reachable caller
  hits it with zero projects today; if a future caller adds an unguarded path, the `registry.ts`
  fix still protects it from a raw crash.
- Did not exercise `apps/panel/app/p/[slug]/**` project-scoped pages (out of scope: they require an
  existing project by their own routing, `findProject`/`notFound()`).

## Open questions or contradictions found

None blocking. One minor design note for the lead: `apps/panel/lib/api.ts`'s `handle()` maps
`MeritRouterError` codes to HTTP statuses and has no entry for `no_project` (falls through to
`500`). None of the panel's own reachable call sites raise it (I guarded every one I found with a
graceful degrade instead), so it currently only surfaces as a correctly-messaged `500` in a
defensive/unreached branch. `lib/api.ts` wasn't in this brief's owned paths, so I left it
unchanged; a follow-up could add `no_project` to the 400 bucket for a tidier status code if it
ever does surface.

## Return contract

```text
Outcome: Done
Changed: packages/router/src/projects/registry.ts, packages/router/src/admin/live.ts, packages/router/src/admin/promotions.ts, packages/router/src/admin/provider-keys.ts, packages/router/src/admin/web-search.ts, packages/router/src/cli/keys.ts, apps/panel/app/all/knowledge/page.tsx, apps/panel/app/all/settings/page.tsx, apps/panel/app/api/brain/access/[id]/route.ts, apps/panel/app/api/brain/memory/route.ts, apps/panel/app/api/web-search/route.ts, packages/router/tests/zero-project-installation.test.ts (new)
Validation: `npx vitest run tests/zero-project-installation.test.ts tests/project-cli-operations.test.ts tests/install-layout.test.ts tests/project-service-activation.test.ts tests/admin-*.test.ts` -> all pass (one slow admin-promotions test flakes under heavy parallel load from ENOTEMPTY/git contention on Windows temp dirs, confirmed pre-existing and unrelated by passing in isolation); `pnpm -r typecheck` -> clean; `pnpm -r build` -> clean; manual panel check on port 4488 against a temp zero-project split install -> every sidebar/top-level and /all/** page curled 200 (redirects followed), panel stopped via /api/panel/stop, port confirmed free, user's live panel on 4477 untouched throughout.
Not verified: MCP tools end-to-end (no dist build run; source review found no unguarded reachable path); apps/panel/lib/api.ts's no_project->500 fallback status mapping left as-is (out of owned paths, not currently reachable).
Report: docs/working/project-local-storage/reports/zero-project-installation.md
Notes: The most severe bug was admin/live.ts's brainHead source, which ran on every /api/live poll (every panel page) in "all" scope and called sy.brain unconditionally. The lead's existing doctor.ts/web-search.ts guard pattern (`sy.layout === "split" && !sy.projects.slugs().length`) was reused everywhere else. registry.ts's primary getter now throws a clear MeritRouterError instead of returning undefined, per the brief's preferred fix.
```
