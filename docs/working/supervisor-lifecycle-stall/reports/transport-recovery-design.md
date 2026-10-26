# Dead local transport owner reconciliation design

Status: Proposed; no implementation or runtime mutations in this design brief.

## Verified cause and boundary

Read gate-wait-discovery report and current gateway/capacity.ts, admission/request-receipts.ts, admission/request-ledger.ts, admission/sqlite-request-ledger.ts, operations/daemon.ts and storage/lease-ref.ts. Six identified modern dispatch_intent slots and two anonymous uncertain holds exhaust8/8 local platform slots. Nonce/lease-bound request slots deliberately survive task lease death (`capacity.ts` LIVE_SQL), so normal lease recovery cannot release them. Existing conservative behavior is correct. No current public operator recovery contract exists.

Process death proves only absence of this local in-process HTTP transport owner. It does NOT prove a request was unsent, remotely cancelled, unbilled or finished at the provider. Remote outcome stays unknown and all accounting remains conservative. This feature explicitly releases a proven-dead LOCAL transport slot; it does not change provider concurrency ceilings or claim remote outstanding work disappeared.

## Minimal contract and source ownership

- New `src/operations/transport-recovery.ts`: strict zod inspect/decision/receipt schemas, immutable snapshot validation, strict process-owner parsing and tri-state same-host liveness proof, synchronous orchestration.
- `src/admission/request-receipts.ts`: validated read of exact request binding/reservation plus synchronous guarded settlement helper, reusing existing bound/reconcile checks.
- `src/core/service.ts`: explicit trusted operator inspect/reconcile methods only; no model harness/MCP exposure. Trusted actor comes from local service invocation, not a user-supplied human-role assertion.
- `src/cli.ts` and `src/cli/help.ts`: `transport inspect <requestId> [--json]`; `transport reconcile <requestId> --expected <snapshotDigest> --reason <text> [--json]`. Single exact request per operation; no bulk/all/force/skip-proof flags.
- New `tests/transport-recovery.test.ts`, plus narrow CLI invocation test if useful.
- Root updates operations/setup docs; worker does not edit shared docs. No migration needed if existing durable event receipts described below are accepted.

Inspect returns bounded metadata: requestId, protocol fingerprint/dispatchId/state, slot ID/platform/nonce, exact owner, participant lease identity digest and reconciliation snapshotDigest; plus eligible/refusal reason and tri-state liveness. Do not expose key secrets, raw prompt/capture, keyRef or paid key labels. Inspection is not an approval/capability and cannot authorize release by itself.

Reconcile input: exact RequestIdSchema, expected snapshot sha256, nonempty bounded reason. No model-supplied process proof or caller-controlled outcome/status/amount. The trusted operation re-reads data and probes the OS itself.

## Immutable binding and eligibility

Require exactly one matching nonanonymous slot: kind=request, uncertain=0, nonempty nonce, nonempty valid LeaseRef[] and owner. Require request_protocol state=dispatch_intent, nonnull dispatch_id; model_requests status=reserved; slot ID+nonce match protocol binding, protocol fingerprint equals canonical ReserveRequestDTO digest, reservation fingerprint/execution/participants/token/paid fields match immutable stored reservation. Validate immutable protocol slot/participants, slot task/lease owner, platform/provider routing relationship and all participant owner identities agree with one demonstrably local owner.

CAS snapshot covers requestId/fingerprint/dispatchId, canonical validated binding and reservation digests, model reserved identity/status, and full immutable slot row identity (ID/platform/kind/holder/task/owner/lease JSON/nonce/uncertain/creation position). Include lease runCount/incarnation/project; never substitute current task lease for original captured lease. Inspect dynamic liveness is not part of snapshot digest; execution always rechecks it. Any malformed/ambiguous/mixed-owner/mixed-project/unmatched/legacy/anonymous slot refuses and leaves all state unchanged. Changed digest/state/slot nonce/lease/dispatch/known outcome refuses.

Owner format currently originates at `core/service.ts`: hostname:pid:random6hex. Parse strictly, require hostname exactly equals current hostname, PID positive safe integer, owner suffix valid. Call process.kill(pid,0) synchronously. Success means live/refuse; ONLY errno ESRCH is absent; EPERM and every unexpected error mean unknown/refuse. Do not reuse daemon.isAlive: it returns false for errors other than EPERM, insufficient for destructive proof. PID reuse resulting in live conservatively refuses. No hostname override, assumed elapsed timeout, lease expiry or model assertion can establish death.

## Atomic accounting and receipt

