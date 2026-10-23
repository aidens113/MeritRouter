# Task importance and verification policy

Status: Active
Status detail: V1, V2, and V3 (calibration) done 2026-10-19; live-model validation outstanding.
Created: 2026-10-19
Last updated: 2026-10-19
Owner: Senior supervisor agent
Scope: Add task importance as its own attribute and use it, with difficulty and the actual change, to pick a verification policy: what evidence, checks, and independent review a result needs before it is accepted, paid for out of a budget reserved before execution.
Paired document: [agent sessions and teams](./agent-sessions-and-teams.md) (reviews run as sessions; this replaces its T2 "automatic review agents")
Related: [decisions](../decisions.md), [roles](../roles.md), [operations](../operations.md)

---

## Current State

**Goal (user, 2026-10-19):** SwitchYard controls both who does the work (difficulty -> tier ->
model) and what evidence is required before a result is accepted (importance + difficulty +
what actually changed -> verification level). The user forwarded a consultant's proposal and
asked for a plan adjusted to this codebase; the proposal's ideas are adopted where they fit and
changed or deferred where they do not (see "Adjustments to the proposal").

**Baseline before this effort (verified in code 2026-10-19, `main` at 1751454):**
- Difficulty: rulebook scoring (measured features + semantic tags, T1-T4, versioned
  fingerprint); T4 returns to the submitter as `too_difficult_for_workers`.
- Acceptance: `acceptanceStatus` is `met | unmet | not_verified`. Self-reports never yield `met`.
  Only coding tasks (all supervisor checks pass, in scope, no protected-path edits) and
  supervisor jobs (job checks pass) can be `met`. Read-only and completion results are at best
  `not_verified`.
- Basic contract checks already exist: `validateWorkerOutput` (each criterion assessed once,
  evidence refs inside the evidence universe, output schema), scope and `coding.protected_paths`
  detection, check logs as artifacts.
- Gaps found:
  - Acceptance criteria have no ids (array index only).
  - Coding acceptance flattens criteria to all-or-none.
  - Check results are not bound to the commit they ran against.
  - `integrate_task` ignores `acceptanceStatus` and matches finding text by prefix.
  - No automatic review. The `review` profile exists but is never dispatched by code.
  - No reviewer independence: no link to the reviewed task and no endpoint exclusion; T2 and T3
    share the 100B floor, so the same model can serve both attempts.
  - Escalation (one retry at the next tier) gets no failure context, and only coding escalates
    on `unmet`.
  - Dependents never see upstream results.
  - No importance or priority anywhere.
  - Budgets are one request count per task. Classification already draws on it, and usage is
    not broken down by purpose.
  - Qualification is keyed by (endpoint, mode family, tier). It has no review, completion, or
    supervisor families, and `qualification.required` defaults to false.
  - The classifier is skipped when the measured tier is already T3, although tags could still
    push it to T4 or reject it.

**V1 and V2 done (2026-10-19, merged to dev):**
- `src/verification/`: importance floors, policy (levels, matrix, rules, fingerprint), immutable
  contracts (`task_contracts`) with budget allocation, named deterministic checks, decision,
  reviewer phase (`review.ts`, `phase.ts`, `followup.ts`), and the panel trail (`trail.ts`).
- Execution: contract after classification; reserves on top of execution caps under
  `verification.max_total_requests_per_task` when explicitly configured (unset by default); a raised level may draw unallocated room;
  checks bound to the revision; re-evaluation at the tier actually run; one quality repair across
  the task (all modes) from the submitted revision; retry state survives restarts.
- Review: a reviewer child session never served by an endpoint that worked on the task,
  preferring another family; `reviewer_qualification: preferred` (size-floor fallback marked
  `reviewer_unqualified`), strict requires `review_strict`; `review` eval family rejects
  approve-everything models. Reviewer-only defects after the repair go to `needs_supervisor`;
  deterministic defects stay `unmet`.
- Acceptance: `accept_task` / `reject_task` (supervisor, judged against the job's goal and
  specifications), `integrate_task` gate (records acceptance only after a successful
  cherry-pick), CLI `accept|reject` and panel buttons (human), MCP `accept_result` /
  `reject_result` (recorded as the supervisor; refused for strict under `strict_acceptor: human`).
