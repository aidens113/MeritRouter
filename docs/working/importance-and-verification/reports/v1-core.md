# Report: v1-core

Worker report for "Brief: v1-core" in `docs/working/importance-and-verification.md`.
Worktree `D:/sy-wt/v1`, branch `feat/v1-verification`. Nothing was committed.

## Outcome

Done. I built the V1 verification library and its tests. Nothing calls it yet: wiring it into
the executor, runners, and tools is v1-exec's job. Typecheck passes. All 143 router tests pass
(122 existing plus 21 new).

## What changed and why

### Owned files

- `packages/router/src/config/schema.ts`
  - New exports:
    - `IMPORTANCE_LEVELS`, `ImportanceSchema`, `Importance`.
    - `VERIFICATION_LEVELS`, `VerificationLevelSchema`, `VerificationLevel`.
    - `CheckNameSchema`, `VerificationMatchSchema`, `VerificationMatch`.
    - `VerificationLevelBundle`, `VerificationFloor`, `VerificationRule`.
    - `levelChain()`, `VerificationConfigSchema`, `VerificationConfig`.
  - New config section `verification` (`ConfigSchema.verification`, prefaulted). Its defaults
    equal the Design YAML.
  - Additions to the Design YAML:
    - `inherit_parent_importance` (default true).
    - Floors carry an `id`, so the source that set an importance can be named.
  - Validation:
    - an `extends` cycle is rejected;
    - every level that requires review must have `budget.review_requests[level] >= 1`;
    - floor and rule ids must be unique;
    - every rule condition needs at least one key;
    - every rule needs at least one effect.
  - `schema.ts` now imports `TAG_GROUPS` from `scoring/rulebook.ts` (no cycle: the rulebook
    imports only `core/errors`). The R1 storage key goes elsewhere in `ConfigSchema`; the
    `verification` key sits between `coding` and `panel`.
- `packages/router/src/core/task.ts`
  - `WorkerTask`:
    - `importance?` and `importanceReason?` (the reason is required for high and critical,
      enforced by `superRefine`).
    - `verification?: { atLeast?, addChecks? }`.
    - `constraints.acceptanceCriteria` now takes strings or
      `{ id, text, verify?: "check"|"review"|"evidence", checks?: string[] }`.
  - `superRefine` rules for criteria:
    - Ids must be unique after normalisation (string i -> `c{i+1}`).
    - A criterion's `checks` must appear in `constraints.checks`.
    - `verify: "check"` needs declared checks.
    - `checks` with a non-check `verify` is rejected.
  - Helpers: `autoCriterionId`, `criteria(spec)`, `criterionTexts(spec)`, and the
    `Criterion` interface.
  - `WorkerResult`:
    - `acceptanceStatus` gains `needs_supervisor`.
    - New optional fields: `verificationStatus`, `verification` (a `VerificationRecord`),
      `changedPaths`, `scopeViolation` (paths outside `allowedPaths`), and
      `protectedPathsChanged` (paths). All are optional so stored results still parse.
    - Check records gain optional `revision` (`string|null`) and `artifactDigest`.
  - New enums and schemas: `ACCEPTANCE_STATUSES`, `VERIFICATION_STATUSES`, `CHECK_OUTCOMES`,
    `CRITERION_OUTCOMES`, `SupervisorDecisionSchema`, `VerificationRecordSchema`, plus their
    types.
- `packages/router/src/storage/migrations.ts`: appended a migration that creates
  `task_contracts`. Its columns are `task_id` (PK, FK to `tasks`), `contract_json`, `sha256`,
  and `created_at`. A `BEFORE UPDATE` trigger aborts with "task contracts are immutable".
