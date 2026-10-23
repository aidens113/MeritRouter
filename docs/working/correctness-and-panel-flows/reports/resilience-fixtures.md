# Resilience fixture approval migration
Status: Implemented and frozen

## Changes
- Owned source limited to tests/resilience.test.ts.
- R1 kill/restart CLI fixture now runs a live worker:false parent operator while the child worker processes execute. Closing the submitter no longer leaves final declared checks waiting without an approver.
- Operator requires canonical switchyard-test-* root under OS temp, matching persisted task/project, exact fixture command present in task constraints, canonical cwd within fixture, no generic operation, and at most4 approvals. Unexpected actions are denied and fail the fixture.
- Operator polls serially, propagates failures and stops/drains before its service closes. Cleanup order kills CLI children before draining operator. Success additionally asserts exactly1 approved check.
- Preserved all crash/restart assertions: killed request, expired original lease, same resumed session, one edit, three requests, check exit0, final acceptance met. Other cases have no outside host checks and remain unchanged.

## Validation
- pnpm --filter switchyard-router exec vitest run tests/resilience.test.ts:11 passed,26.24s overall; R1 actual CLI process kill/restart test15.185s.
- No real providers/configuration accessed; fake loopback provider and temporary fixture only.
- No product code changes, no commits. Source frozen for supervisor acceptance.
