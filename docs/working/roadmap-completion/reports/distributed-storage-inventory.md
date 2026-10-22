# Report: distributed-storage-inventory

## Recommendation
Start R2 with an **integrated asynchronous request-accounting boundary in the real Gate path**, retaining SQLite as the only enabled backend. Do not start with a PostgreSQL-shaped replacement for `openDatabase`, an unused repository factory, or a partial async task-claim implementation.

`gateway/direct.ts` is already async and has exactly three production accounting call sites: one `Admission.reserve` and two `Admission.reconcile` paths. Awaiting an actual repository there gives a bounded, exercised persistence slice before provider dispatch and before success/error/fallback returns. By contrast, `TaskStore.claim` encloses dependency gates, global/project/job concurrency, fair order, file leases and provider-claim hooks in one synchronous transaction; extracting just its SELECT/UPDATE breaks its admission guarantee.

This first slice establishes an awaitable runtime contract and isolates actual SQL transactions. It does **not** enable PostgreSQL, make SQLite nonblocking, or complete lease fencing, global provider admission or multi-host execution. Those are separately required slices below.

## Scope and evidence
Read-only source investigation in roadmap-process (checkpoint b5d0723 at final inspection), plus the supervisor's root `docs/working/distributed-and-lab-extensions.md`. Existing supervisor-owned source copies were not changed. No installs, generated files, branches, services, tests or provider requests were created/run for this investigation. Only this report is authored.

Commands: `rg` inventory for prepared SQL/pragma/transactions and direct DB exec; targeted reads of service/scheduler/executor/task store, request admission/direct gateway/capacity/key limits, session journal/store, artifacts, coordination, projects and Labs. This is an inventory/design claim, not code verification.

## Direct SQLite inventory
The prepared-SQL/pragma/transaction scan found **81 source files in 24 areas** in this snapshot. Paths below are relative to `packages/router/src/`. This counts actual query/pragma/transaction methods, excluding regex `.exec` false positives; transaction wrappers calling `immediate` indirectly, such as `admin/config-edit.ts`, add further coupling beyond this count.

| Area/count | Files |
| --- | --- |
| storage / 8 | db.ts, tasks.ts, usage.ts, fair-claim.ts, file-leases.ts, plans.ts, channel.ts, artifacts.ts |
| admission / 3 | admission.ts, budget-requests.ts, job-pool.ts |
| core / 4 | service.ts, scheduler.ts, executor.ts, watchdog.ts |
| gateway / 3 | capacity.ts, breaker.ts, quarantine.ts |
| providers / 3 | limits.ts, keys.ts, vault.ts |
| paid / 2 | catalog.ts, spend.ts |
| sessions / 2 | store.ts, recorder.ts |
| workspaces / 2 | worktree.ts, merge-queue.ts |
| projects / 4 | registry.ts, backfill.ts, deletion.ts, repository-setup.ts |
| labs / 6 | store.ts, services.ts, retention.ts, ports.ts, lab.ts, checks.ts |
| brain / 2 | brain.ts, access.ts |
| models / 2 | catalog.ts, scanner.ts |
| routing / 1 | router.ts |
| scoring / 1 | classifier.ts |
| context / 1 | upstream.ts |
| runners / 2 | supervisor.ts, coding/finish.ts |
| harness / 5 | tools.ts, supervisor-tools.ts, integration-tools.ts, budget-tools.ts, coordination-edits.ts |
| verification / 6 | contract.ts, phase.ts, review.ts, audit.ts, calibration.ts, followup.ts |
| qualification / 4 | registry.ts, stats.ts, runner.ts, comparison.ts |
| web / 2 | ledger.ts, backend-state.ts |
| operations / 2 | backup.ts, daemon-status.ts |
| cli / 1 | doctor.ts |
| mcp / 1 | tools.ts |
| admin / 14 | insights.ts, entities.ts, dashboards.ts, calibration.ts, brain-entities.ts, jobs.ts, job-metrics.ts, live.ts, job-team.ts, projects.ts, project-settings.ts, provider-keys.ts, qualification-work.ts, sessions.ts |

`storage/db.ts` exports `Db = better-sqlite3.Database`, opens/migrates synchronously, uses WAL/FULL-or-NORMAL/foreign-key pragmas, and exposes synchronous `immediate(fn)`. `Switchyard` publicly exposes this Db and concrete synchronous stores. SQL dialect assumptions include `json_extract/json_each`, `rowid`, SQLite triggers, `lastInsertRowid`, `sqlite_master`, connection `data_version/total_changes`, and SQLite backup/restore. Translating placeholders alone cannot implement a second backend.

