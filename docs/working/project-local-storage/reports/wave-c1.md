# Gate 1 wave C1: the literal exit check (worker report)

Worker: wave-c1 (worker-heavy). Date: 2026-10-27. Branch dev, main checkout. I made no commits and
created no worktrees. Paths below are relative to `packages/router` unless stated otherwise.

## Outcome

Done.

- The new `tests/project-runtime-activation.test.ts` runs the whole gate 1 journey through the real
  entry points and passes. It found no new product defect in the paths it covers. The journey
  passed on its first run, so before trusting it I printed the installation and project trees to
  check it was not vacuous. Afterwards the installation folder holds only these files:
  - `.MeritRouter/meritrouter.db`
  - `meritrouter.config.yaml`
  - `meritrouter.config.yaml.bak`
  - `models.yaml`

  Alpha's `.MeritRouter` holds its state DB, sessions, artifacts, brain reports, both retry
  worktrees, the task Lab and the restore's set-aside copy. Its files contain the canaries.
- I fixed both defects the brief named. Each has a test.
- Two of the findings below need a design decision (Open questions 1 and 2). I did not fix them.

## Defects

| # | Defect | Cause | Fix | Test |
| --- | --- | --- | --- | --- |
| 1 | `new MeritRouter(...)` leaked the installation DB handle when anything after `openDatabase` threw. Example: `split_layout_unavailable` on a store that already holds rows. On Windows the file stayed locked (EBUSY) for the life of the process. | The constructor had no failure path. The handle lived only in a half-built instance that nobody could close. | `src/core/service.ts`: the constructor body after `openDatabase` is wrapped in `try/catch`. The new `abandonConstruction()` stops whatever may have started (reload/discovery timers; the sync part of `labs.close`, which clears the Lab monitor timer; scheduler/host stop, errors swallowed), closes `this.db`, then rethrows. The body was re-indented, so `git diff -w` shows the real change. | "closes the installation database when the constructor fails after opening it". With the fix disabled it failed with `EBUSY ... unlink ...\.MeritRouter\meritrouter.db`. With the fix it passes. |
| 2 | The `brain.path` default became `~/.MeritRouter/brain` with no fallback to an existing `~/.meritrouter/brain`. On a case-sensitive filesystem an existing brain would be silently replaced by a new empty one. | B2a added the fallback only for `storage.directory` (`config/load.ts`); brain paths are resolved separately. | `src/config/load.ts`: new exported `resolveBrainPath(baseDir, brainPath, exists?, home?)`. When the configured path does not exist but the same path with each `.MeritRouter` segment spelled `.meritrouter` does, it returns that old spelling, in the config's own form (relative or `~`). `parseConfig` applies it before `resolveProjects`, so each project's brain settings inherit it. Every reader (`Brain`, `brainPathOf`, project settings) resolves the same string, so none of them changed. | "falls back to an existing old-spelled brain folder ...". A unit test injects `exists` (old only, new exists, neither, no runtime segment, relative path). An integration test checks that through `parseConfig` the resolved brain is the existing old-spelled folder on this filesystem, and that project overrides follow it. |

No other product defect surfaced. I also probed one edge with a throwaway test (since deleted):
opening the split service while a migrated project is registered, then rolling back. That works,
and the main test now covers it in stage 8.

## The journey (`runs the gate 1 journey ...`)

Everything runs in OS temp with a stubbed `MERITROUTER_HOME` and `ScriptedClient` fake providers.
Nothing touches the network or the user's data.

1. **Setup.** `resolveConfigPath` + `initializeConfig({ setup: true })` is `meritrouter setup`'s
   implementation (`main()` in `cli.ts` cannot be imported). It writes `storage.layout: split`,
   `durability: full` and `.MeritRouter`. Then the test adds fake provider keys and the test model
   catalog to the config, which is what an operator does after setup.
2. **Two projects.** `alpha` is created through admin `createProject` with a directory. `beta` is
   created through the CLI (`projectsCommand create beta <dir>`). A summarize task then runs in
   beta.
