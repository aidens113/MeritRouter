# Report: repo-autoprep

Worker report for the brief "repo-autoprep" (worktree `D:/sy-wt/rp`, branch `feat/repo-autoprep`, not committed).

## Outcome

Done. A project's repository folder that is missing, a plain folder, or a git repository with no
commits is now set up by SwitchYard itself. The "Repository app is missing or not a git
repository" attention item is gone. Only three things are still reported as errors: git not
installed, a file where the folder should be, and permissions. Each comes with a plain fix.

## What changed and why

New files:
- `packages/router/src/workspaces/repository-prepare.ts`
  - `prepareRepository(path)` returns `{ ok: true, action: created | initialized | snapshot | unchanged, gitignore, message }` or `{ ok: false, error: git_missing | not_a_folder | permission | busy | git_failed, message }`.
    - **Missing folder:** created with `mkdir -p`, then `git init`, then an empty commit "SwitchYard: initial commit".
    - **Plain folder:** `git init`, plus `DEFAULT_GITIGNORE` if the folder has no `.gitignore`, then `git add -A` and a commit "SwitchYard: initial snapshot".
    - **Unborn repository:** the same snapshot. It gets no `.gitignore`, and the commit is empty if there is nothing to add.
    - **Repository with history:** never touched. A file-system fast path (`folderState`) returns `unchanged` without running any git process. A `.git` that is a file, such as a linked worktree, also counts as a repository.
  - Commits use `-c user.name=SwitchYard -c user.email=switchyard@localhost -c commit.gpgsign=false`.
  - **Concurrency:** a cross-process lock file in `os.tmpdir()` (`switchyard-prepare-<sha1>.lock`, created with `wx`), never inside the repository. It is refreshed every 10 s while held, taken over after 120 s as stale, and a caller waits up to 60 s before returning `busy`. Under the lock the state is read again, and HEAD is checked once more just before the commit.
  - Git missing is detected with `git --version` (ENOENT). Permission errors are recognised from EACCES/EPERM or "permission denied" in git's stderr.
  - Also exports `folderState(path)` (fs only) and `preparationHint(state)` for the forms.
- `packages/router/src/projects/repository-setup.ts`
  - `prepareProjectRepositories(deps, { projects? })` prepares every configured repository of every project, legacy configs included. A folder shared by several projects is prepared once.
  - `recordPreparation` writes a `repository_prepare` event (task_id NULL, data `{ project, alias, path, action, error?, message }`). `unchanged` is not recorded, and an identical repeated failure is recorded once.
  - `repositoryNotices(db, ctx, now)` returns the latest successful preparation per configured repository (alias + path) from the last 7 days.
  - `repositoryProblems(db, ctx)` returns a file in place of the folder (live check), plus the latest recorded failure while the repository is still not ready.
- `packages/router/tests/repository-prepare.test.ts`: 11 tests (listed under Commands).

Changed files:
- `src/core/service.ts`
  - New `Switchyard.prepareRepositories({ projects? })`, one run at a time per instance.
  - It is called fire-and-forget in `startWorker` (service start: MCP server, `switchyard worker`, daemon), and after a config reload while the worker runs.
  - `close()` waits for a running preparation, so tests do not hit EBUSY.
- `src/admin/projects.ts`
  - `projectAttention` drops the old repository item and uses `repositoryProblems`.
  - New `projectNotices` and `prepareRepositoryFolders`.
  - `validateNewProject` rejects only an empty path or a file.
  - `createProject` prepares the repositories after validation and before writing the config. Its result has a new `prepared: string[]`.
- `src/admin/project-settings.ts`
  - `RepositoryPathCheck` gains `state` and `hint`. `problem` is now only "enter the repository's folder" or "is a file, not a folder".
  - `validateProjectRepositories` follows the same rule.
  - `saveProjectRepositories` is now **async**: it validates, then prepares every row (errors are keyed `repositories.<i>.path`), then writes. A refused save prepares nothing.
  - `repositoryRows` carry `hint`.
- `src/admin/dashboards.ts`: `ProjectOverview.notices: string[]`.
- `src/cli/doctor.ts`: `projectChecks` / `doctorChecks` accept `prepared`.
  - A repository SwitchYard just prepared is `ok` with what was done.
  - A failed preparation is `fail` with the fix.
  - Without `prepared` (library callers), a folder not set up yet is a `warn` saying what will happen.
