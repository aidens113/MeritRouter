# Pending-request deletion adversarial review

Status: Complete — adversarial review and authorized bounded session guard implemented; senior-supervisor verification pending.

Read-only source review; no builds, provider calls, user-data edits or live deletion.

## Required invariants and concrete hazards

- `RequestReceipts.beginDispatch` and `assertDispatch` consult durable private receipt bindings. Removing those bindings while retaining opaque `request_protocol_keys` rejects stale reservations and repeat dispatch even from already-running old code. A new lifecycle enum alone is less compatible: the old row schema rejects it rather than implementing its semantics.
- `gateway/direct.ts` awaits capture operations after reservation and before dispatch, so deletion may win that race. Both pre-dispatch guards must reject the removed binding. There is a cross-process interval after the final synchronous dispatch assertion and invocation; deletion cannot promise to stop an invocation that already passed its guard. Preserve its physical capacity hold.
- `purgeProjectRows` previously deletes all `provider_slots` by task. Strict request holds must instead keep exact id/platform/nonce identity, become `uncertain=1`, and detach identifying task/lease/holder fields. `gateway/capacity.ts` counts request nonce rows without a live task; old `release` only deletes `uncertain=0`, so quarantine remains effective against old finally callbacks.
- Merely preserving a hold is insufficient if its full `lease_json`, task id or holder survives as project-private recovery metadata. Preserve the minimum opaque identity needed for exact ownership/recovery. Never replace exact ownership with an arbitrary new nonce.
- Late old `SqliteRequestLedger.reconcile` first calls `RequestReceipts.bound`, so deleting the binding prevents its accounting callback from reintroducing errors, telemetry or citations. A new-version bypass to `Admission.reconcile` would need the same protection.
- `RequestCaptures.complete` cannot recreate a removed row, but `begin` can insert a new unavailable stub after deletion when the old request is anonymized and charges have gone. Explicit retained-request/tombstone refusal is preferable; check payload privacy, including no input under the empty-project scope.
- Dispatched unknown requests need worst-case usage/spend; reserved requests may be marked definitely unsent only when durable dispatch-intent ordering proves it. Preserve already-settled successful accounting, even with an outstanding strict hold. Do not use deletion to reset paid spend.
- `model_requests` retains private error text, route notes, telemetry and web citations beyond request-capture deletion. Scrub project-sensitive retained columns while retaining billing facts. The original receipt JSON also contains participant authority and must be removed.
- Do not erase foreign project holds/requests via an invalid or mixed `lease_json` broad match. Malformed ownership should be quarantined conservatively; attribution must be proved before scrubbing/removing another project's data.
- All lifecycle changes must occur within the outer delete transaction, after final config/activity/Lab ownership checks. A later purge failure must roll them back with the project rows; no independent committed abandonment first.

## Acceptance checklist for final implementation

Reserved, dispatch-intent, settled-success with hold, strict hold without receipt, late captures/outcome, stale replay/new reservation, unrelated-project isolation, failure rollback and repeat purge. Tests must assert nonce/id preservation and continued capacity counting, not only `uncertain=1`. Exact physical quiescence remains unproven for orphaned legacy holds; UI must disclose retained accounting/quarantine rather than say all transport stopped.

Findings and recommendations sent promptly to the implementation worker and senior supervisor. Implementation and test claims require independent senior-supervisor verification.

## Concrete filesystem callback follow-up

`runners/types.ts: ask` checks the lease again before logging a successful response, so deleted-task response content does not normally reach `modelResponse` or downstream response artifacts. Its error catch, however, calls `session.modelError` even after a persistence failure. `sessions/recorder.ts: append` originally opens the JSONL path in append mode and fsyncs bytes before checking SQLite session identity. A stale in-memory recorder can therefore recreate the removed JSONL with private error material before the missing-session index update fails. Root and implementation worker were notified. Recommended narrow fix: establish durable session existence inside the same immediate transaction covering append, so purge and append serialize; test a recorder retained across actual session/project deletion. Already-running old binaries cannot inherit a new recorder guard, a rollout limitation that must be handled/disclosed for live cleanup.

