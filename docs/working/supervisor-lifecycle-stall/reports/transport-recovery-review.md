# Independent dead-owner transport recovery review

Reviewer: repair_hydration_review
Date: 2026-10-25
Status: Independently reviewed and narrow regressions passed; clear for supervisor integration
Scope: D:/SwitchYardRouter-transport-recovery; no production/runtime/provider changes by reviewer.

## Design disposition

No design blocker in the approved explicit operator workflow. It distinguishes definitive local HTTP-owner absence from unknown remote request/billing outcome, preserving conservative original accounting. Only exact identified nonce-bound slots are eligible; anonymous historical holds remain outside the operation.

## Required implementation checks

- Same actual local hostname and positive PID; only ESRCH proves absence. Live/reused PID, EPERM, foreign hostname or unknown probe refuses. Original captured lease must no longer be live, even if a different current task lease exists.
- Canonical immutable protocol/reservation/slot snapshot and digest, exact original request/dispatch/fingerprint/participants/project/owner/nonce identity. Current lease cannot replace original reservation authority.
- One synchronous IMMEDIATE transaction with synchronous RequestReceipts/Admission/Paid reconciliation, exact slot DELETE changes1 and typed durable audit receipt. Exceptions and zero/multiple-delete mismatch must roll back every accounting/protocol/slot/audit effect.
- Outcome remains uncertain; original request/token charges, paid worst case and provider-key quota reservations stay conservative. No release/refund API, replay, cap increase or task-state mutation.
- Audit-first exact retry returns the original committed receipt without reprobing a possibly reused PID or writing again. Changed digest, conflicting terminal outcome, missing/ambiguous audit or reappeared slot refuses.
- Late provider settlement cannot overwrite uncertain reconciliation or affect a new unrelated slot. Old two anonymous holds must remain unchanged.
- CLI-only trusted operator action; no model-controlled tool or caller-supplied process proof. Passive invocation must not start workers/providers.

## Work performed

Read main Current State, transport-recovery-design.md, gate-wait-discovery.md, written review/implementation briefs and current change inventory. Source was still in progress; no tests were run against an unfrozen tree. Sent code-review requirements to root and implementer and requested a final frozen receipt.

No source/test/shared-doc edits, commits, deployments, live store/configuration mutations or provider calls. Only this report was written.

## Provisional implementation review

Found one blocking identity gap in `RequestReceipts.inspectBinding`: `bound(reservation)` follows the reservation's own request ID, while the outer comparison omitted equality of that reservation request ID/fingerprint to the inspected protocol row. A second valid reservation with otherwise identical accounting authority could therefore be substituted, allowing settlement of request B alongside release of request A's slot. Reported to root and implementer with the required explicit identity/fingerprint guards and two-reservation substitution regression. Awaiting focused correction and final freeze.

Other inspected paths are sound: synchronous RequestReceipts ? Admission ? SqliteRequestAccounting ? PaidSpend calls remain within the outer IMMEDIATE transaction; the async runtime ledger adapter is not used. Uncertain settlement retains charge estimates and paid worst-case amount, with no provider quota mutation. Exact slot deletion requires changes=1, and the typed project-scoped event insert participates in the same atomic transaction. Live/unknown/foreign process ownership and captured live original lease refuse. Replay checks original outcome, project, model, dispatch and absent original slot before returning the prior receipt.

Read current source and 26-case test structure. Implementer's final focused run is in progress; no reviewer test run yet.

The implementer corrected the cross-row identity issue by checking reservation.requestId and reservation.fingerprint against the inspected protocol row before following the reservation. Reviewed the added regression: it creates a genuine second reserved/dispatched request sharing the original execution/participants, substitutes its valid reservation JSON into the first row, requires both inspection and reconciliation to refuse, confirms the second request remains reserved, and compares the complete relevant table dump unchanged. Source review now has no remaining blocker; independent narrow execution awaits the implementer's completed frozen run.


## Final validation and disposition

Final frozen source reviewed after the identity correction. Independently ran in the isolated feature checkout:

`pnpm exec vitest run tests/transport-recovery.test.ts -t "valid second reservation|idempotently|rolls back|rechecks process|actual CLI"`

Observed PASS: 9 passed, 18 skipped, 8.11 seconds total. This covers substituted valid reservation refusal, audit idempotence, transactional rollback fault stages, fresh process/lease checks after inspection, and an actual CLI subprocess using a stopped local fake fixture owner with zero provider calls. Implementer separately reports final three-file 51/51 and typecheck/build passing; these broader results were not independently rerun by this reviewer.

No remaining blocker found. Clear for supervisor integration and supervisor-owned broader checks. This review does not claim the six real held slots have been reconciled, nor that the actual Facebook app has been built or tested. No live state, provider quota, project configuration or source/test files were changed by the reviewer.
