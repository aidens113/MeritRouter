# Host-owned metadata-safe index transaction

Worker: project_directory_config
Date: 2026-10-26
Workspace: D:/SwitchYardRouter/.MeritRouter/development/metadata-exclusion
Base: accepted C1 2cb0e0e
Status: implemented; focused checks passed; source frozen for independent review

## Owned changes

- `workspaces/git.ts` and `git-process-policy.ts`
- NEW `workspaces/git-index-transaction.ts`, `workspaces/metadata-staging.ts`
- NEW `tests/project-metadata-index-transaction.test.ts`
- This report. No C1 helper, existing staging callers, shared docs, main tree or commits changed.

## APIs and authority

`withGitIndexTransaction(repo, async capability => result)` is a trusted host-only staging
transaction. It issues an opaque frozen object registered in a private WeakMap. Capability
validity binds active lifetime, canonical repository and owned temporary index path. JSON,
object-copy forgery, foreign repository and replay fail. It expires after60seconds and allows
only add/ls-files/diff/write-tree or exact read-tree --empty; commits, refs/config mutations,
output/pathspec-file redirection and oversized arguments are refused.

`git(..., { index: capability })` passes that active capability through process policy. Raw
GIT_INDEX_FILE overrides remain denied and inherited Git environment redirection remains
stripped. Existing executable config/filter/hook/credential/network restrictions remain.
Scoped calls cap timeout at10seconds and output at32MiB. Non-capability Git behavior retains
its existing Promise result and policy. No worker/model-facing capability issuer is exposed.

Git now returns the tracked command Promise directly. On callback return the public capability
is revoked immediately; commands the callback accidentally left unawaited are drained and
cause refusal before publish. Callback failures likewise revoke/drain before cleanup. Final
postflight uses a separate private validation capability inaccessible to the callback.

## Transaction behavior

- Read-only C1 preflight, trusted worktree-specific Git index location/ancestry validation.
- Acquire native index.lock exclusively; wait bounded2seconds, never reclaim foreign locks
  based on age. Snapshot original bounded index bytes, HEAD and symbolic branch under lock.
- Create owned temporary directory inside the verified worktree Git directory; copy existing
  index or initialize an unborn index with read-tree --empty. No original index mutations.
- Await host callback; revoke/drain; inspect complete candidate index and its physical file
  paths. Verify current original HEAD/branch/index still match snapshots before publish.
- Revoke/drain private validation, remove temporary files before publication, fsync the new
  bytes into the owned native lock, verify ownership/ancestry and atomically rename index.lock.
- On refusal/failure clean only owned temporary state/lock; original index bytes are unchanged
  by the transaction. Concurrent external changes are not overwritten/restored from stale data.
  HEAD/refs are never changed. Cooperating Git writers serialize using the native lock.

`stageWithoutProjectMetadata(repo, { paths? })` is the metadata-safe host consumer. It validates
bounded pathspec inputs, establishes C1 excludes, then uses the transaction. Explicit empty
selection does not stage all. Original positive/negative pathspec selection is expanded through
Git ls-files (tracked and untracked-not-ignored); only safe selected literal files are staged in
bounded chunks. Name-variant metadata is filtered before add, independent of ignore negation.

`assertSafeIndexInput` checks selected physical ancestor chains and file identity without
reading contents. Symlinks/junctions, hardlinked files, physical escapes and reserved metadata
aliases refuse before any stage helper add. Missing ordinary tracked files remain deletions.
Every selected input is preflighted before the first add and rechecked before its own chunk;
complete index physical paths are rechecked before publish. Private metadata names alone are
not treated as protection against physical aliases.

## Actual verification

- Initial C2 run:13 PASS/1 POSIX-only SKIP,35.30s.
- Final `pnpm exec vitest run tests/project-metadata-index-transaction.test.ts tests/project-metadata-exclusion.test.ts --maxWorkers=1`
  ->31 PASS/1 POSIX-only SKIP across2files, exit0,67.22s. Includes accepted C1 regressions.
- `pnpm --filter meritrouter typecheck` in isolated tree ->exit0 after final source changes.
- Actual temporary Git tests: raw/forged/copied/foreign/replayed capability refusal; allowed
  read and forbidden commit; source HEAD unchanged; unrelated staged blob retained while
  selecting app changes; positive/negative wildcard/empty selection; ignored/negated private
  paths; real Windows hardlink/junction refusal and private sentinel blob absent from object
  store; ordinary tracked deletion; unborn/no-index success/failure; callback/postflight failure
  preserves raw original index bytes; unawaited commands drained then refused; old foreign
  native lock retained; concurrent cooperating calls; independent linked-worktree index.
- POSIX actual trailing-dot/space directory test is present but skipped on Windows. The
  shared policy filters those names; actual POSIX execution is not claimed by this worker.

## Boundaries and honest limitations

No existing caller uses C2 yet. No C3 integration, command permission change, paid/provider
call, physical project-storage activation, live project mutation, index migration or commit.

This low-level transaction is trusted host authority, not a sandbox for arbitrary callbacks.
Only stageWithoutProjectMetadata supplies the before-content-copy input guard. A host callback
deliberately calling raw add on private files can create Git objects before postflight refuses
publication (the postflight test uses fixture-only contents). Never expose low-level callback
or capability to untrusted model arguments. Public model tools remain separate.

Link/ancestry checks are bounded preflight against cooperating processes, not race-free OS
capability security against malicious filesystem swaps or native lock bypass. A callback that
never settles can retain its owned lock; expired capability cannot launch new commands, but
no unsafe automatic foreign-lock reclamation is added. Deferred recovery requires typed ownership.

Selected symlinks, hardlinks, submodule/non-file entries and a committed repository with missing
index refuse conservatively. Split/sparse-index compatibility is unverified and may fail closed.
Maximum inputs/index entries20000, index/output32MiB, pathspec count128/combined30000characters,
filename4096, bounded literal chunks and60second capability lifetime may reject large projects.

Index-byte preservation does not undo valid ordinary Git objects created during a later-failed
temporary staging pass; private aliases are checked before copying their bytes. Exclude setup
can change local info/exclude even when later staging refuses, while original index is preserved.

## C3 commitAs integration tradeoff

Ordinary `commitAs --only` rebuilds a selected commit view from current worktree paths and can
perform new content reads after C2 staging. Publishing a safe index then calling ordinary
commit --only is NOT a complete safe commit transaction. C3 needs a separately reviewed
candidate-tree/commit/ref publication design preserving unrelated staged changes and existing
attribution/pathspec semantics, or another scoped commit protocol. Do not broaden this
staging capability's command whitelist to commit and assume those guarantees follow.
