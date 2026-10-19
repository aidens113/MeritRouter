# Report: v-merge

This is the worker report for "Brief: v-merge (integrate dev into feat/v1-verification)" in
`docs/working/importance-and-verification.md`. I worked in the worktree `D:/sy-wt/v1`, on branch
`feat/v1-verification`, with `git merge dev` in progress. Nothing was committed. The resolved
and new files are staged, so the supervisor commits the merge.

## Outcome

Done. All seven conflicted files are resolved, and both sides' behaviour is kept. Resume and
verification now work together:

- A task interrupted during review resumes the author's session.
- An already-accepted submission finishes without a model request, and verification runs again
  on the submitted revision.
- An interrupted reviewer is ended as superseded, and a new reviewer session that links to it
  runs.
- Review requests already spent stay charged against the allocation.
- A repair already started is continued, never repeated.
- The watchdog follows the reviewer session.

Validation results:

| Check | Result |
| --- | --- |
| Router build | passes |
| `pnpm -r typecheck` (router and panel) | passes |
| Full router suite | 25 files, 242 tests, all pass |
| Panel build | passes |
| Conflict markers left | none |

## What changed and why

### Conflicted files

| File | How it was resolved |
| --- | --- |
| `src/runners/types.ts` | Kept both sides. From V1: the acceptance-decision types and `RunContext.contract`, `retry`, and `purpose`. From S2: the `ResumePlan` and `faultPoint` imports and `RunContext.resume`. One more change: `ask()` fault points now use the effective purpose (`ctx.purpose ?? req.purpose`), so a fault can target `repair` and `verification` requests. |
| `src/routing/select.ts` | Kept V2's reviewer-independence rank, ahead of R1b's circuit/cooling rank (open circuit 2, cooling 1, healthy 0). Order: paid rank, then independence, then circuit/cooling, then size. |
| `src/runners/coding/finish.ts` | Merged the imports: `createHash`, `existsSync`, `SessionWorkspace`, and the evidence types. The body merged cleanly: `resumeWorkspace` from S2, and revision-bound checks and `startCommit` from V1/V2. |
| `src/runners/coding/index.ts` | Kept both import sets and S2's `resumeBrief`. |
| `src/cli.ts` | Kept both sides. Details below the table. |
| `tests/mcp.test.ts` | The tool list has both `reject_result` (V1) and `resume_session` (S2). |
| `src/core/executor.ts` | Kept both sides. `context()` takes the verification options and then `resume`. The run loop resumes or opens a session, passes `{ contract, retry, repairCap }` and the resume plan, then verifies, reviews, and repairs as before. The integration changes are listed in the next section. |

The `src/cli.ts` resolution in detail:
- **Imports:** a single `import { homedir, userInfo } from "node:os"`; `cliActor` now uses `userInfo()`.
- **Help text:** S2's resume text (session or task id), followed by V1's accept and reject lines.
- **Functions and flags:** V1's `cliActor` and `withImportance` (I restored the closing brace the merge dropped), and R1's `operationsCommand`. The parse options include both flag sets.
- **Command cases:** S2's `resume` case (session id or task id), with its block closed, then V1's `accept`/`reject` case.

### Making resume and verification compose

**New file `src/core/retry-state.ts`.** This is the task's verification and retry state across runs.
- It holds `VerificationState`, which moved here from the executor and gained an `attempts` field.
- It defines the task events `retry_started` (from tier, to tier, reason, and the full `RetryContext`, validated with zod) and `review_recorded` (the `ReviewRecord`).
- `restoreRunState` rebuilds four things from the task events, ignoring any event that fails validation:
  - the retries used;
  - the retry in progress;
  - the reviews;
  - the review attempt count (the highest `review_started` or `review_not_run`) and `targetedRan`.

