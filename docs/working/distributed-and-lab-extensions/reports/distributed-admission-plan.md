# Distributed admission: next bounded unit

Status: report-only complete; implementation and supervisor verification pending.
Baseline: isolated roadmap-process, feat/distributed-admission-plan, a99c783.
Only this report was authored. No source, shared documents, tests, migrations, builds, services, engines, providers or user data changed. Findings are source inspection, not reproduced failures. No external backend/library contract was assumed or enabled.

## Decision

After the async task lifecycle unit is accepted, implement **generation-bound, replay-safe request admission in the real Gate path**, with SQLite as the only enabled backend. Include conservative physical-request slot ownership because task-generation checks alone otherwise release capacity while an old request is still in HTTP. Preserve existing budget math; do not fold budget-policy/backend authority or provider key selection into an inaccurately small extraction.

Supervisor compatibility decision: preserve explicit taskless public Gate requests (`participants=[]`), preserve separate existing free-tier probes, and preserve synchronous Admission facades. Every nonempty task participant must supply strict captured LeaseRef; missing identity fails validation, with no owner-only or latest-row synthesis fallback. Actual ask/batch/classifier paths always use strict identities. Taskless Gate still uses existing package/accounting/key safeguards, without claiming task authority. Free-tier probes retain their distinct current key/provider-limit/breaker/slot safeguards; they currently bypass package RequestLedger accounting, so this report does not invent that protection. This decision must be documented in future package API/authored docs by the supervisor.

This establishes an awaited reserve/dispatch-intent/settle protocol and exact-attempt authorization for ordinary worker, batch and classifier calls. It does not establish authoritative remote policy, atomic provider/key admission, transport-level exactly-once execution, remote revocation, sessions/tools/Git fencing or PostgreSQL support. Do not add a backend selector or a PG-shaped implementation.

The next unit is serial with the active lifecycle worker. Its supplied contract is a strict LeaseRefSchema `{taskId, owner, runCount, incarnation, project}`: runCount positive, incarnation32hex, project captured from the claim. `capturedLease(StoredTask)` detaches/freezes claim identity; actual Executor contexts populate `taskLease`, while RunContext.taskLease remains optional for compatibility. The worker owns storage task-leases/sqlite-task-leases/tasks/task-queue/sqlite-task-queue/migrations, core executor/task-run-leases/scheduler/watchdog, runners/types and minimal service/supervisor-cancel wiring. These names are its communicated design, not code verified in this report's baseline. Merge/re-read that accepted unit before implementing; never synthesize an old caller's identity from the latest task row.

## Current boundary and concrete findings

Paths below are relative to packages/router/src; line references describe a99c783.

