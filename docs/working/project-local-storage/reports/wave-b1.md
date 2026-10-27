# Gate 1 wave B1: service activation (worker report)

Worker: wave-b1 (worker-heavy). Date: 2026-10-27. Branch dev, main checkout, no commits, no new
worktrees. Paths below are relative to `packages/router` unless stated.

## Stable API for wave B2

Both methods are on `MeritRouter` (`src/core/service.ts`). The return type is exported from
`src/core/service.ts` and `src/core/project-runtime-host.ts`.

```ts
export interface SplitProjectRuntime { identity: ProjectStoreIdentity; paths: ProjectRuntimePaths }

/** Provision `<directory>/.MeritRouter` (A1 provisionProjectStore, installationRoots =
 *  [dirname(cfg.configPath), cfg.storageDir]), register it, and open its runtime. */
createSplitProject(input: { slug: string; name?: string; directory: string }): Promise<SplitProjectRuntime>

/** Stop dispatch, interrupt and drain in-flight work, close the project's Labs and store,
 *  retire its registration. Files stay on disk for B2 to remove (paths.root). */
retireProject(slug: string): Promise<SplitProjectRuntime>
```

Contract details B2 needs:

- **Config first.** `projects.<slug>` must already be in the config with `directory` equal to
  `directory`. The method re-reads the config once if the slug is not yet configured. It does not
  write the config: that stays with `admin/projects.ts`.
- **`name`.** Optional. If given, it must equal the configured name, or the call throws
  `TaskValidationError`.
- **Idempotent.** Calling again with the same directory returns the same identity. Another
  directory for a live slug is refused.
- **Refusals.**
  - A legacy installation throws `MeritRouterError` with code `split_projects_unavailable`. This
    applies to both methods.
  - Directory refusals come from A1: inside, equal to, or containing the config or storage
    directory; not a real path; and so on. The router source checkout is also refused.
- **`retireProject` interrupts running tasks** (shutdown semantics). Afterwards `projectStores(slug)`
  and `submitTasks` for that slug throw ("no project-local store"), and
  `sy.projects.get(slug).storageDir` points back at the installation. Deleting `paths.root` while
  the service keeps running works; a test covers it.
- **Mode check.** `sy.layout` is `"split"` or `"legacy"`.

## Outcome

Done, with one decision B1 had to make that the lead should confirm (Open questions 1). Split
storage is the runtime default for a fresh installation opened with `storage.durability: full`.
Every acceptance test I added passes. All failures in the existing suites are either caused by
load (they pass when run alone) or pre-existing (cause given below).

## What changed and why

- **New `src/core/project-runtime-host.ts` (401 lines).**
  - `openInstallationLayout(db, durability)` decides the layout. A store bound as coordination and
    marked split stays split. An empty unbound store opened with `durability: full` gets the meta
    mark `installation_layout=split` first, then the coordination role (`synchronous=FULL` is
    forced). Everything else stays legacy. "Empty" means no rows in `projects`, `tasks`,
    `sessions`, `artifacts`, `model_requests`, `executions`, `labs`, `job_plans`, `brain_*`,
    `web_requests`, `workspaces` or `classifications`.
  - `ProjectRuntimeHost` builds one bundle per project:
    - the private services factory: project-mode `Brain`/`BrainAccess` on the local DB, a
      per-project `LabManager` with `ProjectLabPortReservations`, and a per-project `WebAccess`
      over the shared `WebUsageReservations`/`WebBackendState`;
    - the queue port from `ProjectQueueBindings.bindLocal`, with `ProviderSlotAdmission` and
      **writer repository digests** (sha256 of the writable repo's real path; without them every
      coding claim throws "Writer claim lacks physical repository authority");
    - `servicesForLease`: `createProjectRunServices` for supervisor-mode tasks (with Lab, submit
      and accept policies), `createProjectWorkerReadServices` otherwise.

    The host also owns `ProjectExecutionGrants` (limits from `execution.*`,
    `supervisor.max_concurrent_jobs` and `projects.<slug>.max_concurrent_tasks`),
    `SqliteRequestAccountingBroker`, a separate `ProviderHealth`, `ProjectRuntimeRegistry` and
    `ProjectScheduler`, plus `create`, `retire` and `close`.
  - `ProjectStoreRouter` resolves which store holds a project, task, question or session. An
    ambiguous ID across projects throws "name the project". `fence(slug)` calls
    `legacyProjectFence`.
