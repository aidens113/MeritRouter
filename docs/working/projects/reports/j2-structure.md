# Report: j2-structure (projects plan, phase J2, step 1)

Worker report for the brief "j2-structure" in [projects.md](../../projects.md). Worktree
`D:/sy-wt/pj`, branch `feat/projects`. Nothing committed. Port 4477 was never used.

## Outcome

Done. The panel is project-based:
- `/` is the projects grid, and `/new` creates a project. On success it opens `/p/<slug>`.
- A project switcher sits at the top left.
- Per-project pages live under `/p/<slug>/`, and install-wide pages under `/all/`.
- The old URLs redirect.
- The demo seeds 3 projects.

Validation results:
- Typecheck, both builds, and the full router suite pass: 451 tests, which is the 449 baseline
  plus 2 new ones.
- 98 page and API checks against a production panel on :4597 behave as expected.
- Screenshots were taken and looked at, and the panel is stopped.

The global dashboard (`/all`) and the project settings page (`/p/<slug>/settings`) are simple
placeholders, as allowed. Everything else is real and wired.

## Route map (old to new)

| Old | New | How |
| --- | --- | --- |
| `/` (overview) | `/` = projects grid; the overview became `/p/<slug>` (project-scoped) | page |
| (none) | `/new` (create form), `POST /api/projects` | new |
| `/jobs`, `/teams`, `/tasks`, `/sessions`, `/requests`, `/brain` (+ query) | `/p/<last>/...` with the query kept, else `/` | 307, `app/<old>/page.tsx` via `lib/legacy.ts` (cookie `sy_project`, re-validated) |
| `/jobs/<id>`, `/tasks/<id>`, `/sessions/<id>` | `/p/<the item's own project>/...` | 307; 404 for an unknown id or an archived project |
| `/models`, `/models/detail?id=`, `/routing`, `/keys`, `/qualification`, `/calibration`, `/settings` | `/all/...` | 308, `next.config.ts` `redirects()` |
| `/paid` | `/all/keys#paid` | 308 (page) |
| (none) | `/all` = global dashboard (placeholder), `/all/requests` (every project, plus requests with no task) | new |
| (none) | `/p/<slug>/settings` (read-only placeholder) | new |

Per-project pages under `app/p/[slug]/`:
- overview, `jobs`, `jobs/[id]`, `teams`, `tasks`, `tasks/[id]`, `sessions`, `sessions/[id]`,
  `requests`, `brain`, and `settings`.
- `app/p/[slug]/layout.tsx` 404s an unknown, archived, or malformed slug. The pages call
  `project()` again; it 404s the same way.
- A detail page 404s a task or session of another project (`requireTaskIn`, `requireSessionIn`).
  Nothing in a project route falls back to "all projects".

Links:
- Shared components take a `base` (`/p/<slug>`). These are `RequestsTable`, `SessionsTable`,
  `PlanCard`, `TeamCard`, `MergeQueueCard`, `ChannelCard`, `JobMetricsCard`, `MetricsTable`,
  `VerificationTrail`, and `Markdown` (`linkBase`).
- Views that span projects link a task as `/tasks/<id>`, which resolves to the task's own project.
  These are calibration, and the request rows of `/all/requests` that have no project.

## URL decision for the global section

The install-wide pages live under **`/all/...`**, not at the top level.

Why:
- The URL tells the shell its scope without any lookup. `/p/<slug>` is a project, `/all` is "All
  projects", and the rest (`/`, `/new`) is home.
- Requests exist in both scopes (`/p/<slug>/requests` and `/all/requests`), so a top-level
  `/requests` would be ambiguous.
- The switcher's "All projects" entry and the `/all` prefix use the same name.

The rule is recorded in `apps/panel/lib/links.ts`, the header comment, and in
`apps/panel/README.md`. The supervisor should copy it into the working document's Decisions.

## Admin functions added or changed (router)

