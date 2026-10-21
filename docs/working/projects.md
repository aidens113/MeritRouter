# Projects (one install, many projects)

Status: Active
Status detail: J1-J3 done, verified, and merged to dev and main 2026-10-20. Remaining: live use with real providers; follow-ups in Current State.
Created: 2026-10-20
Last updated: 2026-10-20
Owner: Senior supervisor agent
Scope: SwitchYard becomes project-based: one install holds many projects, each with its own repositories, brain scope, jobs, tasks, sessions, and teams; providers, models, routing, budgets, and settings stay global; one worker runs every project at once with fair scheduling; the panel opens on a projects grid, has a project switcher, per-project pages, and a global dashboard.
Paired document: none
Related: [direct providers](./direct-providers.md), [roles](../roles.md), [operations](../operations.md), [decisions](../decisions.md)

---

## Current State

**Done (2026-10-20), merged to `dev` and `main`.** SwitchYard is project-based:
- Projects live under `projects.<slug>` in the global config (D2); a single-project config is read
  as one project (D3). Per-project data carries `project_id`; repository leases and merge locks
  are namespaced per project (D6). Each task runs under its project's `ProjectContext`.
- One worker serves every project with weighted round-robin claiming; optional per-project
  `priority`, `max_concurrent_tasks`, `paid_budgets`, `request_share` (D5, D7) with their own
  waiting and denial reasons.
- Brain: agents read their project plus `global/` (D4); only supervisors promote to `global/`,
  through a project-specificity check and an independent review on a different model, with
  rejections kept in the project, provenance recorded, optional human approval, and revert (D9).
  Each project has its own brain index.
- CLI `--project` / `SWITCHYARD_PROJECT`, `projects list|create|archive|unarchive`,
  `init --project`; MCP `--project`, `--no-worker`, refuses to start without a choosable project
  (D8); one daemon/service for all projects; backups include the brain.
- Panel: projects grid at `/`, create flow, switcher top left, project pages under `/p/<slug>`,
  global pages under `/all` (dashboard, requests, models, routing, keys, qualification,
  calibration, knowledge, settings); archived projects open only their settings.
- Internal qualification work runs in the reserved project `_qualification`, viewed under
  `/all/qualification`, never shown as a project.
- Docs: `setup.md`, `operations.md`, `roles.md`, `decisions.md`, README.

**Not verified:** live providers; a real Claude Code client on the MCP; `service install` on real
service managers; multi-process claiming and promotion settling; eval-goal comparisons in the
panel (none in the demo); several client-side forms only exercised through their API routes.

**Known flaky under full-suite load (pass alone and on rerun):** `projects-brain` end-to-end
promotion review; `session-recording` classifier batching; `operations` daemon stop. Each waits
on real timers; making them deterministic is a follow-up. Note: the J2/J3 validation runs shared
the machine with two hung `projects-brain` vitest runs (26 processes, left by an early looping
version of j1-brain and stopped at handoff), so the measured flake rate is likely overstated.

**Follow-ups (minor):** the switcher shows an archived project's slug, not its name; the archived
settings page's name field does not look read-only; a restore whose brain step fails leaves the
store restored and the brain not; alias matching in D9 is strict (an `app` alias rejects
"the app").

