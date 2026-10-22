# Plan report: task lease fencing and async lifecycle

## Status and recommendation
Report-only investigation against source418b106 in frozen roadmap-process. No source changes, builds, tests, services or provider calls. Findings below are source inferences, not reproduced failures. Existing queue acceptance is evidence for async claims only, not for end-to-end lease fencing.

Implement a local SQLite task-lifecycle port next, then serialize generation propagation through Gate and external side-effect callers. Reuse durable tasks.run_count as the lease generation: claim and companion claim already increment it atomically; resume queues the task and the next claim increments again. Owner alone is insufficient. Do not add a PostgreSQL selector or claim that this finishes R2.

The first implementation should wait for the task-Lab lifecycle migration to freeze, and either integrate its caller unit first or explicitly reserve executor.ts/runners/types.ts/coding/finish.ts for the lease unit before that caller unit starts. These are serial units, not independent workers on the same files.

## Actual source evidence
Paths below are relative to packages/router/src; line numbers refer to the inspected source.

| Path/caller | Observed behavior and consequence |
| --- | --- |
| storage/tasks.ts:272,330,408,434 | Claims own one IMMEDIATE transaction and increment run_count. Companion policy is same-project and shares its leader's execution slot. Existing async queue already captures returned run_count. Preserve these transactions. |
| core/scheduler.ts:140,163,173; storage/tasks.ts:446,538 | New queue dispatch checks owner/run_count/live/cancel/deadline from a persisted row. Queue cleanup optionally fences interrupt by expected run_count. This protection currently ends at executor dispatch. |
| core/executor.ts:325,489,202 | runSingle/runBatch receive captured StoredTask but supervise calls activeStatus(id,owner) and heartbeat(id,owner,leaseMs). The interval is synchronous and release currently just clears timers; async renewal would otherwise escape that lifetime. |
| storage/tasks.ts:521,548,563,611 | Heartbeat checks owner/state/expiry but no generation. Finish checks owner/state, with no expiry or generation requirement. Defer checks owner/running/cancel only. Interrupt's generation argument is optional and executor/watchdog omit it. An old context whose owner string is reused can renew/finish/defer/interrupt the new attempt. An expired attempt can finish before recovery changes its row. |
| core/executor.ts:609,615,649; core/watchdog.ts:121 | Settle and record are synchronous. Abandon/shutdown interrupt, capacity defer, and finish all use the process owner; watchdog then reads the current task and resumes it. A stale watchdog must not interrupt/resume the current generation. record uses finish's returned state to decide brain-report writes, so a rejected finish returning another run's state must not be treated as an applied outcome. |
| runners/types.ts:66,119; core/executor.ts:176,251-260,297-309 | RunContext carries taskId/leaseOwner only. ask constructs owner-only participants. Repair, escalation, reviewers and twins derive contexts from the same StoredTask and should retain one captured lease generation; twin session identity is separate. |
| runners/batch.ts:172; scoring/classifier.ts:23,150; routing/router.ts:141,160,171,200 | Completion and classifier batches carry only owner. Router prepare awaits health/source/classification before unconditional task-id-only tier/classification writes. Generation must protect these writes too; adding a field only to the main completion request misses classifier traffic. |
| admission/admission.ts:163; admission/request-ledger.ts:7; admission/sqlite-request-ledger.ts:29,48 | Participant/ledger DTOs lack generation. Current pre-reserve and post-await dispatch checks call activeStatus with owner, then read deadline. Same-owner stale contexts pass. Gate normalization at gateway/gate.ts:343-351 must explicitly preserve any new lease field. |
| admission/sqlite-request-ledger.ts:146-175,235-245 | Reconcile updates model_requests by request id and request_charges by request id/task id, without requiring a live task. This is desirable for late consumed-provider accounting. It is not permission to mutate the current task outcome; repeated reconcile currently has no outcome-CAS/durable operation receipt. |
| gateway/gate.ts:303; gateway/capacity.ts:92-94,130-134,304-308,392-397 | Provider holder/claim records use task id/owner. LIVE_SQL has no task generation comparison; request acquisition deletes every claim for each task id. AIMD SlotHandle.generation is provider-control generation, not task lease generation. An old request must not delete a new generation's claim or stop counting a still-in-flight old HTTP call simply because the task was reclaimed. |
| runners/coding/task-tools.ts:40-49 | External MCP tool guard/watchdog checks owner and deadline only. A captured generation must reach this guard, including tool invocation before/after awaits. |
| runners/coding/finish.ts:24-27,41-48 | prepareWorkspace reads current run_count from DB, rather than from the runner context; resumeWorkspace selects the previous worktree and sets task-wide status. This can accidentally give an old context the new attempt's workspace identity. Use captured lease plus a separately selected immutable workspace/outcome handle. |
| sessions/run-sessions.ts:resumeFor,endRunSession; sessions/store.ts:200-225 | Resume reopens the same session id. Reopen's state CAS prevents simultaneous reopen, but old recorder objects do not have a captured task generation. A late old recorder can target that reused id. |
| sessions/recorder.ts:139,251,269-289 | Recorder keeps sequence/ended state locally. JSONL append/fsync precedes index transaction. Merely checking generation before writing the index does not fence the file append or prevent stale sequence writes. This is a local journal dependency, not an async session-backend implementation in this unit. |
| workspaces/merge-queue.ts:253-255; harness/integration-tools.ts:112-118 | Physical Git mutex reads current job lease owner/run_count when acquiring; this is evidence metadata, not a captured caller authorization check. Integration targets use the task's current workspace row. Retain existing host/PID/nonce mutex safety; task fencing must not replace actual OS ownership proof. Pending task-Lab caller changes already need immutable selected-outcome source identity here. |
| storage/tasks.ts:626,651,686 | Cancellation targets the logical task, pending cancellation wins late finish, expired cancelled leases finalize cancelled, other expired leases interrupt, and resume preserves spent budgets/deadline. These semantics must survive porting. Recovery currently runs atomically with a fresh clock; do not select expired rows, await, and then overwrite a newly renewed generation. |
| core/service.ts:647-654,765,790,823 | Public cancellation/recovery/resumeSession are synchronous; cancellation aborts local task-id controller after mutation. close already awaits scheduler.stop then executor.flush before DB close. Async lifecycle work must join those existing drains. |