## Transactions and durability boundaries

| Boundary | Actual current files/callers | Required preservation/change |
| --- | --- | --- |
| Submit + idempotency | storage/tasks.ts `submit`; core/service.ts, supervisor tools | Validate all tasks/dependencies/project ownership, reserve idempotency keys, create tasks/deps/events together. Same key/different content remains refusal. |
| Claim | tasks.ts `claim/claimCompanions`; fair-claim.ts, file-leases.ts, gateway/capacity.ts hooks; scheduler.ts | Dependency resolution, counters, project fairness, global/job/project/writer caps, overlapping globs, provider claim and lease-generation assignment must share one authoritative transaction. No async JS predicate or cross-backend callback inside it. |
| Lease/task transitions | tasks.ts heartbeat/activeStatus/finish/defer/cancel/recover/resume; executor.ts timers/settle/record | Conditional owner **and attempt generation**, expiry/deadline using backend time; finish/release-leases/events atomic. Current owner-string checks are not a full attempt fence. |
| Model reservation | admission.ts `reserve`; direct.ts | Task lease/cancel/deadline, token/request/job holds and package/project allocations, paid headroom, one model request plus all participant charges plus paid reservation stay atomic. PaidSpend must use that same transaction connection. No network call inside transaction. |
| Model settlement | admission.ts `reconcile`; direct.ts | Actual response/status/telemetry, conservative uncertain cost, paid settlement and proportional batch charges commit together. Add idempotent settlement/transition guards before reconnect retries; current UPDATE-by-id is not a defined replay protocol. |
| Provider/key limits | providers/keys.ts, limits.ts; capacity.ts, breaker.ts | Provider/key/quota-group/model window checks+usage reservations are currently a distinct transaction from model accounting. Preserve compensating release for definitely unsent calls; centralize/revalidate shared caps before enabling PG. Gate slots, scheduler claims and priority waits must use the same backend. |
| Delegation + job pool | harness/supervisor-tools.ts, budget-tools.ts; admission/job-pool.ts, budget-requests.ts; storage/plans.ts | `grantBriefs` reads available pool before later async dispatch/grant writes; do not assume this is already a backend-atomic delegation operation. Future repository must atomically reserve pool/carve, create child tasks and record grants/plan revisions; avoid check-then-await-then-insert. Budget decisions themselves transact pending status, pool availability and granted extras. |
| Sessions | sessions/recorder.ts, store.ts, runners/types.ts `ask`, native/supervisor loops | Recorder fsyncs JSONL **before** indexing event/counters in SQLite; file is current truth and reopen backfills index. A remote backend needs durable ordered event body + index/counters + append idempotency, with awaited intent before side effect and awaited response evidence before task settlement. Cannot just move session index to PG and leave truth on dead host. |
| Artifacts | storage/artifacts.ts, context/sources.ts, harness/tools.ts, coding/finish.ts | Bytes written locally then metadata indexed, read returns Buffer synchronously, absolutePath exposed. Object write/hash verification before metadata publication; orphan cleanup/outbox on failure, authenticated reads, no foreign-host path resolution. |
| Integration/brain | workspaces/merge-queue.ts, integration-tools.ts, brain.ts/access.ts/promotion.ts | Git operations span transactions. Current physical-Git+branch mutex records local host/PID and intentionally refuses ambiguous remote owners. Replace with backend resource lease + fencing and host-owner execution, preserve immutable commits/Task/Agent/Model attribution. A PG lock alone does not stop an old Git subprocess. |
| Projects/config/retention | projects/deletion.ts, admin/projects.ts/config-edit.ts, labs/retention.ts | Current same-install immediate lock serializes config/lifecycle checks and purge; filesystem config rollback is operational, not crash-atomic. Remote config policy needs durable revisions and ownership; deletion must retain request/spend audit, fence new work, and schedule object/Git cleanup rather than deleting arbitrary remote paths. |
| Labs | labs/store.ts/services.ts/ports.ts/lab.ts | Persist host affinity, service generation/ownership; port uniqueness becomes `(hostId, port)` rather than one global port space. Readiness/listener/PID proofs are local. Never adopt/kill a PID on another host merely because backend rows match. |

## First implementation slice: exact contract and integration
Create `admission/request-ledger.ts` for validated DTOs/port and `admission/sqlite-request-ledger.ts` for the real SQLite implementation. Keep concern placement in admission, not a generic SQL helper. Extract the existing reserve/reconcile transaction bodies into a single shared SQLite core; the legacy synchronous Admission methods delegate to that core for compatibility, while the runtime async adapter invokes the same core. Do not duplicate budget math or create an unreferenced adapter.

