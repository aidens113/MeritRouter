# Immutable selected commit and publication receipts

Worker: project_directory_config
Date: 2026-10-26
Workspace: D:/SwitchYardRouter/.MeritRouter/development/metadata-exclusion
Base: accepted C2 b9d866f, synchronized feature branch b7cf87b
Status: implemented and source frozen; final focused validation and isolated typecheck passed

## Owned implementation

- Extended workspaces/git-index-transaction.ts with host-only sealed publication callback,
  immutable expected-HEAD sibling index and snapshot accessor; default C2 staging stays intact.
- Extended workspaces/git.ts with exact bounded cached-apply stdin and exact commit-tree
  message stdin; index capability accepts only exact cached/index-only apply flags and expected
  HEAD read-tree initialization. Arbitrary stdin/env/index/commit capability remains forbidden.
- workspaces/metadata-staging.ts exports stageSelectedIntoOwnedIndex for reuse, retains the
  stageWithoutProjectMetadata API, handles staged deletions via expected-HEAD selection and
  corrects copied-index stat-cache behavior without globally renormalizing unchanged files.
- Windows-only trusted SAFE_CONFIG core.longpaths=true; no repository/global config writes.
  Owned temporary indexes use crypto-random exclusive mkdir instead of Windows-limited mkdtemp.
- NEW attribution/selected-commit.ts, selected-commit-receipts.ts and selected-ref-publication.ts.
- NEW tests/project-metadata-selected-commit.test.ts; two proportional regressions added to
  owned project-metadata-index-transaction.test.ts. No existing caller/Actor edits or commits.

## APIs and exact-tree behavior

`commitSelectedApplication(repo,{actor,message,paths?,allowEmpty?,extraTrailers?},hostControl?)`
validates runtime data with zod. It returns typed `unchanged`, `committed`, `refused`,
`reconciliation_required` or `publication_uncertain` outcome; published/pending states always
include exact commit and durable receipt ID. Early pre-intent validation errors throw with
no owned ref publication. A refused result may name an unreachable candidate commit object;
it must not be interpreted as a successful HEAD publication.

`commitInitialApplicationSnapshot(repo,"created"|"snapshot",hostControl?)` is a separate fixed
host setup wrapper. It uses MeritRouter/meritrouter@localhost and exact existing initialization
messages, allowEmpty and NO Actor trailers. Normal Actor input cannot activate that mode.

One preserved index starts from original staged entries. Selected physical inputs are checked
before copying content; current selected changes stage there once. A second index starts from
immutable expected HEAD (empty for unborn). Bounded binary cached diffs restricted to selected
literal paths transfer those SAME captured blobs through exact cached-only apply. No final
commit --only rereads worktree content. Unrelated staged entries stay outside the commit and
remain staged in preserved index. Ordinary/staged deletions and staged new paths are included
through Git's original positive/negative/literal pathspec selection.

Commit-tree uses the immutable selected tree and expected parent, existing Actor identity and
trailers, terminated message payload. Existing merge/cherry-pick/revert states refuse rather
than being flattened into a one-parent commit. Explicit empty selection stays empty; allowEmpty
is explicit. Scoped host callbacks support independent observed validation/fault injection,
never model tool arguments or persisted permissions.

## Why publication uses prepared literal HEAD transactions

Actual local Git2.55 probes found:

- symref-verify HEAD plus branch create/update in the same stdin transaction refuses with
  multiple HEAD updates (even with no-deref per command).
- Single-shot no-deref update HEAD new old accepts a same-oid currently-symbolic HEAD and
  detaches it; this is NOT symbolic-type compare-and-swap.
- Literal update HEAD new old followed by prepare establishes native HEAD.lock in attached
  and detached cases. Verifying raw HEAD type/target while that queued HEAD update holds its
  lock, before sending commit, closes the same-oid target race. Actual probe committed attached
  and detached cases and aborted a detached-to-symbolic same-oid race with old HEAD unchanged.

The implementation supports file-backed refs only and fails closed when it cannot prove
required native locking/backend/protocol. It invokes fixed interactive update-ref --stdin
through existing trusted process policy, bounded output/time, expected old OID (create for
unborn), waits for prepare acknowledgement, records native lock identities, verifies raw HEAD
type/target and live process/lock ownership, then sends commit. Ordinary symbolic mutation
while prepared is refused by Git's native lock.

Foreign HEAD locks are preserved. A prepared dead process is observed before sending commit;
the protocol is drained, and only recorded inode/device-owned ref locks may be removed AFTER
process/stdout quiescence when no commit was sent. After commit is sent, missing acknowledgement
is uncertainty; acknowledgement followed by later failure remains published. No automatic
HEAD reset, force-update, or sweeping of stale/foreign locks is added.

