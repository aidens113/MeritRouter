# Async task lifecycle

Status: complete for this bounded unit; source frozen and ready for supervisor integration. Worker claim pending supervisor review and independent verification. Worktree roadmap-labs, branch feat/async-task-lifecycle, baseline f213dcf. No commits/pushes or shared document edits.

## Implemented boundary

Actual default workers await the SQLite task lifecycle port for renewal, finish, interruption, capacity deferral, recovery and supervisor cancellation. The new storage/task-leases.ts owns strict JSON DTOs and receipt semantics; sqlite-task-leases.ts owns local SQLite authority and transaction/time policy. Existing synchronous TaskStore/service APIs retain their synchronous return types for CLI/MCP/panel compatibility. Service adds awaited cancelTasksAsync/recoverAsync; worker context cancellation uses captured actor authority and the approved awaited supervisor tool call.

Task ID reuse was a real source-level collision: a new explicit task ID starts run_count at zero, then the same owner/run1 can recur. The one appended migration adds tasks.lease_incarnation, random32hex backfill and an insertion trigger (including raw SQLite insertions). Claim rows/queue DTOs carry this identity. The new async companion leader strictly requires incarnation and project; missing fields and same-owner recreated-ID leaders are refused. Existing synchronous facade compatibility is preserved. LeaseRef is a detached frozen { taskId, owner, runCount, incarnation, project }; project is captured for private retention scope even after task deletion. Executor captures identity before its first await and keeps it across repairs/review/batch members. Same-owner old generation and deleted/recreated ID cannot renew, finish, defer or interrupt the current lease.

Root-approved core/task-run-leases.ts owns run identity, renewal serialization, exact-controller abort and drains, keeping that concern out of an overgrown executor/storage catch-all. At most one renewal is pending per run, expired leases never resurrect, and teardown awaits pending renewal/control/recovery/settlement work before resource/DB closure. Late release removes only its own controller; batch cleanup reads its own controller set. Watchdog ownership checks compare incarnation/run and atomic async interruption/resume selects only the captured generation.

An applied/replayed own finish triggers settled/report hooks only if current incarnation/generation and durable result digest still match. Reports/settled hooks occur once; the former duplicate settled callback on report completion was removed. Every lifecycle receipt is checked against its allocated operation kind/id and captured lease before hooks; recovery additionally refuses mismatched receipt identity before session processing. Lost committed acknowledgements retry the same operation key once, never model work. Persistent failures fail closed; no silent retry loop. Local ask checks the captured lease before/after Gate; this does not migrate classifier, batch/Gate participant or provider-capacity authority.

## Port and receipt contracts

TaskLeases methods return Promise<LeaseReceipt>: renew, finish, interrupt, defer, recover, cancel, plus drain. Every request is a strict data DTO; finish validates task/result/state equality and JSON-only data. Inputs are capped at2MiB; receipt JSON at1MiB. Receipts explicitly distinguish applied/replayed/stale/expired/not_active/cancel_requested/deadline_exceeded, retain original outcome on replay, carry immutable lease/observed targets, local serverNow and original expiry where relevant. TTL comes from adapter config, not caller arguments.

Mutation plus receipt commits in one IMMEDIATE transaction; receipt insertion failure rolls back task/result/events/file-lease changes. Reuse with different digest is rejected. Renew replay returns the original expiry. A matching expired worker cannot finish; recovery is responsible for truthful interrupted/cancelled state. Own matching shutdown interruption may clean up an expired lease without affecting a superseding generation. Pending cancellation wins a matching valid late finish. Successful completed finish after the persisted deadline returns deadline_exceeded even while the lease is live; truthful failed timeout/cancel settlement remains possible. Supervisor cancellation additionally refuses expired actor deadlines and cross-project intermediate ancestry bridges.

Recovery executes selection/mutation under the transaction at server execution time, at most500 expired rows per operation. Tick uses expired_only; worker startup uses startup and bounded auto-resume (three claims, configured profiles, existing spent budgets/deadlines preserved). Public legacy synchronous recover remains compatible. Explicit public recovery promises join scheduler shutdown drains; new async recovery/cancel controls are rejected once service close begins. Logical cancellation captures target incarnation/run before its first await; supervisor actor also requires a live matching lease, project and ancestry under the transaction. Delayed receipt cannot abort a newer local controller.

## Migration and project purge contract

One append only after request_captures; no applied migrations edited:

- tasks.lease_incarnation + backfill/insertion trigger.
- task_lease_operation_keys(id PK, request_digest, expires_at): hash-only tombstones, no task/project/result payload.
- task_lease_operations(id PK/FK keys ON DELETE CASCADE, kind, request_digest, response_json<=1MiB, created_at, expires_at).
- task_lease_operation_projects(operation_id FK operations ON DELETE CASCADE, project_id, composite PK), indexed by project.

Root-owned project purge must execute `DELETE FROM task_lease_operations WHERE id IN (SELECT operation_id FROM task_lease_operation_projects WHERE project_id=?)`; scopes cascade. Preserve hash-only keys until expiry. No task FK blocks task deletion. Private result payloads are never duplicated in receipts; only digest binds the request.

Keys encode issued server-clock time: tlease_<base36 milliseconds>_<24 random hex>. Older than seven days or over60seconds future are rejected even after tombstone pruning. At most100000 unexpired keys; each mutation prunes at most500 expired keys (cascading receipts). At cap, reject before task mutation. No indefinite full result retention. A new stale call after its task incarnation is absent persists only the minimal digest key, never resurrects private scoped receipt payload; replay after scoped purge returns stale metadata and does not rerun a mutation or publish hooks. Different-payload reuse remains rejected by the tombstone. Raw fixture project '' is explicit.

