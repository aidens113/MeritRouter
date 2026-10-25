# Independent retained repair hydration review

Reviewer: repair_hydration_review
Date: 2026-10-25
Status: Review clear after focused corrections; root integration and broad verification remain
Scope: Isolated D:/SwitchYardRouter-repair-hydration source/tests; read-only review, no application/live changes.

## Findings

1. **Blocking: actual replay target scope was not checked.** Initial `workspaces/repair-hydration.ts` validated every source commit path, then recorded completion without validating actual target changes. Git follows target-base renames: an allowed `src/a.ts` source edit can update `outside/a.ts` when the newer integration base renamed that file. The model could receive a completed hydration containing out-of-scope inherited changes. Require actual target per-pick/final delta path and mode validation before completed receipt/model exposure, with rename-target regression.
2. **Blocking boundedness gap: the 8MB check covered only net source delta.** A large file added and later removed in a linear source chain disappears from `base..head` net diff while still being replayed. Apply a cumulative per-commit patch-byte bound or explicitly narrow the advertised bound; add transient add/revert regression. This review requests bounded replay accounting, not a new general resource framework.

3. **Completion source-state race:** source state/head/quiescence were checked before each cherry-pick, but not after the final awaited pick before recording completion. Requested a final source recheck and fault-injection test. Immutable commit content remains stable; this closes the explicit terminal/quiescent-source contract rather than introducing a new authority model.

Findings were sent directly to root and implementer. Root revoked the source freeze for focused corrections.

## Independent reproduction

Ran an inline Node fixture using the repository's existing built internal safe Git wrapper, a fresh OS temp repository, a source modification of `src/a.ts`, a newer target-base rename to `outside/a.ts`, and safe Git cherry-pick. Result:

```json
{"sourceAllowedPath":"src/a.ts","actualHydratedDelta":"outside/a.ts","targetModified":true}
```

The fixture was removed only after verifying its resolved path was inside the OS temp directory and had the exact review prefix. No user repository or configuration was used. Initial fixture attempt used unsupported internal `git mv`; corrected to temp filesystem rename plus safe Git staging and reran successfully.

## Other checks by inspection

- Source ownership is checked against parent/project/repository and terminal task state; active merges, unquiesced worker actions, incomplete author history and dirty/moved source heads refuse.
- Each source commit is checked for linear parentage, attribution presence and original/new child path scope. Safe Git disables executable configuration/hooks; inherited source remains unmet and is replayed only in a new worktree.
- Current job integration base is retained; existing integration test covers all twelve inherited files plus a repair and a newer disjoint API change.
- Persisted plan binding includes repair source; older stored plan nodes default to null.
- Started/failed/malformed/mismatched hydration receipts refuse model entry. Completion verification uses hydrated-head ancestry, allowing later repair commits; current task authority is checked independently rather than requiring the old lease. Requested an explicit normal resume regression after repair commit and renewed worker lease, since existing tests only verified immediate idempotence.
- No production source or tests were changed by this reviewer. No broad validation was run; root owns required final checks.

## Pending

Completed final helper/diff re-review and independent targeted regressions below. No remaining source-review blocker.

## Correction review checkpoint

Production corrections now check actual target path/mode deltas after every replayed commit and at final integration-base delta; count cumulative per-commit patch bytes; and recheck source terminal/head/action/merge state before completed receipt. These address the findings by source inspection.

Independent command:

`npx vitest run tests/repair-hydration.test.ts --testNamePattern="newer target rename|cumulative add|final awaited cherry-pick|fresh lease" --fileParallelism=false`

Result: **3 passed, 1 failed, 19 skipped**, tests17.33s/total20.19s. Cumulative bound, final source-state race, and legitimate fresh-lease resume pass. The rename test failed early at a Git conflict, so it did not exercise the new target-scope guard. Requested the implementer retain the specific expected scope error and use the proven forty-line/minor edit fixture rather than weakening the assertion. Final clearance pending that meaningful regression.

## Final disposition

**No remaining source-review blocker in the corrected frozen implementation.** All three findings are addressed: actual target path/mode checks run after every pick and at the final base delta; cumulative per-commit UTF-8 patch bytes are bounded; and source state/head/action/merge authority is rechecked before completed receipt.

The meaningful rename fixture was corrected to use forty stable lines and a small source edit, retaining its specific expected target-scope error. Independent rerun:

`npx vitest run tests/repair-hydration.test.ts --testNamePattern="newer target rename" --fileParallelism=false`

Result: **1 passed, 22 skipped**, tests4.83s/total7.58s. Combined with the previous unchanged-source three passing targeted regressions, this independently verifies all four review cases. The guard is exercised after a successful rename-following cherry-pick, not merely a generic conflict rejection.

Completed hydration also supports an actual repair commit followed by task interruption/resume and a fresh captured lease without replay. The implementation verifies immutable hydrated-head ancestry and current target authority independently of the original lease. Source remains unmet and its original author/model/task trailers survive ordinary integration; all inherited changes remain in the current job-base integration range.

Limits remain explicit: Lab-bound and quality-retry hydration refuse; partial/conflicted receipts require a new repair task rather than automatic replay; source history is conservatively bounded and must be complete/quiescent. The 8MiB bound is cumulative patch bytes, not an assertion about every repository blob's expanded size. Root still owns full typecheck/build/tests, merged-tree verification, live activation and actual MVP acceptance.

Reviewer changed only this report; no production/test/application/live/configuration edits, commits or deployments.