- Resume composes: an interruption during review resumes the author session; interrupted
  reviewers are superseded; the watchdog covers reviewers; scoring counts only failed runs as
  retries.

**V3 done (2026-10-19):** `verification/calibration.ts` (verdict records, confirmation
signals, cached verdicts), `verification/audit.ts` (sampled background audits, off by default),
`admin/calibration.ts`, panel Calibration page; `criterion_evidence` now shows "passed (review)".

**Not done:** nothing planned. Known gaps: no live model has produced a verdict yet (scripted
reviewers only); external-runner repair, batch members under review, and failed audit tasks are
untested; a job check failing after integration counts as an escaped defect for every task
integrated on that branch (noisy on shared branches).

**Next steps:** live validation against FreeLLMAPI when credentials exist.

**Blockers:** none.

---

## Adjustments to the proposal

1. **Adopted as proposed:**
   - Importance is a separate attribute (`low | normal | high | critical`) with a reason. It
     raises verification, never difficulty.
   - Effective importance is the strongest of the applicable floors.
   - Four verification levels as composable bundles.
   - The difficulty x importance matrix (T4 already returns to the supervisor).
   - An immutable acceptance contract persisted before dispatch.
   - Criterion-level verdicts.
   - `verificationStatus` kept separate from `executionStatus` and `acceptanceStatus`.
   - Cheap checks first.
   - One bounded quality retry across the whole task.
   - Failure types handled differently.
   - Reviewer qualification kept separate from worker qualification.
   - Calibration measured against "subsequently confirmed", not judge approval.
2. **Changed for this codebase:**
   - **Review runs inside the task**, as a verification phase in a reviewer child session charged
     to the same task. It is not a separately submitted task, so its budget, contract, and
     revision binding stay in one place.
   - **No model review at Standard by default.** Standard is deterministic: contract checks plus
     every declared check on the submitted revision. Criteria that no check covers stay
     `not_verified`, as today. The proposal's "semantic review when the criteria require it"
     has no reliable trigger; criteria that need judgement must be marked `verify: review`,
     which forces at least Deep.
   - **Existing risk tags feed importance floors.** `security`, `data_migration`, and
     `public_api_change` already exist in the rulebook's semantic tags. Floors come from
     tags, profiles, path rules, the parent job, and the actual diff.
   - **Undo is a ground-truth signal.** The attribution system already records which task wrote
     which lines and supports undo; an undone accepted task counts as an escaped defect.
   - **Strict acceptance is by the job's supervisor.** That is Claude Code over MCP, SwitchYard's
     own supervisor model, or a human via panel/CLI when `verification.strict_acceptor: human`.
     The proposal assumed Claude is always the supervisor.
3. **Deferred:**
   - Scheduling priority: none exists, and it is out of scope.
   - Propagating importance to upstream dependencies: dependents do not consume upstream output
     yet. Revisit with the T1 task graph, which will pass results downstream.
   - Batched lightweight reviews and cached verdicts: V3, keyed by contract digest, artifact
     digest, policy fingerprint, and source revisions.
   - Exact upstream attempt counting: package requests and FreeLLMAPI `provider_attempts`
     (`attempts_exact=0`) are already recorded separately; nothing new needed.
4. **Small fixes the proposal exposed** (folded into V1):
   - Classify at a measured T3 when tags could still reach T4 or reject.
   - Bind check results to the revision.
   - Make `integrate_task` use structured flags and honor acceptance.
   - Give the escalation retry the failure context.

---

## Design

### Task fields (WorkerTask, all optional, validated with zod)

- `importance`: `low | normal | high | critical` (default `verification.default_importance`,
  `normal`), plus `importanceReason` (required for `high` and `critical`).
- `constraints.acceptanceCriteria` accepts strings or `{ id, text, verify?: "check" | "review" |
  "evidence", checks?: string[] }`. Strings get ids `c1..cn`. Ids are stable in the contract,
  results, and verdicts. `unresolvedCriteria` becomes ids, with the text kept for display.
- `verification`: `{ atLeast?: level, addChecks?: string[] }`. A submitter can strengthen the
  policy, never weaken it.
