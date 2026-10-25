# Encoded plan compatibility correction

## Cause
The new delivery-v2 lifecycle guard parsed nodes/tasks directly as an array. Existing supervisor tool handlers deliberately accept either arrays or strings containing JSON arrays through parseObjectArray. Consequently a valid encoded draft failed in the new guard before the established handler could accept it.

## Changes
- src/harness/supervisor-lifecycle.ts: decode string-valued nodes/tasks with JSON.parse, then zod-validate an array of object records before inspecting execution profiles/checks. Parser errors match the established named nodes/tasks diagnostics. No eval, lossy repair, trailing text stripping or authority relaxation.
- tests/supervisor-lifecycle.test.ts: fixture invokes lifecycle guard before actual tools; new regression checks encoded draft persistence and encoded planned delegate dispatch. Malformed JSON, trailing notes, object instead of array, null/scalar array elements remain refused with no plan/task effects. Encoded inspect-with-check is still refused before effects.
- Actual fake-provider supervisor variant emits encoded draft nodes then encoded delegate tasks, dispatches and completes its planned worker, and creates no worker-action request. Existing native-array variant and immediate blocked case remain covered.

## Validation
pnpm exec vitest run tests/supervisor-lifecycle.test.ts -> 1file/10tests passed,21.81s,exit0 (session79502).
No broader checks, live-provider calls, app source changes or commits. Parent owns typecheck/build/integration and restart.

## Limits
Only valid JSON-encoded arrays preserve compatibility. A string with a trailing note remains invalid and reports nodes/tasks must be a JSON array of objects. This does not fix model quality or guarantee a useful specification/plan; all original stage, command, plan-match and approval guards remain active.
