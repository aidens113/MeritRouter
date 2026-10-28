# Fix: security containment, task-lab-caller, worker-lab-authority (2026-10-27)

Worker: fix-containment-tasklab (worker-heavy). Branch `dev`, main checkout, no commits.

## Outcome

Done. All five failures are fixed, and the cause of each is traced. None of them comes from
today's commits. All five go back to 2026-10-26 contract changes that the tests were never
updated for:

- b87f326: tool writes recheck run authority.
- 7e49ad3: workspace preparation rechecks run authority.
- 5cb43f9: Lab checks no longer call `runProcess`.
- The 2026-10-26 repository-mutation fences (d332c6b, b87f326, 96d4a86) multiplied Git
  process counts.

Fixing them turned up one product gap, which is now fixed. `prepareWorkspace` created a
worktree and replaced the task's workspace record for a claim that had already been
superseded, and only refused afterwards. No security or authority check was weakened. One
check was added, and the refusal tests in `worker-lab-authority` are no longer vacuous.

## What changed and why

### 1. security.test.ts: "refuses .git in any case..." (test encoded an outdated contract; changed by b87f326, 2026-10-26)

- **Cause.** b87f326 put every edit tool behind `withRepositoryToolWrite`, which calls
  `assertRunAuthority(env.ctx)` before the tool's action. The action is where
  `workspacePath` refuses `.git`. The test's harness env had `ctx: {}`, so `ctx.signal.aborted`
  threw a TypeError before the containment check was reached. The write still failed closed;
  the test just never got to the containment check.
- **Why it seemed to pass this morning (environment dependent, inferred).**
  `C:\Users\mrjoh` is itself a Git repository (`.git` created 2023). `withRepositoryToolWrite`
  walks up from a non-repository workspace root to any ancestor `.git`, so a bare `%TEMP%` root
  binds the write fence to the user's home repository. If that fence failed before the action
  with any message containing ".git" (for example a path under `C:\Users\mrjoh\.git`), the old
  `/\.git/` assertion passed vacuously. I could not reproduce the morning state.
- **Fix (test only).**
  - The env carries a real-shaped run authority (lease, signal, `tasks.dispatchable`).
  - The root is its own `git init` repository, so the fence never touches the home repository.
  - The assertion now matches the actual containment message ("named .git are not
    accessible") rather than any ".git".
  - Added a nested `a/.git/config` write refusal.
  - Added a lost-lease refusal that writes nothing.
  - The symlink test also uses its own repository root. It self-skips on this account.

### 2a. task-lab-caller.test.ts: "uses the immutable claimed generation..." (outdated test, changed by 7e49ad3; plus a product gap)

- **Cause.** 7e49ad3 wrapped hydration in `withRepositoryMutation` with
  `assertRunAuthority(ctx)`. The hand-built context had no `signal` or `taskLease`, giving
  `reading 'aborted'`.
- **Product gap found.** Under real authority, the test's scenario (the task row's `run_count`
  advanced past the claim) means a stale claim. `prepareWorkspace` called
  `Worktrees.prepare` before its first authority check. That ran `git worktree add` and
  replaced the task's `workspaces` row, and only then refused.
- **Product fix.** `src/runners/coding/finish.ts`: `assertRunAuthority(ctx)` now runs at the
  top of `prepareWorkspace`, before `workspaceSource` (Lab team source) and
  `Worktrees.prepare`. The existing in-mutation checks are unchanged.
- **Test fix.** The test claims the task for real (`tasks.claim` and `capturedLease`). It
  asserts that:
  - the worktree is named by the claimed generation;
  - a missing claim generation is still refused;
  - after `run_count` advances, preparation is refused with `lease_lost`;
  - the `workspaces` row still points at the claimed worktree.
- **Mutation check.** With the new line commented out, the test fails on the replaced
  `worktree_path`. I restored the line afterwards.
- The test is renamed to "uses the immutable claimed generation and refuses preparation once
  task state advances".

### 2b. task-lab-caller.test.ts: the two `expected [ {…} ] to have length 0` failures (timing; no single introducing commit)

- **Cause.** `completed()` waited 10 s, and each test had a 20 s limit. One native coding task
  here runs two attempts, because the missing Lab proof earns one quality repair to T3. I
  instrumented `node:child_process` in a throwaway test (now deleted):
  - **Process count.** One task spawns about 521 Git and helper processes (about 16 s of
    serial process time) and takes 17.7 to 18.6 s end to end at moderate load. At 97 % CPU,
    with other agents' suites running, it took about 51 s.
  - **Where the time goes.** The main costs are the repository-mutation fences:
    - `assertNoPendingCommitPublication`: 47
    - `resolveOwners`: 70
    - `assertNoActiveRepositoryCommand`: 42
    - `assertNoTrackedProjectMetadata`: 64
    - `withGitIndexTransaction` and `publishSelectedCommit`: about 30 each

    These callers date from 2026-10-26 (d332c6b, b87f326, 96d4a86). Today's 4db4173 and
    0bb1a59 reduce these counts rather than add to them.
  - **Conclusion.** The task cannot finish in 10 s on this machine, whatever the load.
