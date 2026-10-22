# Task Lab project prune

Status: Complete; source frozen for supervisor review. Supervisor integration/acceptance not performed by worker.

Baseline: feat/task-lab-project-prune at 486b552, isolated roadmap-process worktree.

## Contract and ownership

`TaskLabLifecycle.pruneProject(project: string): Promise<{ removed: string[]; blocked: number }>` is an internal confirmed-project-deletion primitive. Root owns its admin/project-deletion caller, public exports and integration. Retention `prune(now)` uses the same exclusion and fencing implementation and retains its string-array return contract.

Owned files: labs/task-attempt.ts, labs/task-attempt-runner.ts, new labs/task-attempt-prune.ts, new tests/labs-task-prune.test.ts and this report. No migrations, callers, service, admin, acceptance or shared documentation edits.

## Findings and implementation

Previous automatic prune inspected no operation and then awaited Git/removal without acquiring an operation. Another lifecycle operation could acquire authority during those awaits. It also called process termination from the prune path. Both paths now claim a unique durable cleanup operation owner generation under IMMEDIATE before awaiting and renew only a still-unexpired owned lease. Lifecycle shutdown tracks and awaits prune promises. Prune never terminates processes: outstanding process, service or port ownership blocks it.

Authoritative project/task/attempt rows, terminal same-project ancestry, retained/stopped complete cleanup, absence of pending/running operations and queued integration are revalidated by each fence. Exact Lab/root/marker/repository identities, Git common directories, registered worktrees, actual branch/head and dirty state are checked before removal. Source coding worktrees and all branch references remain retained.

Removal intent preserves an identity digest plus a verified-before-first-removal flag. Expired prune generations become failed without ordinary cleanup consuming their proof. A subsequent fenced prune can resume missing worktrees/root only with matching verified intent; foreign/replaced, dirty or ambiguously registered missing resources remain blocked. Final Lab/attempt state updates share an IMMEDIATE transaction. Known physical repository registrations are inventoried under the root, including marker-removed foreign worktrees. A separate no-follow content scan refuses unknown nested Git markers and special resources; root-contained dependency symlinks/junctions are skipped and unlinked without following their destinations. Root, ancestor and exact expected repository identity checks remain strict. Safe actionable refusal is stored in cleanup_error without advancing retention age. No claim of atomic Git/filesystem/SQLite crash durability: partial resources and proof remain until a later safe prune.

## Validation

- Router typecheck and build passed on final source including the closed guard.
- Ten-case prune suite passed 10/10 (74.31s), before the separate closed-guard addition.
- Closed-path regression passed 1/1 (443ms); remaining ten skipped in that narrow run.
- Existing lifecycle pre-final-revision run passed 16/16, including actual killed-owner recovery.
- Final combined parallel run measured 25/26: the existing two-real-isolated-attempts test failed with task service exited/environment_failure; every other case passed. This run overlapped an older lifecycle run using the same port range. Contention is a hypothesis, not proven causation. An isolated retry of exactly that failing case passed 1/1 (18.31s).
- Prior overlapping runs and source revisions during earlier lifecycle validation made those earlier snapshots ambiguous. All previous runs were allowed to exit; Win32 process inventory showed no roadmap-process Node validation processes before starting the final serial run.
- Final serial27 suite (--maxWorkers=1) on fully frozen source: 27/27 passed in263.94s (11 prune cases89.98s; 16 existing lifecycle cases169.40s). No source changes or overlapping WT validation during this run. Exact command: `pnpm --filter switchyard-router exec vitest run tests/labs-task-prune.test.ts tests/labs-task-attempt.test.ts --maxWorkers=1`.
- git diff --check passed (only repository CRLF normalization warnings).

Coverage: immediate confirmed-project cleanup at normal seven-day retention; authoritative sibling project preservation with its task running; retained source worktrees and branch references; dirty/foreign root/branch refusal; foreign PID metadata without termination; pending operation and automatic/project prune concurrency; expiry before removal; retry after actual partial Git removal; non-renewal of expired owner lease and shutdown drain; foreign nested registered Git worktree even with missing marker; unknown standalone nested Git repository; Windows junction unlink preserving external sentinel; explicit closed lifecycle refusal with automatic no-op.

Earlier fixture-only defects: beta was initially added after configuration project resolution, and unnecessary fake HTTP services produced cleanup failures while overlapping existing lifecycle fixtures. Both fixed in the new fixture only: both projects are parsed initially and prune fixture uses actual Node command/check processes without ports/services. No existing tests weakened. No fixture cleanup failure is presented as a proven product failure or a proven contention cause.

## Limits and handoff

Explicit pruneProject rejects a closed lifecycle with typed unavailable error; automatic prune remains a no-op after close. The narrow closed regression passed 1/1 (443ms).

Root owns invocation from confirmed project deletion and must revalidate deletion blockers after awaiting prune and before task/database purge. No public task Lab start/check/promote authority changes; no migrations, backend, provider or R2 completion claim.

The no-follow scan is deliberately bounded to 20,000 entries, depth64 and one second per pass. Larger/deeper/slow dependency trees conservatively block with an actionable retained cleanup_error; this unit does not claim automatic cleanup of every large Next.js/pnpm install. Ordinary dependency junctions are supported and were checked with an actual Windows external sentinel. Known Git registrations and unknown nested .git proof remain blocked. Data/log/cache within the proven owned root is removable.

No atomicity claim across Git, filesystem and SQLite. An interrupted remove retains immutable identity/verified intent and can retry under a fresh operation generation. Ambiguously registered missing paths, changed identities and foreign resources remain blocked rather than being forced. Branch refs, coding source worktrees, task rows and durable evidence are retained. The new tests simulate expiry immediately after real Git removal; they do not claim an actual-killed-pruner subprocess test. Existing lifecycle actual-kill fixtures verify ordinary cleanup recovery separately.

No user data, providers, Docker, user4477, persistent services, commits or pushes were used. Test-owned environments/processes are cleaned by fixture teardown. No repository-wide acceptance was run; supervisor owns independent review/full suite/integration.

## Frozen file hashes (SHA-256)

- `packages/router/src/labs/task-attempt.ts`: `8d35688e472e3192f19eb7f50243a259b7666186984136734b6a7dccd1e2a64d`
- `packages/router/src/labs/task-attempt-runner.ts`: `c8f080f79c96829e2be5be584ba48f2605ff276a86037f5bcfe357e08b59fec4`
- `packages/router/src/labs/task-attempt-prune.ts`: `d120cee1172d3baaf1ac679fd3b461a3be0b76b6e8ae77ec035f239ac6bcbae9`
- `packages/router/tests/labs-task-prune.test.ts`: `ee27d6b145bca3f0367fd55e12ded854a0f970d030dd1f5b5541dead0d5aaec3`

Final handoff: no further source edits. All four raw worktree-byte SHA-256 hashes below were rechecked after the successful serial run; Git may normalize CRLF on commit.