- New files in `packages/router/src/verification/`:
  - `match.ts`: rule conditions (`matchesWhen`, `declaredPaths`, `MatchFacts`).
  - `importance.ts`: floors and effective importance with its source.
  - `policy.ts`: level resolution, fingerprint, the matrix, rules, merging, and re-evaluation
    on a result.
  - `contract.ts`: the contract schema, budget allocation, compiling, the digest, and
    `ContractStore`.
  - `checks.ts`: the named deterministic checks.
  - `decide.ts`: the V1 decision, the verification record builder, and supervisor
    accept/reject.

  I split condition matching into `match.ts`, a file the Design does not list. Both
  `importance.ts` and `policy.ts` need it, and the split avoids an import cycle.
- `packages/router/tests/verification.test.ts`: 21 tests (listed under Commands).

### Minimal compile fixes elsewhere

Now that a criterion can be an object, every place that used `spec.constraints.acceptanceCriteria`
as `string[]` calls `criterionTexts(spec)` instead. For string criteria the behaviour is
unchanged. Each file got one import, either merged into its existing `../core/task.js` import
or added as a new import line:

- `src/core/executor.ts` (2 sites)
- `src/harness/worker.ts` (1)
- `src/runners/batch.ts` (5)
- `src/runners/coding/finish.ts` (1)
- `src/runners/coding/index.ts` (2)
- `src/runners/completion.ts` (2)
- `src/runners/readonly.ts` (2)
- `src/runners/supervisor.ts` (3)
- `src/runners/prompts.ts` (1)
- `src/scoring/classifier.ts` (1)

The prompt and classifier sites would still have compiled after the type change, but an object
criterion would have rendered as "[object Object]", so I changed them too. `score.ts` uses only
`.length` and is unchanged. I did not edit `src/index.ts`: `export * from "./config/schema.js"`
already re-exports the new config enums, and the `verification/*` and new `task.ts` exports are
not yet exported from the package index (see Open questions).

## Exported API for v1-exec (ready to quote)

### core/task.ts

```ts
export const CRITERION_VERIFY_KINDS = ["check", "review", "evidence"] as const;
export type CriterionVerify = "check" | "review" | "evidence";
export const CRITERION_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
export const AcceptanceCriterionSchema; // { id, text, verify?, checks? } strict
export function autoCriterionId(index: number): string; // "c" + (index + 1)
export interface Criterion { id: string; text: string; verify: CriterionVerify; checks: string[] }
export function criteria(spec: Pick<WorkerTask, "constraints">): Criterion[];
export function criterionTexts(spec: Pick<WorkerTask, "constraints">): string[];
// WorkerTask additions
importance?: Importance; importanceReason?: string;
verification?: { atLeast?: VerificationLevel; addChecks?: string[] };
constraints.acceptanceCriteria: Array<string | { id: string; text: string; verify?: CriterionVerify; checks?: string[] }>;

export const ACCEPTANCE_STATUSES = ["met", "unmet", "not_verified", "needs_supervisor"] as const;
export type AcceptanceStatus;
export const VERIFICATION_STATUSES = ["not_required", "pending", "passed", "failed", "inconclusive", "skipped_budget"] as const;
export type VerificationStatus;
export const CHECK_OUTCOMES = ["passed", "failed", "not_applicable", "not_run", "stale", "environment_failure", "inconclusive", "unverified", "not_implemented"] as const;
export const CRITERION_OUTCOMES = ["passed", "failed", "claimed", "unknown", "not_run", "stale", "environment_failure", "pending_review"] as const;
export type SupervisorDecision = { decision: "accepted" | "rejected"; by: { kind: "supervisor" | "human"; id: string }; reason: string | null; at: number };
export type VerificationRecord = {
  level: VerificationLevel; raisedFrom: VerificationLevel | null; importance: Importance; importanceSource: string;
  rulesMatched: string[]; contractSha256: string | null; policyFingerprint: string;
  checks: Array<{ name: string; required: boolean; outcome: CheckOutcome; detail: string }>;
  criteria: Array<{ id: string; text: string; verify: CriterionVerify; outcome: CriterionOutcome; checks: string[]; evidenceRefs: string[]; note?: string }>;
  reasons: string[]; decisions: SupervisorDecision[];
};
// WorkerResult additions (all optional)
verificationStatus?: VerificationStatus; verification?: VerificationRecord;
changedPaths?: string[]; scopeViolation?: string[]; protectedPathsChanged?: string[];
checks[i].revision?: string | null; checks[i].artifactDigest?: string;
```

