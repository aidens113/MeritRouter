# C2b selected-commit resumed correction

Date: 2026-10-26
Worker: selected_commit_resume
Status: source frozen; supervisor fresh-source acceptance pending.
Directory: existing `.MeritRouter/development/metadata-exclusion` worktree.

## Scope and changes

Resumed the existing uncommitted draft without making another checkout. The paused draft
already included the under-index-lock unresolved-publication gate, bounded Git metadata
write topology preflight and v2 pending/sharded archive receipt layout. These are existing
draft changes being validated, not worker claims of fresh implementation.

- Added trusted host-only admission observation to reproduce a second invocation admitted
  before the first receipt exists. The real Git regression leaves the first HEAD published
  with its original index and requires the second invocation to refuse after admission.
- Added real junction/symlink regressions for redirected branch refs, reflogs and object
  buckets; a hardlinked packed-refs refusal; and linked-worktree/shared-ref success.
- Updated the backup-tampering fixture to retain genuinely unresolved backups instead of
  expecting terminal full-index backups after the v2 release policy. Unknown version is 999.
- Added terminal receipt audit/backup release, later-staging/history distinction and admission
  with more than 1000 unrelated archive entries. Only pending history is admission input.
- A failure archiving an already complete publication no longer downgrades its successful
  commit outcome to reconciliation required. Terminal evidence remains for later retirement.

## Validation

- Baseline selected tests: `pnpm exec vitest run tests/project-metadata-selected-commit.test.ts
  --maxWorkers=1` -> exit 1, 20 passed / 1 failed, 123.22s. Sole failure was the outdated
  retained-backup fixture reading a correctly retired terminal `next.index`; corrected above.
- `pnpm --filter meritrouter typecheck` -> exit 0.
- `pnpm exec vitest run tests/project-metadata-index-transaction.test.ts
  tests/project-metadata-selected-commit.test.ts tests/project-metadata-exclusion.test.ts
  --maxWorkers=1` -> exit 1, 59 passed / 2 failed / 1 POSIX-only skipped (62), 230.06s.
  C1 passed 18/18; C2 passed 15 with 1 skip; selected file passed 26 with 2 failures.
  Both failures were packed-ref fixture setup using a command deliberately absent from the
  runtime allowlist. Fixed those two test setups to fixed native `execFileSync` fixture-only
  calls; runtime policy was not widened. The running suite had captured the previous test
  snapshot. All gate, redirected destination and history regressions passed. Supervisor owns
  final fresh-source acceptance; no worker duplicate run was started.
- Attempted native commit-message comparison in disposable OS temp was rejected by automatic
  approval review (`blocked by policy`); no comparison executed and no retry attempted.

## Remaining limits

Existing callers remain unwired. No live runtime activation, provider call, project migration,
shared accounting change, commit, push or sibling drive-root directory creation was performed.

Ordinary `git commit -m` whitespace cleanup and configured trailer behavior remain an explicit
pre-activation compatibility gap: this draft directly supplies constructed commit-tree stdin.
The existing setup identity/message and ordinary Actor trailer tests cover their exact samples,
not all native cleanup/configuration semantics. This API is a prerequisite, not a drop-in
accepted replacement for every existing commit caller.

No race-free hostile-filesystem-swap guarantee, reftable acceptance, POSIX-only fixture
acceptance on Windows, application/power-loss crash acceptance, or automatic reconciliation
is claimed. Unresolved receipts retain exact index backups and still need a future explicit
reconciliation and managed-worktree deletion contract. Independent review is in progress.