| Boundary | Current source evidence | Consequence/next requirement |
| --- | --- | --- |
| Admission input | admission/admission.ts:161 Participant; request-ledger.ts:7,15-22 | Task ID, owner and caller EffectiveBudget cross the async port. No generation/incarnation/project, caller operation ID or immutable persisted reservation context. Strict schema validation is present but does not establish authority. |
| Reserve authority | admission/sqlite-request-ledger.ts:29-48,50-142 | One IMMEDIATE owns live-task checks, request/token/job holds, package allocation, project share, paid global/project/key/task headroom and request/charges/spend inserts. Preserve this transaction and connection. Current activeStatus is owner-only; project comes from first participant. Add captured exact identity and require every participant's authoritative project equal, including internal qualification policy. |
| Reserve retry | sqlite-request-ledger.ts:130; request-ledger.ts:38-45 | Adapter generates requestId after budget checks; reject-after-commit leaves caller without deterministic reservation identity. RequestPersistenceError blocks fallback, which is correct, but no durable replay protocol exists. |
| Settle | sqlite-request-ledger.ts:147-254; paid/spend.ts:142 | UPDATE-by-request-id rewrites status, paid actual and charges without outcome CAS/operation receipt. Do not replay blindly. Late true usage must still settle its original physical request after task lease loss, without requiring a live new generation. |
| Key quota | gateway/direct.ts:145-183; providers/keys.ts:317-347; providers/limits.ts:185-210 | Key round-robin selection plus provider/key/group/model usage reserve share one immediate transaction, separately from slots and accounting. A failed/unsent request compensates by release. Selection/usage are not a data-only async backend boundary yet. |
| Actual attempt granularity | gateway/direct.ts:145-303 | Ledger.reserve is inside the credential loop. Each selected credential that reaches reserve gets its own model_requests row in this inspected source. Key-level failure reconciles that row then continues to another reserve; endpoint fallback also reserves again. Gate executionId or logical call ID alone is not an idempotency key for a physical attempt. |
| Post-await authority | gateway/direct.ts:216-251 | Capture begin/dispatched are awaited before current local assertDispatch. No await separates that SQLite authority assertion from client.complete. Preserve this placement after every new authoritative/observational await. Generation/incarnation must reach this check. |
| Capture | gateway/direct.ts:216-231; gateway/request-capture.ts:22-32; storage/request-captures.ts:26-35 | Capture failures are swallowed deliberately. Capture dispatch_intent is observational, written before authority check; it is neither permission nor durable proof HTTP started. Never reuse capture state as an admission protocol. Preserve separate provenance and existing bounded private payload policy. |
| Slot lifetime | gateway/capacity.ts:92-134,253-308 | Holds identify first task+owner, LIVE_SQL follows task lease liveness, COUNT inner-joins tasks, and acquire deletes claims by task ID only. Expiry/reclaim can stop counting a still-running HTTP request; stale acquisition can remove a newer claim. Provider AIMD generation is separate from task incarnation/runCount. |
| Claim hook | routing/claim-capacity.ts:87-91 | Scheduler admission chooses a platform and records its claim synchronously inside task claim. Preserve same-transaction claim policy; add captured post-claim row generation, not a second asynchronous transaction/callback. |
| Runtime callers | runners/types.ts:112-129; runners/batch.ts:172; scoring/classifier.ts:191-195 | Only two production direct Gate.request call sites: ask and classifier; batch supplies participants to ask. Carry each member's own captured LeaseRef. Gate normalization at gate.ts:348-355 currently copies owner/budget only. |
| Classification writes | routing/router.ts:141-211; scoring/classifier.ts projectFor/cache | Routing awaits health/source/classifier then updates task metadata by task ID. Fence tier/classification/cache publication by captured identity; stale results may not write a new generation. Preserve authoritative same-project classifier batching/cache partition already implemented. |
| Close | gateway/gate.ts:293-305; core/service.ts:864-879 | Gate registers promises before invocation and closes new admissions, drains full requests; service starts Gate drain, stops scheduler/executor/Labs/settles, then awaits Gate before closing DB. New port/slot operations must join this lifetime; no detached renew/reconcile retry. |
| Probe | gateway/direct.ts:321-360 | Discovery tool probes select only free-tier keys and use keys/limits/breaker/slots, bypass request ledger/capture. Taskless holders do not obtain durable task authority. Preserve this explicit compatibility path; do not forge LeaseRef or claim task authority, ledger/package accounting, or complete backend admission migration for it. |
| Purge | projects/deletion.ts:147-194; storage/request-captures.ts:137 | Purge deletes payload scope first, then provider_slots/charges/tasks, anonymizing model_requests while retaining paid audit. New durable bindings/receipts must be integrated with purge; current task-bound slot deletion cannot remain for physical in-flight holds. Root owns this caller/integration partition. |

## Transaction authority and budget policy

Keep the actual accounting checks/inserts in one IMMEDIATE transaction. All task identity/project/liveness/cancel/deadline checks use a single adapter clock at execution time and compare taskId+owner+runCount+incarnation+project. Validate stored rows/specs with existing schemas, and verify execution membership refers to the selected participant incarnation. Legacy execution_members lacks this provenance; new request binding supplies it without relabeling legacy rows as current.

Preserve package hour/day counters; per-project request share; task request/input/output caps; parent job carves/worker grants held in heldRequests; global/project paid windows; key monthly cap/prepaid balance; task paid cap; proportional batch charges; consumed-before-resume task spend. Project equality must be checked for every participant, not inferred from aliases or the first row/trigger. Do not let deleted/recreated task IDs inherit old request authority: incarnation participates in receipts, dispatch, claims and request provenance.