## Owned files

New storage/task-leases.ts, sqlite-task-leases.ts; storage/tasks.ts, task-queue.ts, sqlite-task-queue.ts; one append to storage/migrations.ts; core/executor.ts, scheduler.ts, watchdog.ts, new approved core/task-run-leases.ts; runners/types.ts; minimal service.ts lifecycle APIs/wiring. Approved extra: one awaited cancellation call in harness/supervisor-tools.ts. New tests/task-leases.test.ts, executor-task-leases.test.ts and fixtures/task-lease-owner.mjs. Existing queue tests only if required identity contract drift. This report only under docs.

Root acceptance/source-check callbacks and request capture wiring were preserved. No project deletion/config/public exports/provider/Gate/session/tool/Git backends changed.

## Validation ledger

- Initial unchanged queue/scheduler-async acceptance:19/19 passed13.06s.
- Initial adapter6/6 passed3.78s including actual independent killed fixture process; executor delayed-port6/6 passed5.39s after correcting fixture-only contract setup/batch response shape.
- Hardened focused run:40/40 across task-leases14, executor-task-leases7, task-queue7, scheduler-async12 passed16.31s.
- New adapter cases cover same-owner takeover, expiry before recovery, mutation replay/digest conflict, original renewal expiry, explicit task-ID reuse, key expiry after purge, cancel/resume, actor ancestry/expiry, every terminal finish disposition, receipt-write transaction rollback, concurrent recovery/cancellation and delayed private purge/no resurrection.
- New executor cases cover committed lost finish ACK with one provider call/report/settled hook, delayed old finish after takeover, historical successful receipt after deletion/recreation/no reports, serialized delayed renewal and drain, cancellation/new local controller, actual per-member batch finish, and default service close draining a blocked cancellation before SQLite closure.
- The hard-kill fixture is a separately spawned Node process using built actual TaskStore/LeaseRef. It persists its claimed identity barrier, is terminated through its live ChildProcess handle only, then controller expires/recovers/reclaims and submits old DTOs. No ancestry tree kill or unrelated process termination.
- Earlier frozen broad snapshot: **172/172 across18files passed223.63s** (205.00s tests). Included actual task-Lab/caller6/6 (79.19s), dedicated public supervisor startup, session faults/resume/recording, ordinary native/external coding, team nesting, fairness, execution/accounting and verification. This snapshot preceded mandatory companion-schema hardening and later review fixes; it is not misrepresented as a final-head full suite.
- Companion/stored-row boundary snapshot: **107/107 across10 non-Lab/browser files passed76.47s**, before deadline/bridge/explicit-recovery drain changes.
- Deadline/bridge/drain snapshot: **92/92 across8 non-Lab/browser files passed54.50s**, before the final receipt-binding checks.
- Final production source lifecycle focused run: **50/50 across4files passed21.50s**: task-leases18, executor-task-leases12, task-queue8, scheduler-async12. Command: `pnpm --filter switchyard-router exec vitest run tests/executor-task-leases.test.ts tests/task-leases.test.ts tests/task-queue.test.ts tests/scheduler-async.test.ts --maxWorkers=1`.
- Final formatted executor test file repeated:12/12 passed7.61s. Final router typecheck/build and `git diff --check` passed. No test/build/fixture processes remain active.
- Additional final cases verify actor deadline, cross-project ancestry bridge, successful-finish deadline refusal with truthful cancellation/timeout settlement, public delayed-recovery close drain, async controls refused after closing, wrong recovery kind/opId rejected before session hooks, and wrong interrupt/defer receipts refused without settled/report hooks.
- Test overlap: earlier broad run included only task-Lab fixture ports58600?58900 and no Chrome suite; its Lab portion completed before root warned of the separate request-only release full suite. Later targeted runs used no fixed-port Lab/browser services. Root combined full acceptance remains independent work.

## Limits

This is a local SQLite task lifecycle boundary, not whole R2, PostgreSQL, remote clock safety or two-host operation. Gate/admission/classifier/batch participant generation, provider physical request capacity, external tool side effects, session file journal fencing and Git/workspace backend migration remain later serial units. Sync compatibility APIs retain their existing local caller model; async worker mutation safety does not automatically secure those broader boundaries. Existing accounting/capture callbacks remain responsible for late consumed provider usage.

Operator calls using a still-valid ID are allowed only within the explicit seven-day replay window. At storage cap or invalid key/bounds the port fails closed. Private receipts are project scoped; hash-only tombstone retention is intentional for conflict/expiry safety. No user4477, live/paid provider, service install, Docker or PG enabled. All tests use temp configs/brains/repos/fake providers and clean up only their owned fixture process/resources.

## Final return contract

Changed exactly the owned source/test/fixture inventory above plus this report. All production source is frozen; no commits/pushes. Parent must integrate private receipt purge and any desired public exports, independently verify the merged unit, and run combined acceptance when resource conditions allow. No end-to-end R2/PG/two-host completion claim is made.

Frozen17-file source/test/fixture SHA-256: `2d81ae2b0285e0a40718906a7fe71b1e75f74b204e2b9101d2857b5e09ad00cd` (sorted owned package paths, each path + NUL + raw bytes + NUL; excludes report).