Proposed initial DTO/port shape (names are the intended implementation contract):

```ts
type PaidReservationDTO = {
  key: SpendKey; provider: string; worstCaseUsd: number; price: TokenPrice;
}; // data only: no PaidSpend instance, DB, callback, credential secret, path or function
type ReserveRequestDTO = Omit<ReservationRequest, "paid"> & {
  paid?: PaidReservationDTO;
};
type ReservationDTO = Omit<Reservation, "paid"> & {
  paid?: PaidReservationDTO;
};
type RequestOutcome =
  | { kind: "succeeded"; response: ChatResponse;
      servedEndpointId: string | null; policyViolation?: string }
  | { kind: "failed" | "uncertain"; httpStatus?: number;
      errorKind: string; errorMessage: string; response?: ChatResponse };
interface RequestLedger {
  reserve(input: ReserveRequestDTO): Promise<ReservationDTO>;
  reconcile(reservation: ReservationDTO, outcome: RequestOutcome): Promise<void>;
}
```

`SpendKey`, `TokenPrice`, participants and outcome DTOs are schema-validated data. The SQLite implementation privately owns `Admission`/transaction core and `PaidSpend` on the same Db, reattaching dependencies internally; runtime callers never transmit a repository instance. Its initial participant owner/budget snapshots preserve current single-host behavior. They are **not sufficient as a distributed authorization contract**: generation + authoritative persisted policy and reservation context must replace caller-authoritative snapshots before PG selection is allowed.

Wire a default ledger into Gate from core/service.ts. `DirectDeps` uses RequestLedger for reservation/settlement; `requestDirect` awaits all three operations. Gate's existing `admission` remains available for execution bookkeeping/read counters during compatibility migration. All normal free and paid routed requests use the async port by default; not just an injected test path. `probeClient` does not use this admission ledger today, so do not falsely claim tool-probe/package-accounting migration from this slice.

Async interruption rules: no provider call until reserve resolves committed; recheck abort/lease immediately after awaiting reserve before dispatch. If already committed and then cancelled before send, reconcile a definitely-unsent failure with existing conservative counting and zero paid bill, preserving its audit row. If settlement fails after the provider might have consumed the request, propagate persistence uncertainty and do not enter ordinary endpoint/key fallback that could spend again without durable evidence. Shutdown drains those awaited operations. SQLite remains synchronous internally; the awaited contract permits a later genuine async driver without process-per-query emulation.

### File partitions (serial integration, no overlapping ownership)
1. **Ledger owner:** new admission/request-ledger.ts, new admission/sqlite-request-ledger.ts, admission/admission.ts, tests/request-ledger.test.ts. Own the transaction extraction, DTO schemas and shared core, preserving synchronous facade behavior. Existing paid/spend.ts remains a dependency; ask before changing its semantics. No driver/config/PG claims.
2. **Gate integration owner, after contract freeze:** gateway/direct.ts, gateway/gate.ts, core/service.ts, new tests/gate-request-ledger.test.ts; affected existing tests/paid.test.ts, providers-limits.test.ts, budget-control.test.ts, native.test.ts, projects-fairness.test.ts and process-acceptance-workers.test.ts are validation inputs (ask before changing their unrelated cases). Default wiring + awaited ordering, abort/failure handling and drain. Integration owner exclusively owns service.ts; do not run a queue migration against that file concurrently.
3. **Supervisor:** public exports only if required by the existing Gate API type surface, authored docs, review, complete affected checks. No new storage backend selector in this slice; legacy synchronous Db consumers still exist.

### Acceptance for this slice
- A real submitted task through default SQLite service -> Gate -> fake provider uses the port; stored request/participant charges match current behavior, including multi-participant batch, paid reservation/actual/uncertain outcomes and served-model mismatch attribution.
- Delayed/rejecting async ledger fixture at **Gate boundary**: provider invocation count remains zero until committed reservation resolves; reserve failure causes no network; success/error/fallback cannot return or attempt another paid request before prior outcome is durably reconciled; cancel during reserve does not dispatch afterward; settlement rejection preserves uncertain evidence and does not silently retry.
- SQLite transaction rollback leaves no partial request/charges/paid rows; current sync facade tests and package/project/job/token/paid cap refusals remain valid. Independent processes contend for last allowance without double charge, using existing fake-provider process acceptance where applicable.
- A source/caller check confirms no remaining direct Admission.reserve/reconcile calls in the routed path. Router typecheck/build and affected admission/paid/provider/budget/process tests pass. This acceptance makes no PostgreSQL or remote-host claim.

