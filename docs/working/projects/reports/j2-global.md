# Report: j2-global (projects plan, phase J2)

Worker report for the brief "j2-global" in [projects.md](../../projects.md). Worktree
`D:/sy-wt/pj`, branch `feat/projects`. Nothing committed. Port 4477 was never used.

## Outcome

Done. Four pieces of work:

- `/all` is a real global dashboard.
- `/all/settings` shows only global sections when there are several projects.
- `/all/knowledge` is new, and the global nav has a "Knowledge" item.
- The router has a new admin module, `src/admin/promotions.ts`, with its tests and two API
  routes.

Results:

- Typecheck and `pnpm -r build` pass.
- My new test file passes (5 tests), and a mutation check made 2 of them fail.
- Full suite: 467 of 468 pass. The one failure was a Windows EBUSY during the cleanup of
  `tests/projects-brain.test.ts` (details under Commands). That file passed alone (7/7).
- A production panel ran on :4598 against a seeded demo.
- I requested every touched page and API route, took screenshots at 1440 and 600 wide and looked
  at them, and stopped the panel.

## What changed and why

### Router

`src/admin/promotions.ts` (new) is re-exported from `insights.ts` (one 2-line hunk). It adds
these functions:

- **`globalKnowledge(sy, { revertLimit? })`** returns
  `{ generatedAt, requiresApproval, lessons, glossary, other, reverts }`.
  - Every entry under `global/` is read through the primary brain.
  - Each entry's front matter becomes `GlobalProvenance`: project, promotion, promotedBy,
    supervisorModel, supervisorTask, sources, review (verdict, reviewer, reviewerModel,
    reviewTask, rubric, reasons), approvedBy, and promotedAt.
  - The front matter is checked with zod. If it is missing or invalid, provenance is `null`.
- **`globalReverts(sy, limit)`** reads the brain's git log for deletions under `global/`
  (`--diff-filter=D`).
  - For each one it returns the commit, date, paths, `Reverted-By`, `Revert-Reason`,
    `Reverted-Title`, `Promotion`, and `Project` trailers.
  - Files deleted by hand also appear, with the `Agent` trailer as "who" and no reason.
- **`parseGlobalProvenance(text)`**: a defensive parser for that front matter.
- **`promotionsView(sy, { project?, status? })`** returns `PromotionView = PromotionRecord & { awaitingPerson }`.
  - `status` also accepts `"awaiting_person"`. That means `pending_approval`, or `pending_review`
    with no review task running (no reviewer, or the reviews did not settle). These are the
    cases the router's `approve` and `reject` accept.
  - An unknown project gives `not_found`.
- **`decideGlobalPromotion(sy, project, id, approve, by, reason)`** wraps `sy.decidePromotion`.
  It checks, in this order:
  - the project (`not_found`);
  - the id format (`task_invalid`);
  - that the record exists (`not_found`);
  - that a rejection has a reason (`reason_required`);
  - that a person may decide it now (`usage`, which means 409). Under review or already decided
    is refused.
  - A `BrainError` that slips through becomes `usage`.
- **`revertGlobalEntry(sy, path, by, reason)`**:
  - **Allowed paths.** Only `global/**/*.md`, normalized with `normalizeBrainPath`. The glossary
    file and `..` escapes are refused. A reason is required.
  - **Locking.** It takes the brain repository's cross-process lock file
    (`.switchyard-brain.lock`), the same protocol `Brain.locked` uses.
  - **The commit.** It removes the file and commits it as `human`, as one brain commit
    (`Revert global entry <path>`). The trailers are `Reverted-By`, `Revert-Reason`,
    `Reverted-Title`, `Promotion`, and `Project`.
  - **Afterwards.** It pushes if `brain.push` is set and refreshes the FTS index.
  - **Hand-written files.** A file written outside SwitchYard that was never committed is first
    committed ("Record edits made outside SwitchYard"), so the history keeps its text.
  - **Refusals.** It refuses with `usage` when `brain.commit` is off or the mount does not commit,
    because then the revert could not be recorded.
  - **The promotion record is left unchanged.** It stays `approved`, and `global_path` still
    points at the removed file. That stops `settle()` from writing the lesson again. The test
    covers this.

`src/admin/dashboards.ts`: `DashboardProject.oldestQueuedAt`, the submission time of the
project's oldest queued task, for the queue view.

