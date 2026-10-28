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
