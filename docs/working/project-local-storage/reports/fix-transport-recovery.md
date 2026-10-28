# fix-transport-recovery

## Outcome

Done. `tests/transport-recovery.test.ts` passes 31/31: the original 27, plus 4 new cases for slots that carry split-store authority. The CLI case passes against a rebuilt `dist/`. `team-capacity` passes 8/8. `npx tsc --noEmit` is clean.

## What changed and why

Cause (confirmed by reproduction, 24/27 failing with ZodError `unrecognized_keys`):

- `provider_slots` gained `project_uuid`, `store_uuid` and `store_generation` in 87f0945 ("Add isolated global request accounting broker").
- It gained `execution_grants_json` in 121be75.
- `Slot` in `src/operations/transport-recovery.ts` is a strict zod object over `SELECT *`, so every inspect and reconcile call threw.

### Design decisions, with evidence

1. **Which authority each slot shape has.** `ProviderCapacity` writes the four columns only when `grants` is set, which means `attachCoordination` (split project Gate, coordination store) was used. See `tryAcquire`, `wait` and `recordProjectClaim` in `src/gateway/capacity.ts`.
   - Legacy `attach` never sets them.
   - A legacy holder cannot obtain a split-tagged slot: in split mode `splitHolder` requires `executionGrants` and throws without them.
   - `TransportRecovery` works only on the single-store request protocol in one db (`RequestReceipts`, `model_requests`, `request_charges`, `paid_spend`). So a legitimate recovery candidate always has all four columns NULL.
2. **Release path.** Split slots are released only through `ProviderCapacity.release`/`releaseReconciled`. Both refuse while the broker's `physical_requests` row is `dispatch_intent`, uncertain or quarantined.
   - Deleting such a slot with raw SQL would free global provider capacity while the broker still records the physical request as dispatched.
   - Recovery therefore **refuses** any slot with a non-null split column, in both `inspect` and `reconcile`. The error is "transport slot carries split-store coordination authority; single-store transport recovery cannot release it". Nothing is mutated.
3. **Execution grants.** Releasing a slot must not settle grants. Neither `release` nor `releaseReconciled` touches `project_execution_grants`.
   - Grants are task-execution authority with their own lifecycle (`consume`, `complete`, `revoke`, renewal) and are bound to task leases, not to one request.
   - Because split slots are refused, recovery never touches grants or the project store binding.
4. **slotDigest.** The four columns were added to the strict `Slot` shape as nullable. `digest(slot)` and the snapshot digest now cover them.
   - The shape stays `.strict()`, so a future column fails closed again and forces a review, which was the original intent.
   - Replay does not recompute `slotDigest` (it checks that the slot row is absent), so receipts committed earlier still replay.
5. **CAS.** The release `DELETE` now also requires all four columns `IS NULL`. A slot re-tagged between the candidate read and the delete therefore loses the compare-and-swap.
6. **Not routed through `capacity.ts`.** The legacy `ProviderCapacity.release` is weaker (it checks id, nonce and uncertain only) and swallows errors. `releaseReconciled` exists only for split slots. Recovery needs an exact CAS inside its own `immediate` transaction, so the existing raw CAS stays, extended as above. `capacity.ts` is unchanged.

Every existing refusal is unchanged: live or unknown owner, live captured lease, foreign host, a reused PID on replay, and changed accounting, charge or paid binding. All of those tests still pass.

Files:

- `packages/router/src/operations/transport-recovery.ts`: `Slot` shape, the `SPLIT_SLOT_COLUMNS` refusal, and the CAS.
- `packages/router/tests/transport-recovery.test.ts`: one new `it.each` with 4 cases, one per column. Each sets the column after an eligible inspection, then asserts:
  - `inspect` and `reconcile` both throw;
  - the model request stays `reserved`;
  - `dump()` is unchanged.

CLI wiring (`src/cli.ts` `transport` case) needed no change.

## Commands run and observed results