### Panel

- `app/all/page.tsx`, the dashboard, built from `globalDashboard`, `providerHealth`, and
  `promotionsView`:
  - Stat tiles: jobs, tasks, requests (24h), paid spend (24h), and workers.
  - "Needs your attention", grouped as "This install" first and then one group per project.
    Every item has a link:
    - questions go to the job, or the project's Jobs page;
    - decisions, interrupted tasks, and brain requests go to the project's pages;
    - repositories go to project settings;
    - keys go to `/all/keys`; models and policy items go to `/all/models`;
    - "N promotion(s) to global knowledge wait..." goes to `/all/knowledge#pending`.
  - Running and queued jobs of every project, each linking to `/p/<slug>/jobs/<id>`, with a
    project link next to it.
  - Queues by project: running, waiting (with a breakdown into queued, on dependencies, and for
    capacity), and the oldest wait.
  - Usage and paid spend by project, 24h and 7d. The table has a single-hue inline bar for
    requests (one series, so no legend), failed requests with their percentage, tokens, paid
    spend for 24h and 7d, a "No project (probes, scans)" row when it is non-zero, and a totals
    row.
  - Worker status, and provider health with circuit-breaker badges.
  - The bars use `--series-1` and give their value in text and a tooltip.
- `app/all/settings/page.tsx`. With several projects:
  - The Repositories card becomes a "Project settings" card. It says what lives in each
    project's settings and that the values on this page are defaults, and it links to each live
    project's settings.
  - `brain.project` and `brain.access_approver` are removed from the Brain section.
  - "Brain mounts" and "Auto-approve rules" show only when the file already has top-level values.
    Those apply to every project, so they are not hidden. They are then titled "(every project)".
  - The section nav follows these changes.
  - New Brain field `brain.global_requires_approval`, labelled "Approve global lessons yourself",
    in both modes.
  - A single-project config is unchanged except for that new field.
- `app/all/knowledge/page.tsx` and `actions.tsx` (client), sections in order:
  - **Approval mode callout.**
  - **Waiting for you (`#pending`).** Each promotion shows:
    - its project, supervisor, and model;
    - its review verdict, reviewer model, attempts, and reasons;
    - why it waits, and the lesson body;
    - its sources, linked to the owning project's Brain page;
    - Approve (optional note) and Reject. Reject is disabled until a reason is entered, and the
      API refuses it without one.
  - **Global lessons.** Each lesson shows its provenance, a History link (the Brain page's
    history tab), Revert (asks for a reason inline), and the lesson text.
  - **Glossary**, with History and Edit links.
  - **Recent decisions**, approved or rejected. A rejection shows its reason and where the lesson
    was kept.
  - **Other global entries**, if there are any.
  - **Removed entries**, from the git history: who removed each one, why, the commit, project,
    and promotion.
- API routes:
  - `app/api/promotions/route.ts`:
    - GET takes `?project=` (checked against the slug regex, so an unknown project gives 404)
      and `?status=`, and returns `{ promotions }`.
    - POST takes the zod body `{ project, id, approve, reason? }`. A rejection without a reason
      is refused by a refine, and the decision is recorded as `panel`.
  - `app/api/promotions/revert/route.ts`: POST with the zod body `{ path: global/**.md (no
    backslashes), reason (required) }`, recorded as `panel`.
  - I used body fields rather than `/api/promotions/[project]/[id]`. A static `revert` segment
    beside a dynamic `[project]` segment would shadow a project named `revert`.
- `components/client/shell.tsx`, outside my owned paths but required by the brief: two lines,
  the `Library` icon import and a "Knowledge" item before Settings in `GLOBAL_NAV`.
- `scripts/seed-demo.mjs`: four small, separate hunks, so the demo has global knowledge.
  1. The demo config sets `brain.global_requires_approval: true`.
  2. Job A's lesson step promotes a second generic lesson, "Ask before changing what callers see
     on failure".
  3. The scripted client answers promotion reviews ("Promotion review: judge the lesson") with a
     passing verdict, as data. A new function `promotionReviewTurn`, modelled on `auditTurn`,
     does this, so both lessons are reviewed through the real Gate, reviewer
     `groq/openai/gpt-oss-120b`.
  4. At the end, using `idle`:
     - settle the promotions;
     - approve "Verify integrated work..." as `you`, so a global lesson with full provenance
       exists;
     - write three glossary terms;
     - have a person add a storefront lesson, then revert it, so "Removed entries" has a row.
     - The second promotion stays waiting for approval.

  Before this change, the demo's one promotion ended `pending_review` after 3 `invalid_output`
  reviews, and `global/lessons/` was empty.

