# Report: j1-core (projects plan, phase J1, step 1)

Worker report for the brief "j1-core" in [projects.md](../../projects.md). Worktree
`D:/sy-wt/pj`, branch `feat/projects`. Nothing committed.

## Outcome

Done. One install now holds many projects: config `projects.<slug>` (plus the legacy
single-project shape), a `ProjectContext` per project threaded through submit, validation,
routing preparation, the executor, runners, context sources, verification, acceptance, and one
`Brain`/`BrainAccess` per project. One appended migration adds `project_id` and the `projects`
table; repository keys are `<project>/<alias>` in `tasks.writable_repo`, `file_leases.repository`,
and `merge_queue.lock_key`. Typecheck, build, and the full suite (404 tests: 395 baseline plus 9
new) pass.

## What changed and why

New area `packages/router/src/projects/`:
- `schema.ts`: `ProjectConfigSchema` for `projects.<slug>`: `name`, `repositories`, `brain`
  (`mounts`, `access_approver`, `auto_approve`), `verification` (deep-merged, arrays replace),
  `team` (only `max_agents`, `max_depth`, `child_budget_share`, `channel_*`), `coding`
  (`allowed_commands`, `protected_paths`), `supervisor` (`allowed_commands`, `branch_prefix`),
  `roles` (a role given replaces the global entry). Any other key is refused with "not a project
  setting". Key lists are exported as `PROJECT_TEAM_KEYS`, `PROJECT_CODING_KEYS`, and
  `PROJECT_SUPERVISOR_KEYS`.
- `resolve.ts`: `resolveProjects(rawCfg, baseDir)` returns `{ resolution: { projects, primary }, issues }`.
  - Legacy (D3): no `projects` section gives one project with slug `brain.project`,
    `legacy: true`, and no overrides.
  - Otherwise every override is merged onto the global section and validated with that section's
    own schema. Top-level `repositories` beside `projects` is an error.
  - `primary` is `brain.project` when it names a project, else the first project.
  - Called from `parseConfig`, so a bad project config fails at load time (and in the panel's
    config editor).
- `context.ts`:
  - `ProjectContext` is a Proxy over the global `ResolvedConfig`. Overlaid keys come from a
    per-project overlay; everything else is read live from the global config, so a reload reaches
    it without rebuilding anything.
  - A legacy project overlays only `project`, so its context is the global config in every
    respect: the same `repositoryPaths`, `brain`, and `verification` objects.
  - `repoKey(project, alias)` and `splitRepoKey(key)` build and split repository keys (D6).
- `registry.ts`: `ProjectRegistry` holds one stable context per project. `refresh()` rebuilds the
  overlays in place after a config reload. `attach(db)` records rows in `projects`, runs the
  backfill, and merges runtime-registered repositories (qualification and comparison fixtures)
  into every project.
- `backfill.ts`: `backfillProjects(db, primary)` runs at every service start and is idempotent.
  - Rows with `project_id = ''` go to the primary project. Rows hanging off a task take that
    task's project.
  - Bare repository keys are namespaced.
  - Events with no task stay NULL (global). `model_requests` charged to no task stay `''`
    (probes).

Config:
- `src/config/schema.ts`: `RepositorySchema` and `RoleSchema` are now exported. The inline
  `brain`, `supervisor`, `team`, and `coding` sections became exported `BrainConfigSchema`,
  `SupervisorConfigSchema`, `TeamConfigSchema`, and `CodingConfigSchema` (moved, not changed) so
  that project overrides validate against them. Also added `REPOSITORY_ALIAS_RE`,
  `PROJECT_SLUG_RE`, and `projects: z.record(slug, z.unknown())`; the values are validated by
  `ProjectConfigSchema` in `parseConfig`. The `ProviderEntrySchema` and `ProviderKeyConfigSchema`
  blocks are untouched. The file is 799 lines.
- `src/config/load.ts`: `ResolvedConfig.projectResolution: ProjectsResolution`. The global
  `repositoryPaths` remains the top-level (legacy) repositories, which are empty with `projects`.

Storage (`src/storage/migrations.ts`, one appended migration):
- New table `projects (id PK, name, created_at, archived_at, last_active_at)`.
- `project_id TEXT NOT NULL DEFAULT ''` on `tasks` (index `tasks_project(project_id, state,
  created_at)`), `job_state`, `sessions` (index `sessions_project`), `brain_access_requests`,
  `brain_grants`, `job_plans`, and `model_requests` (index `model_requests_project`).