Do not replace caller EffectiveBudget with `effectiveBudget(cfg,spec,tier)` alone. Executor.context uses runCap(contract)+approved extraRequests, repairCap and reviewer/twin-specific caps (core/executor.ts:171,268,314), while total verification budgets differ from execution caps. A simplistic clamp breaks granted continuation and verification. First unit retains current trusted in-process policy snapshots as immutable receipt data and permits callers to narrow them; it makes no remote policy-authority claim. A subsequent owned admission-policy module must derive execution/repair/reviewer/twin allowances from persisted contract/grants/spec plus versioned config, key/vault and catalog/price provenance. It must run inside the reservation authority transaction and be tested against current budget-control semantics. This is a backend-enablement blocker, not omitted implementation hidden behind a DTO.

Key selection/round-robin/cooldowns/provider limits remain current synchronous SQLite operations in the first unit. Their reservation IDs become linked provenance, and definitely-unsent release stays conservative and exact-ID. They are not newly atomic with the accounting/slot transaction. No callbacks, PaidSpend instance, Db, credential secret or arbitrary SQL crosses the new data port. Credential ref, provider/model, quota reservation ID, price snapshot/provenance and policy fingerprint are data; credential material remains local to transport.

## Proposed validated protocol

Reuse the accepted LeaseRefSchema rather than defining a second task identity. Export strict data schemas/types from admission/request-ledger.ts; supervisor owns public index export decisions. Proposed names below are the worker contract, not implemented APIs.

```ts
type RequestParticipant = {
  lease: LeaseRef; budget: EffectiveBudget;
  estInputTokens: number; reservedOutputTokens: number;
};
type ReserveRequest = {
  requestId: string; payloadDigest: string; // allocated once before first persistence await
  executionId: string; profile: ProfileName; purpose: string;
  endpointId: string; gatewayModel: string; tier: TierName | null;
  participants: RequestParticipant[]; paid?: PaidReservationDTO;
  providerReservationId?: string; slot?: PhysicalSlotRef;
  // existing physical estimates/routeNote retained as bounded validated fields
};
type ReservationReceipt = {
  requestId: string; fingerprint: string; disposition: 'fresh' | 'replayed';
  reservation: ReservationDTO; // detached exact original binding, never supplied anew for settle
};
interface RequestLedger {
  reserve(input: ReserveRequest): Promise<ReservationReceipt>;
  beginDispatch(input: { requestId: string; fingerprint: string; dispatchId: string }): Promise<DispatchReceipt>;
  reconcile(input: { requestId: string; fingerprint: string; operationId: string;
    dispatchId?: string; outcome: RequestOutcomeDTO }): Promise<SettlementReceipt>;
  receipt(input: { requestId: string }): Promise<RequestReceipt>;
  drain(): Promise<void>;
}
```

- Allocate requestId once per selected-key/endpoint physical attempt in direct.ts, before await; retain it through uncertain ACK and surface it in RequestPersistenceError. Distinct key attempts/fallback endpoints get distinct IDs. Canonical request fingerprint includes immutable participant leases/project, selected endpoint/key/quota refs, price/policy snapshot, estimates and digest of normalized provider-call input (tools/search included, no credentials). Stable canonicalization and schema validation happen before mutation. Reusing ID with different content is refusal, never a second request.
- Persist reserve binding and its receipt in the SAME accounting transaction. Reserve same ID/content returns original receipt without another counter/spend/usage insert. A replay receipt is diagnostic and must never itself cause another HTTP call. Caller never retries reserve under a new ID after persistence uncertainty.
- Add authoritative protocol state independent of request_captures: reserved -> dispatch_intent -> settled, with exact dispatchId and immutable binding. beginDispatch validates the exact still-live participant identities and held slot under one immediate transaction, records intent and returns fresh/replayed distinction. Replayed dispatch intent never grants another physical send. Commit-with-lost-ACK fails closed; receipt lookup/reconciliation does not retry transport. A reserved replay can be diagnosed as unsent but does not automatically resend in this first unit.
- SQLite runtime performs a synchronous exact-lease/request/dispatch/slot revalidation after awaiting beginDispatch, after all capture/other awaits, immediately before client.complete, plus AbortSignal check. Revocation/cancel/expiry/deadline before that point records definitely-unsent failure and releases only its own quota/slot. No transaction spans HTTP. Never infer authorization from a successful historical reserve or capture record.
- beginDispatch is not remote instantaneous revocation. A future async DB round trip leaves a scheduling/network gap before HTTP; ordinary remote leases cannot promise that all revocations prevent a call already authorized elsewhere. A later owning dispatch service/fenced proxy/outbox and provider-supported idempotency would need a separate reviewed contract. Even the local read cannot undo a call already authorized immediately before another process commits revocation; its precise guarantee is checking persisted authority at the invocation boundary, not instantaneous cross-process network cancellation. Retain SQLite immediate check until that design is implemented; do not advertise a PG DTO as equivalent.
- Reconcile loads persisted binding; do not accept replacement participants/budgets/prices from caller. It atomically updates request/spend/charges and durable outcome receipt. Identical operation/content replays original receipt without mutations; conflicting final outcomes are quarantined/refused, not last-writer-wins. Old consumed responses can record true original usage after lease loss, but cannot change task outcome or charge a recreated task incarnation. Unknown cache-write price retains finite worst-case reservation and quarantine; preserve current nonfinite internal signal semantics.
- Persistence failures remain RequestPersistenceError outside provider classification. No credential retry/endpoint fallback on reserve/intent/settle uncertainty. Driver-return DTO validation failures are persistence failures too, even after commit. Retain request IDs/bindings/evidence for reconciliation.