3. **Coding retry.** A native coding task in alpha (real `createCodingRunner`) fails its first
   attempt by spending its budget. The executor's one bounded retry escalates T2 to T3 and
   completes. The worktree is under `alpha/.MeritRouter/worktrees`.
4. **Interrupt and resume.** A held task is interrupted by `close()`. After reopening it is resumed
   explicitly with `resumeTask(id, "alpha")` and completes after a worker restart.
5. **Task Lab.** A task Lab passes a check in alpha's own `LabManager` (`sy.labsFor("alpha")`). Its
   root is under `alpha/.MeritRouter/labs`, and the coordination DB has no `labs` rows.
6. **Backup and restore.** `backupProjectStore` runs with the service open, then a task is
   submitted after the backup. With the service closed, `restoreProjectStore(force)` runs. After
   reopening, the post-backup task is gone and the earlier tasks remain.
7. **Delete beta.** The CLI deletes beta with `--confirm`. `beta/.MeritRouter` is gone. The repo
   files and git history stay, the registration is `retired`, and the coordination `projects` row
   is gone. `projects list` (CLI) and `usage()` still work.
8. **Legacy migration.** A separate legacy install runs a canary task for `gamma`.
   `migrateLegacyProject` runs into the split coordination DB. With gamma configured, the split
   service reads gamma's history from its own store. `rollbackProjectMigration` then reports
   `targetRemoved` and `legacyIntact`, the registration is `retired`, `gamma/.MeritRouter` is gone,
   and the legacy rows are unchanged.
9. **Reopen.** The service reopens. The coordination DB has 0 rows in `tasks`, `sessions`,
   `model_requests`, `artifacts`, `session_events`, `workspaces`, `labs` and `executions`, and no
   task-scoped `events`.
10. **File walk.** No file under the installation folder contains any of the 5 canaries (goal,
    model output, written code, beta goal, legacy goal). The folders are spelled `.MeritRouter`,
    and no `.meritrouter` exists. Alpha's `.MeritRouter` contains the canaries and has `state`,
    `sessions`, `worktrees` and `labs`. Alpha's git status is clean.

## Commands run and observed results

All from `D:/MeritRouter/packages/router` unless noted.

