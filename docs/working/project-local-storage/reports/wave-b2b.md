# Gate 1 wave B2b: project creation and deletion entry points (worker report)

Worker: wave-b2b (worker-heavy). Date: 2026-10-27. Branch dev, main checkout. I made no commits and
created no worktrees. Paths below are relative to `packages/router` unless stated otherwise.

## Outcome

Done.

- **Creation.** In a split installation, project creation requires a directory. It persists
  `projects.<slug>.directory` and provisions `<directory>/.MeritRouter` through B1's
  `createSplitProject`. If provisioning fails, the config is rolled back. This works from the admin
  API, the CLI, a new MCP `create_project` tool and the panel API route.
- **Deletion.** In split mode, deletion retires the store and then removes only
  `<directory>/.MeritRouter`, after proving it is the registered store folder. It never follows a
  link or junction. The installation's accounting and the retired registration (the tombstone)
  are kept.
- **Legacy installations.** Behaviour is unchanged.
- **Pre-existing late-session failure.** Fixed. The cause was a stale test, not production code
  (see below).

## What changed and why

**`src/projects/deletion.ts`** (mechanics, +158 lines):

- `projectStoreRegistrations(db, slug)`: a zod-validated list of the slug's registrations, newest
  first.
- `verifyProjectRuntimeRoot(reg, configuredDir, installationRoots)` checks all of these:
  - the configured directory equals the registered one;
  - neither the directory nor `.MeritRouter` is a link or junction, and each realpaths to itself;
  - the root neither contains nor lies inside the config or storage directory;
  - `project.json` is a regular file whose `projectId` equals the registration's.

  It returns `present: false` when the root is already gone.
- `removeProjectRuntimeRoot` verifies the root, then removes it depth first:
  - links and junctions are unlinked, never traversed;
  - the root is re-verified, and the manifest and root are removed last, so an interrupted removal
    can still be verified and finished on a rerun.
- `runtimeRootWorktrees(root, repos)` lists git worktrees registered in the project's repositories
  that lie inside the root. They are removed natively with the existing `removeProjectWorktrees`
  before the folder goes, so the repositories forget them and their branches stay.
- `removeCreatedRuntimeRoot` removes a partial store folder that a failed create made itself.
- `projectStoreCounts`, `projectTaskSnapshot`, and `projectAccounting` (coordination
  `physical_requests` by project UUID).
- The legacy `projectFootprint`, `purgeProjectRows` and related functions are unchanged. They stay
  correct for legacy, where the installation `storageDir` *is* the project store. Split deletion no
  longer goes through them: its footprint comes from the project's runtime root.

**`src/admin/projects.ts`** (now 827 lines; see Open questions):

- **`createProject` / `validateNewProject`.**
  - New optional `directory` input, absolute or config-relative. It is persisted in the config in
    any layout and validated: not a file, and acceptable to `projectRuntimePaths`.
  - In split layout the directory is required. A missing folder is created first. After the config
    patch the call goes to `sy.createSplitProject`.
  - On failure, `rollbackSplitCreate`:
    - retires a registration only if this call made it;
    - removes `.MeritRouter` only if it did not exist before;
    - restores the config only if it is still the exact text this call wrote;
    - removes the folders it created while they are empty.
  - The result has a new field `runtimeRoot`.
