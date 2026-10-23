# Harness audit

Outcome: Done
Date: 2026-10-23
Scope: Uncommitted harness repeat guard, serialized delegation inputs, budget tools, runner propagation and supporting test diffs.

## Findings

### H1 — P1: Mutable state reads are cached as immutable and can terminate healthy coordination

- Source: `packages/router/src/harness/loop.ts:278-311`; `packages/router/src/harness/supervisor-tools.ts:655`; `packages/router/src/harness/channel-tools.ts:191`; `packages/router/src/harness/tools.ts:327,387`; `packages/router/src/labs/tools.ts:22,27`.
- Trigger: call `task_result` while a child is running; call `await_tasks` until it finishes; call the same `task_result` again. The first result is returned from the cache, reporting the old state/result. A third identical call stops the supervisor. Equivalent examples are `read_channel({})` before and after another agent posts; `brain_my_requests({})` before and after approval; and `lab_status`/`lab_logs` before and after a restart.
- Cause: only successful local `edit`/`command` calls invalidate results. Waiting, delegation, brain writes, external Lab operations and other agents' writes do not. Only `await_tasks` and `request_more_budget` opt into fresh execution. Even `brain_decide_request` does not invalidate the cached request list.
- Consequence: completed work and new coordination data become invisible; access approvals can appear absent; agents can stop with `repeated_tool_call` despite actual progress outside their own filesystem edits.
- Fix: explicitly distinguish snapshot reads from live-state reads; mark live tools for fresh execution or key their cache by authoritative state revision. Restrict aggressive repeat failure to calls known to observe an unchanged snapshot. Include brain reads/searches that other agents can update, not only status methods.
- Regression tests: scripted supervisor `task_result -> await_tasks -> task_result` observes completion; team channel post becomes visible on the same read; brain approval changes a repeated request-status query; Lab status/logs refresh after restart. Existing new native tests only repeat static repository reads.
- Confidence: confirmed by control-flow inspection; no runtime reproduction performed by this worker.

### H2 — P2: Repeat guard prevents legitimate repeat Lab operations and checks after service progress

- Source: `packages/router/src/harness/loop.ts:280-304`; `packages/router/src/labs/tools.ts:32-51`; `packages/router/src/harness/tools.ts:280`; `packages/router/src/harness/supervisor-tools.ts:697`.
- Trigger: `lab_http` GET a health endpoint; restart its service with `lab_restart`; GET the same endpoint again. All Lab operations have `external` side effect, no repeat override, and do not invalidate the cache. The second GET is refused as a duplicate side effect and stops the task immediately. Similarly a declared check of a recovering service returns the previous check output after a restart; supervisor checks instead stop on the second identical invocation.
- Consequence: the harness cannot perform common verify/recover/verify workflows. Repeated declared checks can present stale exit codes/artifacts while consuming no new check run, obscuring the actual observed service state.
- Fix: define repeat policy per operation. Allow bounded re-execution for checks under existing check limits and Lab GET/HEAD requests. Invalidate relevant state after successful lifecycle operations. Preserve conservative protection for actual externally mutating HTTP calls; do not indiscriminately enable all Lab HTTP requests.
- Regression tests: Lab GET -> restart -> same GET reaches the manager twice and observes new status; declared check -> restart -> same check creates two logs and records fresh exit codes; a third check at the configured limit is rejected by the check limit rather than masked by repeat caching.
- Qualification: `integrate_task` is already `sideEffect: "edit"` (`integration-tools.ts:327`), so check -> integrate -> same check DOES clear the cache and is not this defect. Local edits and successful commands also invalidate it.
- Confidence: confirmed by tool metadata and loop inspection; no provider/Lab operation run.

### H3 — P2: Cached tool errors disable retry even for explicit fresh-execution tools

- Source: `packages/router/src/harness/loop.ts:281,285-287,299-304`.
- Trigger: a read fails transiently (file temporarily unavailable, brain access not yet granted, temporary Lab control error), its dependency becomes available without a successful local command/edit, and the model retries the exact call. Failed outcomes enter `previousResults`; `executeAgain` explicitly excludes `previous.ok === false`; `canRecover` also requires `previous.ok`. The retry is never executed and immediately returns `stalled`.
- Consequence: recoverable errors become task failures; adding `repeatBehavior: "execute"` to a polling tool alone cannot repair this case.
- Fix: separate failed attempts from successful duplicate suppression. Permit a bounded retry for safe reads/fresh-state tools; distinguish deterministic argument errors from transient service errors. Keep outcome-unknown side effects under journal/recovery rules rather than assuming every thrown error is safe to retry.
- Regression tests: read/fresh-state tool throws once then succeeds for the same arguments; a denied brain read succeeds after access approval; deterministic invalid arguments remain bounded and duplicate side effects are still suppressed.
- Confidence: confirmed by branch conditions; no fault injection performed.

## Additional review notes

- Serialized `delegate.tasks` and `plan_work.nodes` now accept JSON strings and reject non-object array entries. The added budget-control test covers the serialized delegate success path; equivalent plan_work success and malformed input tests are absent from the diff reviewed. Inner fields still rely on existing downstream validation and casts; this audit did not establish a new regression there.
- New stalled outcome is propagated in native coding, read-only and supervisor runners; the review runner converts it to an invalid verdict with its reason. No missing LoopResult consumer found by source search.
- New native tests cover canonical argument ordering, a single cached static read followed by progress, repeated writes and the existing no-edit nudge. They do not cover state changes outside local edit/command calls, transient failures, or service recovery.
- The previous explicit final-request-only-submit test was replaced by a repeated-read test. Preserve separate coverage of final-request tool exposure, since the replacement deliberately emits read_file even when only submit_result is offered.
- Journal/resume trace: cached results are journaled under a new call ID, before warning text is appended. A blocked non-idempotent edit/external call records `ok:false`; no confirmed case of an unexecuted mutation recorded successful was found. Reads and idempotent checks can record a cached `ok:true`. Interruption after such a command intent but before its outcome can cause `applyResume` to execute the command under its idempotence policy. Cover this with a focused fault-injection test.
- Resume limitation: repeat maps are initialized after `applyResume` (`loop.ts:117-136`) and not rebuilt from transcript/journal, so resumed runs lose duplicate/stall history. This is a coverage/design question, not reported as a confirmed new safety regression: existing side-effect tools already have their own recovery/deduplication contracts, and stronger claims need per-tool reproduction.

## Validation

- Read source/diffs and searched every `runAgentLoop`/`loop.kind` consumer. No tests, builds, providers, live stores or panel operations run; supervisor owns independent verification.
- Product code, tests, shared working document and Git state unchanged by this worker.

## Suggested implementation order

1. Specify repeat policy for immutable snapshots, live reads, bounded checks and external mutations.
2. Repair H1/H2 together and add focused harness/coordination/Lab regressions.
3. Add bounded transient retry handling for H3 with safety tests for uncertain side effects.
4. Run native, budget-control, team channel, Lab, supervisor and session recovery tests, then required repository checks.