- `npx vitest run tests/transport-recovery.test.ts` (before the fix) gave 24 failed, 3 passed (27), all ZodError `unrecognized_keys`.
- `npx tsc --noEmit` printed nothing, exit 0. It was run after editing and again at the end; tsconfig includes `src` and `tests`.
- `npx tsc -p tsconfig.build.json` printed nothing (`dist/` rebuilt).
- `npx vitest run tests/transport-recovery.test.ts` (after the fix) gave 31 passed (31), including "actual CLI inspects and reconciles an exact stopped local child without any provider calls".
- I ran all 29 test files that match `capacity|provider_slots` in one parallel vitest run:
  - First result: 26 failed, 344 passed.
  - The failures were timeouts ("Matcher did not succeed in time", "Test timed out in 60000ms") and Windows EBUSY on unlink.
  - They were spread across execution, projects-router-fixes, resilience, roadmap-team, task-recovery-retention, team-capacity and verification-calibration. None of these imports or exercises transport recovery.
- `npx vitest run tests/team-capacity.test.ts` alone gave 8 passed (8).
- The 6 other failing files run serially (`--no-file-parallelism`) gave 58/58 passed across 6 files, `success: true`.

## Not verified

- Recovery for split-project transports does not exist. It is now refused explicitly rather than by a ZodError. I did not check what an operator should run instead for a dead-owner split slot whose broker row is stuck in `dispatch_intent`.
- I did not run the full router suite or `pnpm -r typecheck`/`build`.
- The parallel-run timeouts were not root-caused beyond showing that the same files pass serially. Other workers were editing and testing in the same checkout at the same time: `src/workspaces/merge-queue.ts`, `tests/labs.test.ts` and untracked `tests/zz-*` files were modified. That may have added contention.
- The rebuilt `dist/` includes other workers' uncommitted source in its current state.

## Open questions or contradictions found

- The brief says the columns came from 121be75. Only `execution_grants_json` did; the other three are from 87f0945 (migration "Global split-store accounting has no FK to project-private task/execution rows"). The fix is the same either way.
- Gap: in split mode there is no operator path to reconcile a dead local owner's coordination slot and `physical_requests` row. `releaseReconciled` needs an authoritative settled or retired receipt and never produces one. This needs a lead decision, probably a broker-side recovery that settles `physical_requests` as uncertain and then calls `releaseReconciled`.

---

# Follow-up: split-store operator transport recovery (lead brief after 577f6d2)

## Outcome

Done.

- `meritrouter transport inspect|reconcile` now picks the recovery for the installation's layout. Split installations, now the default, get a new `SplitTransportRecovery`. Legacy installations keep `TransportRecovery`, which is unchanged.
- The evidence standard is the same as legacy: same host, owner PID absent via ESRCH only, no live captured lease, snapshot digest re-checked inside the transaction, and an idempotent receipt.
- One coordination transaction does three things:
  - it settles the broker's `physical_requests` row `uncertain`;
  - it releases the exact request slot;
  - it records the receipt.
- The project ledger then projects that settlement into the project store.
- `project_execution_grants` is never read for authority and never written; tests assert the table is unchanged.
- `src/storage/migrations.ts` is unchanged; no schema change was needed.

## What changed and why

- **`src/admission/sqlite-accounting-broker.ts`**
  - The settled write in `settleGlobal` was extracted unchanged into `applySettlement`.
  - New `settleAbsentTransportOwner(input, { guard, commit })`, for trusted operator use only. It requires all of the following, else it refuses with `state` or `slot`:
    - status `dispatch_intent`;
    - the exact `dispatchId`;
    - the exact slot id and nonce;
    - not cost-quarantined and not unbounded.
  - It then runs `guard`, settles with `outcome:"uncertain"`, tokens `null`, `actualUsd:null`, `costBasis:"uncertain"` and `errorCode:"unknown"`, and runs `commit`, all in one `mutation`.
  - Paid amounts: `actual_usd` stays NULL and `liability_usd = MAX(liability, 0)`, which keeps the reservation. `ACCOUNTING_SPEND_SQL` counts `COALESCE(actual, liability)`, so spend is unchanged; the test asserts `projectAccountingSpendSince` is equal before and after.
  - Nothing is refunded or reset, and `provider_usage` quota is untouched.
  - `accounting-usage.ts` needed no change.
