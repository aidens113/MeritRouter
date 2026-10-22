# Report: panel-live-resume

## Outcome
Done. U1 correctness review and focused regressions completed; browser acceptance remains with the supervisor.

## What changed and why
- `packages/router/src/admin/live.ts`: scoped fingerprints of mutable task, session, model-request and job rows detect writes whose timestamps collide or fall below another row's high-water mark. Task/session/job changes include wildcard attribution so older-row edits reach fine subscriptions. Quiet ticks retain the existing database-version fast path.
- Brain-head checks use the install brain plus every configured project root for install scope and the requested project root for project scope. Worker identities are hashed so large worker sets remain valid bounded cursors. Cursor source filtering excludes inherited object properties.
- `apps/panel/app/api/live/route.ts`, `lib/live-hub.ts`: rejected resume cursors and recovery from watcher errors send a reset event rather than silently replacing the baseline and losing updates.
- `apps/panel/components/client/live.tsx`: reset events refresh the page with the existing pause/debounce semantics; delayed refreshes recheck document visibility.
- `packages/router/tests/admin-live.test.ts`: regressions cover unchanged task timestamps, older-row updates, and cursor round trips with many workers.
- Supervisor followup: fingerprints also cover global keys/models/project lifecycle rows, scoped web request/access/grant rows and the shared brain index. Regression coverage now includes same-length ciphertext replacement, project rename, model metadata updates with unchanged timestamps, and an install brain distinct from project roots. Each fingerprint adds a fixed-size hash to the cursor.

## Commands run and observed results
- `cd packages/router; npx vitest run tests/admin-live.test.ts`: passed all 14 tests after the final edits (9.12 seconds total; tests 6.31 seconds). Two earlier runs also passed.
- Supervisor followup final run: the same command passed all 16 tests (16.04 seconds total; tests 11.22 seconds). Initial expansion failed because the obsolete `fl_key_billing` table had already been dropped by a later migration; removed that table from the fingerprint list. A subsequent test setup failure updated an empty endpoints table; corrected the regression to insert and update a fake endpoint override explicitly.

## Not verified
- No broad builds/typechecks or full router suite were run, as requested by the brief while parallel workers edit the shared tree.
- No panel server was started. Browser DOM delivery, server restart/reconnect, pause/resume, and screenshots require supervisor acceptance checks.
- Large-store watcher performance was not benchmarked. Fingerprints scan mutable rows after database writes, which favors correctness over the previous high-water-only cost. Quiet-store checks do not scan these tables.
- No paid/provider requests or user configuration were used.

## Open questions or contradictions found
- A future revision can replace after-write fingerprints with a persistent per-topic change journal if large-store benchmarks justify it. Quiet ticks still run database-version and worker-heartbeat queries; they skip mutable-table scans.
