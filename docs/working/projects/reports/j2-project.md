# Report: j2-project (projects plan, phase J2)

Worker report for the brief "j2-project" in [projects.md](../../projects.md). Worktree
`D:/sy-wt/pj`, branch `feat/projects`. Nothing committed. Port 4477 was never used; the panel ran
on 4599 against a copy of the demo in my scratchpad and is stopped.

## Outcome

Done.
- `/p/<slug>/settings` is a real page with these sections: General, Repositories, Brain,
  Scheduling and budgets, and four override sections (Verification, Team policy, Commands and
  paths, Roles and charters). It uses the global settings page's `SectionNav`.
- Every override row shows the inherited global value, with "Override for this project" and
  "Reset to global". Saving goes through `insights.saveProjectSettings`, which calls
  `patchProjectSettings` and writes `projects.<slug>`.
- The project Brain page has a Promotions tab, and uses the per-project index when
  `projects/<p>/README.md` exists.

Checks:
- Router build, `pnpm -r typecheck`, and `pnpm -r build` pass.
- The full suite passes: 48 files, 468 tests (baseline 451; 5 of the new tests are mine).
- I requested every touched page and API route, took screenshots at 1440 and 600 widths, and
  looked at them.

## What changed and why

Router (`packages/router`):
- `src/admin/project-settings.ts`: additions only. `insights.ts` already re-exports the module,
  so I did not edit `insights.ts`, `index.ts`, or `service.ts`.
- New `tests/admin-project-settings.test.ts` (5 tests).

Panel (`apps/panel`), new files:
- `app/p/[slug]/settings/page.tsx` (server). This rewrites the placeholder.
- `app/p/[slug]/settings/fields.ts`: labels, plain-language help, and the editor kind for each
  override.
- `app/p/[slug]/settings/overrides.tsx` (client):
  - The override row: the global value, "Override for this project", "Reset to global", and the
    editors (int, number, bool, enum, list, text, YAML, a structured role editor, and
    auto-approve rows).
  - `OverridesCard`, `SaveBar`, and the mapping of server field errors onto rows.
- `app/p/[slug]/settings/forms.tsx` (client):
  - `GeneralCard`: the name, a read-only slug, and archive with an inline confirmation. A refusal
    shows the router's message, and a success goes to `/`.
  - `RepositoriesCard`: add, remove, and writable. On blur, the server checks the folder and the
    resolved path is shown. Errors appear inline per row and field.
  - `BrainCard`: the project's own mounts (the install-wide mounts are listed read-only), plus the
    overrides for access approver and auto-approve rules.
  - `SchedulingCard`: `priority`, `max_concurrent_tasks`, `request_share` (entered as a percent),
    and `paid_budgets` (day, week, month). The help is computed from the global caps, for example
    "served 2x as often", "within the install's 4", or "no allocation is set, so a share has no
    effect yet".
- API routes, every body validated with zod:
  - `app/api/projects/[slug]/settings/route.ts`: GET returns `projectSettingsView`. PATCH takes
    `{patch:[{path,value}]}`; a null value resets to global. It answers 400 with
    `fieldErrors` keyed by project-relative path, and 404 for an unknown project.
  - `app/api/projects/[slug]/repositories/route.ts`: GET `?path=` runs the folder check; plain GET
    lists the repository rows. PUT `{repositories:[{alias,path,writable}]}` answers 400 with
    `fieldErrors["repositories.<i>.alias|path"]`.
  - `app/api/projects/[slug]/promotions/route.ts`: GET (optional `?status=`) returns the project's
    promotion records without their bodies.

Panel, edited files:
- `app/p/[slug]/brain/page.tsx`:
  - A new "Promotions" tab (`?view=promotions`) with a badge for waiting promotions. Each status
    has its own display:
    - pending review: the waiting reason;
    - pending approval: a link to `/all/knowledge`;
    - approved: a link to the global entry, plus the person's note;
    - rejected: the reason and a link to the saved project lesson.
  - Each promotion also shows the supervisor and model, its job, the reviewer and verdict, who
    decided, its sources, and its record.
  - The per-project index: when `projects/<slug>/README.md` exists, it becomes the default
    document and the "Index" group, and root files leave the tree. They can still be opened by
    path.
  - The Access requests description now names the project's effective `access_approver`, which a
    project can now override, instead of the global one.
- `scripts/seed-demo.mjs`: one separate hunk after the storefront checkout note. It promotes two
  storefront lessons as a supervisor:
  - one names the project and `src/cart.ts`, so the specificity check rejects it into a project
    lesson;
  - one is generic, and a person approves it.
  - The demo project already had promotions from its seeded job. After the seed: demo has
    "pending approval, approved", and storefront has "approved, rejected".

## Admin functions added (`src/admin/project-settings.ts`, all via `insights.*`)

