# Report: request-ledger

## Status
Complete and frozen for supervisor review in feat/roadmap-request-ledger from6a77c4a. No commits, shared docs/exports/config/migrations/manifests, PG/backend selection, services or live-provider quota.

## Contract and implementation
RequestLedger.reserve(ReserveRequestDTO):Promise<ReservationDTO>; reconcile(ReservationDTO,RequestOutcomeDTO):Promise<void>. Zod-validated data only; PaidSpend is privately rebound by SQLite adapter. Outcome projects ChatResponse onto accounting usage/telemetry/http/web-search metadata, excluding model messages/tools. Current unknown cache-write price null/absence remains intact; internal unpriceable actual cost retains conservative reservation/quarantine semantics.

One SqliteRequestAccounting implementation extracted into admission/sqlite-request-ledger.ts; existing synchronous Admission facade delegates to it, and default async SQLite adapter delegates through that same facade/core. Its synchronous policy/counter reads remain on Admission and execute inside the same Db transaction through private callbacks; no remote callback enters the DTO port. Atomic participant/request/paid writes and latest paid/cache-creation math preserved. Gate/direct defaults use the awaited port. After-reserve abort is settled as definitely unsent and never dispatches; the conservative request audit/count remains, while unsent provider quota and paid billing are released. RequestPersistenceError is separate from provider failures so persistence errors escape fallback, including when an underlying adapter throws a GatewayError. Gate registers requests before invoking adapter hooks, stops new routed calls on close and drains existing requests/accounting; service close waits before Db close.

Response DTO projects ChatResponse onto metadata before the adapter call, so model output/messages/tool calls never enter this accounting port. Paid reservation DTO contains SpendKey reference/limits metadata and token prices, never PaidSpend/Db/functions or raw credential secrets. Schemas reject such extra fields. Legacy sync Admission.reserve returns immediately and Admission.reconcile remains void; no sync API emulation or process-per-query behavior.

## Validation observed
- Router typecheck passed after correcting initial DTO profile enum/spread typing errors.
- Existing focused tests execution.test.ts, paid.test.ts, caching.test.ts, cache-creation.test.ts, providers-limits.test.ts:61/61 passed,21.53s. Includes batching, atomic cap contention, conservative uncertain paid cost and unknown cache-write quarantine.
- `pnpm exec vitest run tests/request-ledger.test.ts tests/gate-request-ledger.test.ts --maxWorkers=2`: initial12/12 passed5.68s; final strengthened13/13 passed4.15s. Covers strict data-only schema refusal, outcome body exclusion, rollback on participant and paid insertion, batch proportional charges/paid cost/shared sync facade, settlement rollback, unknown cache-write retained reservation/quarantine, delayed reserve and independent-connection visibility proving committed-before-provider, reserve rejection with zero dispatch, abort during paid reserve with zero dispatch/not-billed settlement, settlement before return/fallback, success/error paid settlement persistence failures preserving evidence without second spend, service close drain/open Db until commit and rejection of new calls, and default submitted-task runtime using the port with unchanged request/charge rows.
- `pnpm exec vitest run tests/budget-control.test.ts tests/service-close.test.ts tests/process-acceptance-workers.test.ts tests/external-task-tools.test.ts tests/process-acceptance-budget.test.ts --maxWorkers=2`:25/25 passed33.78s. Includes actual independent CLI workers on rebuilt dist sharing provider cap, task-scoped external MCP human/supervisor budget continuation/token/lease enforcement, real CLI+MCP stdio/HTTP decision accounting, and promotion shutdown ownership. This run preceded the final registration-before-adapter bookkeeping guard; the final13 new cases and actual hard-kill acceptance below passed after that guard.
- `pnpm exec vitest run tests/resilience.test.ts -t "R1 acceptance" --maxWorkers=1`:1 actual OS hard-kill/restart case passed (10 unrelated tests intentionally filtered),15.32s total/12.66s case, against freshly rebuilt dist. Durable session resumed, coding edit performed once and request attribution retained.
- Final `pnpm --filter switchyard-router typecheck` and `pnpm --filter switchyard-router build`: passed after final source/test changes.
- `git diff --check`: passed (existing CRLF-to-LF notice for extracted admission.ts only). Gateway source search finds no remaining direct Admission.reserve/reconcile calls.

## Ownership / integration contract
Integrate only:
- admission/admission.ts, new admission/request-ledger.ts, new admission/sqlite-request-ledger.ts;
- gateway/direct.ts, gateway/gate.ts, core/service.ts (two drain-wiring lines);
- new tests/request-ledger.test.ts, tests/gate-request-ledger.test.ts;
- this report.

The modified shared distributed-and-lab-extensions.md brief and previous distributed-storage-inventory report were supervisor/prior-unit artifacts, not edited by this implementation. Root owns authored docs and any public exports. Available names if root elects to export: RequestLedger, ReserveRequestDTO, ReservationDTO, RequestOutcomeDTO; ReserveRequestDTOSchema, ReservationDTOSchema, RequestOutcomeDTOSchema; RequestPersistenceError. SQLite implementation/core need not be public.

## Limits
SQLite is still synchronous internally and remains the only enabled backend. No PG adapter/driver/selector or multi-host claim. Participant owner/budget snapshots retain current semantics, not a new authoritative distributed lease/policy protocol. Provider key/window/slot transactions, object storage, journal persistence, idempotent reconnect/settlement and generation fencing remain subsequent R2 slices. Gate tool probes remain on their existing uncharged provider/probe path; this change ports normal routed accounting, not probe-accounting policy. No panel changes or whole-repository validation was run; supervisor owns integrated acceptance. All test providers/keys/paid values were fake and temporary stores/processes cleaned by their fixtures.


## Review correction: post-reservation dispatch authority (2026-10-22)
Reproduced all four missing checks before the fix: a delayed adapter committed its paid reservation, then returned after persisted lease owner changed, lease expired, cancellation was requested, or deadline passed without AbortSignal. All four regressions failed because a provider response was returned.

Admission.assertDispatch delegates to the same SQLite accounting authority checks used during reservation. Gate supplies this synchronous internal callback to direct dispatch; after await reserve and AbortSignal validation, it checks every original normalized participant immediately before constructing/calling the provider, with no intervening await. It does not reserve again or recompute/charge budgets. A typed AdmissionDenied releases the unused provider quota/breaker admission, awaits definitely-unsent settlement, and escapes without endpoint/key fallback. Unexpected storage validation failures become RequestPersistenceError and retain request evidence; settlement failures preserve the existing persistence failure behavior. This remains SQLite-only authority, not a distributed dispatch protocol or PostgreSQL support; the data-only async RequestLedger interface is unchanged.

Observed final correction validation:
- Four-case pre-fix reproduction: 4 failed as expected.
- request-ledger + gate-request-ledger: 17/17 passed, including four corrected cases asserting zero provider calls, one reservation, original denial classification, one failed request row, and paid actual_usd=0/cost_basis=not_billed.
- Final request-ledger + gate-request-ledger + execution + paid suite: 42/42 passed, 16.31s, maxWorkers=2.
- Router typecheck, router build and git diff --check passed after correction (only normal CRLF conversion warnings).

core/service.ts was frozen throughout this correction; its earlier two-line close/drain patch is unchanged. Corrective files are admission/admission.ts, admission/sqlite-request-ledger.ts, gateway/direct.ts, gateway/gate.ts, tests/gate-request-ledger.test.ts and this report. Unit is frozen again for supervisor integration. No commits, broad repository validation, live quota or enabled backend changes.
