# Report: v-finish

Worker report for the brief "executor split + panel reviews". Work was done in worktree
`D:/sy-wt/v1`, branch `feat/v1-verification`. Nothing was committed.

## Outcome

Done.

1. `src/core/executor.ts` went from 891 to 770 lines. The verification orchestration moved to the new file `src/verification/phase.ts`. This was a pure move plus a narrow seam, and all 242 tests pass unchanged.
2. The panel task page's "Contract and verification" card now renders three things:
   - independent reviews, retries, targeted checks, and levels raised on the result, in time order;
   - repair and retry runs linked to their sessions;
   - model requests by purpose against the contract's allocation.
3. The demo seed produces two review cases from the scripted client:
   - a qualified deep review that fails, is repaired, and then passes;
   - a `reviewer_unqualified` review.

## What changed and why

### Task 1: executor split

**Diagnosis.** The executor held the whole verification phase:
- verify plus the `verification_raised` event and its reserve adjustment;
- `verifyWithReview`, with its review, targeted-check, and re-review loop;
- the reviewer run context and the per-purpose request accounting;
- the retry decision (quality repair or escalation, with its `escalated`, `retry_started`, and `quality_repair` events);
- the retry-state restore and the tier pin after an interruption.

All of that belongs to verification, not to the executor.

**New `packages/router/src/verification/phase.ts` (247 lines).** It exports:
- `PhaseDeps` (a structural subset of `ExecutorDeps`, so the executor passes `this.d`).
- `continueRun`: `restoreRunState` plus the `tier_kept` pin. Supervisors, forced endpoints, and qualification tasks are exempt. The interrupted tier is passed as a thunk, so it is still evaluated only when no retry was started.
- `requestsUsed`.
- `repairPossible`.
- `verifyRecorded`: the former private `verify`, unchanged.
- `verifyWithReview` and its `ReviewRun` seam. The seam carries `tier`, `signal`, `session`, `jobId`, `repairPossible`, a `reviewerContext` callback, and an `onReviewer` watchdog hook. The hook is called only if a reviewer context was built, which matches the old `if (watch?.reviewer)` reset.
- `planRetry`: the former inline retry block. Event order, the `st.qualityRetriesUsed++`, and the forced-endpoint exit are all the same. The executor still ends the session, updates the tier, and `continue`s.

**Ordering, kept as before:**
- The `verifyWithReview` call stays inside the executor's try/catch.
- `planRetry` stays outside it, as before, so an error there still escapes to the outer `finally`.

**One ordering change.** `restoreRunState` now runs after `resumeFor` instead of before it. `resumeFor` writes only `session_resumed`, which the restore ignores, so behaviour is the same.