- `teamMetrics(sy, { limit, now, project? })` in `src/admin/job-metrics.ts`: a new optional
  `project`. The project Teams page needs it, because filtering after `LIMIT` would drop jobs.
- Bug fix in `src/qualification/comparison.ts` (`planComparison`). It checked goal repositories
  against the global `sy.cfg.repositoryPaths`, which is empty in the projects shape. The demo seed
  failed with "unknown repository core". Comparison runs are system work and land in the primary
  project, so the check now uses `sy.projects.primary.repositoryPaths`. The error names the
  project.
- New `tests/projects-panel-scope.test.ts` (2 tests) covers both changes. A mutation check
  reverted each change, and both tests failed. Both pass with the changes restored.

## What changed and why (panel)

New files:
- `lib/links.ts`: the URL scheme, link builders, `slugify`, and `SLUG_RE`.
  - `SLUG_RE` copies the router's `PROJECT_SLUG_RE` so the client can check a slug.
  - `lib/project.ts` warns at load if the two regexes differ.
- `lib/project.ts`: the `project(sy, slug)` helper, which 404s an unknown or archived project.
  Also `findProject`, `taskProject`, `sessionProject`, `requireTaskIn`, `requireSessionIn`,
  `lastProject` (cookie), and `switcherProjects`.
- `lib/legacy.ts`: the old-URL redirects.
- `components/client/project-switcher.tsx`: the switcher, a menu button. Details:
  - It shows the current project (or "All projects", or "SwitchYard / Projects" on the grid).
  - It lists every live project with an activity dot: green and pulsing when running, amber when
    queued, grey when idle. The reduced-motion setting turns the pulse off.
  - It links to "All projects", "Projects grid", and "New project".
  - Keyboard: Enter, Space, or ArrowDown opens it on the current project; arrows, Home, and End
    move; Escape closes and returns focus; Tab closes.
  - Clicking outside, or resizing the window, closes it.
  - The menu is `position: fixed` from the button's rect, so the scrolling sidebar does not clip
    it. My first build clipped it; the screenshot showed this, and I fixed it.
  - It refetches `GET /api/projects` each time it opens.
- `components/client/new-project.tsx`: the create form.
  - Fields: name; slug, derived from the name until you edit it; repository rows (alias, folder,
    writable); and optional brain mounts.
  - Server errors come back keyed by field (`fieldErrors["repositories.0.path"]`) and show inline
    with `aria-invalid` and `aria-describedby`.
- `components/requests-view.tsx`: the request log, shared by the project and global pages. The
  global page adds a Project column.
- `app/page.tsx` (grid): cards built from `insights.projectsGrid`.
  - Each card shows the name and slug, the repositories (with a "missing" badge), running and
    queued jobs and tasks, last activity, and an attention badge with the first item.
  - A "New project" tile.
  - A folded "Archived projects" list with Unarchive.
- `app/new/page.tsx`.
- `app/p/[slug]/layout.tsx`, `page.tsx` (project overview), and `settings/page.tsx`.
  - The overview uses `projectOverview`, `timeseries`, and `tierDistribution` scoped to the
    project. It shows attention items with action links, stats including paid spend, running and
    queued jobs, repositories, charts, and the worker with tasks by state.
- `app/all/page.tsx` (placeholder: totals and a per-project table from `globalDashboard`) and
  `app/all/requests/page.tsx`.
- API routes:
  - `app/api/projects/route.ts`: GET is the switcher list. POST is create, with a zod body; the
    router's `createProject` checks that each path exists and is a git repository; errors are
    mapped to fields.
  - `app/api/projects/[slug]/route.ts`: PATCH `{archived}`. Archiving is refused with 409 while
    the project has work.

Edited files:
- `app/layout.tsx`: passes the switcher list to `Shell`. It leaves the list empty for a signed-out
  visitor when `SWITCHYARD_PANEL_TOKEN` is set, because the layout also renders `/login`.
- `components/client/shell.tsx`: the switcher replaces the brand. Inside a project the sidebar
  shows the project nav; elsewhere it shows the global nav. The phone menu is anchored under the
  sticky top bar.
