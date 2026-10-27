# Gate 1 wave A: project-local storage modules (sub-supervisor report)

Supervisor: wave-a (Opus sub-supervisor). Date: 2026-10-27. Branch dev, main checkout, no commits.
Worker reports: [wave-a/](wave-a/).

## Outcome

Done. All five rows (A1 to A5) are delivered, and every new test file passes when I run it myself.
Router `tsc --noEmit` and the panel typecheck are clean. Nothing is wired into `service.ts`; that
is wave B.

## Per worker

| Row | Tier | Outcome | What I verified myself |
| --- | --- | --- | --- |
| A1 provisioning | worker-heavy | Done | `project-store-provision.test.ts` 20/20 |
| A2 project backup | worker | Done | `project-backup.test.ts` 5/5; `operations.test.ts` 23/23 (with local-labs below) |
| A3 migration | worker-heavy, plus one follow-up | Done | `project-store-migration.test.ts` 19/19 |
| A4a admin helpers | worker | Partial, completed by A4b and A4c | the admin batches below |
| A4b insights fan-out | worker, plus one follow-up | Done | `team-metrics` 7/7; insights cases in the isolation test |
| A4c other admin files | worker | Done | `project-admin-store-isolation.test.ts` 17/17 (10 from A4c, 7 from A4b) |
| A5 runtime path roots | worker | Done | `project-runtime-activation-paths.test.ts` 9/9; `supervisor-lifecycle` 46/46 |

### A1: `projects/store-provision.ts`

Stable interface, unchanged except for an optional third parameter, `options.afterStep`. It is a
seam for crash-injection tests:

```ts
provisionProjectStore(coordinationDb, { slug, projectDirectory, installationRoots, now? }, options?)
  -> Promise<{ identity, registration, paths, adopted }>
prepareProjectStore(coordinationDb, input, identity?, options?)
  -> Promise<{ identity, paths, adopted }>   // everything except registration; used by A3
```

**Refusals**

- The project directory is equal to, inside, or contains any installation root (case-insensitive on
  win32).
- The directory lies inside any `.meritrouter` segment.
- The directory is not given by its real path.
- A stale store from a retired project, or a store from another installation, is in the folder.
- A project is registered but its local database is missing.
- An unbound database already holds data.
- `installationRoots` is empty. B1 and B2 must pass both the config directory and the storage
  directory.

**Order of operations.** The Git exclude for `.MeritRouter/` is written before `mkdir`, so the
store's files never show as untracked. Registration is the last step.

**Crash matrix.** A crash was injected after each of the 8 steps. Every re-run ends with exactly one
registration, and `openRegistered` succeeds.

### A2: `operations/project-backup.ts`, plus `backup.ts`

- **Backup.** `backupProjectStore` uses the SQLite online backup API for `.MeritRouter/state`. It
  also copies `sessions`, `artifacts`, `project.json` and the project brain. The manifest holds the
  identity, the generation and sha256 digests.
- **Restore.** `restoreProjectStore` derives its target only from the manifest identity, matched
  against the current registration.
  - It refuses a generation or identity mismatch, a registration that is not `registered`, a live
    task lease, and a live execution claim (via the new `liveExecutionClaims`).
  - It stages the restore, then swaps it in atomically.
- **`backup.ts` changes.** The manifest gains an optional `installationRole` field. `backupStorage`
  now refuses when a bound coordination store's own `tasks`, `sessions` or `artifacts` tables hold
  rows. Legacy (unbound) backups and `BACKUP_FORMAT` are unchanged.

### A3: `projects/store-migration.ts` and `projects/store-export.ts`

**API**

- `planProjectMigration`: dry run.
- `migrateLegacyProject(coordinationDb, legacyDb, { slug, projectDirectory, installationRoots, backupDir, legacyStorageDir })`
- `rollbackProjectMigration`
- `listProjectMigrationRecovery`: the startup report of registrations left `migrating`.
- `openProjectMigrationRecoveryStore`: read-only.
- `legacyProjectFence`
- `ProjectMigrationRefusedError`: every blocker carries a code and a remedy.

**Phases.** The run goes through these phases in order:

1. plan
2. SQLite backup of the legacy store
3. journal row `prepared` plus registration `migrating`, written before prepare and reusing the same
   projectId