Concrete source-inferred failure schedule to reproduce: claim A=(task,ownerX,run1), hold a renewal/finish/provider response, expire A, recover/resume, claim B=(same task,ownerX,run2), then release A. Current owner-only checks cannot distinguish them. Do this with a deliberate reused owner fixture; normal process-unique owner strings reduce occurrence but do not implement generation fencing. Also test expired A before recovery, and distinct-owner stale A as the simpler control case.

## Proposed immutable identity and authority

```ts
// Strict zod object; positive integer runCount; nonempty taskId/owner.
type LeaseRef = Readonly<{ taskId: string; owner: string; runCount: number }>;
```

Capture LeaseRef once from the claim receipt's row, validate row.id/lease_owner/run_count agree, and pass it to Executor and RunContext. Never construct it by fetching the current task on behalf of an old context. Existing TaskAttempt={taskId,runCount} for companion requests can remain but an authority-bearing call requires owner as well. Readonly TypeScript fields are not sufficient: use a validated detached/frozen copy at executor entry. Expiry is response metadata, not identity and not authority supplied by the client.

Repairs, escalation, reviewers, classifier members and twins retain the same LeaseRef until that task is interrupted/deferred and claimed again. Twin session/verification outcome IDs distinguish concurrent work under one lease; run_count must not increment per model request, repair or twin. Resume gets the next claim's LeaseRef even when continuing the same transcript/worktree. Lab TaskAttemptHandle additionally has its own attemptId/execution/source identity; it embeds the captured LeaseRef and never substitutes its identifier for task lease generation.