## Following slices and backend-safe API contracts
Do these in order; overlapping service/executor/gateway files require serial ownership. Keep backend-specific SQL behind owned repositories, not arbitrary SQL strings in a universal interface.

```ts
type LeaseRef = { taskId: string; ownerId: string; generation: string };
type HostRef = { hostId: string; instanceId: string };
interface TaskQueueRepository {
  claim(input: ClaimRequestDTO): Promise<ClaimedTaskDTO[]>; // includes LeaseRef/server expiry
  renew(lease: LeaseRef, ttlMs: number): Promise<LeaseStatusDTO>;
  finish(lease: LeaseRef, result: WorkerResult): Promise<FinishOutcomeDTO>;
  recoverExpired(input: RecoveryPolicyDTO): Promise<RecoveryOutcomeDTO[]>;
  cancel(input: CancelTaskDTO): Promise<TaskStatusDTO>;
}
interface WorkerRepository {
  register(input: WorkerRegistrationDTO): Promise<HostRef>;
  heartbeat(host: HostRef, capabilities: HostCapabilitiesDTO): Promise<void>;
  unregister(host: HostRef): Promise<void>;
}
interface SessionRepository {
  create(input: CreateSessionDTO, lease: LeaseRef): Promise<SessionDTO>;
  append(input: { sessionId: string; expectedSeq: number; eventId: string;
    event: SessionEvent; lease: LeaseRef }): Promise<{ seq: number }>;
  events(input: SessionEventsQueryDTO): Promise<SessionEventsPageDTO>;
}
interface ArtifactRepository {
  put(input: ArtifactWriteDTO & { lease: LeaseRef }): Promise<ArtifactRefDTO>;
  read(ref: string): Promise<{ metadata: ArtifactMetadataDTO; bytes: Uint8Array }>;
}
interface CoordinationRepository {
  delegate(input: DelegationDTO, lease: LeaseRef): Promise<DelegatedTasksDTO>;
  decideBudget(input: BudgetDecisionDTO): Promise<BudgetRequestDTO>;
  acquireResource(input: ResourceLeaseDTO): Promise<ResourceFenceDTO>;
  releaseResource(fence: ResourceFenceDTO): Promise<void>;
}
```

These are proposed signatures, not existing types/implemented features. Every DTO/response is validated; no Db/JS predicate/closure/absolute-path authority crosses the port. `ClaimRequestDTO` must contain validated host capability/policy references and limits, not current `ClaimLimits.providerSlots.check/claimed` functions or claimCompanions's predicate. Batch compatibility becomes persisted/canonical task data or backend-owned policy, with fairness and slot checks in the same transaction.

| Slice | Exact primary ownership and dependent callers |
| --- | --- |
| Queue + host/fences | storage/tasks.ts, fair-claim.ts, file-leases.ts; new storage/task-queue.ts, sqlite-task-queue.ts, worker-hosts.ts, sqlite-worker-hosts.ts; core/scheduler.ts, executor.ts, service.ts; gateway/capacity.ts. Capture run generation at claim/context creation, not a fresh lookup by an old attempt. Wire immutable generation through runners/types.ts, runners/batch.ts, routing/router.ts, scoring/classifier.ts, admission and gateway participant/slot DTOs. Preserve job/project/provider/file admission as one operation. |
| Fully authoritative accounting | admission/request-ledger implementations + budget-requests.ts/job-pool.ts, paid/spend.ts, providers/keys.ts/limits.ts, gateway/capacity.ts/direct.ts, harness/budget-tools.ts/supervisor-tools.ts. Replace snapshot authority with persisted policy revision, credential quota identity, price provenance and lease-generation checks. Add caller-generated idempotency key, durable reservation context and guarded once-only reconciliation; an old attempt may record a known spent-request receipt without changing a newer task generation. |
| Journals/artifacts | sessions/store.ts/recorder.ts/run-sessions.ts/resume.ts, storage/artifacts.ts; runners/types.ts, harness/tools.ts/resume.ts/compaction.ts, context/sources.ts, coding finish/native/supervisor and admin session reads. All intents awaited before effects, ordered append CAS, durable body+index, object hash/size and authenticated retrieval. Preserve existing fsync-before-index recovery on the SQLite filesystem adapter until the new contract replaces it explicitly. |
| Coordination/workspaces/brain/Labs | storage/channel.ts/plans.ts, harness integration/supervisor/coordination tools, workspaces worktree/merge-queue, brain access/brain/promotion, labs store/lab/services/ports/checks/retention, project registry/deletion/config. Backend leases plus owning-host RPC for Git/process actions; no direct remote path/PID access. |
| Async service + reads/control plane | core/service.ts + public index.ts, admin modules/facade, CLI, MCP and panel data calls. Add an awaited open/initialize/close lifecycle and async reads; migrate synchronously consumed result APIs deliberately. Routing/catalog, provider/key status, verification/qualification, web ledger and backup need owned async repositories/read models too. |
| PostgreSQL backend + acceptance | New backend-specific migration/driver files and validated config only after the migrated service path no longer falls through to sy.db or sync stores. One connection/transaction spans each atomic operation. Real pooled async driver; PostgreSQL row locks/SKIP LOCKED, server time and fenced conditional transitions; backend contract suite, then two-host tests. |

