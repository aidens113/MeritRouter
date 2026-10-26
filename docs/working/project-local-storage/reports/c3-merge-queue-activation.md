# C3.5 merge queue mutation activation

Worker: c3_message
Date: 2026-10-26
Status: source/tests frozen; final11 plus targeted missing-run preflight pass; supervisor acceptance pending.
Owned files: workspaces/merge-queue.ts, tests/project-metadata-merge-queue.test.ts,
and this report. Repair hydration belongs to root.

## Implemented behavior

- Existing per-branch in-process ordering and durable physical branch mutex stay outermost.
  Source/target physical common Git owners are compared by read-only operations before
  writing a lifecycle lease. Foreign source owners fail closed without writing their lock.
- Short common-owner scopes guard initial queue state transitions, recovery aborts,
  source validation, picks/rebase, acceptance, integrated events and check-result recording.
  Source plus target pending receipts/active commands gate these scopes. Host validateSource
  is admission work only. Checks and redelegation run after lifecycle release; their resulting
  queue/event changes reacquire admission. The branch mutex remains held throughout.
- abortInProgress accepts an optional separate {mutation} host control. Failed native aborts
  propagate as typed ownership_changed while preserving sequencer evidence; suppression is
  removed. Typed RepositoryMutationError/SelectedCommitError bypass rollback and failure
  conversion in all mutation orchestration paths.
- Each successful native cherry-pick durably records {source,head,parent} in ownedPicks before
  the crash fault hook. Recovery and rollback require the exact recorded first-parent chain,
  not just forgeable cherry-pick trailer text. Unknown native-success-before-record windows
  retain state for explicit recovery. Known foreign HEAD advances cannot be rolled back or
  claimed as the integrated captured head. Preexisting unrelated sequencers refuse admission.
- Ordinary acceptance/conflict rollback remains reset --keep, under the cooperative lifecycle
  lease immediately after exact ownership verification. Long checks additionally require the
  captured afterHead still current before their proof is persisted.

## Explicit native-writer boundary

Root resolved policy on 2026-10-26: keep ordinary rollback with the common-owner lease and
immediately checked durable owned chain. This excludes cooperating framework writers and
detects known foreign advances. Native reset --keep provides no expected-HEAD argument;
an arbitrary unmanaged native writer racing the final check/reset is outside this rollback
guarantee. This does not weaken selected commit publication's separate native HEAD CAS.
No rollback native CAS is claimed, and no existing assertions are changed to hide it.

## Validation ledger

- Initial new6 cases:3PASS/3FAIL19.35s. Two fixture actors lacked required role; normal
  successful integration exact source assertion exposed inherited Windows core.autocrlf.
  Corrected fixture identity, disabled autocrlf only in the temp fixture, and prevented
  read-only native status refresh from rewriting indexes via GIT_OPTIONAL_LOCKS=0.
- Corrected new6: PASS6/6,33.71s. Real pending target/source preserves exact HEAD/index/status,
  queue business state/events and receipt bytes; normal integration releases lifecycle during
  checks; ordinary acceptance rollback works; known foreign advance stays retained; actual
  native conflict abort failure keeps marker/index.
- Added unknown durable-record window and foreign-owner lock-preservation regressions, then
  tightened recovery/finish ownership checks. Final new8 + existing team-nesting merge queue
  selection:15PASS/1FAIL/1skip,190.70s. All new8 and existing raw merge queue cases passed
  (serialization/rebase/conflict/crash restoration). The sole failure was the existing full
  supervisor-resume scenario: its1500*20ms poll reached the ceiling before the expected queue
  crash, while worker remained running after3 fake-provider calls/two replace tool outputs,
  actions empty and no queue event. Cause is unproven; root investigates after command module
  freeze. No timing/assertion edits were made.
- Added source/target pending interrupted recovery and root-approved missing-target regression.
  Missing integration target now raises typed ownership_changed before business-state/events
  because its physical owner/publication receipts cannot be verified. Queue evidence is
  retained for explicit recovery; no unverified source owner is locked. This is an intentional
  compatibility exception to the old missing-target failed-state conversion, approved by root.
- Native pick proof additionally checks captured parent, single-parent result and exact source
  trailer before persisting its ownedPicks record. Final source/tests frozen11 cases; final
  own run pending prior10-case snapshot drain. Existing assertions remain unchanged.
- Intermediate10-case snapshot PASS10/10,55.91s. Final11 run active; root additionally requested
  run(id) preflight use the same missing-target typed refusal as recover(jobId), to be applied
  after final11 drains and verified by the single missing-target case only.

FINAL: `pnpm exec vitest run tests/project-metadata-merge-queue.test.ts --maxWorkers=1
--reporter=dot` PASS11/11,56.27s total (55.18s tests). All current source except the following
root-requested single preflight was loaded. Then run(id) gained the same initial missing-target
typed refusal, before branchKey/native Git; existing missing-target fixture now checks both
run and recover preserving queue evidence. Exact final case `-t 'retained integration target
is missing'`: PASS1/10skip,1.74s total. No further source changes; no active worker processes.

Outstanding verification: root investigates the existing full supervisor prequeue30s poll
failure after command-module freeze. Broad recursive typecheck/build and integration acceptance
remain supervisor-owned. No normal raw merge queue regression is known failing.

No live project/provider actions, shared docs, commits, broad checks or alternate checkouts.

## Supervisor verification

Independent final new queue suite11/11 PASS54.77s. Root reviewed full integration diff:
short common scopes, nested abort capabilities, exact owned-pick restoration, no lease over
checks/redelegation, typed retained recovery and source/target ownership checks.

Existing full supervisor scenario reproduces prequeue polling failure1FAIL/6selection skips,
62.34s total. Diagnostics show supervisor submitted20:56:03, child only delegated20:56:37,
child still running after3 requests/two edit outputs; no queue event/command action reached.
Its1500*20ms loop was not enough for bootstrap+durable publications; actual elapsed was
~60s under this run, not a native queue failure. Root replaced ONLY that crash-observation
poll with a120s wall-clock deadline matching its existing child awaitResults120s; test's
240s bound, fault count, original commits, replay/attribution assertions and product deadlines
remain unchanged. Exact end-to-end rerun pending; this is not yet a passing test claim.