Use one synchronous SQLite IMMEDIATE transaction. Within it, re-read exact immutable snapshot/binding/slot and terminal receipts, recheck same-host dead-PID proof immediately before mutation; then synchronously invoke RequestReceipts.reconcile with a deterministic canonical outcome:
`{kind:uncertain,errorKind:operator_transport_owner_absent,errorMessage:Local transport owner absent; remote request outcome remains unknown}`.
Its synchronous callback adapts stored paid DTO to the existing PaidSpend instance and calls Admission.reconcile. Do NOT await SqliteRequestLedger.reconcile inside a sync transaction: rejected promises would escape rollback. Existing accounting correctly retains request_charges estimated tokens/count, marks model request uncertain and paid worst-case cost_basis=uncertain. Provider usage/key/quota reservation records are untouched; never call limits.release or fabricate reported usage/zero cost.

In that same transaction, `DELETE provider_slots WHERE` exact ID/nonce/owner/lease/immutable expected values AND uncertain=0/kind=request; require changes===1 or throw and roll back accounting/protocol/event writes. Do not call capacity.release (it swallows errors and provides no receipt). Append one durable audit event, type transport_owner_reconciled, task_id NULL, containing requestId, expected snapshotDigest, opaque binding/reservation/slot identity hashes, canonical outcome digest, trusted local actor, bounded reason, exact owner/PID/host, probe basis ESRCH and timestamp. Existing events table plus serialized IMMEDIATE lookup+insert gives one receipt per exact request; protocol settled/outcome_digest is the authoritative accounting settlement receipt. Event ID is returned as operation receipt. No request replay, new grant, limit increase, paid-route change or task-state mutation.

Retry: first locate the committed audit receipt, require same request+expected snapshot and retained immutable binding, protocol state=settled/canonical outcome_digest and model status=uncertain, exact original slot absent. Return original receipt without re-probing a potentially reused PID or changing any row. Different snapshot or reason/caller retry may report original receipt but cannot alter it; a conflicting settlement, reused slot ID/nonce, missing audit receipt or inconsistent half-state refuses. Two concurrent operators serialize: first performs all changes once, second returns same committed receipt. A crash before commit leaves every original row; a crash after commit/lost ack is an idempotent read. Settled preexisting success/failure/uncertainty has no matching operation receipt and is refused, never overwritten.

Request protocol pruning cannot remove an unresolved slot binding; normal retention may later remove settled evidence, after which retry must refuse rather than recreate authority. Audit fields contain hashes and process metadata only; project deletion anonymous holds remain out of scope.

## Tests required before live use

1. Real temporary nonce-bound reservation + beginDispatch using existing Gate/ledger fixtures; dead-owner test probe; reconcile produces protocol settled and model uncertain, exact local slot gone. Nonzero request count/estimated token charges unchanged, paid worst-case retained, provider usage/key reservations byte-for-byte unchanged; task budget/deadline/lease/cancel fields untouched.
2. Live current PID, reused live PID, foreign hostname, malformed owner, EPERM/unexpected error, unknown proof all refuse; actual OS child process termination may test strict ESRCH separately. No live provider calls.
3. Anonymous uncertain1, legacy nonce-null/missing lease, missing protocol, reservation/slot mismatch, wrong nonce/project/owner/incarnation/runCount, duplicate/mixed participants and changed dispatch ID all refuse atomically. Unresolved process death never chooses failed/not_billed.
4. Known succeeded/failed or mismatching already-settled outcome refuses unchanged. Exact committed retry returns same event receipt with no additional writes/charges; concurrent identical reconciliation once; stale expected digest refuses.
5. Fault injection at accounting, protocol settlement, exact-slot DELETE and event insert proves entire transaction rolls back; DELETE changes0 rolls back. Restart after committed acknowledgment loss returns receipt; absent/conflicting receipt never guesses.
6. Gate dispatch replay cannot use settled request; late provider callback/old reservation cannot replace uncertain outcome or touch new slot. Provider/key budget room is not restored. Anonymous two historical holds remain byte-for-byte unchanged.
7. CLI parser/error tests plus fake service inspect/reconcile; no MCP/harness tool added. Worker:false operator service cannot start model tasks.
8. Root independently runs relevant ledger/capacity/project-deletion tests, recursive typecheck/build and full suite before deploying. Perform live reconciliation one exact reviewed request at a time; record original/after hashes and accounting receipts, preserve2anonymous holds.

## Open decision for root

Approve reuse of existing immutable protocol+audit event receipts (no schema migration) versus a dedicated append-only recovery receipt table. Dedicated table adds schema/cleanup work but offers an explicit unique requestId constraint; existing IMMEDIATE serialization plus request_protocol settlement CAS is sufficient if all invocation goes through this service. Either option must share the exact accounting/slot transaction. No code has been written in this design phase.