**In progress, paused by the user (2026-10-21):** branch `feat/repo-autoprep`, worktree
`D:/sy-wt/rp`, not merged. Two user requests: (1) project repositories are prepared automatically
(missing folder created, git initialised with an initial commit, a default `.gitignore` for plain
folders; runs on project/repository creation and at service start; the "missing or not a git
repository" attention item replaced by an info notice); committed as unverified WIP (2d961a3),
its worker was stopped before reporting. (2) The Live control is a status chip plus a separate
"Pause updates" button with a confirmation dialog (`ConfirmDialog`); done and checked in Chrome
(8ccb935). To finish: read `docs/working/reports/repo-autoprep.md` on that branch, run
typecheck, build, the full suite, and a demo panel check, then merge to `dev` and `main`.

**Next steps:** finish `feat/repo-autoprep`; then caching-and-continuity (C1, C2); then the live
check with real keys.

**Blockers:** none.

---

## Decisions (recommended defaults; the user may override)

- **D1. One install, one global store.** Projects are rows in the existing DB (approach A of the
  code map), not separate DBs. Shared state (keys, catalog, usage, slots, breakers, spend) stays
  shared for free; per-project data gains a `project_id`. Separate DBs would break the
  `provider_slots` join on tasks, the allocation count, and paid budgets.
- **D2. Project settings live in the global config file** under `projects.<slug>` (name,
  repositories, brain mounts and access, and per-project overrides of verification, team policy,
  coding/supervisor allowed commands and protected paths, branch prefix, roles/charters). The panel
  writes them through the existing config editor, so "every setting is editable in the panel or the
  file" still holds. Global sections stay where they are.
- **D3. Upgrade is automatic.** A config with top-level `repositories`/`brain.project` and no
  `projects` section is read as one project named `brain.project` (default `my-project`); existing
  rows get that project id on first start. Nothing for the user to do.
- **D4. Brain isolation.** A project's agents read `projects/<own>/**` and `global/**` only; the
  `**` default supervisor grant narrows accordingly. Cross-project reads go through the existing
  access-request flow.
- **D5. Fairness.** One worker serves all projects. Claiming round-robins across projects with
  ready tasks (oldest first within a project); optional per-project `max_concurrent_tasks` and
  `priority` weight. Global caps and provider capacity still apply on top.
- **D6. Repo aliases are per project.** Internally a repository is `<project>/<alias>` in leases,
  merge locks, and `writable_repo`; users keep writing the bare alias inside a project.
- **D7. Budgets.** Paid budgets and allocation stay global; an optional per-project paid cap and
  request share are added in J1 as config fields (unset = no per-project limit).
- **D9. Global knowledge (user, 2026-10-20).** Only supervisor agents (and people) may add to
  `global/`; workers never can (no grant, and `promoteLesson` already refuses non-supervisors).
  A supervisor's addition must be truly global-worthy, enforced in code, not by prompt text:
  (a) a deterministic check rejects text naming the project's slug or name, its repository
  aliases or paths, or file paths inside them, and requires at least one cited source in the
  project's brain; (b) an independent reviewer (a different model from the supervisor's, through
  the existing verification reviewer machinery) judges "applies beyond this project" against a
  fixed rubric; (c) a rejected promotion is saved as a project lesson
  (`projects/<p>/decisions/lessons/`) with the reason, so nothing is lost; (d) every global entry
  records its project, supervisor, sources, and reviewer verdict, and the panel lists global
  additions with a revert. Optional `brain.global_requires_approval` adds human approval in the
  panel (default off).
