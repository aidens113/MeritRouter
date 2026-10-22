# Integration fixture cleanup

Status: Complete, frozen for supervisor review.
Baseline: feat/integration-fixture-cleanup at 35f18af.
Owner: brain_completion.

Only tests/request-capture.test.ts, tests/process-acceptance-workers.test.ts and this report changed. No runtime/migration/shared doc edits; inherited paid.test.ts untouched.

## Reproduction and evidence

Read full supervisor log at $env:TEMP/switchyard-admission-integration-full-supervisor.log. It records1083pass2fail1skip/107files/756.65s. Capture mixed scope admission failed at sqlite-request-ledger.ts53; process test assertions passed but cleanup threw EBUSY rmdir temp switchyard-test-M1pNjk/brain, helpers.ts103 / worker test67. Parent reports this full-load cleanup recurrence twice.

Local baseline command `pnpm --filter switchyard-router exec vitest run tests/request-capture.test.ts tests/process-acceptance-workers.test.ts --maxWorkers=1` reproduced exact capture AdmissionDenied;7passed1failed7.47s. Process worker passed2.96s; EBUSY did not reproduce in isolation. No claim of proven exact external handle owner from a historic error alone.

## Changes

Capture fixture retains modern strict refusal: mixed project helper asserts Admission.reserve throws different-project error, then directly inserts clearly marked historical model_requests/request_charges tied to valid tasks/execution membership. No mixed modern dispatch occurs. All original mixed payload omission, changed/unknown scope, participant-set purge, accounting counts and private-content assertions remain unchanged. Other reservations still exercise Admission normally.

Worker fixture previously waited exit only on still-running children. Exit does not guarantee stdout/stderr/inherited stream closure. It now registers close promises at spawn, stops the exact two owned children, and awaits close for both even if already exited, with5second visible failure deadline. No broad descendant kill or PID discovery.

Killing CLI SIGKILL can leave independently running Git report work briefly; task completion precedes tracked asynchronous brain-report completion, and Windows directory handles can outlive parent exit. Full log alone cannot establish whether Git or OS scanning held this particular historical directory. After full stdio closure plus service/server close, native fs.promises.rm retries only exact makeEnv-owned root on Windows, maxRetries10/retryDelay50ms (linear bounded backoff about2.75s). Native retryable filesystem errors only; final error propagates. No ignored cleanup, assertion weakening, timeout extension or arbitrary settle sleep. Non-Windows has zero retries.

## Final validation

Final frozen affected command above passed8/8 in7.38s. Earlier post-edit run also8/8 in8.23s. Initial typecheck caught widened profile string in extracted fixture request; corrected to literal as const, refroze then reran affected suite.

`pnpm --filter switchyard-router typecheck`: passed7.80s.
`pnpm --filter switchyard-router build`: passed9.67s.
Three additional serial invocations of `pnpm --filter switchyard-router exec vitest run tests/process-acceptance-workers.test.ts --maxWorkers=1`: see final completion below.
`git diff --check`: passed, CRLF warnings only.

No full-suite contention reproduction or repository-wide acceptance performed. Parent owns independent full acceptance. Tests use exact temporary fake HTTP/SQLite/Git repos and stopped owned child workers/server, no user data/providers/services/config changes.

Final SHA256:
- request-capture.test.ts C7FCA85C61EED4A2DB7E54A95DDFFF17DBE425BC4712A8F19B02101EBB866FA3
- process-acceptance-workers.test.ts F4960153B524590A26AE98284F5EFAD47814C0A569021940F16D2CB752856E9C

No commits or pushes.
Additional serial worker runs all passed1/1 each:6.44s,5.62s,5.02s. All worker validation processes exited before this final report; source remains frozen.
