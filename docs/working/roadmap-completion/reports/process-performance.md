# Report: process-performance

## Outcome and ownership
Complete for the current isolated baseline; frozen for supervisor review and later integrated remeasurement. Own changes: new tests/process-performance.test.ts, approved admin/projects.ts deletion/lifecycle amendment, this report. No commits, shared-document edits, real quota, user installs or panel processes.

The tree began at 702682d; the supervisor checkpointed previous process acceptance at 190e98b during this brief. The earlier queue/process files remained unchanged by this work. Supervisor copied its actual config-edit.ts and new projects/lab-config-guard.ts into this tree as dependencies: config writing now accepts `{expectedText}` and serializes comparator/guard/file write/reload with an immediate SQLite transaction. Those two files are supervisor-owned, not this worker's implementation. No stubs or migrations.

## Bounded performance evidence
Windows, Node fixture services, temporary SQLite/repos/brains, fake in-process provider transport through the normal Gate/client path. One 24-task run each at concurrency 1 and 4, batching and classification disabled, fake response delay 25 ms. Submit-to-completion latency excludes environment setup and service shutdown; timing is observational, not a flaky speed threshold. Each task had exactly one claim, physical request and charge, every task completed, and peak fake-provider requests matched configured concurrency.

| Configured concurrency | Tasks | Elapsed | Tasks/sec | Task latency p50 / p95 | Fake response p50 / p95 | Provider peak |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 24 | 1704.60 ms | 14.08 | 938.00 / 1646.14 ms | 32.02 / 41.87 ms | 1 |
| 4 | 24 | 741.91 ms | 32.35 | 478.57 / 741.87 ms | 89.47 / 105.46 ms | 4 |

The fake response wall time includes local scheduling/event-loop/SQLite contention. These are framework fixture measurements, not real-provider throughput or model latency predictions. Earlier run measured 14.89 / 29.21 tasks/sec, illustrating normal run-to-run variance.

Watcher fixture: two projects; 10,000 historical completed tasks, 10,000 sessions, 20,000 events, 10,000 requests, 10,000 request charges, 1,000 budget requests (61,000 primary rows, plus one execution/project/catalog metadata). Sessions are valid synthetic rows for watcher scanning; no fake session-log files are claimed. Timestamps fixed; 50 quiet ticks and 10 state_reason writes via a second SQLite connection, leaving updated_at unchanged. Every alpha write invalidated alpha tasks despite timestamp collision, beta task topics remained unchanged, every quiet tick reported no topics. Measurements include assertion overhead.

| Watcher operation | Measurement |
| --- | --- |
| Build two scoped cursors | 312.64 ms |
| Quiet tick p50 / p95 | 0.141 / 0.281 ms |
| Write tick p50 / p95 | 166.49 / 184.64 ms |

An earlier 61k-row run measured quiet .122/.262 ms, write 159.33/166.32 ms, initial cursors 289.25 ms. Write ticks remain much costlier because current watcher fingerprints historical mutable tables after a database write. This report measures that behavior; admin/live.ts remained supervisor-owned and unchanged.

## Reproductions and correction
Four deterministic temporary-store failures were reproduced before the approved source fix:

- Start delete(beta), archive(alpha) through another service/connection during async footprint discovery: deletion incorrectly resolved successfully with no problems, removing the last live project.
- Start concurrent delete(alpha) and delete(beta) through two services: both incorrectly fulfilled, rather than preserving one live project.
- Make the config backup path a directory, then delete a project with a completed task: config backup threw, but that task's rows had already been purged.
- Start deletion, append a comment to the config during footprint discovery: deletion incorrectly succeeded and overwrote the newer config text.

Concurrent queued-task submission was already refused by purge's transaction; the new full-blocker check now refuses it earlier with the same retained task/config outcome.

Approved fix only in admin/projects.ts: archive/unarchive lifecycle operations use immediate SQLite transactions; deletion retains its original config snapshot, then after footprint awaits acquires the same write lock, rechecks exact config text and all live/active-project blockers, writes checked config before purging, and refuses any config-write error before removing project rows. A post-write purge failure rolls DB rows back and restores original config only with an expectedText comparator; a newer external editor change is preserved. Two additional deterministic purge-failure tests prove rollback and comparator-protected restoration. Filesystem/worktree/brain cleanup remains after successful critical-section completion.

This is operational rollback and serialization among cooperating writers, not hard-crash atomicity across SQLite and the config filesystem. Direct external editors do not honor the SQLite lock; snapshot comparison catches changes before the write but cannot make an uncooperative editor transactionally atomic.

## Validation observed
- Baseline performance file: 3/4 passed, archive/delete failure reproduced (17.94s). Separate concurrent-delete probe failed 2 fulfilled versus expected 1 (3.27s total). Separate backup/stale-snapshot probes both failed (2.64s total), proving lost rows and overwritten config respectively.
- `pnpm exec vitest run tests/process-performance.test.ts tests/projects-delete.test.ts --maxWorkers=2`: 12/12 passed across two files in 21.34s (seven performance/race tests then present plus five existing deletion tests).
- After adding purge rollback and newer-editor coverage, `pnpm exec vitest run tests/process-performance.test.ts -t "failed purge" --maxWorkers=1`: 2/2 passed (seven other cases intentionally filtered), 2.43s total.
- `pnpm --filter switchyard-router typecheck`: passed after all final source/test changes.
- `pnpm --filter switchyard-router build`: passed.
- `git diff --check`: passed.
- All temporary stores, services and writer connections closed/removed in finally. No fixture listeners or subprocesses are created by this file.

## Limits and supervisor follow-up
Remeasure after the Labs/core merge if lifecycle or live-watcher paths change, as required by the brief. No whole-repository suite or production-panel verification was attempted here; supervisor owns integrated verification and authored documentation. No source change to projects/deletion.ts was needed. The broader cleanup phase still is not a multi-resource crash transaction; this work makes no such claim.