- Surfaces: MCP `submit_tasks`, the supervisor `delegate` tool (adds `importance` and
  `importance_reason` per brief), and the CLI submit.

### Verification policy (config `verification`, versioned and fingerprinted like the rulebook)

```yaml
verification:
  version: 1
  default_importance: normal
  levels:            # bundles; `extends` unions checks
    basic:    { checks: [output_contract, evidence_provenance, scope, protected_paths] }
    standard: { extends: basic, checks: [declared_checks, criterion_evidence] }
    deep:     { extends: standard, review: { required: true, qualification: review, min_total_parameters_b: 100, independent: true } }
    strict:   { extends: deep, review: { qualification: review_strict }, acceptance: supervisor }
  matrix:            # tier -> importance -> level; T4 never reaches verification
    T1: { low: basic, normal: standard, high: deep, critical: strict }
    T2: { low: standard, normal: standard, high: deep, critical: strict }
    T3: { low: deep, normal: deep, high: deep, critical: strict }
  floors:            # importance floors (strongest wins)
    - { when: { tags: { risk: [security, data_migration] } }, importance: critical }
    - { when: { tags: { risk: [public_api_change] } }, importance: high }
  rules:             # level minimums and extra checks; matched before dispatch and again on the result
    - { id: refactor, when: { tags: { kind: refactor } }, require_at_least: deep }
    - { id: evaluator-changes, when: { protected_paths_changed: true }, require_at_least: deep, add_checks: [evaluator_change_review] }
    # project-specific: { when: { changed_paths: ["src/auth/**"] }, importance: critical }
  budget:            # requests reserved out of the task's total before execution
    review_requests: { deep: 4, strict: 6 }
    repair_requests: same_as_execution_at_next_tier
  failure:
    max_quality_retries: 1
    on_insufficient_evidence: needs_supervisor
    on_verification_budget_exhausted: verification_pending
  strict_acceptor: supervisor   # or human
  audit_sample_rate: 0          # V3; e.g. 0.05
```

Merge rules:
- Level minimums take the strongest; checks combine as a union.
- Budgets stay within the task's total cap.
- Task-level `verification` can only raise.
- Nothing in a worker's output can lower the policy. A rule matched on the result can only
  raise.

The keys above are proposed; V1 settles the exact schema. The rules match existing rulebook tags
(`kind: refactor | migrate | ...`, `risk: security | data_migration | public_api_change | ...`).

### Acceptance contract (compiled once, after classification, before the first run)

Stored immutably in a new `task_contracts` table (task id, contract json, sha256, created_at;
new migration) and referenced by results and verdicts. It contains:
- goal;
- criteria with ids and `verify` kinds;
- scope (allowed paths, writable repo) and base commits;
- effective importance, with the floor that set it;
- the verification level and the rules matched;
- required checks;
- the budget allocation `{ classification, execution, review, repair }`;
- the rulebook and policy fingerprints.

Re-evaluating the result never edits the contract. It appends a `verification_raised` event and
records the raised level on the verification record.

### Verification phase (executor, after the runner returns)

1. **Re-evaluate on the actual result.** Changed paths, protected-path edits, and scope go
   against the rules; the level and importance can only rise.
2. **Basic.** The checks that exist today, refactored into named check functions under
   `src/verification/`.
3. **Standard.** Every declared check runs on the submitted revision. A check record gains
   `revision` (commit sha) and `artifactDigest`; a result changed after checks invalidates
   them.
4. **Deep and Strict review.**
   - A reviewer child session (role `reviewer`) runs in a fresh context with the contract, the
     base, the patch or artifact, the check logs, and read access to the repository within
     scope. The worker's summary is supporting material, labelled as the author's claim.
   - **Routing:** the `review` profile at the contract's review floor. It excludes every
     endpoint that served the task (new `avoidEndpoints` in route requirements) and prefers a
     different provider family. Reviewer qualification is required when the level says so.
   - **Gates:** modality and context gates apply. A reviewer that cannot see required evidence
     returns `inconclusive` with a reason.
   - **Verdict:** submitted through a `submit_verdict` terminal tool, validated with zod:
     `{ verdict: pass|fail|inconclusive, examinedRevision, policyVersion, criteria: [{ id,
     outcome, evidenceRefs, reason? }], blockingFindings, missingEvidence, recommendedAction:
     accept|repair|run_targeted_check|needs_supervisor, score? }`. A score is recorded but never
     overrides a failed criterion.