A synchronous SQLite local assertion may remain for the immediate pre-side-effect check after awaiting a port operation. It must compare all identity fields plus persisted state/cancel/expiry/deadline from one authoritative read. Future PostgreSQL requires backend transaction/time/fencing contracts; a SQLite callback cannot be advertised as remote authority.

## Data-only async lifecycle contract

New storage/task-leases.ts owns strict schemas/types/errors, sqlite-task-leases.ts owns the SQLite adapter. Do not overload claim policy DTOs with caller limits, timestamps, functions, SQL or task snapshots. Illustrative signatures (proposed, not implemented):

```ts
interface TaskLeases {
  renew(input: { lease: LeaseRef; operationId: string }): Promise<RenewResult>;
  finish(input: { lease: LeaseRef; operationId: string;
    state: FinishState; result: WorkerResult }): Promise<MutationResult>;
  interrupt(input: { lease: LeaseRef; operationId: string;
    reason: string }): Promise<MutationResult>;
  defer(input: { lease: LeaseRef; operationId: string;
    nextAttemptAt: number; reason: string }): Promise<MutationResult>;
  recover(input: { operationId: string; mode: 'expired_only' | 'startup' }): Promise<RecoveryResult>;
  cancel(input: { operationId: string; taskIds: string[];
    project?: string; actor: 'control' | 'supervisor';
    actorLease?: LeaseRef }): Promise<CancelResult>;
}
```

- RenewResult discriminates renewed/cancel_requested/lease_lost/not_active/deadline_exceeded and carries authoritative serverNow/leaseExpiresAt when relevant. TTL comes from adapter effective config, not caller duration. Serialize renewals per lease; never extend an already expired lease. Pending cancellation returns cancellation rather than granting new dispatch authority.
- FinishState is the existing allowed terminal worker dispositions, validated with WorkerResultSchema and matching result.taskId/executionStatus. MutationResult is an explicit discriminated applied/replayed/stale/expired/not_active receipt including the requested lease; an already-terminal *other* outcome is never returned as this worker's successful finish. Cancellation override retains current downgrade of met acceptance and truthful late-outcome text.
- Every task mutation compares task id + owner + run_count in the same IMMEDIATE transaction as result/event/file-lease changes. Finish/defer require an unexpired matching lease. Shutdown interrupt may clean its own matching expired-but-not-yet-recovered generation, but cannot touch a superseding generation. Expired finish returns expired; authoritative recovery supplies interruption/cancellation, never late completion.
- recover selects and updates expired rows inside one adapter transaction at execution time. Return affected LeaseRefs plus resulting states. Preserve the actual distinction: regular tick currently expires leases only; startup/explicit Scheduler.recover additionally resumes interrupted tasks. The validated mode selects those existing operations; do not accidentally enable automatic replay on every tick. Auto-resume policy is adapter-owned, configured MAX_AUTO_RESUMES/profile behavior and existing spent-budget/deadline rules. No callback/predicate crosses the port. If auto-resume stays a second local operation, it requires an expected interrupted generation CAS; do not read latest state and resume blindly.
- cancel is logical-task control authority, not the target worker's lease authority. Validate project inside the transaction. Supervisor cancellation additionally validates actorLease and task ancestry/project. Return exact target generation/state observed when cancellation was persisted; abort only a matching local controller after awaiting the receipt. An old control response must not abort a newly claimed generation in a task-id-only map. Human cancellation retries must not silently retarget a generation resumed after the original operation committed.
- Server time is read once inside each authoritative transaction through the store/adapter clock (injectable fixture clock). Input DTOs have no now/expiry assertion. SQLite remains local process clock behavior; future PG must use database time. No claim of multi-host clock safety.

## Idempotency and uncertain acknowledgements

Recommend a small durable operation receipt table, appended as a new migration **after the Lab worker releases migrations.ts**. Key by operationId, retain kind, request digest, lease/control scope and JSON response; mutation and receipt commit in the same transaction. A repeated identical operation returns the original receipt and performs no event/lease/report side effects again; a reused key with different payload is rejected. A committed renew replay returns its original expiry, not another extension. Operation receipts are diagnostic/idempotency records, not secrets and not new provider credentials. Retention must outlive automatic retries; no unbounded silent deletion in this first slice.