**Executor's remaining verification surface:**
- `contractFor`;
- a small `reviewRun()` builder (the reviewer's `RunContext` and the watchdog hook);
- the calls into the phase.

**`src/core/acceptance.ts`:** the new `contractShortfall(spec, message)` holds the `verification_budget_insufficient` failure result that `contractFor` built inline.

### Task 2: panel

**New `src/verification/trail.ts` (129 lines).** `verificationTrail(deps, taskId, verification)` rebuilds what verification did, for display:
- **Reviews.** Taken from the result's `verification.reviews`, or from the events while the task is still running. Each one gets the `review_recorded` timestamp, the reviewer's display name, and its model family.
- **Retries.** Built from `retry_started` (validated with `RetryStartedSchema`) merged with `quality_repair`. The run that carried a retry out is the author session whose `previousSessionId` is the session that ended `"...; repair at"` or `"...; escalated to"`.
- **Targeted checks.**
- **`verification_raised`**, with `reserveAdjustment.review`.
- **`requestsByPurpose`**, from `admission.taskTotalsByPurpose`.

Every event is validated with zod, and invalid ones are skipped.

I put this in `verification/` rather than `insights.ts` for two reasons: `insights.ts` was already 819 lines before the change, and `admin/` beyond `insights.ts` is outside my brief. `insights.ts` only adds `TaskDetail.trail` and re-exports the view types: `ReviewView`, `RetryView`, `TargetedCheckView`, `RaisedLevelView`, and `TaskVerificationTrail`.

**Panel files:**

| File | Change |
| --- | --- |
| `apps/panel/components/verification-trail.tsx` (new) | `RequestsByPurpose` table (classification, execution, verification as review, and repair, each used vs allocated). `VerificationTrail` shows the steps above in time order. Each review shows the reviewer model (linked) and its family; a qualified or "unqualified for review" badge; other flags (for example "same model family"); the verdict and recommended action; requests; the examined revision; the score; and a link to the reviewer session. It also shows a per-criterion table (outcome, evidence refs, reason), blocking findings, missing evidence, and an artifact viewer for the verdict, evidence package, and transcript. Retry rows link "Repair run session" or "Retry run session". |
| `apps/panel/app/tasks/[id]/page.tsx` | Requests-by-purpose sits under the contract column. The trail is a full-width section at the bottom of the card. |
| `apps/panel/lib/glossary.ts` | New `review` entry. |

**`apps/panel/scripts/seed-demo.mjs`:**
- The scripted client now answers reviewer requests (`submit_verdict`) from the evidence package (examinedRevision, policyVersion, criterion ids, a given ref).
- The existing high-importance "negative numbers" task gets an unqualified reviewer and an `inconclusive` verdict with missing evidence. It goes to `needs_supervisor` and is accepted by "cli:demo" as before.
- Before a new phase at 11.5h, the seed inserts deterministic review-family qualification rows (T3) for three endpoints.
- The new phase is an analyze task with high importance, label `missing-b`. Its sequence:
  1. A qualified reviewer fails the first answer with a blocking finding and recommends repair.
  2. The repair runs at T3, escalated from T2.
  3. The scripted author submits a "Corrected:" answer.
  4. Review 2 passes, with the flag `same_model_family`, which comes from the product.
  5. The task ends `met`.
- Other deep tasks now get `pass` verdicts, so the classifier analysis and the review-profile task end `met` instead of `needs_supervisor` (before, their reviewers called an unknown tool and ran out of budget).

## Commands run and observed results

| Command | Result |
| --- | --- |
| `pnpm --filter switchyard-router build` | passes, no errors (run after task 1 and again at the end) |
| `pnpm -r typecheck` | router: Done; panel: Done |
| `cd packages/router && npx vitest run tests`, after task 1 | 25 files, 242 tests, all pass. No timeouts. |
| `cd packages/router && npx vitest run tests`, after all changes | 25 files, 242 tests, all pass. No timeouts. |
| `pnpm --filter switchyard-panel build` | Compiled successfully; `/tasks/[id]` listed. I rebuilt it after a final label tweak. |
| `node scripts/seed-demo.mjs` | All phases completed. "deep review: fails, repaired, passes" ended `completed/met`. The high-importance analysis ended `completed/needs_supervisor`, then a person accepted it. |
| Event dump of the seeded database | Repaired task `t_0mvfvld87d3d20c121975`: review 1 (qwen 235B, qualified, fail, repair), then `escalated` T2 to T3, `retry_started`, `quality_repair`, and review 2 (qualified, `same_model_family`, pass). Unqualified task `t_0mvfvlbcvcc82b6f3d513`: review 1 with `reviewer_unqualified`, inconclusive, needs_supervisor. |
| `next start` on port 4531, curl four task pages, a queued task, and two session pages | All returned 200. The repair task's HTML contains the trail, blocking findings, "Repair at T3 (escalated from T2)", and the session link. |

Screenshots are in `C:\Users\mrjoh\AppData\Local\Temp\claude\d--SwitchYardRouter\64f4a817-8bc0-4dfd-868f-f8f14b2e19e2\scratchpad\`:
- `vf-repaired-top.png` (1400x1600);
- `vf-repaired-full.png`, with crops `vf-repaired-card-a.png` and `vf-repaired-card-b.png`;
- `vf-unqualified-full.png`, with crop `vf-unqualified-reviews.png`.

I looked at all of them. They show the reviews in order with the reviewer, qualification badge, verdict, per-criterion table, blocking findings or missing evidence, the repair row with its session link, and the requests-by-purpose table (classification 1/1, execution 2/8, verification 2/4, repair 2/10).

The server was then stopped. The background task was stopped, and the leftover `next start` (PID 13056) was killed. Port 4531 has no listener.

## Not verified

- The final screenshots predate a one-word label change: escalation rows now say "Retry run session" instead of "Repair run session". The panel was rebuilt and typechecked after the change, but no new screenshot was taken.
- No dedicated unit test covers `verification/trail.ts` or the new phase functions. They are covered only through the existing executor and verification tests, and through the demo.
- Dark mode only; light theme not screenshotted.

## Open questions or contradictions found

- `insights.ts` is still past 800 lines (824, including my 5 lines; it was 819 before). It needs its own diagnosis.
- The verification record's `criterion_evidence` check reads "unverified (claimed)" even when a passing review verified the criterion. The criterion row says "passed". This is existing V2 behaviour, but the panel shows both side by side, which may confuse readers.
- The demo's re-review is flagged `same_model_family`. This is because the T3 repair was served by Qwen3 Coder and the reviewer is Qwen3 235B. It is real product output, and I left it as is.

```text
Outcome: Done
Changed: packages/router/src/core/executor.ts, packages/router/src/core/acceptance.ts, packages/router/src/verification/phase.ts (new), packages/router/src/verification/trail.ts (new), packages/router/src/admin/insights.ts, apps/panel/app/tasks/[id]/page.tsx, apps/panel/components/verification-trail.tsx (new), apps/panel/lib/glossary.ts, apps/panel/scripts/seed-demo.mjs
Validation: `cd packages/router && npx vitest run tests` -> 25 files, 242 passed (twice); `pnpm -r typecheck` -> Done x2; router and panel builds pass; demo seeded; :4531 task/session pages 200; screenshots viewed
Not verified: screenshot after the final "Retry run session" label tweak; no new unit tests for trail.ts/phase.ts; light theme
Report: D:\sy-wt\v1\docs\working\importance-and-verification\reports\v-finish.md
Notes: executor 891 -> 770 lines; insights.ts still 824 lines (was 819) and needs its own diagnosis
```