5. **Decide:**
   - All mandatory items pass -> `met`.
   - A concrete defect with quality retries left -> one repair at the next tier. The repair gets
     the verdict findings, the failing check logs, and (coding) starts from the submitted
     revision rather than a fresh base. The repaired revision is verified again.
   - Missing evidence that a targeted check can supply within budget -> run it once.
   - Otherwise -> `needs_supervisor`.
   - Strict -> `needs_supervisor` even when everything passed, until accepted.

**States.**
- `verificationStatus`: `not_required | pending | passed | failed | inconclusive | skipped_budget`.
- `acceptanceStatus` gains `needs_supervisor`. `met` now means the contract's policy was
  satisfied, which is stronger than today's meaning for coding only in that a required review
  must also pass.

**Failure types.**
- A provider or quota failure in review follows availability routing and never raises
  difficulty.
- A check that cannot run (command not found, timeout, environment error) records an
  `environment_failure` and does not count as a defect.
- If the verification budget is exhausted, the result is kept as `verification_pending`.

**Budget.**
- The allocation is reserved at contract time. The agent loop's remaining count excludes the
  review and repair reserves.
- If the total cap cannot hold the required verification, the task is rejected at submission
  with `verification_budget_insufficient`. The level is never lowered to fit.
- New purposes `verification` and `repair` label requests.

### Downstream consumers

- **Dependency gate:** `not_verified` and `needs_supervisor` pass only when the dependent's
  contract does not require the upstream result to be accepted. In V1 they pass as today, plus
  a recorded warning; T1 tightens this.
- **`integrate_task`:** refuses `unmet`. It requires `accept: true` with a reason for
  `not_verified` / `needs_supervisor`. It uses structured `scopeViolation` /
  `protectedPathsChanged` result fields instead of finding-text prefixes.
- **New acceptance tools:** supervisor tools `accept_task` and `reject_task` (with reason), MCP
  `accept_result` and `reject_result`, and the matching CLI and panel actions. Each records
  who accepted.

### Code placement

- New area `packages/router/src/verification/`:
  - `importance.ts`: floors and effective importance.
  - `policy.ts`: the config bundle, merge, and fingerprint.
  - `contract.ts`: compile and store.
  - `checks.ts`: the named deterministic checks.
  - `review.ts`: reviewer session and verdict tool.
  - `decide.ts`: acceptance rules.
- Executor integration in `core/executor.ts`.
- Schema in `config/schema.ts`.
- Migration appended.
- Add the area to AGENTS.md's area list.

### Qualification for reviewers

- New eval family `review` in `evals/suite.json`. Each eval gives a contract plus an artifact
  and has an expected verdict, in four kinds:
  - correct work that should pass;
  - plausible work with a real defect;
  - work that cannot be verified from the evidence (expected `inconclusive`);
  - acceptable work in a non-preferred style (must not fail).
- Graded on per-criterion outcomes. An approve-everything model fails the defect and
  inconclusive kinds.
- `review_strict` is a higher pass threshold on the same family, and harder evals at T3.
- `verification.reviewer_qualification: preferred | required` (default `preferred`, supervisor
  decision 2026-10-19, so Deep stays automated): qualified reviewers are chosen first. Without
  one, Deep uses a reviewer at the size floor and the verdict is marked
  `reviewer_unqualified`, which calibration tracks separately. Strict always requires a
  `review_strict`-qualified reviewer; without one it ends `inconclusive` -> `needs_supervisor`,
  and the supervisor accepts automatically per the user's decision.

### Panel and metrics

- **Task detail:** importance (with reason and source), contract, verification record (checks
  with revisions, verdict per criterion, reviewer model), and acceptance actions.
- **Usage by purpose:** classification, execution, verification, and repair, per task and
  overall.