- **Fix (test only).** Only full coding runs (tests 1, 4 and 6) wait `RUN_SECONDS = 120`, with
  matching test timeouts. Cancellation and refusal tests keep the 10 s window, so their
  promptness is still asserted. No assertion changed.

### 3. worker-lab-authority.test.ts: "executes a proved active supervisor operation..." (outdated test, changed by 5cb43f9, 2026-10-26)

- **Cause.** 5cb43f9 moved Lab command checks from `runProcess` to
  `manager.commands.run` (`LabRepositoryCommands`, which is bound to a Windows Job object). The
  spy on `runProcess` could never fire, so:
  - the positive count was 0;
  - every `expect(run).not.toHaveBeenCalled()` refusal assertion in the file was vacuous;
  - the operation actually executed the real `"fixture-command"` through a Lab job host.
- **Fix (test only).** The test spies on `manager.commands.run`, the current effect
  boundary. `runLabCheck` still calls `assertLabEffect()` before it, so authority is checked
  before the mocked boundary. I removed the unused `processRunner` import.

## Commands run and observed results

| Command | Result |
| --- | --- |
| `npx vitest run tests/security.test.ts -t "refuses .git in any case"` (before) | 1 failed: got "Cannot read properties of undefined (reading 'aborted')" |
| `npx vitest run tests/task-lab-caller.test.ts tests/worker-lab-authority.test.ts` (before) | 4 failed / 11 passed, matching the brief |
| Instrumented throwaway `tests/zz-fixct-debug.test.ts` (deleted) | 1 task: 521 processes, 17.7 to 51 s depending on load; event timeline T2 → repair T3 |
| `npx tsc --noEmit` | exit 0 |
| `npx vitest run tests/worker-lab-authority.test.ts tests/task-lab-caller.test.ts tests/security.test.ts --maxWorkers=1 --minWorkers=1` | 3 files, 27/27 passed (127 s) |
| Mutation check: new `assertRunAuthority` in `prepareWorkspace` commented out | claimed-generation test fails (worktree record replaced); restored |
| `npx vitest run tests/project-split-labs.test.ts tests/labs-task-attempt.test.ts tests/active-validation-ownership.test.ts tests/native.test.ts tests/coding.test.ts tests/project-entrypoint-isolation.test.ts tests/project-service-activation.test.ts --maxWorkers=1 --minWorkers=1` | 7 files, 70/70 passed (664 s; labs-task-attempt 16, native 11, project-entrypoint-isolation 11, project-service-activation 9, active-validation-ownership 18, project-split-labs 2, coding 3) |

## Not verified

- The full router suite, `pnpm -r build` and `dist/`.
- An idle-machine timing. Every run shared the CPU with other agents' suites.
- The exact morning failure mode of the security test. Reproducing it would need the old tree,
  and I created no alternate checkout.
- Other workers had uncommitted edits in the tree during my runs (`src/workspaces/merge-queue.ts`,
  `src/gateway/capacity.ts`, `src/operations/transport-recovery.ts`, `src/cli.ts`,
  `src/admission/sqlite-accounting-broker.ts` and their tests). My runs included them.

## Open questions or contradictions found

1. **The brief's premise.** "They passed in this morning's full run" contradicts the code. Each
   failure follows from a 2026-10-26 commit. Only the security test plausibly "passed", and
   only vacuously, through the home repository described in item 2.
2. **Real-data leak (needs the lead's decision; I did not touch it).** `C:\Users\mrjoh` is a
   Git repository. Fixtures created as bare `%TEMP%` directories make MeritRouter's fences and
   metadata exclusion operate on that home repository:
   - `C:\Users\mrjoh\.git\info\exclude` gained a "MeritRouter private project metadata" entry at
     13:34 today;
   - `.git` and `.git/info` were modified during my 21:04 and 21:14 runs, before I switched
     the test to a repository of its own.

   **Product question.** Should `withRepositoryToolWrite` bind to an ancestor repository that is
   not the workspace root? The current walk-up is conservative: it fences writes in any
   enclosing worktree. But it lets a non-repository workspace take locks in, and write metadata
   to, an unrelated repository. Other tests that use bare temp roots may do the same.
3. **Retry cost.** A coding task whose required Lab checks are refused by policy still gets a
   full T3 quality repair, which is bound to fail the same way and doubles run time. The
   policy lives in `src/verification/phase.ts`, which is outside my ownership.
4. **Lab processes.** These were already running before my session, from 1:40 PM to 7:00 PM:
   hosts 23732, 39784, 29444, 24672 and 2060, with their `server.cjs` children. I did not kill
   them. One new task-command host appeared at 21:35:58: PID 33904, parent 35364, a `MERITROUTER_TASK_COMMAND` host. It was still running after my runs. It started while my acceptance run was in project-split-labs or active-validation-ownership, but other agents were running suites too, so I cannot attribute it. I did not kill it.