Do not implement optimistic retry before this exists. A rejection can mean committed-with-lost-receipt. Executor must fail closed, retain evidence and reconcile by the *same* operationId; it must not mint a new finish id or substitute another task's current state. Applied/replayed success should trigger local onSettled/report handling once per executor operation, not once per response arrival. A failed persistence probe is not a provider failure and never authorizes Gate fallback/retry.

Request accounting is a separate immutable receipt path. Add generation to Participant and capture it in Reserve/Reservation DTOs, execution/member/request-charge provenance (nullable legacy columns with explicit legacy-read policy). Reserve and immediate dispatch require captured current authority. Reconcile an already sent request by original requestId/receipt and participant generation even after that lease expires: record real usage/paid uncertainty for that old physical request, do not mutate current task state, and do not create a second reservation. Repeated identical settlement is a no-op; conflicting settlement is rejected/quarantined conservatively, never used to release another request's held paid spend. Unknown cache-write costs retain current conservative reservation/quarantine semantics. New generation's budget still includes previous consumed task spend, as today.

Provider slots need separate task_run_count provenance and generation-scoped claim deletion. Physical in-flight request capacity should remain held until its handle is released/known expired under an explicit conservative request-slot policy; task lease turnover alone cannot mean an old HTTP operation ended. Keep provider AIMD generation distinct. This is a subsequent admission/capacity unit requiring its own migration, not a reason to weaken task fencing.

## Async lifetime and dispatch rules

1. Executor captures LeaseRef before its first await and stores controllers/watch entries by attempt key, with task-id lookup resolving only the matching active entry. Carry that reference through withUpstream transformations without recapture.
2. Replace setInterval(async...) with a serialized renewal loop: one pending renewal, tracked promises, bounded interval from authoritative expiry and configured TTL. Timer callback always has a rejection handler. On cancellation/stale/expired/backend uncertainty, abort this attempt immediately and stop new tools/model calls; a late renewal response never un-aborts or renews authority locally.
3. A run's cleanup becomes awaited: disable future renewal, clear deadline/renew timers, drain the in-flight renewal, then await exact-attempt interruption/defer/finish and session closure. Recheck captured authority after each awaited state operation before starting further work. Error classification must distinguish lease/persistence errors from provider errors and avoid fallback that spends again.
4. Scheduler.stop fences dispatch, drains claim/companion/recovery promises and interrupts undispatched attempts as now, aborts running attempts, then waits for executor promises including renew/settle. Executor.flush drains lifecycle operations as well as brain writes. Service.close must keep DB and dependent Labs/accounting resources alive until these drains finish; test ordering rather than adding an untracked finally promise.
5. record/settle/tooDifficult/contract-shortfall/review/batch paths all await explicit mutation receipts. Only applied/replayed own terminal outcome can write a completion brain report or run applied-outcome hooks. Stale/expired outcomes may retain diagnostic artifacts but cannot announce the newer task as settled by this worker. Preserve retained batch outcomes and their charges; each member carries its own lease and settles independently.
6. Recovery at start/tick must join the serialized tick promise. Keep public synchronous compatibility recovery/cancel facades for existing SQLite callers until a separate caller migration; default worker runtime uses awaited recovery. Do not call async recover from constructor/start without tracking it.

## Session, tools, workspace and integration dependencies

No asynchronous session/object/host backend is proposed here. Local SQLite/JSONL session writes still require an explicit follow-up before claiming end-to-end stale-side-effect safety: bind recorder create/reopen to captured LeaseRef, refuse stale append/end/reopen/index mutation *before* touching a reused log, and preserve exact old request evidence in the request ledger when its session writer is fenced. The current append-before-index structure means a DB-only guard after append is insufficient. Choose a local serialized writer/CAS design or separate resumed writer identity; do not casually change transcript continuation semantics in the task-lifecycle unit. Session recovery must use affected generation identity rather than treating any live task lease as proof an old recorder is alive.

