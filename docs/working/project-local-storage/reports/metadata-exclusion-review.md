# Independent Git metadata exclusion foundation review

Reviewer: runtime_path_contract
Date: 2026-10-26
Workspace: D:/SwitchYardRouter/.MeritRouter/development/metadata-exclusion
Status: both reproduced helper defects corrected and independently re-probed; no remaining C1 blocker found. No staging integration reviewed.

## Findings requiring correction

Historical findings below are resolved by the correction described next.

## Correction verification

Final source now recognizes only the last nonempty/noncomment ignore rule as its owned
pattern, reasserting the pattern after a later negation. It also checks final appended size
before writing/publishing the lock file. Existing input/output size bounds are coherent.

Independent actual-Git Node ESM probe (exact source transpiled in memory; disposable fixture,
no dist/source writes), exit0,7.25s:
- Existing owned pattern plus later `!.MeritRouter/`: untracked output empty after ensure;
  prior exclude prefix preserved and repeated call byte-identical.
- Existing1048576byte input requiring append: refused; original exclude bytes unchanged.
- Input sized for exact-fit appended output:1048576bytes, repeated call byte-identical.

Root owns the corrected18test focused rerun; this reviewer did not rerun the broad suite.

## Original findings (resolved)

1. **Existing pattern followed by negation is treated as effective exclusion.**
   `ensureProjectMetadataExcluded` returns if the pattern occurs anywhere in info/exclude.
   Independent actual-Git probe: call ensure; append `!.MeritRouter/`; create
   `.MeritRouter/private.txt`; call ensure again; `git ls-files --others --exclude-standard`
   returns `.MeritRouter/private.txt`. Reassert the final effective pattern or refuse an
   ambiguous ordering; merely finding an earlier line does not establish exclusion.
   Add regression with existing exact pattern plus later overriding negation.
2. **Accepted maximum-size input produces output rejected by the next identical call.**
   Independent probe writes1048576bytes of comment text, calls ensure successfully, observes
  1048663byte exclude, then second ensure throws `Git exclude file exceeds the supported size limit`.
   Check final appended size before lock publication and preserve existing bytes on refusal,
   or define a coherent bounded input/output policy. Add exact-boundary idempotence/refusal test.

## Inspected and verified positives

- Index-stage and HEAD tree checks both precede exclude writes; staged deletion cannot hide
  metadata in HEAD. Malformed/unmerged/corrupt states fail closed. Existing index bytes are
  preserved by focused fixture checks. Valid unborn symbolic HEAD is treated separately.
- Actual Git/common-dir resolution checks expected exclude location, physical ancestry,
  regular unlinked exclude, shared linked-worktree exclusion and independent indexes.
- Exclusive exclude.lock serializes cooperating callers; foreign locks are not reclaimed by
  age. Owned cleanup compares inode/device. Byte-prefix/newline preservation and existing
  normal-input idempotency are covered by actual tests.
- Independent temporary probe: missing info directory is created successfully; bare repo
  refuses through Git's worktree guard before any exclude write.

## Verification

- `pnpm exec vitest run tests/project-metadata-exclusion.test.ts --maxWorkers=1` executed
  in isolated packages/router ->16/16 PASS, exit0,21.13s. Those existing tests do not
  cover the two independently reproduced defects above.
- Node ESM inline probe read exact helper and transitive source with TypeScript transpilation
  in memory (no emitted dist/source changes), executed actual Git in a new OS-temp directory,
  then removed only that fixture. Exit0; output:
  `negation: untracked=.MeritRouter/private.txt`, `size:1048663; second=size limit refusal`,
  `missing-info:created=true`, `bare:refused`.

## Limits, not additional blockers for C1

- info/exclude has lower precedence than repository .gitignore rules. A later/high-priority
  user rule can expose metadata despite a valid local exclusion. This helper alone cannot
  authorize staging or claim metadata never enters Git; C2/C3 must enforce independent
  index/HEAD refusal and explicit protected staging.
- Existing links/checks/locks do not prevent hostile concurrent filesystem swaps. Locking is
  a cooperating Git protocol, not a race-free OS capability. No foreign-lock repair implied.
- Branch or commit changes across awaited preflight are not held under an index lock here;
  no transactional staging promise. No existing caller uses this helper yet.
- No tests against user projects/providers. No source, live state, shared docs, commits or
  main-tree/dist changes by this review.
