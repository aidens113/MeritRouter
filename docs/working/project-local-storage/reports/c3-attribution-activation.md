# C3.2 attributed mutation activation

Worker: c3_message
Date: 2026-10-26
Status: implementation/source frozen; focused checks passed with snapshot distinctions below; supervisor acceptance pending.
Scope: attributed commits, undo and captured checked-candidate publication.

## Changes and stable host API

- Actor identity/trailer helpers moved to specifically named actor.ts; index.ts preserves
  existing reexports. Strict Actor schema is shared with selected publication. Extraction
  removes the index -> selected -> index activation cycle; normalization is unchanged.
- commitAs keeps string|null success and maps public paths undefined OR [] to omitted
  selected paths (ALL). Its separate fifth host control carries opaque mutation capability
  and trusted validation/fault hooks; no new tool/model JSON authority is exposed.
- SelectedCommitError validates refused/reconciliation_required/publication_uncertain
  details; unpackSelectedCommitOutcome returns string|null only for completed success or
  true unchanged. Pending admission remains typed RepositoryMutationError.
- Undo acquires the common-owner lifecycle lease before file reads/writes/revert effects,
  validates actor/reason/revisions/range budget before effects, and passes its capability to
  nested commitAs. Failed abort is surfaced, not swallowed; hooks run only after a completed
  undo commit. Physical file preflight also refuses private/linked undo targets.

## Exact captured tree publication

`commitCapturedApplication(repo, {actor, message, head, tree, extraTrailers?}, hostControl)`
uses the same lifecycle/native-index/ref/receipt publication pipeline. It verifies expected
HEAD and exact captured index tree, preflights bounded physical index entries and clean source,
then creates the commit from the supplied immutable tree. No restaging/substitution of newer
application bytes occurs. Publication checks authority before/after native preparation and
after acknowledged ref publication; revocation there retains exact head-published receipt
and original index rather than returning ordinary null or rewinding HEAD.

sealCheckedCandidate now uses this API under a lifecycle lease and preserves final exact
HEAD/tree/index/clean-source checks before accepting checked evidence. Source changes after
completed publication refuse evidence; this is distinct from an unresolved publication.

## Race fixture correction approved by supervisor

The old two race fixtures injected changes on the 11th/12th assertAuthority call. New native
index-lock protection shifts those calls and intentionally blocks ordinary add/commit during
publication. Replaced counts with explicit host-only publication hooks and afterPublication
(after index release, before final evidence checks). Both still assert exact captured HEAD
tree and retained concurrent index change, or preserved competing newer HEAD respectively.
Both additionally prove real native index-lock blocking. The ref-only competing writer uses
native commit-tree/update-ref; no sleeps, counter retargeting or weaker expected assertions.

## Setup compatibility correction

Workspace author traced legacy created-repository setup: it commits an empty tree without
add, while existing-folder snapshot stages ALL. Supervisor approved created paths:[] in the
fixed setup helper, leaving snapshot omitted paths and ordinary explicit-empty selected
semantics unchanged. New exact helper test leaves an arriving app file untracked.

Second supervisor-approved setup correction: if independent native Git establishes HEAD
after setup's earlier unborn observation, the helper's native-index snapshot returns unchanged
before staging. Existing admitted observation hook drives actual native commit races for both
created and snapshot; exact independent HEAD/index/source survive and commit count stays one.

## Validation ledger

- First loop started before the final created-snapshot/runtime-input regressions were added.
  Observed checked-candidate9/9 PASS76.28s (including native fake-provider runner), and new
  attributed suite11/11 PASS99.80s. Complete first loop22PASS/2FAIL of24,184.01s.
- First old attribution failure: multi-undo journey exceeded the30s harness limit; native
  operations continued into fixture cleanup, producing EBUSY. Exact unchanged assertion
  journey rerun serial with diagnostic60s allowance PASS31.24s, exit0,31.76s aggregate.
  Supervisor approved only that one case's60s harness allowance. All native/production
  deadlines remain unchanged; every original assertion remains. Fixture operations are now
  tracked and drained before deletion rather than suppressing Windows cleanup errors.
- Second failure: successful revert --no-commit leaves REVERT_HEAD, which generic selected
  publication correctly refuses. Undo now explicitly ends only its successful no-commit
  revert with revert --quit, preserving staged undo/worktree. Generic sequencer guard stays.
- Three-file loop with created-empty/runtime-input cases:26/26 PASS,exit0,173.91s.
  Attributed wrapper13/13, legacy attribution4/4, checked-candidate9/9. Heavy multi-undo
  case33.76s; cleanup drained normally, no EBUSY suppression or product deadline changes.
- Subsequent setup-existing-HEAD correction only: exact native race tests2/2 PASS,
  13 selection skips,exit0,9.51s. That helper-only initial branch correction was added after
  the three-file run loaded source; no single final-source aggregate is claimed for all28.
- Scoped owned-file `git diff --check`: exit0. Broad typecheck/build/full suite remain
  supervisor work while other source authors edit.
- Final source tests/typecheck/build remain supervisor acceptance work; no full-green claim.

## Measured integration risk

The safe publication protocol adds native Git phases. Five-commit/two-undo journey measured
31.24s serial and33.76s in the combined run; the old30s test harness was below real work cost.
Common-owner lifecycle leases intentionally serialize linked worktrees. Concurrent long
publications can hit the bounded10s lock wait; callers must preserve/propagate typed busy
state and use bounded supported retry/recovery rather than resetting source or usage.

No live projects, provider calls, service reloads, shared working documents, commits or new
checkouts/cache directories were changed by this worker. All fixture writes are OS-temp.
