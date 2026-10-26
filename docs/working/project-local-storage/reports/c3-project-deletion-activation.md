# C3.7 project deletion admission

Supervisor independent final-source acceptance:5/5 PASS126.791s; ordinary confirmed deletion
37.434s with original accepted90s case allowance. Full Brain+deletion22/22 PASS272.96s.
Standalone native lock/sequencer removal precheck added by supervisor. Actual per-worktree
ten-marker and shared packed-refs lock fixture PASS1/1,18.93s; full existing workspace
lifecycle guards PASS12/12,74.97s. Check is cooperative; unmanaged native races remain outside
the atomicity claim. Labs owner consumes the same check under its existing scopes.

Worker: c3_message
Date: 2026-10-26
Status: source/tests frozen; final5/5 passed; supervisor acceptance pending.
Owned files: projects/deletion.ts, admin/projects.ts,
tests/project-metadata-deletion.test.ts and this report. Brain changes belong to sibling.

## Implemented draft

- Read-only discovery gathers configured sources, footprint task/job worktrees, nonremoved
  workspace rows, session workspace roots, merge source/target roots, Lab roots and retained
  task-attempt workspaces, plus the existing Brain root. Each actual worktree root and physical
  common Git owner is verified before writing any lifecycle lock. Foreign recorded roots
  cannot cause foreign lock writes. Missing/unverifiable roots refuse explicitly.
- Historical paths are skipped only when absent AND authoritative removed/destroyed/pruned
  records prove retirement. Existing paths are still inspected despite retirement flags.
  Unknown legacy missing roots require explicit migration/recovery under S10, never guessed
  safe for purge. An absent empty Brain is not bootstrapped just to delete it.
- Sorted common-owner authority spans the destructive lifecycle. Retained root admission is
  revalidated under the opaque host capability in bounded batches before Lab prune. There
  is no SQLite transaction across await. Native worktree cleanup and Brain folder/root-index
  publication complete before final synchronous config CAS/SQL purge; session/artifact files
  follow confirmed purge. Remote Brain pushPending executes after lifecycle release.
- Brain host control is {mutation,deferPush:true}; folder and explicitly slug-excluded README
  publication run while project config/rows still retain recovery context. Any pending or
  uncertain publication propagates before purge. Brain source implementation is sibling-owned.
- Native worktree removal failure is never swallowed or followed by recursive rm. Counts
  advance only after successful native removal and absence verification. Recorded source,
  linked-worktree metadata and native registration are checked prelease and under lease.
  Global prune is removed: deleting this project cannot prune unrelated registrations.
- If config/SQL finalization fails after destructive Git cleanup, the error explicitly reports
  partial cleanup, retained recovery context and that removed files were not rolled back.
  Existing request receipt/quarantined transport retention and accounting purge stay intact.

## Coordination/limits

- Task-Lab prune currently executes within the outer common-owner scope. Its upcoming C3.8
  internal fence must accept/pass this host capability rather than reacquire the same owner.
- Config/SQL CAS rollback restores only those synchronous stores; filesystem cleanup is not
  claimed reversible. Partial worktree removal can leave missing-root rows for explicit
  recovery, preserving evidence rather than suppressing a failed native remove.
- purgeProjectRows remains the existing synchronous low-level SQL primitive; this activation
  guards the supported deleteProject orchestration before invoking it.
- Any retained root outside configured sources/Brain/the currently authorized worktree
  footprint refuses before native/Brain removal or SQL purge. S9 must explicitly expand the
  deletion manifest for v2 project-local workspace layouts before those may be removed; this
  phase does not widen destructive path authority from arbitrary recorded strings.
- No tests/providers/app code from the live Facebook project are touched.

## Validation ledger

New five-case real-temp suite running. Pending worktree and Brain receipts compare exact
config, task/session/workspace/accounting rows, source/worktree/Brain HEAD/index and receipt
bytes, and assert no Lab prune or provider call. Additional cases exercise failed native
remove without fallback deletion, foreign session owner lock preservation, and ordinary
confirmed deletion retaining source branches, model usage and paid accounting.

Initial snapshot:4PASS/1FAIL120.40s. The four pending/failure/foreign invariants passed.
Ordinary full deletion exceeded default30s; its still-running operation then raced fixture
cleanup (ENOTEMPTY Brain/.git). Fixture now tracks/drains actual deletion operations before
cleanup; no cleanup error is suppressed. Exact ordinary diagnostic CLI --testTimeout120000
finished48.24s (52.29s total), no hang, and reached successful deletion/count assertions;
only failure was fixture assuming registry absence returned null rather than actual undefined.
Corrected that fixture assertion. Root approved a case-specific90s harness allowance for this
new multi-publication case based on the finite48.24s diagnostic; no native/product deadline or
other case limit changed. Final five-case frozen-source snapshot now running.

Root recursive router/panel typecheck PASS on the coherent draft. Subsequent source-only
changes bound native-removal admission batches under the same source-owner capability,
supporting many retained worktrees without exceeding the fence's per-call path bound.
Receipt fixtures now compare original/next index-copy bytes alongside receipt JSON.

FINAL frozen-source `pnpm exec vitest run tests/project-metadata-deletion.test.ts
--maxWorkers=1 --reporter=dot`: PASS5/5,148.61s total (145.01s tests). Includes the strict
retained-root coverage refusal source and batched native cleanup gates. All five assertions
pass, including ordinary branches, model token usage, exact paid-accounting retention and
foreign_key_check. Only ordinary new integration case has the approved90s test budget;
other four retain their original limits. No active worker test/native processes remain.

Supervisor still owns final source review, independent claims verification, broader deletion/
Brain compatibility and recursive checks on the completed tree. C3.8 nested Lab authority and
S9 expanded deletion manifest remain explicit dependencies, not claimed complete here.

No broad checks, shared-doc edits, commits/pushes or alternate checkouts by this worker.