- **`src/gateway/capacity.ts`**: new `SplitRequestSlotSchema` and `releaseOwnerAbsentSlot(db, slot, outcomeDigest)`.
  - It runs only inside a coordination-store transaction.
  - It requires this slot's physical receipt to be `settled`/`uncertain` with exactly that outcome digest, not quarantined, and with a matching project, store and generation.
  - It then deletes the slot with a full-row compare-and-swap that also covers `execution_grants_json`.
  - **Deviation from the brief:** I did not reuse `releaseReconciled`.
    - By design it refuses `outcome='uncertain'`, because a live owner's remote request may still be running, and `release()` holds those slots for the same reason.
    - It also needs an in-process split-attached `ProviderCapacity` (with grants), which the CLI process does not have.
    - Widening it would let any in-process caller free an uncertain hold. The new function is the narrower equivalent, keyed to the operator's settlement.
- **`src/operations/transport-recovery.ts`**: new `SplitTransportRecovery` and `SplitRecoveryProject`.
  - The candidate cross-checks the broker receipt, the project-store registration (registered, same store and generation), the project `project_request_protocol` record and the slot. The record must be in phase `dispatch_intent` or `uncertain`, have the same dispatch id, and have **no durable local outcome**; otherwise it is refused, because the project ledger must settle that outcome.
  - Slot checks: id and nonce, provider and platform, project/store/generation, participant leases and owner, `uncertain=0`.
  - It also checks the project's `model_requests` row is still `reserved` and its `request_charges` are unchanged. All of these feed `snapshotDigest`.
  - `reconcile` sequence:
    1. Look for a replay.
    2. `settle()`: candidate, then digest, then the broker method. The broker's `guard` re-reads the candidate and digest and re-probes the PID and lease inside the transaction. Its `commit` releases the slot and INSERTs the receipt into coordination `meta` under `transport_owner_reconciled:<requestId>`.
    3. Project into the project store.
  - Why `meta`: `events` is a project-local table. Coordination `meta` already holds coordination records (`concurrency:*`, `quarantine_ack:*`). The plain INSERT means only one receipt can ever exist per request.
  - **Race handling:** if `settle()` fails because an identical recovery committed first, the call returns the committed receipt as `replayed`, wherever the other one committed: before the candidate read, or while this one waited for the coordination lock.
  - **Projection:** it calls the project's own `ProjectRequestLedger.recover`, which binds the receipt and applies the settlement: `model_requests` becomes `uncertain`, charges stay as estimates, the phase becomes `settled`.
    - It is a second step in a separate store. A failure returns `projection:"pending"` plus `projectionError`, and an identical replay retries it.
- **`src/cli/transport.ts`** (new) and **`src/cli.ts`**: wiring.
  - The split path builds a broker with a deny-all `authorize`, so it can settle but never admit or dispatch.
  - It resolves the project through the public `sy.projectStores(slug)`, which must be a runtime bundle with a ledger.
  - `reconcile` is now awaited. The help text is unchanged and still accurate.
- **`tests/split-transport-recovery.test.ts`** (new, 22 tests):
  - A dead owner gets an uncertain receipt and its slot is freed exactly once (paid and free). Covered: the other live slot, the uncertain slot, grants, quota, charges and tasks unchanged; the second compare-and-swap fails; a replay leaves the stores identical.
  - Replay is idempotent with a reused (live) PID; a wrong `expected` and a foreign project are refused.
  - A live or unknown owner is refused.
  - A PID reused after an eligible inspection is refused.
  - A live captured lease, a foreign host and an unrecognised owner are refused.
  - 8 stale-state mutations after inspection are refused with the stores unchanged.
  - If the receipt write or the release fails, everything rolls back atomically.
  - A failed project projection is reported as pending, then applied on replay.
  - Both race points return replayed.
  - An actual CLI end to end on a real split installation (`createSplitProject`, project ledger reserve and beginDispatch, dead child PID), with two concurrent reconciles giving fresh and replayed and no provider calls.
- **Line endings:** `capacity.ts` was checked out CRLF. My append was normalised to CRLF to match; git stores LF (`eol=lf`).

## Commands run and observed results

