# Report: v2-review

Worker report for "Brief: v2-review" in `docs/working/importance-and-verification.md`, plus the
supervisor's extra decisions 1-6 and the mid-task note on `budget.total`. Worktree `D:/sy-wt/v1`,
branch `feat/v1-verification`. Nothing was committed.

## Outcome

Done. The deep and strict review phase works end to end:
- an independent reviewer runs in a child session and submits a verdict through `submit_verdict`;
- a defect gets one bounded repair, which continues from the submitted revision;
- missing evidence gets one targeted check;
- reviewer routing keeps the reviewer independent of the author and respects reviewer
  qualification;
- the `review` eval family is graded per criterion;
- budgets follow the new total semantics.

Validation is green: the router build passes, `pnpm -r typecheck` passes (router and panel), and
`npx vitest run tests` passes all 20 files and 179 tests (17 of them new).

## Follow-up: supervisor decisions on this report

1. **Confirmed:** a reviewer-only defect that survives the one repair goes to
   `needs_supervisor`; deterministic defects stay `unmet`. No code change.
2. **Confirmed:** the earlier reviewer may re-review a repair. No code change.
3. **Changed: a level raised by the actual result may draw its review from the unallocated
   room.**
   - `reviewAllowance(policy, budget, level, required)` is now `max(review reserve,
     min(review_requests[level], review + unallocated))`. The unallocated room is the ceiling
     (`max_total_requests_per_task`, narrowed by an explicit task budget) minus the reserved
     total.
   - The new `reviewReserveAdjustment` returns `{ from, to, fromUnallocated, wanted }`.
     - The executor records it on the `verification_raised` event, as
       `reserveAdjustment.review`.
     - `reviewResult` uses the same allowance. When even that room is too small, the review is
       not run and the result ends `skipped_budget` / `needs_supervisor`, with the reason "the
       deep review needs 4 request(s); the contract reserved 0 and only N more fit under the
       ceiling".
   - The level is never lowered.
   - Usage can now exceed `budget.total` only by that recorded adjustment, never beyond the
     ceiling.
   - **New test:** "a level raised by the actual result draws its review from the room under the
     ceiling, or ends skipped_budget". It runs a T2 standard coding task with same-tier repairs
     (total 16, review 0, unallocated 8) and a `src/auth/**` rule that raises the level to deep.
     - With room: the event records `{ from: 0, to: 4, fromUnallocated: 4, wanted: 4 }`, the
       review runs, and the result is met.
     - With an explicit budget of 16 (unallocated 0): the result is deep, `skipped_budget`,
       `needs_supervisor`, and no verification request is made.
4. **`src/index.ts` exports:**
   - `ReviewRecordSchema`, `ReviewRecord`;
   - from `verification/contract.ts`: `executionCap`, `repairCap`, `reviewAllowance`,
     `reviewCap`, `reviewReserveAdjustment`, `RequestsUsed`;
   - from `verification/review.ts`: `VerdictSchema`, `validateVerdict`, `submitVerdictTool`,
     `SUBMIT_VERDICT_DEF`, `VERDICT_JSON_SCHEMA`, `VERDICT_CONTRACT`, `VERDICTS`,
     `RECOMMENDED_ACTIONS`, `renderEvidencePackage`, `answerDigest`, `reviewOutcomeOf`,
     `reviewProfile`, `reviewResult`, `runReviewSession`, and the types `EvidenceInput`,
     `ReviewPhaseResult`, `Verdict`, `VerdictExpectations`;
   - from `verification/followup.ts`: `repairRetryContext`, `runTargetedChecks`,
     `submittedRevisionStart`, `targetedCheckAllowed`;
   - from `admission/admission.ts`: `REQUEST_PURPOSES`, `budgetInputFor`, `purposeCategory`,
     `verificationTotal`, `RequestPurpose`;
   - from `qualification/stats.ts`: `REVIEW_FAMILY`, `reviewerQualification`;
   - from `qualification/runner.ts`: `gradeReview`, `reviewEvalPackage`;
   - from `routing/select.ts`: `modelFamily`, `ReviewerQualificationRequirement`.

   **Not exported:** `taskTotalsByPurpose` and `servedEndpointsByPurpose`. They are methods
   reached through `sy.gate.admission`.

**Re-validation after the follow-up:**
- `pnpm --filter switchyard-router build`: ok.
- `pnpm -r typecheck`: router Done, panel Done.
- `npx vitest run tests`: `Test Files 20 passed (20)`, `Tests 179 passed (179)`. Nothing timed
  out on this run, so no single-file re-runs were needed.