External task tools, budget grant application and native harness mutations must validate the same captured identity before and after awaits. A budget approval remains logical-task-wide and can apply to a resumed run, as currently documented; that does not authorize a stale bridge to keep running. Workspace prepare must use ctx.lease.runCount, and resume must select/verify immutable recorded worktree ownership rather than read current run_count/latest workspace for the old context. Worktree Git operations and journal files need physical ownership in addition to task CAS; DB generation does not stop an already running Git subprocess.

Pending task-Lab lifecycle already plans taskId/owner/runCount polling and immutable attempt handles. It should accept this structural LeaseRef without changing its attempt IDs. Caller/verification integration must pass the selected task-Lab handle through repair/resume/finish, retain losing-attempt teardown, and never substitute a newer Lab's evidence for an old response. Clean up only the exact attempt even if the task lease is stale. Keep all new migration indices append-only after that worker freezes.

Merge-queue's host/PID/nonce physical branch mutex remains independent and conservative. A future caller supplies captured supervisor LeaseRef for authorization before enqueue/pick/redelegate/hooks; actual live owner cannot be displaced just because generation changed or owner strings differ. Integration of a finished child uses its selected committed outcome/attempt, not an active child lease requirement. Coordinate this with task-Lab integrationTargets/exact-head changes; do not edit those files in parallel.

## Exact serial file partitions

### First bounded implementation: task lifecycle authority and executor use
Wait for task-Lab migration/caller ownership resolution; one worker owns this whole serial unit.
- New storage/task-leases.ts, storage/sqlite-task-leases.ts (DTOs, adapter, operation receipts).
- storage/tasks.ts (one shared transaction implementation, expected generation predicates and compatibility facades), storage/task-queue.ts and sqlite-task-queue.ts only if sharing LeaseRef schemas/claim validation requires it.
- core/executor.ts, core/watchdog.ts, core/scheduler.ts, minimal core/service.ts (real awaited renew/finish/interrupt/defer/recovery, drain and explicit receipt handling).
- runners/types.ts only for captured RunContext.lease plumbing; no runner authority-completion claim until next unit.
- Supervisor-controlled append to storage/migrations.ts for operation receipts after task-Lab migration freeze. No concurrent worker may own that file.
- New tests/task-leases.test.ts, tests/executor-task-leases.test.ts and fixture tests/fixtures/task-lease-worker.mjs; own new implementation report. Existing scheduler-async/task-queue tests updated only for contract drift; retain their claim/receipt-loss coverage.
- Preserve public sync TaskStore/Switchyard cancel/recover APIs as SQLite compatibility paths. Expose new awaited service variants (cancelTasksAsync/recoverAsync) but do not change sync return types under existing CLI/MCP/panel callers. Actual worker ticks and executor must use the async lifecycle port, not merely export it.

This checkpoint means generation-safe local task lifecycle mutations. It does not mean all Gate/tool/journal/Git operations are fenced or all external controls use async storage. Do not start PG/backend enablement here.

### Second serial unit: request and side-effect propagation after Lab caller freeze
- admission/admission.ts, admission/request-ledger.ts, admission/sqlite-request-ledger.ts; gateway/gate.ts, gateway/direct.ts, gateway/capacity.ts; routing/router.ts, routing/claim-capacity.ts; scoring/classifier.ts; runners/types.ts, runners/batch.ts, runners/coding/task-tools.ts and coding/finish.ts. Generation-aware reserve/dispatch, task metadata CAS, request receipt idempotency, provider capacity provenance, captured workspace run.
- Supervisor migration append for request/member/slot generation provenance; no new backend.
- Existing affected fixtures discovered by source search: tests/execution.test.ts, gate-request-ledger.test.ts, process-acceptance-integration.test.ts, projects-fairness.test.ts, projects-router-fixes.test.ts, request-ledger.test.ts, sessions.test.ts, team-capacity.test.ts. Add targeted tests/gate-task-fences.test.ts and external bridge/coding regressions. Other compiler-discovered RunContext constructions are mechanical fixture updates requiring named ownership before dispatch.
- Do not overlap task-Lab caller files, in particular executor/types/coding finish/integration tools. Integrate one unit first and rebase/validate the other serially.