```ts
interface RepositoryPathCheck { input; resolved; exists; isDirectory; isGit; problem: string | null }
inspectRepositoryPath(sy, input): RepositoryPathCheck          // relative to the config file
interface ProjectRepositoryInput { alias; path; writable }
type FieldErrors = Record<string, string[]>                    // "repositories.1.path", "team.max_agents", "form"
type SettingsSaveResult = { ok: true } | { ok: false; errors: string[]; fieldErrors: FieldErrors }
validateProjectRepositories(sy, rows): FieldErrors             // alias rule, duplicates, exists, folder, .git
saveProjectRepositories(sy, slug, rows): SettingsSaveResult    // per-alias patches (removed aliases deleted)
projectFieldErrors(sy, slug, errors): FieldErrors              // strips "projects.<slug>." and "invalid config" wrappers
saveProjectSettings(sy, slug, patch): SettingsSaveResult       // patchProjectSettings + fieldErrors
interface ProjectOverrideView { id; path; section; global; overridden; override; effective }
interface ProjectSettingsView extends ProjectSettings {
  archived; archivedAt; activity: { runningTasks; queuedTasks };
  repositoryRows: Array<{ alias; path; writable; resolved; isGit; problem }>;
  limits: { priority; max_concurrent_tasks; paid_budgets; request_share;   // null = unset
            global: { maxConcurrentTasks; paidEnabled; paidBudgets; requestsPerHour; requestsPerDay } };
  mounts: { global: Mount[]; project: Mount[] };
  overrides: ProjectOverrideView[];   // every verification key, PROJECT_TEAM/CODING/SUPERVISOR keys, each role, brain.access_approver/auto_approve
}
projectSettingsView(sy, slug): ProjectSettingsView
```

A single-project (legacy) config reports no overrides, because its sections are the global ones.
The page locks the override cards and the scheduling fields with an explanation.

## Commands run and observed results

- `npx vitest run tests/admin-project-settings.test.ts`:
  - First run: 4 passed and 1 failed (my test used the wrong task shape). I fixed the test.
  - Then: 5 passed.
  - The tests cover these behaviours:
    - an override round-trip (branch prefix, coding commands, team, verification, a role), shown
      beside the global value and live in the project context;
    - reset to global;
    - a name change;
    - field-keyed validation failures;
    - repository errors by row and field (duplicate alias, bad alias, not git, missing folder,
      empty), then add, read-only, and remove;
    - fairness fields written and read back through `projectLimits` and the view, refused when
      out of range, and cleared;
    - mounts and the access approver;
    - activity counts.
- Mutation check:
  - I disabled the prefix stripping in `projectFieldErrors` and the folder check. 3 of the 5
    tests failed.
  - I restored the file from a backup. 5 passed.
- `pnpm --filter switchyard-router build`: passes; run several times.
- `pnpm -r typecheck`: "packages/router typecheck: Done", "apps/panel typecheck: Done".
  - Earlier in the session the panel typecheck failed on a half-written j2-global file
    (`app/api/promotions/revert/route.ts`). It was fixed by them; the final run is clean.
- Full suite, `cd packages/router && npx vitest run`: "Test Files 48 passed (48)", "Tests 468
  passed (468)".
- `pnpm -r build`: "packages/router build: Done", "apps/panel build: Done". The log has 0
  warn/error lines.
- Seed:
  - `node scripts/seed-demo.mjs` exited 0 with 0 warnings, and printed `storefront: promotions to
    global/ approved, rejected`.
  - I then copied `.demo` to `scratchpad/j2p/demo`, so my settings writes never touched the shared
    demo.
- Production panel: `next start -H 127.0.0.1 -p 4599`, with `SWITCHYARD_CONFIG` pointing at that
  copy.
  - 200 for:
    - `/p/demo/settings` and `/p/storefront/settings`;
    - `/p/demo/brain` and `/p/storefront/brain`, each also with `?view=promotions`;
    - `GET /api/projects/demo/settings`, `/api/projects/storefront/promotions`,
      `/api/projects/demo/repositories`, and `?path=repo` (`isGit: true`);
    - `?path=nope` (`problem: ... does not exist`).
  - 404 for:
    - `/p/nope/settings`;
    - `/p/legacy-billing/settings` (archived);
    - `/api/projects/nope/settings`, and PATCH to it.
  - Writes:
    - PATCH priority, request_share, and paid_budgets → 200; the YAML shows the values.
    - `request_share: 1.5` → 400 `fieldErrors.request_share`.
    - `execution.*` → 400 `fieldErrors.form` ("not a project setting").
    - An empty patch → 400. A body that is not JSON → 400.
    - PUT repositories with a bad alias and a missing folder → 400 with both
      `repositories.1.alias` and `repositories.1.path`. My first build had zod short-circuit the
      alias; I moved the alias rule to the router so both errors return at once.
    - `PATCH /api/projects/demo {archived:true}` → 409 with the router's message.
- Browser interactions (`scratchpad/j2p/shots2.mjs`, DevTools protocol):
  - The blur check printed "git repository at …" for `repo` and "… does not exist" for
    `nope-folder`.
  - "Override for this project" on Sub-supervisor budget share, then 0.25, then Save: "Saved…"
    appeared and the YAML had `child_budget_share: 0.25`. "Reset to global", then Save: the key is
    gone and the row shows "global".
  - Scheduling: "1.5" for Tasks at once gave the inline "Enter a whole number". "3", then Save: the
    YAML had `max_concurrent_tasks: 3`.
  - Verification: overriding "Requests per task" to 1 put the server's message on that row ("level
    deep reserves 4 review request(s)…").
  - Archive: the confirmation, then the refusal message shown inline.
  - Console errors: none.