- **`src/core/service.ts` (1017 → 1075 lines; the ~1050 budget is exceeded by about 25).**
  - The layout is decided at open. In split mode the host is built, backfill is skipped, the legacy
    `Scheduler` is not started (only the project scheduler runs), and the legacy executor gets no
    brain or web.
  - The staged `createProjectRuntimeRegistry` and `StagedProjectRuntimeOptions` are removed (no
    other callers).
  - These now resolve the owning store: `submitTasks` (validation, insert, Lab binding, supervisor
    route check, purpose and events), `getStatus`/`listTasks`/`collectResults`/`awaitResults`,
    `cancelTasks`/`cancelTasksAsync`, `acceptTask`/`rejectTask`, `questions`/`answerQuestion`,
    `resumeTask`/`resumeSession`, `contract`, `usage` (split without a project uses
    `installationUsage`), `projectStores`, `labsFor`, `brainFor`/`brainAccessFor`, and
    `settlePromotionReview`.
  - `RunContext.cfg` and Lab contexts come from the registry bundle (`storageDir =
    <project>/.MeritRouter/state`), so A5's split roots are now reached in production.
  - `legacyProjectFence` is called on the legacy submit, resume, accept, reject, answer and
    executor-dispatch paths.
  - `web` is now a getter: the legacy `WebAccess`, or in split mode the primary (or first) project's.
- **`src/projects/registry.ts`.** `attach(db, now, { backfill })` lets split mode skip the backfill.
  `bindRuntime(slug, { storageDir, brainPath } | null)` gives a split project's context its
  project-local `storageDir` and brain path, and keeps them across `refresh`.
- **`src/projects/runtime-registry.ts`.** New `release(id, before)`: it fences new opens of one
  project, runs `before` (stop dispatch, drain the port, close Labs), then drains the bundle and
  closes its DB.
- **`src/core/project-scheduler.ts`.** New `forget(projectId)` stops and drops one child scheduler.
  The tick skips an entry that was forgotten mid-tick.
- **Not changed:** `projects/backfill.ts` and `core/project-services.ts`.
- **Tests:**
  - New `tests/project-service-activation.test.ts` (9 tests): fresh install; a summarize task with a
    canary; a coding task whose worktree is created by the real `prepareWorkspace`, plus an artifact;
    restart with recovery of interrupted and queued work; legacy refusal; refusal of an
    unregistered project and of qualification; an install-overlap refusal; retirement; identity
    stable across reopen; split supervisor delegation.
  - `tests/project-runtime-registry.test.ts`: the staged test is replaced by two `new MeritRouter`
    tests (composition and drain on close; a missing project DB fails closed on reopen).
  - `tests/project-queue-isolation.test.ts`: two `new MeritRouter` tests (duplicate task IDs in two
    projects; cancel routed by project).

## Commands run and observed results

All from `D:/MeritRouter/packages/router` unless noted.

| Command | Result |
| --- | --- |
| `npx tsc --noEmit -p .` | exit 0 (final run) |
| `pnpm --filter meritrouter-panel typecheck` (repo root) | exit 0 |
| `npx vitest run tests/project-service-activation.test.ts tests/project-runtime-registry.test.ts tests/project-queue-isolation.test.ts` | 3 files, 54/54 passed (final run, after the hook-timeout change) |
| `npx vitest run` service-close + the 9 `projects*` files | 64/65. 1 failure: `projects.test.ts` "runs two projects' tasks on the same app alias", `afterEach` hook timed out at 10 s (`sy.close()`) under parallel load. Alone: `projects.test.ts` 9/9 |
| `npx vitest run` the 7 `team-*` files + supervisor-lifecycle + operations + admin-live | 143/145. 2 failures, both in `team-capacity.test.ts`: a hook timeout, then a 60 s test timeout plus EBUSY on cleanup, under load. Alone: `team-capacity.test.ts` 8/8 |
| `npx vitest run tests/project- tests/admin-web tests/web- tests/lab-config-guard tests/brain-provenance-paging` (45 files) | 598 passed, 3 failed, 1 skipped; vitest also reported `Timeout calling "onTaskUpdate"` (machine saturated). The 3 failures are below |

