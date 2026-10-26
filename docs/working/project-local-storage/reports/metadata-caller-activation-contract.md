# C3 caller activation contract

Owner: selected_commit_review (read-only worker)
Date: 2026-10-26
Status: proposed implementation contract; no C3 source changes or acceptance.
Scope: activate isolated C1/C2/C2b safely without changing existing public attribution semantics.

## Current implementation facts

| Boundary | Actual source and consequence |
| --- | --- |
| Attributed commits | `attribution/index.ts:36 commitAs` stages, then invokes native `commit -m --trailer` and optionally `--only`. Public success is `string | null`. Empty `opts.paths: []` currently means ALL paths, unlike C2b's explicit-empty selection. |
| Undo | `attribution/index.ts:188 revertCommits` changes index/worktree through revert before calling commitAs; `undoLines` writes the file before commitAs. A guard only in commitAs is too late. Revert abort failures are currently swallowed. |
| Stage collection | `workspaces/worktree.ts:80 collect` broad-adds then captures cached binary diff against base. `runners/coding/finish.ts:102` treats its staged tree as submitted revision and calls checked-candidate sealing. |
| Candidate sealing | `attribution/checked-candidate.ts:8 sealCheckedCandidate` writes immutable commit-tree then directly update-ref's HEAD. It has authority checks but no publication-journal/lifecycle guard. It must not bypass C2b pending protection. |
| Initial preparation | `workspaces/repository-prepare.ts:203 prepareRepository` history fast-path returns unchanged; `prepareLocked` initializes Git/writes default ignore/adds/commits. Project fanout and events are `projects/repository-setup.ts:89 prepareProjectRepositories` / `recordPreparation`. |
| Recovery | `harness/resume.ts:150 reconcileRepo` aborts sequencer, stages everything, optionally reset-hard's, commits recovered edits, then updates session pointer. `abortSequencer` ignores abort failure. `reconcileEdits` catches errors into prose and continues resume processing. |
| Per-response callers | `runners/coding/native.ts:117` and `runners/supervisor.ts:382` set workspace pointers from commitAs; `harness/loop.ts:452` awaits those callbacks. Typed failure must prevent a misleading pointer or later success/collection path. |
| Worktree creation | `workspaces/worktree.ts:51 prepare` records preparing then worktree-adds from source. `runners/supervisor.ts:111 integrationRepos` creates/reuses integration worktrees. Pending state in source/retained target needs an explicit gate before reuse or side effects. |
| Integration/replay | `workspaces/merge-queue.ts:209 abortInProgress`, `restore`, `pick`, `rebase` mutate source/integration trees and swallow several abort/restore failures; `repair-hydration.ts:115 hydrateRepairWorkspace` cherry-picks retained commits after source checks. |
| Removal | `workspaces/worktree.ts:106 remove` ignores force-remove failure then marks removed. `projects/deletion.ts:222 removeProjectWorktrees` force-removes then recursively removes physical paths. Either can destroy worktree Git metadata containing unresolved journals/backups. |
| Project deletion order | `admin/projects.ts:413+` prunes Labs, writes config/purges rows, then removes files/worktrees. A late cleanup-only receipt check loses registry context first; preflight/fencing must precede prune/config/purge. |
| Brain writes | `brain/brain.ts:274 adoptExternalEdits`, `writeFile`, entry/project removal use commitAs. writeFile and removal paths can change files before committing; the Brain's existing per-repo chain is not a cross-process publication fence. Literal/mount/exclude pathspecs must survive. |

Sources above were read or traced by direct references. No exhaustive audit of every raw Git
call in the repository is claimed. Labs, backup/restore and later storage migration must
use the same lifecycle boundary before physical project-local activation.

## Must settle before wiring callers

### 1. Preserve message/trailer semantics explicitly

Add a specifically named `attribution/commit-message.ts` helper and native reference tests.
It must reproduce the existing native `git commit -m <message> --trailer ...` payload under
the supported nonexecutable repository configuration, rather than appending raw trailer text.
Reference comparisons must include default cleanup; leading/trailing blanks and whitespace;
comments, CRLF and Unicode; existing trailer blocks; duplicate/extra Actor keys; multiline
Actor values; trailer separator/order/where/ifexists/ifmissing configuration; and supported
commit.cleanup/encoding settings. Compare actual commit message bytes (`cat-file commit`),
author/committer identities and attribution parsing. Do not compare only `%s` or substrings.