### verification/match.ts

```ts
export interface MatchFacts { profile: ProfileName; tags: Partial<Tags> | null; paths: string[]; protectedPathsChanged: boolean | null }
export function declaredPaths(spec: Pick<WorkerTask, "constraints" | "context">): string[]; // allowedPaths entries + fileRef paths
export function matchesWhen(when: VerificationMatch, facts: MatchFacts): boolean; // all keys AND, values within a key OR
```

### verification/importance.ts

```ts
export const IMPORTANCE_RANK: Readonly<Record<Importance, number>>;
export function strongerImportance(a: Importance, b: Importance): Importance;
export interface ImportanceSource { kind: "default" | "task" | "parent" | "floor" | "rule"; id: string | null; importance: Importance }
export interface EffectiveImportance { importance: Importance; requested: Importance; reason: string | null; source: ImportanceSource; considered: ImportanceSource[] }
export interface ImportanceInput { requested?: Importance | null; reason?: string | null; parent?: { taskId: string; importance: Importance } | null; facts: MatchFacts }
export function formatImportanceSource(s: ImportanceSource): string; // "task", "default", "floor:risk-critical", "parent:<id>", "rule:<id>"
export function effectiveImportance(policy: VerificationConfig, input: ImportanceInput): EffectiveImportance;
```

### verification/policy.ts

```ts
export const LEVEL_RANK: Readonly<Record<VerificationLevel, number>>;
export function strongerLevel(a: VerificationLevel, b: VerificationLevel): VerificationLevel;
export const BUILTIN_RULES = { criterionReview: "criterion-review", taskAtLeast: "task-at-least", taskAddChecks: "task-add-checks" } as const;
export interface ResolvedReview { required: boolean; qualification: string | null; minTotalParametersB: number | null; independent: boolean }
export interface ResolvedLevel { level: VerificationLevel; checks: string[]; review: ResolvedReview; acceptance: "automatic" | "supervisor" }
export function resolveLevel(policy: VerificationConfig, level: VerificationLevel): ResolvedLevel;
export function policyFingerprint(policy: VerificationConfig): string; // `${version}:${sha256(JSON).slice(0,8)}`
export interface PolicyInput {
  tier: TierName; profile: ProfileName; tags: Partial<Tags> | null; paths: string[]; protectedPathsChanged: boolean | null;
  criteria: Criterion[]; requestedImportance?: Importance | null; importanceReason?: string | null;
  parent?: { taskId: string; importance: Importance } | null; atLeast?: VerificationLevel | null; addChecks?: string[];
}
export interface PolicyEvaluation {
  importance: EffectiveImportance; matrixLevel: VerificationLevel; level: VerificationLevel; rulesMatched: string[];
  checks: string[]; review: ResolvedReview; acceptance: "automatic" | "supervisor"; fingerprint: string;
}
export function evaluatePolicy(policy: VerificationConfig, input: PolicyInput): PolicyEvaluation;
export interface ResultFacts { changedPaths: string[]; protectedPathsChanged: string[] }
export interface Reevaluation {
  level: VerificationLevel; raisedFrom: VerificationLevel | null; importance: Importance; importanceSource: string;
  rulesMatched: string[]; newRules: string[]; checks: string[]; review: ResolvedReview;
  acceptance: "automatic" | "supervisor"; raised: boolean; fingerprint: string;
}
export function reevaluateOnResult(policy: VerificationConfig, contract: AcceptanceContract, facts: ResultFacts): Reevaluation;
```

