# Independent observation/recovery safety review

Status: Source review complete; root integrated verification pending.

Reviewed the wait receipt and initial explicit failed-supervisor recovery diffs. No application files or live state changed. No tests run by reviewer while implementers edit.

## Findings

- Wait receipt is host-only mutable state, advanced by the actual supervisor await tool only after the service reports positive measured waiting, never by model arguments or returned prose. It resets observation history only after successful invocation. Immediate polling remains subject to the three-observation stop. Cancellation and request admission still run independently. Rounded sub-half-second waits conservatively do not reset.
- Corruption paging concern resolved: SessionStore.events(limit:1) reads the full log and returns all corruption records separately from its page slice.
- Completed and uncertain effect deduplication reconstructs from assistant/tool messages in loop.ts, so copying the transcript retains these protections across a second interruption. Original pending-action/not-applied proof handling should also be exercised across a second interruption before applyResume; requested focused regression.
- Initial recovery code checked retained workspace existence only at the service request. supervisor.integrationRepos silently filters missing saved worktrees and reconstructs them. This allows deletion between request and execution to reconstruct a different candidate. Requested execution-time fail-closed directory validation and regression.
- Initial resumeFor early returns before reading the trusted recovery directive if the current mode is unavailable/non-resumable. Requested recovery parsing before generic returns, exact supervisor mode and named retained session requirement, avoiding fresh fallback after authority/config change.
- Initial new-linked-session session_resumed receipt names the old session ID. Requested recording the actual new session and previous ID separately.

## Limits

This review does not establish runtime recovery or product acceptance. Parent must independently run integrated typechecks/build/tests and inspect live recovery with original budget/deadline intact. Final corrected diff was read after worker completion; the concrete source-review blockers above are resolved. No remaining source-review blocker found. Worker reports 15/15 focused tests and typecheck passing; reviewer did not run these and does not treat that claim as independent verification.


## Corrected final source

- resumeFor reads recovery authority before generic early returns, requires exact named session ID plus task/role/status/reason, and revalidates retained writable scoped workspace directories before creating the continuation.
- supervisor.integrationRepos refuses reconstruction when retained recovery workspace disappears, including the later runner boundary.
- Explicit recovery refuses any plan with unresolved recovery actions. Linked session stores copied transcript and notAppliedTools receipt before continuing; original failed session remains unchanged. A second-interruption test checks retained completed integration transcript.
- TaskStore recovery requires future original deadline, noncancelled task and exact failed stop reason/session. Service checks current supervisor role/project, effective request cap plus extra grants against consumed and held requests. No deadline, spent request or grant reset is introduced.
- New session_resumed receipt records actual linked session and previous ID separately. Executor fallback is fail closed for explicit recovery.

## Test caveat

The initial fixture's consumed-request preservation assertion compares a zero count, so it is not strong evidence for nonzero budget preservation. Requested nonzero fake-provider admission charge and missing named-session case from implementer; source paths themselves preserve persisted accounting. Root owns exact final test results and live safety verification.