| Command | Result |
| --- | --- |
| `npx vitest run tests/project-runtime-activation.test.ts` (final) | 3/3 passed (journey ~43 s) |
| same, with `abandonConstruction()` call commented out (temporary, restored) | ctor test failed: `EBUSY ... unlink ...meritrouter.db` |
| `npx vitest run tests/project-service-activation.test.ts tests/project-entrypoint-isolation.test.ts tests/install-layout.test.ts tests/qualification-split-store.test.ts tests/project-store-migration.test.ts tests/project-backup.test.ts` | 6 files, 56 passed, 1 skipped (install-layout's Linux-only case) |
| `npx vitest run tests/brain.test.ts tests/rename-compatibility.test.ts tests/packaging.test.ts tests/project-directory.test.ts tests/projects-brain.test.ts tests/operations.test.ts tests/policy.test.ts tests/client-supervision.test.ts` (config/load users) | 8 files, 88/88 |
| `npx vitest run tests/execution.test.ts tests/projects.test.ts tests/project-runtime-registry.test.ts tests/project-queue-isolation.test.ts tests/native.test.ts tests/coding.test.ts` (service users) | 82/84. `projects.test.ts` "runs two projects' tasks ..." failed with an `afterEach` hook timeout of 10 s under parallel load. The next test failed in cascade (`sy` undefined, EBUSY). This is the same load failure B1 and B2b recorded. |
| `npx vitest run tests/projects.test.ts` (alone) | 9/9 |
| `npx vitest run tests/service-close.test.ts` | 4/4 |
| `npx tsc --noEmit` (includes tests) | exit 0 |
| `pnpm --filter meritrouter-panel typecheck` (repo root) | exit 0 |

## Not verified

- **The Linux branch of the brain fallback.** On a case-sensitive filesystem, when only
  `.meritrouter/brain` exists, the redirect itself is covered only by the injected-`exists` unit
  test. The real-filesystem test is a no-op on this Windows box.
- **A task Lab started by a worker run.** I did not test a coding task with `labChecks`. The test
  registers the attempt directly on the project's `LabManager`, the same pattern as the existing
  task-Lab tests. The worker path needs supervisor authority and `ensureLabsSupervisor`, which B1
  recorded as not passed to split executors.
- **Restore while the service is running.** The test closes it first, and on Windows the swap
  would most likely fail on the open project DB.
- Not run: the full router suite, `pnpm -r build`, the MCP tests, the panel build and screenshots,
  POSIX, and multi-process cases.
- `projects.test.ts` under load: I did not investigate beyond the solo rerun.

## Open questions or contradictions found

1. **Design: `setup` leaves the first project without a store in split layout.**
   - **What happens.** `initializeConfig({ setup: true })` writes `projects.my-project` with no
     `directory` and makes it the primary project. In a split installation that project can never
     get a store:
     - `createProject` refuses the existing slug.
     - Nothing provisions a store for a configured project later.
     - Adding `directory` to the config does nothing.
   - **What I observed in a throwaway probe** (all four fail with "no project-local store"):
     - `submitTasks` without a project throws.
     - `sy.brain` throws.
     - `sy.web` throws ("web access belongs to project stores").
     - `projectStores("my-project")` throws.

     MCP and CLI defaults resolve to the primary project, so a fresh install fails until the user
     creates another project.
   - **Options.**
     - (a) `setup` takes a project directory (flag or prompt), and the first open provisions it.
     - (b) In split layout, `setup` writes no project; the first created project becomes primary.
     - (c) The service, or an admin "create store" action, provisions any configured split project
       that has `directory` but no registration.
     - (d) `createProject` adopts an existing store-less configured slug.

   The journey therefore creates `alpha` and `beta` beside the store-less `my-project`.
2. **Design: no operator entry points for project backup, restore or migration.**
   - `backupProjectStore`, `restoreProjectStore`, `migrateLegacyProject` and
     `rollbackProjectMigration` are library-only.
   - `meritrouter backup` and `meritrouter restore` cover only the coordination store
     (`operations/backup.ts`).
   - Migration needs both the legacy DB and a split coordination DB. A fresh split install as the
     target is the only arrangement that works today (B1 open question 2 still stands).

   Adding CLI, MCP or panel commands is contract work for the lead, not a bug fix.
3. **Minor: restore's set-aside copy is never cleaned up.** `restoreProjectStore({ force: true })`
   leaves the previous store at `<project>/.MeritRouter/pre-restore-<timestamp>-<suffix>/`. It is
   project-local, which satisfies gate 1, but nothing ever removes it.
4. **Interpretation.** I read "fails once and succeeds on retry" as the executor's one bounded
   retry: a spent budget, then escalation. I did not test a user-level resubmission. The resume
   stage separately covers explicit operator recovery (`resumeTask`).
5. **Other edits in the working tree are not mine.** `git status` also shows edits under
   `apps/panel/**` and `src/admin/insights.ts`. They belong to the concurrent C3 worker; I did not
   touch them.

## Return contract

Outcome: Done
Changed: packages/router/tests/project-runtime-activation.test.ts (new), packages/router/src/core/service.ts, packages/router/src/config/load.ts
Validation: `npx vitest run tests/project-runtime-activation.test.ts` -> 3/3 passed; 6 named related files -> 56 passed, 1 skipped; `npx tsc --noEmit` -> exit 0; `pnpm --filter meritrouter-panel typecheck` -> exit 0
Not verified: the Linux real-FS brain fallback; a task Lab started by a worker run; the full suite, build, MCP and panel; POSIX
Report: docs/working/project-local-storage/reports/wave-c1.md
Notes: The journey found no new defect; both named defects are fixed and tested (the ctor test reproduces EBUSY without the fix). Design calls: setup's store-less first project in split layout, and no CLI/MCP entry points for project backup, restore or migration.