## Commands run and observed results

- `npx vitest run tests/admin-promotions.test.ts`: "Tests 5 passed (5)".
- **Mutation check.** I made two changes: `awaitingPerson` true for any `pending_review`, and the
  trailer renamed to `Removed-By`. The result was "2 failed | 3 passed": the under-review test
  and the revert test. I restored the file from a copy (`grep` shows `Reverted-By` again), and
  the full run below used the restored file.
- `pnpm --filter switchyard-router build`: Done.
- `pnpm -r typecheck`: "packages/router typecheck: Done", "apps/panel typecheck: Done".
  - An early mid-work run showed `gate.ts` `AdmissionDenialReason` missing. That came from
    j2-router's in-progress edit, and it was gone on later runs.
- **Full suite** (`npx vitest run`, log in `scratchpad/j2g/vitest.log`): "Test Files 1 failed |
  47 passed (48)", "Tests 1 failed | 467 passed (468)".
  - The failure is `tests/projects-brain.test.ts` > "runs the review as a task through the
    Gate...", with `EBUSY: resource busy or locked, rmdir ...\brain` in `env.cleanup`. That is
    a Windows file-handle race during teardown, not an assertion.
  - Re-run alone, `npx vitest run tests/projects-brain.test.ts` gave "Tests 7 passed (7)".
  - The baseline was 451. The rest are the three J2 workers' new tests (mine: 5).
- `pnpm -r build`: "packages/router build: Done", "apps/panel build: Done", with no
  error or warning lines.
- **Seed.** To avoid wiping `.demo` while j2-project might be using it, I ran an identical copy of
  `scripts/seed-demo.mjs` into my scratchpad. The only difference was the demo directory, set
  from `J2G_DEMO_DIR`. The command was `node scripts/j2g-seed.tmp.mjs`.
  - It exited 0 in 45 s with no warnings.
  - I deleted the temporary copy afterwards.
  - Brain afterwards:
    - `global/lessons/verify-integrated-work-on-the-job-branch.md`;
    - promotion "Ask before..." `pending_approval`, review pass by
      `groq/openai/gpt-oss-120b` (model `openai/gpt-oss-120b`);
    - revert commit `a1ca9e1` for the storefront lesson.
- **Production panel** on :4598 (`next start`, `SWITCHYARD_CONFIG` = the scratch demo).
  - 200: `/all`, `/all/settings`, `/all/settings?tab=yaml`, `/all/settings?tab=rulebook`,
    `/all/knowledge`, `/all/requests`, `GET /api/promotions`, `?status=awaiting_person`,
    `?status=approved`, and `?project=demo`.
  - 400: `?project=Bad_Slug` and `?status=bogus`.
  - 404: `?project=nope`.
  - POST `/api/promotions`:
    - 400 for non-JSON, a reject with no reason, a bad slug, and a bad id;
    - 404 for an unknown project, and for the right id under the wrong project;
    - 409 for an already approved promotion.
  - POST `/api/promotions/revert`:
    - 400 for the glossary, a path outside `global/`, `global/../projects/...`, a
      backslash path, and a blank reason;
    - 404 for a missing file;
    - GET answers 405.
- **UI writes in headless Chrome** (`scratchpad/j2g/clicks.mjs`):
  - **Approve.** I typed a note and clicked Approve on the pending promotion. The record became
    `approved`, `decided_by: panel`, reason "Applies to any interface.", and the lesson showed
    in Global lessons with "Approved by panel".
  - **Revert.** I opened Revert, typed a reason, and clicked "Revert entry". The lesson left
    the list, and Removed entries showed "Removed by panel: Duplicate of an existing practice."
    with its commit, project, and promotion.
  - **Brain git.** `dfb1243 human | Revert global entry ...` with the trailers `Reverted-By:
    panel`, `Revert-Reason`, `Reverted-Title`, `Promotion`, and `Project: demo`. The worktree is
    clean and no lock file is left.