- `proxy.ts`: sets the `sy_project` cookie (`httpOnly`, `lax`, one year) on `/p/<slug>` requests
  that pass the sign-in gate.
- `next.config.ts`: the redirects.
- Moved pages: `app/p/[slug]/{jobs,teams,tasks,sessions,brain,requests}` and
  `app/all/{models,routing,keys,qualification,calibration,settings}`. They now pass the project
  to every insights call:
  - `jobsView(…, slug)`;
  - `listTasks(…, slug)`;
  - `sessionsView({project})`;
  - `teamMetrics({project})`;
  - `brainTree`, `brainRead`, `brainSearch`, `brainHistory`, `brainBlame`, and
    `brainAccessRequests` with the slug;
  - `sy.brainFor(slug)`;
  - the project's `team` and `supervisor` settings for limits;
  - the project's repositories for the new-job form.
- Brain page:
  - It lists `projects/<slug>/**`, `global/**`, and root files.
  - Search results are filtered the same way.
  - A path from another project shows a callout that links to that project's brain, instead of
    the document.
- Teams page: comparisons are install-wide records, so it shows those whose runs belong to the
  project. A comparison with no results yet shows only on the primary project.
- `/all/settings`: with the projects shape, the Repositories form is replaced by links to each
  project's settings.
- API routes take `project`:
  - Required for `POST /api/jobs` (the repositories are checked against the project) and for
    `PUT /api/brain`.
  - Optional for accept, reject, cancel, resume, question answers, brain access decisions,
    session resume, and `GET /api/sessions`. The router refuses another project's item.
  - `lib/api.ts` maps the router's `usage` code to 409.
- Client components pass the page's project:
  - `NewJobForm`;
  - `QuestionAnswer`;
  - `BrainEditor` and `AccessDecision`;
  - `AcceptanceActions`;
  - the `ActionButton` payloads.
- `/api/config` `expand()`: a missing `providers` section now starts from `{}`, not from the parsed
  `{request_timeout_seconds, byId}`. This is the P4 follow-up. It is not exercised by a request;
  see Not verified.
- `lib/format.ts` `modelHref` is now `/all/models/detail?id=`.
- `not-found.tsx` has new text.
- `apps/panel/README.md` describes the routes and the demo.
- `scripts/seed-demo.mjs`: 3 projects.
  - `demo`, "Calculator service": repositories `core` and `app` (a `web` fixture).
  - `storefront`: repository `app`, plus a `team.max_agents` override. It has 3 completed
    summaries, a queued job, a queued task, and a brain note.
  - `legacy-billing`: one completed task, archived at the end with `insights.archiveProject`.
  - Every `submitTasks`, `startJob`, and raw store submit names its project.

## Commands run and observed results

- `pnpm --filter switchyard-router build`: Done (run after each router edit).
- `pnpm -r typecheck`: "packages/router typecheck: Done", "apps/panel typecheck: Done".
- `cd packages/router && npx vitest run`: "Test Files 45 passed (45)", "Tests 451 passed (451)".
- `npx vitest run tests/projects-panel-scope.test.ts`: 2 passed. With both changes reverted, 2
  failed. Restored: 2 passed (`git diff` checked).
- `pnpm -r build`: "packages/router build: Done", "apps/panel build: Done". The build log has no
  "warn" or "error" lines.
- Seed:
  - The first run failed on the comparison bug above.
  - After the fix, `node scripts/seed-demo.mjs` exited 0 with no `warning:` lines (`grep -ic
    warn` = 0) and printed every phase.
  - The storefront and billing phases completed.
  - The final reseed after the panel tests also exited 0 with 0 warnings.
  - Afterwards I edited only a comment in the seed header (`node --check` OK). The seed was not
    run again after that edit.
