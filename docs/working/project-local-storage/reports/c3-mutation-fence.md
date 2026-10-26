# C3.1 repository mutation fence

Worker: c3_message
Date: 2026-10-26
Status: implementation/tests frozen; focused final checks passed; supervisor acceptance and caller wiring pending.
Directory: MAIN `D:/SwitchYardRouter`; no new checkout or repository metadata/cache directory.

## Scope and API

Owned files: new workspaces/repository-mutation.ts, attribution/selected-commit.ts,
workspaces/metadata-staging.ts, new tests/project-metadata-mutation.test.ts, this report.
Accepted C3.0 helper/source remains unchanged.

`withRepositoryMutation(repositories, action(capability), {capability?, timeoutMs?})`:

- Resolves physical Git/common owners, acquires common-owner lock files in deterministic
  code-unit order, then checks each requested worktree's pending publication journal.
- Lock order is lifecycle common-owner -> native index/ref. No SQLite transactions may be
  held across this asynchronous boundary. Existing native locks and publication protocol stay.
- Coordination locks are regular exclusive files in existing Git metadata, with version,
  random token and PID; no new project-root metadata folder is created. Unknown/stale locks
  are preserved, not stolen based on time, PID reuse or apparent process liveness.
- Reentrant capabilities are frozen objects backed by WeakMap identity. JSON/copies/expired
  scopes cannot authorize mutation, and nested callers cannot widen the parent's owner set.
  Every newly requested linked worktree still gets its own under-lease publication check.
- Nested scope promises are registered immediately, drained and revoked before unlock.
  An outer caller abandoning live nested mutations receives a typed unawaited error only
  after those scopes settle. Newly attempted reentrancy after revocation refuses.
- Lock release checks physical ancestors, regular/unlinked type, inode/device and exact
  token-bearing contents, then rechecks inode after closing before unlink. Replacements
  remain untouched; release uncertainty is surfaced, never represented as safe rollback.

Typed `RepositoryMutationError.detail` has a strictly validated kind/reason and optional
bounded receiptId for an identified unresolved publication. Pending/busy/invalid scope,
ownership change and unawaited mutations are distinct outcomes for future wrappers.

## Integrated entrypoints

- Selected commits prepare read-only message data and call the observation-only admitted
  callback before first acquisition. No staging/exclude/object/ref effect precedes the
  under-lease pending gate. This preserves the existing admitted-before-intent regression.
- Trusted reentrant selected calls register immediately so their parent cannot unlock
  while an unawaited nested publication remains in progress.
- Stage-only metadata-safe staging obtains the same lease. Neither entrypoint reacquires
  the lifecycle lease during its own prepared receipt/ref/index publication internals.
- Existing public attribution/resume/integration/Brain/deletion callers remain unwired.

## Validation ledger

- Initial validation paused while supervisor removed old shared native-module files; no
  native processes were started until explicit test-resume signal.
- Initial ten-case focused run:9PASS/1FAIL, exit1,33.82s. An open-lock unlink on Windows
  enters delete-pending state; ownership lstat returned raw EPERM instead of the typed
  ownership error, and the fixture could not install its intended replacement.
- Corrected release to classify unverifiable filesystem ownership as ownership_changed,
  preserving evidence. Corrected fault fixture to rename the open own file before placing
  its replacement, so it exercises actual replacement rather than delete-pending behavior.
- Final command from MAIN packages/router:
  `pnpm exec vitest run tests/project-metadata-mutation.test.ts tests/project-metadata-selected-commit.test.ts tests/project-metadata-index-transaction.test.ts --maxWorkers=2`
  ->exit0,53PASS/1POSIX-onlySKIP of54 across3files,168.97s. Fence10/10, selected28/28,
  index15PASS/1SKIP. Existing admitted-before-intent race assertions passed unchanged.
- `git diff --check` scoped to owned tracked source/tests: exit0.
- Supervisor owns broad typecheck/build; no worker broad check while other source authors active.
- Draft tests cover opposite-order multi-owner acquisition, independent owners, host
  reentrancy/forgery/expiry/scope, drain-before-unlock, foreign stale and replaced locks,
  linked-worktree pending journals, stage-only refusal, nested selected commits and actual
  child-Node contention through a transpilation of the exact imported source graph.

## Limits

- Cooperative host lifecycle fence, not OS isolation against hostile concurrent filesystem
  swaps or unrelated Git processes ignoring this lock. Native Git locks remain necessary.
- Crash leftovers intentionally block subsequent admission until explicit operator recovery;
  no stale-lock theft, automatic index reconciliation, HEAD rewind or source rollback.
- Deleting an entire common Git metadata owner while its lifecycle lease is held is not
  authorized by this API; ownership loss will surface rather than claim successful cleanup.
- No live project/configuration/provider/service changes, broad source checks, commits or pushes.
