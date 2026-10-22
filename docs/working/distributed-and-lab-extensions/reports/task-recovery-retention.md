# Task recovery receipt retention

Status: Implemented and frozen; worker checks passed, supervisor independent verification in progress.
Worker: link_completion
Branch: feat/task-recovery-retention
Baseline: 48c1da9
Date: 2026-10-22

## Scope and contract

Owned changes: storage/task-leases.ts, storage/sqlite-task-leases.ts, scheduler.ts recovery allocator only, proportional key updates in task-leases/executor-task-leases tests, new task-recovery-retention.test.ts and this report. No migration, queue, Executor implementation, service, public index, Gate, Compose engine or shared document changes. No commits/pushes or real provider/engine/user-data access.

New exports for root integration: `recoveryOperationId(now?)`, `RECOVERY_RECEIPT_WINDOW_MS=300000`, `LEASE_RECEIPT_CAPACITY=100000`, `RECOVERY_RECEIPT_CAPACITY=20000`, `RECOVERY_TOTAL_THRESHOLD=80000`. Existing `leaseOperationId` and seven-day `LEASE_RECEIPT_WINDOW_MS` are unchanged. Strict LeaseRef is unchanged.

Recovery requests use `trecover_<base36ms>_<24hex>` and reject legacy tlease input. Ordinary mutations accept only tlease keys. Receipt schemas bind trecover exclusively to recover kind. Adapter prefix/window checks precede receipt lookup; recovery retry/expiry is five minutes, ordinary mutation retry/expiry remains seven days, both inclusive at the final millisecond. Existing permitted 60-second future-clock skew remains and can extend observed retention accordingly. Expired recovery keys never become ordinary mutation authority after deletion.

Durable empty recovery receipts are retained: replaying an old empty receipt cannot recover tasks that expired later. Applied recovery replay preserves the exact original affected identities/states/server time; digest reuse with a different payload refuses. Task mutation, events and receipt creation still share one immediate authority transaction. Replay lookup precedes quota checks.

New keys respect total100k capacity. New recovery keys additionally refuse at total80k or maintenance20k, reserving ordinary mutation headroom. Counts include retained keys, including expired backlog not yet collected; maintenance counts only the new kind-bound trecover prefix. This is finite-fleet protection, not unlimited throughput: at one operation per second each process retains about301 keys, with extra skew allowance. At exact one-second cadence,20,000/301 permits66 such streams before the maintenance cap; with the full60-second future skew allowance, up to361 retained keys per stream permits55. Active lifecycle operations, startup/kick cadence and expired backlog can reduce the practical bound. Ordinary seven-day keys are also finite:100,000/604,800 seconds is about0.16534 unique operations/second globally (one per6.048 seconds sustained), before subtracting maintenance usage. No unbounded fleet, workload or multi-host scalability claim is made. Capacity refusal is explicit and can stall a scheduler tick that requires recovery until keys safely expire; headroom does not promise continued claiming at arbitrary occupancy.

At most500 expired keys are collected in a separate committed immediate transaction, using the existing expiry index/order and cascading receipt/project-scope deletes. Subsequent quota/authority refusal cannot roll this progress back. There is no unbounded retry/GC loop. Async mutations invoked inside an existing SQLite transaction refuse explicitly: nested better-sqlite3 savepoints cannot independently commit housekeeping. Current asynchronous scheduler/executor calls already execute outside writer transactions. This precondition does not alter synchronous TaskStore facades.

Legacy tlease recovery tombstones retain their original seven-day expiry, including after private receipt purge. They are never shortened, reclassified or evicted to make capacity. A database already saturated by legacy keys may remain constrained until safe expiry; no unsafe upgrade repair is supplied. This fix is forward-only, and the defective async lifecycle had not been deployed to the user.

## Validation ledger

- First frozen serial run:49/52 passed,84.28s. Three test setup/expectation failures: two malformed recovery receipts now refuse earlier at the strict prefix/kind schema; startup recovery records both interrupted and queued observations for the original attempt. A long uninterrupted microtask loop additionally starved Vitest progress RPC. No adapter assertion or behavior was weakened.
- Fixture correction preserved both layers: wrong kind expects strict schema refusal; wrong operation ID uses another valid recovery prefix so the scheduler identity refusal remains exercised; startup replay asserts the exact interrupted/queued receipt observations. The deterministic loop now yields the event loop every1000 calls without changing fake clock cadence or operation count.
- Second serial run:51/52 passed,81.10s, no unhandled RPC error. The remaining fixture expected the wrong resumed-state name pending; actual TaskStore.resume explicitly uses queued. Corrected to the exact existing state and individually reran that applied-recovery replay case:1/1 passed,2.69s.
- Final frozen serial command in packages/router: `pnpm exec vitest run tests/task-recovery-retention.test.ts tests/task-leases.test.ts tests/executor-task-leases.test.ts tests/scheduler-async.test.ts --maxWorkers=1 --minWorkers=1`: **52/52 passed**,4 files, **84.72s**, no unhandled errors. Retention10, existing adapter18, executor12 and scheduler12. The final full two-day simulation made172,801 recovery calls, passed in66.31s and retained exactly301 keys AND301 durable receipts. The existing adapter suite includes real isolated killed-owner recovery and same-owner stale-attempt refusal.
- Final `pnpm --filter switchyard-router typecheck`: passed after the last test correction.
- `pnpm --filter switchyard-router build`: passed on the exact frozen production source. One later edit corrected only the new test's expected literal state; production source remained unchanged.
- Parent started independent verification in this frozen worktree, including its own full two-day cadence simulation. Its outcome is not claimed here; source/dist remain untouched while it runs.
- No repository-wide/panel/provider/Engine acceptance performed in this worker unit. Root owns public exports, authored operations guidance, receipt purge integration and aggregate acceptance.

New cases cover multi-day bounded retention, empty recovery replay after later task expiry, applied startup replay after same-owner re-claim, digest conflicts, inclusive five-minute expiry and cascade pruning, cross-kind/prefix reuse, ordinary seven-day replay, legacy hash-only tombstone preservation, maintenance20k/total80k/overall100k limits, replays despite full capacity, ordinary mutation headroom, and independently committed500-key cascade progress despite quota refusal. Nested transaction refusal is directly tested. Quota scenarios seed isolated private database rows; they are not live workload or host acceptance evidence.

## Frozen SHA256 inventory

- storage/task-leases.ts: `10F3B755662DC52E086B869FCBCD5B0976B38DC8D54BFAA3A76E1A70CC2D5412`
- storage/sqlite-task-leases.ts: `07A58A78A7939F93ACAA5A4D38485B84E25813F5255E2778C7455F7903A3C1CF`
- core/scheduler.ts: `994BC7E6D79FA7EE17F5EA85914DEE2CCB09E9408B2C7B5D60228CD35FD3A2AF`
- tests/task-leases.test.ts: `E3F3A3D7C119C9BCC5ECEC16F14C007F3CA6466332D291D1454C70D773668E21`
- tests/executor-task-leases.test.ts: `A6A6651AF38402D61F97DE75BC98D6559295A7CFF01C0EE9F62AD3CA08255C7D`
- tests/task-recovery-retention.test.ts: `74351BEB2DDDF04959E04471AD5269D7D75AFABE38D348A8DFBB3F78278D2AED`

No source edits planned after this freeze. This closes the bounded idle-recovery retention defect for upgraded callers, not distributed lifecycle or complete R2 acceptance. Old workers must be upgraded; this code cannot stop an older process continuing to issue legacy seven-day recovery keys. Legacy saturation remains subject to safe original expiry, never unsafe tombstone eviction.
