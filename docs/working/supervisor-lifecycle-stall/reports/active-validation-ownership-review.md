# Independent active validation ownership review

Reviewer: repair_hydration_review
Date: 2026-10-25
Status: Final frozen source reviewed; independent16/16 passed; clear for integration
Scope: D:/SwitchYardRouter-active-validation; report only.

Read main Current State and written review/implementation briefs, changed supervisor-tools.ts/runners/supervisor.ts/roles.md and uniquely named tests. Inspected only directly relevant currentSupervisorAuthority and real service cancelTasks signature to verify synchronous atomicity.

No source blocker found. The tool validates current live persisted supervisor lease and direct child/project ownership, recursively checks same-project descendants, and blocks pending human-only or operator-approved running exact-generation actions. SQL binds task/owner/project/run/incarnation and live deadline/lease; terminal/stale/foreign actions do not acquire protection. A single IMMEDIATE transaction encloses every target preflight and synchronous real service cancellation, refusing mixed batches before any mutation and serializing against approval writes.

Unprotected tasks, supervisor-policy internal approval cleanup, quiesced actions and expired authority remain cancellable. External operator cancellation and runtime service paths are unchanged. await_tasks distinguishes approved running execution from pending approval; finish guidance requires waiting for active work rather than abandoning it. Tests include real mediated operator execution and actual supervisor finish/cancel loop, not only mocked statuses.

Awaiting worker final frozen16-case/typecheck/build receipt before independent focused execution. No source/runtime/config/provider edits or commits by reviewer.


## Final independent validation

Worker confirmed source frozen and typecheck/router build passed. Independently executed:

`pnpm exec vitest run tests/active-validation-ownership.test.ts`

Observed PASS:16/16,20.49seconds. Real pending approval and operator-approved running commands reject model cancellation; mixed batches leave siblings unchanged; descendant validation is protected; approval/cancel race retains execution; stale run/incarnation/foreign/terminal/expired cases do not falsely protect; supervisor-owned policy-approved work remains cancellable. External operator cancellation still quiesces the real command. Actual SupervisorRunner rejects cancel then premature blocked finish, waits for check exit0 and completes without cancelling.

No remaining blocker found. Clear for supervisor integration/broader validation. No source/test/runtime/provider changes or commits by reviewer. Broader four-file worker run remains separate from this independently observed16-case result.

## Final stale-running observation delta

Reviewed frozen82a8e0e currentActionGeneration helper and new display regression. It requires action task/project to match captured lease, then exact persisted running task owner/run/incarnation/project plus uncancelled and live lease/deadline. A persisted running row outside that authority now displays unresolved/operator reconciliation rather than execution in progress. This is observation only and does not mutate action/task or infer transport quiescence/success. Prior cancellation protection is unchanged.

Independently ran only the new regression:

`pnpm exec vitest run tests/active-validation-ownership.test.ts -t "distinguishes current running actions"`

PASS:1 passed,16skipped,11.20seconds. Current active action displays execution; five stale identity variants and expired deadline display unresolved, with action/task unchanged. No remaining blocker on final source. Prior independently observed16/16 remains the guard receipt; root separately reports final75/75 focused and ongoing full validation. No deployment/runtime/source changes by reviewer.
