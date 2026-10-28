# Report: integration-review

## Outcome

Blocked: read-only review found two integration-enforcement gaps that should be resolved before treating the new pilot as proof of unattended delivery.

## What changed and why

Only this report was added. Reviewed the retained diffs and named integration-obligation/test files; no source or runtime changes.

1. **Accepted upstreams can release dependents without integration.** `packages/router/src/storage/integration-obligations.ts:164` waits only for `owed` and `active`; `conflict`, `refused`, `failed`, and `redelegated` fall through immediately. Line 165 also releases owed/active upstreams after 15 minutes. `tasks.ts:526` then queues the dependent. Therefore the stated invariant that dependents start after accepted upstreams reach the job branch is not enforced on integration failure or timeout. The new test at `tests/job-auto-integration.test.ts:186` explicitly expects timeout release. A safe failure path should remain blocked with actionable status, or explicitly bind a supported alternative source rather than claim integration has happened. Source-selection implementation outside the brief was not inspected, so exact alternate-source behavior remains unverified.

2. **Finish can succeed immediately after automatic integration creates a redo.** `packages/router/src/runners/supervisor.ts:406` snapshots running children, then line 412 drains integrations. That drain can create a new queued child through `integration-tools.ts:231`'s conflict re-delegation hook. The running list is not recomputed. Meanwhile `integration-obligations.ts:134` excludes every `redelegated` original from blockers without checking the replacement. Thus an accepted task that conflicts during the finish drain can be marked redelegated, its replacement queued, and the completed-finish integration/running guards both clear in that same call (subject to existing delivery readiness gates). After a replacement fails, the original accepted obligation also remains absent from integration blockers. Recompute children after drain and retain/transfer the obligation until the replacement actually integrates or the original is explicitly rejected. Regression should cover conflict-on-finish and failed replacement.

The ordinary successful path appears wired coherently: accept_task delegates to the existing merge queue, await/delegate/stage/finish paths drain accepted results, pointer refresh includes auto-integrating tools, and the focused real-Git test asserts A-before-B integration and Task trailers. This does not establish failure-path correctness.

## Validation

No tests run, as directed to avoid overlapping supervisor validation. Findings are static code review, not observed runtime reproductions. No providers, application files, configuration, databases, commits, or processes touched.

## Remaining work

Supervisor independently reproduce the two cases, assign any framework repairs, then rerun focused acceptance and relevant existing integration/dependency/recovery checks. Full MVP acceptance remains outside this review.
