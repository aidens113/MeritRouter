# Exact dead-owner transport reconciliation implementation

Status: Complete (worker result; root independent checks/release remain)
Workspace: D:/SwitchYardRouter-transport-recovery
Branch: feat/transport-recovery

## Result and owned files

- New operations/transport-recovery.ts: operator-only synchronous inspect/reconcile class; no MCP/harness tool or model permission.
- admission/request-receipts.ts: narrow inspectBinding reads/validates immutable original request+reservation authority, including exact requestId and fingerprint.
- cli.ts: transport inspect <requestId>; transport reconcile <requestId> --expected <snapshotDigest> --reason <text>; explicit project scope enforced, force/yes/human bypasses refused. Passive operator process.
- cli/help.ts: command usage.
- New tests/transport-recovery.test.ts.

No other source, shared docs, real runtime/store/config/provider state, application code, approvals, commits or pushes changed. Main report is this worker's write-back only.

## Safety behavior

Requires modern dispatch_intent protocol, reserved request, exact nonce-bound nonanonymous uncertain0 request slot, immutable binding/reservation/charges/project/holder/lease consistency, recognized same-host hostname:pid:random owner, and no still-live exact captured lease. Probe succeeds only on explicit ESRCH; live/unknown/EPERM/foreign/malformed identities refuse. The snapshot includes slot holder/lease/nonce/full slot identity and request metadata/charges; stale digest refuses. Paid slot platform mapping follows actual paid catalog alias paid:<provider> while preserving original bound direct provider.

One synchronous IMMEDIATE transaction performs exact original-bound RequestReceipts.reconcile + Admission.reconcile/PaidSpend adaptation, setting unknown result UNCERTAIN and retaining request count, estimated tokens, worst-case paid spend and provider/key quota reservations. It deletes exactly one ID+nonce+holder+lease+platform+row CAS slot; changes must be1. Typed audit receipt stores existing events.project_id and task_id NULL, so existing project purge handles this non-task event correctly. It includes immutable digests, trusted local actor, actual PID-absence proof, reason and canonical outcome digest. No new migration.

Matching retry returns the original event receipt after checking exact retained binding, settled canonical outcome, uncertain model state and original slot absence. It does not re-probe a recycled PID, refund, retry provider requests, revive tasks or increase limits. Conflicting old dispatch/settlement remains fenced. Anonymous historical holds are untouched; unknown/legacy/unmatched holds refuse.

## Verification

- Offline frozen-lockfile dependency install succeeded (219 reused, zero downloaded); warned package bin unavailable before first dist build; no manifest/lock changes.
- Initial typecheck found import before cli.ts shebang; corrected import placement immediately. Final `pnpm --filter meritrouter typecheck` passed.
- Final `pnpm --filter meritrouter build` passed.
- Final `cd packages/router; pnpm exec vitest run tests/transport-recovery.test.ts tests/request-admission-protocol.test.ts tests/gate-request-ledger.test.ts --maxWorkers=1`:3files,51/51 passed,18.47s; transport27/27, request-protocol12/12, gate-ledger12/12.
- `git diff --check` passed (only Windows CRLF normalization warnings).

Tests exercise nonzero original count/tokens and paid/key quota preservation; exact anonymous2hold preservation; live/unknown/foreign/malformed PID and active original lease refusal; state changes after inspect; stale holder/nonce/lease/legacy/quarantine/project/missing/known-result refusals; accounting/protocol/DELETE abort/DELETE changes0/audit fault rollback; idempotence after acknowledgment loss and PID reuse; late conflicting settlement/dispatch fence. Actual stopped child + real CLI subprocesses inspect and concurrently reconcile the same request through separate DB connections: exactly one fresh receipt and one replay, same event ID, no provider calls. Force bypass refused.

Independent reviewer caught an initial binding gap: inspectBinding's call to bound(reservation) could resolve a second request row if a valid reservation_json from another request with identical execution/participants/tokens was substituted. Corrected explicit reservation.requestId==requested row.request_id and reservation.fingerprint==row.fingerprint checks before bound(). Final adversarial regression creates two valid reserved/dispatched requests, substitutes the second receipt into the first, and proves refusal without settling either or deleting a slot. Earlier50/50 run lacked this case; final51/51 includes it.

## Remaining root work

Independent source review and broader/full checks; authored operator documentation; commit/integrate/publish/deploy through supervisor. Only then may root inspect/reconcile each exact reviewed historical request via new CLI. No live capacity or process state was changed by this worker. Feature releases local transport capacity after dead-owner proof, never asserts remote completion/cancellation or unbilled outcome. Existing2anonymous holds remain outside scope. No app acceptance claimed.
