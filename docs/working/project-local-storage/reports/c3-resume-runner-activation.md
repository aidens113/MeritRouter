# C3.4 resume and runner mutation activation

Worker: c3_message
Date: 2026-10-26
Status: owned source frozen; final pending/resume11/11 passed; supervisor verification pending.
Scope: harness/resume.ts, runners/coding/native.ts, runners/coding/finish.ts,
runners/supervisor.ts, tests/project-metadata-resume.test.ts only.

## Implemented boundaries

- Resume preflights retained repositories before evidence restoration. Reconciliation acquires
  the common Git owner lease before abort, staging, reset or recovery commit; nested staging
  and commit receive the same opaque host capability. Recorded baseline must resolve before
  mutation. Abort/diff/publication failures propagate rather than become unchanged prose,
  tool absence proofs or advanced workspace pointers.
- Native reuse and initial/per-response workspace pointers run inside short pending-aware
  scopes, with task authority checked before writes. Per-response commit forwards the host
  capability and publication authority callback.
- Coding preparation/reuse hydration, status/event changes, collection/captured seal/pointer,
  and final collected status are guarded. Collection and seal share one capability. Long
  provider, approval and check work is outside the lease. Typed mutation/publication failures
  from Lab checking are propagated.
- Supervisor validates retained aliases and physical common Git owners, then guards branch
  creation/reuse and pointers. Lab retained roots and orphaned integration worktrees that
  lack a saved session pointer receive an explicit under-lease pending check. Per-response
  commit/pointer and final captured evidence/status are guarded; long model/check/human
  waits remain outside the lease. Typed repository failures cannot be swallowed by ledger
  best-effort catches.

## Coordination and remaining integration

- Sibling workspace worker owns actual edit-operation and approved command execution guards.
  Native/supervisor HarnessEnv now inject createRepositoryEffects(actualWorkspaceRoot), with
  no initial repositoryMutation capability. Their final checks already route through
  awaitWorkerCommand/executeSupervisorCommand; sibling execution fallback derives captured cwd.
  Entry checks alone do not protect tool writes after a later pending receipt appears.
- Root repair hydration activation added third host controls; preparation and resumed
  verification now pass the existing source+target mutation capability to prevent reacquisition.
- No common-owner lock is held across provider calls, await_tasks, approval waiting or long
  command processes. No model/tool JSON capability is introduced.

## Observed validation

- `pnpm exec vitest run tests/project-metadata-resume.test.ts --maxWorkers=1 --reporter=dot`:
  PASS 10/10, 67.95s total (65.39s tests). Real post-ref pending receipts preserve exact
  HEAD/index/source/workspace database row/session events/transcript and receipt/index-copy
  bytes across refused resume commit/reset, native reuse, supervisor reuse and final collection.
  Fake provider records zero calls. Ordinary dirty recovery/reset, verified unchanged proof,
  invalid baseline and actual revert sequencer abort failure also pass.
- `pnpm exec vitest run tests/project-metadata-resume.test.ts tests/session-resume.test.ts
  --maxWorkers=1 --reporter=dot`: PASS23/23,83.23s total (79.55s tests). Includes the explicit
  orphaned supervisor worktree pending regression. Subsequent task-authority rechecks and
  hydration capability forwarding require the final pending/native run now underway;
  repositoryEffects integration awaits sibling module completion before final verification.
- No broad checks by this worker.

Further observed snapshot: pending11 + native11 finished20PASS/2FAIL in418.63s.
The pending11 all passed. Native external-sandbox case timed out in its existing10s
afterEach while awaiting sy.close; the next Brain-report case then observed shared sy
undefined at its explicit sy.close and EBUSY meritrouter.db cleanup. Cause of the first
close delay is unproven; the cascade is not claimed fixed. No fixtures, timeouts or EBUSY
handling were changed. This run loaded before repositoryEffects import injection and
the final supervisor merge-recovery typed catch. Exact final-source rerun is pending
sibling module freeze. Root is independently verifying final hydration/Brain integration.

FINAL own suite: `pnpm exec vitest run tests/project-metadata-resume.test.ts --maxWorkers=1
--reporter=dot` PASS11/11,107.89s total (105.00s tests), including actual repositoryEffects
imports, hydration capability forwarding, task-authority rechecks and supervisor typed
merge-recovery propagation. Root separately confirmed final hydration targeted4/4 pass,
including the previously self-locking fresh-lease case. Root diagnosed native refusal
cleanup as asynchronous Brain bootstrap/report flush (18.34s with diagnostic CLI hook
allowance); root owns a narrow fixture bootstrap correction and exact original-timeout
rerun. This worker changed no native fixture/hook/product deadline.

Root review requested the no-repository recovered-pointer path avoid an empty lifecycle
request; guard now requires recovered.length && repos.size. Final source frozen. Root then
observed the exact native refusal case PASS with the original10s hook after the fixture-only
Brain bootstrap admission (1PASS/10skip,24.39s total); this worker did not edit native.test.ts.

No live project/provider actions, commits, shared working-document edits or new checkouts.