**Executor changes:**
1. **Restores state.** `runSingle` restores that state before the loop. When a retry has already started, the run continues as that repair run: it gets the repair cap, purpose `repair`, the stored retry context (including `startFrom`), the retry's tier, and `escalatedFrom`. A crash during the re-review therefore never repairs a second time. `retry_started` is written before the retry runs.
2. **Resumes the author, never a reviewer.** The new `authorSessions(store, taskId)` returns the task's own runs. It excludes classifier sessions and reviewer sessions, which are children of the task's own sessions. `resumeFor` and `openSession` use it. If a directive or `resumeSession` names a reviewer session, `resumeFor` maps it to the author session it reviewed.
3. **Treats a simulated crash as process death during verification.** A `SimulatedCrash` thrown during verification sets `crashed` in both `runSingle` and `runBatch`. In `reviewResult` it is rethrown before the reviewer session is ended. Before this change, it was swallowed as "the review could not run".
4. **Watchdog follows the reviewer.** The watched entry now records the active reviewer session and when the current phase began. `checkWatchdog` checks the reviewer while a review runs, with no check allowance. Idle time counts from the later of the session's last event and the last phase switch. `watchdog_abort` records `role: "reviewer"`. `requeueStuck` still names the author's session.
5. **Keeps the tier after an interruption.** I had to add this (see Open question 1). The router re-classifies every run, and `retryAfterFailure` counts any earlier run as a failure, so a resumed run could move up a tier. V2 re-evaluates the policy at the tier the run actually ran at, so such a run would suddenly need a deep review. Now:
   - a run after an interruption keeps the tier of the session it continues (resumed, or the latest author session that ended `interrupted`);
   - a run inside a started retry keeps the retry's tier.

   A `tier_kept` event records the change. Supervisors, forced endpoints, and qualification tasks are exempt.
6. **Batch members** get their restored state as well.

**`src/verification/review.ts`:**
- The new `supersedeInterruptedReviews` reopens each interrupted reviewer child session and ends it as `cancelled` with stop reason `superseded: review N runs again`. It writes `review_superseded` and returns the latest such session, which becomes the new reviewer's `previousSessionId`.
- Spent review requests stay charged: `reviewCap` reads purpose totals from the ledger, so a restart cannot reset them.

### Tests

- **New `tests/verification-resume.test.ts`** (4 tests; real worktrees, native runner, fault hook):
  1. **Crash after the reviewer's first response** (`after_model_response:1:verification`):
     - The implementer session resumes: its end reasons are `process_died` then `worker_submitted`.
     - There are 2 author requests in total and one worktree (`worktree_reused`).
     - The dead reviewer ends `interrupted`/`process_died`, then `cancelled`/`superseded: review 2 runs again`. The new reviewer is a child of the implementer and links back to the dead one.
     - The result has one review (attempt 2, pass).
     - Verification requests total 2 and stay within the review budget. There is no repair.
  2. **Crash during the re-review after a repair:**
     - There is one `quality_repair`, one `retry_started`, and 2 worktrees.
     - There are 4 author requests (2 of them repair), none after the restart.
     - The repair session resumes. The reviews are `[1 fail, 3 pass]`, and the reviewer sessions are completed, cancelled, completed.
     - Repair requests total 2, verification requests total 3, and everything stays within the allocation. The tier stays T3.
  3. **A re-review that still fails after the restart:** the result is `needs_supervisor` with one repair only. I mutation-checked this test: with retry restoration disabled, it fails because a second repair runs.
  4. **Watchdog:** a reviewer whose request hangs is aborted after 11 minutes on the fake clock. `watchdog_abort` names the reviewer session with `role: reviewer`. The author's session is the one re-queued and resumed (ends `interrupted`/`watchdog`, then `completed`). A new linked reviewer passes.
- **`tests/session-faults.test.ts`** (from dev): its three unhinted coding tasks are now hinted `difficulty: "T2"`, with a comment explaining why. On this branch an unhinted task classifies to T3 (the classifier fails over to round-up). T3 is deep and needs an independent reviewer, which these single-endpoint tests do not have, so `met` became `needs_supervisor`. With the hint, `met` still proves that checks passed on the resumed revision.

## Commands run and observed results

- `npx tsc --noEmit -p .` (packages/router), run several times:
  - first run: `src/cli.ts(744,1): error TS1005: '}' expected` (the dropped brace, now fixed);
  - every run after that: exit 0.
