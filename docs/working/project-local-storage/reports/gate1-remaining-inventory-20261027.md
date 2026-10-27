# Gate 1 remaining inventory (project ownership and storage)

Worker: gate1_inventory (worker-heavy, read-only). Date: 2026-10-27.
Paths are relative to `packages/router/src` unless stated. Evidence is source reads/greps plus one
`tsc --noEmit` (router). No tests run, no source/test/shared-doc edits.

## Outcome

The split-store building blocks (S0-S6d, C3) are committed but **nothing in production constructs
them**. A fresh `setup` + project creation today writes every project-owned byte under the
installation root. Activation is a composition-root job (service.ts) plus provisioning, deletion,
backup and migration work that has not started (no S7-S11 tests exist).

## 1. What a fresh install does today (implemented but not activated)

| Item | Where it lands today | Evidence |
| --- | --- | --- |
| Config | `%LOCALAPPDATA%/MeritRouter/meritrouter.config.yaml` | config/load.ts:31-36, 42-54 |
| SQLite DB (tasks, sessions rows, requests, Labs rows, vault) | `<configDir>/.meritrouter/` (default `storage.directory`), durability `normal` | config/schema.ts:781,787; load.ts:80; core/service.ts:183-192 |
| Session logs, artifacts | `<storageDir>/sessions`, `<storageDir>/artifacts` | service.ts:185-186; sessions/store.ts:162; storage/artifacts.ts:34 |
| Task/supervisor worktrees, agent homes | `<storageDir>/worktrees`, `<storageDir>/agent-home` | runners/coding/finish.ts:32,56,74; runners/supervisor.ts:154 |
| Task-attempt Lab sources | `<storageDir>/worktrees` | labs/task-attempt-source.ts:42; runners/coding/task-lab.ts:108 |
| Named Labs (new) | `<projectDir>/.MeritRouter/labs/<slug>/<name>`; refused if the project has no directory | labs/lab.ts:355-372 (only path that is already project-local) |
| Brain | setup: `<configDir>/.meritrouter/brain`; init: `~/.meritrouter/brain`; one repository shared by all projects, non-project mode | cli/setup.ts:35; schema.ts:514; service.ts:308 (no `project` option) |
| Request accounting | legacy `SqliteRequestLedger` on the one DB | service.ts:223; gateway/gate.ts:247 |
| Scheduler/executor | legacy `Scheduler`/`Executor` over the installation stores | service.ts:234,277 |
| Project creation | writes `projects.<slug>.repositories` only: no `directory`, no UUID/identity, no local DB, no registration, no `project.json` | admin/projects.ts:229-265; `CreateProjectInput` (185-192) has no directory |
| Project directory | inferred only when exactly one repository exists; `setup` with no repos gives `null` | projects/resolve.ts:56-58; cli/setup.ts:34 |

Dormant pieces with no production caller: `initializeStoreRole` (storage/store-role.ts:67),
`registerProjectStore`/`retireProjectStoreRegistration` (projects/store-identity.ts:58,77),
`MeritRouter.createProjectRuntimeRegistry` (service.ts:375, which refuses unless the installation
DB already has a coordination identity, and nothing writes one), `ProjectScheduler`
(core/project-scheduler.ts:22), `createProjectRunServices` (core/project-services.ts),
`runtimeWorkspacePath`/compact v2 manifest (projects/runtime-paths.ts:148; no callers at all).
`projectStores()` is still the same-DB handle (service.ts:388-393; runtime-store.ts:221).

## 2. Ordered remaining steps

Each wave runs in parallel. Rows within a wave own disjoint files. Waves are serial. Every test
uses OS-temp config/project roots and fake providers.

**Wave A: independent modules, no service.ts edits (parallel)**

A1 Provisioning (new). Owns: new `projects/store-provision.ts`, new `tests/project-store-provision.test.ts`.
`provisionProjectStore(coordinationDb, slug, projectDirectory)`: validate the directory
(`validateRuntimeLocation`), mkdir `.MeritRouter/state`, open the DB with `durability:"full"`,
`initializeStoreRole(project)`, write the v2 `project.json`, then `registerProjectStore` as the last
step. Re-running after a crash must adopt or refuse an orphan local store, never create a second
identity. Refuse a project directory equal to, inside, or containing the installation config or
storage directory. Accept: crash injection between each step; slug recreation gets a new UUID;
`.MeritRouter` lands in the repository's Git exclude. Risk: medium.