## What changed and why

### Review phase: `src/verification/review.ts` (new)

- **Verdict.** `VerdictSchema` (zod, strict) follows the Design shape and adds an optional
  `targetedChecks`. `validateVerdict` enforces, in code:
  - every contract criterion is assessed exactly once;
  - `pass` and `fail` need evidence refs, and `fail` and `inconclusive` need a reason;
  - every ref is inside the reviewer's evidence universe (what it was given or read);
  - `examinedRevision` is the submitted revision (a prefix of 12 or more characters is accepted)
    and `policyVersion` is the contract's fingerprint;
  - the verdict is internally consistent (pass means everything passes and the action is
    `accept`; fail needs a failed criterion or a blocking finding; inconclusive needs missing
    evidence);
  - `run_targeted_check` names only allowed commands.

  `submit_verdict` is the terminal tool, and `VERDICT_JSON_SCHEMA` is shared with qualification.
- **Evidence package.** `renderEvidencePackage` builds the package from:
  - the contract (goal, criteria with ids and verify kinds, scope, level, policy version, and the
    revision to echo);
  - the base commits;
  - SwitchYard's deterministic check results;
  - check runs with log tails and refs;
  - the patch (inline, capped at 20k characters, with its artifact ref) or, for other modes, the
    answer under review;
  - the author's summary and self-assessment, under the heading "Author's claim (unverified)";
  - the context the author was given.

  Everything except the contract is labelled as data.
- **Session.** `runReviewSession` gives the reviewer only read-only tools: repository tools
  (dropped when there are no repositories) and `read_artifact`. Every request carries purpose
  `verification`.