- `npx tsc --noEmit` exited 0 with no output; it was run after each change.
- `npx tsc -p tsconfig.build.json` exited 0; `dist/` was rebuilt after the final source change.
- The first full acceptance run, serial (`--no-file-parallelism`), gave 152/152, `success: true`:
  - `transport-recovery` 31, `split-transport-recovery` 21, `team-capacity` 8, `project-accounting-broker` 26, `project-accounting-protocol` 18, `project-capacity` 31, `project-request-protocol` 4, `paid` 13.
- A serial run of the split, broker and gate suites gave 140/140:
  - `gate-request-ledger`, `project-brain-web-isolation`, `project-cli-operations`, `project-delete-pending-requests`, `project-entrypoint-isolation`, `project-gate-isolation`, `project-queue-isolation`, `project-runtime-activation`, `project-runtime-registry`, `project-service-activation`, `project-tool-store-isolation`, `qualification-split-store`, `request-admission-protocol`.
- One serial run of `split-transport-recovery` plus `transport-recovery` failed the split CLI test once. I could not reproduce it in 5 reruns.
  - Diagnosis: a real race. The concurrent second CLI process could run `candidate()` after the first one committed, and that throw sat outside the replay fallback.
  - Fixed by covering the whole fresh path (`settle()`).
  - Added a deterministic test for that race point ("before its candidate read").
- The final serial acceptance run gave 170/170, `success: true`: the set above plus `gate-request-ledger` and `project-gate-isolation`, with `split-transport-recovery` now at 22.
- The split CLI test, rerun alone 3 more times after the fix, passed 3/3.

## Not verified

- I did not run the full router suite, `pnpm -r typecheck` or `pnpm -r build`.
- The 140-test serial run happened before the final `transport-recovery.ts` race fix. None of those suites use transport recovery, and the broker has not changed since.
- I did not exercise a real crashed worker process mid-request; the CLI test uses a stopped child PID as the lease owner.
- Paid split rows are covered only by the direct fixture: `ProjectRuntimeHost.endpointAuthority` currently refuses paid routes for split projects.
- Docs are not updated. `docs/operations.md` (recovery) should describe split transport recovery; that is outside my owned paths.

## Open questions or contradictions found

- The brief said to settle and then call `releaseReconciled`. That function refuses uncertain outcomes by design, so I used a narrower operator-only release instead (see above). Please confirm this is acceptable.
- **The project projection can stay pending.** Once the broker row is settled, `pendingParticipants` blocks new admission for that task until the projection applies. The projection fails if the participant task was re-created with a new incarnation (`assertOriginalProjectParticipants`); the evidence is kept and the receipt says `projection:"pending"`. I believe it does not fail for an ordinary reclaim of the same row; this is unverified.
- **Remaining gap 1:** a split request with a durable local outcome but an unsettled broker row is refused here as "project ledger recovery must settle it". `ProjectRequestLedger.recover` has no caller anywhere in `src/` (only tests), so nothing runs it automatically.
- **Remaining gap 2:** split slots whose physical row settled `failed` with `timeout` or `provider_error`, or settled `uncertain` by the live owner, are held forever by `release()` and `releaseReconciled`, and this tool does not cover them.
- Both gaps likely need a lead decision.

---

# Follow-up 2: pilot blockers — split slot leak and the uncalled ledger recovery (lead brief after d9f95f2)

## Outcome

Done. Both gaps are closed, plus a third leak the reproduction test exposed.

1. **Slot leak (reproduced through the real Gate first).** I ran `tests/split-slot-settlement.test.ts` before changing anything: a split installation, one slot per provider, a scripted provider that fails.
   - 408 timeout: the physical receipt settled `uncertain`/`timeout`, the slot stayed held, and the task sat in `waiting_for_capacity`.
   - 502: same as the timeout.
   - 400: settled `failed`/`provider_error` and the slot stayed held.
2. **Key-level retry leak (found by the same test with two keys).** A 429 on key 1 retried key 2 on the *same* slot.
   - The broker refuses a second physical request per slot (`physical_requests_slot_authority` unique index, `reserveGlobal` → `conflict`).
   - The ledger turned that into a `RequestPersistenceError`, and `direct.ts` quarantined the slot (`uncertain=1`), which is a permanent leak. The task failed with `internal_error ... Global accounting refused: conflict`.
   - This matters for a multi-key free provider.
