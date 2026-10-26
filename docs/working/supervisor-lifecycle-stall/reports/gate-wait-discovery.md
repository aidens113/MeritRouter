# Pre-reservation Gate wait discovery

Status: confirmed read-only; no source/runtime/config/store changes.

## Exact live cause

At1792972950714, parent `t_0mvof1bldb6e51dd16e6a` was running under lease owner `DESKTOP-7FJA708:13944:ca5019`, run4. Execution `x_0mvohpfu1d8653c181f6d` had no `model_requests` row. Its session model_request was logged at1792972791266.

The actual provider-slot row was `slot_0mvohpfzf7ac8d9863841`, kind `wait`, priority1, holder `h_0mvohpfz187184ddedc6d`, task matching parent, since1792972791339. `seen_at` advanced to1792972954709 while inspecting: the worker was actively polling capacity, not stuck in provider generation or synchronous work.

`concurrency:ollama-cloud` persisted limit8. Exactly8 request slots were held, ALL nonce/lease bound:2 anonymous `uncertain=1` historical holds and6 identified historical holds. Seven model_requests were still reserved; this differs from8 slots because one legacy reserved request has no protocol/slot, while the2anonymous slots are retained separately. All6 modern identified reservations have `request_protocol.state=dispatch_intent` and non-null dispatch IDs. None is definitely-unsent evidence.

`LIVE_SQL` in gateway/capacity.ts explicitly counts nonce/lease-bound request slots independent of task lease/state/age. Normal dead-lease expiry and purge therefore do not free these8 slots. Session/process restart cannot create capacity. Historical row deletion or blindly releasing holds would discard unresolved dispatch/transport evidence and is not authorized.

## Exact call path and bounded behavior

- runners/types.ts `ask`: records session model_request BEFORE calling `Gate.request`.
- gateway/gate.ts `request` clones/captures request and invokes performRequest. `performRequest` awaits `round`.
- `round` calls requestDirect; direct.ts performs synchronous provider/key/eligibility selection, then invokes Gate.admit BEFORE ledger.reserve.
- `admit` finds8/8 provider slots full, so direct returns skip without reservation/provider dispatch. The gate records a wait row and awaits capacity.nextWake with250ms polling.
- Configured providers.request_timeout_seconds is300. Gate starts its own timer when performRequest begins; after300s of slot waits it throws GatewayError rate_limited with retryAfterMs5000/possiblyConsumed=false. The session should record model_error; core/disposition.ts then defers capacity failures for at least5s. Repeated retries can remain blocked indefinitely while the historical holds remain; each individual wait is bounded.
- The snapshot159s after the model_request was below that300s bound. No reservation/provider call is expected for this wait and no new charge was found for this execution.
- SQLiteRequestLedger.reserve is an async facade around synchronous receipts/admission transaction, not an unbounded async queue. SQLite busy_timeout is10000ms. Other synchronous prompt cloning/estimation/credential operations occur before reservation, but the advancing wait.seen_at and exact wait row identify capacity as this incident's cause.
- Separate per-provider HTTP timeout starts only after a successful reservation/dispatch; this incident had not reached it.

Main and repair-hydration source SHA256 hashes matched for gateway/gate.ts, direct.ts and capacity.ts. This diagnosis applies to the active canary, not only main.

## Safe diagnostics

Read using better-sqlite3 with `{readonly:true,fileMustExist:true}`; never instantiate a write-capable runtime merely to inspect the store. Useful queries:

```sql
SELECT id,execution_id,status,reserved_at,endpoint_id
FROM model_requests WHERE execution_id = ?;
SELECT id,platform,kind,holder,task_id,lease_owner,priority,since,seen_at,
       uncertain,nonce IS NOT NULL AS bound_nonce,lease_json IS NOT NULL AS bound_lease
FROM provider_slots WHERE platform = 'ollama-cloud';
SELECT value FROM meta WHERE key = 'concurrency:ollama-cloud';
SELECT m.id,p.state,p.dispatch_id,p.expires_at,
       json_extract(p.binding_json,'$.slot.id') AS slot_id
FROM model_requests m LEFT JOIN request_protocol p ON p.request_id=m.id
WHERE m.status='reserved';
```

No credentials, key secrets, provider requests or state-changing operations were used. Do not infer capacity from reserved-request count alone. To restore progress safely, root needs an explicit supported reconciliation workflow which preserves unknown accounting/dispatch evidence and proves transport authority/quiescence; this investigation does not implement or approve one. Increasing configured capacity or clearing records is outside this read-only brief.

## Verification limits