Primary documented semantics: [Git update-ref](https://git-scm.com/docs/git-update-ref)
describes prepared ref locks and explicit commit/abort. This report's specific Windows behavior
is independently probed, not inferred from version alone. [Git add](https://git-scm.com/docs/git-add)
documents renormalize as forced refreshing; use is restricted to proven changed cached inputs.

## Publication journal and failure contract

Before ref publication, bounded original/next index backups and versioned zod receipt are
written/fsynced under the owned worktree Git metadata `meritrouter-publications/pc_<id>`.
The journal binds old/new commit, symbolic target, selected tree and index SHA256s. Updates
use exclusive receipt lock, expected-content digest and atomic rename. No prompts, credentials,
arbitrary shell commands or model permission fields are journaled.

Native index rename occurs AFTER ref commit; these are deliberately NOT claimed atomic.
Index failure leaves exact committed HEAD and a reconciliation_required outcome with retained
backups. Acknowledgement uncertainty retains uncertain intent. Future selected commits refuse
unresolved receipts instead of blind retry. Complete/refused history stays auditable.

`readCommitReceipt` validates bounded regular/unlinked files, version/identity and backup
digests. `inspectSelectedCommitPublication` is READ ONLY and distinguishes exact complete,
HEAD-published/index-pending, not-currently-published and uncertain observations. It never
automatically rewrites HEAD or restores an index over later user changes.

## Bugs found and corrected during implementation

1. Copying index bytes changes its filesystem timestamp; Git could skip a same-length racy
   selected file and commit an older partial stage. Tests preserved the original full-current-B
   assertion. Shared helper now physically preflights inputs then asks the locked NATIVE original
   index for changed/racy paths; only genuinely changed PRESENT cached files get forced refresh.
   Clean cached entries retain normal Git add behavior; new paths/deletions use ordinary add-A.
2. Global renormalize would stage unchanged CRLF files after core.autocrlf changes. Root reproduced
   this; added actual ordinary-Git reference comparison, retained same-length standalone test.
3. Forced renormalize cannot stat removed files; existing ordinary-deletion regression caught it.
   Corrected missing tracked paths to ordinary add-A, without changing assertion or adding delay.
4. Windows232-character cwd supports Git long paths but Node mkdtemp exceeded its own Windows
   prefix boundary. Exclusive crypto-random mkdir fixes contained temporary index creation.
5. Killing a Git launcher PID alone does not prove the underlying prepared transaction stopped.
   The host fault fixture now observes exit, protocol drains before classification, locks are
   cleaned only with recorded ownership and quiescence proof; published/unknown outcomes remain typed.
6. Commit-tree stdin requires explicit terminating newline to preserve setup commit message
   payload behavior. Production message termination corrected; setup assertions unchanged.

## Validation receipts

- Actual environment: Node v22.11.0, git version2.55.0.windows.3.
- Initial selected suite13/16 passed; failures exposed racy partial stage, launcher termination
  classification and Windows mkdtemp boundary. Subsequent selected16/18 passed; remaining setup
  newline mismatches corrected. Later21/21 selected checks passed on successive snapshots.
- Latest completed combined pre-final-deletion-fix run:53PASS/1FAIL/1POSIX-onlySKIP across3files,
 170.12s; existing ordinary deletion failure drove the final partition correction. Do not call
  this aggregate green. One earlier superseded combined run was stopped; no green claim for it.
- Final frozen-source `pnpm exec vitest run tests/project-metadata-index-transaction.test.ts tests/project-metadata-selected-commit.test.ts tests/project-metadata-exclusion.test.ts --maxWorkers=1`
  ->54PASS/1POSIX-onlySKIP across3files, exit0,174.90s (C2:15PASS/1SKIP; C2b:21PASS; C1:18PASS).
- Final `pnpm --filter meritrouter typecheck` in isolated tree ->exit0.
- Source and runtime stayed isolated; no main-tree/shared dist/node_modules mutation, provider calls,
  live project operations, existing caller changes, commits or pushes by this worker.

## Remaining limits before caller activation

- This is a prerequisite API; collect/commitAs/setup/resume do not use it yet. C3 wrappers must
  preserve typed pending/uncertain states and guard all mutation/cleanup paths against unresolved
  publication intent, not merely selected commits. Current standalone stage API has no receipt guard.
- Explicit index reconciliation is not implemented. Inspector supplies durable evidence, not
  permission to overwrite a user's later staged work. Pending receipt/backup lifecycle must be
  integrated before managed worktree deletion removes its worktree Git metadata directory.
- POSIX trailing-dot/space physical fixture remains skipped on Windows; no full cross-platform
  or reftable acceptance claim. Git older than required protocol/backend fails closed.
- Existing C2 strict link/hardlink/submodule/sparse/split-index limitations and size/time bounds
  still apply. Link checks are bounded preflight, not race-free OS isolation against hostile
  filesystem swaps/native-lock bypass. Windows directory fsync is unavailable through this
  implementation; file fsync/atomic rename are used, full power-loss durability is unverified.
- Host control callbacks are trusted code, not a sandbox. Real process-kill Git protocol tests
  cover prepared-child death and timeout; full application process/power-loss crash recovery is
  not claimed. No paid routing, autonomous production-readiness or physical storage migration claim.
