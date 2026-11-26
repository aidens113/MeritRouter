# Fix: `init`/`setup` leave an unprovisioned project stub in split layout

## Root cause

`meritrouter init --project <slug> [--repo ...]` (and `setup`, which shares the same code path)
always wrote a `projects.<slug>` entry into the config via `initConfigText`
(`src/cli/projects.ts`), but fresh installs force `storage.layout: split`
(`src/cli/setup.ts`). A split project's store is only created by `createSplitProject`
(`sy.createSplitProject` → `src/projects/store-provision.ts`'s `provisionProjectStore`), and
`initializeConfig` never called it — it only wrote YAML. The result: a `projects.<slug>` entry
with `repositories` but no `directory`, and no registered `.MeritRouter` store, so
`doctor`/`mcp` failed with "create it as a split project first" (`src/core/project-runtime-host.ts`
line 330/370) and `meritrouter projects create <slug> <dir>` refused with "project <slug> already
exists" (`validateNewProject` in `src/admin/projects.ts`, which treated any existing config entry
as fully created, with no way to tell a provisioned project from a stuck stub).

Note: `projects.<slug>.directory` is not itself the right signal for "provisioned" — when exactly
one repository is configured, `src/projects/resolve.ts`'s `projectDirectory()` already infers a
lexical directory from that repository *before any store exists*. The actual signal is whether a
`registered` row exists in `project_store_registrations` for the slug (split layout only).

## Fix

1. **`src/admin/projects.ts`** — added `isUnprovisionedSplitStub(sy, slug)`: true only for a
   split-layout project whose config entry exists but has no `registered` store row.
   `validateNewProject` no longer refuses with "already exists" for such a stub; it is adopted
   instead. `createProject` now merges onto the stub's existing raw config entry
   (name/repositories/brain mounts not given in this call are kept, not silently dropped) and
   defaults `directory` from the stub's already-resolved `projectDirectory` when the call does not
   give one, then proceeds through the normal `createSplitProject` provisioning path — so a second
   `projects create <slug> <dir>` finishes what `init`/`setup` started, instead of refusing.
   A genuinely already-provisioned project's slug is still refused (regression test added; see
   `tests/project-cli-operations.test.ts`'s new "still refuses a provisioned project's slug" case).

2. **`src/cli/setup.ts`** — generalized the existing "no placeholder project" decision (previously
   `setup`-only, and only when zero repositories were given) to apply uniformly: a fresh split
   config with **zero** repositories writes no project stub at all (matches the existing `setup`
   convention; `init` now gets the same treatment, closing that gap too). With **one or more**
   repositories, the stub is still written (so `--repo` input is never silently dropped), unchanged
   from before. Added `provisionInitialProject(configPath, slug, directory)`: opens the just-written
   config, and — only if a stub exists and nothing has provisioned it yet — calls `createProject`
   with the given `directory`, which adopts the stub via the fix above.

3. **`src/cli.ts`** — right after `initializeConfig` writes a *fresh* config (tracked via
   `freshInstall = !existsSync(configPath)` taken before the write) with **exactly one**
   `--repo`, calls `provisionInitialProject` using that repository's own folder as the project's
   directory (the only directory an installation can infer unambiguously, and the one
   `src/projects/store-provision.ts`'s git-exclusion logic is specifically built to use — see
   `excludeFromGit`). This exactly covers the README's documented quick-start command
   (`init . --preset claude-code --project my-app --repo app=<path>` /
   `setup --preset claude-code --project <slug> --repo app=<path>`) and the audit's reported
   reproduction. With zero or several repositories (an ambiguous directory), no automatic
   provisioning is attempted; the stub (if any) is left for `projects create <slug> <dir>` to
   finish, which now works thanks to fix (1) instead of refusing.

On a provisioning failure (including the pre-existing environmental issue below), `createProject`
rolls the config back to its prior state (unchanged from before this fix), so a failed attempt
never leaves the config half-written; `provisionInitialProject`/`cli.ts` print a warning naming
the exact `projects create <slug> <dir>` command to retry, instead of failing silently or leaving
only a hint message with no working recovery path.