- `events.project_id TEXT`, nullable; NULL means a global event.
- AFTER INSERT triggers stamp the task's project on any row written without one, whoever writes
  it: `sessions`, `job_state`, `brain_access_requests` (by `task_id`, else `job_id`),
  `brain_grants`, `events`, `job_plans`, and `request_charges`, which stamps the
  `model_requests` row it charges. Writers in `src/sessions`, `src/brain`, and `src/admission`
  therefore needed no edits.
- `job_plans_immutable` is dropped and recreated so that the only update allowed is stamping
  `project_id` on a row whose project is `''`. Any other update still aborts (tested).

Other storage changes:
- `src/storage/tasks.ts`:
  - `TaskRow.project_id`.
  - `submit(specs, { project? })` stores the project and `writable_repo = repoKey(project,
    alias)`. It refuses a dependency on another project's task, and an idempotency key already
    used in another project (the key is unique per install).
  - `list({ ..., project? })` and `projectOf(id)`.
  - `ClaimLimits.maxAgentsPerJob` may be a function of the project, for a per-project
    `team.max_agents`.
  - `claimCompanions` batches only within the leader's project.
  - The claim query is otherwise unchanged (FIFO). It is correct across projects because the
    writer counts and file leases key on the namespaced `writable_repo`.
- `src/storage/usage.ts`: `usageSummary(db, since, until, project?)`.

Core:
- `src/core/executor.ts`: new optional `ExecutorDeps.project(task) => ProjectDeps { cfg, brain,
  access }` and `depsFor(task)`. Every task-scoped call now gets the task's project deps:
  - the run context (`ctx.cfg`, `ctx.brain`, `ctx.access`);
  - `effectiveBudget` and `runCap`, the contract (`ensureContract`), and upstream context;
  - `resumeFor`, `continueRun`, `verifyWithReview`, `planRetry`, and `openRunSession`;
  - `router.prepare` and the worker report.

  Global reads stay global: profiles, execution, lease, and `classifyFailure`. A task whose
  project is no longer configured fails at prepare with "project X is not configured".
- `src/core/scheduler.ts`: an optional `projectConfig(slug)` lets `team.max_agents` be read per
  project. Batch companions must share the leader's project.
- `src/core/service.ts`: see the API section below. One `Brain` and `BrainAccess` per project,
  built lazily from the project context. `sy.brain` and `sy.brainAccess` are the primary
  project's. Config reload calls `projects.refresh()`.

Minimal edits outside the owned paths, each needed for correctness or for tests to pass:
- `src/routing/router.ts`: `prepare(task, owner, project = this.cfg)` uses the project for
  `loadSources`, `measureFeatures`, and the classifier's `effectiveBudget`. Without this, the
  task's repositories cannot be read in multi-project mode.
- `src/workspaces/merge-queue.ts`: `enqueue` builds `lock_key = repoKey(<job's project>,
  repo):branch`.
- `src/verification/audit.ts`: an audit task is submitted in the audited task's project, so its
  repository aliases resolve.
- `src/admin/job-plans.ts`: the file-lease "waiting" view shows the bare alias (`splitRepoKey`).
- `src/index.ts`: exports for the projects area.

Tests:
- New `tests/projects.test.ts` (9 tests), all with temp dirs and temp brains.
- `tests/providers-routing.test.ts` "store upgrade": it assumed its migration was the last one
  (`MIGRATIONS.slice(0, -1)`). It now locates the gateway-drop migration by content. This was the
  only change to an existing test.

## Commands run and observed results

- `npx tsc --noEmit -p .` (router): clean.
- `pnpm -r typecheck`: router Done, panel Done.
- `pnpm -r build`: router and panel built ("apps/panel build: Done", all routes listed).
- `cd packages/router && npx vitest run`, first full run: 394 passed, 1 failed. The failure was
  the store-upgrade test above (EBUSY after its own insert into the dropped `fl_key_billing`
  threw), and it was fixed.
- Final full run: "Test Files 40 passed (40) / Tests 404 passed (404)". The two known timing
  tests did not fail.
