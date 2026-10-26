# Metadata-safe Git staging contract and next implementation units

Worker: project_directory_config
Date: 2026-10-26
Scope: read-only review of four staging routes, Git process policy and next unit design.
Status: proposed implementation contract; not implemented or executed against repositories.

## Actual call sites

| Source | Observed behavior | Required integration |
| --- | --- | --- |
| `workspaces/worktree.ts:Worktrees.collect` | Broad `git add -A`, then binary patch and cached name-status against original base | Shared metadata-safe staging before patch capture; reject contaminated HEAD/index first |
| `attribution/index.ts:commitAs` | Broad or explicit-path add; cached diff; attributed commit, optionally `--only` caller paths | Guard explicit pathspec selection and complete candidate index before committing; keep attribution/selection semantics |
| `harness/resume.ts:reconcileRepo` | Aborts sequencer, broad add, cached dirty list; then hard reset or commitAs | Guard before ANY reconciliation side effect, including abort/reset; use same safe staging; refusal must not erase private tracked data |
| `workspaces/repository-prepare.ts:prepareLocked` | After init/default ignore creation, add-A for existing/unborn folders, then allow-empty initial commit | Establish excludes before initial snapshot and use safe staging, including empty initial commit/index check |

`prepareRepository` fast-returns for repositories with history. Consequently this route cannot
be the only place establishing excludes for existing repositories or newly linked worktrees.
`Worktrees.prepare` creates linked worktrees; establishment must happen before runtime metadata
creation, with exact safe ordering to be wired by the later activation owner.

`commitAs(opts.paths)` currently accepts trusted Git pathspecs, not only literal file names.
Brain mount callers intentionally supply positive and negative pathspecs. Do not globally
convert these to literal paths and silently break their selection. Inspect full candidate
index regardless of requested subset: foreign private staged data is still contamination.

## Mandatory safety contract

1. Reject any reserved metadata component in HEAD tracked paths OR existing index entries
   before adding, aborting sequencers, resetting, or committing. A staged deletion does not
   authorize cleaning historical contamination; explicit separate migration must handle it.
   Support unborn HEAD explicitly; unreadable/corrupt state fails, not treated as empty.
2. Check NUL-delimited paths using shared metadata policy, not line-based Git output or text
   redaction. Inspect all entries including unmerged stages; do not assume tracked means stage0.
3. Establish local ignore without editing the user's .gitignore. Exclusion is defense in depth,
   not authorization: forced index entries and negated ignores still hit contamination checks.
4. Metadata-safe broad staging excludes reserved paths and verifies the resulting full index.
   Explicit pathspec commits likewise cannot select or indirectly include metadata. Preserve
   ordinary app changes, deletion/rename handling, attribution trailers and selection behavior.
5. No silent `git reset`, unstage, tracked-file deletion, history rewrite or cleanup of someone
   else's lock. Report a bounded error naming the contamination class, not private contents.
6. On a refusal the user's original index must remain byte-for-byte unchanged, including
   existing staged app changes. Preflight before ordinary add only proves this for already
   present contamination; it does NOT prove it for postflight failures or concurrent writers.

## Proposed helper API

Own implementation concern: NEW `workspaces/metadata-exclusion.ts` (split a specifically named
`metadata-staging.ts` if the transactional implementation would otherwise mix concerns).

```ts
assertNoTrackedProjectMetadata(repo: string): Promise<void>;
ensureProjectMetadataExcluded(repo: string): Promise<void>;
stageWithoutProjectMetadata(repo: string, opts?: {
  paths?: readonly string[]; // existing trusted pathspec semantics
}): Promise<void>;
```

`assertNoTrackedProjectMetadata` checks HEAD and index using `ls-tree -r -z --name-only HEAD`
and `ls-files -z --cached`, with explicit unborn detection. It never changes index or refs.
The same assertion serves setup, creation, collect, recovery and immediate commit preflight.
It validates metadata policy only, not proof of checked source/candidate identity.

For explicit paths, reject lexically recognizable reserved components early, append Git
negative metadata pathspecs to both staging and selection, then verify the complete actual
candidate index. Do not treat arbitrary wildcard/pathspec text as a literal normalized path.
Prefer deriving actual selected paths through Git and validating those paths; full index gate
still applies. No empty-pathspec fallback that accidentally stages everything.

## Exclude-file location and locking

- Resolve info/exclude through trusted Git plumbing (`rev-parse --git-path info/exclude`),
  and resolve Git directory/common directory with absolute paths. Never assume `.git` is a
  directory; linked worktrees have a file and share common metadata.
- Verify the resolved exclude path belongs to the expected Git metadata owner and reject
  symlink/junction redirection of the file or parent chain. Bare/unrecognized layouts refuse.
  Git config/core.excludesFile is not the target; do not modify arbitrary configured files.
- Shared lock is `<resolved-info-exclude>.lock`, opened exclusively, so linked callers serialize
  on the same actual file. Use bounded contention refusal/retry; do not delete an unknown lock
  merely because its timestamp is old. On failure remove only the lock this invocation owns.
- Preserve existing bytes/order/newline style. Append an idempotent marked block only when
  missing, preserving final newline semantics. Write/flush/close lock then atomic rename.
- Case-insensitive directory matching needs portable Git ignore patterns such as
  `.[mM][eE][rR][iI][tT][rR][oO][uU][tT][eE][rR]/` (no slash prefix: any depth).
  Do not broadly exclude `.MeritRouter-tools`; trailing-dot/space aliases still hit actual
  path policy checks, even where an ignore pattern does not match them.
