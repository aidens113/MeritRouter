# Report: v1-exec

Worker report for "Brief: v1-exec (after v1-core)" in `docs/working/importance-and-verification.md`.
Worktree `D:/sy-wt/v1`, branch `feat/v1-verification`. Nothing was committed.

## Outcome

Done, with one cross-brief issue: `pnpm -r typecheck` fails in `apps/panel` (not mine; see Open
questions 1). The router typechecks and builds, and all 156 router tests pass (143 before plus 13
new in `tests/verification-flow.test.ts`).

## What changed and why

### Executor and service (`src/core/`)

- **New `src/core/acceptance.ts`.** This is the glue between the executor and the verification
  library. I kept it out of `executor.ts`, which grew to 548 lines. It holds:
  - `ensureContract`: compile the contract once after classification, or return the stored one
    on a resumed run. Writes a `contract_compiled` event.
  - `runCap`: the per-run request cap.
  - `verificationBudgetShortfall`: the check at submit time.
  - `verifyOutcome`: re-evaluate the policy, run the named checks, decide, and build the record.
  - `failureContext`: what the escalation retry is told.
  - `parentImportance`: the parent's contract importance, falling back to its spec's.
  - `recordAcceptanceDecision`: accept or reject.
- **`executor.ts`**
  - New dependency `contracts: ContractStore`.
  - `runSingle`:
    - Compiles the contract for every mode except `supervisor`. Supervisor jobs keep their
      job-check acceptance and get `verificationStatus: "not_required"`.
    - Fails the task with `verification_budget_insufficient: …` when the contract will not fit
      the budget.
    - Verifies every outcome and appends `verification_raised` when the level rises on the
      result.
    - Escalation: `acceptance_unmet` is now triggered by `decision.action === "repair"`. This
      stays coding-only, as today.
    - The retry gets a `RetryContext` and the repair cap. Any escalation counts as the task's one
      quality retry.
  - `runBatch`: compiles each member's contract at its own tier (a member that does not fit
    fails before the shared request) and verifies each outcome.
- **The run cap** is admission's cumulative count: `min(tier cap, classification + execution)`
  for the first run, plus `repair` for the escalation run. Without a contract it is the tier cap,
  as before. Without a review reserve this equals today's cap exactly. With one, the reserve
  stays free. Example: T3 deep for `implement` (total 8) runs with a cap of 4.
- **`service.ts`**
  - `readonly contracts`, `contract(id)`, `acceptTask(id, {by, reason})`, and
    `rejectTask(id, {by, reason})`. Both decision methods wake waiters.
  - The services passed to supervisors gain `acceptTask` and `rejectTask`.
  - `submitTasks` refuses a task with `verification_budget_insufficient` when even the weakest
    level it could get needs more requests than its total cap allows. "Weakest" is taken over
    every tier from its floor (min_tier, hint, routing tier) to T3, using hint tags and the
    parent's importance. Premium T4 is checked at T3.
- **`task.ts`** (owned by v1-core; a one-field edit following supervisor decision 1):
  `WorkerResult.unresolvedCriterionIds?: string[]`.
  - It is parallel to `unresolvedCriteria`. Both list the criteria that are neither verified nor
    claimed with evidence.
  - This keeps today's meaning: a criterion the worker claimed as met with evidence is not
    "unresolved"; its `claimed` status is visible in `verification.criteria`.

### Runners (`src/runners/`)

- **`types.ts`**
  - `RunOutcome.evidence?: { revision, artifactDigest, universe, output }`, the
    verification inputs that are not stored on the result.
  - `RunContext.contract?` and `RunContext.retry?`.
  - `RetryContext`, `AcceptanceDecisionInput`, and `AcceptanceDecisionOutcome`.
  - `SupervisorServices.acceptTask` and `SupervisorServices.rejectTask`.
- **Evidence from each runner:**
  - `completion.ts`, `readonly.ts`, and `batch.ts` pass the evidence universe and the worker's
    criteria.
  - `coding/native.ts` passes them through `finishCoding`.