- `npx vitest run tests/projects.test.ts`: 9 passed.
- Mutation check: with `repoKey` temporarily returning the bare alias, the concurrency test
  failed ("timed out waiting", the second project's task held back). The code was restored and
  checked with grep.
- `pnpm --filter switchyard-panel seed:demo`: completed ("Demo ready"); audits were sampled and
  ran through the project path.

New tests in `tests/projects.test.ts`:
- **Same `app` alias in two projects.** Two coding tasks run concurrently in one worker, with
  one writer per repository and overlapping `src/**`. Both reach `running`. `writable_repo` is
  `alpha/app` and `beta/app`, and the live leases are on both. There is no
  `waiting_for_file_lease`. Merge-queue items with the same alias and branch get
  `alpha/app:...` and `beta/app:...` with `ahead` 0 each.
- **Runner isolation.** Each runner sees only its project's `repositoryPaths` and brain scope;
  alpha does not see beta's `lib`.
- **Legacy, in memory.** A single-project config becomes one project, `demo`, whose context
  shares the global objects. The test also covers overlay and override semantics, config errors,
  and the `repoKey` round trip.
- **Legacy, upgraded store.** A database built at the pre-projects migration, holding tasks,
  events, sessions, job_state, file_leases, merge_queue, grants, requests, plans, and
  model_requests, opens with every row assigned to `demo`. Keys are namespaced, the global event
  stays NULL, and the uncharged request stays `''`. Plan immutability holds, old rows are listed
  under `demo`, and a new submit needs no project.
- **Service reads by project.** `listTasks`, `getStatus`, `usage`, and `questions` filter by
  project. `cancelTasks` and `answerQuestion` refuse another project's task. A write with no
  project is refused when there are several projects. A delegated task inherits its job's
  project. A cross-project dependency is refused, and so is an idempotency key reused from
  another project.

## API for the next workers

```ts
// src/projects/context.ts
interface ProjectInfo { slug: string; name: string; legacy: boolean }
type ProjectContext = ResolvedConfig & { readonly project: ProjectInfo };
function projectContext(global: ResolvedConfig, overlay: Record<string, unknown>): ProjectContext;
function repoKey(project: string, alias: string): string;              // "<project>/<alias>"
function splitRepoKey(key: string): { project: string | null; alias: string };

// src/projects/registry.ts
class ProjectRegistry {
  constructor(cfg: ResolvedConfig);
  refresh(): void; attach(db: Db, now?: () => number): void; syncRuntimeRepositories(): void;
  list(): ProjectContext[]; slugs(): string[];
  get(slug: string): ProjectContext | undefined; require(slug: string): ProjectContext;
  get primary(): ProjectContext;
  forWrite(slug?: string | null): ProjectContext;   // the named or only project; else throws
  rows(): ProjectRow[];                              // { id, name, createdAt, archivedAt, lastActiveAt }
  touch(slug: string): void;                         // last_active_at
}
// src/projects/resolve.ts
resolveProjects(raw: RawConfig, baseDir: string): { resolution: ProjectsResolution; issues: ProjectIssue[] };
// ResolvedConfig.projectResolution: { projects: ResolvedProject[]; primary: string }
// src/projects/backfill.ts
backfillProjects(db: Db, primary: string): { tasks: number };
```

Service (`Switchyard`). Reads: no project means all projects. Writes: a project is needed unless
there is exactly one, and for id-based writes a named project acts as a guard.

```ts
readonly projects: ProjectRegistry;
brainFor(project: string): Brain;  brainAccessFor(project: string): BrainAccess;
projectContext(project: string): ProjectContext;   // '' -> primary; unknown -> throws
submitTasks(raw, { purpose?, parentSessionId?, project? })
startJob({ ..., project? })
getStatus(ids, project?)
listTasks(states?, limit = 50, project?)           // TaskStatus now has `project`
cancelTasks(ids, project?)
acceptTask(id, input, project?)
rejectTask(id, input, project?)                    // use the task's project verification policy
questions({ pendingOnly?, taskId?, project? })     // rows now carry `project`
answerQuestion(id, answer, by = "user", project?)
resumeTask(id, project?)
resumeSession(sessionId, project?)
usage(sinceMs, untilMs?, project?)
```

How `submitTasks` finds the project when none is named:
1. A `parentTaskId` or `dependsOn` naming an existing task: that task's project. Several
   different projects are refused, and so is one that conflicts with a named project.
2. Purposes `qualification`, `comparison`, and `audit`: the primary project. The auditor passes
   the audited task's project explicitly.
3. Otherwise the only project, else an error that names the projects.

`TaskStore`: `submit(specs, { project? })`, `list({ states?, limit?, project? })`,
`projectOf(id)`. `ExecutorDeps.project?: (task) => ProjectDeps`, and the Scheduler takes an
optional 8th constructor argument `projectConfig(slug)`.

## Still read off the global cfg (not project-aware yet)

- Fairness, D5, and D7 config fields (per-project `max_concurrent_tasks`, `priority`, and paid
  cap or share) were not added. That is `j1-scheduling-brain`'s. The claim query is still FIFO.
- Brain:
  - The default supervisor grant is still `**` read (`src/brain/access.ts`, not edited).
  - `Brain.ensure()` creates the folders of the first project that writes; there is no "create
    on project create" yet.
  - Brain FTS has no project column.
  - D9 is not started.
- `src/verification/audit.ts`: audit policy (`audit_sample_rate`, `audit_max_requests`,
  `audit_min_free_fraction`, and the deep-review requirements for the audit reviewer) uses the
  global `verification`. A project override of these is ignored.
- `src/qualification/stats.ts` through `TaskRouter` (`qualificationLookup(db, this.cfg)`):
  `verification.reviewer_qualification` and `review_strict_pass_threshold` are read globally
  when reviewers are chosen. A project override of those two keys has no effect on routing.
- Panel facade `src/admin/*`: `insights.ts:393-394` (strict acceptor), `job-team.ts:375`
  (`team.max_depth`), `jobs.ts:52` (`supervisor.branch_prefix`), and `calibration.ts:330`
  (audit rate).
- CLI and MCP:
  - `cli/doctor.ts:165` and `cli.ts:401` read `cfg.repositoryPaths`, which is empty in
    multi-project mode.
  - `mcp.ts:372` and `mcp.ts:408` use the primary brain and `cfg.repositoryPaths`.
  - MCP `submit_tasks` and `start_job` pass no project, so they work only with one project.

  These belong to j1-surfaces.
- `qualification/comparison.ts:115` checks a supplied goal repository against the global
  `cfg.repositoryPaths`.
- Global by design: `team.provider_concurrency_*` (gate), `supervisor.max_concurrent_jobs` and
  `job_timeout_seconds`, `execution.*`, profiles, tiers, routing, paid, and providers.

## Not verified

- No live provider, OpenCode, or real supervisor job across two projects. A supervise job in a
  non-primary project is covered only by the unit wiring (its context comes from `ctx.cfg`); no
  test ran a supervisor in project B end to end.
- Config hot reload of a `projects` section (`reloadIfChanged`, then `projects.refresh()`) has
  no test.
- Panel pages were not started or screenshotted. Only the build and `seed:demo` ran.
- Backfill performance on a large store. It scans `events` and `model_requests` at every start.
- Multi-process: two processes on one store running the backfill at once (each runs in an
  IMMEDIATE transaction and is idempotent; not exercised).

## Open questions or contradictions found

1. The brief and plan say to namespace `workspaces.repo_alias` and `merge_queue` aliases. I
   namespaced `merge_queue.lock_key` (the cross-task merge lock) but kept `workspaces.repo_alias`
   and `merge_queue.repo_alias` bare. Both are keyed by task id, so they cannot collide, and five
   readers outside my paths resolve them as aliases within the task's own project
   (`context/upstream.ts`, `harness/integration-tools.ts`, `verification/followup.ts`, the merge
   queue itself, and `runners/coding/finish.ts`). Namespacing them would mean stripping the
   prefix in each reader for no isolation gain. The supervisor may want this reversed.
2. The plan says the legacy default project is `my-project`, but `brain.project` defaults to
   `default` in the schema. I kept the schema default, so an upgraded install's project is
   whatever `brain.project` was.
3. Idempotency keys stay unique per install (the existing UNIQUE column), so the same key in two
   projects is refused rather than scoped. Scoping would need a table rebuild (a composite
   unique index on `(project_id, idempotency_key)`).
4. Rows written with no project after start (for example a session with no task, or a brain
   request from the MCP supervisor) stay `''` until the next start, which gives them to the
   primary project. j1-surfaces should pass a project explicitly for MCP sessions and requests.
