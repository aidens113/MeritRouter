# Projects (one install, many projects)

Status: Active
Status detail: Plan written 2026-10-20; waiting for the user's go-ahead before J1.
Created: 2026-10-20
Last updated: 2026-10-20
Owner: Senior supervisor agent
Scope: SwitchYard becomes project-based: one install holds many projects, each with its own repositories, brain scope, jobs, tasks, sessions, and teams; providers, models, routing, budgets, and settings stay global; one worker runs every project at once with fair scheduling; the panel opens on a projects grid, has a project switcher, per-project pages, and a global dashboard.
Paired document: none
Related: [direct providers](./direct-providers.md), [roles](../roles.md), [operations](../operations.md), [decisions](../decisions.md)

---

## Current State

**Requirement (user, 2026-10-20):** the starting screen is a projects grid; creating a project
takes the user to its panel; a project switcher sits top left. Knowledge base, jobs, and the rest
are per project. Several projects run at once. A global dashboard (with Settings and the other
global pages) shows all projects and their jobs.

**What exists today (code map 2026-10-20, file:line evidence in the ledger entry):**
- One config file = one storage directory = one SQLite DB = one brain project
  (`config/load.ts:57`, `core/service.ts:117-123`). No table has a project column.
- Global state (vault and master key, catalog, provider key state, rate-limit usage, AIMD slots,
  breakers, paid spend, allocation) lives in that per-config DB, so two configs would each believe
  they own the whole quota and paid budget.
- `cfg` is threaded everywhere as the project context: `repositoryPaths`, `brain.project`/`mounts`,
  `verification`, `team`, `coding.allowed_commands`/`protected_paths`,
  `supervisor.allowed_commands`/`branch_prefix`, `roles`.
- The brain repository is already multi-project on disk (`projects/<p>/...`, `global/...`), but a
  `Brain` instance is bound to one project and supervisors read `**` (every project).
- Claiming is FIFO across the store with global caps (`storage/tasks.ts:243-257`); no fairness.
- Repo aliases are bare strings in `tasks.writable_repo`, `file_leases.repository`,
  `merge_queue.lock_key`: two projects with an `app` alias would collide.
- MCP: one process = one config = one in-process worker, fixed effort `claude-code`.
- Panel: one global `Switchyard` from `SWITCHYARD_CONFIG`, flat 13-item nav, no project concept.

**Next steps:** user go-ahead, then J1 (`j1-core` first; then `j1-scheduling-brain` and
`j1-surfaces` in parallel), then J2 (panel), then J3 (operations, demo, docs). The settings-nav
fix (on `feat/settings-nav`) merges first because J2 rewrites the settings page.

**Blockers:** user go-ahead on the decisions below (each has a recommended default).

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
  when it is created; FTS index stays global with a project column for filtering.
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
| J1 | Router: projects area, config schema and legacy upgrade, migration, `ProjectContext` threaded through executor/runners/brain, fair scheduler, CLI `--project` and `projects`, MCP `--project`/`--no-worker` | Two projects with the same repo alias run concurrently in one worker with no lease or merge collision; fairness test (a 50-task backlog in A does not starve B); brain isolation test; legacy config upgrades with all old rows in the one project; full suite green |
| J2 | Panel: projects grid, create flow, switcher, per-project routes, global dashboard, settings split, redirects | Demo seed with 3 projects; every page 200; screenshots of grid, switcher open, project overview, global dashboard, create flow |
| J3 | Operations and docs: one daemon/service serves all projects, backup includes the brain, setup/operations/roles/decisions, presets | `init` → create two projects → worker runs both (manual run recorded); docs describe projects |

---

## Worker Briefs

Written at dispatch, after the user's go-ahead. Partition: `j1-core` owns `src/projects/**`,
`src/config/**`, `src/storage/**`, `src/core/**`, `src/runners/**`, `src/context/**`; then
`j1-scheduling-brain` (`src/storage/tasks.ts` claim, `src/core/scheduler.ts`, `src/brain/**`) and
`j1-surfaces` (`src/cli*`, `src/mcp.ts`, `src/admin/**`) in parallel; J2 owns `apps/panel/**`.

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

---

## Open Questions

- D2: project settings in the global config file (recommended) or a file inside each project's
  repository? The latter travels with the repo but splits settings across many files.
- D4: is cross-project brain reading ever wanted by default (e.g. a "shared lessons" project)?
  `global/` already covers shared lessons.