4. `prepareProjectStore`
5. FK-ordered export of 56 classified tables (an unknown table blocks the migration)
6. copy of session log and artifact files, with sha256 digests
7. verification of counts and digests, plus `assertStoreRole`
8. registration `registered` and journal `committed`, in one transaction

A failure before commit leaves the journal at `recovery_required`, and `openRegistered` refuses the
store. Nothing reaches `registered` early.

**Rollback**

- Allowed only while a checksum of the whole target still matches what the export produced.
- Deletes only the `.MeritRouter` folder that the migration created.
- Never writes legacy rows or files.

**My follow-up.** I sent the worker back once because migrating only rows left sessions and
artifacts pointing at files that did not exist. Now:

- The target's `log_path` values are canonicalised to `sessions/<id>.jsonl`.
- `artifacts.rel_path` is never rewritten. A value that is absolute or contains `..` blocks the
  migration.

### A4: S7 admin reads

**Consolidation**

- `admin/project-job-reads.ts` is deleted. `admin/project-reads.ts` is now the single helper module.
- It has one `ProjectStoreUnavailable`, one `ProjectStoreUnavailableError` (extends
  MeritRouterError), and one `fanOutProjects`.
- It has `RowsWithAvailability` for arrays and `WithUnavailable` for objects.
- Additive helpers: `projectDbScopes`, `fanOutProjectRows`, `projectIdFilter`.
- `project-usage.ts` is wired into `insights.overview()` through `installationUsage`.

**Converted to per-project reads**

- `sessions.ts`, `session-project-scope.ts`, `request-evidence.ts`, `budget.ts`
- `insights.ts` views: `tasksByState`, `endpointStats`/`modelsView`, the `requestLog` family,
  `timeseries`, `tierDistribution`, `qualificationBoard` (qualification scope only). Merges sum
  counts and re-apply ordering and limits after merging. Averages are recomputed from merged sums.
- `entities.ts`, `calibration.ts`, `dashboards.ts`, `deliveries.ts`, `brain-entities.ts`,
  `brain-memory-manifest.ts`, `labs.ts`, `qualification-work.ts`, `project-settings.ts`, `live.ts`
  (single-project scope).
- Reviewed with no change needed: `config-edit.ts`, `provider-keys.ts`, `quarantine.ts`,
  `plan-recovery.ts`.

**Defect fixed.** `jobsView` and `teamMetrics` listed nothing for jobs stored with `project_id=''`,
although `taskIn` attributes those jobs to the primary project. Both now use `projectIdFilter`.
`team-metrics` had been at 6/7 before the fix and is now 7/7.

**Intentionally still on `sy.db`.** Each worker report gives the reasons in full.

- `insights.workers()`: worker claims in `meta` are installation-wide.
- The qualification lookup in `matrix()` and `routingPreview()`: shared gateway code.
- `calibration.ts` `verdict_records`/`verification_audits`: these tables have no `project_id`
  column, so a fan-out would double count under the same-DB handle.
- `live.ts` with `scope:"all"`.

**New test.** `tests/project-admin-store-isolation.test.ts` replaces `sy.projectStores` with
separate per-project databases. Canary rows go in the project stores and decoy rows in the
installation DB. It asserts that views show only the project-store rows and that a project whose
store fails to open is reported unavailable.

### A5: runtime path roots

- New function in `workspaces/worktree.ts`:
  `projectRuntimeActivationRoots(cfg: { storageDir; projectDirectory? }) -> { worktrees, agentHome, split }`.
- **Split mode** applies exactly when `projectRuntimePaths(projectDirectory).state` path-equals
  `storageDir`. It uses `<project>/.MeritRouter/worktrees` and `<project>/.MeritRouter/agent-home`.
- **Legacy mode** keeps today's paths byte for byte.
- `finish.ts` and `supervisor.ts` use the function to create worktrees.
- `task-attempt-source.ts` and `task-lab.ts` use the same function for their containment checks.
- `supervisor.ts` now calls `assertRuntimeCwdSupported` on the integration worktree path.
- The compact v2 `jobs/` layout was not adopted, because these callsites persist no RuntimeIdentity.

## Integration changes I made

None to source. I approved one change outside the owned files: A4c edited
`tests/brain-provenance-paging.test.ts`, adding `projectStores` (2 lines) to the test's fake
MeritRouter. Without it, the test would have broken because `brain-memory-manifest.ts` now reads
through `projectStores`. No apps/panel edits were needed.