- Hydration:
  - The first build logged React error #418 on the settings page only. The cause: a `<details>` or
    `<pre>` (an object's global value) sat inside a `<p>`. I changed it to a `<div>`.
  - After the rebuild, `/p/{storefront,demo}/settings`, both Brain views, and the per-project index
    all logged no errors.
- The panel was stopped; port 4599 is free. The panel logs have no error or warn lines. Chrome
  exited with the script.
- New files have LF line endings (`file`, no CRLF). `git ls-files --eol` shows `w/lf` for the
  edited files. `git diff --check` is clean for my paths.

## Screenshots

All are in
`C:\Users\mrjoh\AppData\Local\Temp\claude\d--SwitchYardRouter\f513290c-d4c1-4d44-81c0-be35d4674ab1\scratchpad\j2p\shots\`.
Horizontal overflow measured 0 px on every one. The headless profile renders dark mode. I looked
at: 1440-01 to 1440-13 except 1440-11, and 600-01 to 600-06.

| File | Shows |
| --- | --- |
| `1440-01-settings-top.png`, `600-01-…` | Settings top: section nav, General (name, locked slug, archive with "2 queued" warning), Repositories |
| `1440-02-settings-team-override.png`, `600-02-…` | Team policy: an existing override, one row just switched to override ("unsaved"), the rest global with their values |
| `1440-03-settings-scheduling.png`, `600-03-…` | Scheduling and budgets with computed help |
| `1440-04-settings-save-error.png`, `600-04-…` | Repositories save error: bad alias and missing folder inline, the status "Not saved: check the highlighted rows." |
| `1440-05-settings-nav-roles.png`, `600-05-…` | Nav click on "Roles and charters": jumped, item selected |
| `1440-06/07-brain-promotions-*.png`, `600-06/07-…` | Promotions: storefront (rejected with lesson link, approved with global link); demo (pending approval, approved) |
| `1440-08-brain-project-index.png`, `600-08-…` | Brain opens on `projects/storefront/README.md` (Brain index: Storefront) |
| `1440-09-repo-blur-check.png` | Server folder check after leaving the field (warning for a missing folder) |
| `1440-10-override-saved.png` | Override saved ("2 set for this project", success message) |
| `1440-11-scheduling-saved.png` | Scheduling after a save (not viewed) |
| `1440-12-verification-server-error.png` | A server validation error on a verification override row |
| `1440-13-archive-refused.png` | Archive refused with the router's message |

## Not verified

- **Unarchive from the settings page.** It is not possible: `app/p/[slug]/layout.tsx` (not mine)
  404s an archived project, so its settings page cannot open. Unarchive stays on the projects
  grid, and the General card says so. A successful archive from the browser was not clicked: every
  live demo project has queued tasks. Archive success through the API was covered by j2-structure.
- **Editors not exercised in the browser.** These were not saved from the UI:
  - the structured role editor;
  - the auto-approve rules editor;
  - brain mounts;
  - the access approver;
  - YAML verification editors (levels, matrix, rules, and the others);
  - the name field.

  Role, mount, approver, and name writes are covered by the router tests through the same save
  function the API calls.
- **The legacy single-project config page.** Not rendered in the panel. Its locked state is
  covered only by `projectSettingsView` returning no overrides; there is no test for the legacy
  shape.
- **Light mode.** No screenshots.
- **Screen readers.** Not tested beyond ARIA attributes: `aria-invalid`, `aria-describedby`,
  `role=alert`, and `alertdialog` on the archive confirmation.
- **Config writes while a daemon worker runs.** Not exercised. The panel's process reloads
  synchronously; other processes reload by mtime.
- **Scroll-spy at an arbitrary scroll position.** Screenshot 02 shows "Verification" selected
  while Team policy is at the top. My script scrolled to 70 px, which is outside the spy's 48 px
  slack, so this is a script artifact. A nav click selects correctly (05).

## Open questions or contradictions found

1. **Archived projects.** The brief asks for archive/unarchive on the settings page, but archived
   projects 404 under `/p/<slug>`. One option is for the supervisor to let the layout render
   `settings` for an archived project, which would need a change outside my paths. The other is
   to keep unarchive on the grid, which is what the page now says.
2. **Removing a repository** is not refused while queued or running tasks name its alias. The
   router validates only the folders.
3. **Brain mount folders** are not existence-checked on save; only the schema is validated. The
   `doctor` check reports a missing one as a failure. If the supervisor wants it refused at save,
   it is a few lines in `saveProjectSettings`.
4. **The approved promotion in the seed** has a reviewer verdict of "pass" and is "decided by you".
   The review task ran within the seed before the person approved it. This is harmless, but it
   means the seed does not show a purely person-approved record.
5. **Access requests description.** The Access requests view now names the project's effective
   approver (`sy.projects.get(slug).brain.access_approver`), not the global one. This is a small
   behaviour change on the Brain page that follows from approvers being overridable per project.
