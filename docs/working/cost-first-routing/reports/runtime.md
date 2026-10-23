# Runtime cost-first defaults report

Status: Complete

## Changes

- Config defaults: paid enabled, shared $5 weekly cap, T1-T3 on_free_exhaustion, T4 never.
- Standalone supervisor paid_policy now defaults on_free_exhaustion; example explicitly matches.
- Explicit false/zero/never choices remain unchanged; enabled true plus zero weekly budget remains invalid.
- Default claude-code generated preset permits bounded paid routing. standalone-free explicitly disables paid, sets zero cap and all never policies. Other named preset policy overrides preserved.
- Presets regenerated with packages/router/scripts/build-presets.mjs, not hand edited.
- Added schema, init/setup preservation and generated free-only regressions. Added actual fake gateway executions with omitted paid block and a priced direct endpoint; healthy paid-key route succeeds without free candidates, excessive price is refused before dispatch, explicit disable refuses paid. Existing settlement/key/task cap tests unchanged and passing.

## Validation

Observed locally:

- npx vitest run tests/paid-defaults.test.ts tests/paid.test.ts tests/discovery.test.ts --maxWorkers=2 --minWorkers=2: 3 files, 26 tests passed (16.18s).
- npx vitest run tests/packaging.test.ts --maxWorkers=1 --minWorkers=1: 1 file, 4 tests passed (3.79s).
- Packaging default initialization regression now checks enabled/$5/tier policies and standalone supervisor policy.

Initial new schema-test probe omitted required profiles and failed three tests; corrected fixture supplies profiles: {}, rerun above passed. Initial attempted test write used an incorrect doubled repository-relative path and wrote no file; corrected before tests. No real provider/network requests, builds/full suite, commits or changes to installed/user configuration. Supervisor owns integrated validation.
