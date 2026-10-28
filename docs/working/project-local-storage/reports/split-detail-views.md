# Split detail views: by-id panel pages, API routes and request views (worker report)

Worker: split-detail-views (worker-heavy, Opus 5.5). Date: 2026-10-28. Branch dev, main checkout.
No commits, no worktrees, no dist or panel rebuild, no panel or worker started or stopped.

## Outcome

Done. All by-id admin views, panel pages and id-taking API routes read the owning project's
store in a split installation. In a legacy installation every project's store is `sy.db`, so
behaviour there is unchanged.

## Cause

`/p/<slug>/jobs/<id>` returned "not found" before any view ran. `requireTaskIn` →
`taskProject` → `sy.tasks.get(id)` read the installation store. In a split installation that is
the coordination store, which holds no project tasks.

A probe test (two split projects, a fake-provider task in `beta`) showed that further by-id
paths were wrong in the same way:

**Returned nothing or the wrong result**

- `taskDetail`: returned null.
- `contextOfTask`: fell back to the primary project.
- `requestLog`: `taskRefs` came back empty, because the lookup went through `sy.tasks`.
- `taskRelated`: ancestor labels came back null.
- `jobBudget`: read config through `sy.tasks` and used the coordination store's admission.
- `taskWebRequests`: read only the primary project's ledger.
- `labs.ts`: used `sy.labs` rather than the project's own manager.

**Threw "Private evidence requires an explicit project store"**

- `artifactText`
- `requestDetail`, via `requestCapture` → `sy.gate.captures`. This is the user's broken
  request page.
- `sessionRequests`
- `planRecovery`, via `sy.sessions`.
- The `sy.sessions` fallbacks in `entities.ts`.

**Lead's follow-up:** `request-evidence.ts` built the journal path from `sy.cfg.storageDir`.
It now uses the owning store's `SessionStore.logPathFor`. I built on the CLI worker's
`session-project-scope.ts` and did not edit it.

## What changed

### Router (`packages/router/src/admin/`)

**`project-reads.ts`**

- New `AmbiguousProjectIdError` (code `ambiguous_id`).
- `locateProjectTask`, `locateTask`, `locateSession` and `locateRequest` now collect every match
  when no project is given, and refuse an id that two projects hold. `locateRequest` now shares
  `locate`.
- New `legacyStores(sy)`: the installation's stores in a legacy installation, null in a split
  one. All fallbacks to `sy.sessions`, `sy.tasks` and `sy.artifacts` go through it, so a split
  installation never reads the coordination store for private rows.
- New `admissionOf(sy, stores)`: request totals over a project's own store.

**`projects.ts`**

- `contextOfTask(sy, id, project?)` now locates the task in its own project's store.
- New `taskOwner(sy, id, project?)` and `sessionOwner(sy, id, project?)`. A legacy session with
  `project_id ''` still resolves through its task.

**`insights.ts`**

- `requestRowOf` reads `taskRefs` from the store the row came from.
- `taskDetail(sy, id, project?)` reads contract, events, artifacts, status, requests and trail
  from the owning store. Its trail uses that store's sessions and admission.
- `decideTaskAcceptance` locates the task in its project store and names the owner to the
  service.
- `artifactText(sy, ref, max, project?)` reads from the owning store, and refuses an ambiguous id
  when no project is given.
- Re-exports `workerActionScope`.

**`entities.ts`**

- `taskRelated(sy, id, project?)` walks ancestors and labels in the owning store.
- `sessionRequests(sy, id, project?)` uses `locateSession`.
- `sessionRequestIds`, `agentDetail` and `modelUsage` no longer fall back to `sy.sessions` in a
  split installation.

**Other files**

- **`budget.ts`:**
  - `cfgOf` resolves the owning project through its store.
  - `jobBudget` and `taskBudget` take `project?`.
  - `jobBudget` uses `admissionOf`.
  - `decideBudgetRequest` matches each store on its own project's rows and refuses an id that
    two projects hold.
  - `''` labels come from `legacyStores` only.
- **`plan-recovery.ts`:** `planRecovery(sy, jobId, project?)` reads plan, job, sessions and
  context from the owning store.
- **`request-capture.ts`:** reads captures with `RequestCaptures` over the request's own store.
  When that store is `sy.db` (legacy), it keeps `sy.gate.captures`.