- **V3 calibration page:**
  - verified vs subsequently confirmed (accepted by the supervisor, job checks passing, not
    undone);
  - false approvals (accepted, then undone or failing later job checks);
  - false rejections (reviewer fail overturned by the supervisor);
  - inconclusive rate;
  - verification cost per accepted task, per reviewer model.

---

## Phases

| Phase | Deliverable | Acceptance |
| --- | --- | --- |
| V1 | Importance fields and floors; criterion ids; `verification` config with fingerprint; contract compiled and stored; budget allocation and reservation; result re-evaluation; named deterministic checks bound to revisions; `verificationStatus`, `needs_supervisor`; acceptance tools (supervisor, MCP, CLI, panel); `integrate_task` gate; escalation retry gets failure context; classifier at measured T3; docs | Tests: matrix and floors pick the expected level; a diff touching a critical path raises the level after the fact; a worker cannot lower it; checks invalidated by a later revision; insufficient budget rejects at submit; strict ends `needs_supervisor` until accepted |
| V2 | Reviewer phase in a child session; `avoidEndpoints`; `submit_verdict`; decision rules; one bounded repair from the submitted revision; failure types; `review` eval family and reviewer qualification; usage by purpose | Fake-gateway tests: deep review passes a correct patch, fails a seeded defect and triggers one repair, returns inconclusive without evidence; the author's endpoint is never the reviewer; total requests never exceed the contract allocation |
| V3 | Audit sampling, verdict calibration records, undo as escaped-defect signal, cached verdicts, calibration panel | Panel shows verified vs confirmed per reviewer; a seeded undo counts as a false approval |

Recommended order with the other plan: S2 (resume) -> V1 -> V2 -> R1 -> T1 -> T2 (without its
review bullet, replaced by V2) -> V3 with T3. Reason: V1 changes task persistence, results, and
budgets that teams build on, and S2's resume protocol must also resume a task that is mid-review.

---

## Worker Briefs

Branch/worktree: `feat/v1-verification` at `D:/sy-wt/v1`. Workers never commit.

### Brief: v1-core
- Task: the V1 library per Design.
  - `core/task.ts`: `importance`, `importanceReason`, criteria as strings or
    `{id,text,verify,checks}` normalised to ids by a `criteria(spec)` helper,
    `verification.atLeast/addChecks`; `WorkerResult` gains `verificationStatus`, a
    `verification` record, structured `scopeViolation` / `protectedPathsChanged`, check
    `revision` / `artifactDigest`; `acceptanceStatus` gains `needs_supervisor`.
  - `config/schema.ts`: the `verification` section, defaults equal to the Design YAML, with
    `strict_acceptor: supervisor | human` (default supervisor).
  - `src/verification/`: `importance.ts` (floors, effective importance with its source),
    `policy.ts` (bundles, `extends`, merge, matrix, rules matched on the spec and on a result's
    changed paths / protected-path flag, fingerprint), `contract.ts` (compile from spec +
    classification + budget, including the budget allocation; `ContractStore` save/get with
    sha256; appended migration `task_contracts`), `checks.ts` (named deterministic checks
    over a result: output_contract, evidence_provenance, scope, protected_paths,
    declared_checks, criterion_evidence), `decide.ts` (V1 deterministic decision ->
    verificationStatus + acceptanceStatus).
- Required reads: this Current State and Design; `core/task.ts`, `core/worker-output.ts`,
  `runners/coding/finish.ts`, `scoring/rulebook.ts`, `admission/admission.ts`,
  `config/schema.ts`, `storage/migrations.ts` (tail).
- Owns: `src/verification/**`, `src/core/task.ts`, `src/config/schema.ts` (verification
  section; R1 adds a storage key on another branch), `src/storage/migrations.ts` (append),
  `tests/verification.test.ts`, minimal compile fixes elsewhere (list them in the report).
- Definition of done: tests for the matrix, floors, rules raising on a result, a worker unable
  to lower the level, merge semantics, contract immutability and digest, budget allocation
  and `verification_budget_insufficient`; typecheck and all tests pass.
- Report to: docs/working/importance-and-verification/reports/v1-core.md