`reevaluateOnResult` reads only the contract's stored inputs and the actual changed paths and
protected paths. It never reads the worker's output. The level, importance, checks, review
requirement, and supervisor acceptance never drop below the contract's, even when the policy
has changed since the contract was compiled. When `raised` is true, the executor should append
the `verification_raised` event (with `raisedFrom` and `newRules`).

### verification/contract.ts

```ts
export const BudgetAllocationSchema; export type BudgetAllocation = { total; classification; execution; review; repair; unallocated }; // all ints
export const AcceptanceContractSchema; export type AcceptanceContract = {
  schemaVersion: 1; taskId: string; goal: string; profile: ProfileName; tier: TierName;
  criteria: Criterion[];
  scope: { repositoryAliases: string[]; writableRepository: string | null; allowedPaths: string[] | null; baseCommits: Record<string, string> };
  declaredChecks: string[]; hasOutputSchema: boolean;
  importance: { level: Importance; requested: Importance; reason: string | null; source: string; considered: string[] };
  verification: { level; matrixLevel; rulesMatched: string[]; requiredChecks: string[]; review: ResolvedReview;
                  acceptance: "automatic" | "supervisor"; strictAcceptor: "supervisor" | "human"; maxQualityRetries: number };
  inputs: { tags: Partial<Tags> | null; requestedImportance: Importance | null; parent: { taskId; importance } | null; atLeast: VerificationLevel | null; addChecks: string[] };
  budget: BudgetAllocation; fingerprints: { rulebook: string | null; policy: string }; createdAt: number;
};
export interface BudgetInput { total: number; tierExecution: number; nextTierExecution: number | null; classificationUsed: number }
export type AllocationResult = { ok: true; allocation: BudgetAllocation } | { ok: false; needed: number; available: number };
export function allocateBudget(policy: VerificationConfig, ev: Pick<PolicyEvaluation, "level" | "review">, b: BudgetInput): AllocationResult;
export interface CompileInput {
  taskId: string; spec: WorkerTask; tier: TierName; tags: Partial<Tags> | null; rulebookFingerprint: string | null;
  policy: VerificationConfig; budget: BudgetInput; parent?: { taskId: string; importance: Importance } | null; now: number;
}
export type CompileResult =
  | { ok: true; contract: AcceptanceContract; evaluation: PolicyEvaluation }
  | { ok: false; code: "verification_budget_insufficient"; message: string; needed: number; available: number; evaluation: PolicyEvaluation };
export function compileContract(input: CompileInput): CompileResult;
export function canonicalContractJson(contract: AcceptanceContract): string; // sorted keys
export function contractDigest(contract: AcceptanceContract): string; // sha256 hex of canonical JSON
export interface StoredContract { contract: AcceptanceContract; sha256: string; createdAt: number }
export class ContractStore {
  constructor(db: Db);
  save(contract: AcceptanceContract): { sha256: string; created: boolean }; // identical: created false; different: throws SwitchyardError("contract_immutable")
  get(taskId: string): StoredContract | null; // zod-validated; digest mismatch throws SwitchyardError("contract_corrupt")
}
```

`ContractStore.save` needs the task row to exist (FK to `tasks`), so call it after
`TaskStore.submit`.

### How the budget allocation is computed

`allocateBudget` works from the effective budget. The caller passes:

- `total = effectiveBudget(cfg, spec, null).maxModelRequests`: the task's cap across all tiers
  (min of the profile max, the per-task cap, and `spec.budget.maxModelRequests`, with no tier
  cap).
- `tierExecution = effectiveBudget(cfg, spec, tier).maxModelRequests`: the current run cap.
- `nextTierExecution`: the same value at the next tier, or null at T3.
- `classificationUsed`: requests already charged to the task, in practice
  `admission.taskTotals(id).requests` at compile time.

The allocation is then:

1. `review` = `policy.budget.review_requests[level]` when the resolved level requires review,
   otherwise 0. Deep reserves 4 and strict 6 by default.
2. If `classificationUsed + review + 1 > total`, the compile fails with
   `verification_budget_insufficient`. The `+1` is at least one execution request. The level is
   never lowered to make the budget fit.