A2 Project backup/restore. Owns: `operations/backup.ts`, new `operations/project-backup.ts`, new
`tests/project-backup.test.ts`. Back up a project with the SQLite backup API on
`<project>/.MeritRouter/state` plus its sessions, artifacts and brain. Restore checks the
identity and generation against the registration and refuses a live lease. The installation
backup must hold coordination data only. Accept: round trip; refusal on a generation mismatch;
canary strings absent from the installation backup. Risk: medium (WAL handling).

A3 Migration and rollback (minimal). Owns: new `projects/store-migration.ts`,
`projects/store-export.ts`, new `tests/project-store-migration.test.ts`. The journal in
store-identity.ts:87-108 can be read, but nothing writes it ("effects ... remain unimplemented",
:96). See "Fresh install" below for the minimal scope. Risk: high (data integrity).

A4 Finish S7 reads (the uncommitted work below). Owns: `admin/*` except `admin/projects.ts`, plus
new `tests/project-admin-store-isolation.test.ts`. Remaining direct installation reads:
`sy.db`/`sy.tasks`/`sy.sessions`/`sy.artifacts` appear 162 times across 23 admin files. Split the
files across two or three briefs. Risk: low per file.

A5 Filesystem layout (S9-lite). Owns: `runners/coding/finish.ts`, `runners/supervisor.ts`,
`labs/task-attempt-source.ts`, `runners/coding/task-lab.ts`, `workspaces/worktree.ts`, new
`tests/project-runtime-activation-paths.test.ts`. Derive the worktree, agent-home and Lab-source
roots from the project runtime paths rather than `cfg.storageDir`. If A5 is skipped, split mode
still places them under `<project>/.MeritRouter/state/...`, because the registry sets
`storageDir = paths.state` (runtime-registry.ts:68). That is project-local but not the readable
v2 layout. Accept: Windows cwd at most 240 characters (runtime-paths.ts:166-171).
Risk: medium (C3 fence callsites).

**Wave B: composition root (serial; one owner per file)**

B1 Service activation. Owns: `core/service.ts`, new `core/project-runtime-host.ts` (holds the
`privateServices` factory, so the 1017-line service.ts does not grow), `projects/registry.ts`,
`projects/backfill.ts`.
- On first open of an empty installation DB, bind the coordination role and force durability
  `full` (store-identity.ts:31-33 requires `synchronous=FULL`).
- Build the registry and `ProjectScheduler` by default. Use project-mode Brain/BrainAccess on the
  local DB, plus a per-project LabManager, WebAccess port and `createProjectRunServices`.
- Make `projectStores`/`labsFor`/`brainFor` and `submitTasks`/`awaitResults`/`cancel`/`accept`/
  `reject`/`questions` resolve the owning bundle (98 `this.tasks|db|sessions|...` uses).
- Skip `projects.attach` backfill for split projects (service.ts:190).
- When the installation DB is unbound but still holds project rows, keep it in legacy mode and
  refuse to create split projects; never mix the two layouts.

Accept: an extended `project-runtime-registry`/`project-queue-isolation` test that goes through
`new MeritRouter(...)`, not hand-built registries. Risk: high. This is the critical path.

B2 Entrypoints, after B1's API is frozen. Owns: `admin/projects.ts`, `projects/deletion.ts`,
`cli/projects.ts`, `cli/setup.ts`, `config/schema.ts`, `mcp/tools.ts`, `mcp/schemas.ts`,
`qualification/*` (26 `sy.*` uses), `apps/panel/app/api/projects/route.ts`.
- createProject requires and persists `directory`, then calls A1.
- deleteProject drains and closes the bundle, retires the registration, removes only
  `<project>/.MeritRouter`, and keeps the global accounting and tombstones.
- Fix the footprint, which uses the installation `storageDir` (deletion.ts:112-145;
  admin/projects.ts:355).
- The qualification project gets an installation-owned synthetic store.
- Setup defaults: durability `full`.

Accept: `tests/project-entrypoint-isolation.test.ts`. Risk: high (deletion is destructive).

**Wave C: acceptance, docs, panel (supervisor)**

C1 New `tests/project-runtime-activation.test.ts`. In OS temp: setup, then create a project, then
run a fake-provider task through retry, then restart and resume, then a task Lab, then backup and
restore, then delete, then migrate an idle legacy project and roll it back before dispatch. Walk
the installation root afterwards and assert no canary text or project rows: `tasks`, `sessions`,
`model_requests` and `artifacts` for the slug must have zero rows in the coordination DB. This is
the literal exit check.