Bounded trusted Git `stripspace` / `interpret-trailers` plumbing is a possible implementation,
but command/stdin authorization and config-dependent ordering require tests before choosing
it. Do not expose generic stdin/environment/shell authority or permit trailer command hooks.
If a configuration cannot be reproduced, fail before publication with an actionable error;
do not silently normalize differently. Fixed setup identity/message stays a separate path.

Map public commitAs `opts.paths` of undefined OR [] to omitted C2b paths to preserve its
existing all-path behavior. C2b's own explicit [] remains no selection. Preserve allowEmpty,
literal/positive/negative pathspecs, Brain scopes, staged A versus selected B, and no new
`--only` worktree reread after sealing. Zod bounds may explicitly refuse oversized input;
they must not truncate caller message/identity or partially publish.

### 2. One shared mutation fence, not admission-only checks

An asynchronous pending check immediately before raw Git is insufficient: a selected
publication may start after that check. Native index.lock cannot simply wrap commands
like reset/cherry-pick/revert which acquire that lock themselves.

Implement a host-only repository mutation lease in `workspaces/repository-mutation.ts`:
resolve physical Git/common owner, acquire an owned cross-process lifecycle lock, then
check unresolved publication under that lease and hold it through the entire effect.
C2b, stage-only collection, resets/aborts, integration/replay, application writes preceding
commits and deletion must cooperate with that lease. Reentrant trusted capabilities must
be opaque/active/owner-bound, never JSON/tool input. Fixed multi-owner ordering is required
for source+integration operations and project deletion. Define ordering against existing
MergeQueue branch/SQLite locks; do not hold SQLite transactions over awaits.

Keep native index/ref locks as additional protections. Do not globally intercept generic
git() without distinguishing trusted in-flight journal updates: that would make C2b block
its own pending receipt. Recovery inspection stays read-only and available while blocked.
No expired-owner lock theft from timestamp alone and no automatic HEAD rollback. Unknown
locks, incomplete receipts and uncertain publication must preserve source/evidence.

### 3. Typed effects and receipt reconciliation

Keep commitAs's `Promise<string|null>` success signature; throw a named typed error with
validated `{kind, commit, receiptId, reason}` for refused/pending/reconciliation/uncertain
effects. A committed-but-index-pending result is not a normal failed commit or a null.
Per-response/resume/Brain/integration callers must persist/report that distinction and stop
further mutations. Never update a pointer to the old HEAD, mark recovery unchanged, issue
not-applied proofs, run cleanup or auto-retry when publication is unresolved.

Before claiming caller activation, supply explicit reconciliation or an honest blocked-state
workflow: inspect exact current HEAD/index plus original/next digests; restore an index only
under the lifecycle+native locks when exact prerequisites still hold; otherwise retain evidence
and require an operator decision. No automatic rewind/overwrite of later user staging.
Project deletion must refuse before destructive config/row/file changes when such a receipt
exists, unless a separately specified explicit evidence-preserving export/removal is authorized.

## File-partitioned implementation sequence

Each row is one bounded brief. Rows sharing a file run serially; update authored docs in the
same work unit. No new checkout is needed while existing source validation is quiescent.