- **`request-evidence.ts`:** journals come from the project's `SessionStore.logPathFor`.
- **`web-search.ts`:** in a split installation, `taskWebRequests(sy, id, project?)` reads
  `web_requests` from the owning store, validated with zod. A legacy installation keeps
  `sy.web.ledger`.
- **`labs.ts`:** `sy.labs` → `sy.labsFor(project)`. This is the installation manager in a legacy
  installation.
- **`worker-actions.ts`:** new `workerActionScope(sy, project)`. It returns the project store's
  db, plus the project context in a split installation (needed by `projectToolIdentity`) or
  `sy.cfg` in a legacy one.

### Panel (`apps/panel/`)

**Ownership helpers**

- `lib/project.ts`:
  - `taskProject` and `sessionProject` now use `insights.taskOwner` and
    `insights.sessionOwner`.
  - `requireTaskIn` and `requireSessionIn` search only the route's project.
- `lib/qualification.ts`: the session check reads the qualification store.

**Pages and components**

- **Job page (`p/[slug]/jobs/[id]`):** every view now gets `p.slug`, including `sessionsView`,
  `getStatus`, `contextOfTask` and `planRecovery`. The spec comes from
  `sy.projectStores(slug).tasks`, worker actions come from the project store's db, and the
  artifact viewers get the project. I also fixed `p` shadowing in two `patchRefs.map` callbacks.
- **Task detail** (`components/task-detail.tsx`): scoped to `scope.project`. That covers
  `taskDetail`, `taskRelated`, `sessionsView`, `taskBudget`, worker actions, `taskWebRequests`,
  and the artifact viewers, including the verification trail's.
- **Session detail** (`components/session-detail.tsx`): `sessionRequests` is scoped, and the task
  state comes from the project store.
- `components/requests-view.tsx` (job filter), `p/[slug]/teams` (`jobMetrics`) and
  `all/page.tsx` (questions use `q.project`) are now scoped too.
- `components/client/artifact-viewer.tsx`: new optional `project` prop. The viewer sends
  `&project=`.

**API routes**

- `lib/api.ts`:
  - New `projectParam(sy, params)`, which handles an optional `?project=` and returns 404 for an
    unknown project.
  - `ambiguous_id` maps to 409.
  - `project_store_unavailable` maps to 503.
- These routes now take an optional `?project=`: `api/artifacts`, `api/jobs/[id]/{channel,
  metrics,plan,team}` and `api/sessions/[id]`. Without it, the id is looked up across all
  project stores and an ambiguous id is refused.
- These routes now resolve the owner through project stores rather than `sy.sessions`, `sy.tasks`
  or `sy.db`: `api/tasks/resume`, `api/sessions/[id]/resume`, `api/worker-actions/[id]` (which
  also uses `workerActionScope`) and `api/brain/memory-preview`.

**Checked and needed no change.** These routes already pass the project to service methods that
route by `stores.ofTask`/`ofQuestion(project)`:

- accept, reject, cancel
- `api/jobs/questions`
- `api/budget/requests/[id]`

`/all/requests` and `/p/<slug>/requests` use `requestLog`/`requestLogCount`, which already fan
out over project stores. Their remaining defect was the `taskRefs` labels, fixed above.

## Commands run and observed results

**Typecheck**

- `npx tsc --noEmit -p tsconfig.json` (router): exit 0, no output.

**New test: `npx vitest run tests/split-detail-views.test.ts`**

5 of 5 passed (about 35 s). The cases are:

1. Every view resolves:
   - ownership, `contextOfTask`
   - `jobDetail`, `jobPlan`, `jobTeam`, `jobMetrics`, `jobChannel`
   - `jobBudget`, `taskBudget`, `budgetRequestsView`
   - `deliveryView`, `planRecovery`, `taskRelated`
   - `requestLog` and its count, including `taskRefs`
   - `taskDetail`, `taskWebRequests`
   - `artifactText`, with and without a project
   - `sessionRequests`
   - `requestDetail`, including capture and evidence with one exchange
2. A wrong-project slug (`alpha`) is refused by all of them.
3. Mutations land in beta's store, and `alpha` is refused:
   - reject
   - budget decide (expires, because the task finished)
   - answer
   - cancel
   - worker-action scope

   The coordination store row count stays 0.
