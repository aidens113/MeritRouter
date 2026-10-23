# Trusted fixture approval migration
Outcome: Done
Date: 2026-10-23
Owner: repeat-handling worker

## Changes
- Added opt-in `openWithTestSupervisor` to tests/helpers.ts. Ordinary `open` remains unchanged. The helper acts as an explicit trusted operator through WorkerActionRequests.decide; it does not alter production authority.
- Refuses non-temporary fixture roots; checks canonical command cwd stays under the temporary fixture root; approves only exact commands in persisted task declarations or an explicit fixture command list. Operation capabilities are refused. Maximum256 approvals per instance; broker continues enforcing project/task/generation/source authority. Polling stops and in-flight decisions drain before service close; fixture approval errors fail cleanup.
- Migrated assigned native, budget-control, verification-review/calibration/resume, projects-router-fixes, team-integration and team-nesting fixtures to opt in. The targeted reviewer probe is explicitly allowlisted by its test. Fake-clock tests pass opts.now to the broker.
- Budget-control retains exact physical-run assertions and run-limit/undeclared-command refusals; output expectations now include supervisor source identity/action references.
- Qualification project layout test uses a native scripted range edit instead of a now-disabled unsandboxed external process.
- Calibration confirmation fixture now creates and claims a persisted supervisor task with a captured lease and explicitly selects trusted supervisor policy for its synthetic integration-check workflow. This replaces the incomplete unleased mock context.
- Security worker notified readonly success fixtures can opt in. Pending/denial security tests retain ordinary open.

## Observed validation
- Native full file11/11 pass.
- Budget-control full16/17 initially; broker evidence output assertion migrated, targeted declared checks2/2 pass.
- Projects-router-fixes full7/8 initially; external qualification fixture migrated, targeted qualification1/1 pass.
- Verification-review full16/17 initially; targeted probe fixture explicitly approved, targeted rerun1/1 pass.
- Verification-calibration full7/8 initially; synthetic supervisor authority corrected, targeted confirmation1/1 pass.
- Verification-resume full4/4 pass.
- Team-integration full5/5 pass.
- Team-nesting full6/7 initially; durable integration repeat metadata corrected by supervisor; full rerun7/7 pass (21.22s), including supervisor resume without duplicate integration.
- No broad router suite, builds, live configuration/panel/provider/model or external engine operated. Supervisor owns frozen-tree acceptance.

## Remaining integration
- Root owns integration-tools repeat metadata; repeat policy must allow service-reconciled integrate_task on resume.
- Root owns any external-runner legacy suites outside this brief; helper must never bypass external-worker sandbox refusal.
- No commits or shared working-document edits.

## Acceptance-regression follow-up (2026-10-23)
- Owned tests/coding.test.ts and external-task-tools.test.ts, then serially qualification.test.ts and team-surface.test.ts. Product source unchanged.
- Replaced unsupported external worker success/budget/streaming execution fixtures with explicit command/OpenCode refusal under disabled, human_only and supervisor policy. Tests assert no process-start sentinel, no model calls, no workspace/patch/check side effects, preserved source bytes and Git HEAD. Budget approver human/supervisor/auto cannot grant an external worker host capability.
- Preserved direct process quoting test and moved its cwd into a temporary fixture repository.
- Preserved direct task bridge coverage through explicit startTaskTools: bearer authentication, strict foreign-task argument refusal, undeclared-check refusal, token absent from generated brief, server shutdown, original lease rejection, exact persisted check request and denied command never executing. These tests do not launch autonomous external workers.
- Qualification now uses native scripted edits and reads. Positive fix-range is hidden-test graded, no-edit native submission is accepted as a submission but graded fail for no patch. Matched all three range criteria so tests no longer accidentally rely on invalid terminal output.
- Team-surface now inspects the actual native implementation request for upstream presence/absence, untrusted-data boundary, upstream task identity and finding, instead of unsupported external TASK.md stdout.

### Follow-up validation
- coding.test.ts + external-task-tools.test.ts:9/9 pass,25.35s.
- process quoting temporary-cwd follow-up:1 pass/2 filtered skips,2.29s.
- qualification.test.ts full:6/6 pass,9.45s.
- team-surface full initial migration:other4 cases passed; two native context assertions used obsolete external wrapper headings. Corrected to native Goal/Upstream labels; targeted native context rerun2/2 pass,4 filtered skips.
- git diff --check on four owned test files passes (line-ending advisories only).
- No full suite/builds/commits/providers/live-state operations. Supervisor owns final frozen acceptance.

## Final supervisor fixture pass (2026-10-23)
- Changed only supervisor.test.ts: first full integration case explicitly opts into the temporary operator helper with its exact declared check. Unrelated no-check/interrupt cases retain ordinary open.
- Preserved integration branch, check evidence, worker/model attribution, brain memory/report/ledger and untouched source assertions. Added persisted-action assertions: completed, decidedBy operator, exact declared command.
- Focused supervisor.test.ts full3/3 pass,29.61s (26.83s test execution). No product changes or broad validation.
