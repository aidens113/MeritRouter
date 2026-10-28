# Report: panel-stop-drain

## Outcome

Done within brief; source and tests frozen for independent root verification and production activation. No live runtime/configuration/provider access, application source edits, stale-lock changes, commits or pushes.

## Reproduced race and causal limit

The actual stop route called synchronous `turnPanelOff`, which scheduled process exit after300ms without closing its shared Router. `apps/panel/lib/sy.ts` starts repository preparation asynchronously when it opens that Router, including when the first request is the stop request. Code and the new actual-handler regression therefore demonstrate a shutdown race independent of any historical PID attribution.

The regression holds an actual repository mutation through a real Router's tracked `prepareRepositories` promise. Before repair, the exit callback fires while that marker remains held and the database is still open. A separate deferred-close regression proves the route never invoked drain, and a rejected-close regression proves it reported success despite the drain error.

This establishes the code path's defect. It does **not** prove that historical PID18308 was the panel or that its particular retained marker came from this route; the reported165ms timestamp correlation alone is insufficient. This repair never steals, removes or bypasses stale/foreign repository locks. The root supervisor's separate reviewed archival action is outside this worker's work.

## Changed files

- `packages/router/src/operations/panel.ts`: keeps synchronous `turnPanelOff` behavior, factors its delayed-exit scheduling, and adds `turnPanelOffAfterDrain`. The new wrapper marks stop first, awaits Router.close, then schedules exit. A WeakMap shares one drain/exit among concurrent requests for the same Router. Rejected drain retains the stop marker/evidence, schedules no exit, and allows an explicit subsequent stop attempt.
- `packages/router/src/index.ts`: exports the narrow async wrapper.
- `apps/panel/app/api/panel/stop/route.ts`: awaits the wrapper after the existing same-origin check.
- `packages/router/tests/panel-shutdown-drain.test.ts`: imports the actual POST handler, with a mocked shared-instance request wrapper and exit callback; tests deferred drain/response ordering, failure, concurrent stops, cross-origin refusal, real tracked repository mutation release, and unchanged sync API behavior.
- `docs/operations.md`: documents drain-before-exit, retained failures and synchronous caller responsibility.

`core/service.ts`, its close implementation, and all lock/containment code remain unchanged.

## Validation

- Actual-handler red before production edits: `pnpm exec vitest run tests/panel-shutdown-drain.test.ts --maxWorkers=1` -> **3 failed /1 passed**,3.84s. Exit occurred before deferred/real drain and a close failure was not reported. Cross-origin refusal passed.
- First repair -> **5 passed**,4.20s.
- `pnpm --filter meritrouter build` -> PASS (run after root's explicit dist-build clearance).
- `pnpm exec vitest run tests/panel-shutdown-drain.test.ts tests/operations-panel.test.ts tests/service-close.test.ts --maxWorkers=1` -> **24 passed /3 files**,13.60s.
- Initial package typecheck caught a test-only unknown Router annotation; replaced it with the actual async wrapper's parameter type. `pnpm --filter meritrouter typecheck` -> PASS.
- Final typed new regression file -> **6 passed**,4.19s.
- `git diff --check` -> PASS, existing CRLF normalization warnings only.

## Limits

These tests execute the actual route handler without a production Next HTTP server; the shared-instance `handle` adapter and process exit are mocked. The real Router/repository drain case uses an OS-temp fixture and actual mutation ownership. Root still owns recursive panel build, HTTP/browser validation, full-suite status and live activation. No claim that an application delivery is accepted or that all possible external/untracked work is drained.

Completed test fixtures cleaned up normally; no new retained cleanup artifact is known.