### Brief: v1-exec (after v1-core)
- Task: the executor compiles and stores the contract after classification and reserves the
  allocation (the loop's remaining count excludes review/repair reserves), runs
  checks/decide after the runner, and re-evaluates on the result. Coding `finish.ts` binds
  checks to the revision and sets the structured flags and per-criterion status. The
  escalation retry gets the failure context (findings, unresolved criteria, failing check
  logs). Dependency gate per Design. `integrate_task` gate. Supervisor tools `accept_task` /
  `reject_task`; strict acceptance is judged against the job's goal and the specifications
  given to the supervisor (charter and tool description). `delegate` takes importance.
  `Switchyard.acceptTask(id, {by, reason})` / `rejectTask` in `service.ts`. The classifier
  runs at a measured T3 when tags could still reach T4 or reject (`score.ts`).
- Owns: `src/core/**` except task.ts, `src/runners/**`, `src/harness/**`, `src/scoring/**`,
  `src/admission/**`, `src/storage/tasks.ts`, `charters/**`, `tests/verification-flow.test.ts`.
- Report to: docs/working/importance-and-verification/reports/v1-exec.md

### Brief: v1-surface (after v1-exec)
- Task: MCP `submit_tasks` importance/criteria fields, `accept_result` / `reject_result`; CLI
  `accept` / `reject` and importance flags on submit; insights `taskDetail` gains the contract
  and verification; the panel task detail shows importance, contract, verification record,
  and accept/reject actions.
- Owns: `src/cli.ts`, `src/mcp.ts`, `src/admin/insights.ts`, `apps/panel/**`, related tests.
- Report to: docs/working/importance-and-verification/reports/v1-surface.md

### Brief: v2-review (same branch, after v1-exec; parallel with v1-surface)
- Task: the Deep/Strict reviewer phase per Design "Verification phase" step 4 and "Decide".
  - `src/verification/review.ts`: build the evidence package (contract, base, patch or
    artifact, check logs, author's summary labelled as a claim); run a reviewer child session
    (role `reviewer`, read-only repository tools within scope) charged to the task under purpose
    `verification`; a `submit_verdict` terminal tool validated with zod (shape in Design).
  - Routing: `avoidEndpoints` in route requirements (every endpoint that served the task);
    prefer another provider family; `verification.reviewer_qualification: preferred |
    required` per "Qualification for reviewers"; review floor from the level.
  - Decision: pass -> `met`; a concrete defect -> one repair at the next tier (purpose
    `repair`) starting from the submitted revision with the verdict findings, then re-review;
    `run_targeted_check` once when budget allows; otherwise `needs_supervisor`. Failure types
    per Design. Never exceed the contract allocation.
  - Qualification: `review` eval family in `evals/suite.json` (four kinds per Design, at T1-T3)
    graded on per-criterion outcomes; `review_strict` threshold.
- Owns: `src/verification/review.ts` and `decide.ts`, `src/routing/**`, `src/qualification/**`,
  `evals/**`, `src/core/executor.ts`, `src/harness/**`, `charters/reviewer.md`,
  `tests/verification-review.test.ts`.
- Report to: docs/working/importance-and-verification/reports/v2-review.md

### Brief: v-merge (integrate dev into feat/v1-verification)
- Repository: worktree `D:/sy-wt/v1`, merge of `dev` (S2 resume, R1 ops, R1b) in progress with
  conflicts in cli.ts, executor.ts, select.ts, coding/finish.ts, coding/index.ts,
  runners/types.ts, tests/mcp.test.ts.
- Task: resolve keeping both behaviours, and make resume and verification compose: when a
  task is interrupted during its verification phase, the next run resumes the author's session
  (not the reviewer's): S2 finishes an already-accepted submission without a model request and
  verification re-runs on the submitted revision; an interrupted reviewer session is ended as
  superseded and a new linked reviewer session runs; review requests already spent still count
  against the allocation. A repair session resumes like any author session. The watchdog
  (R1b) must also cover reviewer sessions. Add a fault-injection test: crash mid-review, restart,
  verification completes once with no duplicated repair.
- Owns: every conflicted file plus `src/core/**`, `src/verification/**`, `src/harness/**`,
  `src/runners/**`, `tests/**` as needed for the merge.
- Definition of done: merge committed-ready (no conflict markers), build, `pnpm -r typecheck`,
  and the full suite pass; panel builds.
- Report to: docs/working/importance-and-verification/reports/v-merge.md

### Brief: v3-calibration (after V2 is on dev)
- Task: audit sampling (`audit_sample_rate`, background reviews with purpose `audit` that never
  block acceptance); a calibration record per verdict (reviewer endpoint, level, verdict,
  qualified or not); confirmation signals (supervisor accepted, integrated, job checks passed,
  later undone through attribution = escaped defect, reviewer fail overturned = false
  rejection); cached verdicts keyed by contract digest, artifact digest, policy fingerprint,
  and source revisions; usage by purpose in insights; a panel Calibration page.
- Also: make the `criterion_evidence` check row reflect a criterion a review passed.
- Owns: `src/verification/calibration.ts`, `src/verification/checks.ts`, `src/attribution/**` (undo hook only),
  `src/admin/insights.ts`, `apps/panel/**`, a migration, `tests/verification-calibration.test.ts`.
- Report to: docs/working/importance-and-verification/reports/v3-calibration.md

---

## Work Ledger

### 2026-10-19 — Plan written from the consultant's proposal
- Agent: supervisor (two read-only surveys of acceptance, budgets, scoring, qualification)
- Changed: this document; `docs/working/README.md`; pairing note in `agent-sessions-and-teams.md`.
- Why: user asked to add importance-driven verification to the plan, adjusted to this codebase.
- Validation: not validated (design only). Code facts above come from the surveys (file:line
  references in the session) and spot checks.
- Outcome: Accepted
- Follow-up: user answers the open questions; then V1.

---

### 2026-10-19 — V1 and V2 implemented and merged
- Agent: supervisor; workers v1-core, v1-exec, v1-surface, v2-review, v-merge, v-finish
  (`feat/v1-verification`)
- Changed: `src/verification/**` (new area), task schema, config `verification`, migration
  `task_contracts`, executor, admission, routing (`avoidEndpoints`, family preference),
  qualification (`review` family), coding finish, supervisor tools and charters, CLI, MCP,
  insights, panel, `AGENTS.md` area list; docs `operations.md` (Verification), `decisions.md` (16).
- Why: user asked for importance-driven verification, executed with workers.
- Validation: per worker reports; supervisor re-ran on the branch after each step (143, 156, 178,
  242 tests passing), inspected review screenshots; supervisor fixed retry scoring (interruptions
  are not failures) and confirmed the session-fault hints are needed (those tasks classify T3 on
  the first run and single-endpoint tests have no independent reviewer). Merged dev: see the
  agent-sessions ledger for the combined run.
- Outcome: Accepted
- Follow-up: V3; criterion_evidence display mismatch.

---

### 2026-10-19 — V3 calibration
- Agent: supervisor; worker v3-calibration (`feat/v3-calibration`)
- Changed: `src/verification/{calibration,audit}.ts`, `checks.ts`, `phase.ts`, attribution undo
  hook, supervisor tools (integration and job-check signals), service (audit sweep),
  `admin/calibration.ts`, migration, config keys, panel Calibration page, demo seed; docs
  `operations.md` (Calibration).
- Why: phase V3.
- Validation: branch: typecheck Done, 250 tests passed (supervisor re-ran), panel built; the
  supervisor saw a page-level horizontal overflow in the screenshots, sent it back; fixed (shared
  HelpTip popover; root fix assigned to t1-surface) and re-verified scrollWidth === clientWidth
  at 1400/1024/800/420 by the worker; supervisor inspected the 800 px screenshot.
- Outcome: Accepted
- Follow-up: live-model validation.

---

## Open Questions

Resolved by the user 2026-10-19:
- Order S2 -> V1 -> V2 -> R1 -> T1 approved; execute every phase with workers.
- Strict acceptance is automated by the job's supervisor, judged against the job's goal and the
  specifications given to the supervisor; `strict_acceptor: human` is an explicit opt-in override.
- Standard stays deterministic (supervisor default taken; the user asked what it meant and did
  not object).
- Worker qualification stays optional for live routing; only reviewers require qualification.