- `src/cli.ts`: `doctor` runs `sy.prepareRepositories()` first, then passes the result in.
- `src/cli/projects.ts`: `projects create` prints the `prepared` lines.
- `src/index.ts`: exports the new functions and types.
- **Panel:**
  - `lib/sy.ts`: preparation runs on open and after a config reload.
  - `app/p/[slug]/page.tsx`:
    - The overview awaits `sy.prepareRepositories({ projects: [slug] })` before it renders.
    - New info Callout "Repositories set up". It has no dismiss control.
    - The repository badge now reads "not set up" in the warn tone (it was "missing" in the bad tone).
  - `app/api/projects/route.ts`: `GET ?path=` inspects a folder for the new-project form.
  - `app/api/projects/[slug]/repositories/route.ts`: awaits the save, and its doc comments are updated.
  - `components/client/new-project.tsx`: the folder is checked on blur and the server's hint shows under the field; the copy is updated.
  - `app/p/[slug]/settings/forms.tsx`: a neutral hint row with an Info icon. Real problems still show in warn colour, and save errors inline. After a save, each row shows its check as the server now finds it.
- **Existing tests updated for the new rule:**
  - `tests/admin-project-settings.test.ts`: a plain or missing folder is no longer a field error; `await` added.
  - `tests/projects-followups.test.ts`: `await` added.
  - `tests/projects-surfaces.test.ts`: the CLI refusal case now uses a file instead of a missing folder.

Where preparation runs:
- project creation (`createProject`, which serves both the panel `POST /api/projects` and the CLI `projects create`)
- repository save (`saveProjectRepositories`, panel `PUT /api/projects/<slug>/repositories`)
- service start (`startWorker`), and config reloads in a running service
- the panel process (open and reload), and each project overview load (awaited)
- `switchyard doctor`

Default .gitignore (`DEFAULT_GITIGNORE`):
```
node_modules/
.env
.env.*
*.log
dist/
build/
.venv/
__pycache__/
.DS_Store
```

## Commands run and observed results

- `pnpm -r typecheck`: router Done, panel Done (after the final edits).
- `pnpm -r build`: router and panel Done. After the last cosmetic edit to the two forms, `pnpm --filter switchyard-panel build` was rerun and succeeded.
- `npx vitest run tests/repository-prepare.test.ts`: 11 passed. The tests:
  - created
  - initialized with the default .gitignore (node_modules, .env and *.log left untracked)
  - existing .gitignore respected
  - unborn repository gets a snapshot
  - unborn empty repository
  - history untouched, plus idempotence
  - concurrent double prepare yields one commit (plain and missing folders)
  - a file, and git missing
  - service start prepares and records an event, the overview shows the notice, attention is empty
  - attention is gone, doctor warn/ok/fail, a failure is recorded once
  - create and save prepare
- **Identity:** `GIT_CONFIG_GLOBAL` points at a temp file. It contains `user.useConfigOnly = true` rather than being empty, so git cannot guess an identity from the host name. `GIT_CONFIG_NOSYSTEM=1` is set and the identity env vars are unset.
- **Mutation checks** (script `rp_mutate.py` in the scratchpad applies each mutation, runs the file, and reverts). Every one failed at least one test:
  - removing the identity: 10 tests failed
  - lock removed: the concurrency test failed
  - lock and re-check removed: the concurrency test failed
  - no .gitignore written: 3 failed
  - an existing .gitignore overwritten: 1 failed
  - repository with history touched: 3 failed
  - no `git add`: 4 failed
  - git-missing detection removed: 1 failed
  - file check removed: 2 failed
  - no preparation at service start: 1 failed
  - old attention item restored: 1 failed
  - failure dedupe removed: 1 failed
  - no events recorded: 3 failed
  - create result not reported: 1 failed
- **Full suite `npx vitest run`:**
  - Run 1: 487/488. The failure was `projects-surfaces` "projects create ...", which still expected the old missing-folder refusal. I updated it and it then passed alone (8/8).
  - Run 2: 487/488. The failure was `operations` "daemon > stop() ...", with ENOTEMPTY in afterEach `rmSync` (the known flake). It uses a fake spawner, so no preparation runs in it. Rerun alone 3 times: 23/23 each time.
  - The baseline was 477; 11 tests were added, giving 488.
