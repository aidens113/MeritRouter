# Report: v3-calibration

Worker report for "Brief: v3-calibration" in `docs/working/importance-and-verification.md`.
Worktree `D:/sy-wt/s2`, branch `feat/v3-calibration`. Nothing was committed.

## Follow-up: page-level horizontal scroll and the "Live" glyph (supervisor check)

**What was wrong.** At 800 px, `/calibration` scrolled sideways (`scrollWidth 890` against
`clientWidth 785`). My earlier check missed it because it measured a viewport about 16 px
narrower than the screenshot's. I re-measured with a CDP script that sets the exact viewport
(`Emulation.setDeviceMetricsOverride`) and lists every element extending past the viewport that
no overflowing ancestor clips.

**Cause.** The shared `HelpTip` popover is a hidden 288 px absolute span centred on its icon.
When the icon sits near the right edge, that span widens the page. On my page this happened in
two places:
- after the page description, at 800 px;
- after the card title "Passed verification vs subsequently confirmed", at 420 px, where the
  title wraps.

**Fix (`apps/panel/app/calibration/page.tsx` only).**
- Removed the HelpTip from the page description. The card still carries `calibration` help, and
  a comment in the page explains why.
- Shortened the card title to "Verified vs confirmed".
- Earlier I had already removed the tip on the right-most stat tile.

**Result.** `scrollWidth === clientWidth` on `/calibration` and on the reused-verdict task page
(`/tasks/t_0mvfwoo7c7d1478fa7035`) at all four widths:

| Width | Calibration | Task page |
| --- | --- | --- |
| 1400 | 1385/1385 | 1385/1385 |
| 1024 | 1009/1009 | 1009/1009 |
| 800 | 785/785 | 785/785 |
| 420 | 405/405 | 405/405 |

`?days=7` and `?days=90` at 800 px: 785/785. Table wrappers still scroll inside themselves, as on
other pages.

**Screenshots.** In the scratchpad, viewed:
- `v3-fix-calibration-{1400,1024,800,420}.png` and `v3-fix-task-{1400,1024,800,420}.png`, taken
  over CDP;
- `v3-fix-screenshotmode-{1400,800}.png` and `v3-fix-screenshotmode-task-800.png`, taken with
  `chrome --screenshot`.

None of them shows a page scrollbar at the bottom.

**The box glyph next to "Live" is not a missing character, and I left it.** It is the lucide
`Pause` icon, 12 px at opacity 50, which the shared `AutoRefresh` component
(`components/client/actions.tsx`) renders. The same glyph appears next to "Live" on `/requests`.

**Commands.**
- `pnpm -r typecheck`: router Done, panel Done.
- `pnpm --filter switchyard-panel build`: compiled successfully, `/calibration` listed.
- `next start -p 4541`: `/calibration`, `?days=7`, and the task page returned 200. The server was
  stopped; port 4541 now returns 000.

## Outcome

Done. All of the following are implemented, tested, and visible in the panel:
- verdict calibration records;
- confirmation signals: accepted or rejected, integrated, job checks, and undone through
  attribution;
- false approvals and false rejections;
- cached verdicts;
- background audit sampling;
- usage by purpose;
- a Calibration page with seeded demo data;
- the `criterion_evidence` display fix.

The phase acceptance holds:
- the panel shows verified against confirmed, per reviewer;
- a seeded undo counts as a false approval, in a test and in the demo.

All the validation the brief names was run and passes. The edits outside the brief's ownership
are small seams, listed below with the reason for each.

## What changed and why

### Storage: `src/storage/migrations.ts` (one new migration appended)

- **`verdict_records`.** One row per reviewer verdict. A row records:
  - the task and the purpose (`verification` or `audit`);
  - the attempt, the reviewer endpoint, the level, the qualification, and whether the reviewer
    was qualified;
  - the verdict and the revision it examined;
  - the requests spent;
  - the cache key, `cached_from` (for a reused verdict), and `audit_task_id`;
  - the full `ReviewRecord` as JSON. It is validated with zod when read back.