## Compatibility and host prerequisites
- Existing `new Switchyard`, `getStatus/collectResults`, concrete `tasks`, `admission`, `sessions`, `artifacts`, and most insights exports return immediately; panel server components, CLI/MCP and tests consume those concrete values. A Promise-returning implementation cannot satisfy those signatures. Preserve the SQLite-only compatibility surface while introducing async ports, then provide an explicit awaited service API before backend selection. Do not make a PG service expose a live-looking SQLite `sy.db` fallback or cache-only synchronous writes.
- Scheduler start calls recover synchronously; watchdog, provider claim callbacks, execution heartbeats and many event/index writes run in timers. Async migration must track and drain promises and stop claiming on backend uncertainty, not fire-and-forget them. Reconnect is not proof that the old lease still exists.
- Current task `run_count` exists but owner-string fencing predominates; `finish` does not currently compare attempt generation (or independently require a still-unexpired lease). This is a source-observed R2 dependency, not an additionally reproduced bug/fix claim. Database time and lease CAS are required before cross-host scheduling.
- Add durable worker host+instance registration and capability identities: repository/workspace/brain owner, checkout/commit, runner executable, local-provider credentials/endpoints and Labs services. Coding and Lab work stays on that host; an expired owner does not make its absolute Git path accessible on another host. Read-only work can move only when inputs are immutable backend/object references and provider credentials/caps exist on the new host.
- Shared provider quota/key identities must refer to the same logical account/group across hosts; a local config key's array index or a host-local vault master key is not global identity. Secrets remain private host/control-plane bindings, outside task/tool DTOs. Global provider/account caps stay authoritative in the backend; loopback/local capacity is host-scoped.
- Cross-host integration needs one physical repository identity and target branch mapped to its owning host, not just project/alias or local pathname. The current local PID-proof mutex correctly fails closed for remote ownership; do not weaken it to a heartbeat expiry without fencing Git operations.

## PostgreSQL fixture availability (actually inspected)
`Get-Command docker,podman,psql,postgres,pg_ctl,initdb` found only `docker.exe` at `C:/Program Files/Docker/Docker/resources/bin/docker.exe`. `docker context show` reported `desktop-linux`. `docker info --format '{{json .ServerVersion}}'` failed connecting because `//./pipe/dockerDesktopLinuxEngine` does not exist. No Docker/PostgreSQL named pipe was listed by the targeted pipe check. No pg/postgres/PGlite/testcontainers package directory was found in this worktree's pnpm store; no declared PG driver/backend dependency was found in workspace/router manifests. The broad lockfile text grep had incidental integrity-string matches, not a PostgreSQL dependency.

Possible later fixtures, **not started or installed here**: existing Docker Desktop engine plus disposable pinned PostgreSQL container(s); supervisor-authorized temporary native PostgreSQL binaries/cluster; externally provisioned disposable PostgreSQL DSN with authenticated isolation. A local embedded WASM fixture would not demonstrate actual two-host TCP PostgreSQL/locking/reconnect semantics and is not a replacement for that acceptance. Engine activation, downloads and container starts require the next brief's explicit scope. No PostgreSQL or multi-host verification was performed.

## Return to supervisor
Dispatch the ledger extraction/contract first, then its Gate integration after interface freeze. This yields an exercised async persistence boundary without claiming that the remaining81-file synchronous surface is portable. Keep PG selection disabled until queue/fence, authoritative accounting, durable journal/object retrieval and async service/API work are integrated; then run two real isolated hosts against the same PostgreSQL/fake-provider/object-store fixtures with crash/reconnect/affinity/fencing tests. Existing local SQLite two-process tests are useful regression evidence only.