3. `execution` = min(`tierExecution`, `total - classification - review`).
4. Per retry: `repair_requests` when it is a number. For `same_as_execution_at_next_tier`, it is
   `nextTierExecution`, falling back to `tierExecution` at T3.
5. `repair` = min(`max_quality_retries * perRetry`, `total - classification - review - execution`),
   floored at 0.
6. `unallocated` is whatever remains.

Execution therefore keeps today's tier cap unless review squeezes it, and repair takes what is
left.

Examples with the defaults (`max_model_requests_per_task` 16, T1 cap 4, T2 cap 8, T3 cap 12):

| Case | Classification | Execution | Review | Repair | Unallocated |
| --- | --- | --- | --- | --- | --- |
| T1 standard, after 1 classification request | 1 | 4 | 0 | 8 | 3 |
| T3 deep | 0 | 12 | 4 | 0 | 0 |
| Deep with a total of 4 | rejected: needed 5, available 4 | | | | |

Per the Design, the agent loop's cap should be `allocation.execution`. V2's review must stay
within `allocation.review`, and that includes re-review after a repair.

### verification/checks.ts

```ts
export const NAMED_CHECKS = ["output_contract", "evidence_provenance", "scope", "protected_paths", "declared_checks", "criterion_evidence"] as const;
export interface SelfReportEntry { id: string; status: "met" | "unmet" | "unknown"; evidenceRefs: string[]; note?: string }
export type CheckRecord = WorkerResult["checks"][number];
export type CheckedResult = Pick<WorkerResult, "executionStatus" | "stopReason" | "findings" | "checks" | "unresolvedCriteria" | "artifactRefs" | "patchRefs">
  & Partial<Pick<WorkerResult, "data" | "changedPaths" | "scopeViolation" | "protectedPathsChanged">>;
export interface CheckSubject {
  contract: AcceptanceContract; mode: ProfileMode; requiredChecks?: string[]; result: CheckedResult;
  revision: string | null; artifactDigest?: string | null; universe?: EvidenceUniverse | null; selfReport?: SelfReportEntry[] | null;
}
export interface NamedCheckResult { name: string; required: boolean; outcome: CheckOutcome; detail: string }
export interface CriterionResult { id: string; text: string; verify: CriterionVerify; outcome: CriterionOutcome; checks: string[]; evidenceRefs: string[]; note?: string }
export interface CheckReport { checks: NamedCheckResult[]; criteria: CriterionResult[] }
export function selfReportFromOutput(output: Pick<WorkerOutput, "criteria">, contract: Pick<AcceptanceContract, "criteria">): SelfReportEntry[]; // index -> id
export type CheckRunOutcome = "passed" | "failed" | "stale" | "environment_failure" | "not_run";
export function checkRunOutcome(command: string, records: CheckRecord[], revision: string | null, artifactDigest?: string | null): { outcome: CheckRunOutcome; record: CheckRecord | null };
export function runNamedChecks(s: CheckSubject): CheckReport;
```

Check semantics:

- `runNamedChecks` always runs every named check and marks each as required or not
  (`requiredChecks` from the re-evaluation, or the contract's).
- A required name that is not implemented (for example `evaluator_change_review`, added by the
  default `evaluator-changes` rule) gets the outcome `not_implemented`.
- The latest record for a command decides. Its outcome is:
  - stale when it is bound to a revision other than the submitted one, or when it has no
    revision but the subject has one, and likewise for `artifactDigest` when one is given;
  - `environment_failure` for exit code null (killed or timeout), 126, 127, or 9009;
  - otherwise failed for any non-zero exit.
- Coding results need `changedPaths`, `scopeViolation`, and `protectedPathsChanged` on the
  result. Without them, `output_contract`, `scope`, and `protected_paths` report `not_run`.
  `protected_paths` with changes is `inconclusive`, not failed, which matches today's
  not_verified behaviour.
- Criteria by `verify` kind:
  - check: the outcome comes from the declared checks only.
  - evidence: a self-reported met with evidence becomes `claimed`; unknown stays `unknown`; a
    self-reported unmet is `failed`.
  - review: `pending_review` until a verdict arrives.
  - With no self-report, criteria listed in `unresolvedCriteria` are unknown and the rest are
    claimed.

### verification/decide.ts

```ts
export interface ReviewOutcome { verdict: "pass" | "fail" | "inconclusive"; criteria?: Array<{ id: string; outcome: "pass" | "fail" | "inconclusive"; reason?: string }>; reason?: string }
export interface EffectiveLevel { level: VerificationLevel; review: ResolvedReview; acceptance: "automatic" | "supervisor" } // a Reevaluation satisfies it
export interface DecideInput {
  policy: Pick<VerificationConfig, "failure">; contract: Pick<AcceptanceContract, "verification">; effective?: EffectiveLevel;
  executionStatus: ExecutionStatus; report: CheckReport; review?: ReviewOutcome | null;
  verificationBudgetExhausted?: boolean; qualityRetriesUsed?: number;
}
export interface Decision {
  verificationStatus: VerificationStatus; acceptanceStatus: AcceptanceStatus;
  action: "accept" | "repair" | "await_supervisor" | "none";
  criteria: CriterionResult[]; unresolvedCriterionIds: string[]; reasons: string[];
}
export function decide(input: DecideInput): Decision;
export function verificationRecord(args: { contract: AcceptanceContract; contractSha256: string | null; reevaluation?: Reevaluation | null; report: CheckReport; decision: Decision; decisions?: SupervisorDecision[] }): VerificationRecord;
export interface SupervisorDecisionInput { decision: "accept" | "reject"; by: { kind: "supervisor" | "human"; id: string }; reason?: string | null; at: number }
export type SupervisorDecisionResult =
  | { ok: true; acceptanceStatus: AcceptanceStatus; record: SupervisorDecision }
  | { ok: false; code: "reason_required" | "cannot_accept_unmet" | "human_acceptance_required"; message: string };
export function applySupervisorDecision(current: { acceptanceStatus: AcceptanceStatus }, contract: Pick<AcceptanceContract, "verification"> | null, d: SupervisorDecisionInput): SupervisorDecisionResult;
```

`decide` checks these in order; the first that applies decides:

1. Execution did not complete: failed/unmet if there is a defect, otherwise
   inconclusive/not_verified.
2. Defect: any failed check, any failed criterion, or a failing review. Gives failed/unmet,
   with `action: "repair"` while `contract.verification.maxQualityRetries - qualityRetriesUsed`
   is above 0.
3. Review required but not run: pending/needs_supervisor, or skipped_budget/needs_supervisor
   when the review budget ran out.
4. Review inconclusive: inconclusive/needs_supervisor.
5. A required check is `not_run`, `stale`, `environment_failure`, `inconclusive`, or
   `not_implemented`: inconclusive, with `failure.on_insufficient_evidence` (needs_supervisor by
   default).
6. Strict (acceptance supervisor): passed/needs_supervisor.
7. Some criteria are only claimed or unknown: passed/not_verified. This is today's read-only
   behaviour.
8. Otherwise: passed/met, `action: "accept"`.

A review pass marks review and evidence criteria as passed. It never overrides a check-verified
criterion or a failure. `verificationStatus: "not_required"` is never produced by `decide`; it is
for results with no contract (for example supervisor jobs), at v1-exec's discretion.

## Commands run and observed results

- `npx tsc --noEmit -p .` (packages/router): the first run showed the expected `string[]`
  errors at the criteria call sites plus readonly-default errors in `schema.ts`. After the fixes
  it printed nothing (clean).
- `pnpm -r typecheck` (from `D:/sy-wt/v1`): `packages/router typecheck: Done` and
  `apps/panel typecheck: Done`.
- `pnpm --filter switchyard-router build`: `tsc -p tsconfig.build.json` finished without errors
  (dist refreshed for the MCP test).
- `cd packages/router && npx vitest run tests/verification.test.ts`: 21 passed.
- `cd packages/router && npx vitest run tests`: Test Files 17 passed (17), Tests 143 passed (143).

The new tests in `tests/verification.test.ts`:

- Config defaults equal the Design, and the fingerprint changes with the policy.
- Config rejects extends cycles, levels with no review reserve, duplicate ids, and empty
  conditions.
- Plain-string criteria still validate and get ids c1..cn.
- Criterion objects are accepted, and ids, checks, and importance reasons are validated.
- The matrix picks the expected level.
- Floors are applied with the strongest winning, and the parent is a floor.
- Rules raise the level, checks combine as a union, and `atLeast` only raises.
- A diff touching a critical path raises the level after the fact.
- A worker cannot lower the level, even under a policy weakened since compile.
- Budget allocation produces the expected numbers.
- `verification_budget_insufficient` is returned at compile without lowering the level.
- Contract fields are compiled as expected.
- Contract immutability: an identical save is idempotent, a different contract is refused, the
  SQL UPDATE trigger fires, and the digest is canonical.
- A coding result with every check passing is met.
- Checks bound to an old revision are stale and send the result to needs_supervisor.
- A failed check triggers a repair while retries remain; exit 127 is an environment failure;
  scope violations and no changes are defects.
- For read-only results, claims give not_verified, a self-reported unmet gives unmet, and bad
  provenance fails.
- Deep waits for review: skipped_budget, inconclusive, and a pass with criteria all behave as
  specified, and a review never overrides a failed check.
- A required unimplemented check never passes.
- Strict ends needs_supervisor until accepted: a reason is required, the human acceptor is
  enforced, unmet cannot be accepted, and reject gives unmet.
- Legacy results still parse, and the new result fields are accepted.

## Not verified

- No integration: nothing in the executor, runners, or tools calls the library yet, so I have
  not checked end-to-end behaviour such as escalation, loop caps, or `verification_raised`
  events (v1-exec).
- The panel only typechecks. I made no panel changes and did not build it.
- Behaviour on a database that already has the earlier migrations applied (an upgrade path) is
  only covered by the tests opening fresh temp databases. The migration is append-only, so an
  upgrade should be safe.
- `declaredPaths` matches a declared glob literally against a rule glob. A rule on
  `src/auth/**` does not fire before dispatch for a declared `src/**`; it fires on the result.

## Open questions or contradictions found

1. `unresolvedCriteria` is still a list of criterion texts. The Design says "becomes ids, with
   the text kept for display". Changing it would break current consumers and stored results.
   Ids are available instead as `Decision.unresolvedCriterionIds` and `verification.criteria[].id`.
   v1-exec or the supervisor should choose whether to switch `unresolvedCriteria` to ids, or to
   add `unresolvedCriterionIds` to the result.
2. Once wired, the default matrix changes behaviour:
   - T3 tasks (deep) and any task touching protected paths (the `evaluator-changes` rule) end
     needs_supervisor in V1, because no reviewer exists until V2.
   - A protected-path change also adds `evaluator_change_review`, which V1 reports as
     `not_implemented`.
   - Existing tests that expect `met` or `not_verified` for T3 or protected-path tasks may need
     updating when v1-exec wires `decide`.
3. String criteria are check-verified by every declared check when the task declares checks.
   This keeps today's all-or-none coding acceptance; the Design lists this flattening as a gap.
   Object criteria give per-criterion verification.
4. `src/index.ts` (not owned) does not export the `verification/*` API or the new `task.ts`
   helpers. v1-exec or v1-surface should add the exports the panel and MCP need.
5. The Design names the budget-exhaustion outcome `verification_pending`. I map it to
   `verificationStatus: "skipped_budget"` with `acceptanceStatus: "needs_supervisor"`; the
   config key keeps the Design's value.
