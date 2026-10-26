# S5 project queue isolation worker report

Status: implementation assigned; Brain predecessor frozen/accepted by focused checks. Supervisor approved source ownership/API and controls. MAIN checkout only; no new checkout/source metadata/live provider/commit.

## Owned files

core/scheduler.ts; storage/sqlite-task-queue.ts; storage/sqlite-task-leases.ts; storage/fair-claim.ts; core/task-run-leases.ts; approved storage/tasks.ts host FIFO hook; appended storage/migrations.ts and store-role.ts local attempt-marker classification; new core/project-scheduler.ts; bounded storage/project-execution-grants.ts/gateway/capacity.ts/routing/claim-capacity.ts unit corrections; tests/project-queue-isolation.test.ts and relevant project-capacity tests; this report. No core/service.ts/executor.ts/runtime-services.ts edits without separate bridge coordination. S6a owns captured-lease supervisor service injection.

## Approved protocol and interfaces

- One actual existing Executor/Scheduler per pinned ProjectRuntimeRegistry bundle. New ProjectScheduler owns bounded globally fair fan-out; never root task copies or a SQL facade.
- Minimal ready/oldest hints are read/published before coordination transactions. Fair selection/stride state lives explicitly in coordination; local store metadata remains guarded (no worker or claim_pass insertion shortcut).
- TaskStore.claim host control selects project-local FIFO without consulting local claim_pass. Legacy single-store FairClaimOrder remains unchanged.
- One local IMMEDIATE seals leader+eligible same-project completion companions before reserving one immutable full-participant global grant and local attempt marker. No late companion extension.
- Corrected order approved by supervisor: LOCAL claim COMMIT -> fresh GLOBAL consume + atomic provider headroom -> LOCAL started-marker CAS COMMIT -> actual Executor. Replayed consume/lost local commit never starts. Failed local commit may only overhold global state.
- Completion batch is one actual execution/provider-claim unit. Supervisor/writer grants are always one lease. Capacity must validate exact holder lease SET equals the union of whole grants; no subset can turn one batch into independent calls. Composite independent grants remain supported.
- ProjectQueueBindings binds local queues/task lease port/refsForRequest/authorizeStart/reconcile using S4b existing privateServices and executionGrants callback ports. Root owns the service bridge. Supplied taskLeases is the actual Executor TaskRunLeases port.
- Scheduler optional host controls replace every local liveness mutation and authorize actual dispatch; ordinary legacy scheduling remains explicit.
- Renew actual local lease and immutable global bound CAS while holding local IMMEDIATE, local -> global. Terminal receipts commit locally first, then durable outbox reconciliation retires logical grant only. Physical request slots are never refunded from lease age/cancel/end/reopen.

## Findings/dependencies

Current ProviderSlotAdmission.claimed runs inside TaskStore.claim but split capacity.recordProjectClaim requires active grant after durable local claim, so split adapter must buffer admission and apply exact sealed group only after fresh consume. Current grants/provider-claim counts use leases.length; supervisor approved actual unit correction. Local durable attempt/participant markers require appended migration and strict project identity classification.

S4b registry pins UUID/store/generation/path/file identity and gives actual local Executor/leases/Gate; no missing-store fallback. Existing privateServices can inject taskLeases before executor construction, and executionGrants callback can read bound local queue refs; no new runtime-services source is necessary for those ports.

Open preservation issue sent to supervisor: legacy delegated supervisors consume neither worker slots nor top-level supervisor slots; current S3 counts every lease/role. Proposed explicit single-lease delegated supervisor marker from validated local parent, preserving local parent agent caps. Awaiting policy confirmation before that bounded grant-policy change.

All source changes and measured checks will be appended here as they happen. No S5 source changes made before ownership/API approval.

## Implementation candidate and measured validation (2026-10-26)

Implemented approved file partition: core/project-scheduler.ts, core/scheduler.ts; storage/sqlite-task-queue.ts, sqlite-task-leases.ts, fair-claim.ts, tasks.ts, migrations.ts, store-role.ts, project-execution-grants.ts; gateway/capacity.ts; routing/claim-capacity.ts. No TaskRunLeases edit needed: actual runtime already uses injected TaskLeases. Tests: project-queue-isolation.test.ts, project-capacity.test.ts, approved fixture-only projects-fairness.test.ts. Root owns service/runtime/purge integration.

Global weighted fair fan-out drives actual per-project Executors. Local transaction seals whole completion batch before immutable reservation; local commit precedes fresh consume/provider headroom and started-marker commit. Local terminal outbox retires only logical reservations. Exact set binding, separate supervisor/worker pools, trusted local delegation, local-to-global renewal and physical conservative holds enforced. Found/fixed actual hidden additional supervisor claim: legacy leader limit counted workers only; host FIFO now bounds all claimed roles. No local claim_pass/worker metadata bypass.

After-await stop/cancel dispatch check and synchronous child stop signalling prevent late Executor entry. Provider claim replay canonicalizes lease/ref sets (ordering irrelevant). Terminal outbox accepts exact already-completed/revoked global state without refunding physical holds. Root purge deletes mappings only after durable actual terminal reconciliation.

Measured checks: initial frozen queue19+capacity31 =50/50 PASS26.79s. Latest queue21+capacity31 =52/52 PASS30.15s (actual Executor, nested supervisor progress, stale provider headroom, stop-after-admission, real terminal/purge, reordered batch idempotence). Additional real SQLite local/global close-and-reopen test PASS4.38s: started marker cannot execute twice; expiry alone retains active grant; actual local recovery then reconciles revocation, stale refs refused. Final test source now queue22. Earlier legacy task-queue8/task-leases18 PASS; fairness7/10 before fixture warmup had measured native Brain overhead. Warmed isolated batching preserves original internal awaitResults10s and all assertions; body passed, teardown sy.close exceeded10s (22.986s total). Requested bounded teardown drain budget from root; no product/internal timeout change.

Schema serialized for other owners: command owners, Web reservations/protocol, Brain lease binding, shared ports integrated in root checkpoint5cb43f9. After explicit schema hold release appended shared sanitized project_lab_capacity and local/scoped lab_capacity_owners with exact Lab/project validation; C3 owner notified. No schema concurrent writes.

Final queue22 + legacy task-queue8 + task-leases18 exact snapshot:48/48 PASS34.02s. Production and schema frozen to supervisor for integration checks. Capacity31 current source passed in prior52-case run. Fairness first diagnostic hook edit did not apply due LF/CRLF scripted replacement; that failure remained10s and is not accepted. Correct exact temporary120s hook is now running with elapsed close instrumentation, then instrumentation will be removed after reporting measured drain.
