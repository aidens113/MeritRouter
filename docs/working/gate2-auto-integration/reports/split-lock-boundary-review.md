# Report: split-lock-boundary-review

## Outcome

CLEAR for the revised standard `supervise` pilot path within static review, pending the supervisor's independent rerun. The initial broad CLEAR missed an admission snapshot regression: root subsequently observed six unchanged tests fail because provisional binding publication changed queue detail/timestamps before a refusal. That initial conclusion is superseded. The revised restoration logic is reviewed below; no new concrete blocker was found. Custom supervisor profiles remain a confirmed scoped compatibility limitation.

## Review findings

- `storage/merge-branch-lock.ts:27-37` parses a strict bound owner, compares the complete current project-store identity, recomputes the exact physical-owner/branch hash, checks queue-owner equality, joins the exact queue item to its owning project job, and requires the recorded binding to match. An arbitrary `merge-branch:` prefix, foreign item/project/generation, changed physical owner/branch/worktree or extra owner fields does not suffice.
- `workspaces/merge-queue.ts:294` derives the actual physical owner at acquisition and publishes the binding on the queue item in the same immediate transaction as the mutex. Contention checks precede binding replacement. The nonce check is at `:330`; lock acquisition still requires an absent local owner process before takeover rather than trusting age.
- `workspaces/merge-queue.ts:393` carries the binding through existing detail replacements, including stale `item.detail` snapshots in recovery/failure paths. Re-acquisition explicitly supplies its new binding. Callback-time store assertions therefore do not depend on the queue item's changing state or its mutable current owner column.
- `storage/store-role.ts:57-58` continues rejecting all unrelated metadata. The new validator performs no Git subprocess or workspace-module import during role checks.
- The new test exercises actual split-service accept/integrate/dependent Git-head behavior and lock cleanup, plus negative ownership metadata. This review inspected those assertions but did not execute them.

## Admission-refusal follow-up review

Root reported wider verification at 42 passed / 6 failed across six files; the failures showed queue detail/updatedAt mutation before pending, foreign-owner and unknown-pick refusals. This reviewer did not run that command. The implementation worker then reported the unchanged metadata queue file passing 11/11; root still owns independent execution verification of the revised tree.

The updated `workspaces/merge-queue.ts:302-348` captures the complete queue row immediately before and after its binding write, within the same immediate transaction that acquires the mutex. Only an escaping `RepositoryMutationError` marks that binding as provisional admission evidence to undo. During release it first verifies that the mutex still has this invocation's nonce; in the same transaction, it restores the original detail JSON and updatedAt only if a fresh complete row read exactly equals the post-acquisition snapshot. It then deletes only the captured mutex value.

This preserves current queue progress or independent changes to any row column, including state, ownership, detail and timestamp. A changed or malformed mutex, foreign nonce, deleted queue row, or changed whole-row snapshot prevents restoration. If picks/recovery already persisted actual evidence, those changes make the snapshot differ and are retained. The release does not roll back Git, other rows, events or unrelated work. No concrete bypass or overwrite of a currently changed row was found in this static review. Crash/foreign-writer execution coverage remains the supervisor's validation responsibility.

## Confirmed compatibility limit

`storage/merge-branch-lock.ts:35` admits only an owning task whose literal profile is `supervise`. Root confirmed that configuration mode overrides and custom inspect-supervisor tests establish reachability of other configured supervisor profiles. Those profiles retain the split metadata refusal. Root classified this as a pre-existing scoped compatibility limitation (the former guard rejected all queue metadata), not a blocker for this standard `supervise` pilot, and will track it in the master document. This report does not claim general split/custom-supervisor support. Confirmation outside the named review files was supplied by the supervisor, not independently investigated here.

The worker report's legacy stale-lock limitation is accurate: old unbound payloads remain parseable for mutex contention, but `ownMergeBranchMetadata` admits only bound payloads. A crash-retained old lock in a split store therefore remains fail-closed; this change does not provide migration or cleanup authority. That is a documented retained limitation, not a newly introduced relaxation.

## Validation and limits

Static read-only review of the specified working state, repair report, storage validator, queue changes and new split test. No tests, provider calls, runtime/configuration reads, source edits, commits or pushes. Only this report was written. Supervisor owns independent execution checks and live activation.