3. **Ledger recovery wired in.** A durable local outcome left before broker settlement is now settled automatically by a restarted worker, exactly once.

## What changed and why

- **`src/gateway/capacity.ts`**
  - **`release()` (split mode).** The live owner frees its slot once the physical receipt is terminal, *whatever the outcome*. The hold remains only while the row is `dispatch_intent`, cost-quarantined or unbounded. The rule that also held `outcome='uncertain'` and every `failed` except rate_limited, authentication and policy is gone.
    - Why this is safe: every settlement path runs after the transport call returned. That is the live owner after the call, startup recovery from a durable outcome, or the operator after proving the owner dead. Holding capacity proves nothing once the receipt is terminal.
    - Legacy mode already released unconditionally.
    - Accounting is untouched. An uncertain receipt keeps `actual_usd` NULL with the reservation counted as liability, so nothing is refunded. Failures keep the existing settlement semantics.
  - **`releaseReconciled`** is aligned to the same terminal-receipt rule, which keeps the cost-incident refusal. It still has no production caller.
  - **New `releaseSettled()` sweep.** It deletes split request slots whose exact receipt (by `slot_id`+`slot_nonce`) is settled or retired with no cost incident. This covers a crash after settlement but before the owner's `finally` release, and slots quarantined by persistence uncertainty whose receipt later settled. A live owner releasing afterwards finds no row.
- **`src/gateway/direct.ts`**: after a key-level failure, split mode releases the slot (its receipt is already terminal) and the next key acquires its own slot. Legacy keeps reusing the slot; that branch is guarded by `capacity.splitMode`.
- **`src/admission/project-request-recovery.ts`** (new): `recoverProjectSettlements`. For each project request not yet settled or retired it:
  - skips the request if any participant's captured lease is still live (its owner may be settling it right now);
  - skips cost-quarantined or unbounded receipts;
  - otherwise calls the project's own `ProjectRequestLedger.recover` only when durable evidence already decides the outcome: a saved local outcome (global settle, then local projection) or a settled or retired global receipt (projection only).
  - It never reserves or dispatches. Dispatch intent without an outcome is left to `transport reconcile`, and prepared requests are not re-admitted.
- **`src/core/project-runtime-host.ts`** (recovery wiring only):
  - `start()`, which runs only in worker processes, now runs `recoverSettlements()` immediately and then every `max(1s, execution.lease_seconds)`. The timer is unref'd and the pass is single-flight. Each pass runs `recoverProjectSettlements` for every registered bundle, then `health.capacity.releaseSettled()`.
  - `close()` clears the timer and awaits an in-flight pass before draining the bundles.
  - Nothing touches execution grants.
- **Tests**
  - `tests/split-slot-settlement.test.ts` (new, 5 tests):
    - timeout, 502 and 400 cases (real Gate, split, 1 slot): slots return to 0, a later request is served, and receipts keep `uncertain`, `uncertain` and `failed` respectively;
    - a two-key 429 retry that completes and leaks nothing;
    - a crash and restart: durable local outcome with broker `dispatch_intent` and the lease expired, then close, then reopen with `worker:true`. Result: broker settled `succeeded` 80/20, local phase `settled`, `model_requests` and `request_charges` exact, the slot freed, and a second `recoverSettlements()` pass changes nothing.
  - `tests/split-transport-recovery.test.ts`: 3 `recoverProjectSettlements` cases.
    - A live lease is skipped; after expiry the request settles; a second pass leaves the stores identical.
    - Dispatch intent without an outcome is untouched, and so is a cost-quarantined request.
    - An interrupted operator projection is completed.
  - `tests/project-capacity.test.ts`: the test "refuses uncertain/failed_timeout physical hold release" encoded the old design, so it now asserts the new contract. Uncertain and failed-timeout release (held 0); unbounded is still held (held 1); the receipt still reads `settled`, the original outcome, and `actual_usd` NULL. A new case covers a quarantined slot released by `releaseReconciled` and an orphaned slot freed by `releaseSettled`.
