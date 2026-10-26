# Git metadata exclusion foundation

Worker: project_directory_config
Date: 2026-10-26
Branch: feat/project-metadata-exclusion
Base: 87feb17
Workspace: D:/SwitchYardRouter/.MeritRouter/development/metadata-exclusion
Status: implemented, focused checks passed, source frozen for independent review

## Independent-review corrections

Reviewer reproduced two defects in the original16-test version: earlier pattern presence
was mistaken for effective exclusion after a later negation, and a maximum-size input could
produce an output exceeding the helper's own read limit. Both are corrected in frozen source.

Idempotency now requires the owned pattern to be the final nonempty/noncomment rule; later
negation causes a byte-preserving final reassertion. This establishes ordering only within
info/exclude; higher-priority .gitignore overrides remain a documented staging-boundary limit.
The complete appended output must fit the same1MiB limit before any publication.

`pnpm exec vitest run tests/project-metadata-exclusion.test.ts` after fixes ->18/18 PASS,
exit0,34.22s (33.70s execution). Actual-Git regressions confirm negation first exposes private
untracked state, helper then restores exclusion, original prefix/index preserved, next call
idempotent; full1MiB input refuses unchanged with owned lock cleaned, exactly-fitting1MiB
output remains readable and idempotent on next call. Isolated package typecheck exit0 again.
No main-tree, existing source/caller, commit or live-state changes. Ready for re-review.

## Owned changes

- NEW `packages/router/src/workspaces/metadata-exclusion.ts`
- NEW `packages/router/tests/project-metadata-exclusion.test.ts`
- This report. No existing caller/source files changed. No commits or pushes.

## API and behavior

`assertNoTrackedProjectMetadata(repo): Promise<void>` is read-only. It checks NUL-delimited
index entries and HEAD tree paths with the shared metadata predicate; metadata in either
refuses with explicit migration guidance. Staged deletion does not hide contaminated HEAD.
Corrupt/unmerged index fails closed. An unborn HEAD must be valid symbolic refs/heads target
absent from existing branch refs; malformed HEAD does not count as an empty repository.

`ensureProjectMetadataExcluded(repo): Promise<void>` runs that preflight before any writes,
resolves actual Git/common directories and info/exclude through trusted Git plumbing, and
verifies expected common ownership. It rejects existing linked/non-directory ancestry and
non-regular/symlink/hardlinked exclude files. Linked worktrees use the shared common exclude.

It exclusively acquires `info/exclude.lock`, waits at most two seconds on contention and
never removes a foreign lock based on age. It repeats contamination/ancestry checks after
lock acquisition, preserves existing byte prefix and CRLF/LF conventions, appends a marked
case-insensitive any-depth directory ignore pattern once, syncs and atomically renames.
Owned-lock cleanup compares device/inode and refuses changed lock ownership. No index is
staged, reset, restored or otherwise mutated by this API. A missing info directory may be
created beneath the verified Git common directory after the read-only contamination check.

## Observed verification

- `pnpm install --offline --frozen-lockfile --ignore-scripts` in isolated tree: exit0,
  3m9.1s,219 packages reused,0 downloaded. Manifest/lockfile unchanged. Expected CLI bin
  warning because this isolated tree has no built dist/cli.js; package installation succeeded.
- `pnpm exec vitest run tests/project-metadata-exclusion.test.ts` in isolated packages/router:
  final16/16 PASS, exit0,22.32s (21.87s execution). Earlier14/14 also passed before two
  additional malformed-HEAD/hardlinked-exclude tests.
- `pnpm --filter meritrouter typecheck` in isolated tree: exit0.
- Real temporary Git checks: clean/unborn, indexed/forced private data with staged app edits,
  metadata HEAD with staged deletion, corrupt/unmerged index, original index byte identity,
  arbitrary exclude bytes/CRLF/no-final-newline/idempotency, ordinary similar names, nested
  mixed-case exclusion, concurrent calls, linked worktree/common exclusion, stale foreign
  lock preservation, redirected info junction, hardlinked exclude and malformed HEAD.
- No root/shared node_modules or dist mutation. Supervisor notified source freeze.

## Limits and next steps

This implements only C1 exclusion/preflight. It is not called by creation, collect, commitAs
or resume yet; broad staging remains unchanged. Runtime data layout/migration is not activated.
Ignore rules are not authorization and do not protect forced index writes by other processes.

Physical link checks are bounded preflight, not race-free capability security against an
actively hostile process swapping ancestors between awaits or bypassing native lock protocol.
Lock cleanup only manages its own successfully acquired lock; no stale foreign-lock repair.
Appending ignores does not repair tracked/indexed metadata or delete private history.

Next C2 needs a narrowly trusted alternate-index capability and native index lock to preserve
user index bytes on every staging refusal; current Git environment policy intentionally rejects
arbitrary GIT_INDEX_FILE. C3 wires the four staging/recovery paths only after C2 acceptance.
Exact source identity/candidate checks remain their own later partition.

No live project data, provider calls, permissions, existing source, schema, configuration,
shared working docs, Git history or application files changed.