- **Orchestration.** `reviewResult` does the following:
  - **Budget:** it computes the review allowance and the cap for this session.
  - **Authors:** it excludes every endpoint that served the task's classification, execution, or
    repair (`avoidEndpoints`). It ranks other model families first, then other platforms.
  - **Qualification:** it applies reviewer qualification (decision 5).
  - **Session:** it opens a child session (role `reviewer`, parent = the worker's session) and
    runs the reviewer.
  - **Records:** it stores a `review` artifact (verdict, package, transcript) and writes
    `review_started`, `review_completed`, and `review_not_run` events. It returns a `ReviewRecord`
    and the outcome for `decide`.
- **Failures:**
  - No eligible or qualified reviewer gives `inconclusive` with the reason.
  - A provider or capacity error leaves the review not run (`pending`, with the reason); it never
    raises difficulty.
  - A spent allowance gives `skipped_budget`.
  - An invalid verdict gives `inconclusive`.
  - An aborted task rethrows.

### Follow-ups: `src/verification/followup.ts` (new)

- **`submittedRevisionStart`.** It commits anything still uncommitted in the task worktree (as
  the implementer, role `tool`). It returns the HEAD commit only when `HEAD^{tree}` equals the
  verified revision.
- **`repairRetryContext`.** It adds the reviewer's blocking findings and failed criteria, the
  start revision, and a note "fix the defects rather than starting over" to the failure context.
- **`runTargetedChecks`.** It runs once, coding only. Allowed commands are declared checks or
  commands matching `coding.allowed_commands` (`commandAllowed`, which rejects shell
  metacharacters). The checks run in the task worktree, only while its index is still the
  submitted revision, and each record is bound to that revision and digest.

### Decision: `src/verification/decide.ts`

- `notes` are prepended to the reasons, and `reviews` are recorded on the verification record.
- **A defect that only the reviewer found, still standing with no quality retry left,** now gives
  `failed` / `needs_supervisor` (`await_supervisor`) instead of `unmet`. Deterministic defects (a
  failed check, a check-verified or self-reported failure) stay `unmet`. Why:
  - The brief's flow is "then passes or goes to needs_supervisor".
  - The supervisor must be able to overrule a reviewer; V3 counts that as a false rejection.
    `applySupervisorDecision` refuses to accept `unmet`, so an `unmet` result could never be
    overruled.

### Executor: `src/core/executor.ts`

- **`verifyWithReview`.** It runs the deterministic checks first. A review runs only when the
  level requires one, execution completed, and no deterministic defect was found. When a repair
  is still possible, the first review gets half the allowance and the re-review keeps the rest.
  A reviewer's `run_targeted_check` runs once, followed by a re-review. Qualification-purpose
  tasks are not reviewed: the suite grades them.
- **Repair in every mode (decision 4).** A `repair` action gets one repair, labelled with purpose
  `repair`:
  - It runs at the next tier when `escalate_on_failure` is on and a next tier exists; otherwise
    it runs at the same tier, so T3 tasks get their repair too.
  - Its cap is the requests used so far plus what is left of the repair reserve.
  - Coding repairs start from the submitted revision.
  - It writes `quality_repair` and, when the tier changes, `escalated`.

  Execution-failure escalation (`budget_exhausted`, `invalid_output`) works as before, now also
  under purpose `repair`. When a repair is called for but cannot run (forced endpoint, no budget,
  no candidates), the decision is settled as if no retry remained.
- **Re-evaluation at the tier the run actually ran at (decision 3).** The tier is passed to
  `verifyOutcome`, and from there to `reevaluateOnResult`.
- **Batch members** are reviewed one by one, with no repair inside a batch.

### Budget (decision 1, plus the supervisor's note on totals)

- **Config (`config/schema.ts`, verification section only).**
  - `max_total_requests_per_task` (24) is a ceiling, validated to leave at least one execution
    request at every level.
  - `reviewer_qualification: preferred | required` (default `preferred`).
  - `review_strict_pass_threshold` (0.85).
- **Admission (`admission/admission.ts`).**
  - `verificationTotal(cfg, spec)`: the ceiling, narrowed by an explicit `budget.maxModelRequests`.
  - `budgetInputFor(cfg, spec, tier, classificationUsed)`: the repair tier is next when escalation
    is on, else the same tier.
  - `purposeCategory`, `taskTotalsByPurpose`, and `servedEndpointsByPurpose` cover the four
    purposes: classification, execution, verification, and repair.
- **Allocation (`verification/contract.ts`).** `allocateBudget` reserves, in order:
  classification, the level's review, execution (the profile and tier cap), repair, and then the
  review that the repaired result needs at the repair tier (computed in `compileContract` by
  evaluating the policy at that tier).
  - `budget.total` is now the sum of what is reserved. `unallocated` is room under the ceiling
    that is never spent.
  - `reviewAllowance` is the review reserve.
  - New cap helpers: `executionCap`, `repairCap`, and `reviewCap`.

  Admission enforces these per run as cumulative caps, so the sum can never exceed the total.
  `verification_budget_insufficient` now arises only when an explicit task budget (or a lowered
  ceiling) cannot hold the classification, the review, and one execution request.
- **Totals with the test config (asserted in the new suite):**

  | Task | Total | Execution | Review | Repair |
  | --- | --- | --- | --- | --- |
  | summarize, T1, standard | 8 | 4 | 0 | 4 |
  | implement, T2, standard | 20 | 8 | 4 (for the T3 repair) | 8 |
  | analyze, T3, deep | 16 | 6 | 4 | 6 |
  | strict (critical summarize, T1) | 14 | 4 | 6 | 4 |

  An explicit budget of 9 on the strict task gives a total of 9: execution 3, review 6, repair 0.
- **`core/acceptance.ts`.** `ensureContract` uses `budgetInputFor`, and the submit-time shortfall
  uses the ceiling. `runCap` now covers the first run only. `verifyOutcome` takes options: tier,
  review, budget exhausted, reviews, and notes.

### Routing and qualification

- **`routing/select.ts`.**
  - `RouteRequirements` gains `avoidEndpoints` (an exclusion reason), `avoidFamilies` and
    `avoidProviders` (rank last), `minTotalParametersB` (a higher floor), and `reviewer` (the
    reviewer qualification requirement, which replaces the worker `qualification.required` check
    for that request).
  - New `modelFamily(ep)`: the model name's first word without its organisation prefix.
- **`routing/router.ts`.** New `planReviewer`.
- **`qualification/stats.ts`.** It gains a threshold parameter and a family override in the
  lookup, `REVIEW_FAMILY`, and `reviewerQualification(cfg, name, tier)`:
  - `review`: the review family at the task's tier, using `qualification.pass_threshold`, in the
    configured mode.
  - `review_strict`: the review family on T3 evaluations, using `review_strict_pass_threshold`,
    always required.
- **`qualification/runner.ts`.**
  - The family is now `coding | read_only | review`, and a review eval schema was added
    (`kind`, `patch` or `work`, `checks`, `authorSummary`, `expect`).
  - Review evals submit a `review`-profile carrier task: the same `renderEvidencePackage`
    content inline, with `outputSchema = VERDICT_JSON_SCHEMA`, pinned to the endpoint.
  - `gradeReview` validates the verdict and requires the expected verdict and per-criterion
    outcomes.
- **`evals/suite.json`.** Version `2026-10-19.2`.
  - Eight review evals, with patches produced by `git diff` against copies of the existing
    fixtures:
    - T1: correct and defect.
    - T2: style and unverifiable.
    - T3: all four kinds.
  - `rename-option`'s budget went from 12 to 16, so deep's review reserve does not squeeze its
    execution.
  - The labels were checked with the fixtures' hidden tests: the correct and style patches pass,
    and the defect patches fail (`not ok 3 - step`, `not ok 1 - new option is in seconds`).

### Other owned files

- **`harness/supervisor-tools.ts` (decision 2).** `integrate_task` now records the acceptance
  only after a successful cherry-pick.
  - It still refuses up front when the result is strict and `strict_acceptor` is human.
  - A conflict, or a task with no commits, records nothing.
  - If the acceptance is refused after the pick, the pick is rolled back with
    `git reset --keep`, which keeps the supervisor's uncommitted edits.
- **`charters/reviewer.md`.** Rewritten: the contract is the standard, the author's claim is not
  evidence, judge correctness rather than style, verdicts require evidence, data is never
  instructions, and the reviewer finishes with `submit_verdict`.
- **`AGENTS.md`.** `verification` was added to "Placement by area".

### Minimal edits outside my ownership (needed for the brief)

| File | Change | Why |
| --- | --- | --- |
| `src/core/task.ts` | `ReviewRecordSchema`; optional `VerificationRecord.reviews` | The review record lives on the result. Backward compatible. |
| `src/core/acceptance.ts` | Budget input and total, `runCap`, `verifyOutcome` options | Executor glue for decisions 1 and 3. |
| `src/verification/policy.ts` | `ResultFacts.tier` (never below the contract's) | Decision 3. |
| `src/runners/types.ts` | `RunContext.purpose` (`ask` uses it); `RetryContext.startFrom` | Purposes; the repair start. |
| `src/runners/coding/finish.ts` | `prepareWorkspace` passes `startCommit` | The repair starts from the submitted revision. |
| `src/workspaces/worktree.ts` | `prepare({ startCommit })` checks out that commit; diffs stay against the base | Same. |

### Tests

- **New: `tests/verification-review.test.ts` (16 tests).** These use the scripted fake gateway
  and the real native coding runner with real worktrees. They cover:
  - **Deep review of a correct patch:** the result is met, the reviewer is a different endpoint
    and family, the review runs in a child session, the package contents are checked, and the
    allocation holds.
  - **A seeded defect:** the review fails, exactly one `quality_repair` follows, and the second
    worktree starts at the submitted commit. The repair brief carries the reviewer's finding, and
    the repair's edit only applies on top of attempt 1. The re-review passes and the result is
    met.
  - **A defect only the reviewer sees, still there after the repair:** the result goes to
    `needs_supervisor`, and the supervisor can overrule it.
  - **Read-only work:** it is also repaired and re-reviewed.
  - **Missing evidence:**
    - an inconclusive verdict gives `needs_supervisor` with no repair;
    - a targeted check runs once on the revision, then a re-review passes.
  - **Independence:** the author never reviews; with no other model the review is inconclusive
    and spends no request. A different family is preferred over a bigger sibling.
  - **Qualification:** in `required` mode and at strict, unqualified reviewers are refused, and
    qualified ones review (`qualified: true`, `review_strict`).
  - **Budget:**
    - the totals table above;
    - a reviewer that never decides is cut off at its share (2 of 4), giving `skipped_budget`;
    - a small profile cap is accepted, and only an explicit budget is refused.
  - **`integrate_task`:** a conflict records no acceptance; after a reset, the integration
    records it.
  - **Reviewer grading:**
    - an approve-everything reviewer passes only 4 of 8 evals (`passRate 0.5`, not qualified),
      while an accurate one passes all 8 and qualifies;
    - malformed or unbound verdicts fail;
    - a review eval runs end to end through `Qualifier.start` and is graded (correct passes,
      defect fails).
- **Updated:**

  | File | Change |
  | --- | --- |
  | `tests/verification-flow.test.ts` | New totals; strict with no qualified reviewer gives inconclusive; deep with a failing reviewer gives pending; the T2-to-T3 repair is now deep and waits for review (decision 3); the explicit-budget refusal. |
  | `tests/verification.test.ts` | One allocation total: 16 became 13, the reserved sum. |
  | `tests/qualification.test.ts` | Suite listing, plus an assertion on the review kinds and tiers. |
  | `tests/paid.test.ts` | The summarize workaround is reverted; the test now asserts that execution was served by the paid model (premium T4 runs at T3, which is deep, so a reviewer serves too). |

## Commands run and observed results

- `npx tsc --noEmit -p tsconfig.json` (packages/router): clean after each step.
- `pnpm --filter switchyard-router build`: `tsc -p tsconfig.build.json` succeeded.
- `pnpm -r typecheck`: `packages/router typecheck: Done`, `apps/panel typecheck: Done`.
- `npx vitest run tests/verification-review.test.ts`:
  - first full run: 15 passed, 1 failed (the test kept live request objects);
  - after fixing the test: 16 passed.
- `npx vitest run tests` (packages/router):
  - **Before the test updates:** 7 failed (the expected behaviour changes above, plus the suite
    listing).
  - **Mid-way, three full runs:** 7, 3, and 1 failures. All were `Test timed out in 5000ms`, in
    different tests each run (attribution, brain, sessions, policy, execution). The CPU was at
    99%, with the load coming from other processes. With `--exclude` of my file a brain test
    still timed out, and the failed files all passed when run alone.
  - **Final run, after the build:** `Test Files 20 passed (20)`, `Tests 178 passed (178)`.
- **Label check for the review evals:** a scratch script applied each patch to a fixture copy
  and ran its hidden tests.
  - The correct and style patches passed (`# fail 0`).
  - `review-range-defect` failed with `not ok 3 - step`.
  - `review-rename-defect` failed with `not ok 1 - new option is in seconds`.

## Not verified

- No live model, FreeLLMAPI, OpenCode, or paid provider was used; reviewers were scripted.
- Real reviewer behaviour is untested:
  - whether models follow the verdict contract and echo `examinedRevision` and `policyVersion`
    exactly;
  - whether two requests (half of the deep allowance of 4) are enough for a useful first review.
- The external coding runner's repair from the submitted revision: only the native runner is
  exercised. `submittedRevisionStart`'s "commit uncommitted edits" branch is not hit by a test.
- `integrate_task`'s rollback when an acceptance is refused after the pick: that refusal is now
  pre-checked, so it is only reachable if the config changes in between. It is untested.
- Batch-member review is exercised only by the unchanged batch tests, where members are standard
  and get no review.
- Repairs at the next tier with `escalate_on_failure: false` (same-tier repair) are covered only
  at T3.
- The panel was not built. `pnpm -r build` was not run; only the router build and the typecheck
  were.
- Docs under `docs/` (roles, operations, decisions, setup) were not updated: I do not own them.

## Open questions or contradictions found

1. **Independence for re-reviews.** I exclude endpoints that served classification, execution,
   or repair, but not an earlier reviewer, so the same reviewer may re-review the repair. Decision
   5 says "every endpoint that served the task". A literal reading also excludes earlier
   reviewers, which shrinks the pool. If you want that, it is a one-line change in
   `reviewResult` (`authors` would also include `served.verification`).
2. **A defect only the reviewer found, after the one repair, is `needs_supervisor`, not
   `unmet`.** Reasons are in "Decision" above. Deterministic defects stay `unmet`, and
   `integrate_task` still refuses those. Please confirm.
3. **(Superseded by follow-up 3 above.) The review headroom for a raised level is reserved up
   front.** Per your note,
   `budget.total` is the reserved sum and `unallocated` is never spent. So the review a T2 task
   needs if its repair runs at T3 is reserved at contract time; this is why implement T2 shows a
   total of 20. A level raised only by what the result changed (for example a protected-path
   edit on a standard task) has no reserve beyond it, so such a task ends `skipped_budget` /
   `needs_supervisor`. That is the "never exceed the contract allocation" side of the trade-off.
4. **Quality repair at T3 runs at the same tier.** The Design says "one repair at the next tier".
   With no next tier (or with `escalate_on_failure: false`) I repair at the same tier, so deep
   tasks, which are mostly T3, still get their one repair.
5. **Reviewer qualification uses a carrier task.** Review evals run through the pipeline as a
   `review`-profile task returning the verdict as `data` via `submit_result`. They use the same
   evidence renderer and charter as production, not the production `submit_verdict` session.
   The production session needs an executor-run task, and a reviewer that judged a qualification
   task would measure another model. Running a reviewer session against a fixture directly would
   need a review-only executor path.
6. **(The `src/index.ts` exports are done; see follow-up 4.)** `AGENTS.md`'s area list also
   lacks `sessions`, which already exists.
7. **Docs to update (supervisor):**
   - `docs/roles.md`: the reviewer role and its child session.
   - `docs/operations.md`: the budget totals and ceiling, and purposes.
   - `docs/decisions.md`: reviewer independence and qualification, the reviewer-only defect
     rule, and reserving the repair-tier review.