Source and read-only DB observations confirm the exact wait. The300s timeout/defer path is source-verified; this worker did not keep polling until timeout and does not claim its live occurrence. No tests or paid/free provider requests were run, and no files other than this report were edited.

## Guarded recovery design requested by root (read-only recommendation)

No supported operator recovery action was found in admin/operations/MCP/web. Existing project purge is unsuitable: it deliberately anonymizes and retains physical holds. Existing lower-level primitives are sufficient for a bounded new service, but calling them directly is not an operator authorization/proof boundary:

- `RequestReceipts.bound` (private) validates request fingerprint and immutable reservation; `RequestReceipts.reconcile` synchronously binds original outcome and prevents conflicting settlements.
- `RequestLedger.reconcile` supports outcome `uncertain` and retains conservative original request/token charges and worst-case paid accounting. It never needs a fabricated provider response or a refund.
- `ProviderCapacity.release` matches exact nonce but has no owner-death proof and silently swallows persistence failures; it is not itself a safe operator recovery API.

Proposed placement: a narrowly named admission/transport-recovery service, exposed through an explicitly authorized operator endpoint/tool with project, exact request IDs and reason. Avoid generic slot deletion or changing concurrency limits.

1. Resolve original request_protocol/reservation/binding and project membership. Validate through existing zod schemas and canonical receipt/fingerprint checks. Require exact matching request ID, execution, slot ID+nonce+platform+owner, original participant lease array, request state and scoped authority. Refuse unknown/malformed/deleted/mixed-project evidence. Anonymous uncertain holds are outside this operation and remain untouched.
2. Require a request slot with `uncertain=0`, nonempty exact original local lease_owner and bound original dispatch_intent (or an exact prior recovery receipt). Require all participant owners to match the same original transport process. Do not treat expired task lease as proof; a live old process may still own HTTP transport.
3. Parse the existing service owner identity `hostname:PID:randomNonce`. Confirm the hostname is the actual local hostname. Probe the PID synchronously: only definitive ESRCH means absent. Alive, EPERM/access denied, malformed owner, remote host, unsupported process namespace or unknown result must refuse. If a PID exists even with another command/generation, refuse rather than guessing that its nonce differs. A PID absent now proves the original local process cannot run; a later reused PID cannot resurrect the old owner nonce. This proves local client transport stopped, not remote billing or remote generation outcome.
4. Re-read bindings and death proof immediately before mutation. Preserve all original model charges, request counts, provider-key quota reservations and conservative paid holds; never invoke key quota release or claim not billed. Record an uncertain owner_process_exited outcome for the ORIGINAL immutable reservation, then release only that exact local slot with guarded compare-and-swap. Do not clear unrelated held rows, retry the old request ID, permit an old lease to dispatch, update model quality, or increase capacity.
5. Persist a typed idempotent recovery receipt/audit containing actor, reason, project, request/slot/fingerprint/owner evidence and outcome. A changed nonce/owner/binding or conflicting settlement must fail closed. Repeating the same approved action must not decrement accounting twice or free a newly reused slot.

Transaction warning: RequestLedger.reconcile is async. Never invoke it unawaited inside immediate(db, callback); rejected promises do not roll back a synchronously committed transaction. Prefer a synchronous SQLite receipt/accounting adapter using the existing RequestReceipts.reconcile callback (including SqliteRequestLedger paid-spend adaptation), then exact slot CAS in one immediate transaction. If keeping the generic awaited ledger interface, use an explicitly durable two-stage operation: settle conservatively, then recheck owner death/binding and guarded slot release; a crash between stages retains the slot and retry must recognize the exact recorded recovery outcome. Do not turn uncertain into failed to make the operation easy. Slot deletion must report exactly one matched row, with rollback/refusal on mismatch; ProviderCapacity.release's void/swallowed-error behavior is insufficient for an auditable service.

Meaningful tests: dead exact local owner releases only its bound slot and keeps request/token/provider/paid charges; current owner or foreign hostname/EPERM/unknown probe refuses; old anonymous2holds untouched; expired lease with live process refuses; changed nonce/owner/project/mixed participants and conflicting settled outcome refuse; transaction failure leaves both accounting and slot recoverable; duplicate operation is idempotent; a stopped real child process can provide fake-provider transport-death evidence without paid/live provider calls; recovered capacity lets a separate fresh request proceed exactly once while old request remains non-replayable. Include the crash-between-stages case if choosing async orchestration.

This is a design recommendation, not executed recovery. No hold was cleared and no provider/budget/config state was changed by this worker.