### Third serial control/journal/integration compatibility units
- Async external controls: core/service.ts, runners/types.ts, harness/supervisor-tools.ts, qualification/comparison.ts, cli.ts, mcp/tools.ts, mcp/serve.ts, apps/panel/app/api/tasks/cancel/route.ts. Await cancelTasksAsync/recoverAsync and drain errors; retain old sync methods only as explicit SQLite compatibility. resumeSession needs an awaited variant/caller inventory too before claiming full async recovery.
- Local journal authority: sessions/run-sessions.ts, sessions/store.ts, sessions/recorder.ts, sessions/events.ts, exact associated schema migration if selected design needs one; no session/object backend abstraction here.
- Task-Lab-selected workspace/integration provenance: workspaces/worktree.ts, harness/integration-tools.ts, workspaces/merge-queue.ts and pending task-Lab caller files as allocated by supervisor after freeze. Preserve OS ownership mutex and selected outcome evidence.
- Supervisor owns authored docs/public exports and combined validation. No simultaneous schema/migration/shared-file workers.

## Required first-unit acceptance

- Real adapter transaction tests: same-owner A/run1 cannot renew/finish/defer/interrupt B/run2; different-owner control; expired A cannot finish before recovery; cancellation wins a valid matching late outcome. Assert task result, file leases, deadline, spent budgets and events of B unchanged by A.
- Delayed/rejected renew at executor integration boundary: no overlapping renewals; expiry/cancel/generation loss while awaiting prevents further requests/tools; rejected/late receipt cannot restore authority; run finally/stop drains before DB close. Deliberately reuse owner in fixture rather than claim normal unique owner proves safety.
- Delayed finish with takeover; committed finish with lost receipt/replayed operation id; mismatched-payload replay rejection; applied/report/onSettled exactly once. Reject terminal states outside allowed result/state schema. Paid/model accounting must not be retried because task-state storage failed.
- Recovery vs renewal/cancel interleavings at transaction execution time: renewed lease survives; cancelled expired lease ends cancelled; other expired run interrupts once; auto-resume bounds still hold; newer generation cannot be resumed by old watchdog. Concurrent recovery calls and repeats produce no duplicate terminal events.
- Actual independent fixture processes: persist A barrier, OS-kill only its fixture process, expire/recover/claim B and exercise stale A DTOs from controller. Prove no double task mutation, B lease/result/file ownership preserved, operations journal exactly once. A test that merely throws or aborts is not hard-kill evidence.
- Existing queue/fairness/provider/batching/redundancy/verification/session-resume/task-Lab suites after integration. Later Gate unit explicitly tests paid late consumed settlement, unknown cache-write retained uncertainty, classifier+batch stale generations and provider slots that cannot delete newer claims or release live old HTTP capacity.
- Supervisor runs integrated typecheck/build/full tests and any touched panel route acceptance. Worker reports exact checks and limits; this report ran none.

## Decisions for supervisor before implementation

1. Reserve the named core/runners files after the pending task-Lab caller partition is known; lifecycle worker's current migration ownership is a real serial dependency.
2. Approve durable operation receipts now (recommended) or explicitly choose fail-closed/no-automatic-retry lifecycle semantics as a smaller checkpoint. Do not promise retry idempotency without persisted receipts.
3. Choose session writer identity/ownership in its separate local-journal unit; same-session resume plus unfenced recorder append cannot be called end-to-end generation safe.
4. Keep physical provider-request capacity separate from task lease liveness; generation columns alone cannot safely stop counting an old request still in HTTP.

Report-only completion: source/caller inspection only; no behavior reproduction, implementation or R2/PG completion claim.
