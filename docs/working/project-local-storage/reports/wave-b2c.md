# Wave B2c: qualification's installation-owned store (worker report)

Worker: wave-b2c (worker). Date: 2026-10-27. Branch dev, main checkout, no commits. Paths below
are relative to `packages/router` unless stated.

## Outcome

Done. Qualification and comparison runs now work in split layout, routed to a synthetic,
installation-owned store that lives entirely inside the installation's own storage directory.
B1's refusal (`ProjectStoreRouter.runtimeOf` throwing for `_qualification`) is removed; legacy
installations are unaffected (same code paths, same `sy.db`/`sy.tasks`/`sy.artifacts`).

## What changed and why

- **New `src/qualification/store.ts`.** `qualificationStoreDirectory(cfg)` names
  `<storageDir>/qualification` (never a user's directory). `ensureQualificationStore(coordinationDb,
  cfg, now?)` is a narrow, synchronous, idempotent sibling of `provisionProjectStore` that creates
  or adopts a project-role store there and registers it in `project_store_registrations` under
  slug `_qualification` — bypassing the overlap refusal entirely (it never validates a
  caller-supplied directory; it only ever provisions this one fixed path) rather than weakening
  that refusal for real projects. It mints a fresh `ProjectStoreIdentity` on first use, or adopts
  an existing one (crash-recovery between create and register), or refuses outright if the
  directory holds something else. `store-identity.ts`'s slug validator and `store-role.ts`'s
  `assertProjectContents` already special-cased `QUALIFICATION_PROJECT` before this wave (own
  `qualification_runs`/`qualification_tasks`/`qualification_results`/`repository_registry` rows
  permitted in a project store of that slug) and `admin/insights.ts`'s `qualificationBoard` was
  already reading via `requireProjectStores(sy, QUALIFICATION_PROJECT)` — both were waiting on this
  wave to wire up; nothing there needed changing.
- **`src/core/project-runtime-host.ts` (smallest change I could find; 3 spots, ~20 lines):**
  1. `ProjectRuntimeRegistry`'s `context` callback: `o.projects.require(slug)` throws for
     `_qualification` (it is deliberately never "configured"), and even `o.projects.context(slug)`
     always reads `projectDirectory: null` for it (by design, in `registry.ts`, which I must not
     touch) — but `ProjectRuntimeRegistry.openRegistered` requires a non-null `projectDirectory`
     that matches the registration. Fix: for `_qualification` only, wrap
     `o.projects.qualification` in a `projectContext` overlay that overrides just
     `projectDirectory` to `qualificationStoreDirectory(o.cfg)`. `openRegistered` then builds its
     own working `cfg` from the registration's own paths anyway (it overwrites `storageDir` and
     `brain.path`), so this override only has to make the identity/directory equality checks pass.
  2. New `ProjectRuntimeHost.qualificationBundle()`: calls `ensureQualificationStore` then
     `this.bundle(QUALIFICATION_PROJECT)`. Provisioning is synchronous so it can happen inside the
     otherwise-synchronous `runtimeOf`.
  3. `ProjectStoreRouter.runtimeOf`: replaced the refusal with
     `return this.host.qualificationBundle();` for `project === QUALIFICATION_PROJECT`.

  Everything else — `LabManager`, `WebAccess`, `ProjectExecutionGrants`, `ProjectQueueBindings`,
  `Brain`/`BrainAccess`, and critically `ProjectScheduler` (which just iterates every registered
  row in `project_store_registrations` and dispatches it like any other project) — is unmodified
  and already generic over any registered project identity, qualification included. Once the
  store is registered, the scheduler discovers and dispatches its tasks on the very next tick
  (`submitTasks` already calls `this.host!.kick()` when `s.bundle` is set).

- **`src/qualification/runner.ts`.** Added `private store()` (`this.sy.projectStores
  (QUALIFICATION_PROJECT)`), which is the installation's own store in legacy layout (identical
  behaviour to before) or the split store above. Routed `requestsUsedToday`, `start`,
  `gradePending`, and `gradeCoding`'s artifact reads/writes through it instead of the direct
  `this.sy.db`/`this.sy.tasks`/`this.sy.artifacts` fields (those fields are plain readonly
  bindings to the *installation* store and never route per project).
- **`src/qualification/comparison.ts`.**
  - `comparisonRequestsToday`: a legacy installation still runs one query over `sy.db`; a split
    one sums the same query over the qualification store and every configured project's store
    (`sy.projectStores(slug).db`), since a comparison's requests can land in either (an eval
    goal's fixture copy runs in the qualification project; a supplied goal runs in the primary
    project).
  - `repositoryFor`: an eval goal's fixture-copy repository is registered against the
    qualification store's own db, not `sy.db`.
  - `runOne`: computes `project` (qualification for eval goals, the primary project's slug for
    supplied goals — unchanged logic, now named) and reads/writes through
    `sy.projectStores(project)` instead of the direct `sy.tasks` field. `servedEndpoints` takes a
    `Db` parameter instead of `sy`, for the same reason.
  - Left unchanged: `sy.tasks.event(null, ...)` (the comparison start/run/finished event log) and
    the `comparisons()`/`comparison()` reads of it. These are deliberately installation-wide
    (task-less, cross-project audit records), not a user project's data, so they satisfy the
    "no qualification rows in a user project's store" bar either way; see Open questions.

## Commands run and observed results

All from `D:/MeritRouter/packages/router`.

| Command | Result |
| --- | --- |
| `npx tsc --noEmit -p .` | exit 0 (clean; two unrelated errors from concurrent B2a/B2b edits in `admin/projects.ts` and `tests/project-service-activation.test.ts` were present mid-session and gone by the final run) |
| `npx vitest run tests/qualification-split-store.test.ts` | 1/1 passed |
| `npx vitest run tests/qualification.test.ts tests/projects-router-fixes.test.ts tests/qualification-split-store.test.ts` | 15/15 passed |
| Same three files, rerun once after a load-induced failure | First run: 14/15, "per-project brain index" test timed out at 30s plus an `EBUSY` on its temp-dir cleanup (both symptoms of machine load, matching wave-b1's report). Reran `tests/projects-router-fixes.test.ts` alone: 8/8 passed. Reran all three together again: 15/15 passed |

## Not verified

- Restart/resume of the qualification store (crash-recovery adoption path in
  `ensureQualificationStore`, and whether repositories registered at runtime survive a restart in
  split mode — see Open questions 1).
- Concurrent processes racing to provision the qualification store for the first time (the
  registration step is guarded by `BEGIN IMMEDIATE`, but the create-identity-and-open-db step
  before it is not; same class of gap A1's `provisionProjectStore` has for real projects).
- Paid routes for qualification/comparison in split layout (B1 already noted paid requests are
  refused for every split project; unaffected and unexercised here).
- The full router suite, `pnpm -r build`, MCP tests, and the panel.
- `tests/projects-router-fixes.test.ts`'s and `tests/qualification.test.ts`'s own legacy-layout
  qualification cases needed no edits and I made none; I only read them to confirm no regression.

## Open questions or contradictions found

1. **Runtime-registered repositories don't survive a restart in split layout.**
   `ProjectRegistry.syncRuntimeRepositories` (in `registry.ts`, which I must not touch) always
   reads `repository_registry` from `this.db` — the *installation* db it was `attach`-ed to at
   startup, never a split project's own store. I deliberately write qualification/comparison
   fixture registrations to the qualification store's own db (matching `store-role.ts`'s
   classification of `repository_registry` as a qualification-store table), which is correct for
   the running process (the in-memory `cfg.repositoryPaths` mutation that `registerRepository`
   also does takes effect immediately regardless), but means a restarted split installation would
   not recover those registrations from either store. This is pre-existing scope, not something
   B2c can fix without touching `src/projects/registry.ts`; flagging for whoever owns split-mode
   restart recovery of runtime repositories.
2. **Comparison's event log stays installation-wide.** `sy.tasks.event(null, COMPARISON_STARTED/
   RUN/FINISHED, ...)` always writes to the installation (coordination) store in split mode,
   since `sy.tasks` is a plain field, never routed. This matches wave-b1's open question 4
   (`prepareRepositories`/discovery already do the same for `events` rows) and satisfies this
   wave's acceptance bar as written (it is not a *user project's* store), but it does mean a
   comparison's goal text sits in the coordination store's `events` table in split layout, same as
   before this wave. Flagging in case a future canary walk wants it scoped differently.
3. **No change needed to `service.ts` or `projects/registry.ts`.** I initially expected to need a
   change in `core/service.ts` to remove B1's refusal, per the brief's allowance, but the refusal
   lived entirely in `project-runtime-host.ts`'s `ProjectStoreRouter.runtimeOf`; `service.ts`
   itself was already written project-slug-agnostic (`projectStores`, `submitTasks`'s
   `submissionProject`, `jobMetrics`'s `locateProjectTask` in `admin/project-reads.ts`) and needed
   nothing. I did not touch `service.ts`, `projects/registry.ts`, or B2a's `openInstallationLayout`.

## Return contract

Outcome: Done
Changed:
- `packages/router/src/qualification/store.ts` (new)
- `packages/router/src/qualification/runner.ts`
- `packages/router/src/qualification/comparison.ts`
- `packages/router/src/core/project-runtime-host.ts` (3 minimal, documented spots: the registry's
  `context` callback, a new `qualificationBundle()` method, and `ProjectStoreRouter.runtimeOf`'s
  qualification branch — exact lines in "What changed and why" above)
- `packages/router/tests/qualification-split-store.test.ts` (new)
Validation: `npx tsc --noEmit -p .` -> exit 0; `npx vitest run tests/qualification.test.ts
tests/projects-router-fixes.test.ts tests/qualification-split-store.test.ts` -> 15/15 passed
(after one load-induced rerun, per brief)
Not verified: restart/resume of the qualification store; concurrent first-provision races; paid
routes; full router suite/build/MCP/panel (see "Not verified" above)
Report: docs/working/project-local-storage/reports/wave-b2c.md
Notes: `project-runtime-host.ts`'s qualification fix is 3 small, separate edits (registry
`context`, `qualificationBundle()`, `runtimeOf`) — none of them touch `openInstallationLayout` or
service.ts, which B2a owns. `admin/insights.ts`'s `qualificationBoard` already called
`requireProjectStores(sy, QUALIFICATION_PROJECT)` before this wave, confirming the intended design.