- **`coding/finish.ts`**
  - The revision is the staged tree (`git write-tree` after `collect`'s `add -A`) and the digest
    is the patch's sha256.
  - Every check record carries `revision` and `artifactDigest`, and the check log notes the
    revision.
  - Sets `changedPaths`, `scopeViolation`, and `protectedPathsChanged`.
  - `unresolvedCriteria` is now per criterion: a check-verified criterion is resolved when its
    own checks passed on this revision.
- **Prompts:** `prompts.ts` gains `renderRetryContext`, and `taskBrief(spec, retry)` includes it.
  The external coding brief (`coding/index.ts`) and the native, completion, and read-only prompts
  render the retry context. That context includes:
  - findings;
  - unresolved criteria;
  - verification reasons;
  - failing check commands with a 2000-character log tail.

  It is labelled as data about the previous attempt.

### Harness, scoring, storage, charter

- **`harness/supervisor-tools.ts`**
  - `delegate` takes `importance` and `importance_reason`.
  - New `accept_task` and `reject_task` tools. Their descriptions (via the exported
    `ACCEPTANCE_JUDGEMENT`) say the supervisor judges against the job's goal and the
    specifications it was given. Acceptance is recorded with who accepted
    (`{kind: "supervisor", id: "<agent> (job <id>)"}`) and the reason.
  - With `strict_acceptor: human`, strict results are refused with
    `human_acceptance_required` and stay `needs_supervisor`.
  - `integrate_task` now works from structured fields, falling back to finding text for older
    results:
    - refuses out-of-scope changes and `unmet` results;
    - protected paths still need `accept_test_changes: true`;
    - `not_verified` and `needs_supervisor` results need `accept: true` and a reason, which
      records the acceptance just before the cherry-pick;
    - refuses when the task worktree's `HEAD^{tree}` differs from the revision its checks ran
      on.
  - `summarizeResult` shows the verification status, level, and reasons.
- **`scoring/score.ts`**
  - `classifierCouldMatter` is now false only at a measured T4. Otherwise it is true when tags
    could change the tier or the rulebook can reject. This means the classifier runs at a
    measured T3.
  - New `rulebookCanReject`.
- **`storage/tasks.ts`**
  - New `updateResult(id, apply)`: a transactional read-modify-write of a finished result,
    plus an event.
  - The dependency gate writes `dependency_unverified` on the dependent for each
    `not_verified` or `needs_supervisor` prerequisite. Release behaviour is unchanged.
- **`charters/supervisor.md`**
  - Acceptance statuses, judging against the job's goal and the specifications given, and
    `accept_task`/`reject_task` with recorded reasons.
  - The human strict acceptor, `delegate` importance, and `integrate_task`'s `accept`.
- **`src/index.ts`** exports:
  - the task helpers and enums (`criteria`, `criterionTexts`, `autoCriterionId`, the status,
    outcome, and decision schemas and types);
  - the verification API (contract, policy, importance, checks; `decide` is exported as
    `decideVerification` and `Decision` as `VerificationDecision`);
  - the acceptance types.

### Library bug fix (`src/verification/checks.ts`)

`output_contract` counted any non-completed execution as a failure. That made every incomplete
run a defect: `decide` step 1's "inconclusive / not_verified" branch was unreachable, and
budget-exhausted or invalid-output read-only runs would become `unmet` instead of today's
`not_verified`.

Now, when execution did not complete:

- Only real defects fail (a coding run that changed nothing).
- Otherwise the outcome is `not_run` with the execution status.

Completed runs are unchanged. All v1-core tests still pass.

### Existing tests updated (supervisor decision 2 and the brief)

- `tests/coding.test.ts`, "flags modified tests…": `not_verified` became `needs_supervisor`.
  - The protected-path edit matches the default `evaluator-changes` rule, which raises the level
    to deep.
  - V1 has no reviewer, so the result ends `pending` / `needs_supervisor`.
  - The test also asserts `protectedPathsChanged`.
- `tests/session-recording.test.ts`, the supervisor job: `integrate_task` now passes
  `accept: true` and a reason. The delegated coding task declares no checks, so it is
  `not_verified`, and the new gate requires an explicit, recorded acceptance.
- `tests/paid.test.ts`, "T4 work goes to paid models when the T4 policy is premium":
  - The test now raises `summarize.max_model_requests` from 4 to 6.
  - Premium T4 runs at T3, which is deep by default. Its review reserve of 4 plus one
    execution request no longer fits a total of 4, so the task would fail with
    `verification_budget_insufficient` (now refused at submit).
- `tests/scoring.test.ts`, "classifier is skipped…": a measured T3 (score 9) now expects
  `true`, and a new assertion expects a score past T3 (12) to be `false`. This is the brief's
  "classifier at measured T3" fix.

### New `tests/verification-flow.test.ts` (13 tests)

Coding is exercised with a stub `CodingRunner` (no worktree, no model requests). The tests:

- **Default policy:** the contract is stored before the run (`contract_compiled` before
  `completed`) and the default policy reproduces today's `not_verified` with the record
  attached.
- **Budget at submit:** an insufficient budget is rejected at submit (T1 critical → strict on
  `summarize`).
- **Strict:** strict ends `needs_supervisor`/`pending` and the run cap excludes the review
  reserve (total 8, review 6, execution 2). Accepting needs a reason; the decision records `by`
  and `reason`, and a `result_accepted` event is written.
- **Human acceptor:** `strict_acceptor: human` refuses the supervisor with
  `human_acceptance_required` and accepts a human.
- **Reject:** rejecting needs a reason and gives `unmet`; an unmet result then cannot be
  accepted.
- **Dependency warning:** a dependent of a `not_verified` result runs, with the
  `dependency_unverified` event.
- **Coding met:** a coding result whose checks passed on the submitted revision is `met`, and
  the run cap is the tier's.
- **Stale checks:** checks bound to an older revision are `stale`, giving `needs_supervisor` /
  `inconclusive` with `unresolvedCriterionIds: ["c1"]`.
- **Raised after the fact:** a change touching a path a configured rule marks critical raises
  the level from standard to strict, records the `verification_raised` event, and leaves the
  contract unchanged.
- **Deep:** deep at T3 reserves 4 of 8 for review, the run cap is 4, and the result waits for
  review.
- **Escalation retry:** the retry gets the failing check's log tail, the unresolved criteria,
  the verification reasons, and the repair cap. Total 16: execution 8, repair 8. The first cap
  is 8 (T2) and the repair cap is 12 (T3). The final result is `met` at T3.
- **Tool descriptions:** the acceptance tool descriptions state the judgement and recording,
  and `delegate` has `importance` and `importance_reason`.
- **`integrate_task` gate:** refuses unmet results and out-of-scope changes, needs `accept: true`
  and a reason, and records nothing when integration cannot proceed. `accept_task` records the
  decision and gives `met`. `reject_task` works; `accept_task` on an unmet result is refused.

## Commands run and observed results

- `npx tsc --noEmit -p .` (packages/router): clean after one fix in `acceptance.ts`.
- `pnpm --filter switchyard-router build`: `tsc -p tsconfig.build.json` succeeded.
- `npx vitest run tests` (packages/router):
  - First run: 4 failed and 139 passed. The failures were the four tests listed above, all
    with the expected new behaviour.
  - After the updates: `Test Files 18 passed (18)`, `Tests 156 passed (156)`.
- `npx vitest run tests/verification-flow.test.ts`:
  - First run: 2 failed. My test assumed a hinted T1 implement task stays T1; it measures T2.
  - After fixing the test: 13 passed.
- `pnpm -r typecheck` (from `D:/sy-wt/v1`):
  - `packages/router` passed.
  - `apps/panel` failed: `app/tasks/[id]/page.tsx(128,23): error TS2322: Type 'string | { id:
    string; text: string; verify?: …; checks?: … }' is not assignable to type 'ReactNode'`.

## Not verified

- No live gateway, FreeLLMAPI, OpenCode, or paid provider.
- `finish.ts` binding checks to a real staged tree is covered only by the existing
  real-worktree coding tests (`coding.test.ts`, `native.test.ts`, `session-recording.test.ts`).
  They pass, but they do not assert `revision`.
- `integrate_task`'s real cherry-pick after an acceptance is covered by the supervisor
  session-recording test, but only in a passing form. Its new stale-tree refusal and the
  human-acceptor refusal are not exercised against a real worktree.
- Batch-member verification is not exercised directly. Batches pass through the existing batch
  test, which still asserts the old outcomes.
- The panel was not built (`pnpm -r build` was not run; it would hit the same panel error).
- No docs under `docs/` were changed: not owned. AGENTS.md's area list needs `verification`.

## Open questions or contradictions found

1. **Panel typecheck fails.** `apps/panel/app/tasks/[id]/page.tsx:128` renders
   `spec.constraints.acceptanceCriteria` entries directly. Since v1-core, an entry can be an
   object.
   - v1-core reported the panel typecheck as passing; it probably ran against a stale `dist`.
     The rebuilt `dist` exposes the error.
   - The fix belongs to v1-surface (it owns `apps/panel/**`): use `criterionTexts(spec)` or
     `criteria(spec)`, now exported from the package index.
2. **Quality repair stays coding-only.** A read-only self-reported unmet is `decision.action:
   "repair"` but is not escalated, to keep today's behaviour. The Design's "repair on a concrete
   defect" would widen this in V2.
3. **The classifier now runs whenever the measured tier is below T4,** because the default
   rulebook can reject (`ambiguity: high`). In practice this changes only the measured-T3 case.
   Tags also feed importance floors now (`risk: security`), so arguably the classifier matters
   for verification even when the tier cannot move. I did not widen it further.
4. **The allocation slightly overstates execution.** `allocateBudget` treats `tierExecution` as
   an amount, while admission caps are cumulative (classification included).
   - I apply `min(tier cap, classification + execution [+ repair])`, which keeps today's caps
     and the reserves.
   - The stored `budget.execution` can therefore exceed what the run may actually use by the
     classification count.
5. **Acceptance and integration order.** `integrate_task` records the acceptance before the
   cherry-pick. A merge conflict after that leaves the task accepted but not integrated. The
   acceptance is a judgement of the result, so I left it that way.
6. **Escalation keeps the contract's tier.** An escalated run is verified at the contract's
   (classified) tier, not the higher tier it ran at. For example, T2 → T3 stays standard, as
   today.