## Physical capacity contract and compatibility

The capacity ceiling describes observed local in-flight transport attempts, not a strict remote-provider execution concurrency guarantee. Aborting a request, closing a socket, or proving the client process dead does not prove the provider stopped processing or will not bill. Local transport ownership/completion and remote consumption/billing uncertainty are separate facts; a released local capacity slot must not release an uncertain paid reservation or erase request evidence. No strict remote physical concurrency across crashes is claimed.

Extend new runtime holder participants with LeaseRef; preserve provider AIMD generation in its own distinct field. Claim/wait rows are live only for exact captured incarnation/runCount/owner/project, and request acquisition removes only claims of those exact attempts. Claims are still inserted as part of the task claim transaction. No task-ID-wide deletion by an old request.

New physical request slots have random slot ID/owner nonce and immutable request/attempt binding; count them without requiring any task row/live lease. Retain the slot through the observed local transport lifetime and accounting settlement, including cancellation/lease loss and ambiguous persistence; this does not assert remote provider completion. Release by exact slot handle/nonce, never by taskId or a newly read lease. Explicit taskless Gate and free-tier probe requests use distinct system holder identity/nonce for physical counting, never a fabricated task lease. Empty participants do not bypass package/key accounting for ordinary Gate requests. Probes retain their existing free-tier-only provider/key limits outside RequestLedger; their full key/admission backend migration is separate. Neither compatibility path claims task lease authority.

Do not keep current age-based purge for new physical request holds unless termination is proved. Local request timeout or task lease expiry is not proof an arbitrary provider client stopped. With no accepted host/transport-death proof, expired/unknown physical holds conservatively remain counted/quarantined until explicit safe reconciliation; this can exhaust provider capacity after a crash and must be surfaced as a limitation rather than hidden over-admission. Unknown holds require explicit operator reconciliation under a recorded policy: identify the exact request/slot nonce, preserve immutable evidence, distinguish proved local transport termination from unknown remote processing, and retain worst-case/uncertain billing unless a reliable provider outcome establishes actual cost. A finite TTL alone never proves local or remote completion. A later host-affinity recovery unit may automate local hold recovery only under a separately reviewed proof/policy; it still cannot infer remote processing termination from a dead client. Old provider_slots rows have null new provenance and an explicit legacy policy; never backfill them with a current task generation. Retain existing sync ProviderCapacity facade for old tests/callers only, and migrate actual default runtime to strict provenance; legacy paths are not distributed-safe.

Root integration must block project purge while an unsettled protocol/physical hold can still write accounting or receive HTTP. On confirmed safe purge, remove private participant/project/operation bindings and payload digests before deleting charges/tasks; retain only opaque consumed request-ID tombstones plus existing anonymized monetary audit. Replaying a purged ID must refuse without recreating request captures, charges, task links or project names. No request/output bodies, messages/tools or credentials in protocol receipts. Outcome details that can contain private errors/headers require the same purge policy, not permanent retention merely because they are hashes. Avoid unbounded sensitive receipt storage; initial opaque anti-replay tombstones may remain until a separately approved retention contract exists.

