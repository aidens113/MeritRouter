# Failed supervisor observation recovery

Status: Complete (worker claim; supervisor verification required)

Implemented explicit `MeritRouter.resumeTask` recovery only for a failed current supervisor whose exact latest retained session failed with `repeated_tool_call:task_result`. Storage independently validates failure/session/deadline/cancellation before queueing. Current request cap includes approved extras and held child allocations; consumed request charges, task budget, original deadline, child tasks/grants and failure history remain intact. No cancelled, expired, unrelated failed role/reason, or exhausted task is revived.

Continuation creates a fresh session linked to the exact named failed session; the old failed log remains unchanged. It preserves workspace, transcript completed-effect receipts and not-applied proofs. Recovery is deliberately limited to a settled transcript with zero pending reconciliation actions. Missing/corrupt transcript, changed authority, absent named session, missing workspace fail closed at request and execution. Executor refuses fresh-run fallback after recovery; supervisor refuses reconstruction of missing retained integration workspaces. Successful continuation records the new session ID plus previous-session provenance.

Files:
- packages/router/src/core/service.ts
- packages/router/src/storage/tasks.ts
- packages/router/src/sessions/run-sessions.ts
- packages/router/src/core/executor.ts (parent explicitly extended ownership)
- packages/router/src/runners/supervisor.ts (parent explicitly extended ownership)
- packages/router/tests/supervisor-stall-recovery.test.ts

Validation:
- `pnpm --filter meritrouter typecheck` passed after correcting the new fixture's profile union type. An earlier run also observed concurrent other worker's transient waitedSeconds typing error; it was not in recovery code.
- `cd packages/router; pnpm exec vitest run tests/supervisor-stall-recovery.test.ts --maxWorkers=1`: final16/16 passed,8.06s; nonzero2 consumed physical ledger charges retained, held grants/child references/deadline/cap preserved, original failed session immutable, fresh linked session and second interruption receipt verified.
- Refusals cover deadline, cancellation, wrong project/role, exhausted held budget, unrelated failures, missing/corrupt workspace/log, changed authority after queueing and exact missing named-session binding.
- Initial newly added absent-session fixture attempted FK-restricted deletion; corrected fixture points trusted resumed event at an absent named session while eligible latest session remains, directly reproducing forbidden fallback. Final test has no FK failure.

Not verified by worker: full suite/build, panel or live job recovery. No live state, configuration, paid routing, application source or approvals were changed. No commits/pushes. Deferred approval UX untouched.

Operational recommendation: publish/build validated framework first; explicitly resume retained parent t_0mvo6hmvmd7be5c1e9417 using public service/MCP contract. Never revive expired deps3. Parent must settle/rebrief expired child using a new label; preserve390request/$0paid cap and original parent deadline. App remains unaccepted; invalid swcMinify and missing app/pages require MeritRouter implementation, not external FINAL edits.