The three failures in the 45-file run:

- **`project-delete-late-session.test.ts`**: `session ... identity changed` in
  `sessions/recorder.ts:305`. It is deterministic: it also fails when run alone (1 failure in the
  2-file rerun below). I judge it pre-existing: the test and every module it imports (`storage/db`,
  `sessions/store`, `sessions/recorder`, `projects/deletion`) are unmodified in the working tree,
  and none of them import a file I changed. I did not compare against a clean baseline (stash is
  not allowed).
- **`project-metadata-lab.test.ts`**: "service fixture deadline", caused by load. It passed in the
  2-file rerun (`project-delete-late-session` + `project-metadata-lab`: 15/16, the 1 failure being
  late-session).
- **My activation coding test**: a 10 s close-hook timeout under load. I raised my three files'
  `afterEach` timeouts to 60 s. The rerun is the 54/54 row above. I did not rerun the whole 45-file
  batch afterwards.

A throwaway probe (`tests/b1-probe-legacy-bound.test.ts`, since deleted) showed that
`new MeritRouter` on a legacy store bound as coordination throws `Private web ledger cannot use
coordination store`. The cause is the unchanged legacy `WebAccess` constructor. See Open
questions 2.

## Not verified

- The full router suite, `pnpm -r build`, MCP tests (they need a rebuilt `dist/`), the panel build
  and screenshots, and `resilience`/`labs-task-*` (known to be flaky or broken).
- The full 45-file batch after the hook-timeout change.
- **Paid routes in split projects.** `endpointAuthority` returns null for `origin: "paid"` and for
  keys that are not free-tier, so paid requests are refused by the broker. Untested with real paid
  configuration.
- **Promotion review settlement in split mode.** `PromotionReviewer` and `Auditor` still read the
  installation stores, and the auditor sweep runs only on the legacy scheduler tick, which never
  runs in split mode.
- `ensureLabsSupervisor` is not passed to split executors. Lab task paths and Lab-check acceptance
  in split projects are wired but not exercised (the Lab lock fix is concurrent).
- Concurrent processes binding the same empty store (the code handles the race, but it is not
  tested). POSIX was not tested.
- Admin and panel behaviour in split mode beyond the typecheck. `sy.brain` and `sy.brainAccess`
  (primary project) throw when the primary project has no split store.

## Open questions or contradictions found

1. **Default trigger (decision for the lead).** Forcing split mode on every empty installation DB
   would break most of the existing suite: 115 test files build `new MeritRouter` on fresh temp
   stores with `durability: normal` and read `sy.tasks` and `sy.db`. I made the trigger "empty
   **and** `storage.durability: full`". This matches B2's planned setup default (`full`) and the
   coordination role's `synchronous=FULL` requirement. Once B2 changes `setup`, fresh installs are
   split. Flipping to "force full on any empty DB" is a one-line change in `openInstallationLayout`,
   but then the existing suite needs a legacy opt-out (`tests/helpers.ts` or a config flag), which
   I do not own.
2. **The legacy fence is unreachable today.** `legacyProjectFence` needs a coordination-bound
   store. A legacy installation store bound as coordination cannot construct `MeritRouter`:
   `WebLedger`, and the evidence scopes of `SessionStore`/`ArtifactStore`, refuse coordination
   stores. A3's API also takes separate `coordinationDb` and `legacyDb`. Production needs a decision
   on where a legacy installation's coordination store lives (a separate file, and where it is
   configured) before migration can be wired. B1 calls the fence wherever the installation store
   is bound, so it takes effect once that exists.
3. **Qualification in split mode.** Split mode refuses qualification and comparison submissions with
   an actionable error, because the coordination store cannot hold sessions or artifacts. This
   matches wave-a open question 3: B2's synthetic qualification store unblocks it.
4. **Installation `events` rows.** In split mode, `prepareRepositories`, discovery and config
   reloads still write installation-level `events` rows (repository paths) to the coordination
   store. The exit check (tasks/sessions/model_requests/artifacts) is satisfied, but C1's canary
   walk should keep private text out of those events.
5. **ID ambiguity.** Task, question and session IDs are per store. Called without `project`, id-based
   methods search every live project and throw "name the project" on a collision. MCP and admin
   callers in split mode should pass the project.
