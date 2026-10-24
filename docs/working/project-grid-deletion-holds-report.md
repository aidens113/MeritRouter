# Clone request-hold investigation

Status: Historical read-only investigation; superseded by pending-request deletion lifecycle.

The new implementation separates deleting private project data from reclaiming physical
capacity. Pending requests are retired with conservative accounting and anonymous transport
quarantine; no fabricated quiescence proof or raw hold deletion is needed. See
[implementation report](project-grid-deletion-pending-report.md). The findings below describe
the earlier blocking implementation; safe physical capacity recovery remains separate.

## Finding

The deletion refusal is deliberate. `admin/projects.ts:331` reads `RequestReceipts.blockers` before any destructive operation and again during deletion/purge. The reported two unresolved requests and two holds were provided by the supervisor; this worker did not inspect live data.

`admission/request-receipts.ts` counts a project-associated `request_protocol` row whose state is not settled, independently of `provider_slots` strict request holds. Slots with nonce or lease JSON remain held even after task completion, lease expiry, or client death. `gateway/capacity.ts` explicitly keeps these in LIVE_SQL. `release` refuses uncertain slots; `quarantine` has no matching supported recovery operation. Cancelling tasks, waiting, restarting the panel, archiving, or disabling concurrency does not establish safe settlement.

No existing panel API, CLI command, MCP tool, or admin export reconciles these blockers. Searches of those surfaces find only the deletion guard. The public `sy.gate.ledger.reconcile(reservation, outcome)` method settles a correctly bound receipt/accounting outcome, but does not release quarantined transport holds. Calling it requires the original immutable reservation and truthful outcome; it is not a complete operator cleanup workflow.

## Accounting and physical transport are different

- A `reserved` receipt has no dispatch intent. After excluding an active owner that could still dispatch, it can be settled as definitely unsent failed.
- A `dispatch_intent` receipt could have reached the provider even if no local response survived. After proving local transport quiescence, settle conservatively as uncertain, retaining reserved token charges and worst-case paid accounting. Never label it failed/not billed merely because its process died.
- An already settled receipt is immutable: identical outcome replay is idempotent; a conflicting outcome is rejected. A leftover hold can exist despite successful accounting settlement (covered by `request-admission-protocol.test.ts`). Do not replace successful accounting with uncertainty just to remove a hold.
- Local transport termination establishes that this client cannot dispatch/respond further. It does not establish remote cancellation, usage, or billing. The request tombstone must remain, and no retry/replay may send again.

Current persisted holds do not contain an OS process start identity or durable transport-completion proof. A task owner/run/incarnation plus old timestamp is not proof that the owning transport is gone. Never recommend direct database deletion or task-state mutation as recovery.

## Smallest enforceable repair

Add a narrowly scoped request-recovery service, not a deletion-guard exception:

1. `admission/request-receipts.ts`: validated metadata-only recovery preview returning exact request/fingerprint/state/dispatch identity, slot id/nonce and project participants; avoid exposing binding JSON, prompts, or credentials. Add transactional compare-and-set recovery that uses the normal ledger accounting and immutable settled-outcome rules.
2. `gateway/capacity.ts`: exact id/nonce recovery release gated by service-owned quiescence proof, never a generic force-clear API. Preserve all other projects' holds and newly acquired generations.
3. `gateway/gate.ts` and, if needed, appended `storage/migrations.ts`: record durable transport owner/completion identity for future attempts; fence recovered attempts against later dispatch. A process-local active-request map alone cannot prove other client processes are dead. Legacy rows require a verified exclusive maintenance path that prevents all clients using this store while the operator establishes that old owning processes are stopped; absent that proof, refuse them.
4. New `admin/request-recovery.ts`, re-exported by `admin/insights.ts`, plus an authenticated same-origin project recovery API and UI: preview before action, exact request selection, explicit confirmation of conservative unknown-billing preservation, proof validation, one transaction for accounting and exact hold release. Require all request participants to belong to the requested project and refuse live owners, unknown ownership, changed fingerprints/nonces, or active task generations.

Acceptance: exact legacy fixture reproduces blocked deletion; unproven/live transport remains blocked; proved unsent reservation settles failed; dispatched unknown remains conservatively charged; already successful accounting stays unchanged; repeat recovery is idempotent; late original dispatch and reused slot/lease identities cannot proceed; cross-project recovery rejected; rollback preserves receipt/hold if settlement fails; recovery audit/tombstones remain after project deletion. Only after recovery should the normal existing UI deletion run again.

No source, tests, builds, provider calls, live database/config/data, or commits were changed by this investigation.