- **Panel stopped.** Nothing listens on 4598, and no Chrome is left on debug port 9348. The panel
  logs contain no "error" or "warn".
- **Line endings.** Every changed or new file of mine has 0 CR (counted with node). `git diff
  --check` is clean for them.

## Screenshots

All in
`C:\Users\mrjoh\AppData\Local\Temp\claude\d--SwitchYardRouter\f513290c-d4c1-4d44-81c0-be35d4674ab1\scratchpad\j2g\shots\`.
I looked at each one. Horizontal page overflow was measured at 0 for all three pages at both
widths.

| File | Shows |
| --- | --- |
| `all-1440.png`, `all-600.png`, `all-1440-dark.png` | Dashboard. The first build's cramped queue table was fixed; these shots are from the second build. |
| `settings-1440.png`, `settings-600.png` | Settings, full page, capped at 4000 px |
| `settings-repositories-1440.png`, `settings-repositories-600.png` | The "Project settings" card with project links |
| `settings-brain-1440.png`, `settings-brain-600.png` | The Brain section, without project or access approver, with "Approve global lessons yourself" |
| `knowledge-1440.png`, `knowledge-600.png`, `knowledge-1440-dark.png` | The Knowledge page: waiting, lessons, glossary, decisions, removed |
| `revert-form-1440.png` | The inline revert form |
| `knowledge-after-1440.png` | After the UI approve and revert |

## Not verified

- **The official `.demo` was not reseeded.** I seeded an identical copy in my scratchpad instead,
  so I would not disturb other workers. The supervisor should run
  `pnpm --filter switchyard-panel seed:demo` once J2 is integrated.
- **Mount cases.** A revert of a global entry that lives under a brain mount (`global/...`
  mounted elsewhere, with or without `commit`) was not tested. In code, it uses `resolve()` and
  refuses when the mount does not commit.
- **Concurrent writes.** A revert while another process writes the brain was not tested. It uses
  the same lock file as `Brain` writes, but in-process `Brain` chains are not shared with it.
- **Approval with no reviewer.** Approving a `pending_review` promotion that has no reviewer was
  not tested in the UI. The router test covers it.
- **Rejecting in the UI.** Reject was not clicked in the browser. The API and the router test
  cover it.
- **Settings with top-level values.** No screenshot shows "(every project)" mounts or rules. The
  demo has no top-level mounts or rules, so those sections are hidden there, which is the
  intended behaviour.
- **The new setting field.** The `brain.global_requires_approval` field was rendered but not
  saved through the form.
- **Dashboard states not seen.** No running jobs, no worker, and no open breaker, because no
  worker was running. A circuit-breaker badge has never rendered.
- **Screen readers.** Not tested.

## Open questions or contradictions found

1. **A shared lock protocol.** `revertGlobalEntry` duplicates `Brain`'s lock-file protocol,
   because `src/brain/**` is j2-router's and `Brain` has no delete method. A `Brain.remove(p,
   actor, rel, message, trailers)` would be the cleaner home later. Until then, a change to the
   lock in `brain.ts` must also be made in `admin/promotions.ts`.
2. **No "reverted" status.** The promotion record stays `approved` after a revert, because
   `PromotionRecordSchema` is strict and has no `reverted` status. The revert is recorded in
   the git trailers and listed by `globalReverts`. j2-project's project Brain page lists
   promotions by record, so it will show such a lesson as approved. A `reverted` status (with
   `reverted_by` and `reverted_at`) in `promotion.ts` would make that page accurate.
3. **"Who" is `panel`.** The panel has a single token at most, so it does not know the person's
   name. Every decision and revert from the panel is recorded as `panel`, the same as task
   acceptance (`{ kind: "human", id: "panel" }`).
4. **Settings interpretation.** With several projects, `brain.access_approver` (a default a
   project can override) is no longer editable on `/all/settings`; only the raw YAML tab can
   change it. I read "mounts and access" in the brief as covering it. The other overridable
   defaults stay as "defaults every project inherits", as the new card explains: verification,
   team, coding and supervisor commands, branch prefix, and roles.
5. **Shell edit outside my paths.** The Knowledge nav item edits `components/client/shell.tsx`
   (2 lines). The brief asked for it, but the file is outside my owned paths.
