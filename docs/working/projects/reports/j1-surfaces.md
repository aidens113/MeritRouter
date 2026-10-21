# Report: j1-surfaces (projects plan, phase J1)

Worker report for the brief "j1-surfaces" in [projects.md](../../projects.md). Worktree
`D:/sy-wt/pj`, branch `feat/projects`. Nothing committed. `src/core/service.ts` and
`src/index.ts` were not edited (the panel reaches everything new through `insights.*`).

## Outcome

Done. The CLI, the MCP server, and the panel's data API are project-aware. My new test file
passes (8 tests). Typecheck and build pass for the router and the panel. With j1-brain's in-progress
`tests/projects-brain.test.ts` excluded, the full suite passes: 42 files, 422 tests. That file
failed 2 tests in one full run and hung in later runs while j1-brain was editing it. See
"Commands run".

## What changed and why

New files:
- `src/cli/project-select.ts`: project selection shared by the CLI and the MCP.
  - `chooseProject(projects, { flag, env, cwd })` returns `{ slug, source }` or `null`.
  - `requireProject(...)` throws a usage error that lists every project.
  - Order: the flag, then `SWITCHYARD_PROJECT`, then the only non-archived project, then the
    project whose repository contains the cwd.
  - For the cwd, the innermost repository wins. The same folder configured in two projects is
    ambiguous. Path comparison is case-insensitive on Windows.
  - An archived project is never chosen implicitly, but a flag may name it.
- `src/cli/projects.ts`: `projects list|create|archive|unarchive`, and `initConfigText` (the
  config that `init` writes).
- `src/admin/projects.ts`: the projects listing and grid, attention items, activity counts,
  create, archive and unarchive, `contextOfTask`, and `selectableProjects`.
- `src/admin/dashboards.ts`: `globalDashboard` and `projectOverview`, plus `activeJobs` and
  `paidSpendByProject`.
- `src/admin/project-settings.ts`: the global vs per-project settings split, and
  `patchProjectSettings`.
- `tests/projects-surfaces.test.ts`.

Edited files:
- `src/cli.ts`:
  - New global `--project`.
  - Every command uses the selected project (contract below).
  - `init` writes the projects shape.
  - `status`, `jobs`, and `questions` show a project column when there are several projects.
- `src/cli/args.ts`: `repoFlags`, for `--repo <alias>=<path>`.
- `src/cli/doctor.ts`:
  - `doctorChecks(sy, { projects? })` and `projectChecks(sy, slug)`.
  - It no longer reads the global `cfg.repositoryPaths`, which is empty in multi-project mode.
- `src/cli/help.ts`: the Projects section, plus the `init`, `doctor`, `worker`, and `blame` text.
- `src/mcp.ts`:
  - Parses `--config`, `--project`, and `--no-worker`, and selects the project.
  - Tools default to the server's project; the brain tools use that project's brain.
  - Recovery runs only when the server runs a worker.
- `src/admin/insights.ts`:
  - `requestLog`, `timeseries`, and `tierDistribution` take a project. `RequestRow.project` is
    new.
  - `taskDetail` uses the task's project verification policy (j1-core flagged the strict
    acceptor at `insights.ts:393-394`).
  - `decideTaskAcceptance` and every brain function take an optional project.
  - The three new modules are re-exported.
- `src/admin/jobs.ts`:
  - `jobsView(sy, limit, project?)`. `JobView.project` is new.
  - The branch prefix comes from the job's project.
  - `workingDoc` comes from the project's brain.
- `src/admin/job-plans.ts`: `team.max_agents` is read per project.
- `src/admin/job-team.ts`: `team.max_depth` is read per project.
- `src/admin/sessions.ts`: `sessionsView(sy, { ...filter, project? })`. The new type is
  `SessionViewFilter`.
- `examples/switchyard.config.example.yaml`:
  - Top-level `repositories` became `projects.my-project` (with a name and an `app` repository)
    plus a comment block explaining projects.
  - The `brain.project` comment now says it is the primary project.
  - I regenerated the presets with `node scripts/build-presets.mjs`; each preset changed only in
    that block.