- First full `npx vitest run tests`: 4 failed and 234 passed. All 4 failures were in `session-faults.test.ts`, coding tasks expecting `met` and getting `needs_supervisor`. Debug output showed the result level was deep at T3 with "no eligible reviewer". This led to the T2 hints and to the tier-keeping rule.
- `npx vitest run tests/session-faults.test.ts`: 10 of 10 pass.
- `npx vitest run tests/verification-resume.test.ts`:
  - the watchdog case first timed out, because the default request timeout made the allowance larger than 11 minutes; setting `request_timeout_seconds: 10` fixed it;
  - the third case first failed because of a test typo (the repair text was hard-coded);
  - final run: 4 of 4 pass.
- Mutation check: with retry restoration disabled in `retry-state.ts`, the "still fails" case failed. I then restored the file and confirmed it was identical to the backup.
- Final validation from `D:/sy-wt/v1`:

  | Command | Observed result |
  | --- | --- |
  | `pnpm --filter switchyard-router build` | `tsc -p tsconfig.build.json`, no errors |
  | `pnpm -r typecheck` | `packages/router typecheck: Done`, `apps/panel typecheck: Done` |
  | `npx vitest run tests` (packages/router) | `Test Files 25 passed (25)`, `Tests 242 passed (242)`; nothing timed out, so no single-file re-runs were needed |
  | `pnpm --filter switchyard-panel build` | succeeded; route table printed, including `/api/sessions/[id]/resume` and `/api/tasks/resume` |
  | `git grep -n "^<<<<<<<\|^>>>>>>>" -- packages apps` | empty (exit 1) |

## Not verified

- **External coding runner:** a crash during review of an external-runner task was not tested. The fault hook cannot kill the external runner.
- **Batch members** interrupted mid-review: the crash path compiles, but no test covers it.
- **False aborts while the reviewer makes progress:** no test shows that the watchdog leaves a long review alone while the author is idle. The phase-switch timestamp is meant to prevent this, but only the stuck-reviewer case is tested.
- **Tier keeping** for `deferred_for_capacity` and `lease_lost` re-runs is exercised only through the fault tests: process death, and the operator's `resumeTask` with a fresh worktree.
- **Panel:** I did not seed the demo, start the panel, or take screenshots. Only the build ran.
- **Documentation:** `docs/` is not updated. I do not own it.
- **Live providers:** none were used.

## Open questions or contradictions found

1. **Tier keeping after an interruption (my decision; please confirm).**
   - `router.prepare` re-classifies every run with `retryAfterFailure: run_count > 1`, so any re-run, including after a crash or a capacity deferral, counts as a failure and can move up a tier.
   - Combined with V2's re-evaluation at the actual tier, a crash could turn a standard task into a deep one.
   - I kept the earlier tier in the executor, because I own `core`. The classification stored on the result still shows the re-measured tier.
   - The cleaner fix would be in `src/scoring`/`src/routing/router.ts` (outside my ownership): count only runs that actually failed.
2. **Classifier failure on the dev fault tests.** Unhinted `implement` tasks in tests fail over to `classifier_failed` and round up to T3. That makes them deep on this branch. Other dev tests may meet this too after future merges; hints are the test-side fix.
3. **Exports.** `authorSessions`, `restoreRunState`, `supersedeInterruptedReviews`, `REVIEW_SUPERSEDED`, `RETRY_STARTED`, and `REVIEW_RECORDED` are not exported from `src/index.ts`. Add them if the panel or insights should show superseded reviews or retry state.
4. **`src/core/executor.ts` is now 891 lines**, up from 828 on HEAD before the merge. The resume and verification glue is the cause. I moved the retry-state restoration into `core/retry-state.ts`. A further split (for example the review orchestration `verifyWithReview` into `core/acceptance.ts`) is a supervisor call.
5. **Docs to update (supervisor):**
   - `docs/roles.md`: reviewer sessions are never resumed but superseded.
   - `docs/operations.md`: recovery during review, `retry_started`, `review_superseded`, `tier_kept`, and the watchdog covering reviewers.
   - `docs/decisions.md`: tier keeping after an interruption.