- **Proof the tests catch the bugs.** I temporarily reverted the fixes, then restored them byte-for-byte from scratch copies.
  - With the old release predicate and no key-retry change, the timeout and client-error cases failed ("condition not reached": slot never freed) and the key-level case failed (task not completed).
  - With startup recovery disabled, the restart case failed ("condition not reached").

## Commands run and observed results

- `npx tsc --noEmit` exited 0 and `npx tsc -p tsconfig.build.json` exited 0. `dist/` was rebuilt after the final source change, a comment-only edit in `capacity.ts`.
- The serial 170-set, now 174 tests (project-capacity +1, split-transport-recovery +3), gave 174/174 with `success: true`:
  - transport-recovery 31, split-transport-recovery 25, team-capacity 8, project-accounting-broker 26, project-accounting-protocol 18, project-capacity 32, project-request-protocol 4, paid 13, gate-request-ledger 12, project-gate-isolation 5.
- A serial batch gave 68/68: split-slot-settlement 5, project-service-activation 9, project-runtime-activation 3, project-delete-pending-requests 6, project-queue-isolation 24, project-runtime-registry 21.
- providers-routing plus gate-request-capture, which exercise `direct.ts`, gave 32/32.
- Before the project-capacity update, the first batch run gave 171/173: the two old-contract cases failed as expected.

## Not verified

- I did not run the full router suite or the `pnpm -r` checks.
- I did not test against real Ollama Cloud. The provider behaviour is scripted (408, 502, 400, 429).
- The restart test forces the lease to expire. A real crash where the scheduler re-claims the task with a new incarnation before recovery runs would leave the local projection pending: the broker is still settled and the slot freed, but `assertOriginalProjectParticipants` refuses. I did not reproduce that ordering.
- Recovery runs only in worker processes (`host.start`). A deployment with no worker never runs it.

## Open questions or contradictions found

- **Uncertain release is a policy change.** It matches legacy and the brief. The trade-off is that a request still running remotely after a client-side timeout no longer occupies a local slot. Paid exposure is unaffected, because the reservation stays as liability.
- **`releaseReconciled` was broadened.** It still has no production caller; `releaseSettled` is the sweep actually used.

## Text for `docs/operations.md` (split transport recovery)

> ### Split installations: stuck provider slots and requests
>
> In a split installation (the default), each physical model request is recorded in the shared coordination store (`physical_requests`) and holds one provider slot until its receipt is terminal.
>
> - **Normal settlement.** The worker that sent a request frees its slot as soon as the request settles, whether it succeeded, failed (for example a 4xx or a rate limit) or became uncertain (for example a timeout or a 5xx after sending). Accounting is unaffected. Uncertain requests are never refunded: tokens stay estimated, and paid reservations stay counted as liability. A key-level refusal retries the next key on a fresh slot.
> - **Automatic recovery after a crash.** Every worker, at start and then about once per task lease, settles requests that a stopped worker left with durable evidence. A saved local outcome is settled globally and recorded in the project exactly once; a settled global receipt is copied into the project. The worker then frees every slot whose receipt is terminal. It skips requests whose task lease is still held, and it never sends, re-admits or invents an outcome.
> - **Operator recovery for a dead owner.** A request whose owning process died after dispatch, with no saved outcome, stays in dispatch intent and keeps its slot. Recover it explicitly on the same host:
>
>   ```
>   meritrouter --project <slug> transport inspect <requestId> --json
>   meritrouter --project <slug> transport reconcile <requestId> --expected <snapshotDigest> --reason "<why>"
>   ```
>
>   Reconcile refuses unless the owner process is proved absent (ESRCH only), no captured task lease is live, and nothing changed since inspection. It refuses any request that has a saved local outcome or a cost quarantine. It settles the physical request as `uncertain` (no refund), frees exactly that slot and records a receipt (coordination `meta` key `transport_owner_reconciled:<requestId>`), all in one transaction. It then copies the settlement into the project store. If that copy fails, the result says `projection: "pending"`; rerun the same command to retry it. Retries return the same receipt as `replayed`. Execution grants are never changed.
> - **Not recovered automatically.** A slot held because a request is cost-quarantined (unexpected or unbounded cost) needs the quarantine resolved first. A slot marked uncertain by a persistence failure, whose request never settled, needs operator review.
