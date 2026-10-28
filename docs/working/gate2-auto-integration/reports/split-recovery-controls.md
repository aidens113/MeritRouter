# Report: split-recovery-controls

## Outcome

Done within brief; source and tests frozen for independent root verification. No live runtime/configuration/provider access or downstream application source edits.

## Root causes and changes

- `packages/router/src/core/project-scheduler.ts`: managed child startup recovery previously ran only after a fair queued-work hint. An expired running task could be the only work, so no hint existed and recovery never started. Each entry now completes its initial lease-port recovery with a null fair turn before hints. Null turns authorize no claims or transport. Failed child ticks clear initialization for retry. Explicit stop/start resets initialization; stop checks before entries and after awaited startup prevent initializing another project after the stop snapshot.
- `packages/router/src/core/service.ts`: synchronous `resumeTarget` resolves exact session/task ownership through project stores, then delegates mutations to existing guarded `resumeSession`/`resumeTask`. It never falls back to private installation stores, preserves actual task IDs beginning `s_`, rejects unscoped cross-project mixed-ID ambiguity, and retains session-first behavior within one store. Direct interrupted-session resume with a still-expired-running task gives safe worker-recovery guidance instead of bypassing lease reconciliation. Existing synchronous public resume contracts remain.
- `packages/router/src/cli.ts`: Resume delegates target resolution to `resumeTarget`; the previous condition read installation-private sessions/tasks before choosing the project.
- `packages/router/tests/split-recovery-controls.test.ts`: isolated split stores, temporary Git projects, fake provider only. Seeds use real project `claimTurn`/`authorizeStart`, retaining a consumed global execution grant across passive close/reopen. Tests cover expired-running/interrupted-session startup without queued work, exact old-grant/outbox reconciliation, live-owner/grant preservation, original session/deadline/incarnation/usage retention, one new transport, transient recovery failure retry, real CLI session/task forms, foreign/mixed-ID scopes, stop during initialization, and same-scheduler stop/start.
- `docs/operations.md`: documents split startup recovery, project-scoped Resume and safe explicit-recovery refusal.

`core/project-runtime-host.ts` and `core/scheduler.ts` were inspected but not changed. No lock-repair files, existing tests, shared working documents, commits or pushes changed.

## Validation

- Initial fixture probes failed before the product path (inspect requires a repository, then local claim requires explicit project fairness). Fixtures corrected before recording product red.
- Product red: `pnpm exec vitest run tests/split-recovery-controls.test.ts --maxWorkers=1` -> **3 failed**,22.04s. Expired-running task stayed running after12s; actual built CLI session and `s_` task forms both returned `Private evidence requires an explicit project store`.
- First repair: same command -> **3 passed**,19.39s.
- Expanded ownership/retry checks plus unchanged neighboring coverage: `pnpm exec vitest run tests/split-recovery-controls.test.ts tests/project-queue-isolation.test.ts tests/project-service-activation.test.ts tests/session-surface.test.ts --maxWorkers=1` -> **44 passed /4 files**,119.55s.
- Supervisor review identified lifecycle edge cases. Targeted red (`-t "does not initialize another|initializes project recovery again"`) -> **2 failed /5 skipped**,5.61s: stopped initialization invoked3 recoveries instead of1; stop/start initialized once instead of twice.
- Router build after final lifecycle repair: `pnpm --filter meritrouter build` -> PASS.
- Final production-source combined run (same4 files, now7 new tests): **46 passed /4 files**,128.60s.
- Test-only strengthening to real consumed global claims: new7 tests -> **7 passed**,28.24s. Old grant remains active across reopen, becomes revoked through startup recovery, and its terminal outbox is reconciled; live sibling grant stays active.
- Package typecheck initially caught two test assertions using an undeclared `ProjectRuntimeStore.admission` property; changed those assertions to the same typed runtime bundle accessor. `pnpm --filter meritrouter typecheck` -> PASS.
- Final strengthened/typed test file: `pnpm exec vitest run tests/split-recovery-controls.test.ts --maxWorkers=1` -> **7 passed**,28.12s.
- `git diff --check` -> PASS (CRLF normalization warnings only).

## Limits

The restart fixture seeds a real consumed global execution grant and a stopped lease with durable prior usage; it does not kill an actual provider process. Existing queue-isolation tests additionally exercise global claim/recovery/receipt behavior. The new same-session test uses an inspector; the scheduler/lease startup path is shared with supervisors, but actual retained-pilot recovery remains the root supervisor's live acceptance check.

For an already-interrupted session whose task still says expired-running, direct Resume deliberately refuses rather than reconciling synchronously through ad hoc state updates. Start the worker first; it owns asynchronous lease-port recovery and global reconciliation. The pre-existing running-session recovery branch remains unchanged. Budgets, original deadline/incarnation and consumed requests are not reset.

No full suite, recursive panel build, live providers or actual pilot recovery performed by this worker. No retained test cleanup artifact is known from these completed fixture runs.
