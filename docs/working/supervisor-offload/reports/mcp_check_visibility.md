# MCP pending check visibility

Outcome: Done
Date: 2026-11-27
Role: standard worker; assigned mcp_check_visibility brief

## Changes

- `packages/router/src/mcp/tools.ts`: core `await` and `inbox` return `pendingActions` with an explicit metadata allowlist: id, taskId, pending status, createdAt, and command/operation kind. Captured commands, working directories, lease/source identity, reasons, operation arguments, outputs, and actor identities are not returned.
- `inbox` accepts an optional taskIds filter, applied to channel messages and approval metadata. The selected project's own worker-action store is used, with explicit project/task filters. Per-task queries avoid the general listing's 500-row cap hiding a selected task behind unrelated actions.
- `await` immediately collects results when a selected task already has a pending approval. Otherwise a 250 ms local poll interrupts the existing result waiter using a private AbortController when approval starts. This stops the wait, never the task, and returns timedOut=false. Timers and transport abort listeners are removed after waiting. Existing task reports and channel draining remain intact.
- Tool descriptions direct command-approval decisions to the trusted operator surface. No decision/execution API or tool was added; `reply` remains a channel-only action.
- `packages/router/tests/mcp-offload.test.ts`: durable approval fixtures cover project/task isolation, exact metadata projection, immediate return, approval appearing during a wait, unchanged worker/action state, rejected channel grant for an action id, and unchanged core tool set.

## Validation evidence

- Command (D:/MeritRouter/packages/router): `npx vitest run tests/mcp-offload.test.ts --no-file-parallelism`
- Final observed result: exit 0; 1 file passed; 12/12 tests passed; duration 27.53 seconds. The during-wait approval case completed in 1.213 seconds.
- Initial run: 10 passed, 2 new tests failed because the fixture inherited an empty repositoryAliases list. Added the explicit core repository to the test tasks and reran successfully. The initial fixture failure also caused an unhandled closed-transport rejection; the successful rerun had no unhandled errors.

## Boundaries and remaining verification

- Existing admin worker-action listing performs its existing stale-lease reconciliation; this change does not alter that policy or call decision/execution paths.
- Source-focused tests only, as briefed. No dist, build, aggregate typecheck, aggregate suite, live provider calls, panel operations, commits, or pushes. Lead owns those integration checks and authored documentation updates.
- Existing overlapping containment/free-budget edits were preserved. Only the visibility changes described above belong to this worker.