- **`verification_signals`.** Signals of kind `integrated`, `job_check`, and `undone`.
- **`verification_audits`.** One sampling decision per result, plus the audit task it started.
- **Derived, not stored.** Acceptance and rejection are read from the existing
  `result_accepted` / `result_rejected` events. Job checks also count the job's own final checks
  when the job finished after the integration.

### `src/verification/calibration.ts` (new)

**Records.**
- `recordVerdict` and `verdictRecords`.
- `recordSignal`, `recordIntegration` (also writes an `integrated` task event), and
  `recordJobCheck`.
- `calibrationUndoHook`: the attribution undo hook. Every task whose commits were undone gets an
  `undone` signal and a task event.

**Confirmation.** `taskConfirmation` gives a task one of these statuses:
- `escaped_defect`: undone, or the latest job checks after integration failed;
- `rejected`: the latest decision was a rejection;
- `confirmed`: accepted, or integrated;
- otherwise `unconfirmed`.

`resultRevision` works out the final revision the same way reviews bind it: the last review's
revision, else the check revision, else a patch digest (coding), else `answerDigest`.

**Judging a verdict.** `verdictOutcome` returns one of:
- `correct`, `false_approval`, or `false_rejection`, for a pass or fail on the final revision;
- `pending`, while nothing has confirmed or contradicted it yet;
- `led_to_repair`, for a fail on an earlier revision;
- `superseded`, for a pass on an earlier revision;
- `no_verdict`, for an inconclusive verdict or a review with no verdict.

A pass is a false approval if the result was later undone, failed job checks, or was rejected.
A fail is a false rejection if the result was accepted with nothing contradicting it since.

**Cache key.** The key is built from:
- `judgedContractDigest`: the goal, profile, criteria, scope, declared checks, and output-schema
  flag;
- the artifact digest: for coding, `evidence.artifactDigest`, else `evidence.revision`; otherwise
  `answerDigest`;
- the contract's policy fingerprint;
- the source revisions: the contract's base commits merged with the result's.

**Cache lookup (`cachedVerdict`).** It reuses only a decisive original verdict (never itself a
reused one) for which all of these hold:
- its level is the requested level or higher;
- when the qualification is required, it was qualified with the same qualification;
- its reviewer is not an author of the task under review;
- calibration has not contradicted it.

**Review phase (`calibratedReview`).** This wraps `reviewResult`:
- on a cache hit it builds the verdict from the stored record:
  - the verdict is flagged `cached_verdict`;
  - it records 0 requests and no session;
  - it writes a `review_cached` event;
- either way, it records the verdict whenever a reviewer was engaged.

### `src/verification/audit.ts` (new; see the open questions)

- **`Auditor.sweep()`** runs on the scheduler tick. It grades finished audits first; when
  `audit_sample_rate > 0` it then considers results that finished in the last 24 hours. Each
  result is considered once (the row is claimed with `INSERT OR IGNORE`).
- **Eligibility:** only completed `work` tasks whose verification status is `passed`; supervisor
  jobs are excluded.
- **Sampling** is deterministic: a sha256 hash of the task id, compared with the rate.
- **`auditCapacityShortfall`** skips an audit when either of these holds:
  - the hourly or daily package allocation has less than
    `max(audit_max_requests, allocation × audit_min_free_fraction)` left;
  - any task is `waiting_for_capacity`.
- **The audit runs as its own task**, with purpose `audit` and the `review` profile. Its evidence
  package is rendered from the stored final result. It is pinned to one reviewer, chosen this
  way:
  - free models only, and never an author of the audited task;
  - the task's earlier reviewers are avoided first; if nothing else is left, only authors are
    excluded.

  The audit task has its own budget (`audit_max_requests`, `maxPaidUsd: 0`), importance low, and
  T1. Its requests are therefore charged to the audit task, never to the audited task's contract.