- **D8. MCP.** `mcp.js --project <slug>` (or `SWITCHYARD_PROJECT`, or inferred when the cwd is
  inside one of a project's repositories); `--no-worker` when the daemon already runs a worker.
  Brain effort becomes per project.

---

## Design

### Router
- `src/projects/` (new area): project registry from config (`projects.<slug>` + the legacy
  shape), zod schema, `ProjectContext` = the global `ResolvedConfig` overlaid with the project's
  overrides, resolved repository paths, and its brain view. `projectFor(taskId)` resolves a task's
  context; runners, executor, validate, context sources, Brain, and BrainAccess take a
  `ProjectContext` instead of reading project fields off the global `cfg`.
- Storage: one appended migration adds `project_id TEXT NOT NULL DEFAULT ''` to `tasks`,
  `job_state`, `sessions`, `brain_access_requests`, `brain_grants`, `job_plans`, `events`
  (nullable for global events), `model_requests` (attribution), and namespaces repo aliases in
  `tasks.writable_repo`, `workspaces.repo_alias`, `file_leases.repository`, `merge_queue`. Tables
  hanging off a task inherit its project through the task id. A `projects` table records created,
  archived, and last-active times (settings stay in config).
- Service API: task, job, session, question, and usage calls take an optional project; panel and
  CLI pass it; no project means "all" for reads and is an error for writes.
- Scheduler: fair claim per D5; prompt batching never mixes projects.
- Brain: one `Brain` per project over the same repository; `ensure()` creates a project's folders
  when it is created; FTS index stays global with a project column for filtering. Default grants
  per D4 (supervisor reads `projects/{project}/**` and `global/**`); global writes only through
  the gated promotion of D9.
- CLI: global `--project` flag (default: the only project, or the one whose repository contains
  the cwd); `projects list|create|archive`; `init` writes a global config plus a first project.
- MCP: per D8.

### Panel
- `/`: projects grid (name, repositories, running and queued jobs, last activity, attention
  badges) with "New project" (name, slug, repositories with a path check, optional brain mounts);
  creating one opens `/p/<slug>`.
- Project switcher top left (replacing the brand link): current project, every project with a
  live-activity dot, "All projects" (the global dashboard), "New project".
- Per-project pages under `/p/<slug>/`: Overview, Jobs, Teams, Tasks, Sessions, Requests (this
  project's), Brain, Project settings (repositories, brain, per-project overrides).
- Global pages: Dashboard (every project's running jobs, queues, attention items, usage and spend
  by project), Requests (all), Models, Routing, Provider keys, Qualification, Calibration,
  Settings (global sections only).
- Data access: `insights.*` take a project scope; mixed views (overview, requests, settings)
  split into global and per-project functions.
- Old URLs (`/jobs`, `/tasks`, ...) redirect to the last-used project's page.

---

## Phases

| Phase | Deliverable | Acceptance |
| --- | --- | --- |
| J1 | Router: projects area, config schema and legacy upgrade, migration, `ProjectContext` threaded through executor/runners/brain, fair scheduler, CLI `--project` and `projects`, MCP `--project`/`--no-worker` | Two projects with the same repo alias run concurrently in one worker with no lease or merge collision; fairness test (a 50-task backlog in A does not starve B); brain isolation test; D9 tests (worker
cannot write `global/`; a project-specific lesson is rejected to the project; a generic one with a
passing review lands with provenance); legacy config upgrades with all old rows in the one project; full suite green |
| J2 | Panel: projects grid, create flow, switcher, per-project routes, global dashboard, settings split, redirects | Demo seed with 3 projects; every page 200; screenshots of grid, switcher open, project overview, global dashboard, create flow |
| J3 | Operations and docs: one daemon/service serves all projects, backup includes the brain, setup/operations/roles/decisions, presets | `init` → create two projects → worker runs both (manual run recorded); docs describe projects |

---

## Worker Briefs

Branch/worktree: `feat/projects` at `D:/sy-wt/pj`. Partition: `j1-core` first; then
`j1-scheduling-brain` and `j1-surfaces` in parallel; J2 owns `apps/panel/**`.

### Brief: j1-core
- Task: `src/projects/` (registry from `projects.<slug>` config plus the legacy single-project
  shape per D3, zod schema, `ProjectContext` = global config overlaid with the project's
  overrides, resolved repository paths); config schema `projects` section; one appended migration
  (`projects` table; `project_id` on `tasks`, `job_state`, `sessions`, `brain_access_requests`,
  `brain_grants`, `job_plans`, `events` (nullable), `model_requests`; repo aliases namespaced
  `<project>/<alias>` in `tasks.writable_repo`, `workspaces.repo_alias`, `file_leases.repository`,
  `merge_queue`; backfill existing rows to the legacy project); tasks carry their project from
  submit; executor, runners, validate, context sources resolve the task's `ProjectContext`
  instead of project fields on the global `cfg`; service keeps one `Brain` per project (built
  from the project context; no `src/brain` edits); service API task/job/session/question/usage
  calls take an optional project (reads: all when omitted; writes: required unless exactly one
  project exists). CLI, MCP, admin, panel: minimal changes to compile and keep tests passing.
- Owns: `src/projects/**`, `src/config/**`, `src/storage/**` (not the claim query's fairness,
  which is j1-scheduling-brain's), `src/core/**`, `src/runners/**`, `src/context/**`,
  `src/harness/**` (only for project context), minimal compile fixes elsewhere, new
  `tests/projects.test.ts`, existing tests only where signatures change.
- Done: two projects with the same repo alias run concurrently in one worker with no lease or
  merge collision; a legacy config upgrades with every old row in its one project; a task's
  runner sees only its project's repositories; full suite green.
- Report to: docs/working/projects/reports/j1-core.md

### Brief: j1-fairness (after j1-core; parallel with j1-brain, j1-surfaces)
- Task: D5 fair claiming (round-robin across projects with ready tasks, oldest first within a
  project; per-project `max_concurrent_tasks` and `priority` weight); prompt batching never mixes
  projects; D7 optional per-project paid cap and request share enforced at admission; config
  fields in `src/projects/schema.ts`.
- Owns: claim code in `src/storage/tasks.ts`, `src/core/scheduler.ts`, `src/projects/schema.ts`,
  `src/admission/**`, `src/paid/spend.ts`, new `tests/projects-fairness.test.ts`.
- Report to: docs/working/projects/reports/j1-fairness.md

### Brief: j1-brain (after j1-core; parallel)
- Task: D4 default grants (supervisor reads `projects/{project}/**` + `global/**`, writes its
  project); D9 gated global promotion (supervisor-only; deterministic project-specificity check;
  independent reviewer on a different model via the verification reviewer machinery; rejection
  saved as a project lesson with the reason; provenance front matter; optional
  `brain.global_requires_approval`); brain FTS filtered by project; the supervisor tool that
  promotes lessons uses the gate.
- Owns: `src/brain/**`, `src/harness/supervisor-tools.ts` (promotion tool only),
  `src/verification/**` (only to expose a reviewer call), new `tests/projects-brain.test.ts`.
- Report to: docs/working/projects/reports/j1-brain.md

### Brief: j1-surfaces (after j1-core; parallel)
- Task: CLI global `--project` (default: the only project, else the one whose repository contains
  the cwd, else an error listing projects), `projects list|create|archive`, `init` writes a
  global config plus a first project, `doctor` per project; MCP `--project` /
  `SWITCHYARD_PROJECT` / cwd inference, `--no-worker`, per-project brain effort; `src/admin/**`
  functions take a project scope and global/per-project splits of overview, requests, settings
  (the API J2 builds on).
- Owns: `src/cli.ts`, `src/cli/**`, `src/mcp.ts`, `src/admin/**`, new
  `tests/projects-surfaces.test.ts`.
- Report to: docs/working/projects/reports/j1-surfaces.md

Shared by all three: `src/core/service.ts` and `src/index.ts` (small separate hunks only;
re-read immediately before editing). Each runs its own tests and typecheck while working and the
full suite at the end; failures only in another worker's files are re-run later and reported.

### Brief: j2-structure (J2 step 1)
- Task: the panel's frame. `/` becomes the projects grid (cards from `insights.projectsGrid`:
  name, repositories, running/queued jobs, last activity, attention badge) with "New project"
  (name, slug derived and editable, repositories with a server-side path/git check, optional brain
  mounts) via `insights.createProject`; creating one navigates to `/p/<slug>`. Project switcher
  top left in the shell (replaces the brand link): current project or "All projects", every
  project with a live-activity dot, "All projects", "New project"; the sidebar shows project pages
  inside a project and global pages in "All projects". Move per-project pages under
  `apps/panel/app/p/[slug]/` (overview, jobs, teams, tasks, sessions, requests, brain, settings
  placeholder) passing the project to `insights.*`; global pages under `/all/` or top level (decide
  and record): dashboard placeholder, requests, models, routing, keys, qualification,
  calibration, settings. Old URLs (`/jobs`, `/tasks/...`, ...) redirect to the last-used project
  (cookie) or `/`. The panel's `getSy()` stays one instance; a `project(slug)` helper 404s unknown
  or archived projects. Fix `/api/config` `expand()` when the YAML has no `providers:` section.
- Owns: `apps/panel/**` (pages, components, lib, api routes), `scripts/seed-demo.mjs` (seed 3
  projects: two sharing an `app` alias, one archived), new admin functions only if J1's API lacks
  something (record which).
- Done: typecheck, build; demo seeded; every page 200 (old URLs redirect); screenshots of the
  grid, switcher open, create flow, a project overview, the global section; panel stopped.
- Report to: docs/working/projects/reports/j2-structure.md

### Brief: j2-global (J2; parallel with j2-project, j2-router)
- Task: `/all` global dashboard (from `insights.globalDashboard`: every project's running and
  queued jobs, queues, attention items with links into the project, usage and paid spend by
  project, worker status, provider health); `/all/settings` shows only global sections
  (project-level sections move to project settings); `/all/knowledge`: the global brain's
  entries with provenance (project, supervisor and model, sources, reviewer verdict and model),
  pending promotions awaiting a person (when `brain.global_requires_approval`) with approve and
  reject, and revert of a global entry (a brain commit removing it, recorded).
- Owns: `apps/panel/app/all/**` (not `all/keys`), new `apps/panel/app/api/promotions/**`,
  `src/admin/dashboards.ts`, new `src/admin/promotions.ts`, its export line in
  `src/admin/insights.ts`, new `tests/admin-promotions.test.ts`.
- Report to: docs/working/projects/reports/j2-global.md

### Brief: j2-project (J2; parallel)
- Task: `/p/<slug>/settings` real: name, repositories (add, remove, writable, path check), brain
  mounts and access, per-project overrides (verification, team, coding/supervisor allowed
  commands, protected paths, branch prefix, roles) and the fairness fields (`priority`,
  `max_concurrent_tasks`, `paid_budgets`, `request_share`), archive/unarchive; saving through
  `insights.patchProjectSettings`. The project Brain page uses the per-project index (from
  j2-router; fall back to the filtered tree until it lands) and lists this project's promotions
  with status and reason.
- Owns: `apps/panel/app/p/[slug]/settings/**`, `apps/panel/app/p/[slug]/brain/**`,
  `apps/panel/app/api/projects/**`, `src/admin/project-settings.ts`, new
  `tests/admin-project-settings.test.ts`.
- Report to: docs/working/projects/reports/j2-project.md

### Brief: j2-router (J2; parallel)
- Task: qualification repositories in the projects layout (`src/qualification/registry.ts` adds
  fixture repos to the global `repositoryPaths`, which a project context hides: make qualification
  tasks run in a context that sees them, and audit every remaining reader of the global
  `repositoryPaths`/`repositories`); a per-project brain index (`projects/<p>/README.md`,
  regenerated like the root one; the root index lists only `global/` and project names; MCP
  `brain_list` text updated); a waiting reason for tasks held by a project's
  `max_concurrent_tasks`, shown where slot and lease waits are; distinct denial reasons for a
  project's paid cap and request share (`project_paid_budget_exhausted`,
  `project_allocation_exhausted`) through `core/errors.ts` and `core/disposition.ts`.
- Owns: `src/qualification/**`, `src/brain/**`, `src/mcp.ts` (brain_list text only),
  `src/core/errors.ts`, `src/core/disposition.ts`, `src/storage/tasks.ts`,
  `src/storage/fair-claim.ts`, `src/admission/**`, new `tests/projects-router-fixes.test.ts`.
- Report to: docs/working/projects/reports/j2-router.md

Shared: `src/core/service.ts`, `src/index.ts`, `src/admin/insights.ts` (small separate hunks,
re-read before editing). Each runs its own tests while working and the full suite at the end.

### Brief: j2-followups (parallel with j3-ops-docs)
- Task: `apps/panel/app/p/[slug]/jobs/[id]/page.tsx` reads the global repository map (empty with
  projects): use the job's project. `_qualification` never appears as a project on `/all`,
  `/all/requests`, or anywhere a user picks projects; qualification and comparison tasks and runs
  are viewable under `/all/qualification` (task detail there; `/tasks/<id>` of a `_qualification`
  task redirects there). `Brain.remove()` with the brain's lock protocol, and
  `admin/promotions.ts` revert uses it (no copied lock code); a `reverted` promotion status set by
  the revert and shown on the project Brain page and `/all/knowledge`. An archived project's
  `/p/<slug>/settings` renders (read-only except Unarchive). Removing a repository is refused
  while queued or running tasks use its alias; brain mount folders must exist when saved.
- Owns: `apps/panel/**`, `src/brain/**`, `src/admin/**`, `src/projects/**`, new
  `tests/projects-followups.test.ts`.
- Report to: docs/working/projects/reports/j2-followups.md

### Brief: j3-ops-docs (parallel with j2-followups)
- Task: operations for many projects: one daemon/service runs one worker for every project
  (`daemon`, `service install` take the global config; no per-project daemons); backup includes
  the brain repository (a git bundle) as well as the store; restore covers it. Docs: `setup.md`
  (projects from the first run: `init --project`, the grid, create, switcher, MCP `--project` /
  `--no-worker`), `operations.md` (fairness fields, per-project limits and their denial reasons,
  waiting reasons, archiving, backup of the brain), `roles.md` (D4 isolation, D9 gated global
  knowledge, promotions), `decisions.md` (D1-D9 of this plan and the J deviations recorded in the
  reports), README.
- Owns: `src/operations/**`, `src/cli/operations.ts`, `docs/setup.md`, `docs/operations.md`,
  `docs/roles.md`, `docs/decisions.md`, `README.md`, new `tests/projects-operations.test.ts`.
- Report to: docs/working/projects/reports/j3-ops-docs.md

---

## Work Ledger

### 2026-10-20 — Plan written
- Agent: supervisor (code map by an Explore agent)
- Changed: this document; `docs/working/README.md`.
- Why: user requirement for project-based SwitchYard.
- Validation: not validated (design only). Code-map evidence: `config/load.ts:57`,
  `core/service.ts:117-123`, `storage/tasks.ts:243-257`, `gateway/capacity.ts:130-132`,
  `brain/brain.ts:109-126`, `brain/access.ts:28`, `mcp.ts:19-22`, `apps/panel/lib/sy.ts:11-29`,
  `apps/panel/components/client/shell.tsx:31-45`.
- Outcome: Accepted
- Follow-up: user go-ahead; J1.

### 2026-10-20 — j1-core
- Agent: worker j1-core; verified by supervisor
- Changed: `src/projects/{schema,resolve,context,registry,backfill}.ts`; config schema/load;
  migration (projects table, `project_id` columns, insert triggers); `storage/tasks.ts`, `usage.ts`;
  `core/{service,executor,scheduler}.ts`; `routing/router.ts`; `workspaces/merge-queue.ts`;
  `verification/audit.ts`; `admin/job-plans.ts`; `tests/projects.test.ts`. Details:
  [report](./projects/reports/j1-core.md).
- Why: J1 core.
- Validation: supervisor ran `pnpm -r typecheck` (router and panel Done), `pnpm -r build` (both
  Done), `npx vitest run` (`Tests 404 passed (404)`); checked slug and alias regexes exclude `/`.
- Outcome: Accepted
- Follow-up: j1-fairness, j1-brain, j1-surfaces. Note: writing a non-overlaid field through a
  `ProjectContext` writes the global config (by design of the proxy).

### 2026-10-20 — j1-fairness, j1-brain, j1-surfaces (J1 complete)
- Agent: three parallel workers; verified by supervisor
- Changed: see the three reports; shared hunks in `core/service.ts` and `index.ts`.
- Why: J1.
- Validation: supervisor ran `pnpm -r typecheck` (router and panel Done), `pnpm -r build` (both
  Done), `timeout 480 npx vitest run` (exit 0, `Tests 429 passed (429)`); manual CLI in a temp
  dir: `init --project alpha`, `projects create beta` with the same `app` alias, `projects list`
  showed both. Stopped two stale vitest processes left by j1-brain's early looping version.
- Outcome: Accepted
- Follow-up: J2; the carried items in Current State.

### 2026-10-20 — j2-structure, j2-global, j2-project, j2-router
- Agent: four workers (structure first, then three in parallel); verified by supervisor
- Changed: see the four reports under `projects/reports/`. Supervisor: a 90 s timeout on the
  end-to-end promotion review test (its wait is 60 s; the suite default is 30 s).
- Why: J2 panel and the router fixes it needed.
- Validation: supervisor ran `pnpm -r typecheck` (both Done), `pnpm -r build` (both Done),
  `timeout 540 npx vitest run` (`Tests 468 passed (468)`); reseeded the demo ("Demo ready"),
  production panel on :4591: `/`, `/new`, `/p/demo/{,jobs,tasks,sessions,brain,settings}`,
  `/p/storefront{,/settings}`, `/all/{,settings,knowledge,models,keys,requests,qualification}`
  200; `/p/legacy-billing` (archived) 404; `/jobs` 307; `/models` 308; screenshots of the grid,
  switcher (desktop and phone), project overview, create errors, `/all`, `/all/knowledge`,
  project settings checked; panel stopped.
- Outcome: Accepted
- Follow-up: `j2-followups`, `j3-ops-docs`.

### 2026-10-20 — j2-followups, j3-ops-docs, supervisor fixes (effort complete)
- Agent: two parallel workers; supervisor fixes
- Changed: see the two reports. Supervisor: repository removal also blocked by interrupted and
  other unfinished tasks (test extended); `init --project` names the project after its slug;
  example config shows the per-project fields; presets regenerated.
- Why: J2 follow-ups and J3.
- Validation: `pnpm -r typecheck` (router and panel Done); `pnpm -r build` (both Done);
  `npx vitest run` five full runs: `Tests 477 passed (477)` in three, one run failed only
  `projects-brain` end-to-end review (passed in the next three), one failed only
  `session-recording` classifier batching (known timing test); `init --project alpha` wrote
  `name: alpha`; demo panel: `/`, `/all`, `/all/qualification`, `/all/knowledge`,
  `/all/requests`, `/p/demo/jobs`, `/p/legacy-billing/settings` 200, `/p/legacy-billing` 404, no
  `_qualification` project shown, a reverted entry shown; archived settings screenshot checked.
- Outcome: Accepted
- Follow-up: the follow-ups and flaky tests in Current State.

---

## Open Questions

- D2: project settings in the global config file (recommended) or a file inside each project's
  repository? The latter travels with the repo but splits settings across many files.
- D4: is cross-project brain reading ever wanted by default (e.g. a "shared lessons" project)?
  `global/` already covers shared lessons.