- **`projectActivity` / `projectAttention`.** These now read the project's own store through
  `openProjectStores`. In legacy that is the same database, so behaviour is identical. A split
  project without a store shows zero activity, plus an attention line ("no store yet" or "store
  unavailable") instead of reading the coordination DB.
- **`deletionBlockers`.** Takes the store `db` to check: the project's own store in split mode, or
  null when there is no open store. The Lab, claim, receipt and active-task checks run against it.
- **`previewProjectDeletion` / `deleteProject`.** In split layout these branch to
  `previewSplitDeletion` / `deleteSplitProject`. `deleteSplitProject` runs these steps:
  1. Run the blockers, as today. Running or queued tasks still refuse.
  2. Prune stopped task Labs through `sy.labsFor(slug)`.
  3. Run the final blocker and config checks and take a task snapshot. These run synchronously with
     `retireProject`, with no await in between: the registry fences the project before it first
     yields.
  4. Verify the snapshot is unchanged by reading the retired store read-only.
  5. Remove the native worktrees under the root.
  6. Run `removeProjectRuntimeRoot`.
  7. In one coordination transaction: write the config without the project (`brain.project` moves
     as in legacy), and delete the coordination `projects` row and that project's `events`
     (`project_id` / `repository_prepare`).

  `physical_requests`, `broker_paid_spend` and `project_store_registrations` (retired) are kept.

  If the deletion is interrupted after retirement (snapshot change, a removal error, a config
  conflict), the project stays configured. Rerunning the deletion finds the retired registration
  whose folder still exists and finishes the job.

  The preview and the result now carry `layout` / `runtimeRoot`. The split preview's
  removes/keeps sentences describe the store folder, the native worktree removal, the kept project
  folder, and the kept accounting and tombstone.

**`src/cli/projects.ts`:**

- New form `projects create <slug> [<directory>]`. The directory is a positional argument, because
  `src/cli.ts` (which defines flags) is outside my ownership and has no `--directory` flag.
- More than three positional arguments is a usage error.
- The output prints the store path on create and the removed store on delete.

**MCP (`src/mcp/schemas.ts` and `src/mcp/tools.ts`):**

- New `create_project` tool. Its input is `slug`, `name?`, `directory?`, and
  `repositories?: [{alias, path, writable?}]`.
- The schema is portable: no `pattern` and no `z.record`. `validateNewProject` does the full
  validation. Duplicate aliases are refused.
- Deletion is intentionally *not* exposed over MCP, because it is destructive. It stays in the
  panel and the CLI.

**`apps/panel/app/api/projects/route.ts`:**

- The zod body accepts an optional `directory` (trimmed, at most 1000 characters; blank means
  none).
- `directory: ...` errors map to `fieldErrors.directory`.
- The success response includes `runtimeRoot`.
- The form UI field is C2's work.

**Tests:**

- New `tests/project-entrypoint-isolation.test.ts`, 11 tests:
  - split create through admin, CLI and MCP, each landing in `<dir>/.MeritRouter`;
  - a missing directory is refused;
  - a provisioning failure rolls back (config byte-identical, no store, the created folder removed);
  - delete removes only `.MeritRouter`: a `notes.txt` in the folder, a junction inside the store
    pointing at an outside sentinel, git history, the other project's store and the accounting
    count all survive, and the registration ends up `retired`;
  - native worktree removal, with branches unchanged;
  - queued tasks refuse deletion and leave the store live;
  - resume after retirement;
  - refusals: the root is a junction, the configured directory differs, the manifest names another
    project, the root overlaps an installation root;
  - legacy create and delete are unchanged.
- **Split fixture.** The split install is selected with `storage: { layout: "split" }`, wave B2a's
  config key, which is present in the working tree and used by the updated
  `project-service-activation.test.ts`. B1's earlier trigger, `durability: full` on an empty store,
  no longer applies in this tree. This test file therefore depends on B2a landing together with it.
- `tests/mcp.test.ts` and `tests/mcp-http.test.ts`: the tool list and count go from 48 to 49
  (`create_project`).
- `tests/project-delete-late-session.test.ts`: fixed, as below.

**The late-session failure.**

- Commit `985b43d` ("Pin private evidence to canonical project stores") added `project_id` to the
  identity snapshot that `SessionRecorder` takes in its constructor (`sessionIdentity()`).
- The test created a recorder and then ran `UPDATE sessions SET project_id='deleted'` underneath
  the live recorder. Its first `note()`, before the purge, then correctly failed the identity
  check: "session <id> identity changed".
- The production behaviour is right: the test re-homed a session under a live recorder. The test
  now opens the retained recorder over the project's session row, `new SessionRecorder(...)` after
  the update, which models a recorder owned by the deleted project.
- Production code is unchanged.

## Commands run and observed results

All from `D:/MeritRouter/packages/router` unless noted.

| Command | Result |
| --- | --- |
| `npx vitest run tests/project-delete-late-session.test.ts` (before fix) | 1 failed / 2 passed, with "session s_... identity changed" at `recorder.ts:305` |
| same, after fix | 3/3 passed |
| `npx vitest run tests/project-entrypoint-isolation.test.ts` | 10/11 passed. The 1 failure was a bug in my test (wrong `listTasks` signature), fixed; the legacy test then passed alone. All 11 later passed in the batch below. |
| `pnpm --filter meritrouter build` (repo root) | exit 0 |
| `npx vitest run tests/projects tests/project-delete tests/mcp tests/project-entrypoint-isolation` (17 files) | 95/99. Failures: `mcp-http` ×2 (expected 48 tools; fixed to 49); `projects.test.ts` 10 s `afterEach` hook timeout (load); `projects-followups.test.ts` EBUSY on temp-dir cleanup (load) |
| rerun `tests/mcp-http.test.ts tests/projects.test.ts tests/projects-followups.test.ts` | 3 files, 19/19 passed |
| `npx tsc --noEmit -p .` | clean (no output) |
| `pnpm --filter meritrouter-panel typecheck` (repo root) | clean (`tsc --noEmit`, no errors) |
| `npx vitest run` project-admin-store-isolation, project-service-activation, project-task-lab-deletion, project-metadata-deletion, project-request-protocol, lab-config-guard, admin-project-settings | 45/46. 1 failure: `project-service-activation` "refuses an unregistered or qualification project ..." (a qualification submit now resolves). Not mine: it is wave B2c's qualification store, which is in flight in `core/project-runtime-host.ts` / `qualification/*` |
| `npx vitest run tests/process-performance.test.ts` | 8/9. The deletion tests in it pass. "measures bounded task throughput" timed out at 45 s, and again on one rerun. That test only submits and polls tasks in a legacy install and touches none of my code; I did not investigate further. |

## Not verified

- **Multi-process deletion.** Another process (panel, MCP server) holding the same split project
  open while one process deletes it is not handled or tested. Retirement fences only the calling
  process. On Windows, removal would most likely fail with EBUSY, and the deletion would then be
  finished by a rerun, but this is not tested.
- **Partial-removal recovery on a real failure.** Recovery after a mid-removal failure (for example
  EBUSY on one file) is designed for, since the manifest is removed last, but no test injects a
  removal failure.
- **Failure after registration.** The `createSplitProject` path that fails *after* registering,
  which needs the retire-on-rollback, is untested. Only the overlap refusal before registration is
  exercised.
- **Panel.** No panel build, start or screenshot: the form field is C2's. `pnpm -r build` and the
  full router suite were not run.
- **POSIX.** Not tested. On POSIX the junction test uses a symlink; Node ignores the `"junction"`
  type there.
- **Split brain commit and push.** A split project's brain is removed with the folder. There is no
  brain commit, so `brainCommit` is null.

## Open questions or contradictions found

1. **`admin/projects.ts` is 827 lines**, past the ~800 guideline. The growth is a separate concern:
   split-layout deletion orchestration (~200 lines). A natural home would be a new
   `src/admin/project-split-deletion.ts`, but new admin files were outside my owned paths. That
   split is for the lead to decide.
2. **CLI directory is positional.** `projects create <slug> [<directory>]` because I could not add a
   `--directory` flag in `src/cli.ts`. If the lead prefers a flag, it is a one-line option there
   plus a read of `values.directory` in `cli/projects.ts`.
3. **New MCP contract.** `create_project` is a new MCP tool, which is a contract change. Deletion is
   deliberately not on MCP. Documentation (`docs/setup.md` / `docs/operations.md`: the directory
   requirement, deletion semantics, the new tool) is C2's per the inventory, and I did not edit it.
4. **Dependency on B2a.** `project-entrypoint-isolation.test.ts` depends on B2a's
   `storage.layout` key. If B2a does not land, the split fixture needs `durability: "full"`
   instead, and the `layout` key must be removed.