## First implementation partition (one serial worker)

Wait for lifecycle acceptance and migration release. One worker owns these files as a coherent request-admission unit; do not split ledger and Gate in parallel before DTO freeze.

- admission/{admission,request-ledger,sqlite-request-ledger}.ts; new admission/request-receipts.ts only if needed to keep authoritative protocol concern named and bounded. Preserve shared synchronous accounting core; legacy sync reserve/reconcile remain explicit SQLite facades, without quietly upgrading owner-only callers to current leases.
- gateway/{gate,direct,capacity}.ts; actual default port use, generation normalization, pre-send local guard, physical slot binding/settlement lifetime, drain tracking. Every nonempty public Gate task participant must carry LeaseRef; missing identity is refused, never fetched on behalf of an old caller. Explicit empty-participant Gate requests remain supported with package/accounting/key safeguards and system slot identity, without claiming task authority; separate free-tier probes remain supported with their current safeguards. Proportional Gate task fixture migrations must capture fixture-created claim identity rather than synthesize identity inside production Gate.
- routing/{router,claim-capacity}.ts; scoring/classifier.ts; runners/{types,batch}.ts. Capture classifier identity from StoredTask before its first await, carry every batch member's original identity, fence routing metadata/cache publication; preserve project partition and same-project batching. No session backend or tool/Git migration.
- storage/migrations.ts append ONLY after the lifecycle worker freezes: durable request protocol/receipt/private-binding/tombstone tables and nullable legacy provenance on provider slots/request charge rows as selected. No applied migration edits. Do not modify TaskStore lease semantics in this unit; ask root before a necessary claim-hook signature change outside routing, or before storage/task-queue contract drift.
- New tests/request-admission-protocol.test.ts, gate-request-fences.test.ts and provider-request-lifetime.test.ts; affected existing request-ledger/gate-request-ledger/team-capacity/classifier-project-scope/paid/budget-control/capture tests. Fixture migrations only when named and mechanically necessary; preserve all assertions.
- Root owns projects/deletion.ts blocker/purge integration, core/service.ts only if additional port drain wiring proves needed, public exports/authored docs/shared plan, combined acceptance. No concurrent source edits there; send exact receipt purge hooks before implementation. Suggested internal hooks `requestReceipts.blockers(project)` and `requestReceipts.purgeProject(project)` execute on the root deletion transaction connection and return bounded counts; never perform physical cleanup there.

No providers/{keys,limits,vault}.ts or paid/spend.ts policy changes in this first unit unless an actual preserving extraction requires approval. Config/key/catalog policy revision and fully atomic key/slot/accounting admission are the next separate authority unit.

## Required meaningful tests

1. Default real service -> Gate -> fake provider: normal, paid, batch and classifier paths carry exact lease/incarnation/project. A/run1 cannot send after same-owner B/run2; old incarnation cannot send after explicit task-ID reuse; different-owner control. Delay reserve, intent and capture independently; mutate persisted lease/cancel/deadline without AbortSignal; zero HTTP and no fallback after authority loss.
2. Reserve/intent commit-then-reject fixtures: one durable request/spend/charge set, zero unintended HTTP; lookup/replay with same ID never sends, changed input refuses. Reconcile commit-then-reject: exactly one physical call/charge; identical outcome replay no-op, conflicting outcome preserves original conservative paid accounting. SQLite rollback leaves no partial binding/charges/spend/receipts.
3. Hold fake provider HTTP unresolved, expire/recover/reclaim task, then ask from new generation: old request remains capacity-counted, new claim untouched by stale release, configured observed-local-transport attempt ceiling respected; do not infer a strict remote execution ceiling after a crash. Test two processes sharing SQLite for last slot/allowance, explicitly labeling same-install evidence; no multi-host claim.
4. Late old-generation consumed response settles original request exactly once without finishing/modifying B, including real usage, paid uncertainty, unknown cache-write pricing, batch member proportions and truthful served-model attribution. Do not overwrite newer-incarnation totals. Preserve budget grants/continuation, review/repair/twin and project/job/global/key boundaries.
5. Root-owned purge integration: unsettled hold blocks; after the explicit safe settlement/operator policy permits purge, remove receipt/private scope and captures; old reserve/settle/intent replay cannot resurrect private data or bind a recreated task/project. Existing anonymous paid audit remains consistent.
6. Close while reserve/intent/settle delayed: no new admission, every promise/renewal/physical handle drains before DB close, no unhandled rejection or detached retry. Existing capture begin/complete failure remains observational and never authorizes extra HTTP. Test system probes separately; do not present them as migrated task-ledger authority.