Not changed (calibration):
- `calibration.ts:330` reads the audit sample rate from the global config. Audit policy is global
  by design for now, as j1-core found for `verification/audit.ts`, so I left it.

## CLI contract

- Global flag: `--project <slug>`. Choosing the project:
  1. `--project`;
  2. otherwise `SWITCHYARD_PROJECT`;
  3. otherwise the only non-archived project;
  4. otherwise the project whose repository contains the cwd.
- Three uses of the selected project:
  - **Required** (an error lists the projects and says `pass --project <slug> or set
    SWITCHYARD_PROJECT`): `submit`, `run` (repository aliases are the project's), and `blame`
    (the alias is looked up in the project's `repositoryPaths`).
  - **List scope** (the chosen project, or every project when none can be chosen): `status`
    (with no ids), `jobs`, `questions`, `sessions`, `usage`, and `brain ls|read|search|requests`.
  - **Id guard** (only when a project was named by flag or environment): `status <ids>`,
    `cancel`, `resume`, `accept`, `reject`, `answer`, and `brain approve|deny`. Another
    project's id is refused, or reads as unknown.
- An unknown `--project` fails every command except `projects`.
- Global commands are unchanged: `models`, `route`, `keys`, `qualify`, `compare`, `worker` (all
  projects), `backup`, `restore`, `daemon`, and `service`.
- `doctor`:
  - Global checks run as before.
  - Global brain mounts are checked once (multi-project configs only).
  - Per project, for every project or only `--project`:
    - `project <slug>` (name, legacy or archived, repository count);
    - `<slug> repo <alias>` (exists and has `.git`; otherwise fail);
    - `<slug> brain` (`projects/<slug>/working` and `decisions` exist; otherwise a warning that
      they are created when the project is created or first written);
    - `<slug> brain mount <prefix>` for the project's own mounts (missing is a fail).
- `projects [list] [--all] [--json]`:
  - A table with a `*` marking the selected project.
  - JSON is `ProjectCard[]`.
  - `--all` adds archived projects.
- `projects create <slug> [--name "<n>"] [--repo <alias>=<path> | <path> ...]`:
  - Validates the slug, that the slug is unused, and that every repository exists and is a git
    repository.
  - Writes `projects.<slug>` through `patchConfig` (validated, `.bak`, live reload) and creates
    the brain folders.
  - A single-project config is converted first: its raw top-level `repositories` move to
    `projects.<brain.project>.repositories`, so every existing row keeps its project.
- `projects archive|unarchive <slug>`:
  - Sets or clears `projects.archived_at`; nothing is deleted.
  - Archive is refused while the project has running or queued tasks.
- `init [dir] [--preset p] [--project <slug>] [--name "<n>"] [--repo <alias>=<path> ...]`:
  - Writes the preset with its first project renamed to `<slug>` (default `my-project`, or
    `SWITCHYARD_PROJECT`) and sets `brain.project` to it.
  - `--repo` replaces the placeholder repositories.
  - A preset still in the single-project shape is converted.

## MCP contract

- Arguments: `mcp.js [--config <file>] [--project <slug>] [--no-worker]`. Unknown arguments are
  ignored (`strict: false`).
- Choosing the project: `--project`, then `SWITCHYARD_PROJECT`, then the only project, then the
  cwd inside a project's repository.
- If none can be chosen, the server closes the store and exits 1 with
  `switchyard mcp: ... several projects ... Projects: a, b`.
- `--no-worker`: no in-process worker, and `recover()` is not run (the daemon owns both).
  Without the flag, behaviour is unchanged.
- Tools with an optional `project` input (default: the server's project, which must exist):
  - `submit_tasks`, `start_job`, `get_task_status` (with ids, another project's task reads
    `unknown`);
  - `usage_summary`, `list_questions`, `list_sessions`, and `blame` (the alias is resolved in the
    project).
- Tools that use the server's project as a guard: `cancel_tasks`, `resume_task`,
  `resume_session`, `accept_result`, `reject_result`, and `answer_question`.
- Brain tools:
  - They use `sy.brainFor(project)` and `sy.brainAccessFor(project)`.
  - The principal is a supervisor with that project, effort `claude-code` (per project: its
    documents are under `projects/<slug>/`), and that project's repository aliases.
  - `brain_access_requests` lists only the project's requests. `brain_decide_request` refuses
    another project's request.
- The tool names are unchanged, so `tests/mcp.test.ts` is untouched.

## Admin API (for J2)

Every function is exported through `insights.*`.

```ts
// projects.ts
RUNNING_STATES, QUEUED_STATES
interface ProjectRepositoryView { alias; path /*abs*/; writable; exists /* has .git */ }
interface ProjectSummary { slug; name; legacy; primary; archived; archivedAt; createdAt; repositories: ProjectRepositoryView[] }
interface ProjectCard extends ProjectSummary { runningJobs; queuedJobs; runningTasks; queuedTasks; lastActivityAt: number|null; attention: number; attentionItems: string[] }
projectList(sy, { includeArchived? }): ProjectSummary[]
projectInfo(sy, slug): ProjectSummary                      // not_found for unknown
projectsGrid(sy, { includeArchived? }): ProjectCard[]       // the grid
projectAttention(sy, slug): string[]   // questions, results awaiting decision, brain requests, interrupted tasks, missing repos
projectActivity(sy, slug): { runningJobs, queuedJobs, runningTasks, queuedTasks, lastActivityAt }
contextOfTask(sy, taskId): ProjectContext                   // task's project, primary for unassigned/unconfigured
selectableProjects(sy): SelectableProject[]
interface CreateProjectInput { slug; name?; repositories?: Record<alias, { path; writable? }>; mounts?: Array<{ prefix; path; commit? }> }
validateNewProject(sy, input): string[]
createProject(sy, input): Promise<{ ok: true; project: ProjectSummary; convertedLegacy: string|null } | { ok: false; errors: string[] }>
archiveProject(sy, slug, now?): ProjectSummary              // throws usage while running/queued tasks exist
unarchiveProject(sy, slug): ProjectSummary

// dashboards.ts
interface ActiveJob { taskId; project; label; goal; state; createdAt; startedAt; pendingQuestions }
interface ProjectUsage { requests; failedRequests; inputTokens; outputTokens; tasksSubmitted; tasksCompleted; tasksFailed; reportedCostUsd: number|null; paidSpendUsd }
activeJobs(sy, project?, limit = 50): ActiveJob[]           // top-level supervise tasks, running+queued
paidSpendByProject(sy, sinceMs): Map<slug | "", usd>        // COALESCE(actual, reserved) via paid_spend -> model_requests.project_id
interface DashboardProject extends ProjectCard { tasksByState; usage24h: ProjectUsage; usage7d: ProjectUsage }
interface GlobalDashboard { generatedAt; install: Overview; projects: DashboardProject[]; jobs: ActiveJob[];
  attention: Array<{ project: string|null; text }>; unattributed: { usage24h; usage7d };
  totals: { runningJobs; queuedJobs; runningTasks; queuedTasks; usage24h; usage7d } }
globalDashboard(sy, { includeArchived? }): Promise<GlobalDashboard>
interface ProjectOverview { generatedAt; project: ProjectSummary; workers; tasksByState; activity; jobs: ActiveJob[]; attention: string[];
  usage24h: UsageSummary; usage7d: UsageSummary; paidSpendUsd: { last24h; last7d } }
projectOverview(sy, slug): ProjectOverview                  // throws not_found for unknown

// project-settings.ts
PROJECT_SETTING_KEYS: readonly string[]                     // Object.keys(ProjectConfigSchema.shape): includes j1-fairness's fields
globalSettings(sy): { configPath; multiProject; sections: Record<key, effective value> }  // no projects; no repositories when multi
projectSettings(sy, slug): { slug; name; legacy; configPath; configKeyPath: ["projects", slug] | []; raw; effective: { repositories, repositoryPaths, brain, verification, team, coding, supervisor, roles } }
patchProjectSettings(sy, slug, patch: Array<{ path; value }>): { ok: true } | { ok: false; errors }
  // paths relative to the project; written under projects.<slug> (top level for a single-project config);
  // only project keys, and only the overridable keys of brain/team/coding/supervisor; null removes

// insights.ts (added optional parameters; old calls unchanged)
requestLog(sy, { ..., project? })          RequestRow.project
timeseries(sy, { ..., project? })          tierDistribution(sy, sinceMs, project?)
decideTaskAcceptance(sy, id, decision, by, reason, project?)
brainTree(sy, prefix, project?)  brainRead(sy, path, project?)  brainSearch(sy, q, prefix?, project?)
brainHistory(sy, path, project?)  brainBlame(sy, path, project?)  brainWrite(sy, path, content, project?)
brainAccessRequests(sy, status?, project?)  decideBrainAccess(sy, id, approve, reason, project?)
jobsView(sy, limit = 50, project?)         JobView.project
sessionsView(sy, { ...SessionListFilter, project? })
```

The old `overview(sy)` stays as the install-wide view, and `globalDashboard` embeds it as
`install`. The existing panel compiles and builds unchanged.

## Commands run and observed results

- `npx tsc --noEmit -p .` (router): clean, several times while working.
- `pnpm -r typecheck`: "packages/router typecheck: Done", "apps/panel typecheck: Done".
- `node scripts/build-presets.mjs`: wrote the four presets.
- `npx vitest run tests/projects-surfaces.test.ts`:
  - First run: 6 passed, 2 failed. Both failures were mine:
    - `repoFlags("=x")` did not throw (fixed);
    - a wrong expectation that the default `team.max_agents` is 8 (it is unset; fixed).
  - Re-run of those two: passed. Earlier, the other 6 passed, CLI and MCP included.
- Mutation check:
  - I forced `worker: true` in `mcpArgs`, rebuilt, and ran the MCP test. It failed (the task
    was no longer `queued`).
  - I restored the file (checked with grep) and rebuilt.
- `npx vitest run` (full, after `npm run build`): "Test Files 1 failed | 42 passed (43)", "Tests
  2 failed | 427 passed (429)".
  - Both failures are in `tests/projects-brain.test.ts` (j1-brain's new file):
    - "project brain isolation (D4) > a supervisor of one project reads its project and global/";
    - "gated promotion to global/ (D9) > runs the review as a task through the Gate...".
  - That file does not use the CLI, the MCP, or `src/admin`.
  - A separate run of that file alone did not finish within 300 s while j1-brain was working.
- After converting the line endings back to LF and running `npm run build`, I started another
  full run. It hung for more than 20 minutes and I killed its process tree (PID 22932).
- Final run: `npx vitest run --exclude tests/projects-brain.test.ts` printed "Test Files 42
  passed (42)" and "Tests 422 passed (422)". That count includes my 8 tests and j1-fairness's
  file.
- Two stray `vitest run tests/projects-brain.test.ts` processes from 20:51 are still running
  (PIDs 10040 and 7892). One may be mine; its parent shell was already stopped. I could not tell
  which is mine, so I left both rather than kill j1-brain's run.
- `pnpm -r build`: "packages/router build: Done", "apps/panel build: Done".
- Line endings: my Python patch scripts had written CRLF into 11 files. I converted them back to
  LF (byte counts checked), so `git diff` shows no CRLF warnings for my files.

Coverage of `tests/projects-surfaces.test.ts` (8 tests):
- **Selection.**
  - Flag, environment, only project, cwd, innermost repository, and archived handling.
  - The ambiguous error lists the projects, and the same folder in two projects is ambiguous.
  - Unknown flag or environment.
  - `repoFlags`, and `initConfigText` on the presets and on the legacy shape.
- **CLI, two projects** (spawns `dist/cli.js`):
  - `submit` outside every repository fails and lists the projects.
  - `--project`, the cwd inside `alpha-app`, and `SWITCHYARD_PROJECT` each place the task in
    the right project.
  - `status` lists all projects, or the flag's or the cwd's.
  - `cancel <beta task> --project alpha` is refused.
  - `blame` works with `--project beta`.
  - `doctor` shows per-project checks, and `--project` limits them.
- **CLI, legacy config.**
  - `projects create` with a missing repository, or with a slug that already exists, fails.
  - `projects create shop --repo web=web` converts the legacy config to exactly
    `{demo: {repositories: {core}}, shop: {name, repositories: {web}}}`. The result parses.
  - The brain folder and `.bak` exist.
  - `projects list` counts show the old task still in `demo`.
  - Archive is refused for `demo` (queued task) and works for `shop`.
  - With `shop` archived, `demo` is the only live project, so `submit` needs no flag.
  - Unarchive works.
- **`init --project shop --repo web=../web`**: writes `projects.shop` and `brain.project: shop`,
  with no top-level repositories. The result parses.
- **MCP, two projects** (spawns `dist/mcp.js`):
  - `--project beta --no-worker`: the task lands in `beta` and stays `queued` after 1.5 s.
  - A tool's `project` input overrides the default. Status defaults to `beta`, and an `alpha` id
    reads `unknown`.
  - The brain working document lands under `projects/beta/`.
  - `SWITCHYARD_PROJECT=alpha` selects `alpha`, and the cwd in `beta-app` selects `beta`.
  - With no way to choose, the server exits 1 with the list of projects.
- **Admin, two projects** (alpha: 2 tasks and 1 job with a question; beta: 1 task; requests
  charged through `request_charges` with paid spend, plus one unattributed request):
  - Grid counts and attention.
  - Global dashboard: per-project requests, paid spend, and queues; unattributed usage; totals
    `requests: 4, paidSpendUsd: 0.75`; jobs; attention.
  - Project overview for beta and for alpha.
  - `requestLog` across all projects and per project; `jobsView` and `sessionsView` per project.
  - `globalSettings` and `projectSettings` (beta's overrides vs alpha's defaults).
  - `patchProjectSettings` refuses a global key and a non-overridable team key, and writes
    `projects.beta.team.max_agents` (live after reload, alpha unaffected).
  - `createProject` refuses a bad slug and creates `gamma`.
  - Archive is refused for alpha (queued) and hides gamma from the grid and the dashboard.

## Not verified

- The full suite is not green because of the 2 j1-brain failures above. My single run of
  `tests/projects-brain.test.ts` alone was still running in the background when I wrote this. I
  did not judge whether those tests depend on anything of mine; by grep, they import nothing
  from `src/admin`, `src/cli`, or `src/mcp.ts`.
- No live provider, no real Claude Code client over MCP, and no daemon running beside an MCP
  started with `--no-worker`.
- The panel was not started or screenshotted; only the build ran. No panel page uses the new
  functions yet (that is J2).
- `createProject` while another process (a daemon worker) has the config open: the other
  process reloads within about 2 s by mtime. The panel's own process reloads synchronously. Not
  exercised.
- `sessionsView` with a project reads up to 1000 sessions from the store and then filters (the
  session store has no project filter, and `src/sessions` is not mine). A project with older
  sessions beyond the newest 1000 of the install may list fewer than `limit`.
- Windows-only: cwd matching is case-insensitive. The POSIX branch ran only through
  `path.resolve` in the unit test on Windows.

## Open questions or contradictions found

1. The MCP refuses to start when no project can be chosen (several projects, and a cwd outside
   all of them). The alternative is to start with tools requiring `project`. I chose fail-fast
   so that a wrong default never writes into the wrong project; the supervisor may prefer the
   other behaviour.
2. The brief says the CLI takes "flag, then the only project, then the cwd"; D8 gives the MCP
   "flag, env, cwd". I applied one order to both: flag, `SWITCHYARD_PROJECT`, only project, cwd.
   The CLI therefore also honours the environment variable.
3. Converting a legacy config in `projects create` leaves its top-level `brain.mounts` and its
   section values (`verification`, `team`, and others) global. They now apply to every project,
   not only to the old one. To scope them to the old project, they would have to move under
   `projects.<slug>` as overrides; I did not do that.
4. The archive state lives only in the `projects` table, not in the config, so the panel and CLI
   of another install that shares the config but not the storage will not see it. That cannot
   happen within one install.
5. J3 docs: `docs/setup.md` and the other docs still describe top-level `repositories` for new
   installs. The example config and the presets now use `projects.my-project`.