- Production panel on :4597: `next start` against `.demo/switchyard.config.yaml`. The route
  script is `scratchpad/j2s/routes.mjs` (log `routes2.log`); it printed 98 `ok` lines and "all
  as expected".
  - 200 for:
    - every project page of demo and storefront, with real job, task, and session ids, the brain
      views, and the settings page;
    - every `/all` page, including the settings tabs;
    - `/`, `/new`, and `/login`.
  - 404 for:
    - `/p/nope` and `/p/nope/jobs`;
    - `/p/legacy-billing` and its subpages (archived);
    - `/p/Bad_Slug`;
    - another project's task, job, or session under storefront;
    - an unknown task id;
    - `/tasks/<archived project's task>`.
  - 307:
    - `/jobs` → `/` with no cookie, and → `/p/storefront/jobs` with the cookie;
    - `/tasks?state=active` keeps its query;
    - `/teams`, `/sessions`, `/brain?path=…`, and `/requests` go to the cookie's project;
    - a cookie naming an archived or unknown project → `/`;
    - `/jobs/<id>`, `/tasks/<id>`, and `/sessions/<id>` → the item's own project.
  - 308: `/models`, `/models/detail?id=x`, `/routing`, `/keys`, `/qualification`,
    `/calibration`, and `/settings` → `/all/...`; `/paid` → `/all/keys#paid`.
  - APIs:
    - `GET /api/projects` returns only live projects, with `queued` and `attention`.
    - `POST /api/projects` with an empty name and a bad slug → 400 with `fieldErrors.name` and
      `fieldErrors.slug`.
    - A missing folder → 400 with `repositories.0.path`.
    - A duplicate slug → 400 with `slug`.
    - `PATCH /api/projects/demo {archived:true}` → 409 ("0 running and 2 queued").
    - An unknown project → 404.
    - Cancelling a demo task with `project: storefront` → 400 ("belongs to project demo").
    - `POST /api/jobs` to the archived project → 404; with another project's alias → 400.
    - `PUT /api/brain` to an unknown project → 404.
    - The GET routes for plan, team, channel, metrics, comparisons, keys, and sessions → 200.
    - Five routes that are POST-only answer GET with 405 (expected).
- Writes I exercised in an earlier run, before the final reseed:
  - The create flow in Chrome made `docs-site` (repository `web`). The page went to
    `/p/docs-site`, the switcher listed it, and the config gained `projects.docs-site` and
    `brain/projects/docs-site`.
  - `PATCH {archived:true}` on it, then `/p/docs-site` → 404, and the switcher dropped it.
  - `PUT /api/brain` for storefront committed `projects/storefront/facts/shipping.md`.
  - `POST /api/jobs` for storefront queued a job in `storefront`. I checked this in SQLite.
  - The demo was reseeded afterwards to remove these.
- Sign-in gate: I restarted with `SWITCHYARD_PANEL_TOKEN`.
  - Signed out: `/login` contains no project names, `/p/demo` → 307 `/login?next=%2Fp%2Fdemo`,
    and `/api/projects` → 401.
  - Signed in (session cookie): the pages render, and `sy_project` is set.
- Panel stopped: no listener on 4597, and no Chrome left on debug port 9337. The four panel
  logs (`scratchpad/j2s/panel*.log`) contain no "error" or "warn" lines.
- `git diff --check`: clean. No CRLF in any changed or new file.

