# Report: integration-failure-repair

## Outcome

Done within brief, pending supervisor acceptance. Framework-only repair; no downstream application source authored.

## What changed and why

- `storage/integration-obligations.ts`: failed/conflicted/refused/redelegated accepted upstreams remain dependency blockers. Fifteen minutes is an attention threshold, never permission to dispatch. Delivery obligations follow actual same-job/repository replacement merge receipts, with cycle protection; a failed replacement does not discharge the original accepted work.
- `storage/tasks.ts`: prolonged waits record one event and remain blocked instead of queuing a dependent.
- `runners/supervisor.ts`: recomputes active children after finish-time integration, so a conflict-created replacement prevents terminal completion.
- `harness/integration-tools.ts`: explains unresolved replacement obligations.
- `harness/supervisor-tools.ts`: await diagnostics name the original and replacement and instruct cancellation/re-delegation of old dependent briefs against the replacement. Raw original standing is retained, so this condition returns to the model promptly.
- `tests/job-auto-integration.test.ts`: six failing regressions before repair; successful real-Git A-then-B integration retained. Failure cases cover timeout, conflict/refused/failed/redelegated, failed replacement and finish creating a child.
- `docs/operations.md`: documents automatic integration, blocking and explicit dependent repair.

## Validation

- Before runtime edits: `pnpm exec vitest run tests/job-auto-integration.test.ts --maxWorkers=1` -> **6 failed / 2 passed**, 49.74s. Finish returned `supervisor_completed`; timeout and four failure states ran dependents instead of keeping them waiting.
- First repair: same command -> **8 passed**, 48.75s.
- Final safety refinement (original dependencies never claim replacement source): same command -> **8 passed**, 49.01s.
- `git diff --check` -> exit 0 (existing CRLF normalization warnings only).

## Limits and tradeoff

No context/upstream source binding was changed. When an integration is re-delegated, already-dispatched dependents still name the original source and remain blocked even after the redo integrates. The supervisor must cancel and re-delegate those dependents with the replacement task as dependency. This is a supported router workflow and avoids fabricating an original integration event/receipt or silently reading stale source. Fresh dependents on the replacement pass the dependency gate; existing real-Git successful integration verifies receipt-driven selection of the actual integrated head. A full real-Git conflict-to-redo-to-dependent journey was not run in this bounded repair.

No providers, runtime config/data, application projects, commits or pushes touched. Supervisor owns wider validation, build, deployment and pilot acceptance.