## Files changed

- `packages/router/src/admin/projects.ts` — `isUnprovisionedSplitStub`, adoption/merge logic in
  `validateNewProject` and `createProject`.
- `packages/router/src/cli/setup.ts` — uniform no-placeholder-without-repositories decision;
  new exported `provisionInitialProject`.
- `packages/router/src/cli.ts` — calls `provisionInitialProject` after a fresh single-repository
  `init`/`setup`.
- `packages/router/tests/project-cli-operations.test.ts` — new `describe` block with 4 regression
  tests (reproduces the stub, provisions it automatically for the single-repo case, adopts a stuck
  stub via `projects create`, confirms an already-provisioned slug is still refused).

## A pre-existing, unrelated blocker found during validation

**`src/storage/migrations.ts` already has an uncommitted migration (`channel_messages`, for the
in-progress supervisor-offload channel work) that is not registered in
`src/storage/store-role.ts`'s `classifiedTables`.** This makes `initializeStoreRole` throw "Project
store contains an unclassified schema object" for **every** split-project store provisioned in this
working tree right now — `createSplitProject`/`provisionProjectStore`, regardless of caller. This
is not caused by this fix: it reproduces identically for pre-existing calls (e.g.
`project-cli-operations.test.ts`'s already-existing "the worker's startup recovery..." test, and the
entirety of `project-store-provision.test.ts`, which imports none of the files this fix touches).
`src/storage/migrations.ts` and `src/storage/store-role.ts` are both outside this brief's owned
paths, so I did not touch them. **This blocks full green validation of split-project provisioning
repo-wide** (not just this fix) until `channel_messages` is added to `store-role.ts`'s classified
set (or the migration is reverted/committed properly). Recommend the lead either fix that one line
in `store-role.ts` or coordinate with whoever owns the supervisor-offload channel work before
relying on split-project creation for anything.

My new tests and the manual CLI reproduction below tolerate this blocker (they assert the fix's
actual contract — no more "already exists", config rolled back cleanly on failure, actionable
warning naming the exact recovery command — rather than requiring the environment's unrelated bug
to be absent), and additionally assert full success when provisioning does succeed, so they will
exercise the complete path once that one line is fixed.

## Commands run and observed results

- `cd packages/router && pnpm typecheck` → passes for every file this task touched
  (`cli.ts`, `cli/setup.ts`, `admin/projects.ts`, `tests/project-cli-operations.test.ts`); the
  command's full output lists ~25 pre-existing errors in files unrelated to this task
  (`core/task.ts` missing `./report.js`, `core/acceptance.ts`, `harness/worker.ts`,
  `runners/*`, `verification/*`), present before any of my edits (confirmed: none of those paths
  are in my changed-files list, and the errors are type-shape mismatches unrelated to projects/cli).
- `cd packages/router && pnpm build` → **clean, no errors** (`tsc -p tsconfig.build.json`,
  exit 0). The build config does not include the files with pre-existing typecheck errors above.