4. An id held by two projects is refused unless the project is named.
5. Requests appear in `modelUsage`, `timeseries`, `projectOverview` and `globalDashboard`.

**Acceptance suites**

`npx vitest run tests/admin-*.test.ts tests/projects*.test.ts tests/split-cli-reads.test.ts
tests/project-admin-store-isolation.test.ts tests/zero-project-installation.test.ts
tests/split-detail-views.test.ts` ran 24 files: 21 passed, 3 failed, 5 tests failed in all. All
five were 30 s timeouts or 10 s hook timeouts, in:

- `admin-promotions`: three brain-git tests, with ENOTEMPTY/EBUSY on cleanup.
- `projects-followups`: one.
- `projects.test`: one hook timeout.

Rerunning those three files alone passed 3 of 3 files, 20 of 20 tests. I read the failures as
load-related: 24 files ran in parallel while the pilot worker was live, and none of the three
files touches code I changed.

**Other tests that use the changed functions**

| Batch | Files | Result |
| --- | --- | --- |
| 1 | budget-control, native-search, session-surface, verification-surface, web, qualification-split-store, team-metrics, team-surface, client-supervision, delivery-attention-report, lab-config-guard, project-entrypoint-isolation | 12 of 12 files, 112 tests passed |
| 2 | qualification, sessions, task-lab-validation, mcp-lifecycle-v2, verification-calibration, project-cli-operations, project-runtime-activation, brain-catalog | 7 of 8 files passed. `verification-calibration` hit a hook timeout; rerun alone it passed 8 of 8. |

**Panel typecheck**

- `pnpm --filter meritrouter-panel typecheck` failed. Its errors are the expected ones from the
  stale `packages/router/dist` declarations, which I was told not to rebuild: the new
  `taskOwner`, `sessionOwner` and `workerActionScope` exports are missing, and calls with the new
  optional third argument fail with "Expected 2 arguments, but got 3".
- To check the panel anyway, I ran `npx tsc --noEmit -p <scratchpad>/sdv-panel-tc/tsconfig.json`.
  That config is a temporary one in the session scratchpad, not in the repo. It extends the
  panel's config and maps `meritrouter` to `packages/router/src/index.ts`. Result: 0 errors in
  panel files. The 61 errors it reports are all in router files I did not touch: harness
  command-process, labs browser, coding process and git-process-policy. They come from compiling
  router source under Next's `ProcessEnv` and child_process typings.

## Not verified

- **Panel not built, run or screenshotted**, as instructed. The lead needs to rebuild `dist` and
  the panel, then rerun `pnpm --filter meritrouter-panel typecheck` and open
  `/p/<slug>/jobs/<id>`, tasks, sessions and requests against a split installation.
- **No end-to-end mutation tests:**
  - `resumeTask` and `resumeSession`: the panel routes now resolve the owner through project
    stores and pass it on, but no test drives a resume.
  - `decideWorkerAction`: only `workerActionScope` is checked, not an actual decision on a pending
    worker action.
- **Full router suite not run.**
- **Labs:** the `sy.labsFor(project)` change was not exercised in a split installation.
  `admin-labs.test.ts` passed for the legacy installation only.
- **Docs not updated:** docs and the working document's `Current State` are outside my owned
  paths.

## Open questions and contradictions

- **Pre-existing, not mine (`admin/sessions.ts`):** `sessionDetail(..., { project })` with a slug
  does not find a legacy session stored with `project_id ''`. `requireSessionIn` still passes such
  a session, through the fallback in `sessionOwner`, but the session page then 404s on
  `sessionDetail`. Whoever owns `admin/sessions.ts` should decide whether to add the same `''`
  fallback there.
- **`calibration.ts`** still resolves owners with `sy.tasks.projectOf` and falls back to `sy.db`.
  Its verdict tables have no `project_id`, which wave A already recorded. It is a dashboard, not a
  by-id path, so I left it unchanged.
- **Resolving an id without a project now scans every project store and refuses duplicates**,
  where it used to stop at the first match. Ids are random in practice. Ids a client supplies can
  collide across split stores, and the routes now return 409 `ambiguous_id` for those.
- **Raw JSON links do not send `?project=`.** These are the job-plan, team and channel links in
  `components/job-plan.tsx` and `components/job-team.tsx`. They still work through the fan-out.