- Existing HEAD/index contamination should be checked before exclude mutation if the unit
  promises no writes at all on contamination refusal. Ignoring a tracked file is insufficient.

## Index transaction and scope decision

**Source finding:** `workspaces/git-process-policy.ts:gitProcessEnvironment` allows only
author/committer identity overrides. It explicitly rejects GIT_INDEX_FILE. Current `git()`
does not expose a typed alternate-index capability. Do not bypass that policy with raw exec
or allow model-controlled environment variables to introduce an alternate index.

To meet byte-identical index preservation on every refusal, implement a narrow trusted
alternate-index capability in Git helper/policy as a separate prerequisite:

1. Resolve actual worktree index via `rev-parse --git-path index`. Hold its native `.lock`
   exclusively. Shared exclusion-file lock is separate: linked worktrees share exclude but
   each has its own index. Lock order must be consistent (exclude setup before index lock).
2. After lock ownership, reread/validate original index and HEAD, copy original index bytes
   into an exclusively owned temporary Git index in validated metadata. For unborn/no-index,
   initialize through trusted Git plumbing. No arbitrary external index destination input.
3. Run staging in the temporary index using the scoped capability; verify complete temp index
   has no metadata paths. Original stays unchanged on any failure. Native Git filters/hooks
   remain disabled/refused by existing process policy; no new command execution authority.
4. Verify expected HEAD/owner state remains appropriate, write/flush staged index bytes to
   owned native index.lock and atomically rename only on success. Cleanup only owned temp/lock.
   External normal Git commands will respect index.lock; no claim against hostile lock bypass.
5. Commit preflight and final mutation need a consistent locking design. `git commit --only`
   can rebuild selected index from worktree content; blindly validating only pre-staged index
   is insufficient. Use the scoped transaction for candidate creation/commit or prove selection
   excludes metadata and revalidate current HEAD. Do not hold native lock then launch ordinary
   git commit expecting it to reacquire that same lock.

Without this prerequisite, a simpler preflight+negative-pathspec stage can ship only with the
explicit weaker guarantee: existing-contamination refusal preserves index, but no transactional
preservation against later failures. That is not the full requested contract. Supervisor should
choose the strong prerequisite before describing metadata-safe staging as complete.

## Required exact tests (real temporary Git only)

- HEAD metadata and pre-indexed/forced metadata: collect/commitAs/prepare/resume refuse;
  capture raw index bytes before/after and assert identical, staged app entries unchanged.
- Staged deletion of tracked metadata still refuses; corrupt or unmerged index fails safely.
- Broad untracked root/nested/mixed-case metadata never enters index/commit; ordinary app
  changes, deletion and rename remain included. Linux trailing-dot/space actual paths refuse.
- Explicit commitAs paths: direct private path, wildcard selecting private+safe, existing
  positive/negative Brain pathspecs, only-safe selection with unrelated staged app edits;
  private HEAD/index contamination refuses even when outside selected safe paths.
- Initial plain-folder and unborn repository snapshot with private metadata; allow-empty
  created repo; default .gitignore creation does not include state; dirty/prestaged refusal
  does not drop staged files. Existing-history fast path remains behaviorally explicit.
- Resume commit/reset with private metadata contamination fails before abort/reset and
  preserves private+ordinary bytes/index; ordinary recovered edits still commit with trailers.
- Exclude helper preserves arbitrary existing bytes/CRLF/no-final-newline, idempotent calls,
  nested/mixed-case rules, negated tracked ignore cases, shared common-dir linked worktrees.
- Symlinked exclude file/parent, unrelated Git dir, native lock contention: refusal with no
  external writes. Concurrent callers do not duplicate/truncate blocks; stale foreign lock stays.
- Transaction staging failure, temp write/verify failure and commit selection failure preserve
  original index bytes; owned lock/temp cleanup; independent per-worktree indexes under shared
  exclude lock. No tests alter live project repositories, user config or provider state.

## Executable next-unit briefs (serial where files overlap)

**C1 — shared exclusion and contamination preflight (implementation):** own NEW
workspaces/metadata-exclusion.ts + tests/project-metadata-staging.test.ts; shared policy API
already exists. Implement read-only HEAD/index preflight and locked idempotent info/exclude
setup. Do not wire broad staging yet. Tests cover all contamination/exclude/linked/lock cases.
Report exact limits; root review before next stage. No commits or live-state operations.

**C2 — transactional staging capability (implementation after C1 API freeze):** own
workspaces/git.ts, workspaces/git-process-policy.ts, NEW workspaces/metadata-staging.ts and
NEW tests/project-metadata-index-transaction.test.ts. Preserve all existing Git process policy;
introduce only host-owned validated alternate-index capability. Implement native-lock/temporary
index staging with unchanged original index on refusal and bounded cleanup. Parent must review
explicit commit selection contract before C3; no permission broadening or source-identity edits.

**C3 — integrate four routes (implementation after C2 acceptance):** own workspaces/worktree.ts,
workspaces/repository-prepare.ts, attribution/index.ts and harness/resume.ts plus new integration
tests. Use accepted helper before every index-changing/recovery effect, including initial
allow-empty commit and explicit commit paths; establish excludes where needed without implying
legacy tracked metadata is repaired. Preserve attribution and full checked-source semantics.

**D remains serial:** source-identity/exact-candidate code needs its own brief after C3. Runtime
metadata writes must not expire clean app approvals, but tracked/indexed contamination cannot
be silently omitted from exact source identity.

## Verification limits

Read named files and searched source references only. No tests, Git mutations against project
repos, source edits, runtime changes, migrations, commits or pushes. Recommendations require
implementation review; no current staging safety or physical-storage activation claim.
