# Admission fixture integration

Status: Active — baseline reproduction running
Baseline: feat/admission-fixture-integration at 1525960
Owner: brain_completion

Scope: only the twelve named test files in the written brief and this report. No production source, migration, shared-document, or paid.test.ts changes authorized/performed.

Inspection: sessions.test.ts constructs an ask RunContext with mocked Gate and no taskLease; execution.test.ts has an owner-only participant in the explicitly preserved synchronous Admission facade (not a Gate caller). Other manual contexts inspected so far are supervisor-tool/workspace facades. Actual failures will determine proportional fixture changes.

Baseline command (serial, no source edits during execution):
`pnpm --filter switchyard-router exec vitest run tests/native.test.ts tests/external-task-tools.test.ts tests/verification-review.test.ts tests/verification-flow.test.ts tests/verification-calibration.test.ts tests/sessions.test.ts tests/caching.test.ts tests/cache-creation.test.ts tests/execution.test.ts tests/resilience.test.ts tests/team-integration.test.ts tests/task-lab-caller.test.ts --maxWorkers=1`

Started 2026-10-22 15:31 local; pending. User data and real providers unused. Existing paid.test.ts line-ending-only dirty file left untouched.

## Final result
Status: Complete and frozen for supervisor review.

Baseline reproduction: all twelve named files passed unchanged, 125/125 tests, 237.79s. No failing capturedLease fixture was reproduced at 1525960; this is a fixture-fidelity amendment rather than a demonstrated runtime bug fix.

Changed only packages/router/tests/sessions.test.ts: the ask-with-session helper now submits and claims a real validated task, captures its LeaseRef once, supplies that identity and task authority to RunContext, and asserts each mocked Gate request receives the exact captured task identity. All existing transcript/error/attempt assertions and budgets/timeouts/provider expectations remain. There is no latest-lease synthesis at production dispatch.

Other named tests needed no changes: native/external/review/calibration/cache/resilience paths use actual executor contexts; manual supervisor tool/workspace contexts do not make Gate calls. execution.test.ts intentionally exercises the preserved synchronous Admission owner-only compatibility facade. Taskless direct Gate cache/probe fixtures remain explicit participants=[].

Validation (serial; source frozen during each run; all processes exited):
- Baseline twelve-file command above: task-lab-caller6, native9, verification-review17, external-task-tools5, resilience11, verification-calibration8, execution15, verification-flow13, team-integration5, caching16, sessions13, cache-creation7 =125/125 passed.
- Final affected command `pnpm --filter switchyard-router exec vitest run tests/sessions.test.ts --maxWorkers=1`:13/13 passed,6.55s.
- `pnpm --filter switchyard-router typecheck`: passed.
- `pnpm --filter switchyard-router build`: passed,8.85s.
- `git diff --check`: passed (line-ending warnings only).
- paid.test.ts was never edited; `git diff --numstat -- packages/router/tests/paid.test.ts` remains empty despite inherited dirty status.

Final SHA256 sessions.test.ts: DB896FF3D00334FD67A06D3F172E036B0FB16390F3DFA1B3C324BAB852F31DEB.

No production source, shared docs, migration, user data, provider quota, commits or pushes. Root independent review/combined acceptance remains outstanding; no distributed-backend completion claim.