`storage/artifacts.ts: write` likewise creates directories/files before its FK-backed insert. The usual model-completion path is protected by `ask`'s post-request lease check, but direct stale tool/writer callbacks require a durable owner guard before filesystem writes. Do not claim all private callbacks are safe merely because SQLite rejects the eventual insert.

## In-progress implementation inspection

Observed new implementation removes private receipt bindings, retains opaque key/tombstone digests, guards retired reconcile without invoking accounting mutation, bounds tombstone pruning to expired rows without retained exact slots, and preserves request-slot id/nonce while setting quarantine and detaching private authority. These address the dispatch/reconcile/hold hazards above. Inspection is preliminary; tests were not run by this reviewer and final patch remains subject to supervisor checks.

## Authorized late-session guard implementation

Root extended the brief to authorize only `sessions/recorder.ts` and `tests/project-delete-late-session.test.ts`. Recorder construction captures validated durable identity (rowid, creation time, log path, task/job owner and role). Append now obtains SQLite's immediate write transaction before checking that identity, opening/writing/fsyncing the log, and updating its index. Project purge uses the same write serialization, so a deleted or replaced session fails before filesystem writes. Durable lines remain recoverable if indexing fails; errors are not swallowed.

Observed validation: `pnpm exec vitest run tests/project-delete-late-session.test.ts tests/sessions.test.ts` — 2 files, 17 tests passed. New tests cover an actual `purgeProjectRows` followed by removed-log late `modelError`/note calls, changed durable session identity without log mutation, and an injected index failure retaining its fsynced line for recovery. Existing fourteen session tests passed. No broad build/full suite/live data changes.

Rollout limitation remains: a separate process already running the older recorder implementation does not acquire this new guard until restarted. Receipt removal still prevents its accounting mutation and future dispatch, but its own legacy error logger could recreate a file; senior supervisor must handle old-process rollout before claiming universal live callback privacy.

## Authorized late-capture guard

Root additionally authorized `storage/request-captures.ts` plus `tests/project-delete-late-capture.test.ts`. `begin` checks the opaque deletion tombstone inside its existing immediate transaction, before examining/inserting capture rows. A retired request cannot recreate even an unavailable capture stub with either its original participant list or an empty list. Genuine global taskless requests remain supported. Actual Gate reservation/dispatch/settlement followed by `purgeProjectRows` exercises the real tombstone path.

Observed validation: `pnpm exec vitest run tests/project-delete-late-capture.test.ts tests/request-capture.test.ts` — 2 files, 8 tests passed. Combined with the session run above, 25 focused assertions/tests passed across four files. Existing older processes do not acquire the new explicit capture guard until restart; their lost scope/participant checks previously prevented private input resurrection but could recreate an unavailable metadata stub.

## Senior-supervisor integration verification

45 independent focused tests, recursive typecheck and recursive build passed. A missing
endpointId in the new global capture test fixture was corrected before typecheck passed.
Full router run: 144 files passed, 1 failed, 1 skipped; 1,365 tests passed, 1 failed, 3 skipped in 832.15s. The sole failure was labs-browser.test.ts:171 waiting 20s for browser_check_started under concurrent load. The exact failed cancellation case passed independently (11.39s; 1 passed/7 skipped), without source changes. All requested deletion, admission, ledger, accounting, rollback and late-callback cases passed. Initial full run was not wholly green; do not describe it as such.

Facebook and Instagram were deleted using the grid and both confirmation modals. Final
grid/API and read-only row verification confirm absence, preserved source folders, no clone
worktrees or Brain folders, and2anonymous transport holds. One locked worktree cache was
removed using the feature cleanup routine with the panel stopped; final panel restarted
and browser checked at http://127.0.0.1:4477. No live provider calls or manual DB mutation.
