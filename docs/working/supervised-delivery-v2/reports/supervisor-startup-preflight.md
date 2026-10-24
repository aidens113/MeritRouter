# Supervisor startup preflight

Status: Done
Date: 2026-10-23

## Findings and change

`startJob` called `submitTasks` without route validation. Supervisor route blockers
were discovered only after the scheduler claimed the persisted task. Direct supervise
submissions had the same problem.

`core/service.ts` now checks every newly submitted supervisor route within the atomic
submission transaction, using the same T3 profile, forced endpoint, supervisor endpoint
overrides, paid policy, input modalities and web hint as `TaskRouter.prepare`. If no
candidate exists, a `MeritRouterError` carries the route's stable blocker code plus
actionable configuration guidance and endpoint exclusion reasons. The transaction rolls
back the entire batch, so no doomed task remains or scheduler kick occurs. Existing
idempotent task replays remain readable even after routing policy changes.

No qualification defaults, provider policy, live configuration or runtime data changed.
Preflight is a configuration/eligibility check, not a promise of provider availability;
ordinary Gate admission and dispatch checks still apply at runtime.

## Validation

`pnpm exec vitest run tests/supervisor-startup.test.ts --maxWorkers=1 --minWorkers=1`
from `packages/router`: 4/4 passed, 4.43 seconds. Temporary fixtures only; fake provider
recorded zero requests. Covers strict typed/no-task refusal, direct submission and
atomic mixed-batch rollback, usable empty-evidence default submission and idempotency
after policy change, and actionable missing-tool capability exclusions.

Initial test runs exposed two fixture mistakes (wrong schema field and missing task
acceptance criteria); both were corrected before the passing run. No production
behavior was relaxed for those failures.

Not run: full repository suite/typecheck/build, live provider calls, production panel
acceptance. Supervisor owns integration verification. No commits or pushes performed.