- **`gradeFinished`** validates the audit task's `data` with `validateVerdict` against the
  audited task's contract, revision, and policy. It then:
  - writes an `audit` verdict record;
  - writes an `audit_completed` event on the audited task, with `disagrees` set;
  - never touches that task's acceptance.
- **`consider(id, { force })`** is public. The demo seed uses it.

### Other owned files

- **`src/verification/checks.ts`.** `CheckSubject.review` (the review's per-criterion outcomes) is
  new. The `criterion_evidence` row now counts a criterion the review passed as `passed`, using
  the same rule as `decide.applyReview`, and its detail says "(review)". The criteria list itself
  is unchanged, and so are the decisions.
- **`src/attribution/index.ts` (undo hook only).**
  - New types: `UndoneCommit`, `UndoneChange`, and `UndoHook`.
  - `revertCommits(..., opts.onUndone)` and `undoLines(..., opts.onUndone)` report the undone
    commits with their Task, Job, Agent, and Model trailers.
  - A hook that throws is ignored.
- **`src/admin/calibration.ts` (new).**
  - `calibrationOverview(sy, { sinceMs })` returns:
    - totals;
    - per reviewer: reviews, audits, reused verdicts, pass/fail/inconclusive/no verdict,
      qualified, confirmed correct, false approvals, false rejections, pending, led to repair,
      requests, accepted tasks, requests per accepted task, and a per-level breakdown;
    - passed vs confirmed, escaped, rejected, and unconfirmed, overall and per level;
    - contradicted verdicts and recent verdicts;
    - audits.
  - `usageByPurpose(sy, sinceMs)` counts each request once per purpose. The purpose comes from
    the request (`purposeCategory`), except that tasks whose purpose is audit or qualification
    are grouped under that task purpose.
- **`src/admin/insights.ts`.** Diagnosis: it is a facade over every panel concern (overview,
  models, requests, tasks, config, paid, qualification, jobs, sessions, brain). Calibration
  therefore went into its own file. `insights.ts` grew by only 2 lines, `export * from
  "./calibration.js"`, and is now 826 lines.
- **`src/index.ts`.** Exports the calibration and audit API.
- **`src/config/schema.ts` (verification section).** Four keys:
  - `audit_max_requests` (default 4);
  - `audit_min_free_fraction` (default 0.25);
  - `cache_verdicts` (default true);
  - `audit_sample_rate` keeps its default of 0; only its doc comment changed.

### Panel

- **`apps/panel/app/calibration/page.tsx` (new).** It shows:
  - a window filter (7, 30, or 90 days);
  - stat tiles;
  - a table of passed verification vs subsequently confirmed, per level, with a stacked bar;
  - a reviewers table;
  - contradicted verdicts and recent verdicts;
  - audits;
  - model requests by purpose.
- **`components/client/shell.tsx`.** A "Calibration" nav entry.
- **`lib/glossary.ts`.** New entries: `calibration`, `falseApproval`, and `audit`.
- **`scripts/seed-demo.mjs`.** New scripted cases:
  - **False approval:** job C delegates a high-importance `divide()`. It is reviewed and passes,
    is integrated, and passes `run_check`. The supervisor then undoes the task through
    attribution.
  - **False rejection:** a "rounding" analysis the reviewer fails twice (the first fail led to a
    repair) is accepted by a human.
  - **Confirmed:** a human accepts the repaired analysis, which confirms its passing review.
  - **Reused verdict:** the same deep analysis is submitted twice; the second run reuses the
    first verdict.
  - **Audits:** two forced audits, one agreeing (on the multiply task) and one disagreeing.
  - The demo config is rewritten with `audit_sample_rate: 0.2` after seeding.

### Edits outside the brief's ownership (minimal seams)

| File | Change | Why |
| --- | --- | --- |
| `src/verification/phase.ts` | `reviewResult` is replaced by `calibratedReview(..., d.now)`. Tasks with purpose `audit` skip review, as qualification tasks do. | This is the only place a review starts, so both the cache and verdict recording need it. Reviewing an audit would never end. |
| `src/core/acceptance.ts` | One line: `review: opts.review?.criteria ?? null` passed to `runNamedChecks`. | The criterion_evidence fix. |
| `src/harness/supervisor-tools.ts` | `integrate_task` calls `recordIntegration`; `run_check` calls `recordJobCheck`; the `undo` tool passes `onUndone: calibrationUndoHook(...)`. | The integration, job check, and undo signals. The parallel t1-graph worker also edits this file; my changes are about 6 lines. |
| `src/core/service.ts` | `readonly auditor: Auditor`, constructed after `qualifier`; the scheduler `onTick` also calls `auditor.sweep()`. | Background audits need a tick, like `qualifier.gradePending`. |
| `tests/verification-review.test.ts` | The "tight" task in the raised-level budget test gets its own goal. | Otherwise it legitimately reused the "roomy" task's cached verdict: same contract, revision `tree-1`, and base. |
| `src/verification/audit.ts` (new file) | Audit sampling, kept apart from `calibration.ts`. | It is a separate concern. |

## Commands run and observed results

- `npx tsc --noEmit -p tsconfig.json` (packages/router): clean after each step.
- `npx vitest run tests` (packages/router), first full run after the library changes:
  `1 failed | 241 passed`. The failure was the cache hit in `verification-review.test.ts`
  described above. Fixed, then re-run alone: passed.
- `npx vitest run tests/verification-calibration.test.ts`:
  - first run: 3 failures, all bugs in my tests: an `inline` ref outside the evidence universe,
    and the wrong assumption about which endpoint authored the task;
  - after the fixes: `8 passed`.
- Final validation:

  | Command | Result |
  | --- | --- |
  | `pnpm --filter switchyard-router build` | exit 0 |
  | `pnpm -r typecheck` | `packages/router typecheck: Done`, `apps/panel typecheck: Done` |
  | `cd packages/router && npx vitest run tests` | `Test Files 26 passed (26)`, `Tests 250 passed (250)` |
  | `pnpm --filter switchyard-panel build` | `Compiled successfully`; `/calibration` listed |

- `node scripts/seed-demo.mjs`: every phase completed with no warnings:
  - `job: add divide (integrated, then undone)  completed/not_verified`;
  - `deep review overruled by a person  completed/needs_supervisor` (then accepted);
  - `same analysis again (verdict reused)  completed/met`;
  - both audits `sampled`.
- Overview of the seeded database: 12 verdicts in total.

  | Measure | Seeded result |
  | --- | --- |
  | Reused verdicts | 1 |
  | Audits | 2 |
  | False approvals | 1 (divide: "undone through attribution: divide(a, 0) returns Infinity…") |
  | False rejections | 1 (rounding: "accepted by human:cli:demo") |
  | Confirmed correct | 2 |
  | Inconclusive rate | 1/12 |
  | Passed verification (all) | 20 passed, 2 confirmed, 1 escaped, 17 unconfirmed |
  | Usage by purpose | classification 8, execution 53, verification 9, repair 6, audit 2 |

- `next start -p 4541` against `.demo`. Every page requested returned 200:
  - `/calibration`, `?days=7`, and `?days=90`;
  - `/` and `/tasks`;
  - `/tasks/<reused-verdict task>`, `/tasks/<divide task>`, `/tasks/<rounding task>`, and
    `/tasks/<audit task>`.

  The reused-verdict task page contains "cached verdict" and "line: passed (review)"; the divide
  task page shows its `integrated` and `undone` events.
- Screenshots: a layout check over the Chrome DevTools protocol found a page-wide horizontal
  overflow, caused by a HelpTip popover on the right-most stat tile. I removed that tip and
  re-checked: `scrollWidth 1369 = clientWidth 1369`. The screenshots are in the scratchpad, and
  I looked at all of them:
  - `v3-calibration.png` (1400×1000), from before that fix;
  - `v3-calibration-tall.png`;
  - `v3-calibration-narrow.png` (800 wide);
  - `v3-task-cached.png`.
- Stopped the server. Port 4541 then returned `000` (connection refused).

## Not verified

- No live model, FreeLLMAPI, or paid provider was used; reviewers and auditors were scripted.
- No test covers an audit whose task fails or returns an invalid verdict; that path records a
  verdict-less audit row.
- The audit `waiting_for_capacity` skip and the daily-window branch are untested; only the hourly
  allocation skip is tested.
- Light theme not screenshotted. The 1400×1000 screenshot predates the HelpTip removal (the
  narrow and DevTools checks are after it).
- Docs under `docs/` (roles, operations, decisions) and the working document were not updated: I
  do not own them.

## Open questions or contradictions found

1. **The cache key uses a digest of what the verdict judged, not the stored contract's sha256.**
   The stored sha covers the task id, the timestamp, and the budget, so it would never match
   across tasks. `judgedContractDigest` covers the goal, profile, criteria, scope, checks, and
   output schema; the base commits go into the key as source revisions, and the level is
   compared separately. Within one task the two are equivalent. Please confirm.
2. **"Charged to purpose audit".** An audit is its own task (purpose `audit`). Its requests are
   labelled by the review runner, and `usageByPurpose` groups them as audit by task purpose. I
   did not add `audit` to `REQUEST_PURPOSES` or to admission. If a request-level purpose is
   wanted, that is an admission and runner change.
3. **A pass the supervisor later rejected counts as a false approval.** The Design lists only
   "undone or failing later job checks"; I treat a rejection the same way, by symmetry with the
   false rejection.
4. **A failing job check after integration counts as an escaped defect for every task integrated
   before it,** as the Design describes. It is noisy when several tasks share a branch.
5. **An audit verdict never counts against the original reviewer.** An audit `fail` on an
   accepted result is recorded (`disagrees: true`, and in the audit's own reviewer row), but it
   is not treated as ground truth.
6. **The cache is on by default.** Within a task it also reuses a fail when a repair produces an
   identical artifact. `cache_verdicts: false` turns it off.
7. **New file `src/verification/audit.ts`,** and the seams in `phase.ts`, `acceptance.ts`,
   `supervisor-tools.ts`, and `service.ts` (table above). Expect a possible conflict with the
   t1-graph branch in `supervisor-tools.ts`, and in `migrations.ts`, where both branches append.
   Migration order matters: whichever merges second must keep both entries appended.

```text
Outcome: Done
Changed: packages/router/src/storage/migrations.ts, src/config/schema.ts, src/attribution/index.ts, src/verification/{calibration.ts (new), audit.ts (new), checks.ts, phase.ts}, src/core/{acceptance.ts, service.ts}, src/harness/supervisor-tools.ts, src/admin/{calibration.ts (new), insights.ts}, src/index.ts, tests/verification-calibration.test.ts (new), tests/verification-review.test.ts; apps/panel/app/calibration/page.tsx (new), components/client/shell.tsx, lib/glossary.ts, scripts/seed-demo.mjs
Validation: router build exit 0; `pnpm -r typecheck` -> Done x2; `npx vitest run tests` -> 26 files, 250 passed; panel build ok; demo seeded (no warnings); :4541 pages 200; screenshots viewed; server stopped
Not verified: live models; failed or invalid audit-task path; waiting_for_capacity and daily-window audit skips; light theme; docs/ not updated (not owned)
Report: D:\sy-wt\s2\docs\working\importance-and-verification\reports\v3-calibration.md
Notes: seams outside ownership in phase.ts, acceptance.ts, supervisor-tools.ts, service.ts, and one test goal tweak (see report table)
```
