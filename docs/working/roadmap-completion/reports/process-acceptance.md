# Report: process-acceptance

## Current status
Complete and frozen for supervisor review. Isolated feat/roadmap-process worktree from 702682d. No commits, shared-doc edits, live quota, or user-install mutations.

## Findings and decisions
- Existing resilience.test.ts already performs a genuine OS hard-kill of a worker mid-native-coding request and restarts it against durable storage; reuse this acceptance rather than duplicate caught-exception tests.
- Added independent-process tests for worker claims/provider ceiling, merge integration ownership, and real CLI plus stdio/HTTP MCP budget decisions and schema refusals.
- Reproduced integration ownership defect with actual independent processes: while the first process remained alive and held its callback at state picked, the second process recovered that first item and completed its own integration. Expected one callback before release, observed three (first/first, second/first, second/second). Initial focused run: 4/5 passed; live-owner serialization failed precisely on those extra callbacks.
- Supervisor authorized bounded workspaces/merge-queue.ts amendment after reproduction. Added durable per-branch mutex in existing meta storage, keyed by resolved physical Git common directory plus target branch. Aliases/projects cannot bypass the same physical branch mutex. No migration or API/caller changes; stable for Labs.
- Mutex metadata validates host/PID/process instance, random ownership nonce, heartbeat and observed job task lease owner/run generation. Different queue owner, expired task lease or old heartbeat alone never permits takeover. Only ESRCH for a same-host PID proves a holder dead. Remote/malformed ownership and live/reused PID ambiguity fail closed with a bounded busy error (30 seconds plus SQLite scheduling/lock overhead). This deliberately favors safety over automatic recovery when ownership cannot be proved.
- Mutex spans picks, integration callbacks and checks, serializes run/recover across processes, and releases only its matching nonce in finally. Heartbeat is always stopped on that path. Missing-worktree recovery still records failure without attempting Git operations.
- Tests cover independent live owners using different aliases for the same physical Git repository; actual OS hard-kill of the held owner followed by recovery with exactly two cherry-picked commits; check failure releasing the lock; malformed/remote lock refusal without overwriting metadata (clock advanced in-process solely to avoid waiting 30 seconds for these refusal assertions).
- Real independent CLI workers process six tasks against a delayed loopback fake provider: six provider requests, peak in-flight one, six distinct task claim records with one claim each, both worker processes still alive at completion.
- Real CLI approval/denial and MCP stdio/HTTP approval/denial preserve extras [2,0,2,0,0], refuse invalid grants/repeated CLI decisions, and enforce human-only decision ownership. Decision-only runs issue zero model requests/charges; fixture declarations are created through BudgetRequests.file so the acceptance isolates actual transport and decision/accounting boundaries rather than claiming model-loop coverage.

## Validation
- `pnpm install --frozen-lockfile --offline`: passed in 6m52.4s. First build invoked before linking completed failed on missing node types; first test attempt before bin linking failed on vitest not found. Both were prerequisite failures and were rerun after install.
- `pnpm --filter switchyard-router build`: passed after the source fix.
- `pnpm --filter switchyard-router typecheck`: passed after final edits.
- `pnpm exec vitest run tests/process-acceptance-integration.test.ts tests/process-acceptance-workers.test.ts tests/process-acceptance-budget.test.ts tests/team-nesting.test.ts --maxWorkers=2`: final 12/12 passed across four files, 19.90s. Prior post-fix run also passed 12/12 in 20.29s before the final alias/refusal/cleanup assertions.
- `pnpm exec vitest run tests/resilience.test.ts -t "R1 acceptance" --maxWorkers=1`: passed one actual hard-kill/restart test (ten unrelated tests intentionally filtered), 14.04s total / 12.09s case. Durable session resumed, interruption events/request attribution remained readable, interrupted edit performed once and three requests total; no duplicate coding edit replay.
- `git diff --check`: passed.

## Not verified / follow-up
- No whole-repository checks, panel changes, real provider credentials or user data. Supervisor owns integrated acceptance and authored docs update.
- SQLite-install-local mutex does not coordinate distinct stores pointing at the same repository; the existing repository-ownership boundary must remain in force. Remote hosts and PID reuse intentionally require operator recovery when ownership is ambiguous. This is not distributed multi-host acceptance.
- Integration callback has existing recovery idempotency requirements: an actual kill after its callback but before integrated state may invoke that callback again; preserved behavior, commits remain picked once. No claim of exactly-once arbitrary external callback side effects.

## Owned files
- workspaces/merge-queue.ts (approved amendment), new tests/process-acceptance-budget.test.ts, process-acceptance-integration.test.ts, process-acceptance-workers.test.ts, fixtures/process-acceptance/merge-owner.mjs, and this report. Existing tests read/run but not modified.
