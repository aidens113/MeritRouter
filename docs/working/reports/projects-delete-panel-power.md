# Report: projects-delete-panel-power

- Worker brief: `### Brief: projects-delete-panel-power` in `docs/working/live-validation.md`
- Worktree: `D:\SwitchYardRouter\.claude\worktrees\agent-a13bdc71ec1250343`, branch `feat/panel-controls` (not committed)
- Date: 2026-10-21

## Outcome

Done, with two supervisor follow-ups that fall outside my ownership: `cli.ts` must declare the
`--confirm` flag, and `cli/doctor.ts` should call `panelBuildCheck()`. Both are described below.
Task 4 could not make the router external. Instead, `ensurePanel` reports a panel build that is older
than the router build, and `panelBuildCheck` gives `doctor` the same check (the brief's fallback).

The worktree was created from `d735298`, which does not have the brief or `markPanelStopped`. Before
starting, I fast-forwarded `feat/panel-controls` to `dev` (`6afc11e`) with `git merge --ff-only dev`.
This made no commit.

## What changed and why

Router:
- `src/projects/deletion.ts` (new) does the deletion work:
  - `projectFootprint` collects task ids, job, session, and artifact counts, session log and
    artifact paths, the requests and paid requests that are kept, and the SwitchYard worktrees. It
    finds worktrees with `git worktree list` in the project's repositories and in the workspaces'
    source folders. A worktree counts only if it is under `<storage>/worktrees` and named
    `<task>-r<n>-*` or `job-<task>-*`. Leftover folders with those names also count.
  - `purgeProjectRows` deletes the project's rows from about 25 tables in one IMMEDIATE
    transaction. It checks again for running or queued tasks inside the transaction. It sets
    `model_requests.project_id` to `''`, and keeps `request_charges` and `paid_spend`.
  - `removeProjectFiles` deletes session logs and artifacts.
  - `removeProjectWorktrees` runs `git worktree remove --force --force`, then `prune`. Branches
    are kept.
- `src/admin/projects.ts` adds the coordinating functions:
  - `previewProjectDeletion(sy, slug)` returns counts, kept items, `removes`/`keeps` sentences, and
    `blockers`.
  - `deleteProject(sy, slug, { confirm })` checks the confirmation, then the blockers (running or
    queued tasks, the last live project, a single-project config). It builds the config without
    `projects.<slug>` and validates it before deleting anything. If the project was the primary
    project, it moves `brain.project` to another live project. Then it purges the rows, writes the
    config through `writeConfigText` (which keeps the `.bak`), deletes the `projects` row again in
    case another process reloaded in between, removes the files and worktrees, and removes the
    brain folder.
  - Both are reachable through the `insights` facade.
- `src/brain/brain.ts` adds two methods:
  - `projectFolderFiles(slug)` counts the files in another project's brain folder.
  - `removeProjectFolder(slug, actor, reason)` takes the repository lock and commits outside edits
    first, so their text stays in the brain's history. It then removes `projects/<slug>/` in one
    commit with `Removed-By` and `Remove-Reason` trailers, clears the `brain_files`/`brain_fts`
    rows, and regenerates the root `README.md`. It refuses to remove its own project's folder.
- `src/projects/backfill.ts` fix: the backfill on start set
  `model_requests.project_id = (subquery)` whenever a charge existed. Once a charge names a deleted
  task, that subquery is NULL, which breaks the NOT NULL constraint on the column. The backfill now
  only touches requests whose charges join to an existing task.
- `src/cli/projects.ts` adds `projects delete <slug>`. Without `--confirm` it prints the preview
  and exits 1 when blocked. With `--confirm <slug>` it deletes. It also adds `confirm?: string` to
  `ProjectsFlags`.
- `src/operations/panel.ts` adds:
  - `turnPanelOff(cfg, { delayMs, exit })`, which calls `markPanelStopped` and then exits after
    300 ms.
  - `panelBuildStale(panelDir, routerDir)`, which compares `.next/BUILD_ID`'s mtime with the newest
    file in the router's `dist/`.
  - `panelBuildCheck()` for `doctor`, and `routerBuildDir()`.
  - `ensurePanel` now adds the warning to `detail` and sets `PanelStatus.warning`.
- `src/index.ts` (one line, outside my ownership; no other brief touches it) exports
  `markPanelStopped, panelStopFile, turnPanelOff`. The panel can only import from the package root,
  and nothing exported `operations/panel` before.

Panel:
- `components/client/confirm-dialog.tsx` now takes `children`, `confirmDisabled`, a `destructive`
  tone (solid red), and a `ReactNode` description. If `onConfirm` returns `false`, the dialog stays
  open, for example to show an error. The existing caller (`actions.tsx`) is unchanged.
- `components/ui.tsx` adds a `destructive` button variant.
- `components/client/delete-project.tsx` (new) is the `DangerZone`:
  - Modal 1 loads `GET /api/projects/<slug>/deletion` when it opens. It shows the Removed and Kept
    lists with counts and any blockers; Continue is disabled while the project is blocked.
  - Modal 2 asks for the slug before the red "Delete permanently" button, which stays disabled
    until the slug matches. It sends `DELETE /api/projects/<slug>` with `{confirm}`, then goes to
    `/`.
- `app/p/[slug]/settings/page.tsx` adds the Danger zone after the fieldset, so an archived project
  can still be deleted, plus a "Danger zone" item in the section nav.
- `app/api/projects/[slug]/route.ts` adds `DELETE`. `app/api/projects/[slug]/deletion/route.ts`
  (new) adds `GET`.
- `app/api/panel/stop/route.ts` (new) is `POST`: same-origin only, calls `turnPanelOff(sy.cfg)`,
  responds, and the process exits.
- `components/client/shell.tsx` adds the power button. On desktop it sits beside the project
  switcher at the top of the sidebar, because desktop has no top bar. On phone it is in the top
  bar before the menu button. It opens a confirmation with the brief's text, then replaces the
  shell with a static "Panel turned off" screen.

Docs: `docs/operations.md` has a new "Deleting a project" section and a new "The web panel: turning
it off, and rebuilding it" section (power button, and the Turbopack root cause). I also added a
pointer under Housekeeping.

Task 4 root cause: the built server chunks contain router strings (23 chunks held `storage.directory
cannot change while running`). `better-sqlite3` appears only as a hashed external
(`better-sqlite3-<hash>`), and `switchyard-router` never does. My conclusion is that Turbopack
externalizes `serverExternalPackages` only when the resolved real path is under `node_modules`. The
pnpm `workspace:*` link resolves to `packages/router`, so the router is always bundled. This comes
from the observed build output plus my understanding of Turbopack's resolve plugin; I did not read
Turbopack's source.

I rejected the alternatives:
- An injected (copied) dependency changes the lockfile and goes stale after every router rebuild.
- A `resolveAlias` shim needs either top-level-await re-exports of every name or `require(esm)`,
  which needs a flag on Node 22.11.

## Commands run and observed results

- `git merge --ff-only dev`: fast-forwarded d735298..6afc11e.
- `pnpm install --frozen-lockfile`: done. It warned that the `switchyard` bin could not be created
  because `dist` was not built yet.
- Baseline `pnpm --filter switchyard-panel build`, then `grep -rl "storage.directory cannot change
  while running" .next/server`: 23 non-map chunks matched, so the router is bundled.
- `npx vitest run tests/projects-delete.test.ts`: 5 passed. Covered:
  - Preview counts and the wrong-confirmation refusal.
  - The queued-task refusal, with nothing removed.
  - The full delete:
    - The config entry is gone and the `.bak` exists.
    - The rows are gone. Requests are unlinked; charges and `paid_spend` are kept.
    - The channel trigger is back and foreign keys are back on.
    - Session logs and artifacts are deleted.
    - Both worktrees are removed, the job branch is kept, and the repository README is untouched.
    - The alpha worktree is kept.
    - The brain has a "Remove project beta" commit with a Remove-Reason trailer, the outside edit is
      in history, and the root index no longer lists the project.
  - Backfill keeps the unlinked requests global.
  - Refusals for the last live project, the last unarchived project, and the single-project config.
  - Deleting an archived project, and moving the primary to another project.
  - `turnPanelOff`: the marker is written, exit is called after the delay, and `ensurePanel` then
    returns `stopped`.
  - `panelBuildStale`: stale, fresh, and unbuilt cases.
- `pnpm -r typecheck`: router done, panel done.
- `cd packages/router && npx vitest run`: 53 files, 502 tests passed.
- `pnpm -r build`: router done, panel done (routes `/api/panel/stop` and
  `/api/projects/[slug]/deletion` are listed).
- Demo panel (`seed:demo`, then `next start -p 4591` with `SWITCHYARD_CONFIG=.demo/...`, never 4477
  or the user's config):
  - Root, `/p/demo/settings`, `/p/storefront/settings`, `/p/legacy-billing/settings`, and
    `/api/projects/{storefront,demo,legacy-billing}/deletion` all answered 200.
  - A headless Chrome script (CDP) took screenshots at 1366x900 and 390x844, in light and dark:
    the Danger zone, modal 1, modal 2 with the slug typed, and the power confirmation. It also took
    one of a blocked modal 1 (storefront, 2 queued tasks; Continue disabled).
  - "Delete permanently" was disabled before typing and enabled after.
  - Deleting `legacy-billing` through the UI went to `/` and the grid no longer lists it. The brain
    log shows "Remove project legacy-billing | human | project legacy-billing was deleted". The
    `billing` repository folder is intact, and `/p/legacy-billing/settings` now answers 404.
  - Power off through the UI showed "Panel turned off". The `next start` process exited with code
    0, the port was closed, and `.demo/.switchyard/panel.stopped` was written by "the panel's power
    button".
  - After a restart, the API checks:
    - A cross-origin `POST /api/panel/stop` got 403 and the panel stayed up.
    - `DELETE` with a wrong confirm got 409.
    - `DELETE` on storefront, which has queued tasks, got 409.
    - An unknown slug got 404.
  - I then stopped that panel (my own process, matched by its command line). Nothing runs on 4591.
- `node dist/cli.js projects delete storefront --config <demo>` printed the preview and the blocker
  and exited 1. Adding `--confirm storefront` fails with "Unknown option '--confirm'" until `cli.ts`
  declares the flag.

Screenshots are in
`C:\Users\mrjoh\AppData\Local\Temp\claude\d--SwitchYardRouter\af9464f4-1d0a-47ca-842e-d3c47712e7a6\scratchpad\shots\`
(`{desktop,phone}-{light,dark}-{1-danger-zone,2-modal1,3-modal2,4-power-confirm}.png`,
`desktop-light-5-modal1-blocked.png`, `desktop-light-6-after-delete.png`,
`{phone-dark,desktop-light}-7-panel-off.png`).

## Not verified

- `projects delete --confirm` end to end through the CLI, because `cli.ts` is not mine. The same
  code path is covered by the tests and the panel.
- `doctor` reporting a stale build. `panelBuildCheck()` exists, but `cli/doctor.ts` does not call
  it.
- The stale-build warning against a real running panel.
- Deletion while another process (a worker or the MCP server) is running against the same store.
  The re-check inside the transaction and the second `projects` row delete exist for that case,
  but no test runs it.
- Windows EBUSY on worktree removal while something holds files. It would appear in `problems`;
  this was not exercised.

## Open questions or contradictions found

1. **Supervisor wiring needed (outside my ownership):**
   - `src/cli.ts` `parseArgs` options: add `confirm: { type: "string" },`. `projectsCommand`
     already reads `values.confirm`.
   - `src/cli/help.ts`, after the archive line:
     ```
       projects delete <slug> [--confirm <slug>]
                                     without --confirm: what deleting removes and keeps, with counts;
                                     with it: delete the project (settings, tasks, sessions, logs,
                                     artifacts, its SwitchYard worktrees, brain folder; repositories,
                                     branches, requests, and spend are kept). Refused while it has
                                     running or queued tasks, and for the last live project
     ```
   - `src/cli/doctor.ts`: add a check from `panelBuildCheck()` in `operations/panel.ts`
     (`{ ok, detail }`), for example `{ check: "panel build", ok, level: ok ? "ok" : "warn", detail }`.
2. **`src/index.ts` was edited (one export line) although the brief does not list it.** The panel's
   stop route needs `turnPanelOff`/`markPanelStopped` from the package root. No other brief owns
   `index.ts`.
3. **Kept charges and foreign keys.** The brief says to keep charge rows, but
   `request_charges.task_id REFERENCES tasks(id)` with `foreign_keys = ON`. The purge turns foreign
   keys off for its transaction (the pragma cannot change inside one) and back on afterwards; the
   test checks they are back on. The kept charges point at deleted tasks:
   - `PRAGMA foreign_key_check` will list them.
   - A future migration that rebuilds `request_charges` with an `INSERT ... SELECT` under foreign
     keys would fail on them.
   - Requests views that show `task_ids` will show ids that no longer resolve (`requests-table` is
     the caching worker's file).

   Deleting the charges instead would keep the store consistent. That is the supervisor's call.
4. **Stale primary brain handle.** `Switchyard.brain` (core/service.ts) is bound to the primary
   project when the service is built. After the primary project is deleted, a long-running process
   (the panel, a worker) keeps the old `Brain` until restart, and the brain cache keeps an entry for
   the deleted slug. `reloadIfChanged` should rebind `brain` to the new primary. That is in
   `core/`, which the caching brief owns.
5. **`job_channel` append-only trigger.** Deleting a project drops and recreates
   `job_channel_no_delete` inside the purge transaction, using its stored SQL. The test checks the
   trigger still blocks deletes afterwards.