Run router typecheck/build and named focused tests serially with frozen source; supervisor independently runs full acceptance. This report ran none.

## Later units and hard blockers

- Fully authoritative persisted admission policy/config/key/catalog revisions, quota/key selection/usage and spend/slot/request mutation composed in one backend transaction, including system probes and paid search. Current trusted snapshots and several synchronous transactions block remote backend enablement.
- Async execution/member bookkeeping and read counters (Admission.createExecution/finishExecution/setMemberOutcome/totals) still use direct SQLite. Do not claim all Gate-related state migrated just because accounting awaits.
- Sessions/JSONL artifact durability and captured writer identity, external/native tools/budget grant authority, workspace/Lab/integration Git/process fencing remain separate from request side effects. Physical nonce/host/PID proofs remain necessary.
- Shared breaker/quarantine/AIMD/key cooldown state still has local/runtime and SQLite coupling; remote consistency and recovery need explicit owned ports. Physical request crash recovery cannot be fabricated from task expiry.
- PostgreSQL driver/migrations/server clock/transaction locks, worker host registration, remote authenticated dispatch/object/process ownership and real two-host tests come later. Shared SQLite multi-process tests do not establish them.

## Next worker brief (under 40 lines)

- Tier: new isolated feature worktree after accepted async lifecycle + migration release; baseline named by supervisor.
- Read Current State, this report, accepted lifecycle LeaseRef/queue contract and named current source.
- Goal: default SQLite Gate uses generation-bound, replay-safe reserve/dispatch-intent/settle protocol.
- Own admission/{admission,request-ledger,sqlite-request-ledger}.ts and named request-receipts helper if needed.
- Own gateway/{gate,direct,capacity}.ts; routing/{router,claim-capacity}.ts; scoring/classifier.ts; runners/{types,batch}.ts.
- Append storage/migrations.ts only after exclusive ownership confirmed; ask before TaskStore/queue/core changes.
- Own three new protocol/fence/lifetime test files plus named proportional existing fixtures and own report.
- Root owns project purge/blockers, service/public exports/authored/shared/package API docs; send receipt purge hooks early.
- Reuse strict captured LeaseRef {taskId,owner,runCount,incarnation,project}; never read latest row to repair a stale caller.
- Freeze DTO/idempotency contract; preserve explicit empty-participant Gate and separate free-tier probe compatibility.
- Allocate stable requestId per selected key/endpoint attempt before await; strict canonical fingerprint, immutable persisted binding.
- Reserve and receipt atomic with current budget/spend checks; no duplicate request on replay/ACK loss.
- Authoritative dispatch intent distinct from observational captures; replayed intent never sends again.
- Keep synchronous exact SQLite authority guard after all awaits immediately before provider invocation.
- Settle loaded binding once with durable replay receipt; late true usage allowed, current task outcome untouched.
- Keep unknown-cost reservation/quarantine and no provider fallback on persistence uncertainty.
- Fence claim/wait ownership; retain physical request slots across task expiry until proved completion/settlement.
- Do not infer old transport death from expired task or timeout; retain ambiguous holds conservatively.
- Preserve sync Admission facades; nonempty Gate participants require LeaseRef, missing identity refuses; actual workers never bypass it.
- Preserve budget grants/review/repair/twins/project classifier partition; no simplistic effectiveBudget clamp.
- No provider policy extraction/PG/config enablement, engines/services, real quota or user data.
- Test delayed/commit-lost ACK, same-owner takeover, ID reuse, physical slot holds, exact late billing, purge privacy and drains.
- Run focused checks/typecheck/build on frozen tree, report exact limits/hashes; no commits/shared-doc edits.
