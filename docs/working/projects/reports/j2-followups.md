# Report: j2-followups (projects plan, phase J2)

Worker report for the brief "j2-followups" in [projects.md](../../projects.md). Worktree
`D:/sy-wt/pj`, branch `feat/projects`. Nothing committed. j3-ops-docs worked in the same checkout
at the same time. I did not edit `src/core/service.ts` or `src/index.ts`.

## Outcome

Done. All seven items are implemented. The router side of items 2, 3, 5 and 6 is tested in the new
`tests/projects-followups.test.ts` (6 tests). I made 8 mutations, and each one made its test fail.
The panel was checked on a production build on port 4600, against the demo data.

- Full router suite: 477 passed (baseline 468, plus my 6, plus j3's new tests).
- `pnpm -r typecheck` passes. `pnpm -r build` passes.

## What changed and why

### Router (`packages/router`)

| File | Change |
| --- | --- |
| `src/brain/brain.ts` | New `Brain.remove(principal, actor, rel, reason, opts?)`. It uses the brain's own `locked()`: the in-process chain plus `.switchyard-brain.lock`. It also adopts outside edits the same way writes do, so a file that was never committed is committed first. Only a person (`kind: "human"`) may remove `global/**`. Any other path needs write access through `denial`. Generated indexes are refused, and so are non-`.md` paths, a missing file, and an empty reason. By default it writes the trailers `Removed-By` and `Remove-Reason`. `opts.trailers` can replace them, either as a map or as a function of the removed text that runs under the lock. `opts.message` sets the subject. It removes the entry from the FTS index, pushes when `brain.push` is set, and returns `{ path, commit, text }`. |
| `src/brain/promotion.ts` | `PROMOTION_STATUSES` gains `reverted`. The record gets optional `reverted_by`, `reverted_at` and `revert_reason` fields, so old records still validate. New `GlobalPromotions.markReverted(id, by, reason)` runs serialised and moves a record from `approved` to `reverted`. `settle()` only finishes `approved` records, so it never rewrites a reverted lesson. `approve` and `reject` refuse a reverted record ("promotion … is reverted"). |
| `src/admin/promotions.ts` | `revertGlobalEntry` now calls `brain.remove`, and the copied lock code (`withBrainLock`) is gone. The revert trailers are unchanged: `Reverted-By`, `Revert-Reason`, `Reverted-Title`, `Promotion`, `Project`. Afterwards the revert marks the promotion record `reverted` through `markPromotionReverted`. `RevertOutcome` gains `promotionStatus`. |
| `src/admin/projects.ts` | `contextOfTask` resolves through `sy.projects.context(p)`. A `_qualification` task now resolves to the qualification project. Before, it resolved to the primary project, so `/tasks/<id>` redirected into a user project and `/p/<primary>/tasks/<qid>` rendered the task. |
| `src/admin/qualification-work.ts` (new) | `isQualificationTask`, `qualificationTasks(sy, { limit, purpose })` and `qualificationComparisons(sy)`. `qualificationTasks` lists the top-level tasks of `_qualification`, joined to `qualification_tasks` for run, eval, trial and model. `qualificationComparisons` lists comparisons whose runs are in `_qualification`, plus eval-goal comparisons not started yet. All three are re-exported through `insights.ts`. |
| `src/admin/dashboards.ts` | `GlobalDashboard.qualification` gives `_qualification`'s usage (24h and 7d). The totals include it. Before, its requests were missing from the totals. It is still not one of `projects`. |
| `src/admin/project-settings.ts` | New `removedAliases`, `tasksUsingRepository`, `repositoryRemovalErrors`, `mountFolderErrors` and `patchedMounts`. `patchProjectSettings` refuses a patch that removes a repository alias still used by queued or running tasks of that project. "Used" means `repositoryAliases` contains it or `writableRepository` equals it. That refusal is keyed `repositories.<alias>`. It also refuses mounts whose folder does not exist or is not a folder, keyed `brain.mounts.<i>.path`. All patch shapes are covered: `["brain"]`, `["brain","mounts"]`, `[...,i]` and `[...,i,"path"]`. `saveProjectRepositories` returns the removal refusal as a `form` error, because the removed row is no longer on the page. Messages list up to five task ids. Past five, they name three and count the rest. |
| `src/admin/insights.ts` | One hunk: re-exports `qualification-work.js`. |
| `tests/projects-followups.test.ts` (new) | 6 tests, described below. |
| `tests/admin-promotions.test.ts` (**not in my owned list**) | Two expectations changed, because item 3 changes them by design. The revert commit is now `HEAD~1`: the record update follows it. The record's final status is now `reverted`, not `approved`. |

### Panel (`apps/panel`)

- **Item 1.** `app/p/[slug]/jobs/[id]/page.tsx` now reads `insights.contextOfTask(sy, id).repositoryPaths`, the job's own project. I verified that the job page shows `Run it in D:\…\.demo\repo`. I searched the panel for other reads of the global map. `app/all/settings/page.tsx:119` reads it only for a legacy config, which is intended, so I left it.
- **Item 2, `_qualification`:**
  - `lib/links.ts` gains `QUALIFICATION_BASE`, `QUALIFICATION_SLUG`, `itemBase()` and `PATH_HEADER`. `lib/project.ts` warns if `QUALIFICATION_SLUG` and the router's `QUALIFICATION_PROJECT` differ.
  - The task and session detail pages moved into `components/task-detail.tsx` and `components/session-detail.tsx`, so `/p/<slug>/...` and `/all/qualification/...` share them. Their pages are now about 20 lines each. A `DetailScope` (`components/detail-scope.ts`) sets the base path, the back link, whether actions show (resume, cancel, acceptance), and whether list pages exist.
  - New routes:
    - `/all/qualification/tasks/[id]`;
    - `/all/qualification/sessions/[id]`;
    - `/all/qualification/jobs/[id]`, which redirects to the task view.
  - Each route 404s for anything that is not `_qualification`'s (`lib/qualification.ts`).
  - The `/all/qualification` page has two new cards. "Qualification and comparison tasks" (`#work`) lists the tasks, linked to their detail view. "Team vs single agent on evaluation goals" (`#comparisons`) lists `qualificationComparisons`.
  - The comparisons list is now `components/comparisons.tsx`. The Teams page and the Qualification page both use it. The Teams page no longer shows an eval-goal comparison that has not started yet; it points to Qualification instead.
  - `lib/legacy.ts`: `/tasks/<id>`, `/jobs/<id>` and `/sessions/<id>` of a `_qualification` item redirect to `/all/qualification/...`.
  - `components/requests-table.tsx`: on `/all/requests`, a `_qualification` row shows "qualification", linked to `/all/qualification`. Its task links go to the qualification task view.
  - `/all` dashboard: a "Qualification and comparisons" row in the usage table, linked to `/all/qualification#work`.
  - The grid, the switcher and the pickers already exclude `_qualification`, because `projectsGrid` and `findProject` go through the registry. I checked the rendered pages.
- **Item 3 (panel):**
  - The project Brain page's Promotions tab shows a `reverted` badge, plus who, when and why, and the removed path.
  - `/all/knowledge`, Recent decisions: reverted promotions appear with who, when and why.
  - `/all/knowledge`, Removed entries: a "promotion reverted" badge links to the project's promotions.
- **Item 4, archived settings:**
  - `proxy.ts` sets the `x-switchyard-path` request header and always overwrites it. Layouts are not given the path, so they need it.
  - `app/p/[slug]/layout.tsx` lets an archived project through only for `/p/<slug>/settings`. It still 404s every other page, and each page checks its project again.
  - The settings page shows a warn callout with "Unarchive project" and wraps the cards in `<fieldset disabled>`. The General card says the project is archived instead of offering Archive.
  - The settings PATCH and repositories PUT routes answer 409 for an archived project.
  - The shell's nav shows only "Project settings" for a project that is not live.
- **Item 5.** The repositories card shows the router's refusal as the form error.
- **Item 6.**
  - `RowsEditor` (`components/client/settings-rows.tsx`) gains an optional `errors` prop, keyed `<row>.<column>`.
  - The Brain card maps `brain.mounts.<i>.<field>` errors onto that mount's field, and says "Not saved: check the highlighted mounts."
- **Seed (`scripts/seed-demo.mjs`):**
  - `phase()` accepts `purpose`.
  - One real qualification trial runs in `_qualification`. It is linked to the first illustrative qualification run (a `qualification_tasks` row).
  - Storefront's approved "Keep money in integer minor units" lesson is reverted by "you", so a reverted promotion shows.

## Commands run and observed results

- `npx vitest run tests/projects-followups.test.ts`. The first run had 1 failure: my assertion expected the git author `supervisor:alpha-job`, but `commitAs` writes `supervisor alpha-job (model)`. I fixed the assertion, and the file then passed 6 of 6.
- `npx vitest run` on followups, admin-promotions, admin-project-settings, projects-surfaces and brain gave 1 failure in `admin-promotions` "reverts a global entry…". That test expects the old behaviour: HEAD is the revert commit and the record stays `approved`. I updated its two expectations, and the file then passed 5 of 5.
- **Mutation check.** Each mutation reverts one fix, then I restore the file. The script is `j2f-mutate.mjs` in my scratchpad. Each run is `npx vitest run tests/projects-followups.test.ts -t "<test>"`, and every one exited with 1 failed:
  - M1, `contextOfTask` uses `get()`: "is never listed as a project…" fails.
  - M2, the totals leave out qualification: the same test fails.
  - M3, the comparisons are unfiltered: "lists comparisons on eval goals…" fails.
  - M4, the revert leaves the record approved: "a revert goes through the brain's lock…" fails.
  - M5, agents may remove `global/`: "removes with a recorded reason…" fails.
  - M6, `Brain.remove` skips the lock: "a revert goes through the brain's lock…" fails, because the file is removed while another process holds the lock.
  - M7, repository removal unchecked: "refuses to remove a repository…" fails.
  - M8, mount folders unchecked: "refuses brain mounts…" fails.
  - Afterwards, `git diff --stat` matched the pre-mutation state.
- `pnpm --filter switchyard-router build`: passes.
- `pnpm -r typecheck`: "packages/router typecheck: Done", "apps/panel typecheck: Done".
- `cd packages/router && npx vitest run` at the end: **Test Files 50 passed (50), Tests 477 passed (477)**.
- `pnpm -r build`: router Done; panel "Compiled successfully", Done.
- `pnpm --filter switchyard-panel seed:demo`: completed. The new lines were "qualification: one eval trial (reserved project) completed" and "storefront: approved lesson reverted  promotion reverted".
- **Production panel on 127.0.0.1:4600** (`next start`, `SWITCHYARD_CONFIG=.demo/switchyard.config.yaml`). Status codes observed:
  - 200: `/`, `/all`, `/all/requests`, `/all/qualification`, `/all/qualification/tasks/<q>`, `/all/qualification/sessions/<qs>`, `/all/knowledge`, `/p/legacy-billing/settings` (archived), `/p/storefront/settings`, `/p/storefront/brain?view=promotions`, `/p/demo/teams`, `/p/demo/jobs/<id>`, `/p/demo/tasks/<id>`, `/p/demo/sessions/<id>`, `/p/demo/settings`.
  - 307 to `/all/qualification/tasks/<q>`: `/all/qualification/jobs/<q>` and `/tasks/<q>`.
  - 307 to `/all/qualification/sessions/<qs>`: `/sessions/<qs>`.
  - 404: `/p/legacy-billing`, `/p/legacy-billing/jobs`, `/p/legacy-billing/brain`, `/p/demo/tasks/<q>`, `/p/_qualification`, `/p/_qualification/tasks/<q>`, and `/all/qualification/tasks/<demo task>`.
- **API checks:**
  - PATCH `/api/projects/legacy-billing/settings` and PUT `.../repositories` returned 409 "project legacy-billing is archived: unarchive it to change its settings".
  - PUT `/api/projects/storefront/repositories {repositories:[]}` returned 400 "repository app is used by 1 queued or running task (t_0mvhpq1bq949a206ea91d); cancel them or let them finish before removing it".
  - PATCH storefront settings with a mount at `no-such-folder` returned 400 with `fieldErrors["brain.mounts.0.path"]`.
- **Page content:**
  - `/` has no `_qualification`.
  - `/all/requests` links qualification rows to `/all/qualification`.
  - `/all` shows the "Qualification and comparisons" usage row. Its only other `_qualification` text is the React key `__qualification`.
- **Unarchive.** I clicked "Unarchive project" on the archived settings page, through the DevTools protocol. The page re-rendered as editable with the full project nav, and `/p/legacy-billing` returned 200. I archived it again through the API, after which `/p/legacy-billing` returned 404.
- **Panel stopped.** The `next start` process on 4600 was stopped (`Get-NetTCPConnection -LocalPort 4600` shows 0 listeners). The demo was left archived as seeded.

## Screenshots

I looked at each one. They are in
`C:\Users\mrjoh\AppData\Local\Temp\claude\d--SwitchYardRouter\f513290c-d4c1-4d44-81c0-be35d4674ab1\scratchpad\shots\`:

| File | Shows |
| --- | --- |
| `01-qualification-work.png` | `/all/qualification#work`. The task list has "Eval completion-t1-1, trial 1", model GPT-OSS 120B, Completed. Below it is the empty eval-comparisons card. |
| `02-qualification-task.png` | `/all/qualification/tasks/<q>`. The task detail has a "← Qualification" back link and no resume or cancel buttons; result, contract and verification are shown. |
| `03-knowledge-reverted.png` | `/all/knowledge`. Recent decisions shows "Keep money in integer minor units — Reverted, Reverted by you …: Duplicates…". Removed entries shows the "promotion reverted" badge. |
| `04-archived-settings.png` | `/p/legacy-billing/settings`. The archived callout has Unarchive. The controls are disabled, and the nav shows only Project settings. |
| `05-repo-removal-refused.png` | Storefront settings after Remove app and Save. The refusal names the task. |
| `06-mount-missing.png` | Storefront Brain card. The error sits under the mount's Folder field. |
| `07-storefront-brain-promotions.png` | Project Brain, Promotions: a `reverted` badge, who, when and why. |
| `08-demo-teams-comparisons.png` | The Teams page comparison list after the extraction. It renders as before. |
| `09-unarchived-after-click.png` | After clicking Unarchive: the settings are editable and the full nav is back. |

## Not verified

- **An eval-goal comparison in the panel.** The demo has none: its comparison uses a supplied goal in `demo`. So the `/all/qualification#comparisons` list was seen only in its empty state. Its data function is covered by the router test, and the list component is the one the Teams page renders (screenshot 08).
- **A real qualification run (`qualifier.start`) in the demo.** The trial is a real `_qualification` task, but it is linked by hand to an illustrative run row.
- **A session detail page under `/all/qualification/sessions/<id>`.** It returned 200 but was not screenshotted. The project session page after the extraction was only requested (200), not screenshotted.
- **Cross-process races of `Brain.remove`.** The lock-file wait was tested; a write from a real second process was not.
- **`createProject` mounts.** The new-project path does not check that mount folders exist. Only settings saves do, through `patchProjectSettings`.
- **Removing a repository through a legacy single-project config.** The same code path handles it, but no test covers it.
- **Unarchive from the settings page on a narrow screen**, and every theme other than dark.
- **No live provider runs**, as usual.

## Open questions or contradictions found

1. **`tests/admin-promotions.test.ts` is outside my owned paths.** Item 3 necessarily changes two of its expectations, and I made only those two edits.
2. **"Running or queued" uses `RUNNING_STATES` plus `QUEUED_STATES`.** Interrupted tasks that name an alias do not block removal. If one of them is resumed later, it would fail at prepare. Should interrupted tasks block removal too?
3. **The archived settings layout check uses a request header set by `proxy.ts`.** Next layouts are not given the path. The alternative was route groups (`(live)` vs settings), which would have moved every project page. Each page also checks its project itself, so a client-side move to another page of an archived project is still a 404.
4. **`/all/qualification/jobs/<id>` redirects to the task view.** No job view (questions, branches, plan) exists for comparison team runs under `/all`. If one is wanted, `jobs/[id]/page.tsx` could be extracted the same way.
5. **Docs (for j3 or the supervisor) should describe:**
   - `Brain.remove` and the `reverted` promotion status;
   - `/all/qualification` as the home of `_qualification` work;
   - the repository-in-use and mount-folder refusals;
   - the read-only archived settings page.