| Phase | Exclusive files | Deliverable and dependency |
| --- | --- | --- |
| C3.0 message | new attribution/commit-message.ts; attribution/selected-commit.ts; workspaces/git.ts and git-process-policy.ts only for exact bounded plumbing; new tests/project-metadata-commit-message.test.ts | Native byte compatibility. Finish before attributed wrapper wiring. |
| C3.1 fence | new workspaces/repository-mutation.ts; attribution/selected-commit.ts; metadata-staging.ts; new tests/project-metadata-mutation.test.ts | Shared lease and under-lease pending guard; opaque reentrancy, ordered multi-owner acquisition. Serial after C3.0 because selected-commit overlaps. |
| C3.2 attribution | attribution/index.ts; attribution/checked-candidate.ts; optional new attribution/actor.ts (index reexports retained); tests/attribution.test.ts; new tests/project-metadata-commit.test.ts | commitAs maps legacy paths/typed effects; undo guards before edits; checked-candidate exact captured-tree publication joins same fence/journal. Do not substitute worktree bytes for captured checked tree. |
| C3.3 stage/setup | workspaces/worktree.ts; repository-prepare.ts; projects/repository-setup.ts; tests/repository-prepare.test.ts; new tests/project-metadata-worktree.test.ts | C1 exclusions before snapshots; C2 collection; initial C2b commit; prepare/reuse/remove guards and honest status. Can overlap C3.2 only after stable fence/message API. |
| C3.4 resume/runners | harness/resume.ts; runners/coding/native.ts; runners/coding/finish.ts; runners/supervisor.ts; new tests/project-metadata-resume.test.ts | Guard before abort/reset/reuse; abort errors surface; exact typed failure stops pointer/evidence/finish success. Serial after C3.2/C3.3. |
| C3.5 integration | workspaces/merge-queue.ts; workspaces/repair-hydration.ts; new tests/project-metadata-integration.test.ts | Fence source+target for abort/rebase/pick/restore; unresolved outcomes preserve queue/source and never roll back another publication. |
| C3.6 Brain | brain/brain.ts; new tests/project-metadata-brain.test.ts | Fence before writes/removal/adoption; preserve literal/mount scopes, optimistic digests and no premature indexFile/success. Stable attributed API required. |
| C3.7 deletion | projects/deletion.ts; admin/projects.ts; new tests/project-metadata-deletion.test.ts | Discover receipts before Lab prune/config/row purge; hold ordered leases through destructive lifecycle; no forced loss of retained evidence. |
| C3.8 acceptance/docs | supervisor-owned integration and docs/operations.md, docs/roles.md as affected | Audit remaining mutation callsites incl. Labs/backup/restore before any global activation claim; full tests, recursive checks and panel verification for any UI/API behavior changes. |

This split names files, not concurrent topic ownership. A worker needing an already-owned
file reports the dependency; supervisor serializes it rather than permitting overlapping edits.

## Required acceptance cases

- Every mutating boundary: seed an actual head-published/index-pending receipt, invoke that
  operation, and compare HEAD, index bytes, app files, sequencer markers, pointer/status,
  project config/rows, receipt and backups. Refusal precedes its first destructive effect.
- Real two-caller races: selected commit versus stage/abort/reset/undo/replay/seal/remove;
  second admitted before intent exists still blocks after waiting. Also test independent
  repositories progress and multi-owner opposite-order requests cannot deadlock.
- Exact native message matrix and legacy undefined/[] path mapping; Brain mount positive/
  exclude/literal scope; setup empty/unborn/history fast-path and identity; partial staging,
  staged additions/deletions/binary/Unicode with exact resulting trees/index entries.
- Real junction/hardlink topology and metadata contamination refuse before content import
  or destructive abort/reset; ordinary deletes/renames still work. No relaxed assertions.
- Fault before ref prepare, after ref acknowledgement, before index rename, during receipt
  terminal update/archive: preserve typed states, no blind retry, no false not-applied proof.
- Removal failure must not claim removed; project deletion refuses before config/purge and
  retains recoverable mapping. Terminal archival cleanup can retire only owned valid backups.

## Decisions and later work

No new user preference is needed: preserve current public behavior and fail closed when
unresolved effects cannot safely reconcile. Supervisor must approve lease/lock ordering,
message compatibility support and checked-tree publication API before dispatching activation.
These are implementation decisions, not a reason to ask the user for routine permission.

Physical project-store separation, readable runtime-path activation, migration/rollback,
backup relocation and runtime rollout remain later storage-plan work. C3 does not move live
projects or credentials and does not prove unattended production delivery. Full power-loss
durability (including POSIX new-directory parent fsync and Windows limitations) needs its own
explicitly verified contract; do not infer it from ordinary process-fault tests.

Validation: source/reference reads and searches only; no tests, fixtures, source/test/build
changes, provider calls, live operations, checkouts, commits or pushes for this planning task.