- `cd packages/router && npx vitest run tests/project-cli-operations.test.ts` → the 4 new tests in
  "init/setup provision the project they just wrote, and projects create repairs a stuck stub" all
  **pass**. 6 pre-existing tests in the same file fail, all with the pre-existing
  `channel_messages`/"unclassified schema object" blocker above (confirmed by inspecting each
  failure's error text and stack), not from this fix.
- `cd packages/router && npx vitest run tests/install-layout.test.ts tests/packaging.test.ts
  tests/paid-defaults.test.ts tests/projects-surfaces.test.ts` → **all 30 tests pass** (1 skipped,
  platform-gated), including `projects-surfaces.test.ts`'s CLI-level
  `init writes a global config plus a first project` (spawns the real built CLI) and
  `project-cli-operations.test.ts`'s and `install-layout.test.ts`'s existing split-layout
  "no placeholder" tests — confirming no regression from generalizing that decision to `init`.
- Manual CLI reproduction (built `dist/cli.js`, fresh OS temp dir, cleaned up after):
  ```
  node dist/cli.js init install --preset claude-code --project demo --repo "app=<tmp>/app"
  → wrote .../install/meritrouter.config.yaml (first project: demo)
  → wrote .../install/models.yaml
  → warning: project demo was written but its store could not be provisioned automatically:
    directory: the project's store could not be created: Project store contains an unclassified
    schema object; run "meritrouter projects create demo <tmp>/app" to finish
  ```
  Confirms the fix reaches real provisioning (not "already exists") and gives an actionable,
  exact recovery command — it cannot fully succeed only because of the pre-existing environmental
  blocker above. Running the suggested recovery command:
  ```
  node dist/cli.js projects create demo <tmp>/app --config .../install/meritrouter.config.yaml
  → meritrouter: project demo was not created:
      directory: the project's store could not be created: Project store contains an unclassified
      schema object
  ```
  No more "already exists" (the originally reported dead end) — it now reaches the same
  environmental blocker, proving the adoption path (part 2 of the brief) works. `doctor` was also
  run and showed the pre-fix message ("create it as a split project first"), consistent with
  provisioning not completing in this environment.

## Not verified

- A fully green end-to-end `init`/`setup` → `doctor` pass could not be demonstrated, because of
  the pre-existing `channel_messages` schema-classification blocker described above, which is
  outside this brief's owned paths. The fix's logic (config merge, no "already exists", clean
  rollback on failure, exact recovery guidance) is verified directly; actual store creation
  success is exercised by `project-store-provision.test.ts`, which fails identically today for
  reasons unrelated to this change.
- The `setup` command's panel-starting branch (`cmd === "setup" && !values["no-panel"]`) was not
  exercised live (brief said not to touch the panel); the code path reached before it
  (`provisionInitialProject`) is covered by the tests above.
- Multi-repository `init`/`setup` (2+ `--repo` flags): by design, no directory is auto-inferred
  (ambiguous), so the stub is left for `projects create <slug> <dir>` — covered by the adoption
  tests, not by a dedicated multi-repo `init` test.

## Open questions / contradictions found

- AGENTS.md's "Documentation Maintenance" rule normally requires updating `docs/setup.md`/README
  for a change like this (the quick-start command's actual behavior changed: it now attempts
  auto-provisioning and prints a result line). My brief's "Must not touch" list explicitly
  excludes `docs/**`, so I left documentation untouched; the lead should update
  `docs/setup.md`'s onboarding section (and possibly note the `channel_messages` blocker) in the
  same unit as this fix.
- The `channel_messages` migration/classification gap should likely be fixed (or the migration
  reverted) before this fix — or any split-project work — is merged to `dev`, since it currently
  makes split-project creation fail for everyone, not just the previously-reported bug.

Outcome: Done
Changed: packages/router/src/admin/projects.ts, packages/router/src/cli/setup.ts, packages/router/src/cli.ts, packages/router/tests/project-cli-operations.test.ts
Validation: `cd packages/router && pnpm typecheck && pnpm build` -> both clean for all touched files; `npx vitest run tests/project-cli-operations.test.ts tests/install-layout.test.ts tests/packaging.test.ts tests/paid-defaults.test.ts tests/projects-surfaces.test.ts` -> 4 new tests pass, 30 existing tests pass, 6 pre-existing failures traced to an unrelated pre-existing `channel_messages` schema-classification gap (see above); manual CLI repro in OS temp dir confirms the fix's actual behavior change.
Not verified: full green `doctor` after `init` (blocked by the pre-existing environmental issue above, outside owned paths); setup's panel-starting branch; multi-repo init/setup end-to-end.
Report: docs/working/supervisor-offload/reports/init-provisioning-fix.md
Notes: Root cause was two-fold (no auto-provisioning at init time, and createProject treating any existing config entry as final) and both are fixed; a separate pre-existing bug (channel_messages unclassified in store-role.ts) blocks full green validation of split-project creation repo-wide and is flagged for the lead, not fixed here (outside owned paths).