Screenshots (headless Chrome through the DevTools protocol; `scratchpad/j2s/shots.mjs` and
`shots2.mjs`), all in
`C:\Users\mrjoh\AppData\Local\Temp\claude\d--SwitchYardRouter\f513290c-d4c1-4d44-81c0-be35d4674ab1\scratchpad\j2s\shots\`.
I looked at every one.

| File | Shows |
| --- | --- |
| `01-grid.png` | The grid (light) |
| `02-grid-dark.png` | The grid (dark) |
| `03-project-overview.png` | The demo project's overview |
| `04-project-jobs.png` | The demo project's jobs |
| `05-storefront-overview.png` | The storefront overview: its queued job and requests |
| `06-switcher-open-keyboard.png` | The switcher opened with ArrowDown, focus on Storefront (final build: not clipped) |
| `07-all-dashboard.png` | The `/all` placeholder |
| `08-all-requests.png` | Every project's requests, with the Project column |
| `09-new-project-errors.png` | The create form with inline errors: taken slug, missing folder |
| `10-phone-shell.png` | The shell at 600 px |
| `11-phone-menu.png` | The phone menu |
| `12-phone-switcher.png` | The switcher at 600 px |
| `13-phone-grid.png` | The grid at 600 px; horizontal overflow measured 0 |
| `14-switcher-open-mouse.png` | The switcher opened with the mouse; the aside's horizontal overflow is 0 |
| `15-switcher-keyboard-focus.png` | Keyboard focus in the switcher; Enter navigated to `/p/storefront` |
| `16-project-brain.png` | The project brain |
| `17-grid-archived-open.png` | The grid with the archived list open, and Unarchive |
| `18-new-project-filled.png` | The create form filled in |
| `19-created-project-overview.png` | The new project's overview after creating it |
| `20-switcher-with-new-project.png` | The switcher listing the new project |

Shots 14 to 20 come from the build before the final reseed, so they include `docs-site`.

## Not verified

- **The `/api/config` `expand()` fix.** No request ran against a YAML without a `providers:`
  section; the demo config has one. The change is small: a missing `providers` ancestor starts
  from `{}`.
- **Unarchive and the grid's archived list.** Unarchive was not clicked in the browser. The
  archive half was exercised through the API; the unarchive half only through the router's own
  tests.
- **No network calls during the seed.** Not proven by a network monitor. The seed's providers and
  enrichment URLs all point at 127.0.0.1:9 as before, and I added no URLs.
- **Live activity dots.** No worker was running, so a running project's green pulsing dot was not
  seen. Only amber (queued) and grey (idle) were.
- **Screen readers.** No testing beyond the ARIA roles and attributes. The switcher uses
  `role=menu` and `menuitem`, `aria-haspopup`, `aria-expanded`, and `aria-current`.
- **Partial checks.**
  - Dark mode was screenshotted only for the grid.
  - The CRLF scan covered the changed files, not the whole tree.
  - The dev server (`next dev`) was not run; only production builds.
- **Brain page, partly.** History, Blame, and Edit for a project document, and the
  access-decision buttons, were rendered (200) but not clicked.
- **A legacy single-project config.** Not tried in the panel. `globalSettings.multiProject` is
  false then, and the Repositories form stays on `/all/settings`.

## Open questions or contradictions found

1. **A bug outside the brief.** `planComparison` used the global `cfg.repositoryPaths`, a J1
   leftover. I fixed it, with a test, because the seed could not run without it. Other code that
   reads `sy.cfg.repositoryPaths` directly (not through a `ProjectContext`) may have the same
   problem. A grep shows `qualification/registry.ts`, which deliberately adds fixture
   repositories to the global cfg. I did not audit it.
2. **The brain page does not use a per-project index.** The root `README.md` index lists every
   project's working documents and still appears on each project's brain page. This is the
   "per-project brain index" carried into J2/J3. I filtered the tree and search to the project,
   `global/`, and root files instead. I did not build an index per project.
3. **The cookie is set for unknown slugs.** `sy_project` is set for any well-formed `/p/<slug>`,
   including ones that then 404. It is re-validated before use, so the only effect is that a
   later `/jobs` goes to `/`.
4. **Where system work shows up.** System tasks (audits, comparisons) appear in the primary
   project's lists, because the router puts them there. The Teams page shows a comparison under
   the project its runs belong to. j2-global may want a global view of comparisons.
5. **Project selection for writes.** The panel APIs take `project` from the request body.
   `POST /api/jobs` and `PUT /api/brain` require it; the guard routes accept it as optional and
   every panel page sends it. If the supervisor wants it required everywhere, the remaining
   routes need a one-line change each.