C2 Docs: `docs/setup.md` (lines 49, 514 still describe the global `.meritrouter` and the shared
brain), `docs/operations.md`, `docs/roles.md`, `docs/decisions.md`. Panel: a directory field on
project creation, plus unavailable-store states (S11), with a demo-panel screenshot check.
Then run the full suite and the recursive typecheck/build.

**Fresh install: what can be skipped or reduced**

- Skip: importing legacy rows into the broker (exact-ID dual-read dedupe), Git-aware relocation of
  existing worktrees, re-issuing approvals with a changed cwd, purging legacy private content
  after migration, and handling my-project/tetris/pomodoro (they lived in the recycled
  D:/SwitchYard install).
- Still required by the exit criteria (minimal A3): migrate one quiescent legacy project. That
  means all tasks terminal, no Labs, worktrees, unresolved holds or execution claims, and the
  migration refuses anything else with an actionable error. Steps: dry-run manifest, SQLite
  backup, FK-ordered export, then registration `migrating` -> verify counts/digests -> commit the
  generation. Roll back before the first dispatch. On startup, a `migrating` registration opens
  in read-only recovery (the registry already refuses non-`registered` stores,
  runtime-registry.ts:47).
- Risk to resolve before B1: when the config lives in the project directory (`init`), the
  installation storage `<dir>/.meritrouter` is the same folder as `<dir>/.MeritRouter` on
  Windows. `validateRuntimeLocation` then throws "ambiguously cased" (runtime-paths.ts:201-204).
  A1's refusal covers this. Setup in `%LOCALAPPDATA%` is unaffected.

## 3. Doc claims the code contradicts

1. production-readiness.md Current State says "S2 local accounting active". `ProjectRequestLedger`
   is constructed only in runtime-services.ts:380, which is reachable only from
   service.ts:375, and that has no caller. The default Gate uses `SqliteRequestLedger`
   (gate.ts:247).
2. project-local-storage.md Status detail says "runtime registry and queue integration active".
   `ProjectRuntimeRegistry` and `ProjectScheduler` are constructed only in tests. The service
   uses the legacy `Scheduler` (service.ts:277).
3. project-local-storage.md Current State says "Brain local scope ports ... active". Brain
   project mode (brain.ts:166-173) is never passed: service.ts:308.
4. AGENTS.md (2026-10-26 override) and the Current State say all project Labs and data belong
   under the project `.MeritRouter`, "enforced by the service/path boundary". That holds only for
   new named Lab roots (lab.ts:366-368). The DB, sessions, artifacts, worktrees, agent homes,
   task-attempt Lab sources and brain all default to the installation storage (table in §1).
5. project-local-storage.md Current State says "MAIN D:/SwitchYardRouter only". The checkout was
   renamed to D:/MeritRouter (production-readiness, 2026-10-27).
6. The doc's "Intended layout" (`attempts/<n>/repositories/<alias>`) is v1. The code's compact v2
   uses `run-NN/<alias>--<digest>` (runtime-paths.ts:155-159). The doc flags it as a proposal, so
   this is minor.

## 4. Uncommitted working tree (admin/*)

- What it is: S7 per-project reads. jobs.ts, job-plans.ts, job-team.ts and job-metrics.ts now
  read through `sy.projectStores(slug)` with explicit `project_id` filters and cross-project
  fan-out, and carry markers for unavailable projects. Supporting files:
  `admin/project-job-reads.ts` (new, used by those four), `admin/project-reads.ts` and
  `admin/project-usage.ts` (new, not imported anywhere: dead code today).
- Belongs to gate 1: yes (S7). Behaviour is unchanged under the current same-DB handle.
- Complete: no.
  - Two incompatible helper sets: `ProjectStoreUnavailable` and `ProjectStoreUnavailableError`
    are defined twice. project-reads.ts:18,26 uses `{project,reason}` and extends `Error`;
    project-job-reads.ts:17,32 adds `unavailable:true` and extends `MeritRouterError`. There are
    also two `fanOutProjects` with different signatures (:75 vs :89). Consolidate before commit,
    or a later `export *` in insights.ts will collide.
  - `jobsView` changed its return type to `RowsWithAvailability`.
  - There is no `project-admin-store-isolation` test.
  - Router `tsc --noEmit` passes. Panel typecheck not run.