## Commands I ran (observed)

All test commands ran from `D:/MeritRouter/packages/router`.

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` | exit 0 |
| `pnpm --filter meritrouter-panel typecheck` (repo root) | exit 0 |
| `npx vitest run tests/project-store-provision.test.ts` | 20/20 |
| `npx vitest run tests/project-backup.test.ts` | 5/5 |
| `npx vitest run tests/project-store-migration.test.ts` | 19/19 |
| `npx vitest run tests/project-admin-store-isolation.test.ts tests/project-runtime-activation-paths.test.ts tests/project-backup.test.ts` | 3 files, 31/31 |
| `npx vitest run tests/project-store-provision.test.ts tests/project-store-migration.test.ts` | 2 files, 39/39 |

Existing test files I ran:

| Files | Result |
| --- | --- |
| admin-budget-panel, admin-job-navigation, admin-session-project-scope, admin-request-evidence | 4 files, 28/28 |
| admin-brain-entities, admin-labs, admin-live, admin-keys | 4 files, 52/52 |
| admin-plan-recovery, admin-project-settings, admin-promotions, team-metrics | 4 files, 18/18 |
| brain-provenance-paging, project-store-identity, project-runtime-registry, projects-panel-scope | 4 files, 43/43 |
| operations, project-local-labs | 2 files, 41/41 |
| supervisor-lifecycle | 46/46 |

`labs-task-prune`: 8 passed and 3 failed. The failing tests are "serializes automatic and project
prune...", "fences lease loss...", and "recovers partial Git removal...". The error I looked at is
`RepositoryMutationError: Repository mutation lock is busy` from `workspaces/repository-mutation.ts`,
which is not a wave A file. A5 left the legacy path unchanged, and this fixture configures no
project directory. I have not confirmed this against a clean baseline: there is no second checkout,
and `git-process-policy.ts` is being modified concurrently by another worker.

## Not verified

- A clean baseline for `labs-task-prune`, `labs-task-attempt`, `project-task-lab-deletion` and one
  test in `active-validation-ownership`. A5 saw failures in all of them; all were rooted in
  `repository-command.ts`/`repository-mutation.ts` lock and grant checks.
- `process-performance` "bounded task throughput": A4c reproduced a 45 s timeout with the original
  `live.ts`.
- The full router suite, `pnpm -r build`, and the panel build or screenshots. No panel source
  changed.
- POSIX behaviour, since everything ran on win32 only.
- Concurrent provisioning or migration from separate processes.
- Migration against a real service-built bundle. A3 used a stub registry factory.
- `dist/` is not rebuilt after the last admin edits; A5 rebuilt it mid-wave.

## Open questions for the lead (B1/B2 inputs)

1. **Split mode is unreachable in production.** `ProjectRegistry.get()` never overlays
   `storageDir`, so A5's split roots (and `task-lab`'s check) are seen only through contexts that
   `ProjectRuntimeRegistry.openRegistered` builds. B1 must route `RunContext.cfg` and the Lab
   project contexts through it.
2. **The legacy fence is not called.** `legacyProjectFence` (A3) has no caller yet. B1 must call it
   on the legacy dispatch, resume and write paths for a migrated slug.
3. **The coordination guard may refuse the qualification project.** A2 makes `backupStorage` refuse
   when a bound coordination DB holds `tasks`, `sessions` or `artifacts` rows. Qualification tasks
   live in the installation DB today, so this guard would fire unless B2 gives qualification its own
   synthetic store, as the inventory plans.
4. **Verdict tables lack `project_id`.** `calibration.ts` cannot fan out `verdict_records` and
   `verification_audits` without either a `project_id` column (a schema change, so the lead's call)
   or a join through task ownership.
5. **A3 refuses some legacy projects.** It refuses rather than splits shared executions, shared
   protocol records and any `labs` row. A legacy project with cross-project batches cannot migrate
   under the minimal scope.
6. **Duplicated overlap check.** A3 copies A1's installation-overlap check, because
   `store-provision.ts` does not export `assertOutsideInstallation`. That is small cleanup for later.
7. **Commit order.** Commit A4 (all `admin/*`, the deletion of `project-job-reads.ts`, and the
   test-fixture change) as one unit. A1 must go in before or with A3, because A3 imports it.