- **Live panel:**
  - **Setup:** I seeded the demo (`pnpm --filter switchyard-panel seed:demo`), copied `.demo` to the scratchpad (`rp-demo`) so the other worker's `.demo` was not edited, and pointed storefront `app` at the missing temp folder `%TEMP%\sy-rp-live-co9A\my-app`, plus `docs` at a plain temp folder holding a README. I started `next start -p 4601` with `SWITCHYARD_CONFIG` pointing at the copy.
  - **Overview:** shows the info Callout "Repositories set up" with "Repository app: SwitchYard created ...\my-app and set up git." and "Repository docs: SwitchYard set up git in ...\plain-docs, added a default .gitignore, and committed a first snapshot." It also shows "Nothing needs your attention".
  - **git log:** my-app has "SwitchYard <switchyard@localhost> SwitchYard: initial commit". plain-docs has the "initial snapshot" commit, tracking `.gitignore` and `README.md`.
  - **API save:** `PUT /api/projects/storefront/repositories` with a missing folder and a plain folder returned ok, and both got commits. Adding a file path returned 400 with `fieldErrors["repositories.4.path"] = "... is a file, not a folder"`. `GET /api/projects?path=<file>` returned `state: file` with the problem.
  - **Remaining-error case:** I hand-edited the config so `bad` points at a file. The overview then shows one attention item, "Repository bad: ... is a file, not a folder. Choose a folder in the project settings." with a "Fix →" link, and the repository badge "not set up".
  - **Pages:** `/`, `/p/storefront`, `/p/storefront/settings`, `/new`, `/p/demo` and `/api/projects/storefront/repositories` all returned 200.
  - **Cleanup:** I stopped the panel (port 4601), deleted the temp folder, the demo copy and the Chrome profile, and found no leftover `switchyard-prepare-*.lock` in the temp folder.
- **Screenshots** (scratchpad `C:\Users\mrjoh\AppData\Local\Temp\claude\d--SwitchYardRouter\f513290c-d4c1-4d44-81c0-be35d4674ab1\scratchpad\`), each looked at:
  - `rp-overview.png`: the notice, plus the remaining-error attention item.
  - `rp-repositories-hint.png`: settings rows with ok checks, the inline file problem, and the hints "will be created and set up with git" and "git will be set up and the current files committed".
  - `rp-new-project-hint.png`: the new-project form hint "will be created and set up with git".

  The form hints were produced by typing into the inputs over CDP (`rp_shots.mjs`) and dispatching focusout.

## Not verified

- **Permission errors.** Not reproduced: Windows ACLs are not easy to set up in a test. The detection (EACCES/EPERM, or "permission denied" in stderr) is untested.
- **The `busy` lock-timeout path** and the stale-lock takeover.
- **Cross-process concurrency.** The test runs two concurrent calls in one process. They take the same file lock a second process would, but no second process was run.
- **The real MCP server, `switchyard worker`, or a daemon starting** against a missing repository. Only `new Switchyard(..., { worker: true })` was tested.
- **CLI `doctor` and `projects create` text output** with preparation. Doctor was covered through `doctorChecks`; the `projects create` refusal was covered through the CLI test.
- **Very large folders.** A first snapshot runs `git add -A` on everything not ignored, so a huge folder (or a user .gitignore that does not exclude node_modules) could take long. The overview awaits preparation, so the first overview load after pointing at such a folder would be slow.
- **The `reftable` git ref backend.** `folderState` returns `unknown` for it and leaves the decision to git; untested.
- **Light theme screenshots.** Only the default dark theme was captured.

## Open questions or contradictions found

- **Authored docs still state the old rule.** `docs/setup.md:85` and `docs/setup.md:110` say each repository must exist and be a git repository. I did not edit them because they are not in my brief; the supervisor should update them, and probably operations/decisions with the new `repository_prepare` event.
- **Contract change for the panel.** `saveProjectRepositories` is now async, and `RepositoryPathCheck.problem` is no longer set for missing or non-git folders.
- **A deliberate choice to confirm.** User git hooks are not skipped (`--no-verify` is not used), so a global `core.hooksPath` hook that fails would show as `git_failed` with git's message.
- **A deliberate choice to confirm.** Notices show for 7 days after the preparation (`PREPARE_NOTICE_MS`); the brief did not say how long.
- **The generic settings patch (`patchProjectSettings`) does not prepare.** It can still change a repository path. Such a folder is prepared at the next overview load, panel reload or service reload rather than at save time.
- **I re-seeded the worktree's `apps/panel/.demo`.** The live-control worker shares this checkout and may have been using it; I edited only a private copy.
