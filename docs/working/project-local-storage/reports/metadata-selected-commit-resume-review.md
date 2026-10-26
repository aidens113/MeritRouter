# Independent resumed C2b review

Reviewer: selected_commit_review
Date: 2026-10-26
Status: no new blocker found for the isolated prerequisite API; caller activation remains unaccepted.

## Reviewed snapshot

Author confirmed source freeze before final review. Read selected-commit, selected-commit-receipts,
selected-ref-publication, git-write-topology, Git process/index/staging implementation and new
selected tests. Relevant SHA256 values:

| Source | SHA256 |
| --- | --- |
| attribution/selected-commit.ts | B02829DA39EC11C14537C0380701F5D25C157736292C55B75CDAE928904BC02D |
| attribution/selected-commit-receipts.ts | F70A8AFC1A2C1455EA40F7F2335C58CA468495014C9FD999D8EC16E0CDB38525 |
| attribution/selected-ref-publication.ts | C9F1DFEF37E702D6D782796167EA498E02A73889932BADE046280807E2A398B9 |
| workspaces/git-write-topology.ts | 28B536D3EF9380AC06DA9BFBC04D1CC05EF7AE232220FDA506408E31D8B7ACE2 |

## Prior blockers

1. Pending-publication admission is rechecked inside the acquired native index transaction,
   before staging a new candidate. An invocation admitted before the first receipt exists
   can no longer use that earlier admission after waiting for index.lock.
2. Git write topology preflights actual Git/common directory ancestors, refs and reflog
   trees, packed refs, loose object bucket directories, object pack/info directories and
   HEAD before native staging/publication. Publication rechecks before prepared commit.
   Existing directory junctions, symlinks and hardlinked ref/log files are refused.

## Receipt/crash review

- Pending admission scans bounded unresolved/terminal pending entries, never the completed
  archive. Archived history cannot create the old 1000-completed-commit admission cap.
- Archival first validates terminal receipt and exact backups, moves terminal evidence to
  a sharded archive, replaces its retained/released flag, then deletes only hash-matching
  owned index backups. A crash between these steps leaves terminal evidence and possibly
  backup residue; it does not intentionally discard unresolved publication evidence.
- Unknown files or receipt locks refuse archival and remain untouched. Terminal pending
  residue can conservatively block later admission until explicit cleanup. Archive failure
  after a fully completed publication no longer misreports that publication as index-pending.
- Unresolved/uncertain receipts retain backups and block selected commits. No automatic HEAD
  rewind or index restoration is introduced. Historical completion is distinct from current
  HEAD/index observations after later user changes.

## Independent verification

PowerShell `$probe | node` executed a reviewer-authored Node probe. It recursively transpiled
the exact 11 imported TypeScript modules into an OS-temp ESM fixture, linked its dependency
resolution to this isolated package, and used actual disposable Git repositories. Exit 0:

```json
{"modules":11,"results":[{"case":"concurrent-pending","first":"reconciliation_required","second":"refused","head":"first"},{"case":"hardlinked-reflog","denied":true,"foreignUnchanged":true},{"case":"archive-admission","second":"committed"}]}
```

The concurrent case started the second invocation from the first candidate's sealed
callback, waited for explicit second admission, then injected a post-ref/pre-index failure.
The hardlink case linked `.git/logs/HEAD` to a foreign temp file and compared exact bytes
after refusal. The archive case corrupted an unrelated completed archived receipt and
verified a subsequent selected commit still succeeded. Probe temp data was removed.

Independent targeted command from isolated `packages/router`:

```text
pnpm exec vitest run tests/project-metadata-selected-commit.test.ts --maxWorkers=1 -t "refuses redirected|refuses hardlinked packed|supports linked-worktree"
```

Exit 0: 5 PASS / 23 not-selected SKIP, 13.09s. Cases: redirected refs/heads,
logs/refs/heads and objects/ab; hardlinked packed refs; linked-worktree common refs with
packed original branches. These are targeted selection skips, not unsupported-platform skips.

## Acceptance limits

- Ordinary `git commit -m --trailer` whitespace cleanup and repository trailer formatting
  compatibility remain an explicit preactivation gap: commit-tree currently builds raw
  message/trailer text. This review does not certify interchangeable existing caller behavior.
- C3 must gate every mutation/cleanup path against unresolved intent; stage-only legacy
  APIs do not yet supply that complete caller-level boundary. No callers are wired here.
- Existing metadata preflight is not a sandbox against hostile concurrent filesystem swaps
  or processes ignoring Git locks. Full process/power-loss acceptance is absent. POSIX parent
  entry fsync coverage is not established for newly created journal-root/pending directories;
  Windows directory fsync is unavailable here. Do not claim general power-loss durability.
- No physical project-store migration, live source activation, full suite, cross-platform,
  reftable, provider or downstream application acceptance was performed by this reviewer.

Only this report was written. No source/tests/shared documents, live data or services changed;
no commits, pushes, new checkouts or drive-root directories created.
